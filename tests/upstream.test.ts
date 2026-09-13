import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createUpstreamPlugin } from '../src/plugins/upstream.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

const callContext = (): ToolContext => ({ workspace: tmpdir(), owner: 'local-console', signal: new AbortController().signal, taskId: randomUUID(), progress() {} });

function harness(workspace: string, config: Record<string, unknown>, allTools = new Map<string, ToolDefinition>(), id = 'fixture') {
  const cleanup: Array<() => void | Promise<void>> = [];
  const services = new Map<string, unknown>();
  const context: PluginContext = {
    workspace, stateDir: workspace, config,
    registerTool(tool) {
      const key = `${id}__${tool.name}`;
      if (allTools.has(key)) throw new Error(`duplicate: ${key}`);
      allTools.set(key, tool);
      return () => { if (allTools.get(key) === tool) allTools.delete(key); };
    },
    provide(name, service) { services.set(name, service); },
    service<T>(name: string) { return services.get(name) as T; },
    guard() {}, onEvent() {}, onDispose(dispose) { cleanup.push(dispose); },
  };
  return { context, tools: allTools, services, async close() { for (const dispose of cleanup.reverse()) await dispose(); } };
}

const inputSchema = { type: 'object' as const, properties: { value: { type: 'string' } }, additionalProperties: false };
const declaredTools: Tool[] = [
  { name: 'inspect', title: 'Inspect fixture', inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'common', description: 'A shared upstream tool name', inputSchema, annotations: { readOnlyHint: true } },
  { name: 'a.b', inputSchema },
  { name: 'a_b', inputSchema },
  { name: 'payload', inputSchema, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
  { name: 'switch_catalog', inputSchema: { type: 'object', properties: { invalid: { type: 'boolean' } } } },
];
const richResult = {
  content: [
    { type: 'text', text: 'fixture', annotations: { audience: ['user'], priority: 0.5 }, _meta: { source: 'fixture' } },
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'fixture:///note', text: 'attached', mimeType: 'text/plain' } },
    { type: 'resource_link', name: 'attachment', uri: 'fixture:///attachment', mimeType: 'text/plain' },
  ],
  structuredContent: { ok: true },
  isError: true,
  _meta: { fixture: 'metadata' },
};

async function stdioFixture(dir: string) {
  const entry = join(dir, 'fixture.mjs');
  const script = `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(join(dir, 'started'))}, String(process.pid));
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
let catalog = ${JSON.stringify(declaredTools)};
if (process.env.FIXTURE_DUPLICATE) catalog.push(catalog[0]);
server.setRequestHandler(ListToolsRequestSchema, async request => {
  const offset = Number(request.params?.cursor ?? 0);
  return { tools: catalog.slice(offset, offset + 2), ...(offset + 2 < catalog.length ? { nextCursor: String(offset + 2) } : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'common' && request.params.arguments?.value === 'wait') {
    if (request.params._meta?.progressToken !== undefined) await server.notification({ method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: 1, message: 'waiting' } });
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
    return { content: [{ type: 'text', text: 'cancelled' }] };
  }
  if (request.params.name === 'inspect') return { content: [{ type: 'text', text: 'environment' }], structuredContent: { pid: process.pid, secret: process.env.CAPYRA_TEST_SECRET ?? null, explicit: process.env.FIXTURE_EXPLICIT ?? null } };
  if (request.params.name === 'payload') return ${JSON.stringify(richResult)};
  if (request.params.name === 'switch_catalog') {
    catalog = request.params.arguments?.invalid ? [catalog[0], catalog[0]] : [{ name: 'replacement', inputSchema: { type: 'object' } }];
    await server.sendToolListChanged();
  }
  return { content: [{ type: 'text', text: request.params.name }] };
});
await server.connect(new StdioServerTransport());
`;
  await writeFile(entry, script);
  return { entry, config: { transport: 'stdio', command: process.execPath, args: [entry], timeoutMs: 3000 } };
}

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), 'condition did not become true');
}

