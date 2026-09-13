import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Runtime } from '../src/core/runtime.js';
import type { CapyraPlugin, RuntimeConfig } from '../src/core/types.js';
import { startControl } from '../src/transport/control.js';
import { startMcpHttp } from '../src/transport/mcp.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-local-authorize-'));
  let scopeAllowed = false, reads = 0;
  const definitions: CapyraPlugin[] = [
    { apiVersion: 1, id: 'identity', version: '1', title: 'Identity fixture', description: '', permissions: [], setup(ctx) { ctx.provide('identity', { status: () => ({ active: true }), async authorize() { if (!scopeAllowed) throw new Error('Device scope excludes this workspace.'); } }); } },
    { apiVersion: 1, id: 'fixture', version: '1', title: 'Read fixture', description: '', permissions: [], setup(ctx) { ctx.registerTool({ name: 'read', title: 'Read private data', description: '', effect: 'read', permissions: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute() { reads++; return { content: [{ type: 'text', text: 'private-result' }] }; } }); } },
  ];
  const config: RuntimeConfig = { workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, publicUrl: 'https://quick.example/', exposure: 'compact', plugins: definitions.map(plugin => ({ id: plugin.id, enabled: true, grants: [] })), maxTasks: 20, maxConcurrent: 2 };
  const runtime = new Runtime(config, async entry => definitions.find(plugin => plugin.id === entry.id)!); await runtime.start();
  const mcp = await startMcpHttp(runtime, config, { approvalTimeoutMs: 1000 });
  let localMcpUrl: string | undefined = new URL('/mcp', mcp.localUrl).href;
  const control = await startControl(runtime, config, { pending: () => mcp.oauth.pending(), decide: (id, approve) => mcp.oauth.decide(id, approve), grants: () => mcp.oauth.grants(), revoke: () => mcp.oauth.revoke() },
    { get publicUrl() { return config.publicUrl; }, get mcpUrl() { return mcp.url; }, get localMcpUrl() { return localMcpUrl; }, access: mcp.access });
  t.after(async () => { await control.close(); await mcp.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  const headers = { 'X-Capyra-Local': '1', Origin: control.url, 'Content-Type': 'application/json' };
  const bootstrap = await fetch(control.url + '/api/bootstrap', { method: 'POST', headers, body: JSON.stringify({ nonce: new URL(control.openUrl).hash.slice('#bootstrap='.length) }) });
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0], authenticated = { ...headers, Cookie: cookie };
  const post = (route: string, body: unknown, overrides: Record<string, string> = {}) => fetch(control.url + route, { method: 'POST', headers: { ...authenticated, ...overrides }, body: JSON.stringify(body) });
  return { workspace, config, runtime, mcp, control, headers, authenticated, post, reads: () => reads, allowScope: () => { scopeAllowed = true; }, denyScope: () => { scopeAllowed = false; }, disableLocalEndpoint: () => { localMcpUrl = undefined; } };
}

test('local authorization preparation accepts only the current public authorize route and preserves the query verbatim', async t => {
  const f = await fixture(t), resource = f.mcp.url;
  const query = `?client_id=client%2B1&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcallback&state=a%2Bb%20c%252F%23&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&scope=mcp&extra=%2f%2F&repeat=a&repeat=b`;
  const source = `https://quick.example/authorize${query}`;
  const unauthorized = await fetch(f.control.url + '/api/oauth/local-authorize', { method: 'POST', headers: f.headers, body: JSON.stringify({ url: source }) }); assert.equal(unauthorized.status, 401);
  assert.equal((await f.post('/api/oauth/local-authorize', { url: source }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.post('/api/oauth/local-authorize', { url: source }, { Origin: '' })).status, 403);
  assert.equal((await f.post('/api/oauth/local-authorize', { url: source }, { 'X-Capyra-Local': '' })).status, 403);
  const prepared = await f.post('/api/oauth/local-authorize', { url: source }); assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { localAuthorizeUrl: `${f.mcp.localUrl}/authorize${query}` });
  assert.equal(f.mcp.oauth.pending().length, 0); assert.equal(f.mcp.oauth.grants().length, 0); assert.equal(f.reads(), 0);
  const state = await (await fetch(f.control.url + '/api/state', { headers: f.authenticated })).json(); assert.equal(state.connection.localAuthorizationAvailable, true);
  const invalid = [
    source.replace('quick.example', 'attacker.example'), source.replace('quick.example', 'quick.example.attacker.example'), source.replace('https:', 'http:'),
    source.replace('quick.example', 'user@quick.example'), source.replace('quick.example', '@quick.example'), source + '#fragment', source + '#',
    source.replace('/authorize?', '/token?'), source.replace('/authorize?', '/other/../authorize?'), source.replace('/authorize?', '/%61uthorize?'),
    source.replace('https://quick.example', ''), source.replace('https://quick.example', 'https:\\quick.example'),
    'https://quick.example/authorize?resource=' + encodeURIComponent(new URL('/mcp', f.mcp.localUrl).href),
    'https://quick.example/authorize?resource=https%3A%2F%2Fattacker.example%2Fmcp', 'x'.repeat(16_385), null,
  ];
  for (const url of invalid) assert.equal((await f.post('/api/oauth/local-authorize', { url })).status, 400);
  assert.equal((await f.post('/api/oauth/local-authorize', { url: source, localMcpUrl: 'http://127.0.0.1:1/mcp' })).status, 400);
  await f.mcp.setPublicUrl('https://rotated.example'); f.config.publicUrl = 'https://rotated.example/';
  assert.equal((await f.post('/api/oauth/local-authorize', { url: source })).status, 400);
  const updated = source.replaceAll('quick.example', 'rotated.example');
  const rotated = await f.post('/api/oauth/local-authorize', { url: updated }); assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).localAuthorizeUrl, `${f.mcp.localUrl}/authorize${query.replaceAll('quick.example', 'rotated.example')}`);
  f.disableLocalEndpoint();
  assert.equal((await f.post('/api/oauth/local-authorize', { url: updated })).status, 409);
  assert.equal((await (await fetch(f.control.url + '/api/state', { headers: f.authenticated })).json()).connection.localAuthorizationAvailable, false);
});

