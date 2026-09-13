import { createHash, randomBytes } from 'node:crypto';
import { boundedBytes, type ConnectionFetch } from './installer.js';

export interface CloudflareProviderOptions {
  accountId: string; zoneId: string; baseDomain: string; apiToken: string; controlPort?: number; fetch?: ConnectionFetch;
}
export interface ProvisionedConnection { tunnelId: string; publicUrl: string; token: string; dnsRecordId: string }
export interface ConnectionProvider {
  provision(input: { deviceId: string; mcpPort: number }): Promise<ProvisionedConnection>;
  revoke(input: { tunnelId: string; dnsRecordId?: string }): Promise<void>;
  rotate(input: { tunnelId: string }): Promise<{ token: string }>;
}
class CloudflareRequestError extends Error {
  constructor(message: string, readonly status: number, readonly codes: number[]) { super(message); }
}
export const PUBLIC_ROUTE_PATTERN = '^/(mcp|health|authorize|token|register|revoke|\\.well-known/(oauth-authorization-server|oauth-protected-resource(/mcp)?)|oauth/pending/[A-Za-z0-9-]+)$';
export function assertMcpPort(port: number, controlPort: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === controlPort) throw new Error('隧道必须指向独立的 MCP 端口（1024–65535），不能使用本机控制端口');
}
function identifier(value: string): string {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(value)) throw new Error('Cloudflare 资源标识无效');
  return value;
}

/** 仅在产品方账号服务运行；构造参数和实例不能序列化到设备响应。 */
export class CloudflareApiProvider implements ConnectionProvider {
  #apiToken: string;
  private fetcher: ConnectionFetch;
  private account: string;
  private zoneId: string;
  private baseDomain: string;
  private controlPort: number;
  constructor(options: CloudflareProviderOptions) {
    identifier(options.accountId); identifier(options.zoneId);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(options.baseDomain) || options.baseDomain.endsWith('.localhost')) throw new Error('产品连接域名必须为完整域名');
    if (!options.apiToken || /[\r\n]/.test(options.apiToken)) throw new Error('缺少 Cloudflare 管理 API 凭据');
    this.fetcher = options.fetch ?? fetch;
    this.account = `/accounts/${options.accountId}/cfd_tunnel`;
    this.#apiToken = options.apiToken; this.zoneId = options.zoneId; this.baseDomain = options.baseDomain; this.controlPort = options.controlPort ?? 4318;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${this.#apiToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('Cloudflare 管理 API 网络请求失败，请检查云端连接'); }
    let envelope: { success: boolean; result: T; errors?: { code: number }[] };
    try { envelope = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString()); }
    catch { throw new Error(`Cloudflare 管理 API 返回无效响应（HTTP ${response.status}）`); }
    if (!response.ok || envelope.success !== true) {
      // 上游错误消息可能包含原始请求；只记录状态码和数字错误码。
      const codes = envelope.errors?.map(error => Number.isInteger(error.code) ? error.code : 0).slice(0, 4) ?? [];
      throw new CloudflareRequestError(`Cloudflare 管理 API 失败（HTTP ${response.status}${codes.length ? `，代码 ${codes.join(',')}` : ''}）`, response.status, codes);
    }
    return envelope.result;
  }
  async provision(input: { deviceId: string; mcpPort: number }): Promise<ProvisionedConnection> {
    assertMcpPort(input.mcpPort, this.controlPort);
    if (!input.deviceId || input.deviceId.length > 256) throw new Error('设备 ID 无效');
    const label = `d-${createHash('sha256').update(input.deviceId).digest('hex').slice(0, 24)}`;
    const hostname = `${label}.${this.baseDomain}`;
    const tunnel = await this.request<{ id: string; token?: string }>(this.account, 'POST', { name: `capyra-${label}`, config_src: 'cloudflare', tunnel_secret: randomBytes(32).toString('base64') });
    const tunnelId = identifier(tunnel.id);
    let dnsRecordId: string | undefined;
    try {
      await this.request(`${this.account}/${tunnelId}/configurations`, 'PUT', { config: { ingress: [{ hostname, path: PUBLIC_ROUTE_PATTERN, service: `http://127.0.0.1:${input.mcpPort}`, originRequest: { connectTimeout: 10 } }, { service: 'http_status:404' }] } });
      const dns = await this.request<{ id: string }>(`/zones/${this.zoneId}/dns_records`, 'POST', { type: 'CNAME', proxied: true, name: hostname, content: `${tunnelId}.cfargotunnel.com`, comment: 'Capyra device connection' });
      dnsRecordId = identifier(dns.id);
      const token = tunnel.token ?? await this.request<string>(`${this.account}/${tunnelId}/token`);
      if (typeof token !== 'string' || token.length < 16) throw new Error('Cloudflare 未返回有效设备运行凭据');
      return { tunnelId, publicUrl: `https://${hostname}`, token, dnsRecordId };
    } catch (error) {
      try { await this.revoke({ tunnelId, dnsRecordId }); }
      catch { throw new Error(`Cloudflare 设备配置失败且回滚未完成；云端需清理 tunnel ${tunnelId}${dnsRecordId ? ` / DNS ${dnsRecordId}` : ''}`); }
      throw error;
    }
  }
  async revoke(input: { tunnelId: string; dnsRecordId?: string }): Promise<void> {
    const tunnelId = identifier(input.tunnelId);
    // 先切断入口并清除在线 connector；仅删 DNS 不会立即吊销现有连接。
    const errors: string[] = [];
    const remove = async (path: string, method: string, body?: unknown) => {
      try { await this.request(path, method, body); }
      catch (error) {
        // 上次撤销可能已删掉 tunnel；资源已不存在时继续清理 DNS，允许安全重试。
        if (error instanceof CloudflareRequestError && (error.status === 404 || error.status === 410)) return;
        errors.push(error instanceof Error ? error.message : 'Cloudflare 撤销失败');
      }
    };
    await remove(`${this.account}/${tunnelId}/configurations`, 'PUT', { config: { ingress: [{ service: 'http_status:404' }] } });
    await remove(`${this.account}/${tunnelId}/connections`, 'DELETE');
    await remove(`${this.account}/${tunnelId}`, 'DELETE');
    if (input.dnsRecordId) await remove(`/zones/${this.zoneId}/dns_records/${identifier(input.dnsRecordId)}`, 'DELETE');
    if (errors.length) throw new Error(`Cloudflare 撤销尚未全部完成，可重试：${errors.join('；')}`);
  }
  async rotate(input: { tunnelId: string }): Promise<{ token: string }> {
    const tunnelId = identifier(input.tunnelId);
    await this.request(`${this.account}/${tunnelId}`, 'PATCH', { tunnel_secret: randomBytes(32).toString('base64') });
    try {
      await this.request(`${this.account}/${tunnelId}/connections`, 'DELETE');
      const token = await this.request<string>(`${this.account}/${tunnelId}/token`);
      if (typeof token !== 'string' || token.length < 16) throw new Error('Cloudflare 未返回有效设备运行凭据');
      return { token };
    } catch { throw new Error('Cloudflare 已更新隧道凭据，但旧连接清理或新凭据读取未完成。请重试轮换；当前设备可能需要重新连接。'); }
  }
}
