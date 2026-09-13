import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessSessions } from '../src/execution/sessions.js';
import terminal from '../src/plugins/terminal.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

test('terminal extension is optional and missing installation starts no process', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-terminal-missing-'));
  const sessions = new ProcessSessions(path.join(root, 'state'));
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const status = await sessions.ptyStatus();
  if (status.available) { t.skip('PTY is available from parent installation'); return; }
  await assert.rejects(sessions.start({ command: '/bin/sh', cwd: root, workspace: root, owner: 'alice', taskId: 'one', tty: true }), /optional node-pty/);
  assert.equal(sessions.list('alice', root).length, 0);
});
test('real PTY preserves shell state, resizes, interrupts foreground jobs, and closes', async t => {
  const installed = process.env.CAPYRA_TEST_PTY_MODULES;
  if (!installed) { t.skip('Set CAPYRA_TEST_PTY_MODULES to an installed node-pty@1.1.0 node_modules directory for real PTY acceptance'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-terminal-real-')), state = path.join(root, 'state');
  await mkdir(path.join(state, 'extensions', 'terminal'), { recursive: true });
  await symlink(installed, path.join(state, 'extensions', 'terminal', 'node_modules'));
  const sessions = new ProcessSessions(state), tools = new Map<string, ToolDefinition>(), disposers: (() => void | Promise<void>)[] = [];
  const context: PluginContext = { workspace: root, stateDir: state, config: { shell: '/bin/sh' }, registerTool(tool) { tools.set(tool.name, tool); return () => {}; }, provide() {}, service<T>() { return sessions as T; }, guard() {}, onEvent() {}, onDispose(fn) { disposers.push(fn); } };
  await terminal.setup(context);
  t.after(async () => { for (const dispose of disposers) await dispose(); await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const ctx: ToolContext = { workspace: root, owner: 'alice', taskId: 'terminal', signal: new AbortController().signal, progress() {} };
  const invoke = async (name: string, args: Record<string, unknown>) => JSON.parse(((await tools.get(name)!.execute(args, ctx)).content[0] as { text: string }).text);
  const opened = await invoke('open', { columns: 91, rows: 31 }); const id = opened.session.id;
  await invoke('write', { sessionId: id, text: 'export CAPYRA_TTY_VALUE=kept\n' });
  await invoke('resize', { sessionId: id, columns: 110, rows: 40 });
  await invoke('write', { sessionId: id, text: 'printf "VALUE:%s\\n" "$CAPYRA_TTY_VALUE"; stty size\n' });
  let output = '', cursor = 0;
  for (let attempt = 0; attempt < 50 && !output.includes('40 110'); attempt++) { const page = await invoke('read', { sessionId: id, cursor, waitMs: 100 }); cursor = page.nextCursor; output += page.output.map((entry: { text: string }) => entry.text).join(''); }
  assert.match(output, /VALUE:kept/); assert.match(output, /40 110/);
  await invoke('write', { sessionId: id, text: 'sleep 30\n' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await invoke('write', { sessionId: id, text: '\x03' });
  await invoke('write', { sessionId: id, text: 'printf "AFTER_INTERRUPT\\n"\n' });
  for (let attempt = 0; attempt < 50 && !output.includes('AFTER_INTERRUPT\r\n'); attempt++) { const page = await invoke('read', { sessionId: id, cursor, waitMs: 100 }); cursor = page.nextCursor; output += page.output.map((entry: { text: string }) => entry.text).join(''); }
  assert.match(output, /AFTER_INTERRUPT\r?\n/);
  assert.equal((await invoke('close', { sessionId: id })).session.status, 'cancelled');
});

test('verified terminal extension installs from the pinned official dependency lock', async t => {
  if (process.env.CAPYRA_TEST_INSTALL_PTY !== '1') { t.skip('Set CAPYRA_TEST_INSTALL_PTY=1 for official registry installation acceptance'); return; }
  const { installTerminalExtension, terminalExtension } = await import('../src/execution/terminal-extension.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-terminal-install-')), state = path.join(root, 'state');
  const sessions = new ProcessSessions(state);
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const result = await installTerminalExtension(sessions, state, { owner: 'local-console', workspace: root, taskId: 'install', signal: new AbortController().signal, progress() {} });
  assert.equal(result.available, true); assert.equal(result.integrity, terminalExtension.integrity);
  const terminal = await sessions.start({ command: '/bin/sh', args: ['-c', 'tty'], owner: 'local-console', workspace: root, taskId: 'pty', cwd: root, tty: true });
  assert.equal((await sessions.wait(terminal.id, 'local-console', root)).status, 'completed');
  assert.match((await sessions.read(terminal.id, 'local-console', root)).output.map(entry => entry.text).join(''), /\/dev\//);
});
