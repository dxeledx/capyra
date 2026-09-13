import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { hash, IdentityError, normalizeScope, readPrivateJson, secret, signProof, writePrivateJson } from './security.js';
import type { MobileApprovalRequest, MobileApprovalDecision } from './mobile-approvals.js';
import type { DeviceConnection, DeviceScope, IdentityDevice, IdentityStatus, IdentityUser, ApprovalRelayStatus } from './types.js';

interface AccountSession { token: string; csrfToken: string; expiresAt: string; user: IdentityUser }
interface LocalState { version: 1; privateKey: string; publicKey: string; cloudUrl?: string; account?: AccountSession; device?: IdentityDevice; localScope?: DeviceScope }
interface Pairing { id: string; code: string; expiresAt: string; fingerprint: string }
export interface ApprovalBinding { deviceId: string; ownerId: string; version: number; generation: number; cloudUrl: string }
export interface IdentityServiceOptions { stateDir: string; cloudUrl?: string; pollIntervalMs?: number }

export function validateCloudUrl(value: string): string {
  // 先检查原始文本；URL 解析会自动消去点段、转义和反斜杠，不能用归一化后的结果证明输入安全。
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\%]/.test(value)) throw new IdentityError('Account service URL must use a canonical origin and plain path');
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(value);
  if (!parts || parts[1].includes('@')) throw new IdentityError('Account service URL must not include credentials, a query, or a fragment');
  const path = parts[2] ?? '';
  if (path.includes('//') || path.split('/').some(segment => segment === '.' || segment === '..' || (segment && !/^[A-Za-z0-9._~-]+$/.test(segment)))) throw new IdentityError('Account service path must contain ordinary path segments without traversal');
  let url: URL;
  try { url = new URL(value); } catch { throw new IdentityError('Account service URL is invalid'); }
  if (url.username || url.password || url.search || url.hash) throw new IdentityError('Account service URL must not include credentials, a query, or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new IdentityError('Account service needs HTTPS (HTTP is allowed only on loopback)');
  return url.origin + path.replace(/\/$/, '');
}
function localScope(scope: DeviceScope): DeviceScope {
  const result = normalizeScope(scope);
  // 绑定明确的是实际目录，软链接更换后不能把已有授权挪到另一个工作区。
  result.workspaces = result.workspaces.map(path => realpathSync(resolve(path)));
  return normalizeScope(result);
}
function includesCapability(allowed: string[], capability: string): boolean {
  return allowed.some(value => value === '*' || value === capability || (value.endsWith(':*') && capability.startsWith(value.slice(0, -1))) || (value.endsWith('_*') && capability.startsWith(value.slice(0, -1))));
}

