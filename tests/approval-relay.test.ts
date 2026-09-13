import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Runtime } from '../src/core/runtime.js';
import type { CapyraPlugin, TaskRecord } from '../src/core/types.js';
import { createAccessController } from '../src/transport/access.js';
import { canonicalApproval, createApprovalRelay, type RelayIdentity } from '../src/identity/approval-relay.js';
import type { ApprovalBinding } from '../src/identity/client.js';
import type { MobileApprovalDecision, MobileApprovalRequest } from '../src/identity/mobile-approvals.js';
import type { ApprovalRelayStatus, IdentityStatus } from '../src/identity/types.js';

async function fixture(t: TestContext, options: { intervalMs?: number; now?: () => number } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-approval-relay-'));
  let executions = 0, previews = 0, syncs = 0;
  const plugin: CapyraPlugin = { apiVersion: 1, id: 'fixture', version: '1', title: 'Fixture', description: '', permissions: [], setup(context) {
    context.registerTool({ name: 'command', title: 'Run command', description: '', effect: 'execute', permissions: [], inputSchema: { type: 'object', properties: { command: { type: 'string' }, content: { type: 'string' } }, required: ['command'], additionalProperties: false },
      async preview(args) { previews++; return { title: 'Command', description: String(args.command) }; },
      async execute() { executions++; return { content: [{ type: 'text', text: 'private result' }] }; },
    });
  } };
  const runtime = new Runtime({ workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, exposure: 'compact', plugins: [{ id: 'fixture', enabled: true, grants: [] }], maxConcurrent: 2, maxTasks: 200 }, async () => plugin);
  await runtime.start();
  const access = createAccessController(60_000);
  const binding: ApprovalBinding = { deviceId: 'device-1', ownerId: 'account-1', version: 1, generation: 0, cloudUrl: 'https://accounts.example/capyra' };
  let active = true;
  let snapshots: MobileApprovalRequest[][] = [];
  let decisions: MobileApprovalDecision[] = [];
  let handler: ((requests: MobileApprovalRequest[], signal?: AbortSignal) => Promise<void>) | undefined;
  let relayStatus: ApprovalRelayStatus | undefined;
  const listeners = new Set<(status: IdentityStatus) => void>();
  const identity: RelayIdentity = {
    status: () => ({ configured: true, cloudUrl: binding.cloudUrl, active, approvalRelay: relayStatus }),
    approvalBinding: () => active ? structuredClone(binding) : undefined,
    onBindingChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setApprovalRelayStatus(value) { relayStatus = structuredClone(value); },
    async syncApprovals(requests, options) {
      syncs++; snapshots.push(structuredClone(requests)); await handler?.(requests, options?.signal);
      const reply = { deviceId: binding.deviceId, version: binding.version, decisions: structuredClone(decisions) }; decisions = []; return reply;
    },
  };
  let provider: RelayIdentity | undefined = identity;
  const relay = createApprovalRelay({ runtime, access, identity: () => provider, intervalMs: options.intervalMs ?? 0, now: options.now });
  t.after(async () => { relay.close(); access.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  return { workspace, runtime, access, relay, identity, binding,
    executions: () => executions, previews: () => previews, syncs: () => syncs, snapshots: () => snapshots,
    decide(request: MobileApprovalRequest, approve = true, visibility: 'local' | 'client' = 'local') { decisions.push({ id: request.id, kind: request.kind, digest: request.digest, approve, visibility }); },
    reply(items: MobileApprovalDecision[]) { decisions = items; },
    handle(value?: typeof handler) { handler = value; },
    changeBinding(update: Partial<ApprovalBinding>) { Object.assign(binding, update); for (const listener of listeners) listener(identity.status()); },
    disable() { active = false; for (const listener of listeners) listener(identity.status()); provider = undefined; },
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('mobile approval uses the original runtime approval once, defers previews, and keeps local-only results local', async t => {
  const f = await fixture(t);
  const task = await f.runtime.submit('fixture__command', { command: 'printf test', content: 'exact complete content' }, 'oauth:caller-a');
  assert.equal(f.previews(), 0);
  await f.relay.syncNow();
  const request = f.snapshots().at(-1)![0];
  assert.equal(request.kind, 'task');
  assert.notEqual(request.id, task.id);
  const details = request.details as { originalRequestId: string; request: TaskRecord; previewState: string };
  assert.equal(details.originalRequestId, task.id); assert.deepEqual(details.request.args, task.args);
  assert.equal(details.request.owner, 'oauth:caller-a'); assert.equal(details.request.workspace, f.workspace);
  assert.equal(details.previewState, 'not_prepared'); assert.equal(f.previews(), 0);
  f.decide(request, true, 'local'); await f.relay.syncNow(); await f.runtime.waitTask(task.id, 1000);
  assert.equal(f.executions(), 1); assert.equal(f.previews(), 1);
  assert.equal(f.runtime.getTask(task.id)!.resultVisibility, 'local');
  f.decide(request, true, 'client'); await f.relay.syncNow();
  assert.equal(f.executions(), 1); assert.equal(f.runtime.getTask(task.id)!.resultVisibility, 'local');
  assert.deepEqual(f.snapshots().at(-1), []);
  assert.equal(f.identity.status().approvalRelay!.approvalUrl, 'https://accounts.example/capyra/approve');
  assert.equal(f.runtime.listTools().length, 1, 'relay does not register any MCP approval capability');
});

test('access requests preserve owner, generation and exact parameters, while wrong digest/kind decisions are ignored', async t => {
  const f = await fixture(t);
  const result = f.access.request({ owner: 'oauth:shared-client', method: 'capyra_tasks', workspace: f.workspace, description: '查看一条历史结果', args: { action: 'get', id: 'history-1' } });
  await f.relay.syncNow(); const request = f.snapshots().at(-1)![0];
  assert.deepEqual((request.details as any).request.args, { action: 'get', id: 'history-1' });
  assert.equal((request.details as any).request.owner, 'oauth:shared-client');
  f.reply([{ id: request.id, kind: 'access', digest: '0'.repeat(64), approve: true, visibility: 'client' }, { id: request.id, kind: 'task', digest: request.digest, approve: true, visibility: 'client' }]);
  await f.relay.syncNow(); assert.equal(f.access.pending().length, 1);
  f.decide(request, true, 'client'); await f.relay.syncNow();
  assert.deepEqual(await result, { allowed: true, visibility: 'client' });
});

test('a local decision wins while cloud sync is in flight and later snapshots remove the request', async t => {
  const f = await fixture(t);
  const result = f.access.request({ owner: 'owner-a', method: 'resources/read', workspace: f.workspace, description: 'Read resource', args: { uri: 'private:test' } });
  await f.relay.syncNow(); const request = f.snapshots().at(-1)![0]; const original = f.access.pending()[0];
  const gate = deferred(), entered = deferred();
  f.handle(async () => { entered.resolve(); await gate.promise; }); f.decide(request, true, 'client');
  const sync = f.relay.syncNow(); await entered.promise;
  f.access.decide(original.id, false); gate.resolve(); await sync;
  assert.equal((await result).allowed, false);
  f.handle(); await f.relay.syncNow(); assert.deepEqual(f.snapshots().at(-1), []);
});

test('preview changes require a new frozen cloud request and old decisions never migrate to new details', async t => {
  const f = await fixture(t);
  const task = await f.runtime.submit('fixture__command', { command: 'printf unchanged' }, 'owner-a');
  await f.relay.syncNow(); const old = f.snapshots().at(-1)![0];
  await f.runtime.preparePreview(task.id);
  f.decide(old, true, 'client'); await f.relay.syncNow();
  const next = f.snapshots().at(-1)![0];
  assert.notEqual(next.id, old.id); assert.notEqual(next.digest, old.digest);
  assert.equal(f.executions(), 0); assert.equal(f.runtime.getTask(task.id)!.status, 'awaiting_approval');
  f.decide(next, true); await f.relay.syncNow(); await f.runtime.waitTask(task.id, 1000); assert.equal(f.executions(), 1);
});

test('binding changes, pause, plugin removal and relay close invalidate delayed cloud decisions', async t => {
  for (const action of ['binding', 'pause', 'disable', 'close'] as const) {
    const f = await fixture(t);
    const result = f.access.request({ owner: 'owner-a', method: 'tools/list', workspace: f.workspace, description: 'Read catalog', args: {} });
    await f.relay.syncNow(); const request = f.snapshots().at(-1)![0];
    const entered = deferred(), gate = deferred(); let signal: AbortSignal | undefined;
    f.handle(async (_requests, current) => { signal = current; entered.resolve(); await gate.promise; }); f.decide(request, true, 'client');
    const sync = f.relay.syncNow(); await entered.promise;
    if (action === 'binding') { f.changeBinding({ generation: 1, deviceId: 'device-2', cloudUrl: 'https://new-account.example/capyra' }); assert.equal(f.relay.status().approvalUrl, 'https://new-account.example/capyra/approve'); }
    if (action === 'pause') { f.access.pause(true); await f.runtime.pause(true); }
    if (action === 'disable') f.disable();
    if (action === 'close') f.relay.close();
    assert.equal(signal!.aborted, true, action);
    gate.resolve(); await sync;
    f.access.close(); assert.equal((await result).allowed, false, action);
    const before = f.syncs(); f.handle();
    if (action !== 'binding') { await f.relay.syncNow(); assert.equal(f.syncs(), before, action); }
  }
});

test('oversized command/body and bounded snapshot overflow remain local with explicit reasons and no truncation', async t => {
  const f = await fixture(t);
  const huge = await f.runtime.submit('fixture__command', { command: 'printf exact', content: '敏感完整内容'.repeat(6000) }, 'owner-a');
  for (let i = 0; i < 10; i++) await f.runtime.submit('fixture__command', { command: `command-${i}`, content: 'x'.repeat(30_000) }, 'owner-a');
  await f.relay.syncNow();
  const sent = f.snapshots().at(-1)!;
  assert.ok(Buffer.byteLength(JSON.stringify({ requests: sent })) <= 256 * 1024);
  assert.ok(sent.every(request => Buffer.byteLength(JSON.stringify(request.details)) <= 32 * 1024));
  assert.ok(sent.every(request => (request.details as any).originalRequestId !== huge.id));
  assert.ok(sent.length < 10 && sent.length > 0);
  for (const request of sent) assert.equal((request.details as any).request.args.content.length, 30_000);
  const unavailable = f.relay.status().requiresLocalApproval;
  assert.match(unavailable.find(item => item.id === huge.id)!.reason, /没有截断/);
  assert.ok(unavailable.some(item => /队列已满/.test(item.reason)));
  assert.equal(f.runtime.getTask(huge.id)!.status, 'awaiting_approval'); assert.equal(f.executions(), 0);
});

test('unknown original workspace stays local, canonical hashes are order-stable, and syncs never overlap', async t => {
  const f = await fixture(t);
  const result = f.access.request({ owner: 'owner-a', method: 'tools/list', description: 'Legacy request', args: {} });
  const entered = deferred(), gate = deferred(); f.handle(async () => { entered.resolve(); await gate.promise; });
  const first = f.relay.syncNow(); await entered.promise; const second = f.relay.syncNow();
  assert.equal(first, second); assert.equal(f.syncs(), 1); gate.resolve(); await first;
  assert.deepEqual(f.snapshots().at(-1), []); assert.match(f.relay.status().requiresLocalApproval[0].reason, /原始工作区/);
  assert.equal(canonicalApproval({ b: [2, { z: 1, a: 3 }], a: 1 }), canonicalApproval({ a: 1, b: [2, { a: 3, z: 1 }] }));
  f.access.close(); await result;
});

test('scheduled relay stops network activity on pause and resumes only after the runtime resumes', async t => {
  const f = await fixture(t, { intervalMs: 5 });
  await delay(20); assert.ok(f.syncs() > 0);
  await f.runtime.pause(true); const count = f.syncs(); await delay(25); assert.equal(f.syncs(), count);
  await f.runtime.pause(false); await delay(20); assert.ok(f.syncs() > count);
  f.disable(); const disabled = f.syncs(); await delay(25); assert.equal(f.syncs(), disabled);
});

test('identity sync rejects delayed replies after scope generation changes and rejects another device response', async t => {
  const { createIdentityService } = await import('../src/identity/client.js');
  const { readFile, writeFile, realpath } = await import('node:fs/promises');
  const { hash } = await import('../src/identity/security.js');
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'capyra-relay-client-')));
  const nativeFetch = globalThis.fetch;
  const initial = createIdentityService({ stateDir: workspace, cloudUrl: 'https://relay.example', pollIntervalMs: 0 }); initial.close();
  const path = join(workspace, 'identity', 'device.json');
  const disk = JSON.parse(await readFile(path, 'utf8'));
  const timestamp = new Date().toISOString();
  let device = { id: 'device-a', ownerId: 'account-a', name: 'Synthetic fixture', fingerprint: hash(disk.publicKey), scope: { workspaces: [workspace], capabilities: ['*'] }, version: 1, createdAt: timestamp, updatedAt: timestamp };
  disk.device = device; disk.localScope = device.scope;
  disk.account = { token: 'a'.repeat(43), csrfToken: 'c'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), user: { id: 'account-a', email: 'synthetic@example.test', createdAt: timestamp } };
  await writeFile(path, JSON.stringify(disk), { mode: 0o600 });
  let gate: ReturnType<typeof deferred> | undefined; let entered: ReturnType<typeof deferred> | undefined;
  let responseDeviceId = device.id;
  globalThis.fetch = async (input, options) => {
    const endpoint = new URL(String(input)).pathname; let body: unknown;
    if (endpoint === '/v1/device/challenge') body = { challenge: 'synthetic-challenge' };
    else if (endpoint === '/v1/device/authenticate') body = { token: 'r'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), device };
    else if (endpoint === '/v1/device') body = device;
    else if (endpoint === '/v1/devices/device-a/scope') { device = { ...device, scope: JSON.parse(String(options?.body)).scope, version: device.version + 1 }; body = device; }
    else if (endpoint === '/v1/device/approvals/sync') {
      body = { deviceId: responseDeviceId, version: device.version, decisions: [] };
      entered?.resolve(); await gate?.promise;
    } else throw new Error('Unexpected synthetic endpoint');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = createIdentityService({ stateDir: workspace, pollIntervalMs: 0 });
  t.after(async () => { service.close(); globalThis.fetch = nativeFetch; await rm(workspace, { recursive: true, force: true }); });
  await service.refreshBinding();
  gate = deferred(); entered = deferred();
  const rejected = assert.rejects(service.syncApprovals([]), /设备绑定不符/);
  await entered.promise;
  await service.updateScope(device.id, { workspaces: [workspace], capabilities: ['workspace:read'] });
  gate.resolve(); await rejected;
  assert.equal(service.status().active, true); assert.deepEqual(service.status().device!.scope.capabilities, ['workspace:read']);
  gate = undefined; entered = undefined; responseDeviceId = 'other-device';
  await assert.rejects(service.syncApprovals([]), /设备绑定不符/);
});

