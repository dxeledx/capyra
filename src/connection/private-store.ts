import { mkdir, lstat, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('连接状态目录必须为真实目录');
  await chmod(path, 0o700);
}
export async function readPrivate(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('连接状态文件必须为普通文件');
    await chmod(path, 0o600);
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function writePrivate(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await privateDirectory(dirname(path));
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('连接状态文件不能为软链接'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function redact(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:access_token|refresh_token|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/eyJ[A-Za-z0-9_+\/=.-]{20,}/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').slice(0, 1000);
}
