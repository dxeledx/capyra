import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcpHttp, type McpRuntime, type McpTemplateDiagnostic, type McpRequestDiagnostic } from '../src/transport/mcp.js';
import { createMcpExtensions } from '../src/client-ui/extensions.js';
import { createOAuth, validRedirectUri } from '../src/transport/oauth.js';
import type { RuntimeConfig, TaskRecord } from '../src/core/types.js';

test('redirect URI rules reject remote HTTP, credentials, fragments, and non-HTTP schemes', () => {
  for (const value of ['https://chatgpt.com/connector/callback', 'http://127.0.0.1:1234/callback', 'http://localhost/callback', 'http://[::1]:1234/callback']) assert.equal(validRedirectUri(value), true, value);
  for (const value of ['http://evil.example/callback', 'https://user:pass@example.com/callback', 'https://example.com/#token', 'javascript:alert(1)', 'file:///tmp/token', 'http://127.0.0.1.evil.example/callback']) assert.equal(validRedirectUri(value), false, value);
});

test('template diagnostics observe pre-handler HTTP rejection and successful authenticated resource delivery without private data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-template-http-'));
  let close = async () => {};
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const config: RuntimeConfig = { workspace: dir, stateDir: dir, port: 0, controlPort: 0, exposure: 'compact', plugins: [], maxConcurrent: 1, maxTasks: 10 };
  const registry = createMcpExtensions(), uri = 'ui://PRIVATE_TEMPLATE_URI'; let handles = 0;
  registry.register('shell', { capabilities: { resources: {} }, owns: (method, params) => method === 'resources/read' && params.uri === uri, async handle() { handles++; throw Error('PRIVATE_HANDLER_ERROR'); } }, { publicUiTemplates: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>PRIVATE_BODY</p>', _meta: { privateMarker: 'PRIVATE_META' } }] });
  const runtime: McpRuntime = { config, listTools: () => [], instructions: () => '', async submit() { throw Error('unused'); }, getTask: () => undefined, listTasks: () => [], async cancelTask() {}, onEvent: () => () => {}, hasService: name => name === 'mcp.extensions', service: <T>() => registry as T };
  const events: McpTemplateDiagnostic[] = [], requests: McpRequestDiagnostic[] = [];
  const bridge = await startMcpHttp(runtime, config, { onTemplateDiagnostic: event => events.push(event), onRequestDiagnostic: event => requests.push(event) });
  close = () => bridge.close();
  const origin = new URL(bridge.localUrl).origin;
  const post = (endpoint: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const body = { jsonrpc: '2.0', id: 'PRIVATE_RPC_ID', method: 'resources/read', params: { uri, _meta: { token: 'PRIVATE_REQUEST_META' } } };
  assert.equal((await post('/mcp', body, { Authorization: 'Bearer PRIVATE_INVALID_TOKEN' })).status, 401);
  assert.deepEqual(events.map(event => event.stage), ['received', 'auth', 'closed']);
  assert.equal(events[1].reason, 'unauthorized'); assert.equal(events[1].httpStatus, 401);
  const requestId = events[0].requestId; events.length = 0;
  assert.equal((await post('/mcp', body, { Origin: 'https://private-origin.invalid' })).status, 403);
  assert.equal(events[1].reason, 'forbidden'); assert.notEqual(events[0].requestId, requestId); events.length = 0;
  await post('/mcp', { ...body, params: { uri: 'file:///PRIVATE_DYNAMIC_URI' } }); assert.deepEqual(events, []);
  const redirectUri = 'https://chatgpt.com/connector/callback';
  const registration = await (await post('/register', { client_name: 'PRIVATE_CLIENT_NAME', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })).json();
  const verifier = randomBytes(32).toString('base64url');
  const authorization = new URL('/authorize', origin);
  authorization.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'mcp', resource: bridge.url }).toString();
  assert.equal((await fetch(authorization)).status, 200);
  const pending = bridge.oauth.pending()[0]; bridge.oauth.decide(pending.id, true);
  const redirect = new URL((await (await fetch(origin + '/oauth/pending/' + pending.id)).json()).redirect);
  const token = await (await fetch(origin + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, code: redirect.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource: bridge.url }) })).json();
  assert.equal(typeof token.access_token, 'string'); assert.deepEqual(events, []);
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'resources/read', 'Mcp-Name': uri };
  const modern = { ...body, params: { uri, _meta: meta } };
  const mismatch = await post('/mcp', modern, { ...headers, 'Mcp-Name': 'PRIVATE_WRONG_HEADER' });
  assert.equal(mismatch.status, 400); assert.ok(events.some(event => event.reason === 'header_mismatch')); events.length = 0;
  const response = await post('/mcp', modern, headers); assert.equal(response.status, 200);
  assert.equal((await response.json()).result.contents[0].text, '<p>PRIVATE_BODY</p>');
  assert.deepEqual(events.map(event => event.stage), ['received', 'auth', 'protocol', 'auth', 'returned', 'closed']);
  assert.equal(events.at(-1)?.httpStatus, 200); assert.equal(handles, 0); assert.equal(bridge.access.pending().length, 0);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|ui:\/\/|token|owner|workspace|header[s"]|text|stack/i);
  assert.equal(JSON.stringify(events).includes(token.access_token), false);
  events.length = 0;
  const legacy = await post('/mcp', body, { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).result.contents[0].uri, uri);
  assert.equal(events.filter(event => event.stage === 'received').length, 1); assert.equal(events.filter(event => event.stage === 'closed').length, 1);
  assert.equal(new Set(events.map(event => event.requestId)).size, 1);
  requests.length = 0;
  const earlyCall = { jsonrpc: '2.0', id: 'PRIVATE_RPC_ID', method: 'tools/call', params: { name: 'PRIVATE_TOOL_NAME', arguments: { token: 'PRIVATE_ARGUMENT' } } };
  const initializeRequired = await post('/mcp', earlyCall, { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream' });
  assert.equal(initializeRequired.status, 400);
  assert.ok(requests.some(event => event.reason === 'initialize_required' && event.httpStatus === 400));
  assert.deepEqual([...new Set(requests.map(event => event.operation))], ['tools_call']);
  assert.equal(new Set(requests.map(event => event.requestId)).size, 1);
  requests.length = 0;
  const invalidJson = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{PRIVATE_BROKEN_JSON' });
  assert.equal(invalidJson.status, 400); assert.ok(requests.some(event => event.reason === 'invalid_json'));
  assert.deepEqual([...new Set(requests.map(event => event.operation))], ['other']);
  for (const [method, operation] of [['initialize', 'initialize'], ['tools/list', 'tools_list'], ['tools/call', 'tools_call'], ['resources/read', 'resources_read'], ['constructor', 'other']]) {
    requests.length = 0;
    assert.equal((await post('/mcp', { ...earlyCall, method })).status, 401);
    assert.deepEqual([...new Set(requests.map(event => event.operation))], [operation]);
    assert.deepEqual(requests.map(event => event.stage), ['received', 'auth', 'closed']);
    assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|token|owner|workspace|headers|arguments|https?:|stack/i);
    for (const event of requests) assert.ok(Object.keys(event).every(key => ['requestId', 'operation', 'stage', 'reason', 'httpStatus'].includes(key)));
  }
});

test('HTTP OAuth requires local approval and PKCE, isolates sessions and tasks, and rotates and revokes tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-oauth-'));
  const config: RuntimeConfig = { workspace: dir, stateDir: dir, port: 0, controlPort: 0, exposure: 'compact', plugins: [], maxConcurrent: 2, maxTasks: 50 };
  const tasks = new Map<string, TaskRecord>();
  let subscriptions = 0;
  const runtime: McpRuntime = {
    config, listTools: () => [], instructions: () => '',
    async submit(name, args, owner) {
      const now = new Date().toISOString();
      const record: TaskRecord = { id: String(tasks.size + 1), owner, tool: name, pluginId: 'test', effect: 'write', status: 'awaiting_approval', args, inputHash: '', createdAt: now, updatedAt: now };
      tasks.set(record.id, record); return record;
    },
    getTask(id, owner) { const record = tasks.get(id); return record && (!owner || record.owner === owner) ? record : undefined; },
    listTasks: owner => [...tasks.values()].filter(record => !owner || record.owner === owner),
    async cancelTask() {},
    onEvent() { subscriptions++; return () => { subscriptions--; }; },
  };
  const evidence: unknown[] = [];
  let bridge = await startMcpHttp(runtime, config, { approvalTimeoutMs: 250, onEvidence: event => evidence.push(event) });
  const base = new URL(bridge.url).origin;
  const json = async (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  const form = async (path: string, body: Record<string, string>) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });
  const redirectUri = 'https://chatgpt.com/connector/callback';
  async function register(name: string) {
    const response = await json('/register', { client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    assert.equal(response.status, 201);
    return (await response.json()).client_id as string;
  }
  async function requestAuthorization(clientId: string) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('/authorize', base);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, scope: 'mcp', state: 'client-state', resource: bridge.url }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const request = bridge.oauth.pending().at(-1)!;
    assert.match(await response.text(), new RegExp(request.verificationCode));
    assert.deepEqual(await (await fetch(`${base}/oauth/pending/${request.id}`)).json(), { status: 'pending' });
    return { request, verifier };
  }
  async function approve(clientId: string) {
    const { request, verifier } = await requestAuthorization(clientId);
    bridge.oauth.decide(request.id, true);
    const poll = await (await fetch(`${base}/oauth/pending/${request.id}`)).json();
    const redirect = new URL(poll.redirect);
    assert.equal(redirect.origin + redirect.pathname, redirectUri);
    assert.equal(redirect.searchParams.get('state'), 'client-state');
    return { code: redirect.searchParams.get('code')!, verifier };
  }
  const exchange = (clientId: string, code: string, verifier: string, overrides: Record<string, string> = {}) => form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: bridge.url, ...overrides });
  let rpcId = 0;
  async function rpc(access: string, method: string, params: Record<string, unknown>, sessionId?: string) {
    return json('/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }, { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });
  }
  async function approved<T>(pending: Promise<T>) {
    for (let i = 0; i < 100 && !bridge.access.pending().length; i++) await delay(5);
    assert.equal(bridge.access.pending().length, 1); bridge.access.decide(bridge.access.pending()[0].id, true, 'client'); return pending;
  }
  const initialize = (access: string) => rpc(access, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1.0.0' } });
  try {
    const unauthorized = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata=/);
    assert.equal((await json('/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })).status, 401);
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/.well-known/oauth-authorization-server', { headers: { Host: 'evil.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(base + '/.well-known/oauth-authorization-server', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const metadata = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(metadata.resource, bridge.url);
    assert.equal((await json('/register', { redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' })).status, 400);
    const clientA = await register('ChatGPT A');
    const clientB = await register('ChatGPT B');
    const denied = await requestAuthorization(clientB);
    bridge.oauth.decide(denied.request.id, false);
    const denial = new URL((await (await fetch(`${base}/oauth/pending/${denied.request.id}`)).json()).redirect);
    assert.equal(denial.searchParams.get('error'), 'access_denied');
    const authorization = await approve(clientA);
    assert.equal((await exchange(clientA, authorization.code, 'x'.repeat(43))).status, 400);
    assert.equal((await exchange(clientB, authorization.code, authorization.verifier)).status, 400);
    assert.equal((await exchange(clientA, authorization.code, authorization.verifier, { resource: 'https://evil.example/mcp' })).status, 400);
    assert.equal((await exchange(clientA, authorization.code, authorization.verifier, { redirect_uri: 'https://evil.example/cb' })).status, 400);
    const issued = await exchange(clientA, authorization.code, authorization.verifier);
    assert.equal(issued.status, 200);
    const tokensA = await issued.json();
    assert.equal((await exchange(clientA, authorization.code, authorization.verifier)).status, 400);
    const authorizationB = await approve(clientB);
    const tokensB = await (await exchange(clientB, authorizationB.code, authorizationB.verifier)).json();
    const initA = await initialize(tokensA.access_token);
    assert.equal(initA.status, 200);
    const sessionA = initA.headers.get('mcp-session-id')!;
    assert.ok(sessionA);
    assert.equal((await initA.json()).result.serverInfo.name, 'capyra');
    const initB = await initialize(tokensB.access_token);
    assert.equal(initB.status, 200);
    const sessionB = initB.headers.get('mcp-session-id')!;
    await initB.json();
    const beforeInvalidInit = subscriptions;
    const invalidInit = await json('/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'invalid-accept', version: '1' } } }, { authorization: `Bearer ${tokensB.access_token}`, accept: 'application/json' });
    assert.equal(invalidInit.status, 406);
    await invalidInit.json();
    assert.equal(subscriptions, beforeInvalidInit);
    assert.equal((await rpc(tokensB.access_token, 'tools/list', {}, sessionA)).status, 404);
    const submitted = await (await rpc(tokensA.access_token, 'tools/call', { name: 'capyra_call', arguments: { tool: 'fixture_write', args: {} } }, sessionA)).json();
    const taskId = JSON.parse(submitted.result.content[0].text).taskId;
    const listB = await (await approved(rpc(tokensB.access_token, 'tools/call', { name: 'capyra_tasks', arguments: { action: 'list' } }, sessionB))).json();
    assert.deepEqual(JSON.parse(listB.result.content[0].text).tasks, []);
    const getB = await (await approved(rpc(tokensB.access_token, 'tools/call', { name: 'capyra_tasks', arguments: { action: 'get', id: taskId } }, sessionB))).json();
    assert.equal(getB.result.isError, true);
    const refresh = await form('/token', { grant_type: 'refresh_token', client_id: clientA, refresh_token: tokensA.refresh_token, resource: bridge.url });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    assert.equal((await rpc(tokensA.access_token, 'tools/list', {}, sessionA)).status, 401);
    assert.equal((await form('/token', { grant_type: 'refresh_token', client_id: clientA, refresh_token: tokensA.refresh_token })).status, 400);
    assert.equal((await rpc(rotated.access_token, 'tools/list', {}, sessionA)).status, 200);
    await form('/revoke', { client_id: clientB, token: rotated.access_token });
    assert.equal((await rpc(rotated.access_token, 'tools/list', {}, sessionA)).status, 200);
    const stateless = await json('/mcp', { jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} }, { authorization: `Bearer ${rotated.access_token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
    assert.equal(stateless.status, 200); assert.equal(stateless.headers.get('mcp-session-id'), null); assert.equal((await stateless.json()).result.tools.length, 4);
    const modernHeaders = { authorization: `Bearer ${rotated.access_token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' };
    const modernBody = { jsonrpc: '2.0', id: 'modern', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } };
    const modern = await json('/mcp', modernBody, modernHeaders);
    assert.equal(modern.status, 200); assert.equal(modern.headers.get('mcp-session-id'), null);
    const modernResult = await modern.json(); assert.equal(modernResult.result.resultType, 'complete'); assert.ok(modernResult.result.supportedVersions.includes('2026-07-28'));
    const mismatch = await json('/mcp', modernBody, { ...modernHeaders, 'mcp-method': 'tools/call' });
    assert.equal(mismatch.status, 400); assert.equal((await mismatch.json()).error.code, -32020);
    const missing = await json('/mcp', { ...modernBody, params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, modernHeaders);
    assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, -32602);
    const unsupported = await json('/mcp', { ...modernBody, params: { _meta: { ...modernBody.params._meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }, { ...modernHeaders, 'mcp-protocol-version': '2099-01-01' });
    assert.equal((await unsupported.json()).error.code, -32022);
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, service: 'capyra' });
    const controller = new AbortController();
    const disconnectRequest = fetch(base + '/mcp', { method: 'POST', signal: controller.signal, headers: { ...modernHeaders, 'content-type': 'application/json', 'mcp-method': 'tools/call', 'mcp-name': 'capyra_tasks' }, body: JSON.stringify({ ...modernBody, method: 'tools/call', params: { ...modernBody.params, name: 'capyra_tasks', arguments: { action: 'list' } } }) });
    const aborted = assert.rejects(disconnectRequest);
    for (let i = 0; i < 100 && !bridge.access.pending().length; i++) await delay(5);
    const staleId = bridge.access.pending()[0].id; controller.abort(); await aborted;
    for (let i = 0; i < 100 && bridge.access.pending().length; i++) await delay(5);
    assert.equal(bridge.access.pending().length, 0); assert.throws(() => bridge.access.decide(staleId, true, 'client'));
    const pendingDelete = rpc(rotated.access_token, 'tools/call', { name: 'capyra_discover', arguments: {} }, sessionA);
    for (let i = 0; i < 100 && !bridge.access.pending().length; i++) await delay(5);
    const deletedId = bridge.access.pending()[0].id;
    const deleted = await fetch(base + '/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${rotated.access_token}`, 'mcp-session-id': sessionA } });
    assert.equal(deleted.status, 200); await pendingDelete.catch(() => undefined);
    for (let i = 0; i < 100 && bridge.access.pending().length; i++) await delay(5);
    assert.throws(() => bridge.access.decide(deletedId, true, 'client'));
    const grantIds = bridge.oauth.grants().map(grant => grant.id);
    const stateFile = join(dir, (await readdir(dir)).find(name => name.startsWith('oauth-'))!);
    const disk = await readFile(stateFile, 'utf8');
    assert.ok(!disk.includes(rotated.access_token) && !disk.includes(rotated.refresh_token));
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    await bridge.close(); await delay(50); assert.equal(subscriptions, 0);
    bridge = await startMcpHttp(runtime, { ...config, port: Number(new URL(base).port) }, { approvalTimeoutMs: 250 });
    assert.deepEqual(bridge.oauth.grants().map(grant => grant.id), grantIds);
    const restarted = await initialize(rotated.access_token); assert.equal(restarted.status, 200); await restarted.json();
    const concurrent = await Promise.all([form('/token', { grant_type: 'refresh_token', client_id: clientA, refresh_token: rotated.refresh_token }), form('/token', { grant_type: 'refresh_token', client_id: clientA, refresh_token: rotated.refresh_token })]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 400]);
    const fresh = await concurrent.find(response => response.status === 200)!.json();
    assert.equal((await initialize(rotated.access_token)).status, 401);
    await bridge.close(); await delay(50);
    const expiringState = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const entry of expiringState.tokens) if (entry[1].kind === 'access') entry[1].expiresAt = Date.now() + 2200;
    await writeFile(stateFile, JSON.stringify(expiringState), { mode: 0o600 });
    let resourceRunning = false;
    runtime.hasService = name => name === 'mcp.extensions';
    runtime.service = <T>() => ({ capabilities: { resources: {} }, async handle(_method: string, _params: unknown, context: { signal: AbortSignal }) {
      resourceRunning = true;
      await new Promise<void>((_done, reject) => context.signal.addEventListener('abort', () => reject(new Error('PRIVATE RESOURCE SHOULD NOT LEAK')), { once: true }));
      return { contents: [{ text: 'PRIVATE' }] };
    } }) as T;
    bridge = await startMcpHttp(runtime, { ...config, port: Number(new URL(base).port) }, { approvalTimeoutMs: 5000 });
    const expiringRequest = json('/mcp', { ...modernBody, method: 'resources/read', params: { ...modernBody.params, uri: 'file:///secret' } }, { ...modernHeaders, authorization: `Bearer ${fresh.access_token}`, 'mcp-method': 'resources/read', 'mcp-name': 'file:///secret' });
    const expiredRequest = assert.rejects(expiringRequest);
    for (let i = 0; i < 100 && !bridge.access.pending().length; i++) await delay(5);
    bridge.access.decide(bridge.access.pending()[0].id, true, 'client');
    for (let i = 0; i < 100 && !resourceRunning; i++) await delay(5);
    assert.ok(resourceRunning); await expiredRequest;
    assert.equal(bridge.access.pending().length, 0);
    assert.equal((await initialize(fresh.access_token)).status, 401);
    await form('/revoke', { client_id: clientA, token: fresh.access_token });
    assert.equal((await rpc(rotated.access_token, 'tools/list', {}, sessionA)).status, 401);
    bridge.oauth.revoke();
    assert.equal((await rpc(tokensB.access_token, 'tools/list', {}, sessionB)).status, 401);
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
  assert.equal(subscriptions, 0);
});


test('revocation interrupts active work even when its atomic state write fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-oauth-failure-'));
  let revoked = false;
  const issuer = new URL('https://oauth-test.example');
  const oauth = createOAuth(issuer, () => { revoked = true; }, { stateDir: dir });
  try {
    const filename = `oauth-${createHash('sha256').update(issuer.origin).digest('hex').slice(0, 24)}.json`;
    await mkdir(join(dir, filename));
    assert.throws(() => oauth.revoke());
    assert.equal(revoked, true);
    assert.deepEqual(await readdir(dir), [filename]);
  } finally { oauth.close(); await rm(dir, { recursive: true, force: true }); }
});

test('tunnel forwarding headers neither trigger OAuth proxy errors nor change identity or endpoint rate budgets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-oauth-forwarded-'));
  const config: RuntimeConfig = { workspace: dir, stateDir: dir, port: 0, controlPort: 0, publicUrl: 'https://tunnel.example', exposure: 'compact', plugins: [], maxConcurrent: 2, maxTasks: 50 };
  const runtime: McpRuntime = { config, listTools: () => [], instructions: () => 'PRIVATE WORKSPACE INSTRUCTIONS',
    async submit() { throw new Error('No work should execute during proxy-header validation.'); }, getTask: () => undefined, listTasks: () => [], async cancelTask() {}, onEvent: () => () => {} };
  const errors: unknown[] = []; t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(...args); });
  const bridge = await startMcpHttp(runtime, config, { approvalTimeoutMs: 50 });
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const base = bridge.localUrl, redirectUri = 'https://client.example/callback'; let sequence = 0;
  const forwarded = () => { const id = ++sequence; return { 'X-Forwarded-For': `203.0.113.${id % 254 + 1}`, Forwarded: `for="[2001:db8::${id.toString(16)}]";proto=https;host=attacker.example`, 'CF-Connecting-IP': `198.51.100.${id % 254 + 1}`, 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-User': 'local-console', 'X-Capyra-Owner': 'local-console' }; };
  const json = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { ...forwarded(), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  const form = (route: string, body: Record<string, string>) => fetch(base + route, { method: 'POST', headers: { ...forwarded(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });
  const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server', { headers: forwarded() })).json();
  assert.equal(metadata.issuer, 'https://tunnel.example/'); assert.equal(metadata.token_endpoint, 'https://tunnel.example/token');
  const registered = await json('/register', { client_name: 'Tunnel fixture', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registered.status, 201); const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(base + '/authorize'); authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, scope: 'mcp', resource: bridge.url }).toString();
  const requested = await fetch(authorize, { headers: forwarded(), redirect: 'manual' }); assert.equal(requested.status, 200); await requested.text();
  assert.equal(bridge.oauth.pending().length, 1); assert.equal(bridge.oauth.grants().length, 0);
  const exchange = (code: string) => form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: bridge.url });
  const unapproved = await exchange('not-approved'); assert.equal(unapproved.status, 400); await unapproved.text();
  const anonymous = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); assert.equal(anonymous.status, 401); await anonymous.text();
  const pending = bridge.oauth.pending()[0]; bridge.oauth.decide(pending.id, true);
  const redirect = new URL((await (await fetch(base + '/oauth/pending/' + pending.id, { headers: forwarded() })).json()).redirect);
  const exchanged = await exchange(redirect.searchParams.get('code')!); assert.equal(exchanged.status, 200); const tokens = await exchanged.json();
  const initialized = await json('/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Tunnel fixture', version: '1' } } }, { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' });
  assert.equal(initialized.status, 200); const session = initialized.headers.get('mcp-session-id')!; await initialized.json();
  const discovery = json('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capyra_discover', arguments: {} } }, { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session });
  for (let i = 0; i < 100 && !bridge.access.pending().length; i++) await delay(1);
  assert.equal(bridge.access.pending()[0]?.owner, `oauth:${bridge.oauth.grants()[0].id}`);
  const denied = await (await discovery).json(); assert.equal(JSON.parse(denied.result.content[0].text).status, 'not_approved'); assert.doesNotMatch(JSON.stringify(denied), /PRIVATE WORKSPACE/);
  const routes = [
    { limit: 20, send: () => json('/register', {}) },
    { limit: 100, send: () => fetch(base + '/authorize?client_id=missing', { headers: forwarded(), redirect: 'manual' }) },
    { limit: 50, send: () => form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: 'not-issued' }) },
    { limit: 50, send: () => form('/revoke', { client_id: clientId, token: 'not-issued' }) },
  ];
  for (const route of routes) {
    const first = await route.send(); assert.notEqual(first.status, 429); assert.equal(Number(first.headers.get('ratelimit-limit')), route.limit);
    const remaining = Number(first.headers.get('ratelimit-remaining')); assert.ok(Number.isInteger(remaining) && remaining >= 0 && remaining < route.limit); await first.text();
    for (let i = 0; i < remaining; i++) { const response = await route.send(); assert.notEqual(response.status, 429); await response.text(); }
    for (let i = 0; i < 2; i++) { const limited = await route.send(); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0); await limited.text(); }
  }
  assert.deepEqual(errors, [], 'Forwarded headers must not produce SDK rate-limit validation errors.');
});