test('identity relay abort stops its final device check without corrupting the otherwise active identity', async t => {
  const { createIdentityService } = await import('../src/identity/client.js');
  const { readFile, writeFile, realpath } = await import('node:fs/promises');
  const { hash } = await import('../src/identity/security.js');
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'capyra-relay-abort-')));
  const nativeFetch = globalThis.fetch;
  const initial = createIdentityService({ stateDir: workspace, cloudUrl: 'https://relay.example', pollIntervalMs: 0 }); initial.close();
  const path = join(workspace, 'identity', 'device.json'); const disk = JSON.parse(await readFile(path, 'utf8'));
  const timestamp = new Date().toISOString();
  const device = { id: 'device-a', ownerId: 'account-a', name: 'Synthetic fixture', fingerprint: hash(disk.publicKey), scope: { workspaces: [workspace], capabilities: ['*'] }, version: 1, createdAt: timestamp, updatedAt: timestamp };
  disk.device = device; disk.localScope = device.scope; await writeFile(path, JSON.stringify(disk), { mode: 0o600 });
  let holdDeviceCheck = false; const entered = deferred();
  globalThis.fetch = async (input, options) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint === '/v1/device' && holdDeviceCheck) {
      entered.resolve();
      await new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    }
    const body = endpoint === '/v1/device/challenge' ? { challenge: 'synthetic' }
      : endpoint === '/v1/device/authenticate' ? { token: 'r'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), device }
      : endpoint === '/v1/device/approvals/sync' ? { deviceId: device.id, version: device.version, decisions: [{ id: 'request', kind: 'access', digest: '1'.repeat(64), approve: true, visibility: 'client' }] }
      : device;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = createIdentityService({ stateDir: workspace, pollIntervalMs: 0 });
  t.after(async () => { service.close(); globalThis.fetch = nativeFetch; await rm(workspace, { recursive: true, force: true }); });
  await service.refreshBinding(); holdDeviceCheck = true;
  const abort = new AbortController(); const rejected = assert.rejects(service.syncApprovals([], { signal: abort.signal }));
  await entered.promise; abort.abort(new Error('relay paused')); await rejected;
  assert.equal(service.status().active, true);
});

