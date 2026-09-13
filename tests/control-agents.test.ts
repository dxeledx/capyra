import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Runtime } from '../src/core/runtime.js';
import type { RuntimeConfig, TaskRecord } from '../src/core/types.js';
import { startControl } from '../src/transport/control.js';
import processPlugin from '../src/plugins/process.js';
import agentsPlugin from '../src/plugins/agents.js';
import type { AgentDaemonClient } from '../src/daemon/client.js';
import type { AgentRecord } from '../src/execution/agent-manager.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'capyra-control-agents-')), workspace = join(root, 'workspace'), outside = join(root, 'outside'), stateDir = join(root, 'state');
  await mkdir(workspace); await mkdir(outside); await mkdir(join(stateDir, 'agent-sessions'), { recursive: true });
  const now = new Date().toISOString(), owner = 'oauth:shared-client';
  const record = (workspace: string, cwd = workspace): AgentRecord => ({ id: randomUUID(), owner, workspace, cwd, target: 'worker', provider: 'command', providerSessionId: 'native-fixture', status: 'completed', createdAt: now, updatedAt: now, response: '0123456789'.repeat(2000), writeMode: 'full_access', turns: [{ taskId: 'previous-launch-was-pruned', prompt: 'original task', startedAt: now, endedAt: now, status: 'completed', response: '0123456789'.repeat(2000), processSessionIds: [], writeMode: 'full_access' }] });
  const remote = record(workspace, await realpath(workspace)), otherWorkspace = record(outside, await realpath(outside)), invalidCwd = record(workspace, await realpath(outside));
  for (const saved of [remote, otherWorkspace, invalidCwd]) await writeFile(join(stateDir, 'agent-sessions', `${saved.id}.json`), JSON.stringify(saved));
  const code = 'require("node:fs").appendFileSync("effects.log",process.argv[1]+"\\n");if(process.argv[1]==="keep-running")setInterval(()=>{},1000);else process.stdout.write("continued")';
  const config: RuntimeConfig = { workspace, stateDir, port: 0, controlPort: 0, exposure: 'compact', maxTasks: 100, maxConcurrent: 2, plugins: [
    { id: 'process', enabled: true, grants: processPlugin.permissions },
    { id: 'agents', enabled: true, grants: agentsPlugin.permissions, config: { profileDirs: [], workflow: { enabled: false }, roles: { worker: { provider: 'command', executable: process.execPath, args: ['-e', code, '{prompt}'], resumeArgs: ['-e', code, '{prompt}'] } } } },
  ] };
  const runtime = new Runtime(config, async entry => entry.id === 'process' ? processPlugin : agentsPlugin); await runtime.start();
  const manager = runtime.service<AgentDaemonClient>('agents.manager');
  const control = await startControl(runtime, config, { pending: () => [], decide() {}, revoke() {} });
  t.after(async () => { await control.close(); await manager.stop(true); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { 'X-Capyra-Local': '1', Origin: control.url, 'Content-Type': 'application/json' };
  const bootstrap = await fetch(control.url + '/api/bootstrap', { method: 'POST', headers, body: JSON.stringify({ nonce: new URL(control.openUrl).hash.slice('#bootstrap='.length) }) });
  assert.equal(bootstrap.status, 200); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const post = (route: string, body: unknown, changes: Record<string, string> = {}) => fetch(control.url + route, { method: 'POST', headers: { ...headers, Cookie: cookie, ...changes }, body: JSON.stringify(body) });
  const action = (method: string, body: unknown, changes?: Record<string, string>) => post(`/api/services/agents/${method}`, body, changes);
  const approve = async (task: TaskRecord) => { assert.equal(task.status, 'awaiting_approval'); assert.equal(task.owner, owner); assert.equal(task.resultVisibility, 'local'); assert.equal((await post(`/api/tasks/${task.id}/approve`, { approve: true })).status, 200); await runtime.waitTask(task.id, 5000); assert.equal(runtime.getTask(task.id)!.status, 'succeeded'); };
  return { runtime, manager, config, workspace, outside, remote, otherWorkspace, invalidCwd, control, headers: { ...headers, Cookie: cookie }, owner, action, approve };
}

test('trusted local console lists and pages remote agents while workspace and MCP owner boundaries remain', async t => {
  const f = await fixture(t);
  assert.equal((await f.action('read', { agentId: f.remote.id }, { Cookie: '' })).status, 401);
  assert.equal((await f.action('read', { agentId: f.remote.id }, { Origin: 'https://attacker.example' })).status, 403);
  const state = await (await fetch(f.control.url + '/api/state', { headers: f.headers })).json();
  assert.deepEqual(state.services.agents.sessions.map((record: { id: string }) => record.id), [f.remote.id]); assert.equal(state.services.agents.sessions[0].source, 'client'); assert.equal(state.services.agents.sessions[0].turnCount, 1);
  assert.equal(state.services.agents.sessions[0].response, undefined, 'polling only returns summaries');
  const result = await (await f.action('read', { agentId: f.remote.id, outputOffset: 2, outputLimit: 4 })).json();
  assert.equal(result.agent.response, '2345'); assert.equal(result.agent.responseLength, 20000); assert.equal(result.agent.nextOutputOffset, 6);
  for (const record of [f.otherWorkspace, f.invalidCwd]) assert.equal((await f.action('read', { agentId: record.id })).status, 404);
  for (const body of [{ agentId: f.remote.id, owner: f.owner }, { agentId: f.remote.id, workspace: f.outside }, { agentId: f.remote.id, cwd: f.outside }]) assert.equal((await f.action('read', body)).status, 400);
  assert.equal((await f.action('read', { agentId: f.remote.id, outputLimit: 16385 })).status, 400);
  assert.equal(f.runtime.listTools().some(tool => /getLocal|agents__readLocal/.test(tool.name)), false);
  const sameOwnerRead = await f.runtime.submit('agents__show', { agentId: f.remote.id }, f.owner);
  assert.equal(sameOwnerRead.status, 'awaiting_approval'); assert.equal(sameOwnerRead.result, undefined); await f.runtime.approveTask(sameOwnerRead.id, false);
  const otherOwnerRead = await f.runtime.submit('agents__show', { agentId: f.remote.id }, 'oauth:another-client');
  await f.runtime.approveTask(otherOwnerRead.id, true); await f.runtime.waitTask(otherOwnerRead.id, 5000);
  assert.equal(f.runtime.getTask(otherOwnerRead.id)!.status, 'failed'); assert.match(f.runtime.getTask(otherOwnerRead.id)!.error!, /Unknown agent session/);
});

test('local continuation and cancellation resolve stored ownership and still require exact Runtime approval', async t => {
  const f = await fixture(t);
  assert.equal((await f.action('continue', { agentId: f.remote.id, prompt: 'forged', owner: 'local-console' })).status, 400);
  assert.equal((await f.action('continue', { agentId: f.otherWorkspace.id, prompt: 'cross-workspace' })).status, 404);
  const response = await f.action('continue', { agentId: f.remote.id, prompt: 'new instruction' }); assert.equal(response.status, 200);
  const task = await response.json() as TaskRecord;
  assert.equal((await f.manager.get(f.remote.id, f.owner, f.workspace)).turns.length, 1);
  await assert.rejects(readFile(join(f.workspace, 'effects.log')), { code: 'ENOENT' });
  await f.approve(task); await f.manager.wait([f.remote.id], f.owner, f.workspace, 12000);
  const continued = await f.manager.get(f.remote.id, f.owner, f.workspace);
  assert.equal(continued.owner, f.owner); assert.equal(continued.status, 'completed', continued.error); assert.equal(continued.turns.length, 2); assert.equal(continued.turns.at(-1)!.prompt, 'new instruction'); assert.equal(continued.turns.at(-1)!.taskId, task.id);
  assert.equal(await readFile(join(f.workspace, 'effects.log'), 'utf8'), 'new instruction\n'); await assert.rejects(f.runtime.approveTask(task.id, true));
  const runningTask = await (await f.action('continue', { agentId: f.remote.id, prompt: 'keep-running' })).json() as TaskRecord; await f.approve(runningTask);
  const cancellation = await (await f.action('cancel', { agentId: f.remote.id })).json() as TaskRecord;
  assert.equal((await f.manager.get(f.remote.id, f.owner, f.workspace)).status, 'running'); await f.approve(cancellation);
  assert.equal((await f.manager.get(f.remote.id, f.owner, f.workspace)).status, 'cancelled');
});

test('workspace changes during a local agent lookup cannot submit a continuation', async t => {
  const f = await fixture(t), list = f.manager.listLocal.bind(f.manager);
  f.manager.listLocal = async workspace => { const result = await list(workspace); f.config.workspace = f.outside; return result; };
  try { assert.equal((await f.action('continue', { agentId: f.remote.id, prompt: 'stale workspace' })).status, 409); assert.equal(f.runtime.listTasks().length, 0); }
  finally { f.manager.listLocal = list; f.config.workspace = f.workspace; }
});
