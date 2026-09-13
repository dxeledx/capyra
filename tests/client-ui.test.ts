import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Runtime } from '../src/core/runtime.js';
import type { CapyraPlugin, RuntimeConfig } from '../src/core/types.js';
import { createAccessController, type AccessController } from '../src/transport/access.js';
import { createMcpServer } from '../src/transport/mcp.js';
import git from '../src/plugins/git.js';
import projects from '../src/plugins/projects.js';
import clientUi from '../src/plugins/client-ui.js';
import workspacePlugin from '../src/plugins/workspace.js';
import { CARD_URI, CARD_MIME } from '../src/client-ui/cards.js';
import { createMcpExtensions, type McpExtensionRegistry } from '../src/client-ui/extensions.js';

const exec = promisify(execFile);
async function eventually(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await delay(10); assert.ok(check()); }
async function approved<T>(promise: Promise<T>, access: AccessController, visibility: 'client' | 'local' = 'client') {
  await eventually(() => access.pending().length > 0); access.decide(access.pending()[0]!.id, true, visibility); return promise;
}
async function fixture(t: TestContext, exposure: 'direct' | 'compact' = 'direct', extraPlugins: CapyraPlugin[] = []) {
  const folder = await mkdtemp(path.join(tmpdir(), 'capyra-client-ui-')); const workspace = path.join(folder, 'project'); await mkdir(workspace);
  const command = async (...args: string[]) => (await exec('git', args, { cwd: workspace })).stdout;
  await command('init', '-q'); await command('config', 'user.name', 'Capyra Test'); await command('config', 'user.email', 'test@example.test');
  await writeFile(path.join(workspace, 'note.txt'), 'initial\n'); await command('add', '.'); await command('commit', '-qm', 'Initial');
  const mcp: CapyraPlugin = { apiVersion: 1, id: 'mcp', version: '1', title: 'MCP fixture', description: '', permissions: [], setup(ctx) { ctx.provide('mcp.extensions', createMcpExtensions()); } };
  const skills: CapyraPlugin = { apiVersion: 1, id: 'skills', version: '1', title: 'Skills fixture', description: '', permissions: [], setup(ctx) { ctx.provide('skills', { async discover() { return { rules: [{ path: 'AGENTS.md', scope: '.', name: 'AGENTS.md' }], skills: [], diagnostics: [] }; } }); } };
  const definitions = [mcp, git, projects, skills, clientUi, ...extraPlugins];
  const config: RuntimeConfig = { workspace, stateDir: path.join(folder, 'state'), port: 0, controlPort: 0, exposure, plugins: definitions.map(plugin => ({ id: plugin.id, enabled: true, grants: plugin.permissions })), maxConcurrent: 2, maxTasks: 100 };
  const runtime = new Runtime(config, async entry => definitions.find(plugin => plugin.id === entry.id)!); await runtime.start();
  assert.equal(runtime.listPlugins().find(plugin => plugin.id === 'client-ui')?.status, 'ready');
  const clients: Client[] = []; const access = createAccessController(2000);
  async function connect(owner: string) {
    const server = createMcpServer(runtime, owner, { access, approvalTimeoutMs: 5000 });
    const client = new Client({ name: 'client-ui-sdk-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); clients.push(client); return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}, visibility: 'client' | 'local' = 'client') {
    const before = new Set(runtime.listTasks().map(task => task.id));
    const pending = client.callTool({ name, arguments: args });
    await eventually(() => runtime.listTasks().some(task => !before.has(task.id) && task.status === 'awaiting_approval'));
    const task = runtime.listTasks().find(task => !before.has(task.id))!;
    await runtime.approveTask(task.id, true, visibility);
    return await pending;
  }
  t.after(async () => { await Promise.all(clients.map(client => client.close())); access.close(); await runtime.close(); await rm(folder, { recursive: true, force: true }); });
  return { workspace, folder, runtime, access, connect, call, command };
}

test('SDK reads the registered public UI shell without approval while catalogs and workspace data require separate approval', async t => {
  const f = await fixture(t); const client = await f.connect('alice');
  const catalog = await approved(client.listTools(), f.access);
  const descriptor = catalog.tools.find(tool => tool.name === 'client-ui__workspace')!;
  assert.equal((descriptor._meta?.ui as any).resourceUri, CARD_URI);
  assert.equal(descriptor._meta?.['openai/outputTemplate'], CARD_URI);
  for (const tool of catalog.tools.filter(tool => tool.name.startsWith('client-ui__'))) {
    assert.equal((tool._meta?.ui as any).resourceUri, CARD_URI); assert.equal(tool._meta?.['openai/outputTemplate'], CARD_URI);
  }
  const resources = await approved(client.listResources(), f.access); assert.equal(resources.resources[0]?.uri, CARD_URI);
  const resource = await client.readResource({ uri: CARD_URI });
  assert.equal(f.access.pending().length, 0); assert.equal(f.runtime.listTasks().length, 0);
  assert.deepEqual(await client.readResource({ uri: CARD_URI }), resource);
  assert.equal(resource.contents[0]?.mimeType, CARD_MIME);
  assert.doesNotMatch(JSON.stringify(resource), /frozen <script>|capyra-client-ui-|fetch\(|\/api\//);
  assert.deepEqual((resource.contents[0]?._meta?.ui as any).csp, { connectDomains: [], resourceDomains: [], frameDomains: [] });
  assert.deepEqual(resource.contents[0]?._meta?.['openai/widgetCSP'], { connect_domains: [], resource_domains: [], frame_domains: [] });
  // 安全域声明交给宿主执行；产品 HTML 不叠加另一层可能阻断宿主运行时的 CSP。
  assert.doesNotMatch(String(resource.contents[0]?.text), /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy/i);
  assert.doesNotMatch(String(resource.contents[0]?.text), /<(?:script|link|iframe)\b[^>]*(?:src|href)\s*=/i);
  const wrong = client.readResource({ uri: 'file:///etc/passwd' }); const rejected = assert.rejects(wrong); await approved(Promise.resolve(), f.access); await rejected;
  const workspace = await f.call(client, 'client-ui__workspace');
  assert.equal((workspace.structuredContent as any).root, await realpath(f.workspace));
  assert.equal((workspace.structuredContent as any).rules[0].path, 'AGENTS.md');
  assert.equal(f.runtime.listTasks().length, 1);
  assert.deepEqual(await client.readResource({ uri: CARD_URI }), resource);
});

test('only explicitly registered snapshots bypass approval, not dynamic HTML with the same MIME or client metadata', async t => {
  const f = await fixture(t); const client = await f.connect('alice');
  const registry = f.runtime.service<McpExtensionRegistry>('mcp.extensions'); let reads = 0;
  const uri = 'ui://capyra/dynamic.html';
  registry.register('dynamic-html', { capabilities: { resources: {} }, owns: (method, params) => method === 'resources/read' && params.uri === uri, async handle() { reads++; return { contents: [{ uri, mimeType: CARD_MIME, text: 'PRIVATE DYNAMIC CONTENT' }] }; } });
  const withheld = client.readResource({ uri, _meta: { publicUiTemplate: true } }); const rejected = assert.rejects(withheld);
  await eventually(() => f.access.pending().length === 1); assert.equal(reads, 0);
  f.access.decide(f.access.pending()[0]!.id, true, 'local'); await rejected; assert.equal(reads, 0);
  const allowed = await approved(client.readResource({ uri }), f.access);
  assert.equal(allowed.contents[0]?.text, 'PRIVATE DYNAMIC CONTENT'); assert.equal(reads, 1);
});

test('public UI registration freezes values, rejects conflicts atomically and withdraws on disposal', () => {
  const registry = createMcpExtensions(); const uri = 'ui://fixture/shell.html'; let reads = 0;
  const provider = { capabilities: { resources: {} }, owns: (method: string, params: Record<string, unknown>) => method === 'resources/read' && params.uri === uri, async handle() { reads++; return { contents: [] }; } };
  const template = { uri, mimeType: CARD_MIME, text: '<p>Static shell</p>', _meta: { ui: { csp: { connectDomains: [] as string[] } } } };
  const dispose = registry.register('shell', provider, { publicUiTemplates: [template] });
  template.text = 'changed later'; template._meta.ui.csp.connectDomains.push('https://later.invalid');
  const frozen = registry.publicUiTemplates!.get(uri)!;
  assert.equal(frozen.text, '<p>Static shell</p>'); assert.deepEqual((frozen._meta?.ui as any).csp.connectDomains, []);
  assert.throws(() => ((frozen._meta?.ui as any).csp.connectDomains.push('https://mutation.invalid')), TypeError);
  (registry.publicUiTemplates as Map<string, unknown>).clear(); assert.equal(registry.publicUiTemplates!.get(uri), frozen);
  assert.throws(() => registry.register('collision', provider), /conflicts/);
  assert.throws(() => registry.register('collision', provider, { publicUiTemplates: [template] }), /conflicts/);
  assert.equal(registry.publicUiTemplates!.get(uri), frozen); assert.equal(reads, 0);
  dispose(); assert.equal(registry.publicUiTemplates!.size, 0);
  const replacement = registry.register('shell', provider, { publicUiTemplates: [template] }); dispose();
  assert.equal(registry.publicUiTemplates!.get(uri)?.text, 'changed later'); replacement();
  registry.register('dynamic-first', provider);
  assert.throws(() => registry.register('late-shell', provider, { publicUiTemplates: [template] }), /conflicts/);
  assert.equal(registry.publicUiTemplates!.size, 0);
});

test('review cards reopen immutable snapshots with owner, workspace and per-request visibility protection', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob');
  await f.call(alice, 'client-ui__workspace');
  await writeFile(path.join(f.workspace, 'note.txt'), 'frozen <script>unsafe()</script>\n');
  const initial = await f.call(alice, 'client-ui__changes'); const card = initial.structuredContent as any;
  assert.match(card.files[0].patch, /frozen/); assert.equal(card.summary.additions, 1); assert.equal(card.summary.removals, 1);
  assert.equal(JSON.parse((initial.content as any[])[0].text).reviewRef, card.reviewRef);
  assert.equal('owner' in card, false); assert.equal('workspace' in card, false);
  await writeFile(path.join(f.workspace, 'note.txt'), 'later\n');
  await f.runtime.setPluginEnabled('client-ui', false); await f.runtime.setPluginEnabled('client-ui', true);
  const args = { reviewRef: card.reviewRef, workspaceId: card.workspaceId };
  const restored = await f.call(alice, 'client-ui__review', args);
  assert.deepEqual(restored.structuredContent, initial.structuredContent);
  const other = await f.call(bob, 'client-ui__review', args); assert.equal(JSON.parse((other.content as any[])[0].text).status, 'failed'); assert.doesNotMatch(JSON.stringify(other), /frozen|later/);
  const wrongWorkspace = await f.call(alice, 'client-ui__review', { ...args, workspaceId: 'a'.repeat(64) }); assert.equal(JSON.parse((wrongWorkspace.content as any[])[0].text).status, 'failed'); assert.doesNotMatch(JSON.stringify(wrongWorkspace), /frozen/);
  const localOnly = await f.call(alice, 'client-ui__review', args, 'local'); assert.equal(localOnly.structuredContent, undefined); assert.doesNotMatch(JSON.stringify(localOnly), /frozen/);
  const malicious = await alice.callTool({ name: 'client-ui__review', arguments: { ...args, owner: 'bob' } }); assert.equal(malicious.isError, true);
});

test('unloading the client UI removes tools and resource registration while another extension remains usable', async t => {
  const f = await fixture(t); const client = await f.connect('alice');
  const registry = f.runtime.service<McpExtensionRegistry>('mcp.extensions');
  const dispose = registry.register('external', { capabilities: { resources: {} }, owns: (method, params) => method === 'resources/read' && params.uri === 'test://external', async handle(method) { return method === 'resources/list' ? { resources: [{ name: 'external', uri: 'test://external' }] } : method === 'resources/templates/list' ? { resourceTemplates: [] } : { contents: [{ uri: 'test://external', text: 'external result', mimeType: 'text/plain' }] }; } });
  await f.runtime.setPluginEnabled('client-ui', false);
  assert.equal(registry.publicUiTemplates!.has(CARD_URI), false);
  assert.equal(f.runtime.listTools().some(tool => tool.pluginId === 'client-ui'), false);
  const list = await approved(client.listResources(), f.access); assert.deepEqual(list.resources.map(resource => resource.uri), ['test://external']);
  assert.equal((await approved(client.readResource({ uri: 'test://external' }), f.access)).contents[0]?.text, 'external result');
  const removed = client.readResource({ uri: CARD_URI }); const rejected = assert.rejects(removed); await approved(Promise.resolve(), f.access); await rejected;
  dispose(); assert.deepEqual(registry.capabilities, {});
});

test('extension registry aggregates pages, rejects collisions and invalidates in-flight unloaded providers', async () => {
  const registry = createMcpExtensions(); const context = { owner: 'alice', signal: new AbortController().signal };
  let release: (value: Record<string, unknown>) => void = () => {};
  const dispose = registry.register('one', { capabilities: { resources: {} }, owns: (_method, params) => params.uri === 'test://one', async handle(method, params) {
    if (method === 'resources/list') return params.cursor ? { resources: [{ uri: 'test://two', name: 'two' }] } : { resources: [{ uri: 'test://one', name: 'one' }], nextCursor: 'next' };
    return new Promise(resolve => { release = resolve; });
  } });
  assert.equal(((await registry.handle('resources/list', {}, context)).resources as any[]).length, 2);
  const pending = registry.handle('resources/read', { uri: 'test://one' }, context); dispose();
  release({ contents: [{ uri: 'test://one', text: 'secret' }] }); await assert.rejects(pending, /unloaded/);
  registry.register('collision-a', { capabilities: { resources: {} }, owns: () => true, async handle() { return { resources: [{ uri: 'same:', name: 'one' }] }; } });
  registry.register('collision-b', { capabilities: { resources: {} }, owns: () => true, async handle() { return { resources: [{ uri: 'same:', name: 'two' }] }; } });
  await assert.rejects(registry.handle('resources/list', {}, context), /duplicate/);
  await assert.rejects(registry.handle('resources/read', { uri: 'same:' }, context), /ambiguous/);
});

test('public static catalog exposes all eight built-in compact tools while workspace data still needs exact approval', async t => {
  const f = await fixture(t, 'compact', [workspacePlugin]); const client = await f.connect('alice');
  const catalog = await client.listTools();
  assert.equal(f.access.pending().length, 0); assert.equal(f.runtime.listTasks().length, 0);
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), ['capyra_discover', 'capyra_call', 'capyra_tasks', 'capyra_cancel', 'client-ui__workspace', 'client-ui__changes', 'client-ui__review', 'workspace__download_artifact'].sort());
  assert.doesNotMatch(JSON.stringify(catalog), /capyra-client-ui-|AGENTS\.md|initial|publicCatalog/);
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'workspace__download_artifact')?._meta?.['openai/fileParams'], ['file']);
  assert.ok(catalog.tools.some(tool => tool.name === 'client-ui__workspace' && (tool._meta?.ui as any)?.resourceUri === CARD_URI));
  assert.equal(catalog.tools.some(tool => tool.name === 'git__diff'), false);
  await f.call(client, 'client-ui__workspace');
  await writeFile(path.join(f.workspace, 'note.txt'), 'compact review\n');
  const result = await f.call(client, 'client-ui__changes');
  assert.equal((result.structuredContent as any).kind, 'review');
});