test('stdio upstream is lazy, paginated, namespaced, locally authorized and releases its child', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-upstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await stdioFixture(dir);
  const first = createUpstreamPlugin('first');
  await assert.rejects(readFile(join(dir, 'started')), { code: 'ENOENT' });
  const tools = new Map<string, ToolDefinition>();
  const a = harness(dir, { ...fixture.config, readOnlyTools: ['inspect'], env: { FIXTURE_EXPLICIT: 'configured' } }, tools, 'first');
  const b = harness(dir, fixture.config, tools, 'second');
  t.after(() => a.close());
  t.after(() => b.close());
  const previousSecret = process.env.CAPYRA_TEST_SECRET;
  process.env.CAPYRA_TEST_SECRET = 'do-not-inherit';
  try { await first.setup(a.context); } finally {
    if (previousSecret === undefined) delete process.env.CAPYRA_TEST_SECRET;
    else process.env.CAPYRA_TEST_SECRET = previousSecret;
  }
  await createUpstreamPlugin('second').setup(b.context);
  assert.equal(tools.size, 12);
  assert.ok(tools.has('first__common') && tools.has('second__common'));
  assert.ok(tools.has('first__a_b'));
  assert.ok([...tools.keys()].some(name => /^first__a_b_[0-9a-f]{12}$/.test(name)));
  assert.equal(tools.get('first__inspect')!.effect, 'read');
  assert.equal(tools.get('first__common')!.effect, 'execute');
  assert.equal(tools.get('first__common')!.annotations!.readOnlyHint, false);
  assert.deepEqual(tools.get('first__inspect')!.inputSchema, inputSchema);
  assert.deepEqual(tools.get('first__payload')!.outputSchema, declaredTools[4]!.outputSchema);
  const result = await tools.get('first__inspect')!.execute({}, callContext());
  assert.equal(result.structuredContent!.secret, null);
  assert.equal(result.structuredContent!.explicit, 'configured');
  assert.deepEqual(await tools.get('first__payload')!.execute({}, callContext()), richResult);
  const stale = tools.get('first__inspect')!;
  const pid = result.structuredContent!.pid as number;
  await a.close();
  assert.equal(tools.size, 6);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(stale.execute({}, callContext()), /disconnected/);
});

test('catalog changes replace registrations and invalid refresh keeps the last valid generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-upstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await stdioFixture(dir);
  const state = harness(dir, fixture.config);
  t.after(() => state.close());
  await createUpstreamPlugin('fixture').setup(state.context);
  const previous = state.tools.get('fixture__common')!;
  await state.tools.get('fixture__switch_catalog')!.execute({ invalid: true }, callContext());
  const status = state.services.get('fixture.status') as { error?: string };
  await eventually(() => Boolean(status.error));
  assert.match(status.error!, /duplicate tool name/);
  assert.equal(state.tools.size, 6);
  assert.equal(state.tools.get('fixture__common'), previous);
  await state.tools.get('fixture__switch_catalog')!.execute({}, callContext());
  await eventually(() => state.tools.has('fixture__replacement'));
  assert.equal(state.tools.size, 1);
  await assert.rejects(previous.execute({}, callContext()), /tools changed/);
});

