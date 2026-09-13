import type { Request, Response } from 'express';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { IdentityError } from './security.js';

export function bridgeUpstream(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(value)) throw new IdentityError('Use the HTTPS origin of this device Quick Tunnel', 400);
  return new URL(value).origin;
}

/** DNS 结果先验证再固定到该次 TLS 连接，避免第二次解析绕过内网限制。 */
export function publicBridgeAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
}

export function bridgeRoute(method: string, path: string): boolean {
  if (path === '/mcp') return ['GET', 'POST', 'DELETE', 'OPTIONS'].includes(method);
  if (path === '/health' || /^\/oauth\/pending\/[A-Za-z0-9_-]{43}$/.test(path)) return method === 'GET';
  if (path === '/authorize') return ['GET', 'POST'].includes(method);
  if (['/token', '/register', '/revoke'].includes(path)) return method === 'POST' || method === 'OPTIONS';
  return method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path);
}

const requestHeaders = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const responseHeaders = ['content-type', 'cache-control', 'www-authenticate', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'location', 'content-security-policy', 'referrer-policy', 'x-content-type-options'];

async function resolveBridgeHost(hostname: string) {
  try { return await dns.lookup(hostname, { all: true }); }
  catch (error) {
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(String((error as NodeJS.ErrnoException).code))) throw new IdentityError('Tunnel DNS lookup failed', 502);
    // 新 Quick 域名可能在系统解析链中命中负缓存；只对桥的白名单域名作有界重试，不改系统 DNS。
    const resolver = new dns.Resolver({ timeout: 2500, tries: 1 });
    resolver.setServers(['1.1.1.1']);
    try { return (await resolver.resolve4(hostname)).map(address => ({ address, family: 4 })); }
    catch { throw new IdentityError('Tunnel DNS lookup failed; retry after the tunnel is ready', 502); }
    finally { resolver.cancel(); }
  }
}

/** 仅转发协议白名单；身份 cookie、控制台会话与代理配置头不会穿过此入口。 */
export async function proxyDeviceBridge(req: Request, res: Response, input: { upstream: string; suffix: string; publicUrl: string; signal: AbortSignal; stillActive: () => boolean }): Promise<void> {
  const upstream = new URL(bridgeUpstream(input.upstream));
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([resolveBridgeHost(upstream.hostname), new Promise<never>((_resolve, reject) => { dnsTimeout = setTimeout(() => reject(new IdentityError('Tunnel DNS timed out', 504)), 5000); dnsTimeout.unref(); })]).finally(() => clearTimeout(dnsTimeout));
  if (!records.length || records.some(record => !publicBridgeAddress(record.address))) throw new IdentityError('Tunnel address is not publicly routable', 502);
  if (input.signal.aborted || !input.stillActive()) throw new IdentityError('Device bridge is unavailable', 410);
  const record = records.find(item => item.family === 4) ?? records[0];
  const headers: Record<string, string> = {};
  for (const name of requestHeaders) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  for (const [name, value] of Object.entries(req.headers)) if (/^mcp-param-[a-z0-9-]{1,64}$/.test(name) && typeof value === 'string') headers[name] = value;
  // sandbox 授权页为不透明来源；只有云端核验过的随机 pending 路由可去掉 null Origin。
  if (typeof req.headers.origin === 'string' && req.headers.origin !== 'null') headers.origin = req.headers.origin;
  headers['accept-encoding'] = 'identity';
  // URL 中只有已经验证过的固定路径和原始查询；绝不跟随上游重定向。
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearInterval(leaseCheck); input.signal.removeEventListener('abort', aborted); res.removeListener('close', disconnected);
      if (error) { outgoing.destroy(); if (res.headersSent) { res.destroy(); resolve(); } else reject(error); } else resolve();
    };
    const aborted = () => finish(new IdentityError('Device bridge is unavailable', 410));
    const disconnected = () => { outgoing.destroy(); finish(); };
    const outgoing = https.request({ hostname: upstream.hostname, port: 443, path: input.suffix, method: req.method, headers,
      servername: upstream.hostname, family: record.family, lookup: (_host, _options, callback) => callback(null, record.address, record.family),
    }, incoming => {
      if (!input.stillActive() || input.signal.aborted) { incoming.destroy(); aborted(); return; }
      res.status(incoming.statusCode ?? 502);
      for (const name of responseHeaders) {
        const value = incoming.headers[name];
        if (typeof value !== 'string') continue;
        if (name === 'location') {
          let target: URL;
          try { target = new URL(value, upstream); } catch { incoming.destroy(); finish(new IdentityError('Invalid tunnel redirect', 502)); return; }
          if (target.origin === upstream.origin && bridgeRoute('GET', target.pathname)) res.setHeader(name, input.publicUrl + target.pathname + target.search);
          else if (target.protocol === 'https:' && !target.username && !target.password && target.hostname === 'chatgpt.com' && target.pathname.startsWith('/connector/oauth/')) res.setHeader(name, target.href);
          else { incoming.destroy(); finish(new IdentityError('Unsupported tunnel redirect', 502)); return; }
        } else res.setHeader(name, value);
      }
      // 独立 CSP 策略与设备策略取交集，设备不能用 allow-same-origin 覆盖云端隔离。
      const policy = res.getHeader('content-security-policy');
      res.setHeader('Content-Security-Policy', [...(typeof policy === 'string' ? [policy] : []), 'sandbox allow-scripts allow-forms allow-top-navigation']);
      res.setHeader('X-Accel-Buffering', 'no');
      const gated = new Transform({ transform(chunk, _encoding, done) {
        if (!input.stillActive() || input.signal.aborted) done(new IdentityError('Device bridge is unavailable', 410)); else done(null, chunk);
      } });
      gated.on('error', error => { incoming.destroy(); finish(error); });
      incoming.on('error', error => finish(error)); incoming.on('end', () => finish()); incoming.pipe(gated).pipe(res);
    });
    const leaseCheck = setInterval(() => { if (!input.stillActive()) aborted(); }, 1000); leaseCheck.unref();
    const deadline = setTimeout(() => finish(new IdentityError('Device bridge timed out', 504)), 10 * 60_000); deadline.unref();
    outgoing.setTimeout(75_000, () => finish(new IdentityError('Device bridge timed out', 504)));
    outgoing.on('error', () => finish(new IdentityError('Device tunnel is unreachable', 502)));
    input.signal.addEventListener('abort', aborted, { once: true }); res.once('close', disconnected);
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) done(new IdentityError('MCP request exceeds 1 MiB', 413)); else done(null, chunk);
    } });
    bounded.on('error', error => finish(error)); req.once('aborted', disconnected); req.pipe(bounded).pipe(outgoing);
  });
}
