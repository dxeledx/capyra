import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-store.js';
import { publicBaseUrl } from './urls.js';
import { sitesFetch } from './sites-network.js';

export interface SitesRelayClientOptions {
  stateDir: string;
  mcpPort: number;
  onState(state: 'starting' | 'established' | 'reconnecting' | 'stopped' | 'error', detail?: string): void;
  onPublicUrl(url: string): Promise<void>;
}
interface Identity { origin: string; deviceId?: string; publicUrl?: string; privateKey: string; publicKey: string }
interface RelayRequest { id: string; method: string; path: string; headers: Record<string, string>; body: string }
interface Reply { id: string; status: number; headers: Record<string, string>; body: string }
const REQUEST_LIMIT = 128 * 1024, RESPONSE_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT_ERROR = 'Local MCP response exceeds the Sites relay limit of 1 MiB';
const forwardHeaders = new Set(['authorization', 'content-type', 'accept', 'origin', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'last-event-id', 'user-agent']);
const hopHeaders = new Set(['connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'content-length']);
const allowedPath = /^\/(?:mcp|health|authorize|token|register|revoke|\.well-known\/oauth-authorization-server|\.well-known\/oauth-protected-resource(?:\/mcp)?|oauth\/pending\/[A-Za-z0-9_-]{43})$/;

/** 电脑主动领取请求，不监听公网端口；设备私钥与 MCP 用户授权彼此独立。 */
export class SitesRelayClient {
  private identity?: Identity;
  private controller?: AbortController;
  private loop?: Promise<void>;
  private lastPollState?: 'established' | 'reconnecting';
  private readonly active = new Set<Promise<void>>();
  private readonly seen = new Map<string, number>();
  constructor(private readonly options: SitesRelayClientOptions) {
    if (!Number.isInteger(options.mcpPort) || options.mcpPort < 1 || options.mcpPort > 65535) throw new Error('MCP 端口无效');
  }
  get status(): { deviceId?: string; publicUrl?: string; origin?: string; running: boolean } {
    return { deviceId: this.identity?.deviceId, publicUrl: this.identity?.publicUrl, origin: this.identity?.origin, running: !!this.controller && !this.controller.signal.aborted };
  }

  async start(value: string, enrollmentToken?: string): Promise<{ publicUrl: string }> {
    await this.stop();
    const canonical = publicBaseUrl(value), url = new URL(canonical);
    if (url.protocol !== 'https:' || url.pathname !== '/') throw new Error('Sites 地址必须是 HTTPS 站点根地址');
    const origin = url.origin;
    const controller = this.controller = new AbortController();
    this.lastPollState = undefined;
    this.options.onState('starting');
    try {
      const path = join(this.options.stateDir, 'connection', `sites-${createHash('sha256').update(origin).digest('hex').slice(0, 24)}.json`);
      const saved = await readPrivate(path);
      let identity: Identity;
      if (saved) {
        identity = JSON.parse(saved) as Identity;
        if (identity.origin !== origin || typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') throw new Error('Sites 设备状态无效');
        const key = createPrivateKey(identity.privateKey);
        if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url') !== identity.publicKey) throw new Error('Sites 设备密钥不匹配');
      } else {
        const pair = generateKeyPairSync('ed25519');
        identity = { origin, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
        // 先保存密钥，注册响应丢失时仍能用相同公钥恢复设备，避免生成不可找回的身份。
        await writePrivate(path, JSON.stringify(identity));
      }
      this.identity = identity;
      if (!identity.deviceId || !identity.publicUrl) {
        if (!enrollmentToken) throw new Error('首次连接 Sites 需要设备绑定码');
        const result = await this.api('/api/devices', { token: enrollmentToken, name: hostname(), publicKey: identity.publicKey }, false, controller.signal) as { deviceId?: unknown; publicUrl?: unknown };
        if (typeof result.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.deviceId) || typeof result.publicUrl !== 'string') throw new Error('Sites 返回的设备身份无效');
        const publicUrl = publicBaseUrl(result.publicUrl);
        if (new URL(publicUrl).origin !== origin || new URL(publicUrl).pathname !== `/devices/${result.deviceId}`) throw new Error('Sites 返回的设备入口无效');
        identity.deviceId = result.deviceId; identity.publicUrl = publicUrl;
        await writePrivate(path, JSON.stringify(identity));
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.deviceId) || identity.publicUrl !== `${origin}/devices/${identity.deviceId}`) throw new Error('Sites 已保存的设备入口无效');
      controller.signal.throwIfAborted();
      await this.options.onPublicUrl(identity.publicUrl);
      controller.signal.throwIfAborted();
      this.loop = this.poll(controller.signal);
      return { publicUrl: identity.publicUrl };
    } catch (error) {
      controller.abort();
      this.options.onState('error', error instanceof Error ? error.message : 'Sites 连接失败');
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    await Promise.allSettled([...this.active]);
    this.loop = undefined; this.controller = undefined;
    this.options.onState('stopped');
  }

  private async api(path: string, data: unknown, authenticated: boolean, signal: AbortSignal): Promise<unknown> {
    const identity = this.identity!;
    const body = JSON.stringify(data), headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authenticated) {
      const time = String(Date.now()), nonce = randomUUID();
      const payload = `POST\n${path}\n${time}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
      Object.assign(headers, { 'x-capyra-time': time, 'x-capyra-nonce': nonce, 'x-capyra-signature': sign(null, Buffer.from(payload), identity.privateKey).toString('base64url') });
    }
    const response = await sitesFetch(identity.origin, path, headers, body, signal);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Sites 请求失败（HTTP ${response.status}）`); }
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('Sites 响应超过限制');
      chunks.push(chunk);
    }
    return length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
    });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        // 满载时只发送心跳，不领取新任务；耗时操作不会阻断设备在线状态的更新。
        const capacity = Math.max(0, 8 - this.active.size);
        const result = await this.api(`/api/devices/${this.identity!.deviceId}/poll`, { capacity }, true, signal) as { requests?: unknown };
        if (!Array.isArray(result.requests) || result.requests.length > capacity) throw new Error('Sites 请求队列格式无效');
        failures = 0;
        // 只有签名轮询成功才报告连接已建立，注册成功本身不代表数据通路可用。
        if (this.lastPollState !== 'established') { this.lastPollState = 'established'; this.options.onState('established'); }
        for (const request of result.requests as RelayRequest[]) {
          if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) continue;
          if (this.seen.has(request.id)) continue;
          if (signal.aborted) break;
          this.seen.set(request.id, Date.now());
          while (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
          const job = this.deliver(request, signal).finally(() => { this.active.delete(job); });
          this.active.add(job);
        }
        // 保留近期去重记录；过期任务不应被服务端重新分派。
        for (const [id, at] of this.seen) if (Date.now() - at > 24 * 60 * 60_000) this.seen.delete(id);
        await this.pause(result.requests.length ? 1_000 : 2_000, signal);
      } catch {
        if (signal.aborted) break;
        failures++;
        if (this.lastPollState !== 'reconnecting') { this.lastPollState = 'reconnecting'; this.options.onState('reconnecting', 'Sites 暂时不可达，正在自动重连'); }
        await this.pause(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)) * (0.75 + Math.random() * 0.25), signal);
      }
    }
  }

  private async deliver(input: RelayRequest, signal: AbortSignal): Promise<void> {
    let reply: Reply;
    try { reply = await this.forward(input, signal); }
    catch (error) {
      const message = error instanceof Error && error.message === RESPONSE_LIMIT_ERROR ? RESPONSE_LIMIT_ERROR : 'Local MCP request could not be completed';
      reply = { id: input.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: message })).toString('base64') };
    }
    // 只重传相同结果，绝不因为上传失败再次执行本机操作。
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      try { await this.api(`/api/devices/${this.identity!.deviceId}/replies`, reply, true, signal); return; }
      catch { await this.pause(500 * 2 ** attempt, signal); }
    }
  }

  private async forward(input: RelayRequest, signal: AbortSignal): Promise<Reply> {
    if (typeof input.path !== 'string' || input.path.length > 16_384 || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\\r\n#]/.test(input.path)) throw new Error('Invalid relay path');
    const url = new URL(input.path, 'http://127.0.0.1');
    // 检查原始路径，拒绝 URL 规范化可能隐藏的路径穿越或编码绕过。
    if (!allowedPath.test(input.path.split('?')[0]) || !allowedPath.test(url.pathname) || !['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD'].includes(input.method)) throw new Error('Relay route denied');
    if (typeof input.body !== 'string' || input.body.length > Math.ceil(REQUEST_LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body)) throw new Error('Invalid relay body');
    const body = Buffer.from(input.body, 'base64');
    if (body.length > REQUEST_LIMIT || !input.headers || typeof input.headers !== 'object') throw new Error('Relay request too large');
    const headers: Record<string, string> = { host: new URL(this.identity!.publicUrl!).host };
    for (const [name, value] of Object.entries(input.headers)) if (forwardHeaders.has(name.toLowerCase()) && typeof value === 'string' && value.length < 16_384 && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
    headers['content-length'] = String(body.length);
    return new Promise<Reply>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: this.options.mcpPort, path: input.path, method: input.method, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) }, response => {
        let length = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > RESPONSE_LIMIT) { const error = new Error(RESPONSE_LIMIT_ERROR); reject(error); request.destroy(error); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const outgoing: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) if (!hopHeaders.has(name) && value !== undefined) outgoing[name] = Array.isArray(value) ? value.join(', ') : value;
          resolve({ id: input.id, status: response.statusCode ?? 502, headers: outgoing, body: Buffer.concat(chunks).toString('base64') });
        });
      });
      request.on('error', reject); request.end(body);
    });
  }
}
