import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 1024 * 1024;
const blockedNames = new Set(['.git', '.capyra', '.ssh', '.aws', '.azure', '.kube', '.gnupg', 'node_modules', '.npmrc', '.netrc', '.pypirc', 'capyra.json', 'capyra.local.json']);

export function isBlockedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return blockedNames.has(normalized) || normalized === '.env' || normalized.startsWith('.env.') || normalized.startsWith('.capyra-tmp-');
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Operation cancelled');
}

export function stringArg(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== 'string') throw new Error(`${name} must be a string`);
  return args[name] as string;
}

export async function workspacePath(workspace: string, input: string, options: { allowRoot?: boolean; allowMissing?: boolean } = {}): Promise<string> {
  if (input.includes('\0') || input.includes('\\') || path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new Error('Use a relative workspace path with forward slashes');
  }
  const segments = input.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) throw new Error('Parent traversal is not allowed');
  if (!segments.length && !options.allowRoot) throw new Error('A file path is required');
  if (segments.some(isBlockedName)) throw new Error('This path is protected');

  // 工作区由本机配置确定；逐段检查，避免工具通过目录软链接跨出边界。
  let current = await realpath(workspace);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (index < segments.length - 1 && !info.isDirectory()) throw new Error('Parent path must be a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.allowMissing && index === segments.length - 1) return current;
      throw error;
    }
  }
  return current;
}

export async function* walkWorkspace(workspace: string, start: string, signal: AbortSignal, maxDepth = 8): AsyncGenerator<{ path: string; type: 'file' | 'directory' }> {
  const pending = [{ name: start, depth: 0 }];
  let inspected = 0;
  while (pending.length) {
    const item = pending.shift()!;
    const target = await workspacePath(workspace, item.name, { allowRoot: true });
    for await (const entry of await opendir(target)) {
      checkCancelled(signal);
      // 把目录读取本身也计入预算，避免空目录或被保护条目造成无界扫描。
      if (++inspected > 20_000) throw new Error('Directory scan limit reached; choose a narrower path');
      if (entry.isSymbolicLink() || isBlockedName(entry.name) || (!entry.isFile() && !entry.isDirectory())) continue;
      const name = path.posix.join(item.name, entry.name);
      if (entry.isDirectory() && item.depth < maxDepth) pending.push({ name, depth: item.depth + 1 });
      yield { path: name, type: entry.isDirectory() ? 'directory' : 'file' };
    }
  }
}

export function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readBinaryHandle(handle: FileHandle, signal: AbortSignal): Promise<Buffer> {
  checkCancelled(signal);
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Only regular files are supported');
  if (info.nlink > 1) throw new Error('Files with multiple hard links are not supported');
  if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte limit`);
  // stat 后文件仍可能增长，因此实际读取也限制分配和累计字节数。
  const data = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < data.length) {
    checkCancelled(signal);
    const { bytesRead } = await handle.read(data, length, data.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte limit`);
  return data.subarray(0, length);
}

export async function readHandle(handle: FileHandle, signal: AbortSignal): Promise<{ content: string; hash: string; bytes: number; data: Buffer }> {
  const bytes = await readBinaryHandle(handle, signal);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Only UTF-8 text files are supported'); }
  if (content.includes('\0')) throw new Error('Binary files are not supported');
  return { content, hash: sha256(bytes), bytes: bytes.length, data: bytes };
}

export async function readWorkspaceFile(workspace: string, input: string, signal: AbortSignal) {
  const target = await workspacePath(workspace, input);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await readHandle(handle, signal); }
  finally { await handle.close(); }
}

export function textBytes(content: string): Buffer {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`Content exceeds the ${MAX_FILE_BYTES}-byte limit`);
  if (content.includes('\0')) throw new Error('Binary content is not supported');
  return Buffer.from(content, 'utf8');
}

export function expectedHash(args: Record<string, unknown>): string {
  const hash = stringArg(args, 'expectedHash');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('expectedHash must be a lowercase SHA-256 hash returned by read');
  return hash;
}

export function assertHash(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('File changed: expectedHash does not match. Read the file again and prepare a new operation.');
}