test('expired mobile windows get new IDs without extending the original task expiry or accepting old decisions', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const task = await f.runtime.submit('fixture__command', { command: 'printf bounded' }, 'owner-a');
  await f.relay.syncNow(); const first = f.snapshots().at(-1)![0];
  assert.equal(first.expiresAt, clock + 4 * 60_000);
  await f.relay.syncNow(); assert.equal(f.snapshots().at(-1)![0].id, first.id); assert.equal(f.snapshots().at(-1)![0].expiresAt, first.expiresAt);
  clock += 4 * 60_000 + 1; f.decide(first); await f.relay.syncNow();
  const second = f.snapshots().at(-1)![0];
  assert.notEqual(second.id, first.id); assert.notEqual(second.digest, first.digest); assert.equal(f.executions(), 0);
  assert.ok(second.expiresAt <= Date.parse(task.expiresAt!));
  clock = Date.parse(task.expiresAt!) + 1; f.decide(second); await f.relay.syncNow();
  assert.deepEqual(f.snapshots().at(-1), []); assert.equal(f.executions(), 0);
  assert.match(f.relay.status().requiresLocalApproval[0].reason, /过期/);
});

test('a complete cloud snapshot never exceeds 128 records and overflow remains available to local approval', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 129; i++) await f.runtime.submit('fixture__command', { command: String(i) }, 'owner-a');
  await f.relay.syncNow();
  assert.equal(f.snapshots().at(-1)!.length, 128);
  const overflow = f.relay.status().requiresLocalApproval;
  assert.equal(overflow.length, 1); assert.match(overflow[0].reason, /队列已满/);
  assert.equal(f.runtime.getTask(overflow[0].id)!.status, 'awaiting_approval');
  await f.runtime.approveTask(overflow[0].id, false);
  assert.equal(f.runtime.getTask(overflow[0].id)!.status, 'denied');
});
