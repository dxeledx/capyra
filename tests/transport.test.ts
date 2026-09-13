import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpRuntime, type McpOptions, type McpTemplateDiagnostic } from '../src/transport/mcp.js';
import { createAccessController, type AccessController } from '../src/transport/access.js';
import type { RegisteredTool, RuntimeConfig, TaskRecord } from '../src/core/types.js';
import { createMcpExtensions } from '../src/client-ui/extensions.js';

async function eventually(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await delay(5); assert.ok(check()); }
function fixture(exposure: 'direct' | 'compact') {
  const tasks = new Map<string, TaskRecord>();
  const access = createAccessController(300);
  const tool: RegisteredTool = { name: 'files_read', localName: 'read', pluginId: 'files', title: 'Read a file', description: 'PRIVATE DESCRIPTION', effect: 'read', permissions: ['fs.read'], inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, async execute() { return { content: [] }; } };
  tool.outputSchema = { type: 'object', properties: { value: { type: 'string' } } };
  tool._meta = { 'capyra/plugin': 'untrusted-value', provider: 'upstream' };
  let subscriptions = 0;
  const original = { content: [{ type: 'text' as const, text: 'PRIVATE RESULT' }, { type: 'image' as const, mimeType: 'image/png', data: 'AA==' }], structuredContent: { value: 'PRIVATE RESULT' }, _meta: { source: 'fixture' } };
  const runtime: McpRuntime = {
    config: { exposure } as RuntimeConfig,
    listTools: () => [tool], instructions: () => 'PRIVATE INSTRUCTIONS',
    async submit(name, args, owner) {
      if (name !== tool.name) throw new Error('/PRIVATE/PATH unknown tool');
      const now = new Date().toISOString();
      const task: TaskRecord = { id: String(tasks.size + 1), workspace: '/PRIVATE/ROOT', resultVisibility: 'local', owner, tool: name, pluginId: 'files', effect: 'read', status: 'awaiting_approval', args, inputHash: 'PRIVATE HASH', createdAt: now, updatedAt: now, preview: { title: 'PRIVATE PREVIEW', description: 'PRIVATE BEFORE' }, error: 'PRIVATE ERROR', progress: 'PRIVATE PROGRESS' };
      tasks.set(task.id, task); return task;
    },
    getTask(id, owner) { const task = tasks.get(id); return task && (!owner || owner === task.owner) ? task : undefined; },
    listTasks: owner => [...tasks.values()].filter(task => !owner || owner === task.owner),
    async cancelTask(id, owner) { const task = runtime.getTask(id, owner); if (task) task.status = 'cancelled'; },
    async waitTask(id, timeout) { const deadline = Date.now() + timeout; while (tasks.get(id)?.status === 'awaiting_approval' && Date.now() < deadline) await delay(5); },
    onEvent() { subscriptions++; return () => { subscriptions--; }; },
  };
  return { runtime, access, tasks, original, subscriptions: () => subscriptions,
    approve(id: string, visibility: 'client' | 'local') { Object.assign(tasks.get(id)!, { status: 'succeeded', resultVisibility: visibility, result: original }); },
  };
}
async function connect(runtime: McpRuntime, owner: string, access: AccessController, options: McpOptions = {}) {
  const server = createMcpServer(runtime, owner, { access, approvalTimeoutMs: 150, ...options });
  const client = new Client({ name: 'transport-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport); return client;
}
async function approved<T>(promise: Promise<T>, access: AccessController, visibility: 'client' | 'local' = 'client') {
  await eventually(() => access.pending().length > 0); access.decide(access.pending()[0].id, true, visibility); return promise;
}
const body = (result: any) => JSON.parse(result.content[0].text);

test('capability discovery accepts client keyword phrases after exact local approval', async () => {
  const f = fixture('compact'); const client = await connect(f.runtime, 'owner', f.access);
  try {
    const found = await approved(client.callTool({ name: 'capyra_discover', arguments: { query: 'files read：只查找读取能力' } }), f.access);
    assert.equal(body(found).tools[0].name, 'files_read');
    const missing = await approved(client.callTool({ name: 'capyra_discover', arguments: { query: 'unrelated_capability' } }), f.access);
    assert.deepEqual(body(missing).tools, []);
  } finally { await client.close(); f.access.close(); }
});

test('compact catalogs retain host-native file parameters and their calls still need a separate approval', async () => {
  const f = fixture('compact'); const tool = f.runtime.listTools()[0];
  tool.inputSchema = { type: 'object', properties: { file: { type: 'object' } }, required: ['file'] };
  tool._meta = { 'openai/fileParams': ['file'] };
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    const hidden = await approved(client.listTools(), f.access, 'local');
    assert.equal(hidden.tools.length, 4);
    const catalog = await approved(client.listTools(), f.access);
    assert.equal(catalog.tools.length, 5); assert.deepEqual(catalog.tools[4]._meta?.['openai/fileParams'], ['file']);
    const pending = client.callTool({ name: tool.name, arguments: { file: { file_id: 'synthetic-file' } } });
    await eventually(() => f.tasks.size === 1);
    assert.equal(f.tasks.get('1')?.status, 'awaiting_approval');
    f.approve('1', 'client'); assert.deepEqual((await pending).content, f.original.content);
  } finally { await client.close(); f.access.close(); }
});

test('direct schemas and multimodal results require separate explicit approval', async () => {
  const f = fixture('direct'); const client = await connect(f.runtime, 'owner-a', f.access);
  try {
    assert.doesNotMatch(client.getInstructions()!, /PRIVATE/);
    const catalog = await approved(client.listTools(), f.access);
    assert.deepEqual(catalog.tools.map(tool => tool.name), ['files_read', 'capyra_tasks', 'capyra_cancel']);
    assert.deepEqual(catalog.tools[0].inputSchema, f.runtime.listTools()[0].inputSchema);
    assert.equal(catalog.tools[0].outputSchema, undefined);
    assert.equal(catalog.tools[0]._meta?.['capyra/plugin'], 'files');
    const pending = client.callTool({ name: 'files_read', arguments: { path: 'a.txt' } });
    await eventually(() => f.tasks.size === 1); f.approve('1', 'client');
    const result = await pending;
    assert.deepEqual(result.content, f.original.content); assert.deepEqual(result.structuredContent, f.original.structuredContent);
    const history = await approved(client.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: '1' } }), f.access, 'local');
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE/);
  } finally { await client.close(); f.access.close(); }
  assert.equal(f.subscriptions(), 0);
});

