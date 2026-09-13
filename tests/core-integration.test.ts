import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../src/core/runtime.js';
import { configWriter, loadConfig } from '../src/config.js';
import type { CapyraPlugin, RuntimeConfig } from '../src/core/types.js';
import { textResult } from '../src/sdk.js';

const settings = (workspace: string, plugins: RuntimeConfig['plugins']): RuntimeConfig => ({ workspace, stateDir: join(workspace, '.capyra'), plugins, port: 0, controlPort: 0, exposure: 'compact', maxTasks: 10, maxConcurrent: 2 });
const definition = (setup: CapyraPlugin['setup']): CapyraPlugin => ({ apiVersion: 1, id: 'fixture', title: 'Fixture', version: '1', description: '', permissions: [], setup });

test('remote reads defer all file-sensitive preview work and cannot share pending approvals', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-read-'));
  let previews = 0, executed = 0;
  const runtime = new Runtime(settings(workspace, [{ id: 'fixture', enabled: true, grants: [] }]), async () => definition(ctx => ctx.registerTool({
    name: 'read', title: 'Read', description: '', inputSchema: { type: 'object' }, effect: 'read', permissions: [],
    async preview() { previews++; return { title: 'Private content', description: 'Only visible locally' }; },
    async execute() { executed++; return textResult('private'); },
  })));
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start();
  const [first, second] = await Promise.all([runtime.submit('fixture__read', {}, 'oauth:shared'), runtime.submit('fixture__read', {}, 'oauth:shared')]);
  assert.notEqual(first.id, second.id); assert.equal(previews, 0); assert.equal(executed, 0);
  assert.equal(first.status, 'awaiting_approval'); assert.equal(first.resultVisibility, 'local');
  await runtime.preparePreview(first.id); assert.equal(previews, 1);
  await runtime.approveTask(first.id, true, 'client'); await runtime.waitTask(first.id, 1000);
  assert.equal(executed, 1); assert.equal(runtime.getTask(second.id)?.status, 'awaiting_approval');
});

test('workspace snapshots remain stable after project selection changes', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-root-'));
  const other = join(workspace, 'other'); await mkdir(other);
  let current = workspace;
  const runtime = new Runtime(settings(workspace, [{ id: 'fixture', enabled: true, grants: [] }]), async () => definition(ctx => {
    ctx.provide('projects', { current: () => ({ path: current }) });
    ctx.registerTool({ name: 'read', title: 'Read', description: '', inputSchema: { type: 'object' }, effect: 'read', permissions: [], async execute(_args, execution) { return textResult({ workspace: execution.workspace, owner: execution.owner }); } });
  }));
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start(); const task = await runtime.submit('fixture__read', {}, 'remote:owner'); current = other;
  await runtime.approveTask(task.id, true); await runtime.waitTask(task.id, 1000);
  assert.equal(runtime.getTask(task.id)?.workspace, workspace);
  assert.deepEqual(JSON.parse((runtime.getTask(task.id)?.result?.content[0] as { text: string }).text), { workspace, owner: 'remote:owner' });
});

test('parallel asynchronous admission cannot exceed the queue or outlive shutdown', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-queue-'));
  const runtime = new Runtime(settings(workspace, [{ id: 'fixture', enabled: true, grants: [] }]), async () => definition(ctx => ctx.registerTool({ name: 'read', title: 'Read', description: '', inputSchema: { type: 'object' }, effect: 'read', permissions: [], async execute() { return textResult('done'); } })));
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start(); const submissions = await Promise.allSettled(Array.from({ length: 30 }, () => runtime.submit('fixture__read', {}, 'remote')));
  assert.equal(submissions.filter(value => value.status === 'fulfilled').length, 10);
  assert.equal(runtime.listTasks().length, 10); await runtime.close();
  await assert.rejects(runtime.submit('fixture__read', {}, 'remote'), /暂停/);
});