/** 此服务仅由受保护的本机控制面调用；它不向 MCP 注册任何账号或批准工具。 */
export class IdentityService {
  private readonly statePath: string;
  #state: LocalState;
  private pairing?: Pairing;
  #runtimeToken?: { token: string; expiresAt: string };
  private authentication?: { generation: number; promise: Promise<void> };
  private bindingGeneration = 0;
  private bindingChanging = false;
  private management: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(status: IdentityStatus) => void>();
  private readonly lifetime = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private checkedAt?: string;
  private active = false;
  private error?: string;
  private approvalRelay?: ApprovalRelayStatus;
  constructor(options: IdentityServiceOptions) {
    this.statePath = join(options.stateDir, 'identity', 'device.json');
    const stored = readPrivateJson<LocalState>(this.statePath);
    if (stored) {
      if (stored.version !== 1 || typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') throw new Error('Invalid local identity state');
      this.#state = stored;
    } else {
      const keys = generateKeyPairSync('ed25519');
      this.#state = { version: 1, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    }
    if (this.#state.cloudUrl) this.#state.cloudUrl = validateCloudUrl(this.#state.cloudUrl);
    else if (options.cloudUrl) this.#state.cloudUrl = validateCloudUrl(options.cloudUrl);
    this.save();
    if (options.pollIntervalMs !== 0) {
      this.timer = setInterval(() => { if (this.#state.device && !this.lifetime.signal.aborted) void this.refreshBinding().catch(() => undefined); }, options.pollIntervalMs ?? 15_000);
      this.timer.unref();
    }
  }
  private save() { writePrivateJson(this.statePath, this.#state); }
  private beginBindingChange(): () => void {
    // 本机管理意图先关闸；旧网络响应不能在撤销或范围切换后恢复已批准的访问。
    this.bindingGeneration++; this.bindingChanging = true; this.active = false; this.#runtimeToken = undefined; this.notify();
    return () => { this.bindingChanging = false; };
  }
  private notify() { const status = this.status(); for (const listener of this.listeners) { try { listener(status); } catch {} } }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.management.then(() => { if (this.lifetime.signal.aborted) throw new Error('Identity service is closed'); return operation(); });
    this.management = next.catch(() => undefined); return next;
  }
  status(): IdentityStatus {
    const account = this.#state.account && Date.parse(this.#state.account.expiresAt) > Date.now() ? this.#state.account : undefined;
    const pairing = this.pairing && Date.parse(this.pairing.expiresAt) > Date.now() ? this.pairing : undefined;
    return structuredClone({ configured: Boolean(this.#state.cloudUrl), cloudUrl: this.#state.cloudUrl, user: account?.user, sessionExpiresAt: account?.expiresAt,
      device: this.#state.device, approvalRelay: this.approvalRelay, active: !this.bindingChanging && this.active && Boolean(this.checkedAt && Date.now() - Date.parse(this.checkedAt) < 45_000), checkedAt: this.checkedAt, error: this.error,
      pairing: pairing ? { code: pairing.code, expiresAt: pairing.expiresAt, fingerprint: pairing.fingerprint } : undefined });
  }
  onBindingChanged(listener: (status: IdentityStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  configure(input: { cloudUrl: string }): Promise<IdentityStatus> { return this.serial(async () => {
    const cloudUrl = validateCloudUrl(input.cloudUrl);
    if (this.#state.cloudUrl !== cloudUrl) {
      if (this.#state.device) throw new IdentityError('Unbind this device before changing the account service');
      delete this.#state.account; this.pairing = undefined; this.#runtimeToken = undefined;
    }
    this.#state.cloudUrl = cloudUrl; this.save(); this.notify(); return this.status();
  }); }
  private async request<T>(path: string, options: { method?: string; body?: unknown; account?: boolean; token?: string; signal?: AbortSignal } = {}): Promise<{ body: T; response: Response }> {
    const base = this.#state.cloudUrl;
    if (!base) throw new IdentityError('Configure a Capyra account service first');
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.account) {
      if (!this.#state.account || Date.parse(this.#state.account.expiresAt) <= Date.now()) throw new IdentityError('Sign in to your Capyra account', 401);
      headers.authorization = `Bearer ${this.#state.account.token}`; headers['x-csrf-token'] = this.#state.account.csrfToken;
    } else if (options.token) headers.authorization = `Bearer ${options.token}`;
    let response: Response;
    try { response = await fetch(base + path, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]) }); }
    catch { options.signal?.throwIfAborted(); throw new IdentityError('Capyra account service is unreachable; device access is paused', 503); }
    let body: T & { error?: string };
    try { body = await response.json() as T & { error?: string }; } catch { throw new IdentityError('Account service returned an invalid response', 502); }
    if (!response.ok) throw new IdentityError(typeof body.error === 'string' ? body.error : 'Account service rejected the request', response.status);
    return { body, response };
  }
  private rememberSession(body: { user: IdentityUser; csrfToken: string; expiresAt: string }, response: Response) {
    const token = response.headers.getSetCookie().find(value => value.startsWith('capyra_account='))?.split(';')[0]?.slice(15);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof body.csrfToken !== 'string' || !body.user?.id || !Number.isFinite(Date.parse(body.expiresAt))) throw new IdentityError('Account service returned an invalid session', 502);
    this.#state.account = { token, ...body }; this.save(); this.notify();
  }
  register(input: { email: string; password: string }): Promise<IdentityStatus> { return this.signIn('/v1/register', input); }
  login(input: { email: string; password: string }): Promise<IdentityStatus> { return this.signIn('/v1/login', input); }
  private signIn(path: string, input: { email: string; password: string }): Promise<IdentityStatus> { return this.serial(async () => {
    const { body, response } = await this.request<{ user: IdentityUser; csrfToken: string; expiresAt: string }>(path, { method: 'POST', body: input });
    this.rememberSession(body, response); return this.status();
  }); }
  refreshSession(): Promise<IdentityStatus> { return this.serial(async () => {
    const { body, response } = await this.request<{ user: IdentityUser; csrfToken: string; expiresAt: string }>('/v1/session/refresh', { method: 'POST', body: {}, account: true });
    this.rememberSession(body, response); return this.status();
  }); }
  changePassword(input: { currentPassword: string; password: string }): Promise<IdentityStatus> { return this.serial(async () => {
    const { body, response } = await this.request<{ user: IdentityUser; csrfToken: string; expiresAt: string }>('/v1/password', { method: 'POST', body: input, account: true });
    this.rememberSession(body, response); return this.status();
  }); }
  logout(): Promise<IdentityStatus> { return this.serial(async () => {
    let failure: unknown;
    try { if (this.#state.account) await this.request('/v1/logout', { method: 'POST', body: {}, account: true }); } catch (error) { failure = error; }
    delete this.#state.account; this.save(); this.notify();
    if (failure) throw failure; return this.status();
  }); }
  startPairing(): Promise<NonNullable<IdentityStatus['pairing']>> { return this.serial(async () => {
    if (this.#state.device) throw new IdentityError('Unbind this device before pairing it again');
    const code = randomBytes(10).toString('hex').toUpperCase(); const codeHash = hash(code); const nonce = secret(); const expiresAt = Date.now() + 5 * 60_000;
    const { body } = await this.request<{ id: string; expiresAt: string }>('/v1/pairings', { method: 'POST', body: { publicKey: this.#state.publicKey, codeHash, nonce, expiresAt, signature: signProof(this.#state.privateKey, 'pair', codeHash, nonce, expiresAt) } });
    this.pairing = { ...body, code, fingerprint: hash(this.#state.publicKey) }; this.notify(); return this.status().pairing!;
  }); }
  bind(input: { code: string; name?: string; scope: DeviceScope }): Promise<IdentityStatus> { return this.serial(async () => {
    const pairing = this.pairing; const user = this.status().user;
    if (!user) throw new IdentityError('Sign in before binding the local device', 401);
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now() || input.code !== pairing.code) throw new IdentityError('Start pairing on this computer and use its current code', 403);
    const scope = localScope(input.scope); const name = input.name?.trim() || hostname();
    const done = this.beginBindingChange(); this.pairing = undefined;
    try {
      const { body } = await this.request<IdentityDevice>('/v1/devices/pair', { method: 'POST', account: true, body: { pairingId: pairing.id, code: pairing.code, name, scope, signature: signProof(this.#state.privateKey, 'bind', pairing.id, user.id, name, scope) } });
      if (body.ownerId !== user.id || body.fingerprint !== hash(this.#state.publicKey)) throw new IdentityError('Account service returned mismatched device ownership', 502);
      this.#state.device = body; this.#state.localScope = scope; this.save();
    } finally { done(); this.notify(); }
    await this.refreshBinding(); return this.status();
  }); }
  async listDevices(): Promise<IdentityDevice[]> { return (await this.request<{ devices: IdentityDevice[] }>('/v1/devices', { account: true })).body.devices; }
  updateScope(deviceId: string, scope: DeviceScope): Promise<IdentityDevice> { return this.serial(async () => {
    const isLocal = this.#state.device?.id === deviceId;
    const approved = isLocal ? localScope(scope) : normalizeScope(scope);
    const done = isLocal ? this.beginBindingChange() : () => undefined;
    let device: IdentityDevice;
    try {
      device = (await this.request<IdentityDevice>(`/v1/devices/${encodeURIComponent(deviceId)}/scope`, { method: 'PATCH', body: { scope: approved }, account: true })).body;
      if (isLocal) { this.#state.device = device; this.#state.localScope = approved; this.save(); }
    } finally { done(); if (isLocal) this.notify(); }
    if (isLocal) await this.refreshBinding();
    return device;
  }); }
  revokeDevice(deviceId: string): Promise<IdentityStatus> { return this.serial(async () => {
    const isLocal = this.#state.device?.id === deviceId;
    const done = isLocal ? this.beginBindingChange() : () => undefined;
    try {
      const device = (await this.request<IdentityDevice>(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST', body: {}, account: true })).body;
      if (isLocal) { this.#state.device = device; this.save(); }
    } finally {
      done();
      if (isLocal) { this.error = 'Device access is paused; refresh to verify revocation'; this.notify(); }
    }
    return this.status();
  }); }
  unbind(): Promise<IdentityStatus> { return this.serial(async () => {
    const device = this.#state.device; const done = this.beginBindingChange();
    try {
      if (device && (!device.revokedAt || device.connection)) {
        // 先在云端撤销，失败时保留可重试的设备记录，避免遗留不可管理的公网入口。
        await this.request(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST', body: {}, account: true });
      }
      delete this.#state.device; delete this.#state.localScope; this.pairing = undefined; this.error = undefined; this.checkedAt = undefined; this.save();
    } finally { done(); this.notify(); }
    return this.status();
  }); }
  private async authenticate(): Promise<void> {
    const generation = this.bindingGeneration;
    if (this.bindingChanging || this.lifetime.signal.aborted) throw new IdentityError('Device binding is changing or closed', 409);
    if (this.authentication?.generation === generation) return this.authentication.promise;
    const promise = (async () => {
      const device = this.#state.device;
      if (!device || device.revokedAt) throw new IdentityError('Bind an active local device first', 403);
      const { body } = await this.request<{ challenge: string }>('/v1/device/challenge', { method: 'POST', body: { deviceId: device.id } });
      if (generation !== this.bindingGeneration || this.bindingChanging || this.lifetime.signal.aborted) throw new IdentityError('Device binding changed', 409);
      const result = (await this.request<{ token: string; expiresAt: string; device: IdentityDevice }>('/v1/device/authenticate', { method: 'POST', body: { deviceId: device.id, challenge: body.challenge, signature: signProof(this.#state.privateKey, 'authenticate', device.id, body.challenge) } })).body;
      if (generation !== this.bindingGeneration || this.bindingChanging || this.lifetime.signal.aborted || this.#state.device?.id !== device.id) throw new IdentityError('Device binding changed', 409);
      this.#runtimeToken = { token: result.token, expiresAt: result.expiresAt };
    })();
    this.authentication = { generation, promise };
    try { await promise; } finally { if (this.authentication?.promise === promise) this.authentication = undefined; }
  }
  private async deviceRequest<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.#runtimeToken || Date.parse(this.#runtimeToken.expiresAt) < Date.now() + 5000) await this.authenticate();
    try { return (await this.request<T>(path, { ...options, token: this.#runtimeToken!.token })).body; }
    catch (error) {
      if (!(error instanceof IdentityError) || error.status !== 401) throw error;
      this.#runtimeToken = undefined; await this.authenticate();
      return (await this.request<T>(path, { ...options, token: this.#runtimeToken!.token })).body;
    }
  }
  async refreshBinding(options: { signal?: AbortSignal } = {}): Promise<IdentityStatus> {
    const deviceId = this.#state.device?.id; const generation = this.bindingGeneration;
    if (this.bindingChanging || this.lifetime.signal.aborted) throw new IdentityError('Device binding is changing or closed', 409);
    if (!deviceId) { this.active = false; return this.status(); }
    try {
      options.signal?.throwIfAborted();
      const device = await this.deviceRequest<IdentityDevice>('/v1/device', { signal: options.signal });
      options.signal?.throwIfAborted();
      if (generation !== this.bindingGeneration || this.bindingChanging || this.lifetime.signal.aborted) throw new IdentityError('Device binding changed', 409);
      if (this.#state.device?.id !== deviceId || device.id !== deviceId || device.ownerId !== this.#state.device.ownerId || device.fingerprint !== hash(this.#state.publicKey)) throw new IdentityError('Device ownership no longer matches', 403);
      if (device.version < this.#state.device.version) throw new IdentityError('A newer device authorization is already active', 409);
      const changed = !this.active || device.version !== this.#state.device.version;
      this.#state.device = device; this.checkedAt = new Date().toISOString(); this.active = !device.revokedAt; this.error = undefined;
      if (changed) { this.save(); this.notify(); }
      return this.status();
    } catch (error) {
      if (options.signal?.aborted || generation !== this.bindingGeneration || this.#state.device?.id !== deviceId || this.lifetime.signal.aborted) throw error;
      this.active = false; this.#runtimeToken = undefined; this.error = error instanceof Error ? error.message : 'Device verification failed'; this.checkedAt = new Date().toISOString(); this.notify(); throw error;
    }
  }
  async authorize(input: { workspace: string; capability?: string }): Promise<void> {
    await this.refreshBinding();
    if (this.bindingChanging || this.lifetime.signal.aborted || !this.active || !this.#state.device || !this.#state.localScope) throw new IdentityError('Local device access is not authorized', 403);
    const path = realpathSync(resolve(input.workspace));
    const local = this.#state.localScope; const cloud = this.#state.device.scope;
    if (!local.workspaces.includes(path) || !cloud.workspaces.includes(path)) throw new IdentityError('This workspace is outside the device access scope', 403);
    if (input.capability && (!includesCapability(local.capabilities, input.capability) || !includesCapability(cloud.capabilities, input.capability))) throw new IdentityError('This capability is outside the device access scope', 403);
  }
  provisionConnection(input: { mcpPort: number }): Promise<DeviceConnection & { token: string }> { return this.serial(async () => {
    const device = this.#state.device; if (!device) throw new IdentityError('Bind the local device first');
    await this.request(`/v1/devices/${encodeURIComponent(device.id)}/connection`, { method: 'POST', body: input, account: true });
    await this.refreshBinding(); return this.deviceRequest<DeviceConnection & { token: string }>('/v1/device/connection');
  }); }
  approvalBinding(): ApprovalBinding | undefined {
    const device = this.#state.device;
    if (this.bindingChanging || this.lifetime.signal.aborted || !this.status().active || !device || device.revokedAt || !this.#state.cloudUrl) return undefined;
    return { deviceId: device.id, ownerId: device.ownerId, version: device.version, generation: this.bindingGeneration, cloudUrl: this.#state.cloudUrl };
  }
  setApprovalRelayStatus(status: ApprovalRelayStatus): void { this.approvalRelay = structuredClone(status); }
  async syncApprovals(requests: MobileApprovalRequest[], options: { signal?: AbortSignal } = {}): Promise<{ deviceId: string; version: number; decisions: MobileApprovalDecision[] }> {
    const binding = this.approvalBinding();
    if (!binding) throw new IdentityError('手机批准需要已验证的本机设备绑定', 403);
    const matches = () => JSON.stringify(this.approvalBinding()) === JSON.stringify(binding);
    options.signal?.throwIfAborted();
    const result = await this.deviceRequest<{ deviceId: string; version: number; decisions: MobileApprovalDecision[] }>('/v1/device/approvals/sync', { method: 'POST', body: { requests }, signal: options.signal });
    options.signal?.throwIfAborted();
    if (!matches() || result.deviceId !== binding.deviceId || result.version !== binding.version || !Array.isArray(result.decisions)) throw new IdentityError('手机批准响应与当前设备绑定不符', 409);
    // 有决定时再做一次即时云端核实；撤销或范围变更不能借旧的同步响应生效。
    if (result.decisions.length) await this.refreshBinding(options);
    options.signal?.throwIfAborted();
    if (!matches()) throw new IdentityError('手机批准期间设备状态已变化', 409);
    return result;
  }
  bridgePublicUrl(): string | undefined {
    const device = this.#state.device;
    return !this.lifetime.signal.aborted && device && !device.revokedAt && this.#state.cloudUrl ? `${this.#state.cloudUrl}/devices/${encodeURIComponent(device.id)}/bridge` : undefined;
  }
  publishBridge(upstream: string): Promise<{ publicUrl: string; upstream: string; updatedAt: string; expiresAt: number }> { return this.serial(async () => {
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(upstream)) throw new IdentityError('Expected the current Cloudflare Quick Tunnel origin');
    await this.refreshBinding();
    const device = this.#state.device, generation = this.bindingGeneration, publicUrl = this.bridgePublicUrl();
    if (!device || !this.active || !publicUrl) throw new IdentityError('Bind and verify the local device first', 403);
    // 留出一分钟时钟与传输裕量，仍受云端五分钟最长租期约束。
    const nonce = secret(), expiresAt = Date.now() + 4 * 60_000;
    const body = await this.deviceRequest<{ publicUrl: string; upstream: string; updatedAt: string; expiresAt: number }>('/v1/device/bridge', { method: 'POST', body: { upstream, nonce, expiresAt, signature: signProof(this.#state.privateKey, 'connection-bridge', device.id, device.version, upstream, nonce, expiresAt) } });
    if (generation !== this.bindingGeneration || this.bindingChanging || this.lifetime.signal.aborted || this.#state.device?.id !== device.id || this.#state.device.version !== device.version || body.publicUrl !== publicUrl || body.upstream !== upstream || body.expiresAt !== expiresAt) throw new IdentityError('Device bridge response no longer matches this binding', 409);
    return body;
  }); }
  removeBridge(): Promise<void> { return this.serial(async () => {
    if (!this.#state.device || this.#state.device.revokedAt) return;
    await this.refreshBinding();
    const device = this.#state.device!;
    const nonce = secret(), expiresAt = Date.now() + 60_000;
    await this.deviceRequest('/v1/device/bridge', { method: 'DELETE', body: { nonce, expiresAt, signature: signProof(this.#state.privateKey, 'connection-bridge-remove', device.id, device.version, nonce, expiresAt) } });
  }); }
  rotateConnection(): Promise<DeviceConnection & { token: string }> { return this.serial(async () => {
    const device = this.#state.device; if (!device) throw new IdentityError('Bind the local device first');
    const done = this.beginBindingChange();
    try { await this.request(`/v1/devices/${encodeURIComponent(device.id)}/connection/rotate`, { method: 'POST', body: {}, account: true }); }
    finally { done(); this.notify(); }
    await this.refreshBinding(); return this.deviceRequest<DeviceConnection & { token: string }>('/v1/device/connection');
  }); }
  close(): void { this.bindingGeneration++; clearInterval(this.timer); this.lifetime.abort(); this.active = false; this.notify(); this.listeners.clear(); }
}
export function createIdentityService(options: IdentityServiceOptions): IdentityService { return new IdentityService(options); }