test('shared OAuth owner cannot borrow another concurrent request approval or poll past authorizations', async () => {
  const f = fixture('compact'); const client = await connect(f.runtime, 'same-shared-account', f.access); const other = await connect(f.runtime, 'same-shared-account', f.access);
  try {
    assert.doesNotMatch(JSON.stringify(await client.listTools()), /PRIVATE/);
    const discoverA = client.callTool({ name: 'capyra_discover', arguments: { query: 'files' } });
    const discoverB = other.callTool({ name: 'capyra_discover', arguments: { query: 'files' } });
    await eventually(() => f.access.pending().length === 2);
    const [a, b] = f.access.pending(); assert.notEqual(a.id, b.id);
    f.access.decide(a.id, true, 'client'); f.access.decide(b.id, false);
    assert.match(JSON.stringify(await discoverA), /PRIVATE INSTRUCTIONS/);
    assert.doesNotMatch(JSON.stringify(await discoverB), /PRIVATE/);
    assert.throws(() => f.access.decide(a.id, true, 'client'), /expired|already/);
    const replay = other.callTool({ name: 'capyra_discover', arguments: { query: 'files' } });
    assert.doesNotMatch(JSON.stringify(await replay), /PRIVATE/);
    assert.equal(f.access.pending().length, 0);
  } finally { await Promise.all([client.close(), other.close()]); f.access.close(); }
});

