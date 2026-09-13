import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../src/core/runtime.js';
import type { CapyraPlugin, PluginContext, RuntimeConfig, ToolDefinition } from '../src/core/types.js';
import { textResult } from '../src/sdk.js';
import type { TaskStore } from '../src/core/store.js';

const schema = { type: 'object' as const, properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name: 'change', title: 'Change', description: 'Test capability', effect: 'write', permissions: ['test:write'], inputSchema: schema, async execute(args) { return textResult(args); }, ...overrides };
}
function plugin(setup: CapyraPlugin['setup']): CapyraPlugin {
  return { apiVersion: 1, id: 'test', version: '1', title: 'Test', description: 'test', permissions: ['test:write'], setup };
}
async function fixture(t: TestContext, definition: CapyraPlugin, enabled = true) {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-runtime-'));
  const config: RuntimeConfig = { workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, exposure: 'direct', plugins: [{ id: 'test', enabled, grants: ['test:write'] }], maxConcurrent: 2, maxTasks: 100 };
  let loads = 0;
  const resolver = async () => { loads++; return definition; };
  const runtime = new Runtime(config, resolver);
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start(); return { runtime, config, resolver, loads: () => loads };
}
async function settled(runtime: Runtime, id: string) {
  for (let i = 0; i < 100; i++) {
    const task = runtime.getTask(id)!;
    if (['succeeded', 'failed', 'cancelled', 'denied', 'interrupted'].includes(task.status)) return task;
    await delay(5);
  }
  throw new Error('task did not settle');
}

test('local approval freezes exact arguments, deduplicates pending mutations and cannot be consumed twice', async t => {
  const executed: unknown[] = [];
  const { runtime } = await fixture(t, plugin(ctx => ctx.registerTool(tool({ async execute(args) { assert(Object.isFrozen(args)); executed.push(args); return textResult(args); } }))));
  const input = { value: 1 };
  const task = await runtime.submit('test__change', input, 'local-console'); input.value = 99;
  assert.equal(task.status, 'awaiting_approval'); assert.equal(executed.length, 0);
  assert.equal((await runtime.submit('test__change', { value: 1 }, 'local-console')).id, task.id);
  assert.equal(runtime.getTask(task.id, 'bob'), undefined);
  await assert.rejects(runtime.cancelTask(task.id, 'bob'), /不存在/);
  await runtime.approveTask(task.id, true);
  await assert.rejects(runtime.approveTask(task.id, true));
  assert.equal((await settled(runtime, task.id)).status, 'succeeded');
  assert.deepEqual(executed, [{ value: 1 }]);
});

test('schema rejects invalid arguments before creating a task; policy denials do not execute', async t => {
  const { runtime } = await fixture(t, plugin(ctx => {
    ctx.registerTool(tool()); ctx.guard((_tool, args) => args.value === 2 ? 'blocked' : undefined);
  }));
  await assert.rejects(runtime.submit('test__change', { value: '1' }, 'alice'), /参数无效/);
  await assert.rejects(runtime.submit('test__change', { value: 2 }, 'alice'), /blocked/);
  assert.equal(runtime.listTasks().length, 0);
});

test('mutations form a scheduling barrier even when read concurrency is greater than one', async t => {
  let active = 0; let max = 0;
  const { runtime } = await fixture(t, plugin(ctx => ctx.registerTool(tool({ async execute() { active++; max = Math.max(max, active); await delay(20); active--; return textResult('done'); } }))));
  const first = await runtime.submit('test__change', { value: 1 }, 'a');
  const second = await runtime.submit('test__change', { value: 2 }, 'a');
  await runtime.approveTask(first.id, true); await runtime.approveTask(second.id, true);
  await settled(runtime, second.id); assert.equal(max, 1);
});