test('preview reentrancy is single-flight and disposal waits for preparation cleanup', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-preview-'));
  let release!: () => void, started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  let previews = 0, disposed = false, usedAfterDispose = false;
  const runtime = new Runtime(settings(workspace, [{ id: 'fixture', enabled: true, grants: [] }]), async () => definition(ctx => {
    ctx.onDispose(() => { disposed = true; });
    ctx.registerTool({ name: 'read', title: 'Read', description: '', inputSchema: { type: 'object' }, effect: 'read', permissions: [],
      async preview(_args, execution) { previews++; execution.progress('Preparing'); started(); await gate; usedAfterDispose ||= disposed; return { title: 'Preview', description: '' }; }, async execute() { return textResult('done'); } });
  }));
  t.after(async () => { release(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start(); const task = await runtime.submit('fixture__read', {}, 'remote');
  const off = runtime.onEvent(event => { if (event.taskId === task.id && runtime.getTask(task.id)?.progress === 'Preparing') void runtime.preparePreview(task.id); });
  const preparation = runtime.preparePreview(task.id); await active; const disable = runtime.setPluginEnabled('fixture', false);
  await delay(10); assert.equal(disposed, false); release(); await preparation; await disable; off();
  assert.equal(previews, 1); assert.equal(usedAfterDispose, false); assert.equal(disposed, true);
});

test('control configuration writes preserve unknown settings and survive restart', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-config-')); const path = join(workspace, 'capyra.json');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = settings(workspace, [{ id: 'fixture', enabled: false, grants: [], config: { answer: 42 } }]);
  const write = configWriter(path); await write(config);
  const loaded = await loadConfig(path);
  assert.equal(loaded.plugins[0].config?.answer, 42);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
  await Promise.all([write({ ...config, exposure: 'direct' }), write({ ...config, exposure: 'compact' })]);
  assert.equal((await loadConfig(path)).exposure, 'compact');
});

test('a failed live configuration restores the previous service, grants and persisted restart state', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-rollback-'));
  const path = join(workspace, 'capyra.json');
  const config = settings(workspace, [{ id: 'fixture', enabled: true, grants: ['original'], config: { value: 'working' } }]);
  let active = 0;
  const resolver = async () => definition(ctx => {
    active++; ctx.onDispose(() => { active--; });
    ctx.provide('configured-service', { value: ctx.config.value });
    if (ctx.config.value === 'invalid') throw new Error('candidate rejected');
  });
  const runtime = new Runtime(config, resolver);
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  const write = configWriter(path); runtime.setConfigWriter(write);
  await runtime.start(); await write(config);
  await assert.rejects(runtime.configurePlugin('fixture', { value: 'invalid' }, ['replacement']), /已恢复旧配置.*candidate rejected/);
  assert.equal(active, 1);
  assert.equal(runtime.service<{ value: string }>('configured-service').value, 'working');
  assert.equal(runtime.listPlugins()[0].status, 'ready');
  assert.deepEqual((await loadConfig(path)).plugins[0], { id: 'fixture', enabled: true, grants: ['original'], config: { value: 'working' } });
  await runtime.close(); assert.equal(active, 0);
  const restarted = new Runtime(await loadConfig(path), resolver);
  try { await restarted.start(); assert.equal(restarted.service<{ value: string }>('configured-service').value, 'working'); }
  finally { await restarted.close(); }
});

test('concurrent live configuration changes serialize activation and retain the newest successful value', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-reconfigure-'));
  let active = 0, maximum = 0;
  const runtime = new Runtime(settings(workspace, [{ id: 'fixture', enabled: true, grants: [], config: { value: 0 } }]), async () => definition(async ctx => {
    active++; maximum = Math.max(maximum, active); ctx.onDispose(() => { active--; });
    await delay(10); ctx.provide('configured-service', { value: ctx.config.value });
  }));
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start();
  await Promise.all([runtime.configurePlugin('fixture', { value: 1 }), runtime.configurePlugin('fixture', { value: 2 })]);
  assert.equal(maximum, 1); assert.equal(active, 1);
  assert.equal(runtime.service<{ value: number }>('configured-service').value, 2);
});

test('disabling configured identity pauses remote admission while local tools remain usable', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-core-identity-'));
  const config = settings(workspace, [{ id: 'fixture', enabled: true, grants: [] }, { id: 'identity', enabled: true, grants: [] }]);
  const runtime = new Runtime(config, async entry => entry.id === 'identity'
    ? { ...definition(ctx => ctx.provide('identity', { async authorize() {} })), id: 'identity' }
    : definition(ctx => ctx.registerTool({ name: 'read', title: 'Read', description: '', inputSchema: { type: 'object' }, effect: 'read', permissions: [], async execute() { return textResult('local fixture'); } })));
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await runtime.start();
  await runtime.setPluginEnabled('identity', false);
  await assert.rejects(runtime.submit('fixture__read', {}, 'remote'), /身份服务不可用/);
  const local = await runtime.submit('fixture__read', {}, 'local-console');
  await runtime.waitTask(local.id, 1000); assert.equal(runtime.getTask(local.id)?.status, 'succeeded');
  await runtime.setPluginEnabled('identity', true);
  assert.equal((await runtime.submit('fixture__read', {}, 'remote')).status, 'awaiting_approval');
});
