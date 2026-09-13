import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { ProcessSessions } from '../src/execution/sessions.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-sessions-')), state = path.join(root, 'state');
  const sessions = new ProcessSessions(state, options);
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const start = (code: string, extra = {}) => sessions.start({ owner: 'alice', workspace: root, cwd: root, taskId: 'task', command: process.execPath, args: ['-e', code], ...extra });
  return { root, state, sessions, start };
}
test('background sessions return immediately, accept stdin, page output and isolate owners/workspaces', async t => {
  const { sessions, root, start } = await fixture(t);
  const record = await start('process.stdout.write("ready\\n");process.stdin.on("data",data=>{process.stdout.write("echo:"+data);process.exit(0)})');
  assert.equal(record.status, 'running');
  const first = await sessions.read(record.id, 'alice', root, { waitMs: 1000 });
  assert.equal(first.output.map(entry => entry.text).join(''), 'ready\n');
  assert.throws(() => sessions.get(record.id, 'bob', root), /Unknown/);
  assert.throws(() => sessions.get(record.id, 'alice', root + '/different'), /Unknown/);
  await assert.rejects(sessions.write(record.id, 'bob', root, 'attack'), /Unknown/);
  await sessions.write(record.id, 'alice', root, 'hello\n');
  const ended = await sessions.wait(record.id, 'alice', root);
  assert.equal(ended.status, 'completed');
  const second = await sessions.read(record.id, 'alice', root, { cursor: first.nextCursor });
  assert.equal(second.output.map(entry => entry.text).join(''), 'echo:hello\n');
  assert.equal(second.hasMore, false);
});
test('disk logs and terminal states survive restart without replaying an action', async t => {
  const { sessions, root, state, start } = await fixture(t);
  const record = await start('require("node:fs").appendFileSync("effects","once\\n");process.stdout.write("retained")');
  await sessions.wait(record.id, 'alice', root); await sessions.close();
  const restored = new ProcessSessions(state); t.after(() => restored.close());
  assert.equal(restored.get(record.id, 'alice', root).status, 'completed');
  assert.equal((await restored.read(record.id, 'alice', root)).output[0].text, 'retained');
  assert.equal(await readFile(path.join(root, 'effects'), 'utf8'), 'once\n');
  const stale = { ...record, status: 'running' };
  await writeFile(path.join(state, 'process-sessions', `${record.id}.json`), JSON.stringify(stale));
  const recovered = new ProcessSessions(state); t.after(() => recovered.close());
  assert.equal(recovered.get(record.id, 'alice', root).status, 'interrupted');
  assert.match(recovered.get(record.id, 'alice', root).error!, /not replayed/);
});
test('output rotation is bounded and explicitly reports a stale cursor', async t => {
  const { sessions, root, start } = await fixture(t, { maxLogBytes: 1000 });
  const record = await start('let n=0;const timer=setInterval(()=>{process.stdout.write(String(n)+":"+"x".repeat(800)+"\\n");if(++n===30){clearInterval(timer)}},2)');
  await sessions.wait(record.id, 'alice', root);
  const page = await sessions.read(record.id, 'alice', root);
  assert.equal(page.outputTruncated, true); assert.ok(page.firstCursor > 1);
  assert.match(page.output.at(-1)!.text, /29:/);
  await assert.rejects(sessions.read(record.id, 'alice', root, { cursor: -1 }), /Invalid/);
});
test('closing service terminates children and timeout returns timed_out', async t => {
  const { sessions, root, start } = await fixture(t);
  const timed = await start('setInterval(()=>{},1000)', { timeoutMs: 40 });
  assert.equal((await sessions.wait(timed.id, 'alice', root)).status, 'timed_out');
  const live = await start('setInterval(()=>{},1000)');
  await sessions.close(); assert.equal(sessions.get(live.id, 'alice', root).status, 'interrupted');
  if (process.platform !== 'win32') assert.throws(() => process.kill(live.pid!, 0), /ESRCH/);
});
test('stop waits for descendants including detached foreground-style groups', async t => {
  if (process.platform === 'win32') return;
  try { execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pid=']); } catch { t.skip('OS sandbox prevents process-tree inspection; verified in unrestricted local run'); return; }
  const { sessions, root, start } = await fixture(t);
  const record = await start('const child=require("node:child_process").spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'],{detached:true,stdio:"ignore"});process.stdout.write(String(child.pid));setInterval(()=>{},1000)');
  const page = await sessions.read(record.id, 'alice', root, { waitMs: 2000 });
  const pid = Number(page.output[0].text); assert.ok(pid > 0);
  t.after(async () => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 50));
  await sessions.stop(record.id, 'alice', root);
  let state = '';
  try { state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); } catch {}
  assert.ok(!state || /^[ZX]/.test(state), `descendant is still running: ${state}`);
});

