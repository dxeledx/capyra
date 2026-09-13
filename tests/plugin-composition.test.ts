import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { configWriter, loadConfig, resolvePlugin } from '../src/config.js';
import { createRuntime, type ExecutionPolicy, type Runtime } from '../src/core/runtime.js';
import type { TaskStore } from '../src/core/store.js';
import type { CapyraPlugin, PluginContext, RuntimeConfig } from '../src/core/types.js';
import type { startControl } from '../src/transport/control.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
const moduleEntry = (id: string, name: string, enabled = true, config: Record<string, unknown> = {}) => ({ id, module: example(name), enabled, config, grants: [] });
const configuration = (workspace: string, plugins: RuntimeConfig['plugins'], storagePlugin = 'storage'): RuntimeConfig => ({ workspace, stateDir: path.join(workspace, '.capyra'), configPath: path.join(workspace, 'capyra.json'), storagePlugin, plugins, port: 0, controlPort: 0, exposure: 'compact', maxConcurrent: 2, maxTasks: 100 });
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'capyra-composition-'));
  const runtimes: Runtime[] = [];
  t.after(async () => { try { for (const runtime of runtimes.reverse()) await runtime.close(); } finally { await rm(workspace, { recursive: true, force: true }); } });
  return { workspace, own(runtime: Runtime) { runtimes.push(runtime); return runtime; } };
}
async function start(config: RuntimeConfig) { const runtime = await createRuntime(config, resolvePlugin); runtime.setConfigWriter(configWriter(config.configPath!)); await runtime.start(); return runtime; }
async function count(runtime: Runtime, text: string) { const task = await runtime.submit('word-count__count_text', { text }, 'local-console'); await runtime.waitTask(task.id, 2000); const result = runtime.getTask(task.id)!; assert.equal(result.status, 'succeeded', result.error); return result; }

test('a real external SQLite provider imports JSON tasks, persists new results across restart, and releases its database', async t => {
  const { workspace, own } = await temporary(t);
  const config = configuration(workspace, [{ id: 'storage', enabled: true, grants: [] }, moduleEntry('word-count', 'word-count.mjs')]);
  let runtime = own(await start(config));
  const original = await count(runtime, '原有任务 remains available');
  const originalFile = path.join(config.stateDir, 'tasks', `${original.id}.json`);
  const originalBytes = await readFile(originalFile);
  await runtime.close();

  config.storagePlugin = 'sqlite-storage'; config.plugins[0]!.enabled = false;
  config.plugins.push(moduleEntry('sqlite-storage', 'sqlite-storage.mjs', true, { filename: 'daily.sqlite', auditLimit: 100, importJsonTasks: true }));
  await configWriter(config.configPath!)(config);
  runtime = own(await start(await loadConfig(config.configPath!)));
  assert.equal(runtime.listPlugins().find(plugin => plugin.id === 'storage')?.status, 'disabled');
  const store = runtime.service<TaskStore & { status(): { closed: boolean; tasks: number; auditEvents: number; path: string } }>('storage');
  assert.match(store.status().path, /daily\.sqlite$/);
  assert.equal(runtime.getTask(original.id)?.status, 'succeeded');
  const added = await count(runtime, 'stored in SQLite');
  assert.equal(store.status().tasks, 2);
  for (let index = 0; index < 110; index++) store.event({ type: 'composition.audit', at: new Date().toISOString() });
  assert.equal(store.status().auditEvents, 100);
  assert.deepEqual(await readFile(originalFile), originalBytes);
  assert.deepEqual(await readdir(path.join(config.stateDir, 'tasks')), [`${original.id}.json`]);
  await assert.rejects(runtime.setPluginEnabled('sqlite-storage', false), /存储.*不能停用/);
  await Promise.all([runtime.close(), runtime.close()]);
  assert.equal(store.status().closed, true);
  assert.throws(() => store.load(), /closed/);

  runtime = own(await start(await loadConfig(config.configPath!)));
  assert.deepEqual(runtime.getTask(added.id)?.result, added.result);
  assert.equal(runtime.getTask(original.id)?.owner, 'local-console');
  const replacement = runtime.service<typeof store>('storage');
  assert.notEqual(replacement, store);
  assert.equal(replacement.status().closed, false);
  assert.equal(replacement.status().tasks, 2);
});

