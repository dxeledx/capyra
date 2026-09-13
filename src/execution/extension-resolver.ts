import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 让 Node 自己处理 import 条件、exports 子路径和封装边界；解析不加载 SDK。
// parentURL 的官方开关只加到此短进程，主服务无需实验标志或全局 loader hook。
const resolver = `
try {
  process.stdout.write(JSON.stringify({ url: import.meta.resolve(process.argv[1], process.argv[2]) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message, code: error.code }));
}
`;
const cache = new Map<string, { filename: string; manifest: string; stamp: string }>();
function file(filename: string): string {
  if (!statSync(filename).isFile()) throw new Error(`Extension module is not a file: ${filename}`);
  return filename;
}
function packageManifest(parent: string, request: string) {
  const name = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
  for (const directory of createRequire(parent).resolve.paths(name) ?? []) {
    const manifest = path.join(directory, name, 'package.json');
    try {
      const info = statSync(manifest, { bigint: true });
      if (info.isFile()) return { manifest, stamp: `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}` };
    } catch { /* 缺包的默认配置只检查目录，不为每次可用性轮询启动 Node。 */ }
  }
  throw Object.assign(new Error(`Extension package was not found: ${name}`), { code: 'ERR_MODULE_NOT_FOUND' });
}

/** Resolve an optional SDK using ESM import conditions from its provider extension directory. */
export function resolveExtension(stateDir: string, provider: string, request: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !request || request.includes('\0')) throw new Error('Invalid extension module request');
  const parent = pathToFileURL(path.resolve(stateDir, 'extensions', provider, 'package.json')).href;
  if (path.isAbsolute(request)) return file(request);
  if (request.startsWith('file:') || request.startsWith('./') || request.startsWith('../')) return file(fileURLToPath(new URL(request, parent)));
  if (request.includes(':') || request.startsWith('#')) throw new Error('Extension modules must resolve to a local file or installed package');
  const current = packageManifest(parent, request);
  const key = `${parent}\0${request}`;
  const saved = cache.get(key);
  if (saved?.manifest === current.manifest && saved.stamp === current.stamp) {
    try { return file(saved.filename); } catch { /* 卸载或删除入口后不能继续报告扩展可用。 */ }
  }
  cache.delete(key);
  const result = JSON.parse(execFileSync(process.execPath,
    ['--experimental-import-meta-resolve', '--input-type=module', '--eval', resolver, '--', request, parent],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 65_536,
      env: { ...process.env, NODE_OPTIONS: undefined }, stdio: ['ignore', 'pipe', 'pipe'] })) as { url?: string; error?: string; code?: string };
  if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
  if (!result.url?.startsWith('file:')) throw new Error('Extension modules must resolve to a local file');
  // import.meta.resolve 可以返回不存在的 file URL，可用性查询必须检查实际文件。
  const filename = file(fileURLToPath(result.url));
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, { filename, ...current });
  return filename;
}
