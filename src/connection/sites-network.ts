import { request } from 'node:https';
import { isIP } from 'node:net';

const addresses = new Map<string, { values: string[]; expires: number }>();
const connectionErrors = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function connectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && connectionErrors.has(code)) return true;
  return error.cause !== undefined && error.cause !== error && connectionFailure(error.cause);
}

async function resolvePublic(hostname: string, signal: AbortSignal): Promise<string[]> {
  const cached = addresses.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.values;
  // DoH 避免 TUN 把发往公共 DNS 的 UDP 查询再次改写为 Fake-IP。
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Sites 公共 DNS 暂不可达'); }
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; if (size > 65_536) throw new Error('Sites DNS 响应过大'); chunks.push(chunk); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Answer?: { type: number; data: string; TTL: number }[] };
  const routable = (data.Answer ?? []).filter(record => record.type === 1 && publicIpv4(record.data));
  if (!routable.length) throw new Error('Sites 公共 DNS 未返回有效公网地址');
  const values = [...new Set(routable.map(record => record.data))].slice(0, 2);
  const ttl = Math.min(60, ...routable.map(record => Number.isFinite(record.TTL) ? Math.max(0, record.TTL) : 0));
  if (addresses.size >= 32) addresses.delete(addresses.keys().next().value!);
  addresses.set(hostname, { values, expires: Date.now() + ttl * 1_000 });
  return values;
}

function direct(url: URL, address: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    // 只固定该请求的解析结果，保留原域名、SNI 与默认 TLS 证书校验，不修改系统代理或路由。
    const outgoing = request(url, {
      method: 'POST', headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)), 'accept-encoding': 'identity' },
      servername: url.hostname, signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
    }, incoming => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { const error = new Error('Sites 响应超过限制'); reject(error); outgoing.destroy(error); }
        else chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) resultHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status > 599) { reject(new Error('Sites 返回无效 HTTP 状态')); return; }
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
      });
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
}

/** 首选系统网络；仅连接异常触发固定站点的公共 DNS 回退，HTTP 失败和 TLS 拒绝不回退。 */
export async function sitesFetch(origin: string, path: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
  const base = new URL(origin), url = new URL(path, base);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || url.origin !== base.origin || !path.startsWith('/api/devices')) throw new Error('Sites 网络目标无效');
  const cached = addresses.get(base.hostname);
  if (cached && cached.expires > Date.now()) {
    try { return await direct(url, cached.values[0], headers, body, signal); }
    catch (error) { if (signal.aborted || !connectionFailure(error)) throw error; addresses.delete(base.hostname); }
  }
  try {
    return await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
  } catch (error) {
    if (signal.aborted || !connectionFailure(error)) throw error;
    const resolved = await resolvePublic(base.hostname, signal);
    let lastError: unknown = error;
    for (const address of resolved) {
      try { return await direct(url, address, headers, body, signal); }
      catch (failure) { if (signal.aborted || !connectionFailure(failure)) throw failure; lastError = failure; }
    }
    throw lastError;
  }
}