test('owner revocation cancels detached work while local console sessions remain', async t => {
  const { sessions, root, start } = await fixture(t);
  const remote = await start('setInterval(()=>{},1000)');
  const local = await start('setInterval(()=>{},1000)', { owner: 'local-console' });
  await sessions.cancelOwner();
  assert.equal(sessions.get(remote.id, 'alice', root).status, 'cancelled');
  assert.equal(sessions.get(local.id, 'local-console', root).status, 'running');
  assert.equal(sessions.listLocal(root).length, 2);
});

test('EPERM for an already empty process group is verified before cancellation completes', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group handling'); return; }
  try { execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pid=']); } catch { t.skip('OS sandbox prevents process-group inspection'); return; }
  const { sessions, root, start } = await fixture(t), record = await start('setInterval(()=>{},1000)');
  const original = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === -record.pid! && signal === 'SIGKILL') throw Object.assign(new Error('simulated empty-group EPERM'), { code: 'EPERM' });
    return original(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  try { assert.equal((await sessions.stop(record.id, 'alice', root)).status, 'cancelled'); }
  finally { process.kill = original; }
});

const processState = (pid: number) => {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim(); }
  catch (error) { if ((error as { status?: number }).status === 1) return ''; throw error; }
};
const exited = (state: string) => !state || /^[ZX]/.test(state);
async function removeTestChild(pid: number) {
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 50 && !exited(processState(pid)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(exited(processState(pid)), 'owned test child exited during cleanup');
}
function canInspectProcesses(t: { skip(reason: string): void }) {
  if (process.platform === 'win32') { t.skip('POSIX process-group handling'); return false; }
  try { processState(process.pid); return true; }
  catch { t.skip('OS sandbox prevents process-group inspection'); return false; }
}
const childTree = (detached: boolean) => `const child=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],{detached:${detached},stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000)`;

test('EPERM while the final descendant is exiting waits for verified group termination', async t => {
  if (!canInspectProcesses(t)) return;
  const { sessions, root, start } = await fixture(t), record = await start(childTree(false));
  const childPid = Number((await sessions.read(record.id, 'alice', root, { waitMs: 2000 })).output[0]?.text);
  assert.ok(childPid > 0);
  const original = process.kill; let pendingKill: NodeJS.Timeout | undefined, observedLiveGroup = false;
  process.kill = ((pid: number, signal?: string | number) => {
    // 把内核尚未处理完 SIGKILL 的窗口固定下来；仅延迟本测试捕获的后代。
    if (pid === childPid && signal === 'SIGKILL') { pendingKill ??= setTimeout(() => { try { original(pid, 'SIGKILL'); } catch {} }, 120); return true; }
    if (pid === -record.pid! && signal === 'SIGKILL') { observedLiveGroup = !exited(processState(childPid)); throw Object.assign(new Error('simulated exiting-group EPERM'), { code: 'EPERM' }); }
    return original(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  try {
    assert.equal((await sessions.stop(record.id, 'alice', root)).status, 'cancelled');
    assert.ok(observedLiveGroup, 'group signal encountered the live-to-exited transition');
    assert.ok(exited(processState(childPid)), 'stop waited for the captured descendant to exit');
  } finally { process.kill = original; clearTimeout(pendingKill); await removeTestChild(childPid); }
});

test('EPERM for a live process group remains a cancellation error', async t => {
  if (!canInspectProcesses(t)) return;
  const { sessions, root, start } = await fixture(t), record = await start('process.stdout.write("ready");setInterval(()=>{},1000)');
  await sessions.read(record.id, 'alice', root, { waitMs: 2000 });
  const original = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === -record.pid! && (signal === 'SIGTERM' || signal === 'SIGKILL')) throw Object.assign(new Error('simulated live-group EPERM'), { code: 'EPERM' });
    return original(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  try { await assert.rejects(sessions.stop(record.id, 'alice', root), /live-group EPERM/); assert.ok(!exited(processState(record.pid!))); }
  finally { process.kill = original; await sessions.stop(record.id, 'alice', root); }
});

test('a detached descendant that refuses termination cannot be reported as stopped', async t => {
  if (!canInspectProcesses(t)) return;
  const { sessions, root, start } = await fixture(t), record = await start(childTree(true));
  const childPid = Number((await sessions.read(record.id, 'alice', root, { waitMs: 2000 })).output[0]?.text);
  assert.ok(childPid > 0);
  const original = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === childPid && (signal === 'SIGTERM' || signal === 'SIGKILL')) throw Object.assign(new Error('simulated detached-child EPERM'), { code: 'EPERM' });
    return original(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  try {
    await assert.rejects(sessions.stop(record.id, 'alice', root), /descendant.*still running/i);
    assert.ok(!exited(processState(childPid)));
    assert.equal(sessions.get(record.id, 'alice', root).status, 'failed');
    assert.match(sessions.get(record.id, 'alice', root).error!, /descendant.*still running/i);
  }
  finally { process.kill = original; await removeTestChild(childPid); }
});
