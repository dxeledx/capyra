import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { AgentDaemonClient as Client } from '../src/daemon/client.js';
import type { AgentRecord } from '../src/execution/agent-manager.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeError = (value: unknown) => String(value).slice(0, 4000).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
function stateOf(pid: number) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 2000 }).trim(); }
  catch (error) { if ((error as { status?: number }).status === 1) return ''; throw error; }
}
const isAlive = (pid: number) => { const state = stateOf(pid); return !!state && !/^[ZX]/.test(state); };

test('frozen release Codex writes, resumes after real daemon restart, and cancels a live command', { timeout: 300_000 }, async t => {
  if (process.env.CAPYRA_REAL_CODEX_LIFECYCLE !== '1') { t.skip('Explicit CAPYRA_REAL_CODEX_LIFECYCLE=1 is required; this test uses existing ChatGPT subscription quota'); return; }
  if (process.platform !== 'darwin') { t.skip('This acceptance checks macOS process state and the existing local Codex installation'); return; }
  const project = path.resolve(import.meta.dirname, '..'), archive = path.join(project, 'artifacts/releases/0.2.0/capyra-0.2.0.tgz');
  const release = JSON.parse(await readFile(path.join(project, 'artifacts/releases/0.2.0/release.json'), 'utf8'));
  const archiveHash = hash(await readFile(archive)); assert.equal(archiveHash, release.sha256);
  const root = await realpath(await mkdtemp('/private/tmp/capyra-real-lifecycle-')), workspace = path.join(root, 'workspace'), runtime = path.join(root, 'runtime'), state = path.join(root, 'state');
  await mkdir(workspace); await mkdir(runtime);
  execFileSync('tar', ['-xzf', archive, '-C', runtime]);
  await symlink(path.join(project, 'node_modules'), path.join(runtime, 'package/node_modules'));
  const { AgentDaemonClient } = await import(pathToFileURL(path.join(runtime, 'package/dist/daemon/client.js')).href) as { AgentDaemonClient: typeof import('../src/daemon/client.js').AgentDaemonClient };
  const { executionEnvironment } = await import(pathToFileURL(path.join(runtime, 'package/dist/execution/sessions.js')).href);
  const executable = process.env.CAPYRA_TEST_NATIVE_CODEX ?? '/opt/homebrew/bin/codex';
  const config = { profileDirs: [], daemonIdleMs: 60000, workflow: { instructions: 'on-demand' }, providers: { codex: { executable, model: 'gpt-5.6-sol', effort: 'low', timeoutMs: 90000 } }, roles: { 'fixture-writer': { provider: 'codex', writeMode: 'allowed', prompt: 'Work only in the named synthetic working directory and only on files explicitly named by the task. Do not read files outside it, authentication, configuration, or other projects. Do not use network commands, web search, MCP services, or other agents. Use local commands or file tools only. Follow the exact requested file contents and brief final reply.' } } };
  let client: Client = new AgentDaemonClient(state, config), agentId: string | undefined, probePid: number | undefined, probeOwned = false;
  const nonce = randomBytes(8).toString('hex'), probeNonce = randomBytes(8).toString('hex');
  const evidence: Record<string, any> = { schema: 'capyra-real-agent-lifecycle/v1', date: new Date().toISOString(), runtimeArchive: path.relative(project, archive), runtimeArchiveSha256: archiveHash, provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', loginMode: 'unverified', writeMode: 'allowed', networkBoundary: 'The existing allowed mode permits OS network access. Task instructions prohibit network tools and external resources; this acceptance does not claim OS-level network denial.', modelTurnsRequested: 0, status: 'started' };
  const context = (taskId: string) => ({ owner: 'local-console', workspace, taskId, signal: new AbortController().signal, progress() {} });
  const finish = async (id: string) => {
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) { const [record] = await client.wait([id], 'local-console', workspace, 12000); if (!['starting', 'running'].includes(record.status)) return client.get(id, 'local-console', workspace); }
    await client.cancel(id, 'local-console', workspace); throw new Error('Real provider timed out; no automatic retry');
  };
  const trace = async (record: AgentRecord) => {
    const result: Record<string, any> = { commands: [], changes: [], errors: [], nativeParameters: [], otherToolTypes: [], processStates: [], tokenUsage: [] };
    for (const id of record.turns.flatMap(turn => turn.processSessionIds)) {
      let cursor = 0, stdout = '';
      for (;;) { const page = await client.readOutput(record.id, id, 'local-console', workspace, { cursor, limit: 262144 }); stdout += page.output.filter(entry => entry.stream === 'stdout').map(entry => entry.text).join(''); cursor = page.nextCursor; if (!page.hasMore) { result.processStates.push({ pid: page.session.pid, status: page.session.status }); break; } }
      for (const line of stdout.split('\n')) {
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        const item = message.params?.item;
        if (message.method === 'item/started' && item?.type === 'commandExecution') result.commands.push({ command: item.command, cwd: item.cwd });
        if (message.method === 'item/completed' && item?.type === 'fileChange') result.changes.push(...(item.changes ?? []).map((change: any) => ({ path: change.path, kind: change.kind })));
        if (item && !['commandExecution', 'fileChange', 'agentMessage', 'reasoning', 'plan', 'userMessage', 'contextCompaction'].includes(item.type)) result.otherToolTypes.push(item.type);
        const error = message.error ?? message.params?.error ?? message.params?.turn?.error;
        if (error) result.errors.push({ method: message.method, message: safeError(error.message), willRetry: message.params?.willRetry });
        if (message.result?.model) result.nativeParameters.push({ model: message.result.model, approvalPolicy: message.result.approvalPolicy, sandbox: message.result.sandbox });
        if (message.method === 'thread/tokenUsage/updated') result.tokenUsage.push({ turnHash: typeof message.params?.turnId === 'string' ? hash(message.params.turnId) : undefined, tokenUsage: message.params?.tokenUsage });
      }
    }
    return result;
  };
  try {
    const login = spawnSync(executable, ['login', 'status'], { env: executionEnvironment({ login: true }), encoding: 'utf8', timeout: 15000 });
    const loginText = `${login.stdout ?? ''}\n${login.stderr ?? ''}`;
    assert.ok(login.status === 0 && /Logged in using ChatGPT/i.test(loginText) && !/using an API key/i.test(loginText), 'Existing ChatGPT login was not confirmed; no model call made');
    evidence.loginMode = 'chatgpt'; evidence.cliVersion = execFileSync(executable, ['--version'], { env: executionEnvironment({ login: true }), encoding: 'utf8', timeout: 15000 }).trim();
    await writeFile(path.join(workspace, 'seed.json'), JSON.stringify({ alpha: 17, beta: 25, remember: nonce }));
    evidence.modelTurnsRequested = 1;
    const first = await client.run({ target: 'fixture-writer', prompt: 'Read seed.json. Add alpha and beta. Create result.txt with exactly SUM=<sum> followed by one newline. Remember the remember value for later conversation turns. Reply exactly WROTE=<sum> REMEMBER=<remember value>. Do not inspect any other files.' }, context('real-lifecycle-write'));
    agentId = first.id; const written = await finish(agentId); evidence.write = { status: written.status, response: written.response, error: written.error && safeError(written.error) };
    assert.equal(written.status, 'completed'); assert.ok(written.providerSessionId); assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), 'SUM=42\n'); assert.ok(written.response?.includes(nonce));
    evidence.write.content = 'SUM=42\n'; evidence.write.sha256 = hash(await readFile(path.join(workspace, 'result.txt')));
    // 删除合成种子后，下一回合的校验值只能来自已持久化的原生对话上下文。
    await rm(path.join(workspace, 'seed.json'));
    const before = await client.status(); assert.ok(before.running && before.pid);
    await client.stop(); assert.equal((await client.status()).running, false); assert.equal(isAlive(before.pid!), false); await client.close();
    client = new AgentDaemonClient(state, config);
    const offline = await client.get(agentId, 'local-console', workspace); assert.equal(offline.status, 'completed'); assert.equal(offline.providerSessionId, written.providerSessionId); assert.equal((await client.status()).running, false);
    evidence.modelTurnsRequested = 2;
    await client.continue(agentId, { prompt: 'Append exactly PRODUCT=<19 multiplied by 4> followed by one newline to result.txt, preserving its first line. Reply exactly CONTINUED=<product> REMEMBER=<remember value retained from our previous turn>. The seed file was intentionally removed; use conversation context for the remember value. Do not inspect any other files.' }, context('real-lifecycle-restart-resume'));
    const after = await client.status(); assert.ok(after.running && after.pid !== before.pid);
    const resumed = await finish(agentId); evidence.restart = { oldDaemonPid: before.pid, oldDaemonExited: true, offlineRecordPreserved: true, newDaemonPid: after.pid, status: resumed.status, response: resumed.response, error: resumed.error && safeError(resumed.error), sameNativeSession: resumed.providerSessionId === written.providerSessionId, nativeSessionHash: hash(written.providerSessionId!) };
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.providerSessionId, written.providerSessionId); assert.ok(resumed.response?.includes(nonce)); assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), 'SUM=42\nPRODUCT=76\n');
    evidence.restart.content = 'SUM=42\nPRODUCT=76\n'; evidence.restart.sha256 = hash(await readFile(path.join(workspace, 'result.txt')));
    const script = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('cancel-ready.json',JSON.stringify({pid:process.pid,nonce:${JSON.stringify(probeNonce)}}));setInterval(()=>fs.appendFileSync('heartbeat.log','tick\\n'),50);setTimeout(()=>fs.writeFileSync('cancel-survived.txt','unexpected'),20000);setInterval(()=>{},1000);`;
    await writeFile(path.join(workspace, 'cancel-probe.cjs'), script);
    evidence.modelTurnsRequested = 3;
    await client.continue(agentId, { prompt: `Run exactly this local command in the current directory:\n${JSON.stringify(process.execPath)} cancel-probe.cjs\nKeep the command running and wait for it; the host acceptance harness will cancel the task. Do not kill or background it yourself, do not edit any files, and do not reply with completion while it runs.` }, context('real-lifecycle-cancel'));
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { const ready = JSON.parse(await readFile(path.join(workspace, 'cancel-ready.json'), 'utf8')); assert.equal(ready.nonce, probeNonce); assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 1); probePid = ready.pid; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const current = await client.get(agentId, 'local-console', workspace); if (!['starting', 'running'].includes(current.status)) throw new Error(`Provider ended before the cancellation command was ready: ${current.status} ${current.error ?? ''}`); await pause(100);
    }
    assert.ok(probePid, 'Real provider command became ready');
    const running = await client.get(agentId, 'local-console', workspace), processId = running.turns.at(-1)!.processSessionIds.at(-1)!;
    const provider = (await client.readOutput(agentId, processId, 'local-console', workspace, { limit: 1 })).session;
    const rows = execFileSync('/bin/ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), parents = new Map(rows.map(([pid, parent]) => [pid, parent]));
    const ancestry: number[] = []; let pid = probePid!;
    for (let n = 0; n < 40 && pid > 1; n++) { ancestry.push(pid); if (pid === provider.pid) break; pid = parents.get(pid) ?? 0; }
    assert.ok(ancestry.includes(provider.pid!), 'Only an observed descendant of this provider may be used for cancellation evidence'); probeOwned = true;
    assert.equal(running.status, 'running'); assert.equal(isAlive(probePid!), true);
    const cancelStarted = Date.now(), cancelled = await client.cancel(agentId, 'local-console', workspace);
    const heartbeat = async () => { try { return await readFile(path.join(workspace, 'heartbeat.log')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; } };
    const stoppedHeartbeat = hash(await heartbeat()); await pause(500);
    evidence.cancel = { statusBefore: running.status, statusAfter: cancelled.status, elapsedMs: Date.now() - cancelStarted, observationWindowMs: 500, providerPid: provider.pid, probePid, observedAncestry: ancestry, providerExited: !isAlive(provider.pid!), probeExited: !isAlive(probePid!), heartbeatStopped: stoppedHeartbeat === hash(await heartbeat()), cancelledLastTurn: cancelled.turns.at(-1)?.status };
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.turns.at(-1)?.status, 'cancelled'); assert.ok(evidence.cancel.providerExited && evidence.cancel.probeExited && evidence.cancel.heartbeatStopped); await assert.rejects(readFile(path.join(workspace, 'cancel-survived.txt')), { code: 'ENOENT' });
    const saved = JSON.parse(await readFile(path.join(state, 'agent-sessions', `${agentId}.json`), 'utf8')) as AgentRecord;
    evidence.persisted = { status: saved.status, turns: saved.turns.map(turn => ({ status: turn.status, writeMode: turn.writeMode })), nativeSessionHash: hash(saved.providerSessionId!) };
    assert.deepEqual(saved.turns.map(turn => turn.status), ['completed', 'completed', 'cancelled']); assert.deepEqual(saved.turns.map(turn => turn.writeMode), ['allowed', 'allowed', 'allowed']);
    const protocol = await trace(saved); evidence.protocol = protocol;
    assert.equal(protocol.otherToolTypes.length, 0, 'Only local command and file tools were used');
    for (const command of protocol.commands) { assert.equal(command.cwd, workspace); assert.doesNotMatch(command.command, /\b(?:curl|wget|ssh|scp|https?:\/\/|git\s+(?:clone|fetch|push)|npm\s+install)\b/i); }
    for (const change of protocol.changes) assert.ok(path.resolve(workspace, change.path).startsWith(workspace + path.sep));
    for (const parameters of protocol.nativeParameters) { assert.equal(parameters.approvalPolicy, 'never'); assert.equal(parameters.sandbox.type, 'workspaceWrite'); }
    evidence.workspaceFiles = await readdir(workspace); evidence.resultFileUnchangedByCancellation = (await readFile(path.join(workspace, 'result.txt'), 'utf8')) === 'SUM=42\nPRODUCT=76\n'; assert.equal(evidence.resultFileUnchangedByCancellation, true);
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = safeError(error); if (agentId) { try { const record = await client.get(agentId, 'local-console', workspace); evidence.lastStatus = record.status; evidence.lastError = record.error && safeError(record.error); evidence.protocol = await trace(record); } catch (traceError) { evidence.traceError = safeError(traceError); } } throw error; }
  finally {
    try { await client.stop(true); } catch (error) { evidence.cleanupError = safeError(error); }
    await client.close();
    if (probeOwned && probePid && isAlive(probePid)) { evidence.emergencyOwnedProbeCleanup = true; process.kill(probePid, 'SIGKILL'); for (let n = 0; n < 50 && isAlive(probePid); n++) await pause(20); }
    await rm(root, { recursive: true, force: true }); evidence.fixtureRemoved = true;
    const filename = process.env.CAPYRA_REAL_CODEX_LIFECYCLE_EVIDENCE;
    if (filename) { await mkdir(path.dirname(path.resolve(filename)), { recursive: true }); await writeFile(filename, JSON.stringify(evidence, null, 2) + '\n'); }
  }
});
