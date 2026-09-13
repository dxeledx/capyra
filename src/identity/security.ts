import { createHash, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceScope } from './types.js';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nowIso = () => new Date().toISOString();
export class IdentityError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function requireString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new IdentityError(`Invalid ${name}`);
  return value;
}
export function normalizeScope(value: unknown): DeviceScope {
  const raw = value as DeviceScope | undefined;
  if (!raw || !Array.isArray(raw.workspaces) || !Array.isArray(raw.capabilities)) throw new IdentityError('Scope needs workspaces and capabilities');
  if (raw.workspaces.length > 100 || raw.capabilities.length > 200) throw new IdentityError('Scope is too large');
  const workspaces = raw.workspaces.map(path => {
    requireString(path, 'workspace', 4096);
    // 云端同时承载不同平台的设备；仅接受绝对路径，本机再按自身平台解析。
    if (!/^(\/|[A-Za-z]:[\\/])/.test(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new IdentityError('Workspace must be an absolute path without traversal');
    return path;
  });
  const capabilities = raw.capabilities.map(item => {
    requireString(item, 'capability', 100);
    if (!/^[a-zA-Z0-9_.*:-]+$/.test(item)) throw new IdentityError('Invalid capability');
    return item;
  });
  return { workspaces: [...new Set(workspaces)].sort(), capabilities: [...new Set(capabilities)].sort() };
}
export function normalizedPublicKey(value: unknown): string {
  try {
    const key = createPublicKey(requireString(value, 'public key', 2048));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch { throw new IdentityError('An Ed25519 public key is required'); }
}
// 签名使用固定字段组成的数组，避免属性顺序或不同动作之间的可替换解释。
export function proofPayload(action: string, ...parts: unknown[]): Buffer { return Buffer.from(JSON.stringify(['capyra-identity-v1', action, ...parts])); }
export function signProof(privateKey: string, action: string, ...parts: unknown[]): string { return sign(null, proofPayload(action, ...parts), privateKey).toString('base64url'); }
export function verifyProof(publicKey: string, signature: unknown, action: string, ...parts: unknown[]): boolean {
  if (typeof signature !== 'string' || signature.length > 256) return false;
  try { return verify(null, proofPayload(action, ...parts), publicKey, Buffer.from(signature, 'base64url')); } catch { return false; }
}
export function readPrivateJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 20_000_000) throw new Error('Identity state path is unsafe');
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function writePrivateJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error('Identity state path is unsafe');
  chmodSync(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