test('SQLite factory cleanup closes an opened external provider if runtime recovery construction fails', async t => {
  const { workspace } = await temporary(t);
  const entry = moduleEntry('sqlite-storage', 'sqlite-storage.mjs');
  const definition = await resolvePlugin(entry);
  const factory = definition.createStore!;
  let opened: (TaskStore & { status(): { closed: boolean } }) | undefined;
  t.mock.method(definition, 'createStore', (stateDir: string, config: Record<string, unknown>) => { opened = factory(stateDir, config) as typeof opened; return opened!; });
  const config = configuration(workspace, [entry, { ...entry }], 'sqlite-storage');
  await assert.rejects(createRuntime(config, resolvePlugin), /重复插件/);
  assert.equal(opened?.status().closed, true);
  assert.throws(() => opened!.load(), /closed/);
});

test('an external UI replaces real HTTP assets while the same console transport keeps its authenticated API', async t => {
  const { workspace, own } = await temporary(t);
  const config = configuration(workspace, [{ id: 'storage', enabled: true, grants: [] }, { id: 'ui', enabled: true, grants: [] }, { id: 'console', enabled: true, grants: [] }, moduleEntry('word-count', 'word-count.mjs')]);
  const runtime = own(await start(config));
  const transport = runtime.service<{ start: typeof startControl }>('console.transport');
  const control = await transport.start(runtime, config, { pending: () => [], decide() {}, revoke() {} });
  const original = await (await fetch(control.url)).text();
  assert.doesNotMatch(original, /CAPYRA · OBSERVER/);
  const headers = { 'X-Capyra-Local': '1', Origin: control.url, 'Content-Type': 'application/json' };
  const nonce = new URL(control.openUrl).hash.slice('#bootstrap='.length);
  const bootstrap = await fetch(control.url + '/api/bootstrap', { method: 'POST', headers, body: JSON.stringify({ nonce }) });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;

  await runtime.installPlugin(moduleEntry('alternate-ui', 'alternate-ui/plugin.mjs', false));
  await runtime.setPluginEnabled('ui', false);
  await runtime.setPluginEnabled('alternate-ui', true);
  assert.equal(runtime.service('console.transport'), transport);
  assert.match(await (await fetch(control.url)).text(), /CAPYRA · OBSERVER/);
  const javascript = await (await fetch(control.url + '/app.js')).text();
  assert.match(javascript, /\/api\/bootstrap/);
  assert.match(javascript, /credentials: 'same-origin'/);
  assert.doesNotMatch(javascript, /\/approve|\/api\/tools\/call/);
  assert.match(await (await fetch(control.url + '/style.css')).text(), /\.metrics/);
  const task = await count(runtime, 'visible through another UI');
  const state = await fetch(control.url + '/api/state', { headers: { ...headers, Cookie: cookie } });
  assert.equal(state.status, 200);
  const payload = await state.json() as { tasks: { id: string }[]; metrics: { pluginCount: number } };
  assert(payload.tasks.some(item => item.id === task.id));
  assert(payload.metrics.pluginCount >= 3);
  const detail = await fetch(`${control.url}/api/tasks/${task.id}`, { headers: { ...headers, Cookie: cookie } });
  assert.deepEqual((await detail.json() as { result: unknown }).result, task.result);
  assert.equal((await fetch(control.url + '/api/state', { headers })).status, 401);

  const observer = runtime.service<{ snapshot(): { observedEvents: number } }>('alternate-ui.status');
  assert(observer.snapshot().observedEvents > 0);
  await runtime.setPluginEnabled('alternate-ui', false);
  assert.throws(() => observer.snapshot(), /上下文已失效/);
  assert.equal(runtime.hasService('alternate-ui.status'), false);
  await runtime.setPluginEnabled('ui', true);
  assert.equal(await (await fetch(control.url)).text(), original);
  await runtime.setPluginEnabled('console', false);
  await assert.rejects(fetch(control.url + '/health'));
  await assert.rejects(transport.start(runtime, config, { pending: () => [], decide() {}, revoke() {} }), /已停止/);
});

