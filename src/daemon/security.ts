import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const protocolVersion = 1;
export interface Scope { owner: string; workspace: string }
export interface DaemonRequest { version: number; id: string; method: string; params: Record<string, unknown>; scope?: Scope; revision?: string; instance: string; issuedAt: number; signature: string }
export class DaemonError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'DaemonError'; } }

export function daemonPaths(stateDir: string, platform: NodeJS.Platform = process.platform) {
  const root = path.resolve(stateDir), directory = path.join(root, 'agentd');
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 24);
  // 长工作区路径也必须适配 macOS 104 字节的 Unix socket 地址限制。
  const socketDirectory = platform !== 'win32' && Buffer.byteLength(path.join(directory, 'socket')) > 100
    ? path.join(platform === 'darwin' ? '/private/tmp' : '/tmp', `capyra-agentd-${process.getuid?.() ?? 'user'}-${digest}`) : directory;
  return { directory, socketDirectory, secret: path.join(directory, 'secret'), lock: path.join(directory, 'lock'), log: path.join(directory, 'events.log'), endpoint: platform === 'win32' ? `\\\\.\\pipe\\capyra-agentd-${digest}` : path.join(socketDirectory, 'socket') };
}

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new DaemonError('DAEMON_UNSAFE_PATH', 'Daemon directory must be owned by the current local user and cannot be a symbolic link.');
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
}

export function readPrivate(filename: string, maxBytes = 1024 * 1024): string {
  const before = lstatSync(filename);
  if (before.isSymbolicLink()) throw new DaemonError('DAEMON_UNSAFE_FILE', 'Daemon files cannot be symbolic links.');
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxBytes || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) throw new DaemonError('DAEMON_UNSAFE_FILE', 'Daemon credential or state file must be a private, regular file owned by the current user.');
    // hard-link发布到删除临时名之间nlink短暂为2；此时绝不读取正文，只让调用方有界等待发布结束。
    if (info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1) throw new DaemonError('DAEMON_FILE_BUSY', 'Daemon private file is being published or replaced.');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

export async function readPublished<T>(read: () => T, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return read(); }
    catch (error) {
      if (!(error instanceof DaemonError) || error.code !== 'DAEMON_FILE_BUSY') throw error;
      if (attempt >= 24) throw new DaemonError('DAEMON_UNSAFE_FILE', 'Daemon private file remained linked or changed throughout the publication deadline.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export function daemonSecret(stateDir: string, create = false): string | undefined {
  const paths = daemonPaths(stateDir);
  if (create) { privateDirectory(path.resolve(stateDir)); privateDirectory(paths.directory); }
  try {
    const secret = readPrivate(paths.secret, 128).trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new DaemonError('DAEMON_INVALID_SECRET', 'Daemon authentication file is invalid.');
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return undefined;
  }
  const secret = randomBytes(32).toString('hex'), temporary = path.join(paths.directory, `.secret-${randomBytes(12).toString('hex')}`);
  // 原子发布完整凭据，并发客户端不能读到刚创建但尚未写完的空文件。
  writeFileSync(temporary, secret, { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, paths.secret); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { rmSync(temporary, { force: true }); }
  return daemonSecret(stateDir)!;
}

export function configurationRevision(config: Record<string, unknown>) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  // 权限、上下文和审批目标指纹参与版本协商，旧后台不能忽略新的执行前置条件。
  return createHash('sha256').update(JSON.stringify({ executionRevision: 5, config: canonical(config) })).digest('hex');
}

export function validateTargetHash(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('expectedTargetHash must be 64 lowercase hexadecimal characters.');
  return value;
}

export function signRequest(secret: string, request: Omit<DaemonRequest, 'signature' | 'issuedAt'> & { issuedAt?: number }): DaemonRequest {
  const payload = { ...request, issuedAt: request.issuedAt ?? Date.now() };
  return { ...payload, signature: createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex') };
}
export function verifyRequest(secret: string, value: unknown): DaemonRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DaemonError('DAEMON_AUTH', 'Invalid daemon request.');
  const { signature, ...payload } = value as DaemonRequest;
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new DaemonError('DAEMON_AUTH', 'Daemon authentication failed.');
  const expected = signRequest(secret, payload).signature;
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new DaemonError('DAEMON_AUTH', 'Daemon authentication failed.');
  if (payload.version !== protocolVersion || typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.id) || typeof payload.method !== 'string' || !payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params)) throw new DaemonError('DAEMON_PROTOCOL', 'Invalid daemon protocol.');
  if (!Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < Date.now() - 30_000 || payload.issuedAt > Date.now() + 2000 || typeof payload.instance !== 'string') throw new DaemonError('DAEMON_AUTH_EXPIRED', 'Daemon request authentication has expired.');
  if (payload.scope && (typeof payload.scope.owner !== 'string' || !payload.scope.owner || typeof payload.scope.workspace !== 'string' || !path.isAbsolute(payload.scope.workspace))) throw new DaemonError('DAEMON_SCOPE', 'Invalid daemon scope.');
  return value as DaemonRequest;
}

export function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
