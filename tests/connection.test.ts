import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import express from 'express';
import { CloudflaredInstaller, assetName, releaseChecksum, type ConnectionFetch } from '../src/connection/installer.js';
import { createConnectionService as createService } from '../src/connection/service.js';
import { networkEnvironment, probeConnectionNetwork } from '../src/connection/network.js';
import { CloudflareApiProvider, PUBLIC_ROUTE_PATTERN } from '../src/connection/cloudflare-api.js';
import { redact, writePrivate } from '../src/connection/private-store.js';
import { createOAuth } from '../src/transport/oauth.js';
import { startMcpHttp, type McpRuntime } from '../src/transport/mcp.js';
import { publicMetadataUrls } from '../src/connection/urls.js';

const origin = 'https://device.example.com';
const deviceToken = 'device-only-runtime-token-for-testing';
const installed = { installed: true, path: '/fixture/cloudflared', version: '2026.9.0', checksumVerified: true, source: 'managed' as const };
const installer = { async detect() { return installed; }, async install() { return installed; } };
const createConnectionService = (options: Parameters<typeof createService>[0]) => createService({ networkProbe: async () => ({ dns: { state: 'ok' }, tcp: { state: 'ok' }, vpnInterfaces: [], proxyVariables: [], recommendations: [] }), ...options });
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(20); } assert.fail('Condition did not become true'); }

test('official installation verifies asset digest, detects tampering, and never accepts a foreign download', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-cloudflared-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from('fixture executable'); const digest = createHash('sha256').update(binary).digest('hex');
  const release = { tag_name: '2026.9.0', assets: [{ name: 'cloudflared-linux-amd64', browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-linux-amd64', digest: `sha256:${digest}` }] };
  const requests: string[] = [];
  const fetcher: ConnectionFetch = async input => { requests.push(String(input)); return requests.length % 2 === 1 ? json(release) : new Response(binary); };
  const managed = new CloudflaredInstaller(directory, fetcher, 'linux', 'x64');
  assert.equal((await managed.install()).checksumVerified, true);
  assert.equal((await stat(join(directory, 'installation.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(managed.binary)).mode & 0o777, 0o700);
  assert.equal((await managed.detect()).installed, true);
  await writeFile(managed.binary, 'tampered');
  assert.equal((await managed.detect()).installed, false);
  release.assets[0].browser_download_url = 'https://example.com/cloudflared';
  await assert.rejects(managed.install(), /官方/);
  assert.equal(requests.length, 3);
  assert.equal(assetName('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
  assert.throws(() => assetName('win32', 'arm64'), /平台/);
  assert.equal(releaseChecksum({ tag_name: '2020.1.0', assets: [], body: `SHA256 Checksums:\ncloudflared-linux-amd64: ${digest}` }, 'cloudflared-linux-amd64'), digest);
});

test('invalid official checksum leaves no executable and private state refuses symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-cloudflared-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const release = { tag_name: '2026.9.0', assets: [{ name: 'cloudflared-linux-amd64', browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-linux-amd64', digest: `sha256:${'0'.repeat(64)}` }] };
  const managed = new CloudflaredInstaller(directory, async input => String(input).includes('api.github.com') ? json(release) : new Response('untrusted'), 'linux', 'x64');
  await assert.rejects(managed.install(), /SHA-256/);
  await assert.rejects(stat(managed.binary), { code: 'ENOENT' });
  const target = join(directory, 'target'); await writeFile(target, 'unchanged'); await symlink(target, join(directory, 'linked'));
  await assert.rejects(writePrivate(join(directory, 'linked'), 'changed'), /软链接/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.doesNotMatch(redact(`token=${deviceToken} Authorization: Bearer abcdef`, [deviceToken]), /device-only|abcdef/);
});

test('connection process lifecycle separates tunnel/OAuth/tool observations, redacts credentials and restores explicitly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const launches: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const urls: (string | undefined)[] = [];
  const launch = (_file: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    launches.push({ args, env: options?.env });
    return spawn(process.execPath, ['-e', `process.stderr.write('Registered tunnel connection\\n');setInterval(()=>{},1000);`], options);
  };
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, spawn: launch, fetch: async () => json({ error: 'offline fixture' }, 503), onPublicUrl: url => { urls.push(url); } });
  t.after(() => service.close().catch(() => {}));
  assert.equal(service.status().configuration.mode, 'quick');
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken, autoStart: true });
  assert.equal(service.status().authorization.state, 'unknown');
  const config = await readFile(join(directory, 'connection.json'), 'utf8'); assert.doesNotMatch(config, /device-only-runtime-token/);
  assert.equal((await stat(join(directory, 'tunnel-token'))).mode & 0o777, 0o600);
  await service.start(); await until(() => service.status().tunnel.state !== 'starting');
  assert.equal(launches.length, 1); assert.ok(launches[0].args.includes('--token-file')); assert.ok(!launches[0].args.includes(deviceToken));
  assert.equal(launches[0].env?.TUNNEL_TOKEN, undefined);
  assert.equal(service.status().toolCall.state, 'not_observed'); assert.equal(service.status().chatgptVerification, 'not_verified');
  service.observeOAuth({ status: 'authorized', selfTest: true }); service.observeToolCall({ clientName: 'ChatGPT', selfTest: true });
  assert.equal(service.status().authorization.state, 'unknown'); assert.equal(service.status().toolCall.count, 0);
  service.observeOAuth({ status: 'authorized', clientName: 'test client' }); service.observeToolCall({ clientName: 'ChatGPT', tool: 'workspace__read' });
  assert.equal(service.status().authorization.state, 'authorized'); assert.equal(service.status().toolCall.count, 1); assert.equal(service.status().chatgptVerification, 'not_verified');
  await service.close();
  const restored = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, spawn: launch, fetch: async () => json({}, 503) });
  t.after(() => restored.close().catch(() => {}));
  assert.equal(restored.status().tunnel.state, 'stopped'); assert.equal(restored.status().authorization.state, 'unknown');
  await restored.restore(); assert.equal(launches.length, 2); await restored.stop(); assert.equal(restored.status().tunnel.state, 'stopped');
  await restored.configure({ clearToken: true }); assert.equal(restored.status().configuration.hasToken, false);
  await assert.rejects(restored.start(), /凭据/);
  assert.ok(urls.includes(origin));
});

