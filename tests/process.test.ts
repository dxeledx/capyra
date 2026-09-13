import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/plugins/process.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, commands: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-process-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const tools = new Map<string, ToolDefinition>();
  const disposers: (() => void | Promise<void>)[] = [];
  const context: PluginContext = {
    workspace, stateDir: path.join(root, 'state'), config: { commands },
    registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    provide() {}, service() { throw new Error('unused'); }, guard() {}, onEvent() {}, onDispose(dispose) { disposers.push(dispose); },
  };
  await plugin.setup(context);
  t.after(async () => { for (const dispose of disposers) await dispose(); await rm(root, { recursive: true, force: true }); });
  const ctx: ToolContext = { workspace, taskId: 'test', signal: new AbortController().signal, progress() {} };
  const run = (args: Record<string, unknown>, current = ctx) => tools.get('run')!.execute(args, current);
  return { root, workspace, tools, ctx, run };
}
const nodeCommand = (code: string, timeoutMs = 5000) => ({ command: process.execPath, args: ['-e', code], timeoutMs });
const parse = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);

test('only named commands run and shell characters remain literal arguments', async t => {
  const f = await fixture(t, { literal: { command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '$(touch should-not-exist); echo injected'] } });
  const list = parse(await f.tools.get('list_commands')!.execute({}, f.ctx));
  assert.equal(list.commands[0].id, 'literal');
  await assert.rejects(f.run({ id: 'missing' }), /Unknown configured command/);
  await assert.rejects(f.run({ id: 'literal', args: ['extra'] }), /only a configured command ID/);
  const result = parse(await f.run({ id: 'literal' }));
  assert.equal(result.stdout, '$(touch should-not-exist); echo injected');
  await assert.rejects(readFile(path.join(f.workspace, 'should-not-exist')), /ENOENT/);
});

test('command environment excludes credentials and NODE_OPTIONS', async t => {
  const previous = process.env.CAPYRA_TEST_SECRET;
  process.env.CAPYRA_TEST_SECRET = 'not-for-children';
  t.after(async () => { if (previous === undefined) delete process.env.CAPYRA_TEST_SECRET; else process.env.CAPYRA_TEST_SECRET = previous; });
  const f = await fixture(t, { environment: nodeCommand('process.stdout.write(JSON.stringify({secret:process.env.CAPYRA_TEST_SECRET,nodeOptions:process.env.NODE_OPTIONS,path:!!process.env.PATH}))') });
  assert.deepEqual(JSON.parse(parse(await f.run({ id: 'environment' })).stdout), { path: true });
});

test('nonzero exits and missing executables report failures', async t => {
  const f = await fixture(t, { fail: nodeCommand('process.stderr.write("expected failure"); process.exitCode=7'), missing: { command: '/definitely-missing-capyra-command', args: [] } });
  const result = await f.run({ id: 'fail' });
  assert.equal(result.isError, true);
  assert.equal(parse(result).exitCode, 7);
  assert.equal(parse(result).stderr, 'expected failure');
  await assert.rejects(f.run({ id: 'missing' }), /Unable to start/);
});

test('combined stdout and stderr capture remains within 64 KiB', async t => {
  const f = await fixture(t, { noisy: nodeCommand('process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000))') });
  const result = parse(await f.run({ id: 'noisy' }));
  assert.equal(result.truncated, true);
  assert.equal(result.capturedBytes, 65536);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 65536);
});

test('configured cwd rejects traversal and symlink escape', async t => {
  const f = await fixture(t, { traversal: { ...nodeCommand(''), cwd: '..' }, shortcut: { ...nodeCommand(''), cwd: 'shortcut' } });
  await symlink(f.root, path.join(f.workspace, 'shortcut'));
  await assert.rejects(f.run({ id: 'traversal' }), /traversal/);
  await assert.rejects(f.run({ id: 'shortcut' }), /Symbolic links/);
});

test('timeout stops a command and cancellation kills its descendant process group', async t => {
  const f = await fixture(t, {
    timeout: nodeCommand('setInterval(()=>{},1000)', 60),
    tree: nodeCommand(`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync("survived.txt","bad"),800);setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('ready.txt',String(child.pid));setInterval(()=>{},1000)`),
  });
  const timeout = await f.run({ id: 'timeout' });
  assert.equal(timeout.isError, true);
  assert.equal(parse(timeout).timedOut, true);
  if (process.platform === 'win32') return;
  const controller = new AbortController();
  const running = f.run({ id: 'tree' }, { ...f.ctx, signal: controller.signal });
  // 等待子进程实际启动后取消，覆盖父进程先退出、孙进程忽略 SIGTERM 的分支。
  const cancellation = assert.rejects(running, /cancelled/);
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { childPid = Number(await readFile(path.join(f.workspace, 'ready.txt'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(childPid, 'child process started');
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort();
  await cancellation;
  await new Promise(resolve => setTimeout(resolve, 850));
  await assert.rejects(readFile(path.join(f.workspace, 'survived.txt')), /ENOENT/);
});
