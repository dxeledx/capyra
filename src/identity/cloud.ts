import { MobileApprovals } from './mobile-approvals.js';
import { fileURLToPath } from 'node:url';
import { bridgeUpstream, bridgeRoute, proxyDeviceBridge } from './cloud-bridge.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { hash, IdentityError, normalizeScope, normalizedPublicKey, nowIso, readPrivateJson, requireString, secret, verifyProof, writePrivateJson } from './security.js';
import type { ConnectionProvider, DeviceConnection, DeviceScope, IdentityDevice, IdentityUser } from './types.js';

interface User extends IdentityUser { salt: string; passwordHash: string }
interface Session { hash: string; csrfHash: string; userId: string; expiresAt: number }
interface Pairing { id: string; codeHash: string; publicKey: string; expiresAt: number }
interface PairReplay { digest: string; expiresAt: number }
interface Device extends IdentityDevice { publicKey: string; connectionToken?: string; bridgeUpstream?: string; bridgeExpiresAt?: number }
interface DeviceToken { hash: string; deviceId: string; version: number; expiresAt: number }
interface Challenge { id: string; deviceId: string; expiresAt: number }
interface Database { version: 1; users: User[]; sessions: Session[]; pairings: Pairing[]; pairReplays: PairReplay[]; devices: Device[]; deviceTokens: DeviceToken[]; challenges: Challenge[]; bridgeReplays?: { digest: string; expiresAt: number }[] }
export interface IdentityCloudOptions { stateDir: string; port?: number; host?: string; publicOrigin?: string; provider?: ConnectionProvider; sessionTtlMs?: number; publicBasePath?: string }

function passwordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
function password(value: unknown): string {
  const result = requireString(value, 'password', 1024);
  if (result.length < 12 || Buffer.byteLength(result) > 1024) throw new IdentityError('Use a password of at least 12 characters');
  return result;
}
function email(value: unknown): string {
  const result = requireString(value, 'email', 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new IdentityError('Enter a valid email address');
  return result;
}
function publicUser(user: User): IdentityUser { return { id: user.id, email: user.email, createdAt: user.createdAt }; }
function publicDevice(device: Device): IdentityDevice { const { publicKey: _key, connectionToken: _token, bridgeUpstream: _upstream, bridgeExpiresAt: _expires, ...result } = device; return structuredClone(result); }

/** 一份状态目录由单个账号服务进程持有。文件锁阻止两个副本覆盖配对消费或撤销记录。 */
function acquireLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'identity.lock');
  const acquire = () => { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); };
  try { acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Identity state lock is invalid; inspect it before restarting');
    try { process.kill(pid, 0); throw new Error('Identity state is already open in another process'); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
    unlinkSync(path); acquire();
  }
  return () => { try { unlinkSync(path); } catch {} };
}