test('tool replacement invalidates previously approved identity rather than calling new code', async t => {
  let context: PluginContext; let remove: () => void; let count = 0;
  const { runtime } = await fixture(t, plugin(ctx => { context = ctx; remove = ctx.registerTool(tool()); }));
  const task = await runtime.submit('test__change', { value: 1 }, 'a');
  remove!(); context!.registerTool(tool({ async execute() { count++; return textResult('new'); } }));
  await runtime.approveTask(task.id, true);
  assert.equal((await settled(runtime, task.id)).status, 'failed'); assert.equal(count, 0);
});

test('disabled plugins are not imported; unload removes services, tools and the old registration context', async t => {
  let context: PluginContext;
  const { runtime, loads } = await fixture(t, plugin(ctx => { context = ctx; ctx.provide('service', {}); ctx.registerTool(tool()); }), false);
  assert.equal(loads(), 0); await runtime.setPluginEnabled('test', true); assert.equal(loads(), 1);
  await runtime.setPluginEnabled('test', false);
  assert.equal(runtime.listTools().length, 0);
  assert.throws(() => context!.registerTool(tool()), /失效/);
  assert.throws(() => context!.provide('late', {}), /失效/);
  await runtime.setPluginEnabled('test', true); assert.equal(runtime.listTools().length, 1);
});

test('startup-bound service owners reject changes before disposal or persistence, while shutdown still releases them', async t => {
  let disposed = 0, writes = 0;
  const service = { listening: true };
  const { runtime, config, loads } = await fixture(t, plugin(ctx => {
    ctx.provide('test.transport', service); ctx.onDispose(() => { disposed++; service.listening = false; });
  }));
  runtime.setConfigWriter(async () => { writes++; });
  runtime.requireRestartForPluginChanges(['mcp', 'console'], id => `${id} 更改需重启`, ['test.transport']);
  const previous = structuredClone(config.plugins);
  for (const enabled of [false, true]) await assert.rejects(runtime.setPluginEnabled('test', enabled), /test 更改需重启/);
  await assert.rejects(runtime.configurePlugin('test', { changed: true }, []), /test 更改需重启/);
  assert.equal(runtime.listPlugins()[0].restartRequired, true); assert.equal(runtime.listPlugins()[0].restartReason, 'test 更改需重启');
  assert.equal(runtime.service('test.transport'), service); assert.equal(service.listening, true);
  assert.equal(disposed, 0); assert.equal(writes, 0); assert.equal(loads(), 1); assert.deepEqual(config.plugins, previous);
  await runtime.close(); assert.equal(disposed, 1); assert.equal(service.listening, false);
});

test('startup-bound disabled adapters cannot be hot-enabled or configured before their next startup', async t => {
  const { runtime, config, loads } = await fixture(t, plugin(ctx => ctx.provide('test.transport', {})), false);
  runtime.requireRestartForPluginChanges(['test'], () => '更改需重启'); const previous = structuredClone(config.plugins);
  await assert.rejects(runtime.setPluginEnabled('test', true), /更改需重启/);
  await assert.rejects(runtime.configurePlugin('test', { changed: true }), /更改需重启/);
  assert.equal(loads(), 0); assert.deepEqual(config.plugins, previous); assert.equal(runtime.listPlugins()[0].status, 'disabled');
});

test('schema identifiers are isolated across plugin generations; draft 2020 tuple constraints are validated', async t => {
  const tuple = tool({ inputSchema: { type: 'object', $id: 'urn:capyra:test', $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { values: { type: 'array', prefixItems: [{ type: 'integer' }], items: false } }, required: ['values'] } });
  const { runtime } = await fixture(t, plugin(ctx => ctx.registerTool(tuple)));
  await assert.rejects(runtime.submit('test__change', { values: ['bad'] }, 'a'), /参数无效/);
  await runtime.setPluginEnabled('test', false); await runtime.setPluginEnabled('test', true);
  assert.equal(runtime.listPlugins()[0].status, 'ready');
  assert.equal((await runtime.submit('test__change', { values: [1] }, 'a')).status, 'awaiting_approval');
});