test('unexpected exit retries, explicit stop cancels retry, and config rejects control-port routing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let launches = 0;
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, retryBaseMs: 20, fetch: async () => json({}, 503), spawn(_file, _args, options) { launches++; return spawn(process.execPath, ['-e', launches === 1 ? 'process.exit(1)' : 'setInterval(()=>{},1000)'], options); } });
  t.after(() => service.close().catch(() => {}));
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken });
  await service.start(); await until(() => launches >= 2); await service.stop(); await delay(100); assert.equal(launches, 2);
  await assert.rejects(service.configureHost({ mcpPort: 4318 }), /控制端口/);
  await assert.rejects(service.configure({ publicUrl: 'https://device.example.com/api/../state' }), /path/);
  await assert.rejects(service.configure({ publicUrl: 'https://127.0.0.1/' }), /公网 HTTPS/);
});

test('a fixed device bridge keeps the public endpoint across Quick process replacements', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const fixed = 'https://198.51.100.20:8443/capyra/devices/device-fixture/bridge';
  const publics: (string | undefined)[] = [], tunnels: (string | undefined)[] = [], publications: string[] = [];
  let launches = 0, removals = 0;
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, fetch: async () => json({}, 503),
    onPublicUrl: url => { publics.push(url); }, onTunnelUrl: url => { tunnels.push(url); },
    bridge: { publicUrl: () => fixed, async publish(upstream) { publications.push(upstream); return { publicUrl: fixed, upstream, updatedAt: new Date().toISOString(), expiresAt: Date.now() + 300_000 }; }, async remove() { removals++; } },
    spawn(_file, _args, options) { launches++; return spawn(process.execPath, ['-e', `process.stderr.write('https://replacement-${launches}.trycloudflare.com\\nRegistered tunnel connection\\n');setInterval(()=>{},1000)`], options); },
  });
  t.after(() => service.close());
  await service.start(); await until(() => publications.length === 1);
  assert.equal(service.status().chatgpt.mcpUrl, `${fixed}/mcp`);
  await service.restart(); await until(() => publications.length === 2);
  assert.deepEqual(publications, ['https://replacement-1.trycloudflare.com', 'https://replacement-2.trycloudflare.com']);
  assert.ok(publics.every(url => url === fixed)); assert.equal(service.status().configuration.publicUrl, fixed);
  assert.equal(service.status().tunnel.url, publications[1]); assert.ok(tunnels.includes(undefined));
  await service.stop(); assert.equal(removals, 1);
});

