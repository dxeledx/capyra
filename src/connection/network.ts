import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ConnectionNetwork } from './types.js';

export const CLOUDFLARE_EDGES = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'];
export function networkEnvironment(environment: NodeJS.ProcessEnv = process.env, interfaces = networkInterfaces()): Pick<ConnectionNetwork, 'vpnInterfaces' | 'proxyVariables' | 'recommendations'> {
  const vpnInterfaces = Object.keys(interfaces).filter(name => /^(utun|tun|tap|wg|ppp)\d*$/i.test(name) && interfaces[name]?.length).slice(0, 16);
  // 只检查代理变量是否非空；不解析或回传可能包含用户名密码的 URL。
  const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].filter(name => Boolean(environment[name]));
  const recommendations = ['建议使用 IPv4 与 TCP HTTP/2；出站需要允许 Cloudflare 7844/TCP。'];
  if (vpnInterfaces.length) recommendations.push('检测到可能的 VPN/TUN 网络接口。若出站失败，在 VPN 的分流设置中允许 cloudflared 或 Cloudflare Tunnel 域名直连后重试；Capyra 不修改系统路由。');
  if (proxyVariables.length) recommendations.push('当前进程设置了代理环境变量。隧道出站仍需可用的系统网络路径；这些变量不能保证绕过 VPN/TUN。');
  return { vpnInterfaces, proxyVariables, recommendations };
}
function within<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function tcpConnect(address: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, family: 4, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeout);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}
export interface NetworkProbeOptions {
  lookup?: (hostname: string) => Promise<string[]>; connect?: (address: string, port: number, timeout: number) => Promise<void>;
  timeoutMs?: number; environment?: NodeJS.ProcessEnv; interfaces?: ReturnType<typeof networkInterfaces>;
}
export async function probeConnectionNetwork(options: NetworkProbeOptions = {}): Promise<ConnectionNetwork> {
  const timeout = options.timeoutMs ?? 4000;
  const resolve = options.lookup ?? (async hostname => (await lookup(hostname, { family: 4, all: true })).map(item => item.address));
  const answers = await Promise.allSettled(CLOUDFLARE_EDGES.map(hostname => within(resolve(hostname), timeout)));
  const addresses = answers.flatMap(answer => answer.status === 'fulfilled' ? answer.value.slice(0, 1) : []);
  const checkedAt = new Date().toISOString();
  const environment = networkEnvironment(options.environment, options.interfaces);
  if (!addresses.length) return { ...environment, dns: { state: 'error', checkedAt, detail: 'Cloudflare Tunnel 域名的 IPv4 解析失败，请检查系统 DNS 或 VPN 分流。' }, tcp: { state: 'unknown', detail: 'DNS 尚未解析，未发起出站连接。' } };
  const connected = await Promise.allSettled(addresses.map(address => (options.connect ?? tcpConnect)(address, 7844, timeout)));
  const ok = connected.some(result => result.status === 'fulfilled');
  const fakeIpDetected = addresses.some(address => /^198\.(18|19)\./.test(address));
  if (fakeIpDetected) environment.recommendations.push('DNS 返回 198.18.0.0/15 地址，当前网络可能使用 Fake-IP。TCP 握手只能证明代理路径接受连接；以 connector 就绪状态和 HTTPS 回访分别核验隧道与客户端路径。');
  return { ...environment, fakeIpDetected,
    dns: { state: 'ok', checkedAt, detail: `已解析 ${addresses.length} 个 Cloudflare Tunnel 区域。${fakeIpDetected ? '结果包含可能由 VPN 返回的 Fake-IP。' : ''}` },
    tcp: { state: ok ? 'ok' : 'error', checkedAt: new Date().toISOString(), detail: ok ? fakeIpDetected ? '7844/TCP 代理路径握手成功；尚不能据此证明已连接 Cloudflare 边缘。' : 'Cloudflare 7844/TCP 路径握手成功；隧道注册和公网可用性另行核验。' : 'Cloudflare 7844/TCP 不可达，请检查防火墙、VPN/TUN 分流或切换网络后重试。' },
  };
}
