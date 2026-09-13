import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolContext } from '../src/core/types.js';
import { AgentDaemonClient } from '../src/daemon/client.js';
import { daemonPaths, daemonSecret, protocolVersion, signRequest, type DaemonRequest } from '../src/daemon/security.js';
import { runAgentCommand } from '../src/daemon/commands.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: { after(fn: () => Promise<void>): void }, idleMs = 30_000) {
  const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'capyra-agentd-')), state = path.join(root, 'state');
  const provider = path.join(root, 'provider.mjs');
  await writeFile(provider, `setTimeout(()=>process.stdout.write(JSON.stringify({prompt:process.argv[2],session:process.argv[3]})),Number(process.argv[4]??150));`);
  const config = { profileDirs: [], workflow: { enabled: false }, daemonIdleMs: idleMs, providers: { command: { provider: 'command', executable: process.execPath, args: [provider, '{prompt}', '{sessionId}', '300'], resumeArgs: [provider, '{prompt}', '{sessionId}', '100'] } } };
  const client = new AgentDaemonClient(state, config);
  const ctx: ToolContext = { owner: 'alice', workspace: root, taskId: 'task-1', signal: new AbortController().signal, progress() {} };
  t.after(async () => { const cleanup = new AgentDaemonClient(state, config); try { await cleanup.stop(true); } finally { await cleanup.close(); await client.close(); await rm(root, { recursive: true, force: true }); } });
  return { root, state, config, client, ctx };
}

test('read-only queries do not start a daemon or create runtime state', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).running, false);
  assert.equal((await f.client.list('alice', f.root)).length, 0);
  assert.ok((await f.client.catalog(f.root)).targets.some(item => item.id === 'command'));
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
});

test('concurrent clients start one detached daemon and use private IPC', async t => {
  const f = await fixture(t), second = new AgentDaemonClient(f.state, f.config); t.after(() => second.close());
  const [one, two] = await Promise.all([f.client.run({ target: 'command', prompt: 'one' }, f.ctx), second.run({ target: 'command', prompt: 'two' }, { ...f.ctx, taskId: 'task-2' })]);
  const [firstStatus, secondStatus] = await Promise.all([f.client.status(), second.status()]);
  assert.ok(firstStatus.pid && firstStatus.pid !== process.pid); assert.equal(firstStatus.pid, secondStatus.pid);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.client.paths.secret)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.client.paths.endpoint)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.client.paths.directory)).mode & 0o777, 0o700);
  }
  assert.equal((await f.client.wait([one.id, two.id], 'alice', f.root, 12_000)).every(record => record.status === 'completed'), true);
});

test('client disconnect and MCP replacement preserve active turns; scoped reads remain isolated', async t => {
  const f = await fixture(t), record = await f.client.run({ target: 'command', prompt: 'survives' }, f.ctx);
  const pid = (await f.client.status()).pid; await f.client.close();
  const replacement = new AgentDaemonClient(f.state, f.config); t.after(() => replacement.close());
  assert.equal((await replacement.status()).pid, pid);
  await assert.rejects(replacement.get(record.id, 'bob', f.root), /Unknown agent/);
  await assert.rejects(replacement.get(record.id, 'alice', path.dirname(f.root)), /Unknown agent/);
  const [result] = await replacement.wait([record.id], 'alice', f.root, 12_000);
  assert.equal(result.status, 'completed'); assert.equal(JSON.parse(result.response!).prompt, 'survives');
  await replacement.continue(record.id, { prompt: 'continued' }, f.ctx);
  const [continued] = await replacement.wait([record.id], 'alice', f.root, 12_000);
  assert.equal(continued.providerSessionId, record.id); assert.equal(continued.turns.length, 2);
});