test('bridge registration retries recover without replacing the Quick process or retaining its stale error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const fixed = 'https://203.0.113.10/capyra/devices/device-fixture/bridge'; let attempts = 0, launches = 0;
  // 只加速登记重试调度；独立时钟避免并行测试的调度延迟被误当作休眠恢复。
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, monitorIntervalMs: 20, now: () => 0, fetch: async () => json({}, 503),
    bridge: { publicUrl: () => fixed, async publish(upstream) { attempts++; if (attempts === 1) throw new Error('fixture temporary bridge registration failure'); return { publicUrl: fixed, upstream, updatedAt: new Date().toISOString(), expiresAt: Date.now() + 240_000 }; }, async remove() {} },
    spawn(_file, _args, options) { launches++; return spawn(process.execPath, ['-e', "process.stderr.write('https://bridge-retry.trycloudflare.com\\nRegistered tunnel connection\\n');setInterval(()=>{},1000)"], options); },
  });
  t.after(() => service.close());
  await service.start(); await until(() => service.status().recentEvents.some(event => event.message === '固定入口登记已恢复'));
  assert.equal(launches, 1); assert.equal(attempts, 2); assert.equal(service.status().configuration.publicUrl, fixed);
  assert.doesNotMatch(service.status().lastError ?? '', /fixture temporary bridge/);
  assert.ok(service.status().recentEvents.some(event => event.message.includes('fixture temporary bridge')));
  assert.ok(service.status().recentEvents.every(event => !event.message.includes('休眠')));
});