test('approval cancellation during async preview cannot requeue a cancelled mutation', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const { runtime } = await fixture(t, plugin(ctx => ctx.registerTool(tool({ async preview() { await gate; return { title: 'test', description: '' }; }, async execute() { calls++; return textResult('done'); } }))));
  const submission = runtime.submit('test__change', { value: 1 }, 'local-console');
  await delay(1); const id = runtime.listTasks()[0].id; await runtime.cancelTask(id); release();
  assert.equal((await submission).status, 'cancelled'); assert.equal(calls, 0);
});

test('cancel waits for cooperative execution to stop and never records success', async t => {
  const { runtime } = await fixture(t, plugin(ctx => ctx.registerTool(tool({ effect: 'read', permissions: [], async execute(_args, context) { await delay(1000, undefined, { signal: context.signal }); return textResult('done'); } }))));
  const task = await runtime.submit('test__change', { value: 1 }, 'a');
  await runtime.cancelTask(task.id);
  assert.equal((await settled(runtime, task.id)).status, 'cancelled');
});

test('restart retains results and marks unfinished persisted actions interrupted without replay', async t => {
  let executions = 0;
  const definition = plugin(ctx => ctx.registerTool(tool({ async execute() { executions++; return textResult('done'); } })));
  const { runtime, config, resolver } = await fixture(t, definition);
  const task = await runtime.submit('test__change', { value: 1 }, 'a');
  const file = join(config.stateDir, 'tasks', `${task.id}.json`);
  const preCrash = await readFile(file, 'utf8'); await runtime.close(); await writeFile(file, preCrash);
  const next = new Runtime(config, resolver); await next.start();
  try { assert.equal(next.getTask(task.id)?.status, 'interrupted'); await assert.rejects(next.approveTask(task.id, true)); assert.equal(executions, 0); }
  finally { await next.close(); }
});

test('failed activation rolls back partial registrations', async t => {
  const { runtime } = await fixture(t, plugin(ctx => { ctx.registerTool(tool({ name: 'read', effect: 'read', permissions: [] })); throw new Error('activation failed'); }));
  assert.equal(runtime.listPlugins()[0].status, 'error'); assert.equal(runtime.listTools().length, 0);
});

test('reentrant observers cannot exceed concurrency when a task starts', async t => {
  let active = 0; let max = 0; let reentered = false;
  const { runtime, config } = await fixture(t, plugin(ctx => ctx.registerTool(tool({ effect: 'read', permissions: [], async execute() { active++; max = Math.max(max, active); await delay(20); active--; return textResult('done'); } }))));
  config.maxConcurrent = 1;
  runtime.onEvent(event => { if (event.type === 'task.running' && !reentered) { reentered = true; void runtime.submit('test__change', { value: 2 }, 'local-console'); } });
  await runtime.submit('test__change', { value: 1 }, 'local-console');
  await delay(100); assert.equal(max, 1); assert.equal(runtime.listTasks().length, 2);
});

test('failure to persist running state prevents all side effects and pauses admission', async t => {
  let calls = 0;
  const { config } = await fixture(t, plugin(() => {}));
  const store: TaskStore = { load: () => [], remove() {}, event() {}, save(task) { if (task.status === 'running') throw new Error('ENOSPC'); } };
  const runtime = new Runtime(config, async () => plugin(ctx => ctx.registerTool(tool({ async execute() { calls++; return textResult('unexpected'); } }))), store);
  await runtime.start();
  try {
    const pending = await runtime.submit('test__change', { value: 1 }, 'a');
    await assert.rejects(runtime.approveTask(pending.id, true), /ENOSPC/);
    await delay(10); assert.equal(calls, 0); assert.equal(runtime.metrics().paused, true);
    await assert.rejects(runtime.submit('test__change', { value: 2 }, 'a'), /暂停/);
  } finally { await runtime.close(); }
});