test('local-only task content remains private even on a newly approved history query', async () => {
  const f = fixture('compact'); const client = await connect(f.runtime, 'owner-a', f.access); const other = await connect(f.runtime, 'owner-b', f.access);
  try {
    const pending = client.callTool({ name: 'capyra_call', arguments: { tool: 'files_read', args: { path: 'secret' } } });
    await eventually(() => f.tasks.size === 1); f.approve('1', 'local');
    assert.deepEqual(body(await pending), { taskId: '1', status: 'succeeded' });
    const get = await approved(client.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: '1' } }), f.access);
    assert.deepEqual(body(get), { taskId: '1', status: 'succeeded' });
    const list = await approved(client.callTool({ name: 'capyra_tasks', arguments: { action: 'list' } }), f.access);
    assert.deepEqual(body(list), { tasks: [{ taskId: '1', status: 'succeeded' }] });
    assert.doesNotMatch(JSON.stringify(list), /PRIVATE/);
    const leaked = await approved(other.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: '1' } }), f.access);
    assert.equal(leaked.isError, true); assert.doesNotMatch(JSON.stringify(leaked), /PRIVATE/);
    const bad = await client.callTool({ name: 'capyra_call', arguments: { tool: 'missing', args: {} } });
    assert.doesNotMatch(JSON.stringify(bad), /PRIVATE/);
  } finally { await Promise.all([client.close(), other.close()]); f.access.close(); }
});

test('approval timeout and MCP cancellation invalidate the pending task or access callback', async () => {
  const f = fixture('compact'); const client = await connect(f.runtime, 'owner-a', f.access);
  try {
    const result = await client.callTool({ name: 'capyra_call', arguments: { tool: 'files_read', args: {} } });
    assert.deepEqual(body(result), { taskId: '1', status: 'cancelled' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'capyra_discover', arguments: {} }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await eventually(() => f.access.pending().length === 1);
    const id = f.access.pending()[0].id; controller.abort(); await rejected;
    await eventually(() => f.access.pending().length === 0);
    assert.throws(() => f.access.decide(id, true, 'client'));
  } finally { await client.close(); f.access.close(); }
});

test('scope revocation blocks historic content and metadata even after a local approval', async () => {
  const f = fixture('compact');
  let allowed = true; let checks = 0;
  f.runtime.config.plugins = [{ id: 'identity', enabled: true, grants: [] }];
  f.runtime.hasService = name => name === 'identity';
  f.runtime.service = <T>() => ({ async authorize(input: { workspace: string }) { checks++; if (!allowed || input.workspace === '/PRIVATE/OLD') throw new Error('Scope removed'); } }) as T;
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    const discovered = client.callTool({ name: 'capyra_discover', arguments: {} });
    await eventually(() => f.access.pending().length === 1);
    allowed = false; f.access.decide(f.access.pending()[0].id, true, 'client');
    assert.doesNotMatch(JSON.stringify(await discovered), /PRIVATE/); assert.ok(checks >= 2);
    allowed = true;
    const submitted = client.callTool({ name: 'capyra_call', arguments: { tool: 'files_read', args: {} } });
    await eventually(() => f.tasks.size === 1); f.approve('1', 'client'); await submitted;
    f.tasks.get('1')!.workspace = '/PRIVATE/OLD';
    const history = await client.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: '1' } });
    assert.equal(history.isError, true); assert.equal(f.access.pending().length, 0);
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE/);
    const list = await approved(client.callTool({ name: 'capyra_tasks', arguments: { action: 'list' } }), f.access);
    assert.deepEqual(body(list).tasks, []);
    f.runtime.hasService = () => false;
    const unavailable = await client.callTool({ name: 'capyra_discover', arguments: {} });
    assert.equal(unavailable.isError, true); assert.equal(f.access.pending().length, 0);
    f.runtime.config.plugins[0].enabled = false;
    const disabled = await client.callTool({ name: 'capyra_discover', arguments: {} });
    assert.equal(disabled.isError, true); assert.equal(f.access.pending().length, 0);
    assert.doesNotMatch(JSON.stringify(disabled), /PRIVATE/);
  } finally { await client.close(); f.access.close(); }
});