export async function startIdentityCloud(options: IdentityCloudOptions) {
  const unlock = acquireLock(options.stateDir);
  const statePath = join(options.stateDir, 'identity.json');
  let database: Database;
  try {
    database = readPrivateJson<Database>(statePath) ?? { version: 1, users: [], sessions: [], pairings: [], pairReplays: [], devices: [], deviceTokens: [], challenges: [] };
    database.pairReplays ??= []; database.bridgeReplays ??= [];
    if (database.version !== 1 || ['users', 'sessions', 'pairings', 'pairReplays', 'devices', 'deviceTokens', 'challenges'].some(key => !Array.isArray(database[key as keyof Database]))) throw new Error('Invalid identity database');
  } catch (error) { unlock(); throw error; }
  const publicBasePath = options.publicBasePath ?? '';
  if (publicBasePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(publicBasePath)) { unlock(); throw new Error('Invalid account public base path'); }
  const bridgeRequests = new Map<string, Set<AbortController>>();
  const cancelBridge = (id: string) => { for (const controller of bridgeRequests.get(id) ?? []) controller.abort(); };
  const sessionTtl = Math.max(60_000, Math.min(options.sessionTtlMs ?? 12 * 60 * 60_000, 7 * 24 * 60 * 60_000));
  let origin = options.publicOrigin ? new URL(options.publicOrigin).origin : '';
  if (options.publicOrigin && !options.publicOrigin.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(options.publicOrigin)) { unlock(); throw new Error('Public identity origin requires HTTPS'); }
  const save = () => {
    const now = Date.now();
    database.sessions = database.sessions.filter(item => item.expiresAt > now);
    database.bridgeReplays = database.bridgeReplays?.filter(item => item.expiresAt > now);
    database.pairings = database.pairings.filter(item => item.expiresAt > now);
    database.pairReplays = database.pairReplays.filter(item => item.expiresAt > now);
    database.deviceTokens = database.deviceTokens.filter(item => item.expiresAt > now);
    database.challenges = database.challenges.filter(item => item.expiresAt > now);
    writePrivateJson(statePath, database);
  };
  const pending = new Set<Promise<void>>();
  const asynchronous = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    const operation = Promise.resolve().then(() => handler(req, res));
    pending.add(operation);
    void operation.then(() => { pending.delete(operation); }, error => { pending.delete(operation); next(error); });
  };
  const mobileApprovals = new MobileApprovals(() => database.devices);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const rawPath = req.originalUrl.split('?')[0];
    let match: string[] | null = /^\/devices\/([a-f0-9-]{36})\/bridge(\/.*)$/.exec(rawPath);
    let suffix = match?.[2];
    if (!match) {
      const escapedPrefix = publicBasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const metadata = new RegExp('^/\\.well-known/(oauth-authorization-server|oauth-protected-resource)' + escapedPrefix + '/devices/([a-f0-9-]{36})/bridge(/mcp)?/?$').exec(rawPath);
      if (metadata && ((metadata[1] === 'oauth-authorization-server' && !metadata[3]) || (metadata[1] === 'oauth-protected-resource' && metadata[3] === '/mcp'))) {
        match = [metadata[0], metadata[2], '']; suffix = '/.well-known/' + metadata[1] + (metadata[3] ?? '');
      }
    }
    if (!match) { next(); return; }
    const id = match[1];
    void asynchronous(async (request, response) => {
      const sandboxPoll = request.method === 'GET' && /^\/oauth\/pending\/[A-Za-z0-9_-]{43}$/.test(suffix ?? '') && request.headers.origin === 'null' && !request.headers.cookie && !request.headers.authorization;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin && !sandboxPoll)) throw new IdentityError('Origin is not allowed', 403);
      if (request.originalUrl.length > 8192) throw new IdentityError('Bridge URL is too long', 414);
      if (!suffix || !bridgeRoute(request.method, suffix)) throw new IdentityError('Bridge route is not available', 404);
      if (sandboxPoll) { response.setHeader('Access-Control-Allow-Origin', 'null'); response.setHeader('Vary', 'Origin'); }
      limit(request, 'bridge', 600);
      const device = database.devices.find(item => item.id === id && !item.revokedAt);
      if (!device?.bridge || !device.bridgeUpstream || (device.bridgeExpiresAt ?? 0) <= Date.now()) throw new IdentityError('Device bridge is unavailable', 410);
      const requests = bridgeRequests.get(id) ?? new Set<AbortController>();
      if ([...bridgeRequests.values()].reduce((count, active) => count + active.size, 0) >= 256 || requests.size >= 16) throw new IdentityError('Device bridge is busy', 429);
      const controller = new AbortController(); requests.add(controller); bridgeRequests.set(id, requests);
      const version = device.version; const upstream = device.bridgeUpstream;
      try {
        await proxyDeviceBridge(request, response, { upstream, publicUrl: device.bridge.publicUrl, suffix: suffix + (request.originalUrl.includes('?') ? '?' + request.originalUrl.split('?').slice(1).join('?') : ''), signal: controller.signal,
          stillActive: () => !device.revokedAt && device.version === version && device.bridgeUpstream === upstream && (device.bridgeExpiresAt ?? 0) > Date.now() });
      } finally { requests.delete(controller); if (!requests.size) bridgeRequests.delete(id); }
    })(req, res, next);
  });
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.status(403).json({ error: 'Origin is not allowed' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) { res.status(415).json({ error: 'JSON is required' }); return; }
    next();
  });
  app.use('/v1/device/approvals/sync', express.json({ limit: '256kb', strict: true }));
  app.use(express.json({ limit: '32kb', strict: true }));
  const rate = new Map<string, { count: number; until: number }>();
  function limit(req: Request, category: string, maximum = 30) {
    const key = `${category}:${req.socket.remoteAddress}`;
    const now = Date.now();
    for (const [id, value] of rate) if (value.until < now) rate.delete(id);
    if (rate.size > 10_000) throw new IdentityError('Service is busy', 429);
    const entry = rate.get(key) ?? { count: 0, until: now + 60_000 };
    rate.set(key, entry);
    if (++entry.count > maximum) throw new IdentityError('Too many requests; try again later', 429);
  }
  function session(req: Request, mutation = false): { record: Session; user: User } {
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('capyra_account='))?.slice(15);
    const token = bearer ?? cookie;
    const record = token && database.sessions.find(item => item.hash === hash(token) && item.expiresAt > Date.now());
    const user = record && database.users.find(item => item.id === record.userId);
    if (!record || !user) throw new IdentityError('Sign in to your Capyra account', 401);
    if (mutation && ((!bearer && req.headers.origin !== origin) || typeof req.headers['x-csrf-token'] !== 'string' || hash(req.headers['x-csrf-token']) !== record.csrfHash)) throw new IdentityError('CSRF verification failed', 403);
    return { record, user };
  }
  function issueSession(res: Response, user: User) {
    const token = secret(); const csrfToken = secret(); const expiresAt = Date.now() + sessionTtl;
    database.sessions.push({ hash: hash(token), csrfHash: hash(csrfToken), userId: user.id, expiresAt });
    // cookie 供受同源保护的浏览器使用；本机代理仅取此 cookie，再通过 bearer 与 CSRF 双证明调用。
    res.cookie('capyra_account', token, { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: publicBasePath + '/v1', maxAge: sessionTtl });
    save();
    return { user: publicUser(user), csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }
  function ownedDevice(req: Request, mutation = false): Device {
    const { user } = session(req, mutation);
    const device = database.devices.find(item => item.id === req.params.id && item.ownerId === user.id);
    if (!device) throw new IdentityError('Device not found', 404);
    return device;
  }
  function runtimeDevice(req: Request): Device {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const credential = token && database.deviceTokens.find(item => item.hash === hash(token) && item.expiresAt > Date.now());
    const device = credential && database.devices.find(item => item.id === credential.deviceId && item.version === credential.version && !item.revokedAt);
    if (!device) throw new IdentityError('Device authorization expired or was revoked', 401);
    return device;
  }
  const work = new Set<string>();
  async function withDeviceLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (work.has(id)) throw new IdentityError('Device connection operation is already running', 409);
    work.add(id); try { return await operation(); } finally { work.delete(id); }
  }
  const mobileRoot = fileURLToPath(new URL('../../cloud/mobile/', import.meta.url));
  const mobilePolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  app.get('/approve', (req, res) => { if (req.path.endsWith('/')) { res.redirect(308, publicBasePath + '/approve'); return; } res.setHeader('Content-Security-Policy', mobilePolicy); res.sendFile(join(mobileRoot, 'index.html')); });
  for (const name of ['app.js', 'style.css']) app.get('/approve-assets/' + name, (_req, res) => { res.setHeader('Content-Security-Policy', mobilePolicy); res.sendFile(join(mobileRoot, name)); });
  app.post('/v1/device/approvals/sync', (req, res) => {
    const device = runtimeDevice(req); limit(req, 'approval-sync:' + device.id, 120); res.json(mobileApprovals.sync(device, req.body));
  });
  app.get('/v1/approvals', (req, res) => { const { user } = session(req); res.json(mobileApprovals.list(user.id)); });
  app.post('/v1/devices/:id/approvals/decide', (req, res) => {
    const device = ownedDevice(req, true); limit(req, 'approval-decide:' + device.id, 120); res.json(mobileApprovals.decide(device, req.body));
  });
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'capyra-identity', version: 1 }));
  app.post('/v1/register', asynchronous(async (req, res) => {
    limit(req, 'account', 15);
    const address = email(req.body.email); const pass = password(req.body.password); const salt = randomBytes(16).toString('hex');
    const passwordHash = (await passwordKey(pass, salt)).toString('hex');
    // 哈希运算完成后再检查唯一性；并发注册不能越过同一账号检查。
    if (database.users.some(item => item.email === address)) throw new IdentityError('This account cannot be registered', 409);
    const user: User = { id: randomUUID(), email: address, salt, passwordHash, createdAt: nowIso() };
    database.users.push(user); res.status(201).json(issueSession(res, user));
  }));
  app.post('/v1/login', asynchronous(async (req, res) => {
    limit(req, 'account', 15);
    const address = email(req.body.email); const pass = requireString(req.body.password, 'password', 1024);
    const user = database.users.find(item => item.email === address);
    const derived = await passwordKey(pass, user?.salt ?? 'invalid-account-placeholder');
    if (!user || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) throw new IdentityError('Email or password is incorrect', 401);
    res.json(issueSession(res, user));
  }));
  app.get('/v1/session', (req, res) => { const { record, user } = session(req); res.json({ user: publicUser(user), expiresAt: new Date(record.expiresAt).toISOString() }); });
  app.post('/v1/session/refresh', (req, res) => {
    const { record, user } = session(req, true); database.sessions = database.sessions.filter(item => item !== record); res.json(issueSession(res, user));
  });
  app.post('/v1/logout', (req, res) => { const { record } = session(req, true); database.sessions = database.sessions.filter(item => item !== record); save(); res.clearCookie('capyra_account', { path: publicBasePath + '/v1' }); res.json({ ok: true }); });
  app.post('/v1/password', asynchronous(async (req, res) => {
    limit(req, 'account', 15);
    const { user } = session(req, true);
    const oldHash = user.passwordHash;
    const derived = await passwordKey(requireString(req.body.currentPassword, 'current password', 1024), user.salt);
    if (!timingSafeEqual(derived, Buffer.from(oldHash, 'hex'))) throw new IdentityError('Current password is incorrect', 401);
    const salt = randomBytes(16).toString('hex'); const newHash = (await passwordKey(password(req.body.password), salt)).toString('hex');
    if (user.passwordHash !== oldHash) throw new IdentityError('Account changed; sign in again', 409);
    user.salt = salt; user.passwordHash = newHash; database.sessions = database.sessions.filter(item => item.userId !== user.id); res.json(issueSession(res, user));
  }));
  app.post('/v1/pairings', (req, res) => {
    limit(req, 'pair', 30);
    const publicKey = normalizedPublicKey(req.body.publicKey); const codeHash = requireString(req.body.codeHash, 'pairing digest', 64);
    const nonce = requireString(req.body.nonce, 'pairing nonce', 100);
    const expiresAt = req.body.expiresAt;
    const digest = hash(JSON.stringify([publicKey, nonce]));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000 || !/^[a-f0-9]{64}$/.test(codeHash) || !verifyProof(publicKey, req.body.signature, 'pair', codeHash, nonce, expiresAt)) throw new IdentityError('Invalid local pairing proof', 403);
    if (database.pairReplays.some(item => item.digest === digest && item.expiresAt > Date.now())) throw new IdentityError('Local pairing proof was already used', 403);
    database.pairReplays.push({ digest, expiresAt });
    // 相同公钥只允许一份待绑定记录，旧二维码或代码随新配对开始而失效。
    database.pairings = database.pairings.filter(item => item.publicKey !== publicKey);
    const pairing = { id: randomUUID(), publicKey, codeHash, expiresAt };
    database.pairings.push(pairing); save(); res.status(201).json({ id: pairing.id, expiresAt: new Date(pairing.expiresAt).toISOString() });
  });
  app.post('/v1/devices/pair', (req, res) => {
    limit(req, 'pair', 30);
    const { user } = session(req, true); const scope = normalizeScope(req.body.scope);
    const name = requireString(req.body.name, 'device name', 100).trim();
    const pairing = database.pairings.find(item => item.id === req.body.pairingId && item.expiresAt > Date.now());
    if (!pairing || hash(requireString(req.body.code, 'pairing code', 100)) !== pairing.codeHash || !verifyProof(pairing.publicKey, req.body.signature, 'bind', pairing.id, user.id, name, scope)) throw new IdentityError('Pairing expired, was used, or local proof is invalid', 403);
    if (database.devices.some(item => item.publicKey === pairing.publicKey && !item.revokedAt)) throw new IdentityError('This device is already bound; unbind it locally first', 409);
    const device: Device = { id: randomUUID(), ownerId: user.id, name, publicKey: pairing.publicKey, fingerprint: hash(pairing.publicKey), scope, version: 1, createdAt: nowIso(), updatedAt: nowIso() };
    // 消费与设备写入在一个同步提交中完成；相同代码的并发请求只会成功一次。
    database.pairings = database.pairings.filter(item => item !== pairing); database.devices.push(device); save(); res.status(201).json(publicDevice(device));
  });
  app.get('/v1/devices', (req, res) => { const { user } = session(req); res.json({ devices: database.devices.filter(item => item.ownerId === user.id).map(publicDevice) }); });
  app.get('/v1/devices/:id', (req, res) => res.json(publicDevice(ownedDevice(req))));
  app.patch('/v1/devices/:id/scope', (req, res) => {
    const device = ownedDevice(req, true); if (device.revokedAt) throw new IdentityError('Device is revoked', 409);
    cancelBridge(device.id); device.scope = normalizeScope(req.body.scope); device.updatedAt = nowIso(); device.version++; save(); res.json(publicDevice(device));
  });
  app.post('/v1/devices/:id/revoke', asynchronous(async (req, res) => {
    const device = ownedDevice(req, true);
    cancelBridge(device.id); delete device.bridge; delete device.bridgeUpstream; delete device.bridgeExpiresAt;
    if (!device.revokedAt) { device.revokedAt = nowIso(); device.version++; device.updatedAt = nowIso(); delete device.connectionToken; save(); }
    // 先撤销能力，再等待外部基础设施；供应商故障不会延长本机授权。
    if (device.connection) {
      if (!options.provider) throw new IdentityError('Device revoked; connection cleanup requires the configured provider', 503);
      try { await options.provider.revoke(device.connection); delete device.connection; save(); }
      catch { throw new IdentityError('Device revoked; connection cleanup failed and can be retried', 503); }
    }
    res.json(publicDevice(device));
  }));
  app.post('/v1/devices/:id/connection', asynchronous(async (req, res) => {
    const device = ownedDevice(req, true);
    if (device.revokedAt) throw new IdentityError('Device is revoked', 409);
    if (!options.provider) throw new IdentityError('Managed connections are not configured on this account service', 503);
    const mcpPort = req.body.mcpPort;
    if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535) throw new IdentityError('Invalid MCP port');
    const connection = await withDeviceLock(device.id, async () => {
      if (device.connection) return device.connection;
      const version = device.version;
      let issued: DeviceConnection & { token: string };
      try { issued = await options.provider!.provision({ deviceId: device.id, mcpPort }); }
      catch { throw new IdentityError('Connection provisioning failed; check account service diagnostics', 502); }
      if (device.revokedAt || device.version !== version) {
        await options.provider!.revoke(issued).catch(() => undefined); throw new IdentityError('Device authorization changed during provisioning', 409);
      }
      const { token, ...metadata } = issued;
      device.connection = metadata; device.connectionToken = token; device.updatedAt = nowIso(); save(); return metadata;
    });
    // 管理会话只获得描述信息，运行 token 必须由该设备的私钥换取。
    res.json(connection);
  }));
  app.post('/v1/devices/:id/connection/rotate', asynchronous(async (req, res) => {
    const device = ownedDevice(req, true);
    if (device.revokedAt || !device.connection) throw new IdentityError('An active connection is required', 409);
    if (!options.provider) throw new IdentityError('Connection provider is unavailable', 503);
    await withDeviceLock(device.id, async () => {
      let result: { token: string };
      try { result = await options.provider!.rotate(device.connection!); } catch { throw new IdentityError('Connection credential rotation failed', 502); }
      if (device.revokedAt) throw new IdentityError('Device was revoked', 409);
      device.connectionToken = result.token; device.version++; device.updatedAt = nowIso(); save();
    });
    res.json(publicDevice(device));
  }));
  app.post('/v1/device/challenge', (req, res) => {
    limit(req, 'device-proof', 120);
    const device = database.devices.find(item => item.id === req.body.deviceId && !item.revokedAt);
    if (!device) throw new IdentityError('Device is unavailable', 401);
    const challenge = { id: secret(), deviceId: device.id, expiresAt: Date.now() + 60_000 };
    database.challenges = database.challenges.filter(item => item.deviceId !== device.id);
    database.challenges.push(challenge); save(); res.json({ challenge: challenge.id, expiresAt: new Date(challenge.expiresAt).toISOString() });
  });
  app.post('/v1/device/authenticate', (req, res) => {
    limit(req, 'device-proof', 120);
    const device = database.devices.find(item => item.id === req.body.deviceId && !item.revokedAt);
    const challenge = database.challenges.find(item => item.id === req.body.challenge && item.deviceId === device?.id && item.expiresAt > Date.now());
    if (!device || !challenge || !verifyProof(device.publicKey, req.body.signature, 'authenticate', device.id, challenge.id)) throw new IdentityError('Invalid or replayed device proof', 401);
    database.challenges = database.challenges.filter(item => item !== challenge);
    const token = secret(); const expiresAt = Date.now() + 5 * 60_000;
    database.deviceTokens = database.deviceTokens.filter(item => item.deviceId !== device.id);
    database.deviceTokens.push({ hash: hash(token), deviceId: device.id, version: device.version, expiresAt }); save();
    res.json({ token, expiresAt: new Date(expiresAt).toISOString(), device: publicDevice(device) });
  });
  const bridgeProof = (req: Request, device: Device, upstream?: string) => {
    const { nonce, expiresAt, signature } = req.body;
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000) throw new IdentityError('Invalid bridge proof lifetime', 403);
    const args = upstream === undefined ? ['connection-bridge-remove', device.id, device.version, nonce, expiresAt] : ['connection-bridge', device.id, device.version, upstream, nonce, expiresAt];
    if (!verifyProof(device.publicKey, signature, ...args as [string, ...unknown[]])) throw new IdentityError('Invalid device bridge proof', 403);
    const digest = hash(JSON.stringify([device.id, nonce]));
    if (database.bridgeReplays?.some(item => item.digest === digest && item.expiresAt > Date.now())) throw new IdentityError('Bridge proof was already used', 403);
    database.bridgeReplays!.push({ digest, expiresAt });
    return expiresAt as number;
  };
  app.post('/v1/device/bridge', (req, res) => {
    const device = runtimeDevice(req); limit(req, 'bridge-update:' + device.id, 120); const upstream = bridgeUpstream(req.body.upstream);
    const expiresAt = bridgeProof(req, device, upstream);
    if (device.bridgeUpstream !== upstream) cancelBridge(device.id);
    device.bridge = { publicUrl: origin + publicBasePath + '/devices/' + device.id + '/bridge', updatedAt: nowIso() };
    device.bridgeUpstream = upstream; device.bridgeExpiresAt = expiresAt; save();
    res.json({ ...device.bridge, upstream, expiresAt });
  });
  app.get('/v1/device/bridge', (req, res) => {
    const device = runtimeDevice(req);
    if (!device.bridge || !device.bridgeUpstream || (device.bridgeExpiresAt ?? 0) <= Date.now()) throw new IdentityError('Device bridge is unavailable', 404);
    res.json({ ...device.bridge, upstream: device.bridgeUpstream, expiresAt: device.bridgeExpiresAt! });
  });
  app.delete('/v1/device/bridge', (req, res) => {
    const device = runtimeDevice(req); limit(req, 'bridge-update:' + device.id, 120); bridgeProof(req, device); cancelBridge(device.id);
    delete device.bridge; delete device.bridgeUpstream; delete device.bridgeExpiresAt; save(); res.json({ ok: true });
  });
  app.get('/v1/device', (req, res) => res.json(publicDevice(runtimeDevice(req))));
  app.get('/v1/device/connection', (req, res) => {
    const device = runtimeDevice(req);
    if (!device.connection || !device.connectionToken) throw new IdentityError('Device connection is not provisioned', 404);
    res.json({ ...device.connection, token: device.connectionToken });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof IdentityError) res.status(error.status).json({ error: error.message });
    else if (error instanceof SyntaxError || (error as { status?: number })?.status === 413) res.status(400).json({ error: 'Invalid request body' });
    else res.status(500).json({ error: 'Account service could not complete the request' });
  });
  const sockets = new Set<Socket>();
  const server = app.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 64;
  try { await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
  catch (error) { unlock(); throw error; }
  const url = `http://${options.host === '::1' ? '[::1]' : options.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
  if (!origin) origin = url;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closed = false;
  return { app, server, url, origin, async close() {
    if (closed) return; closed = true;
    for (const id of bridgeRequests.keys()) cancelBridge(id);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // 已断开的客户端仍可能有异步密码计算或供应商操作；等它们提交后才能交出单写锁。
    await Promise.allSettled([...pending]); unlock();
  } };
}
