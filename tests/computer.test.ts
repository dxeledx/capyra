import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerController, ComputerError } from '../src/computer/controller.js';
import { childResult, createComputerBackend } from '../src/computer/macos.js';
import { COMPUTER_LIMITS, type BackendActionResult, type ComputerBackend, type ComputerStatus, type DesktopAction, type NativeScreenshot } from '../src/computer/types.js';
import { Runtime } from '../src/core/runtime.js';
import type { PluginContext, RuntimeConfig, ToolContext, ToolDefinition } from '../src/core/types.js';
import { defaults, resolvePlugin } from '../src/config.js';
import { createComputerPlugin } from '../src/plugins/computer.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');

class MockBackend implements ComputerBackend {
  screenshots = 0;
  performs = 0;
  disposed = false;
  active = 0;
  maxActive = 0;
  actions: readonly DesktopAction[] = [];
  statusValue: ComputerStatus = { platform: 'darwin', supported: true, backendReady: true, displaySelection: 'primary', screenRecording: 'granted', accessibility: 'granted', message: 'ready' };
  image: NativeScreenshot = { data: png.toString('base64'), mimeType: 'image/png', width: 1000, height: 500, bytes: png.length, displayId: '7', coordinateBounds: { x: 10, y: 20, width: 500, height: 250 } };
  performImpl?: (actions: readonly DesktopAction[], signal: AbortSignal) => Promise<BackendActionResult>;
  screenshotImpl?: (signal: AbortSignal) => Promise<NativeScreenshot>;

  async status(signal: AbortSignal) { signal.throwIfAborted(); return this.statusValue; }
  async screenshot(signal: AbortSignal) {
    this.screenshots++; this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try { return this.screenshotImpl ? await this.screenshotImpl(signal) : this.image; }
    finally { this.active--; }
  }
  async perform(actions: readonly DesktopAction[], _target: unknown, signal: AbortSignal) {
    this.performs++; this.actions = actions;
    return this.performImpl ? this.performImpl(actions, signal) : { completedActions: actions.length };
  }
  async dispose() { this.disposed = true; }
}

async function pluginFixture(t: TestContext, backend = new MockBackend()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-computer-'));
  const tools = new Map<string, ToolDefinition>(), disposers: Array<() => void | Promise<void>> = [];
  const plugin = createComputerPlugin({ backend: () => backend });
  await plugin.setup({
    workspace: root, stateDir: path.join(root, '.capyra'), config: {},
    registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    provide() {}, service() { throw new Error('unused'); }, guard() {}, onEvent() {}, onDispose(dispose) { disposers.push(dispose); },
  } as PluginContext);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); await rm(root, { recursive: true, force: true }); });
  const context = (owner = 'alice', workspace = root, signal = new AbortController().signal, session = owner): ToolContext => ({ owner, workspace, session, signal, taskId: 'task', progress() {} });
  const json = (result: Awaited<ReturnType<ToolDefinition['execute']>>) => JSON.parse((result.content[0] as { text: string }).text);
  return { backend, root, tools, context, json, disposers };
}

test('plugin is default-disabled, declares prepare/read/execute grants, and reports unsupported OS explicitly', async () => {
  const entry = defaults.plugins.find(plugin => plugin.id === 'computer');
  assert.deepEqual(entry, { id: 'computer', enabled: false, grants: [], requestedPermissions: ['computer:prepare', 'computer:read', 'computer:execute'] });
  const plugin = await resolvePlugin(entry!);
  assert.deepEqual(plugin.permissions, ['computer:prepare', 'computer:read', 'computer:execute']);
  const unsupported = createComputerBackend('/unused', 'linux');
  assert.deepEqual(await unsupported.status(new AbortController().signal), {
    platform: 'linux', supported: false, backendReady: false, displaySelection: 'primary', screenRecording: 'unknown', accessibility: 'unknown',
    message: 'Computer Use supports macOS in this release; current platform is linux.',
  });
  await assert.rejects(unsupported.screenshot(new AbortController().signal), /supports macOS/);
});

test('explicit builtin installation learns declared permissions while remaining disabled and ungranted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-computer-install-'));
  const config: RuntimeConfig = { workspace: root, stateDir: path.join(root, '.capyra'), port: 0, controlPort: 0, exposure: 'compact', plugins: [], maxConcurrent: 2, maxTasks: 10 };
  const runtime = new Runtime(config, async () => createComputerPlugin({ backend: () => new MockBackend() }));
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.start();
  await runtime.installPlugin({ id: 'computer', module: 'builtin:computer', enabled: false, grants: [], config: {} });
  const installed = runtime.listPlugins()[0];
  assert.equal(installed.enabled, false); assert.equal(installed.status, 'disabled'); assert.deepEqual(installed.permissions, ['computer:prepare', 'computer:read', 'computer:execute']); assert.deepEqual(installed.grants, []);
  assert.deepEqual(config.plugins[0].requestedPermissions, ['computer:prepare', 'computer:read', 'computer:execute']);
});