test('loopback authorization retains the public issuer, PKCE, exact local approval and device scope', async t => {
  const f = await fixture(t), base = f.mcp.localUrl, redirectUri = 'https://chatgpt.com/connector/callback', state = 'state + /?#';
  const json = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  const form = (body: Record<string, string>) => fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });
  const registered = await json('/register', { client_name: 'ChatGPT fixture', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registered.status, 201); const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const source = new URL('/authorize', f.mcp.url); source.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state, resource: f.mcp.url, scope: 'mcp' }).toString();
  const prepared = await f.post('/api/oauth/local-authorize', { url: source.href }); assert.equal(prepared.status, 200);
  const local = (await prepared.json()).localAuthorizeUrl;
  assert.equal(new URL(local).search, source.search); assert.equal(new URL(local).searchParams.get('resource'), f.mcp.url);
  assert.equal(f.mcp.oauth.pending().length, 0);
  const page = await fetch(local, { redirect: 'manual' }); assert.equal(page.status, 200);
  const pending = f.mcp.oauth.pending()[0]; assert.equal(pending.redirectUri, redirectUri); assert.match(await page.text(), new RegExp(pending.verificationCode));
  assert.equal(f.mcp.oauth.grants().length, 0);
  const exchange = (code: string, overrides: Record<string, string> = {}) => form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: f.mcp.url, ...overrides });
  assert.equal((await exchange('not-approved')).status, 400);
  const approved = await f.post(`/api/oauth/${pending.id}/decide`, { approve: true }); assert.equal(approved.status, 200);
  const callback = new URL((await (await fetch(base + '/oauth/pending/' + pending.id)).json()).redirect);
  assert.equal(callback.origin + callback.pathname, redirectUri); assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code')!;
  assert.equal((await exchange(code, { code_verifier: 'x'.repeat(43) })).status, 400);
  assert.equal((await exchange(code, { resource: new URL('/mcp', base).href })).status, 400);
  const issued = await exchange(code); assert.equal(issued.status, 200); const tokens = await issued.json();
  assert.equal((await exchange(code)).status, 400);
  const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server')).json(); assert.equal(metadata.issuer, 'https://quick.example/');
  const initialized = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ChatGPT fixture', version: '1' } } }, { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' });
  assert.equal(initialized.status, 200); const session = initialized.headers.get('mcp-session-id')!; await initialized.json();
  let id = 1;
  const read = () => json('/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'capyra_call', arguments: { tool: 'fixture__read', args: {} } } }, { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session });
  const outsideScope = await (await read()).json(); assert.equal(outsideScope.result.isError, true); assert.equal(f.reads(), 0); assert.equal(f.runtime.listTasks().length, 0);
  f.allowScope(); const requestedRead = read();
  for (let attempt = 0; attempt < 100 && !f.runtime.listTasks().some(task => task.status === 'awaiting_approval'); attempt++) await pause(5);
  const task = f.runtime.listTasks().find(task => task.status === 'awaiting_approval')!; assert.ok(task); assert.equal(f.reads(), 0);
  assert.equal((await f.post(`/api/tasks/${task.id}/approve`, { approve: true, resultVisibility: 'client' })).status, 200);
  const result = await (await requestedRead).json(); assert.match(JSON.stringify(result), /private-result/); assert.equal(f.reads(), 1);
  f.denyScope(); assert.equal((await (await read()).json()).result.isError, true); assert.equal(f.reads(), 1);
});

test('fixed device authorization fallback preserves the resource and rejects another device or normalized path', async t => {
  const f = await fixture(t);
  f.config.publicUrl = 'https://203.0.113.10/capyra/devices/device-a/bridge';
  await f.mcp.setPublicUrl(f.config.publicUrl);
  const query = `?state=a%2Bb&resource=${encodeURIComponent(f.mcp.url)}&code_challenge=${'a'.repeat(43)}`;
  const source = `${f.config.publicUrl}/authorize${query}`;
  const response = await f.post('/api/oauth/local-authorize', { url: source });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).localAuthorizeUrl, `${f.mcp.localUrl}/authorize${query}`);
  for (const url of [source.replace('device-a', 'device-b'), source.replace('/bridge/authorize', '/bridge/other/../authorize'), source.replace('/bridge/authorize', '/bridge/%61uthorize'), source.replace(encodeURIComponent(f.mcp.url), encodeURIComponent('https://203.0.113.10/mcp'))]) {
    assert.equal((await f.post('/api/oauth/local-authorize', { url })).status, 400);
  }
});
