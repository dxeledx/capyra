import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Runtime } from '../src/core/runtime.js';
import type { RuntimeConfig } from '../src/core/types.js';
import { createComputerPlugin } from '../src/plugins/computer.js';
import type { ComputerBackend, DesktopAction, NativeScreenshot } from '../src/computer/types.js';
import { createAccessController } from '../src/transport/access.js';
import { createMcpServer } from '../src/transport/mcp.js';

// Synthetic one-pixel PNG. No test reads a display, starts a native helper or posts input.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a4L8AAAAASUVORK5CYII=';
async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await delay(5);
  assert.ok(check(), 'Expected test state was not reached');
}
async function fixture(t: TestContext, exposure: 'compact' | 'direct' = 'compact') {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-desktop-mcp-'));
  const seen: DesktopAction[][] = [];
  let captures = 0, disposed = false;
  const backend: ComputerBackend = {
    async status() { return { platform: 'fixture', supported: true, backendReady: true, displaySelection: 'primary', screenRecording: 'granted', accessibility: 'granted', message: 'Mock desktop' }; },
    async screenshot(): Promise<NativeScreenshot> { captures++; return { data: png, mimeType: 'image/png', width: 1, height: 1, bytes: Buffer.from(png, 'base64').length, displayId: 'synthetic', coordinateBounds: { x: 0, y: 0, width: 1440, height: 900 } }; },
    async perform(actions) { seen.push([...actions]); return { completedActions: actions.length }; },
    async dispose() { disposed = true; },
  };
  const config: RuntimeConfig = { workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, exposure, approvalMode: 'ask', autoResultVisibility: 'client', maxTasks: 50, maxConcurrent: 2, plugins: [{ id: 'computer', enabled: true, grants: ['computer:prepare', 'computer:read', 'computer:execute'] }] };
  const runtime = new Runtime(config, async () => createComputerPlugin({ backend: () => backend }));
  const access = createAccessController(3000), clients: Client[] = [];
  await runtime.start();
  t.after(async () => { for (const client of clients) await client.close(); access.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); assert.equal(disposed, true); });
  async function connect(owner = 'oauth:desktop-a') {
    const client = new Client({ name: 'desktop-integration-test', version: '1' });
    const server = createMcpServer(runtime, owner, { access, approvalTimeoutMs: 3000 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); clients.push(client); return client;
  }
  function request(client: Client, tool: string, args: Record<string, unknown> = {}) {
    return client.callTool(exposure === 'compact' ? { name: 'capyra_call', arguments: { tool, args } } : { name: tool, arguments: args });
  }
  async function approved(client: Client, tool: string, args: Record<string, unknown> = {}, visibility: 'client' | 'local' = 'client') {
    const before = new Set(runtime.listTasks().map(task => task.id));
    const pending = request(client, tool, args);
    await eventually(() => runtime.listTasks().some(task => !before.has(task.id) && task.status === 'awaiting_approval'));
    const task = runtime.listTasks().find(task => !before.has(task.id))!;
    await runtime.approveTask(task.id, true, visibility);
    return { result: await pending, taskId: task.id };
  }
  async function grantAccess<T>(pending: Promise<T>) {
    await eventually(() => access.pending().length > 0);
    access.decide(access.pending()[0].id, true, 'client'); return pending;
  }
  return { runtime, access, connect, request, approved, grantAccess, seen, captures: () => captures };
}

