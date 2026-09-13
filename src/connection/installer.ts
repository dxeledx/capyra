import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { privateDirectory, readPrivate, writePrivate } from './private-store.js';
import type { CloudflaredInstallation } from './types.js';

const execute = promisify(execFile);
export type ConnectionFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ReleaseMetadata { tag_name: string; body?: string; assets: { name: string; browser_download_url: string; digest?: string; size?: number }[] }
export function assetName(platform: string, architecture: string): string {
  const arch = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[architecture];
  if (!arch || !['darwin', 'linux', 'win32'].includes(platform) || (platform === 'darwin' && !['amd64', 'arm64'].includes(arch)) || (platform === 'win32' && !['amd64', '386'].includes(arch))) throw new Error(`此平台暂无自动安装包：${platform}/${architecture}`);
  return `cloudflared-${platform === 'win32' ? 'windows' : platform}-${arch}${platform === 'darwin' ? '.tgz' : platform === 'win32' ? '.exe' : ''}`;
}
export function releaseChecksum(release: ReleaseMetadata, name: string): string {
  const asset = release.assets.find(item => item.name === name);
  // 优先使用 GitHub 对上传资产计算的 digest；旧版发行说明仅作为兼容来源。
  if (asset?.digest && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)) return asset.digest.slice(7).toLowerCase();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = release.body?.match(new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*([a-f0-9]{64})`, 'i'));
  if (!match) throw new Error('官方发行版未提供有效 SHA-256，安装已停止');
  return match[1].toLowerCase();
}
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('响应为空');
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('下载超过大小限制'); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('下载超过大小限制'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export function extractExecutable(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('官方安装包 TAR 格式无效');
    const type = header[156];
    if (name === 'cloudflared' || name === './cloudflared') {
      if (type !== 0 && type !== 48) throw new Error('安装包中的 cloudflared 不是普通文件');
      return tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('官方安装包缺少 cloudflared 可执行文件');
}
export function minimalEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
export class CloudflaredInstaller {
  readonly binary: string;
  private pending?: Promise<CloudflaredInstallation>;
  constructor(private directory: string, private fetcher: ConnectionFetch = fetch, private platform = process.platform as string, private architecture = process.arch as string) {
    this.binary = join(directory, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }
  async detect(): Promise<CloudflaredInstallation> {
    const metadata = await readPrivate(join(this.directory, 'installation.json'));
    if (metadata) {
      try {
        const expected = JSON.parse(metadata) as { executableSha256: string; version: string };
        const info = await lstat(this.binary);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('cloudflared 文件类型无效');
        const digest = createHash('sha256').update(await readFile(this.binary)).digest('hex');
        if (digest !== expected.executableSha256) throw new Error('cloudflared 校验失败，请重新安装');
        return { installed: true, source: 'managed', path: this.binary, version: expected.version, checksumVerified: true };
      } catch { return { installed: false, checksumVerified: false, error: '受管 cloudflared 文件缺失或校验失败，请重新安装' }; }
    }
    try {
      const { stdout } = await execute('cloudflared', ['--version'], { timeout: 5000, maxBuffer: 8192, env: minimalEnvironment() });
      const version = stdout.match(/cloudflared version (\d+\.\d+\.\d+)/)?.[1];
      if (!version) throw new Error('无法识别 cloudflared 版本');
      return { installed: true, source: 'system', path: 'cloudflared', version, checksumVerified: false };
    } catch { return { installed: false, checksumVerified: false }; }
  }
  install(): Promise<CloudflaredInstallation> {
    if (!this.pending) this.pending = this.download().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async download(): Promise<CloudflaredInstallation> {
    const name = assetName(this.platform, this.architecture);
    const releaseResponse = await this.fetcher('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Capyra' }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!releaseResponse.ok) throw new Error(`获取官方 cloudflared 版本失败（HTTP ${releaseResponse.status}）`);
    const release = JSON.parse((await boundedBytes(releaseResponse, 2 * 1024 * 1024)).toString()) as ReleaseMetadata;
    if (!/^\d{4}\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('官方版本元数据无效');
    const asset = release.assets.find(item => item.name === name);
    if (!asset) throw new Error('官方版本没有当前平台的安装包');
    const expectedUrl = `https://github.com/cloudflare/cloudflared/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== expectedUrl) throw new Error('安装包地址不属于官方 Cloudflare 发行版');
    const checksum = releaseChecksum(release, name);
    const response = await this.fetcher(expectedUrl, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`下载 cloudflared 失败（HTTP ${response.status}）`);
    const archive = await boundedBytes(response, 100 * 1024 * 1024);
    if (createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('官方安装包 SHA-256 不匹配，安装已停止');
    const executable = name.endsWith('.tgz') ? extractExecutable(archive) : archive;
    await privateDirectory(this.directory);
    await writePrivate(this.binary, executable, 0o700);
    await writePrivate(join(this.directory, 'installation.json'), JSON.stringify({ version: release.tag_name, asset: name, assetSha256: checksum, executableSha256: createHash('sha256').update(executable).digest('hex'), installedAt: new Date().toISOString() }));
    return { installed: true, source: 'managed', path: this.binary, version: release.tag_name, checksumVerified: true };
  }
}