test('resource and prompt callbacks cannot deliver after approval generation is revoked', async () => {
  const f = fixture('compact');
  let release: (() => void) | undefined;
  let invoked = false;
  f.runtime.hasService = name => name === 'mcp.extensions';
  f.runtime.service = <T>() => ({ capabilities: { resources: {}, prompts: {} }, async handle(method: string) {
    invoked = true; await new Promise<void>(done => { release = done; });
    return method === 'resources/read' ? { contents: [{ uri: 'file:///secret', text: 'PRIVATE RESOURCE' }] } : { messages: [{ role: 'user', content: { type: 'text', text: 'PRIVATE PROMPT' } }] };
  } }) as T;
  const client = await connect(f.runtime, 'shared-owner', f.access);
  try {
    const resource = client.readResource({ uri: 'file:///secret' });
    const rejected = assert.rejects(resource, /could not be completed/);
    await eventually(() => f.access.pending().length === 1); f.access.decide(f.access.pending()[0].id, true, 'client');
    await eventually(() => invoked); f.access.cancelOwner('shared-owner'); release!(); await rejected;
    invoked = false;
    const prompt = client.getPrompt({ name: 'secret' });
    const rejectedPrompt = assert.rejects(prompt, /could not be completed/);
    await eventually(() => f.access.pending().length === 1); f.access.decide(f.access.pending()[0].id, true, 'client');
    await eventually(() => invoked); f.access.pause(true); f.access.pause(false); release!(); await rejectedPrompt;
  } finally { await client.close(); f.access.close(); }
});