test('status and screenshot expose a native image plus explicit Retina coordinate mapping', async t => {
  const f = await pluginFixture(t);
  assert.deepEqual([...f.tools].map(([name, tool]) => [name, tool.effect, tool.permissions, tool.clientCatalog]), [
    ['prepare', 'execute', ['computer:prepare'], true],
    ['status', 'read', ['computer:read'], true],
    ['screenshot', 'read', ['computer:read'], true],
    ['act', 'execute', ['computer:read', 'computer:execute'], true],
  ]);
  assert.match(JSON.stringify(f.tools.get('act')!.inputSchema), /positive scrolls up; negative scrolls down/);
  const status = await f.tools.get('status')!.execute({}, f.context());
  assert.equal(f.json(status).screenRecording, 'granted');
  const screenshot = await f.tools.get('screenshot')!.execute({}, f.context());
  assert.equal(screenshot.content[1]?.type, 'image');
  if (screenshot.content[1]?.type === 'image') assert.equal(screenshot.content[1].data, png.toString('base64'));
  const frame = f.json(screenshot);
  assert.match(frame.screenshotId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(frame.coordinateBounds, { x: 10, y: 20, width: 500, height: 250 });
  assert.match(frame.coordinateMapping.desktopX, /screenshot_x \* 500 \/ 1000/);
});

test('bounded batches map screenshot pixels to desktop coordinates and return a fresh screenshot', async t => {
  const f = await pluginFixture(t);
  const observed = f.json(await f.tools.get('screenshot')!.execute({}, f.context()));
  const result = await f.tools.get('act')!.execute({ screenshotId: observed.screenshotId, actions: [
    { type: 'click', x: 500, y: 250 },
    { type: 'drag', x: 0, y: 0, toX: 999, toY: 499, durationMs: 120 },
    { type: 'scroll', x: 20, y: 30, deltaY: -300 },
    { type: 'type_text', text: '你好 Capyra' },
    { type: 'key', key: 'a', modifiers: ['command'] },
    { type: 'wait', durationMs: 10 },
  ] }, f.context());
  const body = f.json(result);
  assert.equal(result.isError, undefined);
  assert.equal(body.ok, true); assert.equal(body.completedActions, 6); assert.equal(f.backend.performs, 1); assert.equal(f.backend.screenshots, 2);
  assert.deepEqual(f.backend.actions[0], { type: 'click', x: 260, y: 145 });
  assert.deepEqual(f.backend.actions[1], { type: 'drag', x: 10, y: 20, toX: 509.5, toY: 269.5, durationMs: 120 });
  assert.notEqual(body.screenshot.screenshotId, observed.screenshotId);
  assert.equal(result.content[1]?.type, 'image');
});

test('screenshot IDs are caller/session/workspace isolated and stale frames never execute', async t => {
  const f = await pluginFixture(t);
  const first = f.json(await f.tools.get('screenshot')!.execute({}, f.context('alice', f.root)));
  const otherOwner = await f.tools.get('act')!.execute({ screenshotId: first.screenshotId, actions: [{ type: 'click', x: 1, y: 1 }] }, f.context('bob', f.root));
  assert.equal(otherOwner.isError, true); assert.equal(f.json(otherOwner).error.code, 'SCREENSHOT_SCOPE_MISMATCH'); assert.equal(f.backend.performs, 0);
  const otherWorkspace = await f.tools.get('act')!.execute({ screenshotId: first.screenshotId, actions: [{ type: 'click', x: 1, y: 1 }] }, f.context('alice', path.join(f.root, 'other')));
  assert.equal(otherWorkspace.isError, true); assert.equal(f.json(otherWorkspace).error.code, 'SCREENSHOT_SCOPE_MISMATCH'); assert.equal(f.backend.performs, 0);
  const otherSession = await f.tools.get('act')!.execute({ screenshotId: first.screenshotId, actions: [{ type: 'click', x: 1, y: 1 }] }, f.context('alice', f.root, new AbortController().signal, 'another-conversation'));
  assert.equal(otherSession.isError, true); assert.equal(f.json(otherSession).error.code, 'SCREENSHOT_SCOPE_MISMATCH'); assert.equal(f.backend.performs, 0);
  const second = f.json(await f.tools.get('screenshot')!.execute({}, f.context('alice', f.root)));
  const stale = await f.tools.get('act')!.execute({ screenshotId: first.screenshotId, actions: [{ type: 'click', x: 1, y: 1 }] }, f.context('alice', f.root));
  assert.equal(stale.isError, true); assert.equal(f.json(stale).error.code, 'STALE_SCREENSHOT'); assert.equal(f.backend.performs, 0);
  const outside = await f.tools.get('act')!.execute({ screenshotId: second.screenshotId, actions: [{ type: 'click', x: 1000, y: 0 }] }, f.context('alice', f.root));
  assert.equal(outside.isError, true); assert.equal(f.json(outside).error.code, 'COORDINATE_OUT_OF_BOUNDS'); assert.equal(f.backend.performs, 0);
});

test('partial native failure is returned once with the observed post-action screenshot', async t => {
  const backend = new MockBackend();
  backend.performImpl = async () => ({ completedActions: 1, failedAction: 1, error: { code: 'EVENT_FAILED', message: 'The second event failed.' } });
  const f = await pluginFixture(t, backend);
  const frame = f.json(await f.tools.get('screenshot')!.execute({}, f.context()));
  const result = await f.tools.get('act')!.execute({ screenshotId: frame.screenshotId, actions: [{ type: 'click', x: 1, y: 1 }, { type: 'click', x: 2, y: 2 }] }, f.context());
  const body = f.json(result);
  assert.equal(result.isError, true); assert.equal(body.ok, false); assert.equal(body.completedActions, 1); assert.equal(body.failedAction, 1);
  assert.equal(body.error.code, 'EVENT_FAILED'); assert.ok(body.screenshot.screenshotId); assert.equal(backend.performs, 1);
});

test('cancellation preserves partial information, invalidates the frame, and disposal releases the backend', async t => {
  const backend = new MockBackend();
  let entered!: () => void, released = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  backend.performImpl = async (_actions, signal) => new Promise((_resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => { released = true; reject(new ComputerError('CANCELLED', 'cancelled after one action', 1, 1)); }, { once: true });
  });
  const controller = new ComputerController(backend), signal = new AbortController();
  const frame = await controller.screenshot({ owner: 'alice', workspace: '/workspace' }, signal.signal);
  const acting = controller.act({ owner: 'alice', workspace: '/workspace' }, frame.frame.screenshotId, [{ type: 'click', x: 1, y: 1 }, { type: 'click', x: 2, y: 2 }], true, signal.signal);
  await started; signal.abort();
  const result = await acting;
  assert.equal(result.ok, false); assert.equal(result.completedActions, 1); assert.equal(result.failedAction, 1); assert.equal(released, true); assert.equal(backend.screenshots, 1);
  await assert.rejects(controller.act({ owner: 'alice', workspace: '/workspace' }, frame.frame.screenshotId, [{ type: 'click', x: 1, y: 1 }], false, new AbortController().signal), /stale/i);
  await controller.dispose(); assert.equal(backend.disposed, true);
});