test('external policy replacement narrows real requests, persists configuration, and cannot authorize writes on its own', async t => {
  const { workspace, own } = await temporary(t);
  const config = configuration(workspace, [{ id: 'storage', enabled: true, grants: [] }, { id: 'policy', enabled: true, grants: [] }, { id: 'workspace', enabled: true, grants: ['workspace:read', 'workspace:write'] }]);
  let runtime = own(await start(config));
  const args = { path: 'reviewed.txt', content: 'approved content', expectedMissing: true };
  const pending = await runtime.submit('workspace__write', args, 'local-console');
  assert.equal(pending.status, 'awaiting_approval');
  await runtime.installPlugin(moduleEntry('strict-policy', 'strict-policy.mjs', false));
  await runtime.setPluginEnabled('policy', false);
  await runtime.setPluginEnabled('strict-policy', true);
  await assert.rejects(runtime.submit('workspace__write', { ...args, path: 'denied.txt' }, 'local-console'), /Strict policy blocks write/);
  await runtime.approveTask(pending.id, true); await runtime.waitTask(pending.id, 2000);
  assert.equal(runtime.getTask(pending.id)?.status, 'failed');
  await assert.rejects(readFile(path.join(workspace, 'reviewed.txt')), /ENOENT/);
  const read = await runtime.submit('workspace__list', {}, 'remote-owner');
  assert.equal(read.status, 'awaiting_approval');

  const oldPolicy = runtime.service<ExecutionPolicy>('execution.policy');
  const oldStatus = runtime.service<{ snapshot(): object }>('strict-policy.status');
  await runtime.configurePlugin('strict-policy', { deniedEffects: [], allowedTools: ['workspace__write'] });
  assert.throws(() => oldStatus.snapshot(), /上下文已失效/);
  assert.match(String(await oldPolicy.check(runtime.listTools().find(tool => tool.name === 'workspace__write')!, args, { owner: 'local-console', workspace })), /stopped/);
  await assert.rejects(runtime.submit('workspace__list', {}, 'local-console'), /does not allow/);
  const approved = await runtime.submit('workspace__write', args, 'local-console');
  assert.equal(approved.status, 'awaiting_approval');
  await assert.rejects(readFile(path.join(workspace, 'reviewed.txt')), /ENOENT/);
  await runtime.approveTask(approved.id, true); await runtime.waitTask(approved.id, 2000);
  assert.equal(await readFile(path.join(workspace, 'reviewed.txt'), 'utf8'), 'approved content');
  await runtime.close();
  const persisted = await loadConfig(config.configPath!);
  assert.equal(persisted.plugins.find(plugin => plugin.id === 'policy')?.enabled, false);
  assert.deepEqual(persisted.plugins.find(plugin => plugin.id === 'strict-policy')?.config, { deniedEffects: [], allowedTools: ['workspace__write'] });
  runtime = own(await start(persisted));
  await assert.rejects(runtime.submit('workspace__list', {}, 'local-console'), /does not allow/);
});

test('a dynamically imported external plugin cannot register through a stale context after reload', async t => {
  const { workspace, own } = await temporary(t);
  const modulePath = path.join(workspace, 'lifecycle-fixture.mjs');
  await writeFile(modulePath, `
export const instances = [];
export default {
  apiVersion: 1, id: 'external-lifecycle', version: '1', title: 'External lifecycle', description: 'Fixture', permissions: [],
  setup(ctx) {
    const instance = { ctx, closed: false, events: 0 }; instances.push(instance);
    ctx.onEvent(() => instance.events++);
    ctx.provide('external-lifecycle.instance', instance);
    ctx.registerTool({ name: 'value', title: 'Value', description: 'Read configured value', effect: 'read', permissions: [], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute() { return { content: [{ type: 'text', text: String(ctx.config.value) }] }; } });
    ctx.onDispose(() => { instance.closed = true; });
  }
};
`);
  const config = configuration(workspace, [{ id: 'storage', enabled: true, grants: [] }, { id: 'external-lifecycle', module: modulePath, enabled: true, grants: [], config: { value: 'first' } }]);
  const runtime = own(await start(config));
  const imported = await import(pathToFileURL(modulePath).href) as { instances: { ctx: PluginContext; closed: boolean; events: number }[]; default: CapyraPlugin };
  assert.equal(imported.instances.length, 1);
  const old = imported.instances[0]!;
  await runtime.configurePlugin('external-lifecycle', { value: 'second' });
  assert.equal(old.closed, true); assert.equal(imported.instances.length, 2);
  const before = old.events;
  assert.throws(() => old.ctx.registerTool({ name: 'stale', title: 'Stale', description: '', effect: 'read', permissions: [], inputSchema: { type: 'object' }, async execute() { return { content: [] }; } }), /上下文已失效/);
  assert.throws(() => old.ctx.provide('late.service', {}), /上下文已失效/);
  const task = await runtime.submit('external-lifecycle__value', {}, 'local-console'); await runtime.waitTask(task.id, 2000);
  assert.equal((runtime.getTask(task.id)?.result?.content[0] as { text: string }).text, 'second');
  assert.equal(old.events, before);
  assert.equal(runtime.hasService('late.service'), false);
  assert.deepEqual((await loadConfig(config.configPath!)).plugins.find(plugin => plugin.id === 'external-lifecycle')?.config, { value: 'second' });
});