test('public UI snapshots bypass no identity, pause, revocation or provider lifecycle checks', async () => {
  const f = fixture('compact'); const registry = createMcpExtensions(); const uri = 'ui://fixture/shell.html';
  let handles = 0, checks = 0, allowed = true; let duringAuthorization: (() => void) | undefined;
  const provider = { capabilities: { resources: {} }, owns: (method: string, params: Record<string, unknown>) => method === 'resources/read' && params.uri === uri, async handle() { handles++; return { contents: [{ uri, text: 'DYNAMIC PRIVATE CONTENT' }] }; } };
  let dispose = registry.register('shell', provider, { publicUiTemplates: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Public shell</p>' }] });
  f.runtime.hasService = name => ['identity', 'mcp.extensions'].includes(name);
  f.runtime.service = <T>(name: string) => (name === 'mcp.extensions' ? registry : { async authorize() { checks++; duringAuthorization?.(); if (!allowed) throw new Error('Identity denied'); } }) as T;
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    assert.equal((await client.readResource({ uri })).contents[0]?.text, '<p>Public shell</p>');
    assert.equal(checks, 2); assert.equal(handles, 0); assert.equal(f.access.pending().length, 0);
    allowed = false; await assert.rejects(client.readResource({ uri })); allowed = true;
    f.runtime.isPaused = true; await assert.rejects(client.readResource({ uri })); f.runtime.isPaused = false;
    checks = 0; duringAuthorization = () => { if (checks === 2) f.access.cancelOwner('owner'); };
    await assert.rejects(client.readResource({ uri }));
    checks = 0; duringAuthorization = () => { if (checks === 2) dispose(); };
    await assert.rejects(client.readResource({ uri }));
    duringAuthorization = undefined; assert.equal(handles, 0); assert.equal(f.access.pending().length, 0);
    dispose = registry.register('shell', provider, { publicUiTemplates: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>New shell</p>' }] });
    assert.equal((await client.readResource({ uri })).contents[0]?.text, '<p>New shell</p>');
    assert.equal(handles, 0);
  } finally { dispose(); await client.close(); f.access.close(); }
});

test('optional template diagnostics contain only fixed stages and static fingerprints, including identity rejection', async () => {
  const f = fixture('compact'); const registry = createMcpExtensions(); const uri = 'ui://PRIVATE_TEMPLATE_LOCATION';
  registry.register('shell', { capabilities: { resources: {} }, owns: (_method, params) => params.uri === uri, async handle() { throw Error('PRIVATE HANDLER'); } }, { publicUiTemplates: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>PRIVATE_HTML_MARKER</p>', _meta: { marker: 'PRIVATE_META' } }] });
  let allowed = true;
  f.runtime.hasService = name => ['mcp.extensions', 'identity'].includes(name);
  f.runtime.service = <T>(name: string) => (name === 'mcp.extensions' ? registry : { async authorize() { if (!allowed) throw Error('PRIVATE_IDENTITY_ERROR /PRIVATE/ROOT'); } }) as T;
  const events: McpTemplateDiagnostic[] = [];
  const client = await connect(f.runtime, 'PRIVATE_OWNER', f.access, { onTemplateDiagnostic: event => events.push(event) });
  try {
    await client.readResource({ uri, _meta: { token: 'PRIVATE_REQUEST_META' } });
    assert.deepEqual(events.map(event => event.stage), ['received', 'protocol', 'auth', 'returned', 'closed']);
    assert.equal(new Set(events.map(event => event.requestId)).size, 1);
    const prior = events[0].requestId; events.length = 0; allowed = false;
    await assert.rejects(client.readResource({ uri }));
    assert.notEqual(events[0].requestId, prior); assert.ok(events.some(event => event.reason === 'identity_rejected'));
    assert.equal(events.some(event => event.stage === 'returned'), false); assert.equal(f.access.pending().length, 0);
    const reported = JSON.stringify(events); assert.doesNotMatch(reported, /PRIVATE|ui:\/\/|token|owner|workspace|text|stack/i);
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['requestId', 'stage', 'reason', 'templateBytes', 'templateSha256'].sort());
      assert.match(event.requestId, /^[a-f0-9-]{36}$/); assert.match(event.templateSha256, /^[a-f0-9]{64}$/); assert.equal(event.templateBytes, 26);
    }
    events.length = 0;
    await assert.rejects(client.readResource({ uri: 'ui://PRIVATE_DYNAMIC_LOCATION' })); assert.deepEqual(events, []);
    allowed = true;
    const throwing = await connect(f.runtime, 'owner', f.access, { onTemplateDiagnostic() { throw Error('PRIVATE_DIAGNOSTIC_ERROR'); } });
    try { assert.equal((await throwing.readResource({ uri })).contents.length, 1); } finally { await throwing.close(); }
  } finally { await client.close(); f.access.close(); }
});

test('unapproved catalog errors never expose identity or filesystem exception paths', async () => {
  const f = fixture('direct');
  f.runtime.hasService = name => name === 'identity';
  f.runtime.service = <T>() => ({ async authorize() { throw new Error('ENOENT /PRIVATE/WORKSPACE'); } }) as T;
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    await assert.rejects(client.listTools(), error => { assert.doesNotMatch(String(error), /PRIVATE|ENOENT/); return true; });
    assert.equal(f.access.pending().length, 0);
  } finally { await client.close(); f.access.close(); }
});

test('MCP close releases subscriptions once before connect and across repeated closes', async () => {
  const f = fixture('compact');
  const unopened = createMcpServer(f.runtime, 'owner');
  assert.equal(f.subscriptions(), 1);
  await Promise.all([unopened.close(), unopened.close()]);
  assert.equal(f.subscriptions(), 0);
  await unopened.close(); assert.equal(f.subscriptions(), 0);
  const server = createMcpServer(f.runtime, 'owner');
  const client = new Client({ name: 'lifecycle-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  assert.equal(f.subscriptions(), 1);
  await Promise.all([server.close(), server.close()]); await client.close();
  assert.equal(f.subscriptions(), 0);
});

test('compact client UI descriptors require approval and direct UI calls retain task approval', async () => {
  const f = fixture('compact');
  f.runtime.listTools()[0]._meta = { ui: { resourceUri: 'ui://PRIVATE/card' } };
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    const hidden = await approved(client.listTools(), f.access, 'local');
    assert.equal(hidden.tools.length, 4); assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE/);
    const visible = await approved(client.listTools(), f.access);
    assert.equal(visible.tools.length, 5);
    assert.equal((visible.tools[4]._meta?.ui as { resourceUri: string }).resourceUri, 'ui://PRIVATE/card');
    const pending = client.callTool({ name: 'files_read', arguments: { path: 'secret' } });
    await eventually(() => f.tasks.size === 1); assert.equal(f.tasks.get('1')!.status, 'awaiting_approval');
    f.approve('1', 'client'); assert.match(JSON.stringify(await pending), /PRIVATE RESULT/);
    f.runtime.listTools()[0]._meta = {};
    const unavailable = await client.callTool({ name: 'files_read', arguments: { path: 'secret' } });
    assert.equal(unavailable.isError, true); assert.equal(f.tasks.size, 1);
  } finally { await client.close(); f.access.close(); }
});

test('public static catalog declarations do not authorize calls, discovery, history or undeclared native replacements', async () => {
  const f = fixture('compact'); const tool = f.runtime.listTools()[0];
  tool.description = 'Static product card'; tool.publicCatalog = true;
  tool._meta = { ui: { resourceUri: 'ui://fixture/card' } };
  let tools = [tool]; let instructionReads = 0;
  f.runtime.listTools = () => tools;
  f.runtime.instructions = () => { instructionReads++; return 'PRIVATE INSTRUCTIONS'; };
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 5); assert.equal(f.access.pending().length, 0);
    assert.equal(instructionReads, 0); assert.equal(f.tasks.size, 0);
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE|publicCatalog/);

    const pending = client.callTool({ name: tool.name, arguments: { path: 'secret' } });
    await eventually(() => f.tasks.size === 1);
    assert.equal(f.tasks.get('1')?.status, 'awaiting_approval');
    f.approve('1', 'client'); assert.deepEqual((await pending).content, f.original.content);
    const discovery = await approved(client.callTool({ name: 'capyra_discover', arguments: {} }), f.access, 'local');
    assert.equal(body(discovery).status, 'local_only'); assert.equal(instructionReads, 0);
    const history = await approved(client.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: '1' } }), f.access, 'local');
    assert.equal(body(history).status, 'local_only'); assert.doesNotMatch(JSON.stringify(history), /PRIVATE/);

    // 客户端元数据、插件 ID、同名入口都不能代替插件层的公开声明。
    const external: RegisteredTool = { ...tool, name: 'external__download', pluginId: 'external', publicCatalog: undefined, description: 'PRIVATE EXTERNAL', inputSchema: { type: 'object', properties: { file: { type: 'object' } } }, _meta: { 'openai/fileParams': ['file'], publicCatalog: true } };
    tools = [tool, external];
    const hidden = await approved(client.listTools(), f.access, 'local');
    assert.equal(hidden.tools.length, 5); assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE EXTERNAL/);
    assert.equal((await approved(client.listTools(), f.access)).tools.length, 6);
    tools = [{ ...tool, publicCatalog: undefined, description: 'PRIVATE REPLACEMENT', _meta: { ...tool._meta, publicCatalog: true } }];
    assert.equal((await approved(client.listTools(), f.access, 'local')).tools.length, 4);
    assert.match(JSON.stringify(await approved(client.listTools(), f.access)), /PRIVATE REPLACEMENT/);

    f.runtime.config.exposure = 'direct'; tools = [tool];
    assert.deepEqual((await approved(client.listTools(), f.access, 'local')).tools, []);
    assert.equal((await approved(client.listTools(), f.access)).tools.length, 3);
  } finally { await client.close(); f.access.close(); }
});