test('timeout keeps the completion count unknown and never retries the native batch', async t => {
  const backend = new MockBackend();
  backend.performImpl = async () => { throw new ComputerError('NATIVE_TIMEOUT', 'timed out with unknown partial execution'); };
  const controller = new ComputerController(backend);
  t.after(() => controller.dispose());
  const signal = new AbortController().signal, frame = await controller.screenshot({ owner: 'alice', workspace: '/workspace' }, signal);
  const result = await controller.act({ owner: 'alice', workspace: '/workspace' }, frame.frame.screenshotId, [{ type: 'click', x: 1, y: 1 }], false, signal);
  assert.equal(result.ok, false); assert.equal(result.completedActions, null); assert.equal(result.error?.code, 'NATIVE_TIMEOUT'); assert.equal(backend.performs, 1);
});

function fakeChild(options: { stdinError?: boolean } = {}) {
  const child: any = new EventEmitter(), stdin: any = new EventEmitter();
  const kills: string[] = [];
  let writes = 0, destroyed = false, closed = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = stdin; child.exitCode = null; child.signalCode = null;
  const close = (signal: string) => {
    if (closed) return; closed = true; child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
  };
  child.kill = (signal: string) => { kills.push(signal); close(signal); return true; };
  stdin.end = () => {
    writes++;
    if (options.stdinError) queueMicrotask(() => stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' })));
  };
  stdin.destroy = () => { destroyed = true; };
  return { child, kills, writes: () => writes, destroyed: () => destroyed };
}

test('bounded child collection consumes EPIPE and never writes an already-aborted request', async () => {
  const broken = fakeChild({ stdinError: true });
  await assert.rejects(childResult(broken.child, Buffer.from('request'), new AbortController().signal, 1000, 1000), (error: unknown) => error instanceof ComputerError && error.code === 'NATIVE_INPUT_FAILED');
  assert.equal(broken.writes(), 1); assert.deepEqual(broken.kills, ['SIGTERM']);

  const cancelled = fakeChild(), controller = new AbortController(); controller.abort();
  await assert.rejects(childResult(cancelled.child, Buffer.from('request'), controller.signal, 1000, 1000), (error: unknown) => error instanceof ComputerError && error.code === 'CANCELLED');
  assert.equal(cancelled.writes(), 0); assert.equal(cancelled.destroyed(), true); assert.deepEqual(cancelled.kills, ['SIGTERM']);
});

test('physical desktop access is serialized across concurrent callers', async t => {
  const backend = new MockBackend();
  backend.screenshotImpl = async signal => { await delay(20, undefined, { signal }); return backend.image; };
  const controller = new ComputerController(backend);
  t.after(() => controller.dispose());
  await Promise.all([
    controller.screenshot({ owner: 'alice', workspace: '/a' }, new AbortController().signal),
    controller.screenshot({ owner: 'bob', workspace: '/b' }, new AbortController().signal),
  ]);
  assert.equal(backend.maxActive, 1);
});

test('runtime JSON schemas reject malformed and oversized batches before backend access', async t => {
  const backend = new MockBackend(), plugin = createComputerPlugin({ backend: () => backend });
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-computer-runtime-'));
  const config: RuntimeConfig = {
    workspace: root, stateDir: path.join(root, '.capyra'), port: 0, controlPort: 0, exposure: 'direct', approvalMode: 'auto', autoResultVisibility: 'client',
    plugins: [{ id: 'computer', enabled: true, grants: ['computer:prepare', 'computer:read', 'computer:execute'] }], maxConcurrent: 2, maxTasks: 100,
  };
  const runtime = new Runtime(config, async () => plugin);
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.start();
  const goodId = '00000000-0000-4000-8000-000000000000';
  const invalid = [
    { screenshotId: 'bad', actions: [{ type: 'click', x: 1, y: 1 }] },
    { screenshotId: goodId, actions: [] },
    { screenshotId: goodId, actions: [{ type: 'wait', durationMs: 2001 }] },
    { screenshotId: goodId, actions: [{ type: 'click', x: 1, y: 1, unexpected: true }] },
    { screenshotId: goodId, actions: Array.from({ length: 25 }, () => ({ type: 'click', x: 1, y: 1 })) },
    { screenshotId: goodId, actions: [{ type: 'key', key: 'a', modifiers: ['command', 'command'] }] },
  ];
  for (const args of invalid) await assert.rejects(runtime.submit('computer__act', args, 'remote-owner'), /参数无效/);
  assert.equal(runtime.listTasks().length, 0); assert.equal(backend.performs, 0); assert.equal(backend.screenshots, 0);
});

test('aggregate wait, text, and screenshot payload caps fail before native input dispatch', async t => {
  const backend = new MockBackend(), f = await pluginFixture(t, backend);
  const frame = f.json(await f.tools.get('screenshot')!.execute({}, f.context()));
  const waits = await f.tools.get('act')!.execute({ screenshotId: frame.screenshotId, actions: Array.from({ length: 6 }, () => ({ type: 'wait', durationMs: 2000 })) }, f.context());
  assert.equal(waits.isError, true); assert.equal(f.json(waits).error.code, 'BATCH_DELAY_TOO_LARGE'); assert.equal(backend.performs, 0);
  const texts = await f.tools.get('act')!.execute({ screenshotId: frame.screenshotId, actions: Array.from({ length: 3 }, () => ({ type: 'type_text', text: 'x'.repeat(3000) })) }, f.context());
  assert.equal(texts.isError, true); assert.equal(f.json(texts).error.code, 'BATCH_TEXT_TOO_LARGE'); assert.equal(backend.performs, 0);
  backend.image = { ...backend.image, data: Buffer.alloc(1_200_001).toString('base64'), bytes: 1_200_001 };
  const oversized = await f.tools.get('screenshot')!.execute({}, f.context());
  assert.equal(oversized.isError, true); assert.equal(f.json(oversized).error.code, 'SCREENSHOT_TOO_LARGE');
  assert.equal(Math.ceil(COMPUTER_LIMITS.maxScreenshotBytes / 3) * 4, 1_600_000);
});
