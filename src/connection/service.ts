import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { CloudflaredInstaller, boundedBytes, minimalEnvironment, type ConnectionFetch } from './installer.js';
import { assertMcpPort } from './cloudflare-api.js';
import { networkEnvironment, probeConnectionNetwork } from './network.js';
import { publicBaseUrl, publicEndpoint, publicMetadataUrls } from './urls.js';
import { privateDirectory, readPrivate, writePrivate, redact } from './private-store.js';
import { SitesRelayClient } from './sites.js';
import type { ConnectionCheck, ConnectionConfiguration, ConnectionConfigurationInput, ConnectionHost, ConnectionService, ConnectionStatus, CloudflaredInstallation, ConnectionNetwork } from './types.js';

export interface ConnectionServiceOptions extends ConnectionHost {
  stateDir: string; configuration?: ConnectionConfigurationInput;
  fetch?: ConnectionFetch;
  installer?: Pick<CloudflaredInstaller, 'detect' | 'install'>;
  spawn?: (file: string, args: string[], options: Parameters<typeof spawnProcess>[2]) => ChildProcess;
  monitorIntervalMs?: number; retryBaseMs?: number;
  networkProbe?: () => Promise<ConnectionNetwork>; now?: () => number;
}
const unknown = (): ConnectionCheck => ({ state: 'unknown' });
function diagnosticError(error: unknown): string {
  if (!(error instanceof Error)) return '网络探测失败';
  const cause = error.cause as { code?: string } | undefined;
  if (cause?.code === 'ECONNRESET') return '网络连接在握手或传输期间被重置（ECONNRESET）；请检查 VPN 分流和当前公网地址的 HTTPS 访问。';
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') return `当前地址的 DNS 解析失败（${cause.code}）`;
  if (error.name === 'TimeoutError' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return '网络探测超时，请检查连接路径后重试';
  return cause?.code && /^[A-Z0-9_]{1,64}$/.test(cause.code) ? `${error.message}（${cause.code}）` : error.message;
}
function publicOrigin(value: string): string {
  const canonical = publicBaseUrl(value), url = new URL(canonical);
  // 固定设备桥可使用独立 HTTPS 端口，避免占用宿主已有的 443 服务。
  if (url.protocol !== 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost' || /\.(local|localhost|internal)$/.test(url.hostname)) throw new Error('连接地址必须为有效的公网 HTTPS 基地址');
  return canonical;
}
function configuration(input: ConnectionConfigurationInput, previous: ConnectionConfiguration): ConnectionConfiguration {
  const allowed = new Set(['mode', 'autoStart', 'tunnelId', 'publicUrl', 'protocol', 'token', 'clearToken', 'sitesUrl', 'enrollmentToken']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('连接配置包含未知字段');
  const next = { ...previous };
  if (input.mode !== undefined) { if (!['managed', 'quick', 'sites'].includes(input.mode)) throw new Error('连接模式无效'); next.mode = input.mode; }
  if (input.sitesUrl !== undefined) {
    if (typeof input.sitesUrl !== 'string' || !input.sitesUrl.trim()) throw new Error('请填写部署后的 Sites Relay 首页地址');
    const url = new URL(publicOrigin(input.sitesUrl));
    if (url.pathname !== '/') throw new Error('Sites 地址应为站点首页地址');
    next.sitesUrl = url.origin;
  }
  if (input.enrollmentToken !== undefined && (typeof input.enrollmentToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(input.enrollmentToken))) throw new Error('Sites 接入码格式无效');
  if (input.autoStart !== undefined) { if (typeof input.autoStart !== 'boolean') throw new Error('autoStart 必须为布尔值'); next.autoStart = input.autoStart; }
  if (input.protocol !== undefined) { if (!['auto', 'http2', 'quic'].includes(input.protocol)) throw new Error('隧道协议无效'); next.protocol = input.protocol; }
  if (input.tunnelId !== undefined) { if (typeof input.tunnelId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(input.tunnelId)) throw new Error('隧道 ID 无效'); next.tunnelId = input.tunnelId; }
  if (input.publicUrl !== undefined) { if (typeof input.publicUrl !== 'string') throw new Error('公网地址必须为字符串'); next.publicUrl = publicOrigin(input.publicUrl); }
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length < 16 || input.token.length > 16_384 || /\s/.test(input.token))) throw new Error('设备运行凭据格式无效');
  if (input.clearToken !== undefined && typeof input.clearToken !== 'boolean') throw new Error('clearToken 必须为布尔值');
  if (next.mode === 'quick') { delete next.tunnelId; if (previous.mode !== 'quick') delete next.publicUrl; }
  if (next.mode === 'sites') {
    delete next.tunnelId;
    if (!next.sitesUrl) throw new Error('请先部署 Sites Relay，并填写它的 HTTPS 首页地址');
    if (previous.mode !== 'sites' || next.sitesUrl !== previous.sitesUrl) delete next.publicUrl;
  }
  return next;
}

export class CloudflareConnectionService implements ConnectionService {
  private config: ConnectionConfiguration = { mode: 'quick', autoStart: false, protocol: 'http2' };
  private host: ConnectionHost;
  private installer: Pick<CloudflaredInstaller, 'detect' | 'install'>;
  private installation: CloudflaredInstallation = { installed: false, checksumVerified: false };
  private token?: string;
  private sites?: SitesRelayClient;
  private process?: ChildProcess;
  private metricsUrl?: string;
  private upstreamUrl?: string;
  private bridgePublishedAt = 0;
  private bridgePublication?: Promise<void>;
  private desiredRunning = false;
  private closed = false;
  private closing?: Promise<void>;
  private sequence: Promise<unknown> = Promise.resolve();
  private monitor?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private generation = 0;
  private probe?: Promise<ConnectionStatus>;
  private probes = { local: unknown(), public: unknown(), oauthDiscovery: unknown(), mcp: unknown() };
  private network: ConnectionNetwork = { dns: unknown(), tcp: unknown(), ...networkEnvironment() };
  private lastTick = 0;
  private tunnel: ConnectionStatus['tunnel'] = { state: 'stopped' };
  private authorization: ConnectionStatus['authorization'] = { state: 'unknown' };
  private toolCall: ConnectionStatus['toolCall'] = { state: 'not_observed', count: 0 };
  private recentEvents: ConnectionStatus['recentEvents'] = [];
  private lastError?: string;
  private probeError?: string;
  private bridgeError?: string;
  private fetcher: ConnectionFetch;
  private constructor(private options: ConnectionServiceOptions) {
    this.host = { mcpPort: options.mcpPort, controlPort: options.controlPort, onPublicUrl: options.onPublicUrl, onTunnelUrl: options.onTunnelUrl, bridge: options.bridge, getProbeToken: options.getProbeToken };
    assertMcpPort(this.host.mcpPort, this.host.controlPort);
    this.fetcher = options.fetch ?? fetch;
    this.installer = options.installer ?? new CloudflaredInstaller(join(options.stateDir, 'bin'), this.fetcher);
  }
  static async create(options: ConnectionServiceOptions): Promise<CloudflareConnectionService> {
    const service = new CloudflareConnectionService(options);
    await privateDirectory(options.stateDir);
    const saved = await readPrivate(join(options.stateDir, 'connection.json'));
    if (saved) {
      const data = JSON.parse(saved) as { version: number; configuration: ConnectionConfiguration; desiredRunning: boolean };
      if (data.version !== 1 || typeof data.desiredRunning !== 'boolean') throw new Error('连接状态版本无效');
      service.config = configuration(data.configuration, service.config);
      service.desiredRunning = data.desiredRunning;
    }
    service.token = await readPrivate(join(options.stateDir, 'tunnel-token'));
    if (options.configuration && Object.keys(options.configuration).length) {
      service.config = configuration(options.configuration, service.config);
      if (options.configuration.clearToken || service.config.mode === 'quick') {
        service.token = undefined;
        await unlink(join(options.stateDir, 'tunnel-token')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } else if (options.configuration.token) {
        service.token = options.configuration.token;
        await writePrivate(join(options.stateDir, 'tunnel-token'), service.token);
      }
      await service.save();
    }
    if (options.configuration?.enrollmentToken) await writePrivate(join(options.stateDir, 'sites-enrollment-token'), options.configuration.enrollmentToken);
    service.installation = await service.installer.detect();
    return service;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(() => { if (this.closed) throw new Error('连接插件已停止'); return operation(); });
    this.sequence = result.catch(() => {}); return result;
  }
  private async save(): Promise<void> {
    await writePrivate(join(this.options.stateDir, 'connection.json'), JSON.stringify({ version: 1, configuration: this.config, desiredRunning: this.desiredRunning }, null, 2));
  }
  private event(message: string, error = false): void {
    const safe = redact(message, this.token ? [this.token] : []);
    this.recentEvents.push({ at: new Date().toISOString(), message: safe });
    this.recentEvents = this.recentEvents.slice(-20); if (error) this.lastError = safe;
  }
  status(): ConnectionStatus {
    const url = this.config.publicUrl;
    return structuredClone({ configuration: { ...this.config, hasToken: Boolean(this.token) }, installation: this.installation,
      tunnel: this.tunnel, ...this.probes, network: this.network, authorization: this.authorization, toolCall: this.toolCall,
      chatgptVerification: 'not_verified', chatgpt: { name: 'Capyra', mcpUrl: url ? `${url}/mcp` : undefined, authentication: 'OAuth', instructions: [
        '在 ChatGPT 的应用设置中创建连接，填写名称 Capyra、下方 MCP 地址并选择 OAuth。',
        '发起授权后，在这台电脑的 Capyra 控制台核对并批准连接。',
        '返回 ChatGPT 发起一次工具调用；请求按本机的批准设置执行，收到调用后检查实际结果。',
      ] }, lastError: this.lastError ?? this.bridgeError ?? this.probeError, recentEvents: this.recentEvents,
      externalDependencies: this.config.mode === 'sites' ? ['本机需要保持运行并能访问 Sites；当前使用 MCP JSON 响应，未启用独立 SSE 事件流。'] : this.config.mode === 'managed' && !this.token ? ['需要产品账号服务配置 Cloudflare 账号、域名和管理 API 凭据，并为此设备颁发独立运行凭据。'] : this.config.mode === 'quick' ? [this.host.bridge ? '设备入口保持固定；Cloudflare Quick Tunnel 不支持 SSE。' : '免登录连接的地址在进程重新建立后可能变化；Cloudflare Quick Tunnel 不支持 SSE。'] : [],
    });
  }
  configureHost(input: Partial<ConnectionHost>): Promise<void> {
    return this.enqueue(async () => { const next = { ...this.host, ...input }; assertMcpPort(next.mcpPort, next.controlPort); if ((this.process || this.sites?.status.running) && (next.mcpPort !== this.host.mcpPort || next.controlPort !== this.host.controlPort)) throw new Error('修改服务端口前请先停止隧道'); this.host = next; });
  }
  configure(input: ConnectionConfigurationInput): Promise<ConnectionStatus> {
    return this.enqueue(async () => {
      const next = configuration(input, this.config);
      if (next.mode === 'managed' && next.tunnelId !== this.config.tunnelId && this.token && !input.token && !input.clearToken) throw new Error('更换隧道时必须提供该设备的新运行凭据');
      const resume = this.desiredRunning;
      await this.stopInternal();
      this.generation++;
      this.probes = { local: unknown(), public: unknown(), oauthDiscovery: unknown(), mcp: unknown() };
      this.probeError = undefined;
      this.authorization = { state: 'unknown' }; this.toolCall = { state: 'not_observed', count: 0 };
      if (input.enrollmentToken) await writePrivate(join(this.options.stateDir, 'sites-enrollment-token'), input.enrollmentToken);
      this.config = next;
      if (input.clearToken || next.mode === 'quick') { this.token = undefined; await unlink(join(this.options.stateDir, 'tunnel-token')).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      else if (input.token) { this.token = input.token; await writePrivate(join(this.options.stateDir, 'tunnel-token'), this.token); }
      this.desiredRunning = resume && !input.clearToken;
      await this.save();
      await this.host.onPublicUrl?.(this.config.publicUrl);
      if (this.desiredRunning) await this.startInternal();
      return this.status();
    });
  }
  async detect(): Promise<CloudflaredInstallation> { this.installation = await this.installer.detect(); return structuredClone(this.installation); }
  install(): Promise<CloudflaredInstallation> { return this.enqueue(async () => { if (this.process) throw new Error('更新 cloudflared 前请先停止连接'); this.installation = await this.installer.install(); this.event(`cloudflared ${this.installation.version} 已通过官方 SHA-256 校验`); return structuredClone(this.installation); }); }
  start(): Promise<ConnectionStatus> { return this.enqueue(async () => { this.desiredRunning = true; await this.save(); try { await this.startInternal(); } catch (error) { this.tunnel = { state: 'error' }; this.event(error instanceof Error ? error.message : '隧道启动失败', true); throw error; } return this.status(); }); }
  stop(): Promise<ConnectionStatus> { return this.enqueue(async () => { this.desiredRunning = false; await this.stopInternal(); await this.save(); await this.host.bridge?.remove(); return this.status(); }); }
  restart(): Promise<ConnectionStatus> { return this.enqueue(async () => { await this.stopInternal(); this.desiredRunning = true; await this.save(); await this.startInternal(); return this.status(); }); }
  restore(): Promise<ConnectionStatus> { return this.enqueue(async () => { if (this.desiredRunning && this.config.autoStart) await this.startInternal(); return this.status(); }); }
  private async startInternal(): Promise<void> {
    if (this.config.mode === 'sites') {
      if (this.sites?.status.running) return;
      const client = new SitesRelayClient({ stateDir: this.options.stateDir, mcpPort: this.host.mcpPort,
        onPublicUrl: async url => { this.config.publicUrl = publicOrigin(url); await this.host.onPublicUrl?.(url); await this.save(); },
        onState: (state, detail) => {
          this.tunnel = { state, url: this.config.publicUrl, readiness: { state: state === 'established' ? 'ok' : state === 'error' ? 'error' : 'unknown', checkedAt: new Date().toISOString(), detail: detail ?? 'Sites 设备连接' } };
          // 签名心跳只证明设备到 Sites 的通道，不替代公网 MCP 或真实客户端验收。
          this.network = { ...networkEnvironment(), dns: { state: 'unknown', detail: '使用 Sites 出站连接；未单独执行 DNS 检测' }, tcp: { state: state === 'established' ? 'ok' : 'unknown', checkedAt: new Date().toISOString(), detail: state === 'established' ? 'Sites 已接受本机签名心跳' : '等待 Sites 心跳响应' } };
          if (state === 'established') this.lastError = undefined;
          if (detail) this.event(detail, state === 'error' || state === 'reconnecting');
        } });
      this.sites = client;
      try {
        await client.start(this.config.sitesUrl!, await readPrivate(join(this.options.stateDir, 'sites-enrollment-token')));
        // 完成登记后只需设备私钥；接入码不长期留在用户电脑上。
        await unlink(join(this.options.stateDir, 'sites-enrollment-token')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) { await client.stop(); this.sites = undefined; throw error; }
      return;
    }
    if (this.process) return;
    if (this.config.mode === 'managed' && (!this.token || !this.config.publicUrl || !this.config.tunnelId)) throw new Error('请先绑定设备并自动准备稳定连接，设备运行凭据尚未就绪');
    this.installation = await this.installer.detect();
    if (!this.installation.installed || !this.installation.path) throw new Error(this.installation.error ?? '尚未安装 cloudflared，请在连接向导中点击准备客户端');
    const version = this.installation.version?.split('.').map(Number);
    if (this.config.mode === 'managed' && (!version || version[0] < 2025 || version[0] === 2025 && version[1] < 4)) throw new Error('稳定连接需要 cloudflared 2025.4.0 或更新版本，请更新客户端');
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    if (this.config.mode === 'quick' && this.host.bridge) {
      const fixed = this.host.bridge.publicUrl();
      if (!fixed) throw new Error('请先绑定本机，准备固定设备入口');
      this.config.publicUrl = publicOrigin(fixed);
      await this.host.onPublicUrl?.(this.config.publicUrl); await this.save();
    } else if (this.config.mode === 'quick') { delete this.config.publicUrl; await this.host.onPublicUrl?.(undefined); }
    else await this.host.onPublicUrl?.(this.config.publicUrl);
    const configFile = join(this.options.stateDir, 'cloudflared-config.json');
    // 显式空配置避免读取用户已有 cloudflared 配置或复用其他隧道。
    await writePrivate(configFile, '{}');
    const args = ['tunnel', '--config', configFile, '--no-autoupdate', '--protocol', this.config.protocol, '--edge-ip-version', '4', '--grace-period', '2s'];
    if (this.config.mode === 'managed') args.push('run', '--token-file', join(this.options.stateDir, 'tunnel-token'));
    else args.push('--url', `http://127.0.0.1:${this.host.mcpPort}`);
    this.tunnel = { state: 'starting', since: new Date().toISOString() };
    this.metricsUrl = undefined;
    this.upstreamUrl = undefined; this.bridgePublishedAt = 0; await this.host.onTunnelUrl?.(undefined);
    const child = (this.options.spawn ?? spawnProcess)(this.installation.path, args, { cwd: this.options.stateDir, stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnvironment(), windowsHide: true });
    this.process = child; this.tunnel.pid = child.pid;
    let output = '';
    const accept = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      const lines = output.split(/\r?\n/); output = lines.pop() ?? '';
      for (const line of lines) this.acceptLine(child, line);
    };
    child.stdout?.on('data', accept); child.stderr?.on('data', accept);
    child.once('error', () => this.processEnded(child, 'cloudflared 进程无法启动'));
    child.once('exit', (code, signal) => this.processEnded(child, `cloudflared 已退出（${code ?? signal ?? 'unknown'}）`));
    this.event('隧道正在启动，等待连接与公网探测');
    this.lastTick = (this.options.now ?? Date.now)();
    this.monitor = setInterval(() => { void this.monitorTick().catch(error => this.event(error instanceof Error ? error.message : '连接恢复检查失败', true)); }, this.options.monitorIntervalMs ?? 30_000); this.monitor.unref();
  }
  private async monitorTick(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const resumed = now - this.lastTick > (this.options.monitorIntervalMs ?? 30_000) * 3;
    this.lastTick = now;
    if (this.process && this.host.bridge && this.upstreamUrl && Date.now() - this.bridgePublishedAt >= 60_000) await this.publishBridge().catch(error => this.bridgeFailed(error));
    if (resumed) this.event('检测到休眠或运行间隔，正在重新检查网络与连接');
    const status = await this.diagnose();
    if (resumed && status.public.state === 'error' && status.tunnel.readiness?.state === 'ok') this.event('Cloudflare connector 已就绪；保留当前入口，并检查本机到公网地址的访问路径');
    if (resumed && this.desiredRunning && status.public.state === 'error' && status.tunnel.readiness?.state !== 'ok') await this.enqueue(async () => {
      if (!this.desiredRunning) return;
      this.event('恢复后的连接未通过探测，正在重新建立隧道');
      await this.stopInternal(); await this.startInternal();
    });
  }
  private acceptLine(child: ChildProcess, line: string): void {
    if (this.process !== child) return;
    const metrics = line.match(/Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/);
    if (metrics && Number(metrics[1].split(':')[1]) <= 65535) this.metricsUrl = `http://${metrics[1]}`;
    if (this.config.mode === 'quick') {
      const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (url && this.upstreamUrl !== url[0]) {
        void this.enqueue(async () => {
          if (this.process !== child) return;
          this.upstreamUrl = url[0]; this.tunnel.url = url[0]; await this.host.onTunnelUrl?.(url[0]);
          if (this.host.bridge) await this.publishBridge();
          else { this.config.publicUrl = url[0]; await this.host.onPublicUrl?.(url[0]); await this.save(); }
          void this.diagnose().catch(() => {});
        }).catch(error => { if (this.host.bridge) this.bridgeFailed(error); else this.event(error instanceof Error ? error.message : '连接地址更新失败', true); });
      }
    }
    if (/Registered tunnel connection/.test(line)) { this.tunnel.state = 'established'; this.attempts = 0; this.lastError = undefined; this.event('Cloudflare connector 已注册；正在核验公网与 MCP'); void this.diagnose().catch(() => {}); }
    else if (/ERR|error|failed/i.test(line)) { this.event(line, true); if (/reconnect|connection|edge/i.test(line)) this.tunnel.state = 'reconnecting'; }
  }
  private bridgeFailed(error: unknown): void {
    const message = redact(error instanceof Error ? error.message : '固定入口更新失败', this.token ? [this.token] : []);
    if (this.bridgeError !== message) this.event(message);
    this.bridgeError = message;
  }
  private publishBridge(): Promise<void> {
    if (this.bridgePublication) return this.bridgePublication;
    const child = this.process, upstream = this.upstreamUrl, bridge = this.host.bridge;
    if (!child || !upstream || !bridge) return Promise.resolve();
    this.bridgePublication = (async () => {
      const published = await bridge.publish(upstream);
      if (this.process !== child || this.upstreamUrl !== upstream || this.closed || !this.desiredRunning) return;
      if (published.publicUrl !== bridge.publicUrl() || published.upstream !== upstream) throw new Error('固定入口响应与本机设备不匹配');
      this.config.publicUrl = publicOrigin(published.publicUrl); this.bridgePublishedAt = Date.now();
      await this.host.onPublicUrl?.(this.config.publicUrl); await this.save();
      if (this.bridgeError) this.event('固定入口登记已恢复');
      this.bridgeError = undefined;
    })().finally(() => { this.bridgePublication = undefined; });
    return this.bridgePublication;
  }
  private processEnded(child: ChildProcess, message: string): void {
    if (this.process !== child) return;
    this.generation++;
    this.process = undefined;
    this.metricsUrl = undefined;
    this.upstreamUrl = undefined; void this.host.onTunnelUrl?.(undefined);
    if (this.monitor) { clearInterval(this.monitor); this.monitor = undefined; }
    this.tunnel = { state: this.desiredRunning ? 'reconnecting' : 'stopped' };
    this.event(message, this.desiredRunning);
    this.probes.public = { state: 'error', checkedAt: new Date().toISOString(), detail: '隧道进程已退出' }; this.probes.mcp = unknown();
    if (!this.desiredRunning || this.closed) return;
    const wait = Math.min(60_000, (this.options.retryBaseMs ?? 2000) * 2 ** Math.min(this.attempts++, 5));
    this.tunnel.retryAt = new Date(Date.now() + wait).toISOString();
    this.retry = setTimeout(() => { this.retry = undefined; void this.enqueue(async () => { if (this.desiredRunning) await this.startInternal(); }).catch(error => { this.tunnel = { state: 'error' }; this.event(error instanceof Error ? error.message : '重连失败', true); }); }, wait); this.retry.unref();
  }
  private async stopInternal(): Promise<void> {
    this.generation++;
    if (this.sites) { const client = this.sites; this.sites = undefined; await client.stop(); }
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    if (this.monitor) { clearInterval(this.monitor); this.monitor = undefined; }
    const child = this.process; this.process = undefined; this.metricsUrl = undefined; this.upstreamUrl = undefined;
    await this.host.onTunnelUrl?.(undefined);
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 4000);
        const finish = () => { clearTimeout(timer); resolve(); };
        child.once('exit', finish); child.once('error', finish); child.kill('SIGTERM');
      });
    }
    this.tunnel = { state: 'stopped' }; this.probes.public = unknown(); this.probes.mcp = unknown();
  }
  observeOAuth(event: { status: 'authorized' | 'paused' | 'revoked'; clientName?: string; selfTest?: boolean }): void {
    if (event.selfTest || this.closed) return;
    this.authorization = { state: event.status, observedAt: new Date().toISOString(), clientName: event.clientName ? redact(event.clientName).slice(0, 120) : undefined };
    if (event.status !== 'authorized') this.toolCall = { state: 'not_observed', count: 0 };
  }
  observeToolCall(event: { clientName?: string; tool?: string; selfTest?: boolean }): void {
    if (event.selfTest || this.closed) return;
    this.toolCall = { state: 'observed', count: this.toolCall.count + 1, observedAt: new Date().toISOString(), clientName: event.clientName ? redact(event.clientName).slice(0, 120) : undefined, tool: event.tool ? redact(event.tool).slice(0, 120) : undefined };
  }
  diagnose(): Promise<ConnectionStatus> {
    if (this.closed) return Promise.reject(new Error('连接插件已停止'));
    if (!this.probe) this.probe = this.runDiagnosis().finally(() => { this.probe = undefined; });
    return this.probe;
  }
  private async runDiagnosis(): Promise<ConnectionStatus> {
    const generation = this.generation; const origin = this.config.publicUrl;
    const fetchJson = async (url: string, init?: RequestInit): Promise<{ response: Response; data: Record<string, unknown> }> => {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', ...init?.headers } });
      let data: Record<string, unknown> = {};
      try { data = JSON.parse((await boundedBytes(response, 1024 * 1024)).toString()); } catch { if (response.ok) throw new Error('服务未返回有效 JSON'); }
      return { response, data };
    };
    const check = async (action: () => Promise<{ detail: string; httpStatus?: number; state?: ConnectionCheck['state'] }>): Promise<ConnectionCheck> => {
      try { return { state: 'ok', ...await action(), checkedAt: new Date().toISOString() }; }
      catch (error) { return { state: 'error', checkedAt: new Date().toISOString(), detail: redact(diagnosticError(error), this.token ? [this.token] : []) }; }
    };
    const health = (url: string) => check(async () => { const { response, data } = await fetchJson(`${url}/health`); if (!response.ok || data.ok !== true || data.service !== 'capyra') throw new Error(`Capyra 健康检查未通过（HTTP ${response.status}）`); return { detail: 'Capyra 健康检查通过', httpStatus: response.status }; });
    let readyConnections: number | undefined;
    const readiness = this.metricsUrl ? check(async () => {
      // 只访问该受管子进程日志报告的 loopback readiness，不能由公网 URL 指定。
      const { response, data } = await fetchJson(`${this.metricsUrl}/ready`);
      if ((response.status !== 200 && response.status !== 503) || !Number.isInteger(data.readyConnections) || Number(data.readyConnections) < 0) throw new Error('cloudflared 就绪响应无效');
      readyConnections = Number(data.readyConnections);
      return { state: Number(data.readyConnections) > 0 && response.ok ? 'ok' : 'error', detail: `${Number(data.readyConnections)} 个 Cloudflare connector 已就绪`, httpStatus: response.status };
    }) : Promise.resolve(this.config.mode === 'sites' ? this.tunnel.readiness ?? unknown() : unknown());
    const results = await Promise.all([
      health(`http://127.0.0.1:${this.host.mcpPort}`),
      origin ? health(origin) : Promise.resolve(unknown()),
      origin ? check(async () => {
        const discovery = publicMetadataUrls(origin);
        const [metadata, protectedResource] = await Promise.all([fetchJson(discovery.authorization), fetchJson(discovery.resource)]);
        if (!metadata.response.ok || !protectedResource.response.ok) throw new Error('OAuth discovery 不可达');
        // SDK 将根 issuer URL 序列化为末尾带 /；仅兼容这两种根地址，resource 仍精确比较。
        const matchesIssuer = (value: unknown) => value === origin || value === `${origin}/`;
        if (!matchesIssuer(metadata.data.issuer) || protectedResource.data.resource !== `${origin}/mcp`) throw new Error('OAuth issuer 或资源地址与当前连接不一致');
        for (const [name, endpoint] of [['authorization_endpoint', 'authorize'], ['token_endpoint', 'token'], ['registration_endpoint', 'register']]) if (metadata.data[name] !== publicEndpoint(origin, endpoint)) throw new Error(`OAuth ${name} 与当前连接不一致`);
        if (!Array.isArray(protectedResource.data.authorization_servers) || !protectedResource.data.authorization_servers.some(matchesIssuer)) throw new Error('OAuth 授权服务声明无效');
        return { detail: 'OAuth 授权与资源发现地址有效' };
      }) : Promise.resolve(unknown()),
      origin ? check(async () => {
        const token = await this.host.getProbeToken?.();
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const { response, data } = await fetchJson(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'capyra-connection-probe', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Capyra Connection Check', version: '1.0.0' } } }) });
        if (response.status === 401) return { state: 'authorization_required', detail: 'MCP 已响应鉴权要求；尚未完成初始化验证', httpStatus: 401 };
        const session = response.headers.get('mcp-session-id');
        try {
          const result = data.result as Record<string, unknown> | undefined;
          if (!response.ok || data.id !== 'capyra-connection-probe' || !result?.protocolVersion || !result.serverInfo || !result.capabilities) throw new Error(`MCP 初始化未通过（HTTP ${response.status}）`);
          return { detail: '诊断客户端已完成 MCP 初始化；真实 ChatGPT 调用仍需单独验证', httpStatus: response.status };
        } finally { if (session) await this.fetcher(`${origin}/mcp`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { ...headers, 'MCP-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } }).then(response => response.body?.cancel()).catch(() => {}); }
      }) : Promise.resolve(unknown()),
      this.config.mode === 'sites' ? Promise.resolve(this.network) : (this.options.networkProbe ?? probeConnectionNetwork)(),
      readiness,
    ]);
    if (generation === this.generation && !this.closed) {
      [this.probes.local, this.probes.public, this.probes.oauthDiscovery, this.probes.mcp, this.network] = results;
      this.tunnel.readiness = results[5];
      this.tunnel.connections = readyConnections;
      if (this.process && results[5].state === 'ok') this.tunnel.state = 'established';
      else if (this.process && results[5].httpStatus === 503) this.tunnel.state = 'reconnecting';
      // 公网应用探测与 connector 状态独立：HTTP 错误也可能来自 origin、OAuth 或响应格式。
      const error = results.slice(0, 4).find(result => 'state' in result && result.state === 'error') as ConnectionCheck | undefined;
      // 探测恢复仅清除自己的错误；connector 失败由其重连事件单独处理。
      // 相同错误只记录一次，恢复后保留历史供用户追查网络波动。
      if (error?.detail !== this.probeError) {
        if (error?.detail) this.event(`连接检测失败：${error.detail}`);
        else if (this.probeError) this.event('连接检测已恢复');
      }
      this.probeError = error?.detail;
    }
    return this.status();
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.enqueue(async () => { await this.stopInternal(); this.closed = true; });
    return this.closing;
  }
}

export const createConnectionService = (options: ConnectionServiceOptions): Promise<CloudflareConnectionService> => CloudflareConnectionService.create(options);