test('public static catalog retains identity, pause, generation and current registration checks', async () => {
  const f = fixture('compact'); const tool = f.runtime.listTools()[0];
  tool.description = 'Static product card'; tool.publicCatalog = true;
  tool._meta = { ui: { resourceUri: 'ui://fixture/card' } };
  let tools = [tool], allowed = true, checks = 0; let duringAuthorization: (() => void) | undefined;
  f.runtime.listTools = () => tools;
  f.runtime.hasService = name => name === 'identity';
  f.runtime.service = <T>() => ({ async authorize() { checks++; duringAuthorization?.(); if (!allowed) throw Error('PRIVATE IDENTITY /PRIVATE/ROOT'); } }) as T;
  const client = await connect(f.runtime, 'owner', f.access);
  try {
    assert.equal((await client.listTools()).tools.length, 5); assert.equal(checks, 2);
    allowed = false;
    await assert.rejects(client.listTools(), error => { assert.doesNotMatch(String(error), /PRIVATE/); return true; });
    allowed = true; f.runtime.isPaused = true; await assert.rejects(client.listTools()); f.runtime.isPaused = false;
    checks = 0; duringAuthorization = () => { if (checks === 2) f.access.cancelOwner('owner'); };
    await assert.rejects(client.listTools());
    checks = 0; duringAuthorization = () => { if (checks === 2) tools = [{ ...tool, publicCatalog: undefined, description: 'PRIVATE REPLACEMENT' }]; };
    const replaced = await client.listTools();
    assert.equal(replaced.tools.length, 4); assert.doesNotMatch(JSON.stringify(replaced), /PRIVATE/);
    duringAuthorization = undefined; tools = [tool]; checks = 0;
    duringAuthorization = () => { if (checks === 2) tools = []; };
    assert.equal((await client.listTools()).tools.length, 4);
    duringAuthorization = undefined;
    assert.equal(f.access.pending().length, 0); assert.equal(f.tasks.size, 0);
  } finally { await client.close(); f.access.close(); }
});