test('duplicate upstream names reject setup and leave no child or partial registrations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-upstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await stdioFixture(dir);
  const state = harness(dir, { ...fixture.config, env: { FIXTURE_DUPLICATE: 'yes' } });
  await assert.rejects(createUpstreamPlugin('fixture').setup(state.context), /duplicate tool name/);
  assert.equal(state.tools.size, 0);
  const pid = Number(await readFile(join(dir, 'started'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('request cancellation is forwarded and disabling cancels an in-flight call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-upstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await stdioFixture(dir);
  const state = harness(dir, fixture.config);
  t.after(() => state.close());
  await createUpstreamPlugin('fixture').setup(state.context);
  const tool = state.tools.get('fixture__common')!;
  let waiting = false;
  const controller = new AbortController();
  const pending = tool.execute({ value: 'wait' }, { ...callContext(), signal: controller.signal, progress: () => { waiting = true; } });
  const cancelled = assert.rejects(pending, /cancel|abort/i);
  await eventually(() => waiting);
  controller.abort(new Error('request cancelled'));
  await cancelled;
  waiting = false;
  const running = tool.execute({ value: 'wait' }, { ...callContext(), progress: () => { waiting = true; } });
  const disabled = assert.rejects(running, /disabled|closed|abort/i);
  await eventually(() => waiting);
  await state.close();
  await disabled;
  const pid = Number(await readFile(join(dir, 'started'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('HTTP upstream preserves rich results, filters tools and terminates its session', async t => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const server = new Server({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: declaredTools }));
  server.setRequestHandler(CallToolRequestSchema, async () => richResult as never);
  await server.connect(transport);
  let deleted = false;
  const http = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401).end(); return; }
    if (req.method === 'DELETE') deleted = true;
    void transport.handleRequest(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  t.after(async () => { await server.close(); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const state = harness(tmpdir(), { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer fixture-only' }, allowTools: ['payload'], timeoutMs: 3000 });
  t.after(() => state.close());
  await createUpstreamPlugin('fixture').setup(state.context);
  assert.equal(state.tools.size, 1);
  assert.deepEqual(await state.tools.get('fixture__payload')!.execute({}, callContext()), richResult);
  await state.close();
  assert.equal(deleted, true);
  assert.equal(state.tools.size, 0);
});


test('SSE upstream authenticates both GET and POST and releases its connection', async t => {
  const server = new Server({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [declaredTools[0]] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'sse-result' }] }));
  let transport: SSEServerTransport | undefined;
  const methods: string[] = [];
  const http = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer sse-test-secret') { res.writeHead(401).end(); return; }
    methods.push(req.method!);
    if (req.method === 'GET') { transport = new SSEServerTransport('/messages', res); void server.connect(transport); }
    else if (transport) void transport.handlePostMessage(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  t.after(async () => { await server.close(); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const prior = process.env.CAPYRA_UPSTREAM_TEST_TOKEN; process.env.CAPYRA_UPSTREAM_TEST_TOKEN = 'sse-test-secret';
  const state = harness(tmpdir(), { transport: 'sse', url: `http://127.0.0.1:${address.port}/sse`, auth: { type: 'bearer', tokenEnv: 'CAPYRA_UPSTREAM_TEST_TOKEN' }, timeoutMs: 2000 });
  t.after(() => state.close());
  try { await createUpstreamPlugin('fixture').setup(state.context); }
  finally { if (prior === undefined) delete process.env.CAPYRA_UPSTREAM_TEST_TOKEN; else process.env.CAPYRA_UPSTREAM_TEST_TOKEN = prior; }
  assert.equal((await state.tools.get('fixture__inspect')!.execute({}, callContext())).content[0].type, 'text');
  assert.ok(methods.includes('GET') && methods.includes('POST'));
  await state.close(); assert.equal(state.tools.size, 0);
});

test('unexpected upstream exit reconnects its catalog without replaying a call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capyra-upstream-reconnect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await stdioFixture(dir);
  const state = harness(dir, { ...fixture.config, reconnectDelayMs: 20 });
  t.after(() => state.close());
  await createUpstreamPlugin('fixture').setup(state.context);
  const original = state.tools.get('fixture__common')!;
  const pid = Number(await readFile(join(dir, 'started'), 'utf8'));
  let started = false;
  const pending = original.execute({ value: 'wait' }, { ...callContext(), progress: () => { started = true; } });
  const failed = assert.rejects(pending, /closed|connection/i);
  await eventually(() => started); process.kill(pid, 'SIGKILL'); await failed;
  await eventually(() => state.tools.get('fixture__common') !== original);
  const status = state.services.get('fixture.status') as { connected: boolean; reconnecting: boolean };
  assert.equal(status.connected, true);
  const next = await state.tools.get('fixture__inspect')!.execute({}, callContext());
  assert.notEqual(next.structuredContent!.pid, pid);
  await assert.rejects(original.execute({}, callContext()), /tools changed/);
  await state.close(); assert.equal(status.connected, false); assert.equal(status.reconnecting, false);
});