test('independent CLI processes can exit while the provider continues', async t => {
  const f = await fixture(t);
  const module = new URL('../src/daemon/client.ts', import.meta.url).href;
  const source = `import {AgentDaemonClient} from ${JSON.stringify(module)};const c=new AgentDaemonClient(${JSON.stringify(f.state)},${JSON.stringify(f.config)});const r=await c.run({target:'command',prompt:'after-exit'},{owner:'alice',workspace:${JSON.stringify(f.root)},taskId:'subprocess',signal:new AbortController().signal,progress(){}});console.log(r.id);await c.close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, stderr);
  const [result] = await f.client.wait([stdout.trim()], 'alice', f.root, 12_000);
  assert.equal(result.status, 'completed'); assert.equal(JSON.parse(result.response!).prompt, 'after-exit');
});

test('IPC binds scope and params to authentication and rejects replay', async t => {
  const f = await fixture(t), record = await f.client.run({ target: 'command', prompt: 'private' }, f.ctx);
  const secret = daemonSecret(f.state)!, instance = JSON.parse(await readFile(f.client.paths.lock, 'utf8')).nonce;
  const signed = signRequest(secret, { instance, version: protocolVersion, id: randomUUID(), method: 'get', scope: { owner: 'bob', workspace: f.root }, params: { id: record.id } });
  const forged = await rpc(f.client.paths.endpoint, { ...signed, scope: { owner: 'alice', workspace: f.root } });
  assert.equal(forged.error.code, 'DAEMON_AUTH');
  const expired = signRequest(secret, { instance, issuedAt: Date.now() - 60_000, version: protocolVersion, id: randomUUID(), method: 'get', scope: { owner: 'alice', workspace: f.root }, params: { id: record.id } });
  assert.equal((await rpc(f.client.paths.endpoint, expired)).error.code, 'DAEMON_AUTH_EXPIRED');
  const oldInstance = signRequest(secret, { instance: 'previous-instance', version: protocolVersion, id: randomUUID(), method: 'get', scope: { owner: 'alice', workspace: f.root }, params: { id: record.id } });
  assert.equal((await rpc(f.client.paths.endpoint, oldInstance)).error.code, 'DAEMON_AUTH_EXPIRED');
  const spoofed = signRequest(secret, { instance, version: protocolVersion, id: randomUUID(), method: 'get', scope: { owner: 'bob', workspace: f.root }, params: { id: record.id, owner: 'alice' } });
  assert.equal((await rpc(f.client.paths.endpoint, spoofed)).error.code, 'DAEMON_SCOPE');
  const valid = signRequest(secret, { instance, version: protocolVersion, id: randomUUID(), method: 'get', scope: { owner: 'alice', workspace: f.root }, params: { id: record.id } });
  assert.equal((await rpc(f.client.paths.endpoint, valid)).ok, true);
  assert.equal((await rpc(f.client.paths.endpoint, valid)).error.code, 'DAEMON_REPLAY');
});

test('three independent CLI processes race startup without replacing active daemon state', async t => {
  const f = await fixture(t);
  const module = new URL('../src/daemon/client.ts', import.meta.url).href;
  const source = `import {AgentDaemonClient} from ${JSON.stringify(module)};const c=new AgentDaemonClient(${JSON.stringify(f.state)},${JSON.stringify(f.config)});const r=await c.run({target:'command',prompt:'concurrent'},{owner:'alice',workspace:${JSON.stringify(f.root)},taskId:'subprocess',signal:new AbortController().signal,progress(){}});console.log(JSON.stringify({id:r.id,pid:(await c.status()).pid}));await c.close();`;
  const launch = () => new Promise<{ id: string; pid: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => { if (code) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
  const results = await Promise.all([launch(), launch(), launch()]);
  assert.equal(new Set(results.map(result => result.pid)).size, 1);
  assert.equal((await f.client.wait(results.map(result => result.id), 'alice', f.root, 12_000)).every(record => record.status === 'completed'), true);
});

test('a killed daemon leaves an interrupted record and never replays its previous prompt', async t => {
  const f = await fixture(t), first = await f.client.run({ target: 'command', prompt: 'before-crash' }, f.ctx);
  const pid = (await f.client.status()).pid!;
  process.kill(pid, 'SIGKILL');
  await pause(600);
  const next = await f.client.run({ target: 'command', prompt: 'after-crash' }, f.ctx);
  const interrupted = await f.client.get(first.id, 'alice', f.root);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.turns.length, 1);
  assert.match(interrupted.error!, /not replayed/);
  assert.equal((await f.client.wait([next.id], 'alice', f.root, 12_000))[0].status, 'completed');
});

test('deep workspaces use a short private Unix socket and remove it on shutdown', async t => {
  if (process.platform === 'win32') { t.skip('Windows named pipes do not have the Unix socket path limit.'); return; }
  const f = await fixture(t), state = path.join(f.root, 'nested-workspace-'.repeat(8), 'state');
  const client = new AgentDaemonClient(state, f.config); t.after(async () => { await client.stop(true); await client.close(); });
  assert.ok(Buffer.byteLength(client.paths.endpoint) <= 103);
  const record = await client.run({ target: 'command', prompt: 'deep path' }, f.ctx);
  assert.equal((await client.wait([record.id], 'alice', f.root, 12_000))[0].status, 'completed');
  await client.stop(); await assert.rejects(lstat(client.paths.socketDirectory), { code: 'ENOENT' });
});

test('configuration changes refuse active replacement and rotate the idle daemon', async t => {
  const f = await fixture(t); const record = await f.client.run({ target: 'command', prompt: 'original' }, f.ctx);
  const previousPid = (await f.client.status()).pid;
  const changed = new AgentDaemonClient(f.state, { ...f.config, maxSessions: 80 }); t.after(() => changed.close());
  await assert.rejects(changed.run({ target: 'command', prompt: 'new-config' }, f.ctx), /configuration changed/i);
  assert.equal((await f.client.status()).pid, previousPid);
  await f.client.wait([record.id], 'alice', f.root, 12_000);
  const next = await changed.run({ target: 'command', prompt: 'new-config' }, f.ctx);
  assert.notEqual((await changed.status()).pid, previousPid);
  assert.equal((await changed.wait([next.id], 'alice', f.root, 12_000))[0].status, 'completed');
});

test('stop refuses active work; force interrupts, persists and releases the provider', async t => {
  const f = await fixture(t);
  f.config.providers.command.args[3] = '30000';
  const client = new AgentDaemonClient(f.state, f.config); t.after(() => client.close());
  const record = await client.run({ target: 'command', prompt: 'long' }, f.ctx);
  await assert.rejects(client.stop(), /still running/);
  await client.stop(true);
  assert.equal((await client.status()).running, false);
  assert.equal((await client.get(record.id, 'alice', f.root)).status, 'interrupted');
  const log = client.logs(); assert.match(log, /daemon_stopped/); assert.doesNotMatch(log, /long|alice|provider|secret/);
});

test('idle shutdown leaves no process and the next explicit turn resumes its native session', async t => {
  const f = await fixture(t, 150);
  const first = await f.client.run({ target: 'command', prompt: 'idle' }, f.ctx);
  const completed = (await f.client.wait([first.id], 'alice', f.root, 12_000))[0]; assert.equal(completed.status, 'completed');
  await pause(650);
  assert.equal((await f.client.status()).running, false);
  await f.client.continue(first.id, { prompt: 'wake' }, f.ctx);
  const [next] = await f.client.wait([first.id], 'alice', f.root, 12_000);
  assert.equal(next.providerSessionId, completed.providerSessionId); assert.equal(next.status, 'completed');
});

test('stale durable running state is reconciled only after exclusive daemon startup', async t => {
  const f = await fixture(t), initial = await f.client.run({ target: 'command', prompt: 'first' }, f.ctx);
  await f.client.wait([initial.id], 'alice', f.root, 12_000); await f.client.stop();
  const filename = path.join(f.state, 'agent-sessions', `${initial.id}.json`), raw = JSON.parse(await readFile(filename, 'utf8'));
  raw.status = 'running'; raw.turns[0].status = 'running'; await writeFile(filename, JSON.stringify(raw));
  assert.equal((await f.client.get(initial.id, 'alice', f.root)).status, 'interrupted');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).status, 'running');
  const next = await f.client.run({ target: 'command', prompt: 'separate' }, f.ctx);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).status, 'interrupted');
  assert.equal((await f.client.get(initial.id, 'alice', f.root)).providerSessionId, initial.id);
  await f.client.wait([next.id], 'alice', f.root, 12_000);
});

test('credential symlinks and permissive modes are refused; Windows endpoint is a private named pipe', async t => {
  const f = await fixture(t); daemonSecret(f.state, true);
  assert.match(daemonPaths(f.state, 'win32').endpoint, /^\\\\\.\\pipe\\capyra-agentd-/);
  if (process.platform === 'win32') { t.diagnostic('NTFS ACL requires a separate Windows native validation.'); return; }
  await chmod(f.client.paths.secret, 0o644);
  assert.throws(() => daemonSecret(f.state), /private/);
  await chmod(f.client.paths.secret, 0o600);
  const alternate = path.join(f.root, 'alternate'); await writeFile(alternate, 'a'.repeat(64), { mode: 0o600 });
  await rm(f.client.paths.secret); await symlink(alternate, f.client.paths.secret);
  assert.throws(() => daemonSecret(f.state));
  await rm(f.client.paths.secret);
});

test('CLI targets and daemon diagnostics stay offline; CLI run/show/wait/continue share sessions', async t => {
  const f = await fixture(t), output: string[] = [];
  const runtime = { stateDir: f.state, workspace: f.root, plugins: [{ id: 'agents', enabled: true, grants: [], config: f.config }] } as any;
  const options = { owner: 'alice', write(text: string) { output.push(text); }, flags: { json: true } };
  await runAgentCommand(['targets'], runtime, options); await runAgentCommand(['daemon', 'status'], runtime, options);
  assert.equal(JSON.parse(output.at(-1)!).running, false);
  await runAgentCommand(['run', 'command', 'CLI task'], runtime, options); const id = JSON.parse(output.at(-1)!).id;
  await runAgentCommand(['wait', id], runtime, options); assert.equal(JSON.parse(output.at(-1)!)[0].status, 'completed');
  await runAgentCommand(['continue', id, 'next'], runtime, options);
  await runAgentCommand(['wait', id], runtime, options); assert.equal(JSON.parse(output.at(-1)!)[0].turns.length, 2);
  await runAgentCommand(['show', id], runtime, options); assert.equal(JSON.parse(output.at(-1)!).id, id);
  await runAgentCommand(['ls'], runtime, options); assert.equal(JSON.parse(output.at(-1)!).length, 1);
});

test('agent output is scoped to its exact process IDs and remains readable after daemon shutdown', async t => {
  const f = await fixture(t), first = await f.client.run({ target: 'command', prompt: 'output-one' }, f.ctx);
  const second = await f.client.run({ target: 'command', prompt: 'output-two' }, f.ctx);
  await f.client.wait([first.id, second.id], 'alice', f.root, 12_000);
  const secondRecord = await f.client.get(second.id, 'alice', f.root);
  const page = await f.client.readOutput(first.id, undefined, 'alice', f.root);
  assert.match(page.output.map(entry => entry.text).join(''), /output-one/);
  await assert.rejects(f.client.readOutput(first.id, undefined, 'bob', f.root), /Unknown/);
  await assert.rejects(f.client.readOutput(first.id, secondRecord.turns[0].processSessionIds[0], 'alice', f.root), /Unknown agent process/);
  await f.client.stop();
  const saved = await f.client.readOutput(first.id, undefined, 'alice', f.root);
  assert.deepEqual(saved.output, page.output); assert.equal(saved.session.status, 'completed');
  assert.equal((await f.client.readOutput(first.id, undefined, 'alice', f.root, { cursor: saved.nextCursor })).output.length, 0);
  await assert.rejects(f.client.readOutput(first.id, undefined, 'bob', f.root), /Unknown/);
});

test('agent write modes survive CLI dispatch, IPC, continuation and daemon restart', async t => {
  const f = await fixture(t), provider = path.join(f.root, 'codex-permissions.mjs');
  await writeFile(provider, `import readline from 'node:readline';const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const reply=result=>send({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:m.params.threadId??'permission-session'}});else if(m.method==='turn/start'){reply({turn:{id:'mode-turn'}});send({method:'turn/completed',params:{turn:{status:'completed',items:[{type:'agentMessage',text:JSON.stringify(m.params.sandboxPolicy)}]}}});}});`);
  const config = { ...f.config, providers: { ...f.config.providers, codex: { provider: 'codex', executable: process.execPath, args: [provider] } } };
  const client = new AgentDaemonClient(f.state, config); t.after(() => client.close());
  const runtime = { stateDir: f.state, workspace: f.root, plugins: [{ id: 'agents', enabled: true, grants: [], config }] } as any;
  const printed: string[] = [], options = { owner: 'alice', write(text: string) { printed.push(text); }, flags: { json: true, 'write-mode': 'read_only' } };
  await runAgentCommand(['run', 'codex', 'inspect only'], runtime, options);
  const first = JSON.parse(printed.at(-1)!); assert.equal(first.writeMode, 'read_only');
  const [readOnly] = await client.wait([first.id], 'alice', f.root); assert.equal(JSON.parse(readOnly.response!).type, 'readOnly');
  assert.equal(readOnly.turns[0].writeMode, 'read_only');
  await client.continue(first.id, { prompt: 'workspace changes', writeMode: 'allowed' }, f.ctx);
  const [allowed] = await client.wait([first.id], 'alice', f.root); assert.equal(allowed.writeMode, 'allowed');
  assert.equal(JSON.parse(allowed.response!).type, 'workspaceWrite');
  await runAgentCommand(['continue', first.id, 'local unrestricted task'], runtime, { ...options, flags: { json: true, 'write-mode': 'full_access' } });
  const [fullAccess] = await client.wait([first.id], 'alice', f.root); assert.equal(JSON.parse(fullAccess.response!).type, 'dangerFullAccess');
  assert.deepEqual(fullAccess.turns.map(turn => turn.writeMode), ['read_only', 'allowed', 'full_access']);
  await client.stop();
  assert.equal((await client.get(first.id, 'alice', f.root)).writeMode, 'full_access');
  await client.continue(first.id, { prompt: 'preserve mode after restart' }, f.ctx);
  const [resumed] = await client.wait([first.id], 'alice', f.root); assert.equal(resumed.writeMode, 'full_access'); assert.equal(resumed.turns.at(-1)!.writeMode, 'full_access');
  assert.equal(JSON.parse(resumed.response!).type, 'dangerFullAccess');
});

test('invalid write modes are rejected before daemon startup and at the signed IPC boundary', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.run({ target: 'command', prompt: 'invalid', writeMode: 'bypass' } as any, f.ctx), /writeMode/);
  assert.equal((await f.client.status()).running, false);
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
  const record = await f.client.run({ target: 'command', prompt: 'valid', writeMode: 'full_access' }, f.ctx);
  const instance = JSON.parse(await readFile(f.client.paths.lock, 'utf8')).nonce;
  const request = signRequest(daemonSecret(f.state)!, { instance, version: protocolVersion, id: randomUUID(), method: 'run', revision: f.client.revision, scope: { owner: 'alice', workspace: f.root }, params: { target: 'command', prompt: 'invalid boundary', writeMode: 'bypass' } });
  assert.match((await rpc(f.client.paths.endpoint, request)).error.message, /writeMode/);
  await f.client.wait([record.id], 'alice', f.root);
  assert.equal((await f.client.list('alice', f.root)).length, 1);
});

test('atomic hard-link publication is retried without reading linked credentials or weakening permissions', async t => {
  const f = await fixture(t), first = await f.client.run({ target: 'command', prompt: 'publication' }, f.ctx);
  await f.client.wait([first.id], 'alice', f.root);
  for (const filename of [f.client.paths.lock, f.client.paths.secret]) {
    const temporary = path.join(f.root, 'publication-link'); await link(filename, temporary);
    let settled = false; const pending = f.client.status().then(status => { settled = true; return status; });
    await pause(30); assert.equal(settled, false, 'A multiply-linked file must not be accepted while it is being published.');
    await rm(temporary); assert.equal((await pending).running, true);
  }
  const persistent = path.join(f.root, 'persistent-link'); await link(f.client.paths.secret, persistent);
  await assert.rejects(f.client.status(), /remained linked/); await rm(persistent);
  if (process.platform !== 'win32') {
    await chmod(f.client.paths.secret, 0o644);
    await assert.rejects(f.client.status(), /private, regular file/); await chmod(f.client.paths.secret, 0o600);
  }
});

test('workflow CLI discovery stays offline, private install is explicit, and dispatch injects on-demand or preloaded context', async t => {
  const f = await fixture(t), { workflow: _disabled, ...defaults } = f.config;
  const output: string[] = [], options = { owner: 'alice', write(text: string) { output.push(text); }, flags: { json: true } };
  const runtime = { stateDir: f.state, workspace: f.root, plugins: [{ id: 'agents', enabled: true, grants: [], config: defaults }] } as any;
  await runAgentCommand(['workflow', 'status'], runtime, options);
  const initial = JSON.parse(output.at(-1)!); assert.equal(initial.enabled, true); assert.equal(initial.mode, 'on-demand'); assert.equal(initial.installed, false);
  await runAgentCommand(['workflow', 'show'], runtime, options); assert.match(JSON.parse(output.at(-1)!).content, /# Capyra subagents/);
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
  await runAgentCommand(['workflow', 'install'], runtime, options); assert.equal(JSON.parse(output.at(-1)!).installed, true);
  const installed = path.join(f.state, 'agent-workflow', 'skills', 'subagents', 'SKILL.md');
  assert.match(await readFile(installed, 'utf8'), /# Capyra subagents/);
  if (process.platform !== 'win32') assert.equal((await lstat(installed)).mode & 0o777, 0o600);
  await assert.rejects(lstat(f.client.paths.secret), { code: 'ENOENT' });
  for (const mode of ['on-demand', 'preload'] as const) {
    const config = mode === 'on-demand' ? defaults : { ...defaults, workflow: { instructions: mode } };
    runtime.plugins[0].config = config;
    const client = new AgentDaemonClient(f.state, config); t.after(() => client.close());
    await runAgentCommand(['run', 'command', 'workflow brief'], runtime, options);
    const id = JSON.parse(output.at(-1)!).id, [record] = await client.wait([id], 'alice', f.root);
    assert.equal(record.status, 'completed');
    const prompt = JSON.parse(record.response!).prompt;
    assert.match(prompt, /Capyra task context/); assert.match(prompt, /Assigned task\nworkflow brief/);
    if (mode === 'preload') assert.match(prompt, /# Capyra subagents/); else { assert.match(prompt, /agents__workflow/); assert.doesNotMatch(prompt, /# Capyra subagents/); }
    await client.stop();
  }
});

test('approval target fingerprints reject malformed client and signed IPC values without starting another turn', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.run({ target: 'command', prompt: 'invalid fingerprint', expectedTargetHash: 'A'.repeat(64) }, f.ctx), /expectedTargetHash/);
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
  const preview = await f.client.preview('command', f.root); assert.match(preview.targetHash, /^[a-f0-9]{64}$/);
  const record = await f.client.run({ target: 'command', prompt: 'original task', expectedTargetHash: preview.targetHash }, f.ctx); await f.client.wait([record.id], 'alice', f.root);
  const instance = JSON.parse(await readFile(f.client.paths.lock, 'utf8')).nonce;
  for (const method of ['run', 'continue']) for (const hash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), null, 7]) {
    const request = signRequest(daemonSecret(f.state)!, { instance, version: protocolVersion, id: randomUUID(), method, revision: f.client.revision, scope: { owner: 'alice', workspace: f.root }, params: { target: 'command', id: record.id, prompt: 'invalid boundary', expectedTargetHash: hash } });
    assert.match((await rpc(f.client.paths.endpoint, request)).error.message, /expectedTargetHash/);
  }
  assert.equal((await f.client.list('alice', f.root)).length, 1);
  assert.equal((await f.client.get(record.id, 'alice', f.root)).turns.length, 1);
  await assert.rejects(f.client.continue(record.id, { prompt: 'stale target', expectedTargetHash: '0'.repeat(64) }, f.ctx), /target changed after preview/);
  await f.client.continue(record.id, { prompt: 'matching fingerprint', expectedTargetHash: preview.targetHash }, f.ctx);
  const [continued] = await f.client.wait([record.id], 'alice', f.root);
  assert.equal(continued.status, 'completed'); assert.equal(continued.turns.length, 2);
});

function rpc(endpoint: string, request: DaemonRequest): Promise<any> {
  return new Promise((resolve, reject) => { const socket = connect(endpoint); let input = ''; socket.once('connect', () => socket.write(JSON.stringify(request) + '\n')); socket.on('error', reject); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('RPC timeout')); }); socket.on('data', chunk => { input += chunk; if (input.includes('\n')) { socket.destroy(); resolve(JSON.parse(input.trim())); } }); });
}