test('MCP preserves fixed path OAuth realms and accepts only its current Quick ingress host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const fixed = 'https://203.0.113.10/capyra/devices/device-fixture/bridge';
  const config: McpRuntime['config'] = { stateDir: directory, workspace: directory, publicUrl: fixed, port: 0, controlPort: 4318, exposure: 'compact', maxConcurrent: 1, maxTasks: 20, plugins: [] };
  const runtime: McpRuntime = { config, listTools: () => [], listTasks: () => [], instructions: () => '', onEvent: () => () => {}, getTask: () => undefined, async submit() { throw new Error('unused'); }, async cancelTask() {} };
  let server = await startMcpHttp(runtime, config); t.after(() => server.close());
  let ingress = 'current-quick.trycloudflare.com';
  server.setTunnelUrl(`https://${ingress}`);
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    // 使用 HTTP API 保留被测 Host；Fetch 实现可能改写该受限请求头。
    const req = httpRequest(server.localUrl + path, { method: init.method, headers: { Host: ingress, ...init.headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? ''])) })));
    });
    req.on('error', reject); req.end(init.body === undefined ? undefined : String(init.body));
  });
  let metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  let resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(server.url, `${fixed}/mcp`); assert.equal(metadata.issuer, `${fixed}/`);
  for (const endpoint of ['authorize', 'token', 'register', 'revoke']) assert.ok(Object.values(metadata).includes(`${fixed}/${endpoint}`), endpoint);
  assert.equal(resource.resource, `${fixed}/mcp`); assert.deepEqual(resource.authorization_servers, [`${fixed}/`]);
  assert.equal(publicMetadataUrls(fixed).authorization, 'https://203.0.113.10/.well-known/oauth-authorization-server/capyra/devices/device-fixture/bridge');
  assert.equal(publicMetadataUrls(fixed).resource, 'https://203.0.113.10/.well-known/oauth-protected-resource/capyra/devices/device-fixture/bridge/mcp');
  const client = await (await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Fixed bridge fixture', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
  const authorize = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, resource: `${fixed}/mcp` });
  const page = await (await request(`/authorize?${authorize}`)).text();
  assert.match(page, /fetch\('\.\/oauth\/pending\//); assert.match(page, /credentials:'omit'/);
  const pending = server.oauth.pending()[0]; assert.ok(pending);
  assert.equal((await request(`/oauth/pending/${pending.id}`, { headers: { Origin: 'null' } })).status, 200);
  assert.equal((await request('/health', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await request(`/oauth/pending/${pending.id}`, { headers: { Origin: 'null', Cookie: 'any=value' } })).status, 403);
  server.oauth.decide(pending.id, true); assert.equal(server.oauth.grants().length, 1);
  await server.setPublicUrl(fixed); assert.equal(server.oauth.grants().length, 1);
  ingress = 'replacement-quick.trycloudflare.com'; server.setTunnelUrl(`https://${ingress}`);
  assert.equal((await request('/health', { headers: { Host: 'current-quick.trycloudflare.com' } })).status, 403);
  assert.equal((await request('/health')).status, 200); assert.equal(server.oauth.grants().length, 1);
  await server.close(); server = await startMcpHttp(runtime, config); server.setTunnelUrl(`https://${ingress}`);
  assert.equal(server.oauth.grants().length, 1);
  await server.setPublicUrl('https://203.0.113.10/capyra/devices/another-device/bridge');
  assert.equal(server.oauth.grants().length, 0);
  metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.match(metadata.issuer, /another-device\/bridge\/$/); assert.match(resource.resource, /another-device\/bridge\/mcp$/);
});

test('real HTTP diagnostic validates health, discovery, initialization, and releases the diagnostic session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let deleted = 0; let authorized = false; let mismatch = false;
  const http = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown) => res.end(JSON.stringify(body));
    if (req.url === '/health') return send({ ok: true, service: 'capyra' });
    if (req.url === '/.well-known/oauth-authorization-server') return send({ issuer: mismatch ? 'https://wrong.example.com' : origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    if (req.url === '/.well-known/oauth-protected-resource/mcp') return send({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (req.method === 'DELETE') { deleted++; return send({}); }
    if (req.url === '/mcp') {
      if (!authorized || req.headers.authorization !== 'Bearer diagnostic-access') { res.statusCode = 401; return send({ error: 'unauthorized' }); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.method, 'initialize'); assert.equal(request.params.clientInfo.name, 'Capyra Connection Check');
      res.setHeader('mcp-session-id', 'diagnostic-session'); return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Capyra', version: '0.1.0' } } });
    }
    res.statusCode = 404; send({});
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  const port = (http.address() as { port: number }).port;
  const fetcher: ConnectionFetch = (input, init) => fetch(String(input).replace(origin, `http://127.0.0.1:${port}`), init);
  const service = await createConnectionService({ stateDir: directory, mcpPort: port, controlPort: port === 4318 ? 4319 : 4318, installer, fetch: fetcher, getProbeToken: () => authorized ? 'diagnostic-access' : undefined });
  t.after(() => service.close().catch(() => {}));
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken });
  let status = await service.diagnose(); assert.equal(status.local.state, 'ok'); assert.equal(status.public.state, 'ok'); assert.equal(status.oauthDiscovery.state, 'ok'); assert.equal(status.mcp.state, 'authorization_required');
  assert.equal(status.authorization.state, 'unknown'); assert.equal(status.toolCall.count, 0);
  authorized = true; status = await service.diagnose(); assert.equal(status.mcp.state, 'ok'); assert.equal(deleted, 1); assert.equal(status.toolCall.count, 0);
  mismatch = true; status = await service.diagnose(); assert.equal(status.oauthDiscovery.state, 'error'); assert.equal(status.chatgptVerification, 'not_verified');
});

test('diagnostics accept actual SDK root issuer URLs and reject different issuer or resource locations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const oauth = createOAuth(new URL(origin)); t.after(() => oauth.close());
  const app = express();
  app.use(oauth.router);
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'capyra' }));
  app.post('/mcp', oauth.requireAuth, (_req, res) => res.sendStatus(400));
  const http = createServer(app);
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  const port = (http.address() as { port: number }).port;
  const local = `http://127.0.0.1:${port}`;
  // 直接使用 Capyra 的 SDK OAuth router，以捕获 URL.toString() 的真实尾斜线形状。
  const actualMetadata = await (await fetch(`${local}/.well-known/oauth-authorization-server`)).json();
  const actualResource = await (await fetch(`${local}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(actualMetadata.issuer, `${origin}/`);
  assert.deepEqual(actualResource.authorization_servers, [`${origin}/`]);
  assert.equal(actualResource.resource, `${origin}/mcp`);
  let mutation: { path: string; field: string; value: unknown } | undefined;
  const service = await createConnectionService({ stateDir: directory, mcpPort: port, controlPort: port === 4318 ? 4319 : 4318, installer, fetch: async (input, init) => {
    const url = String(input), response = await fetch(url.replace(origin, local), init);
    if (!mutation || !url.endsWith(mutation.path)) return response;
    const data = await response.json(); data[mutation.field] = mutation.value;
    return json(data, response.status);
  } });
  t.after(() => service.close());
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken });
  assert.equal((await service.diagnose()).oauthDiscovery.state, 'ok');
  const metadataPath = '/.well-known/oauth-authorization-server', resourcePath = '/.well-known/oauth-protected-resource/mcp';
  for (const invalid of [
    { path: metadataPath, field: 'issuer', value: 'https://other.example.com/' },
    { path: metadataPath, field: 'issuer', value: `${origin}/tenant/` },
    { path: metadataPath, field: 'issuer', value: `${origin}/?tenant=other` },
    { path: resourcePath, field: 'resource', value: 'https://other.example.com/mcp' },
    { path: resourcePath, field: 'resource', value: `${origin}/mcp/` },
    { path: resourcePath, field: 'authorization_servers', value: ['https://other.example.com/'] },
    { path: resourcePath, field: 'authorization_servers', value: [`${origin}/tenant/`] },
  ]) {
    mutation = invalid;
    assert.equal((await service.diagnose()).oauthDiscovery.state, 'error', JSON.stringify(invalid));
  }
  mutation = undefined;
  const recovered = await service.diagnose(); assert.equal(recovered.oauthDiscovery.state, 'ok'); assert.equal(recovered.lastError, undefined);
});

test('Cloudflare provider limits ingress, isolates management token, rotates and cuts off old connections', async () => {
  const calls: { url: string; method: string; body?: any; authorization: string }[] = [];
  const provider = new CloudflareApiProvider({ accountId: 'account-12345', zoneId: 'zone-12345', baseDomain: 'connect.example.com', apiToken: 'cloud-management-secret', fetch: async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET'; calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: (init?.headers as Record<string, string>).Authorization });
    return json({ success: true, result: url.endsWith('/token') ? deviceToken : url.endsWith('/dns_records') ? { id: 'dns-record-123' } : url.endsWith('/cfd_tunnel') ? { id: 'tunnel-id-123' } : {} });
  } });
  const connection = await provider.provision({ deviceId: 'device-id', mcpPort: 4317 });
  assert.equal(connection.token, deviceToken); assert.ok(!JSON.stringify(connection).includes('cloud-management-secret'));
  assert.ok(!JSON.stringify(provider).includes('cloud-management-secret'));
  assert.ok(calls.every(call => call.authorization === 'Bearer cloud-management-secret'));
  const ingress = calls.find(call => call.url.endsWith('/configurations'))!.body.config.ingress;
  assert.equal(ingress[0].service, 'http://127.0.0.1:4317'); assert.equal(ingress[1].service, 'http_status:404');
  const routes = new RegExp(PUBLIC_ROUTE_PATTERN);
  for (const route of ['/mcp', '/health', '/authorize', '/token', '/register', '/revoke', '/oauth/pending/1234-abc', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) assert.ok(routes.test(route), route);
  for (const route of ['/api/state', '/api/oauth/x/decide', '/api/identity', '/api/connection', '/', '/mcp/../api/state', '/.well-known/anything']) assert.ok(!routes.test(route), route);
  await provider.rotate({ tunnelId: connection.tunnelId });
  const patch = calls.findIndex(call => call.method === 'PATCH'); assert.equal(Buffer.from(calls[patch].body.tunnel_secret, 'base64').length, 32);
  assert.ok(calls[patch + 1].url.endsWith('/connections')); assert.equal(calls[patch + 1].method, 'DELETE');
  await provider.revoke(connection);
  const last = calls.slice(-4); assert.equal(last[0].body.config.ingress[0].service, 'http_status:404'); assert.equal(last[1].method, 'DELETE'); assert.equal(last[3].url.split('/').at(-1), connection.dnsRecordId);
  await assert.rejects(provider.provision({ deviceId: 'other', mcpPort: 4318 }), /控制端口/);
});

test('Cloudflare revocation is idempotent after a partially completed deletion', async () => {
  const calls: string[] = [];
  const provider = new CloudflareApiProvider({ accountId: 'account-12345', zoneId: 'zone-12345', baseDomain: 'connect.example.com', apiToken: 'cloud-management-secret', fetch: async input => {
    const url = String(input); calls.push(url);
    return url.includes('/dns_records/') ? json({ success: true, result: {} }) : json({ success: false, errors: [] }, 404);
  } });
  await provider.revoke({ tunnelId: 'deleted-tunnel', dnsRecordId: 'dns-record-123' });
  assert.ok(calls.at(-1)?.endsWith('/dns-record-123'));
});

test('quick mode produces a fresh URL, uses IPv4 HTTP2 and rechecks/restarts after a sleep gap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-quick-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 1000; let launches = 0; const urls: (string | undefined)[] = [];
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, monitorIntervalMs: 20, now: () => time, onPublicUrl: url => { urls.push(url); }, fetch: async () => json({}, 503), spawn(_file, args, options) {
    launches++; assert.equal(args[args.indexOf('--protocol') + 1], 'http2'); assert.equal(args[args.indexOf('--edge-ip-version') + 1], '4');
    assert.ok(args.includes('http://127.0.0.1:4317')); assert.ok(!args.includes('--token-file'));
    return spawn(process.execPath, ['-e', `process.stderr.write('https://fixture-${launches}.trycloudflare.com\\nRegistered tunnel connection\\n');setInterval(()=>{},1000)`], options);
  } });
  t.after(() => service.close().catch(() => {}));
  await service.start(); await until(() => Boolean(service.status().configuration.publicUrl));
  assert.equal(service.status().configuration.publicUrl, 'https://fixture-1.trycloudflare.com');
  time += 1000;
  await until(() => launches === 2); await until(() => service.status().configuration.publicUrl === 'https://fixture-2.trycloudflare.com');
  assert.ok(service.status().recentEvents.some(event => event.message.includes('休眠'))); assert.equal(service.status().chatgptVerification, 'not_verified');
  await service.stop(); assert.ok(urls.includes(undefined));
});

test('network diagnostics distinguish DNS failure from blocked TCP and disclose only proxy variable names', async () => {
  const environment = networkEnvironment({ HTTPS_PROXY: 'http://username:secret@proxy.example.com', ALL_PROXY: 'socks5://private' }, { utun7: [{ address: '10.0.0.1' } as any], en0: [{ address: '192.168.0.1' } as any] });
  assert.deepEqual(environment.proxyVariables, ['HTTPS_PROXY', 'ALL_PROXY']); assert.deepEqual(environment.vpnInterfaces, ['utun7']);
  assert.doesNotMatch(JSON.stringify(environment), /username|secret|private|192\.168|10\.0\.0/);
  let connections = 0;
  const dnsFailure = await probeConnectionNetwork({ lookup: async () => { throw new Error('DNS'); }, connect: async () => { connections++; }, environment: {}, interfaces: {} });
  assert.equal(dnsFailure.dns.state, 'error'); assert.equal(dnsFailure.tcp.state, 'unknown'); assert.equal(connections, 0);
  const tcpFailure = await probeConnectionNetwork({ lookup: async () => ['192.0.2.1'], connect: async (_address, port) => { assert.equal(port, 7844); throw new Error('blocked'); }, environment: {}, interfaces: {} });
  assert.equal(tcpFailure.dns.state, 'ok'); assert.equal(tcpFailure.tcp.state, 'error');
  const available = await probeConnectionNetwork({ lookup: async () => ['192.0.2.1'], connect: async () => {}, environment: {}, interfaces: {} });
  assert.equal(available.tcp.state, 'ok');
  const intercepted = await probeConnectionNetwork({ lookup: async () => ['198.18.13.130'], connect: async () => {}, environment: {}, interfaces: {} });
  assert.equal(intercepted.fakeIpDetected, true); assert.equal(intercepted.tcp.state, 'ok');
  assert.match(intercepted.tcp.detail!, /代理路径/); assert.match(intercepted.dns.detail!, /Fake-IP/);
});

test('cloudflared readiness stays independent of public HTTPS failure and exposes useful transport errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let ready = 1; let time = 1000; let launches = 0;
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, monitorIntervalMs: 20, now: () => time, fetch: async input => {
    if (String(input).endsWith(':20242/ready')) return json({ status: ready ? 200 : 503, readyConnections: ready }, ready ? 200 : 503);
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('TLS reset'), { code: 'ECONNRESET' }) });
  }, spawn(_file, _args, options) { launches++; return spawn(process.execPath, ['-e', "process.stderr.write('Starting metrics server on 127.0.0.1:20242/metrics\\nRegistered tunnel connection\\n');setInterval(()=>{},1000)"], options); } });
  t.after(() => service.close());
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken });
  await service.start(); await until(() => service.status().tunnel.readiness?.state === 'ok');
  let status = await service.diagnose();
  assert.equal(status.tunnel.state, 'established'); assert.equal(status.tunnel.connections, 1); assert.equal(status.public.state, 'error'); assert.match(status.public.detail!, /ECONNRESET/);
  time += 1000; await until(() => service.status().recentEvents.some(event => event.message.includes('保留当前入口'))); assert.equal(launches, 1);
  ready = 0; status = await service.diagnose(); assert.equal(status.tunnel.state, 'reconnecting'); assert.equal(status.tunnel.connections, 0);
  ready = 1; status = await service.diagnose(); assert.equal(status.tunnel.state, 'established');
});

test('recovered probes clear their current error, retain history and preserve a separate connector failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capyra-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let recovered = false; let ready = true; let child: ReturnType<typeof spawn>;
  const service = await createConnectionService({ stateDir: directory, mcpPort: 4317, controlPort: 4318, installer, fetch: async input => {
    const url = String(input);
    if (url.endsWith(':20242/ready')) return json({ readyConnections: ready ? 1 : 0 }, ready ? 200 : 503);
    if (!recovered) throw new TypeError('fetch failed', { cause: Object.assign(new Error('TLS reset'), { code: 'ECONNRESET' }) });
    if (url.endsWith('/health')) return json({ ok: true, service: 'capyra' });
    if (url.endsWith('/oauth-authorization-server')) return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    if (url.endsWith('/oauth-protected-resource/mcp')) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    return json({ error: 'authorization required' }, 401);
  }, spawn(_file, _args, options) {
    child = spawn(process.execPath, ['-e', "process.stderr.write('Starting metrics server on 127.0.0.1:20242/metrics\\nRegistered tunnel connection\\n');setInterval(()=>{},1000)"], options);
    return child;
  } });
  t.after(() => service.close());
  await service.configure({ mode: 'managed', tunnelId: 'fixture-tunnel-123', publicUrl: origin, token: deviceToken });
  await service.start(); await until(() => service.status().tunnel.readiness?.state === 'ok');
  assert.match(service.status().lastError!, /ECONNRESET/);
  const failureCount = service.status().recentEvents.filter(event => event.message.includes('ECONNRESET')).length;
  await service.diagnose(); assert.equal(service.status().recentEvents.filter(event => event.message.includes('ECONNRESET')).length, failureCount);
  recovered = true;
  let status = await service.diagnose();
  assert.equal(status.lastError, undefined); assert.equal(status.public.state, 'ok'); assert.equal(status.mcp.state, 'authorization_required');
  assert.ok(status.recentEvents.some(event => event.message.includes('ECONNRESET'))); assert.ok(status.recentEvents.some(event => event.message === '连接检测已恢复'));
  // 注入该受管进程的独立故障，再让普通 HTTP 探测通过；两类错误不能相互覆盖。
  ready = false; child!.stderr!.emit('data', Buffer.from('ERR connection fixture-connector-failure\n'));
  status = await service.diagnose();
  assert.equal(status.tunnel.state, 'reconnecting'); assert.match(status.lastError!, /fixture-connector-failure/);
  assert.equal(status.public.state, 'ok');
});

test('Cloudflare configuration failures roll back device resources and API errors never include request secrets', async () => {
  const calls: string[] = [];
  const provider = new CloudflareApiProvider({ accountId: 'account-12345', zoneId: 'zone-12345', baseDomain: 'connect.example.com', apiToken: 'cloud-management-secret', fetch: async (input, init) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/cfd_tunnel')) return json({ success: true, result: { id: 'tunnel-id-123', token: deviceToken } });
    if (url.endsWith('/dns_records')) return json({ success: false, errors: [{ code: 1000, message: 'cloud-management-secret' }] }, 403);
    return json({ success: true, result: {} });
  } });
  await assert.rejects(provider.provision({ deviceId: 'device-id', mcpPort: 4317 }), error => { assert.match(String(error), /403/); assert.doesNotMatch(String(error), /cloud-management-secret/); return true; });
  assert.ok(calls.some(call => call.startsWith('DELETE ') && call.endsWith('/connections')));
  assert.ok(calls.at(-1)?.endsWith('/tunnel-id-123'));
});
