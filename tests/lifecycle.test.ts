import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/core/runtime.js';
import { DiskTaskStore, type TaskStore } from '../src/core/store.js';
import type { CapyraPlugin, RuntimeConfig, TaskRecord } from '../src/core/types.js';

function config(workspace: string, plugins: RuntimeConfig['plugins'] = []): RuntimeConfig {
  return { workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, exposure: 'direct', plugins, maxConcurrent: 2, maxTasks: 10 };
}
function memoryStore(): TaskStore { return { load: () => [], save() {}, remove() {}, event() {} }; }

test('stdio CLI exits and releases its workspace lock when stdin closes during startup', { timeout: 25_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-stdio-lifecycle-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'start', '--stdio', '--workspace', workspace, '--control-port', '0', '--port', '0'], {
    cwd: dirname(dirname(cli)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-20_000); });
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-20_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // EOF 必须早于控制台监听完成，以覆盖启动期间丢失 end 事件的竞态。
    child.stdin.end();
    const result = await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`CLI survived early stdin EOF. stderr: ${stderr}`)), 15_000);
    })]);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null);
    assert.equal(stdout, '', 'stdio stdout must remain reserved for MCP messages');
    await assert.rejects(access(join(workspace, '.capyra', 'runtime.lock')), { code: 'ENOENT' });
    const events = (await readFile(join(workspace, '.capyra', 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1)?.type, 'runtime.stopped');
  } finally {
    clearTimeout(deadline);
    // 断言失败也必须回收子进程，不能让测试占着本机端口或工作区锁。
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      try { await exited; } catch {} finally { clearTimeout(force); }
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test('shutdown disposes consumers before providers even when configuration order is reversed', async () => {
  const order: string[] = [];
  const resource = { closed: false };
  let consumerSawClosedProvider: boolean | undefined;
  const provider: CapyraPlugin = {
    apiVersion: 1, id: 'provider', version: '1', title: 'Provider', description: '', permissions: [],
    setup(context) {
      context.provide('shared-resource', resource);
      context.onDispose(() => { resource.closed = true; order.push('provider'); });
    },
  };
  const consumer: CapyraPlugin = {
    apiVersion: 1, id: 'consumer', version: '1', title: 'Consumer', description: '', permissions: [], requires: ['provider'],
    setup(context) {
      const shared = context.service<typeof resource>('shared-resource');
      context.onDispose(() => { consumerSawClosedProvider = shared.closed; order.push('consumer'); });
    },
  };
  const runtime = new Runtime(config(tmpdir(), [{ id: 'consumer', enabled: true, grants: [] }, { id: 'provider', enabled: true, grants: [] }]), async entry => entry.id === 'consumer' ? consumer : provider, memoryStore());
  try {
    await runtime.start();
    assert.ok(runtime.listPlugins().every(plugin => plugin.status === 'ready'));
    await runtime.close();
    assert.deepEqual(order, ['consumer', 'provider']);
    assert.equal(consumerSawClosedProvider, false);
    assert.equal(resource.closed, true);
  } finally { await runtime.close(); }
});

test('a malformed but parseable task record cannot prevent valid records from recovering', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-store-lifecycle-'));
  let runtime: Runtime | undefined;
  try {
    const settings = config(workspace);
    const store = new DiskTaskStore(settings.stateDir);
    const now = new Date().toISOString();
    const valid: TaskRecord = { id: '11111111-1111-1111-1111-111111111111', owner: 'owner', tool: 'fixture__edit', pluginId: 'fixture', effect: 'write', status: 'awaiting_approval', args: { value: 1 }, inputHash: 'hash', createdAt: now, updatedAt: now };
    store.save(valid);
    const missingDate = { ...valid, id: '22222222-2222-2222-2222-222222222222', createdAt: undefined };
    const invalidDate = { ...valid, id: '33333333-3333-3333-3333-333333333333', createdAt: 'invalid' };
    for (const record of [missingDate, invalidDate]) await writeFile(join(settings.stateDir, 'tasks', `${record.id}.json`), JSON.stringify(record));
    assert.deepEqual(store.load().map(task => task.id), [valid.id]);
    let loads = 0;
    runtime = new Runtime(settings, async () => { loads++; throw new Error('No plugin should load'); }, store);
    await runtime.start();
    assert.equal(runtime.getTask(valid.id)?.status, 'interrupted');
    assert.equal(loads, 0);
    await assert.rejects(runtime.approveTask(valid.id, true));
    assert.equal(JSON.parse(await readFile(join(settings.stateDir, 'tasks', `${valid.id}.json`), 'utf8')).status, 'interrupted');
  } finally { await runtime?.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('shutdown cancels active work and disposes plugins even when task and audit storage fail', async () => {
  let failStorage = false;
  let started!: () => void;
  const executionStarted = new Promise<void>(resolve => { started = resolve; });
  let observedAbort = false;
  let executionStopped = false;
  let disposed = false;
  let disposedAfterExecution: boolean | undefined;
  const store: TaskStore = { load: () => [], remove() {}, save() { if (failStorage) throw new Error('ENOSPC'); }, event() { if (failStorage) throw new Error('ENOSPC'); } };
  const plugin: CapyraPlugin = {
    apiVersion: 1, id: 'fixture', version: '1', title: 'Fixture', description: '', permissions: [],
    setup(context) {
      context.onDispose(() => { disposedAfterExecution = executionStopped; disposed = true; });
      context.registerTool({ name: 'waiting', title: 'Wait', description: '', effect: 'read', permissions: [], inputSchema: { type: 'object' },
        async execute(_args, ctx) {
          await new Promise<void>(resolve => {
            ctx.signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true });
            started();
          });
          executionStopped = true;
          return { content: [{ type: 'text', text: 'stopped' }] };
        },
      });
      context.registerTool({ name: 'pending', title: 'Pending edit', description: '', effect: 'write', permissions: [], inputSchema: { type: 'object' }, async execute() { throw new Error('Unapproved mutation executed'); } });
    },
  };
  const runtime = new Runtime(config(tmpdir(), [{ id: 'fixture', enabled: true, grants: [] }]), async () => plugin, store);
  try {
    await runtime.start();
    const active = await runtime.submit('fixture__waiting', {}, 'local-console');
    await executionStarted;
    const pending = await runtime.submit('fixture__pending', {}, 'owner');
    assert.equal(pending.status, 'awaiting_approval');
    failStorage = true;
    await runtime.close();
    assert.equal(observedAbort, true);
    assert.equal(executionStopped, true);
    assert.equal(disposed, true);
    assert.equal(disposedAfterExecution, true);
    assert.equal(runtime.listTools().length, 0);
    assert.equal(runtime.getTask(pending.id)?.status, 'cancelled');
    assert.notEqual(runtime.getTask(active.id)?.status, 'succeeded');
  } finally { await runtime.close(); }
});