for (const exposure of ['compact', 'direct'] as const) {
  test(`${exposure} MCP: screenshot -> action -> refreshed native image retains metadata and approval`, async t => {
    const f = await fixture(t, exposure), client = await f.connect();
    const before = f.request(client, 'computer__screenshot');
    await eventually(() => f.runtime.listTasks().some(task => task.status === 'awaiting_approval'));
    assert.equal(f.captures(), 0, 'No screen read before approval');
    const task = f.runtime.listTasks()[0];
    await f.runtime.approveTask(task.id, true, 'client');
    const first = await before;
    assert.equal(first.isError, undefined);
    assert.deepEqual((first.content as any[]).find(item => item.type === 'image'), { type: 'image', data: png, mimeType: 'image/png' });
    const frame = first.structuredContent as any;
    assert.equal(frame.width, 1); assert.equal(frame.coordinateMapping.input, 'screenshot_pixels');
    const action = { screenshotId: frame.screenshotId, actions: [{ type: 'click', x: 0, y: 0 }] };
    const changed = (await f.approved(client, 'computer__act', action)).result;
    assert.equal((changed.structuredContent as any).completedActions, 1);
    assert.notEqual((changed.structuredContent as any).screenshot.screenshotId, frame.screenshotId);
    assert.equal((changed.content as any[]).filter(item => item.type === 'image').length, 1);
    assert.equal(f.captures(), 2); assert.equal(f.seen.length, 1);
    const repeated = (await f.approved(client, 'computer__act', action)).result;
    assert.equal(repeated.isError, true);
    assert.equal((repeated.structuredContent as any).error.code, 'STALE_SCREENSHOT');
    assert.equal(f.seen.length, 1, 'Stale coordinates never replay a mutation');
  });
}

test('compact discovery exposes real desktop schemas only after access approval', async t => {
  const f = await fixture(t), client = await f.connect();
  const response = await f.grantAccess(client.callTool({ name: 'capyra_discover', arguments: { query: 'computer' } }));
  const catalog = JSON.parse((response.content as any[])[0].text);
  for (const name of ['computer__prepare', 'computer__status', 'computer__screenshot', 'computer__act']) assert.ok(catalog.tools.some((tool: any) => tool.name === name));
  const action = catalog.tools.find((tool: any) => tool.name === 'computer__act');
  assert.deepEqual(action.inputSchema.required, ['screenshotId', 'actions']);
  assert.equal(action._meta['capyra/approval'], 'always');
  assert.equal(action.outputSchema.type, 'object');
  assert.equal(f.captures(), 0); assert.equal(f.seen.length, 0);
});

test('local-only screenshot remains private on freshly approved history retrieval', async t => {
  const f = await fixture(t), client = await f.connect();
  const completed = await f.approved(client, 'computer__screenshot', {}, 'local');
  const receipt = JSON.parse((completed.result.content as any[])[0].text);
  assert.equal(receipt.taskId, completed.taskId); assert.equal(receipt.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(completed.result), /screenshotId|iVBOR|coordinateBounds/);
  const history = await f.grantAccess(client.callTool({ name: 'capyra_tasks', arguments: { action: 'get', id: completed.taskId } }));
  assert.doesNotMatch(JSON.stringify(history), /screenshotId|iVBOR|coordinateBounds/);
  assert.equal(f.captures(), 1);
});

test('another OAuth caller cannot consume the first caller screenshot', async t => {
  const f = await fixture(t), alice = await f.connect(), bob = await f.connect('oauth:desktop-b');
  const first = (await f.approved(alice, 'computer__screenshot')).result;
  const frame = first.structuredContent as any;
  const stolen = (await f.approved(bob, 'computer__act', { screenshotId: frame.screenshotId, actions: [{ type: 'key', key: 'a' }] })).result;
  assert.equal(stolen.isError, true);
  assert.equal((stolen.structuredContent as any).error.code, 'SCREENSHOT_SCOPE_MISMATCH');
  assert.equal(f.seen.length, 0);
  const own = (await f.approved(alice, 'computer__act', { screenshotId: frame.screenshotId, actions: [{ type: 'wait', durationMs: 0 }] })).result;
  assert.equal((own.structuredContent as any).ok, true);
});

test('denied desktop request does not capture or dispatch inputs', async t => {
  const f = await fixture(t), client = await f.connect();
  const pending = f.request(client, 'computer__screenshot');
  await eventually(() => f.runtime.listTasks().some(task => task.status === 'awaiting_approval'));
  const task = f.runtime.listTasks()[0];
  await f.runtime.approveTask(task.id, false);
  const result = await pending;
  assert.equal(JSON.parse((result.content as any[])[0].text).status, 'denied');
  assert.equal(f.captures(), 0); assert.equal(f.seen.length, 0);
});
