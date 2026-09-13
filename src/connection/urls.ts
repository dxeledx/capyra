/** 公共基地址可包含设备前缀；拒绝解析器会自动消去的歧义路径。 */
export function publicBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\%]/.test(value)) throw new Error('Public URL must use a canonical HTTPS base path');
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!parts || parts[1].includes('@')) throw new Error('Public URL must not contain credentials, a query or a fragment');
  const path = parts[2] ?? '';
  if (path.includes('//') || path.split('/').some(segment => segment === '.' || segment === '..' || (segment && !/^[A-Za-z0-9._~-]+$/.test(segment)))) throw new Error('Public URL path is invalid');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Public URL requires HTTPS');
  return url.origin + path.replace(/\/$/, '');
}
export function publicEndpoint(base: string | URL, path: string): string { return `${publicBaseUrl(String(base))}/${path.replace(/^\//, '')}`; }
export function publicMetadataUrls(base: string | URL): { authorization: string; resource: string } {
  const canonical = publicBaseUrl(String(base)), url = new URL(canonical);
  const prefix = url.pathname === '/' ? '' : url.pathname;
  return { authorization: `${url.origin}/.well-known/oauth-authorization-server${prefix}`, resource: `${url.origin}/.well-known/oauth-protected-resource${prefix}/mcp` };
}
