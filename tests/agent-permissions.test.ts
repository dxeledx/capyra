import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { acpArguments, acpPermission, agentWriteMode, claudeAuthority, codexSandbox, opencodePermissions } from '../src/execution/agent-permissions.js';
import { AgentManager } from '../src/execution/agent-manager.js';
import { ProcessSessions } from '../src/execution/sessions.js';
import { piWorkspacePath, restrictedPiTools } from '../src/execution/pi-permissions.js';
import type { AgentRunInput } from '../src/execution/agent-drivers.js';

test('native modes map to provider-enforced permissions and never treat an unknown mode as full access', () => {
  assert.equal(agentWriteMode(undefined), 'allowed'); assert.throws(() => agentWriteMode('read-only'), /writeMode/);
  assert.deepEqual(codexSandbox('read_only', '/repo'), { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } });
  assert.equal(codexSandbox('allowed', '/repo').sandboxPolicy.networkAccess, true);
  assert.equal(codexSandbox('full_access', '/repo').sandbox, 'danger-full-access');
  const readonly = claudeAuthority('read_only', '/repo'); assert.deepEqual(readonly.allowedTools, ['Read(/**)']); assert.deepEqual(readonly.settings.permissions.deny, ['Bash', 'Edit', 'Write']);
  assert.equal(readonly.sandbox.failIfUnavailable, true); assert.deepEqual(readonly.sandbox.filesystem?.denyWrite, ['/repo']);
  const full = claudeAuthority('full_access', '/repo'); assert.equal(full.permissionMode, 'bypassPermissions'); assert.equal(full.sandbox.enabled, false);
  assert.deepEqual(opencodePermissions('read_only'), { read: 'allow', edit: 'deny', glob: 'allow', grep: 'allow', list: 'allow', bash: 'deny', task: 'deny', external_directory: 'deny' });
  assert.equal(opencodePermissions('allowed').external_directory, 'deny'); assert.equal(opencodePermissions('full_access').external_directory, 'allow');
});
test('ACP uses sandbox/plan flags and denies restricted Copilot escalations', () => {
  assert.deepEqual(acpArguments('cursor', 'read_only', '/repo'), ['acp', '--sandbox', 'enabled', '--workspace', '/repo', '--mode', 'plan']);
  assert.ok(acpArguments('cursor', 'full_access', '/repo').includes('--force'));
  assert.ok(acpArguments('copilot', 'read_only', '/repo').includes('--sandbox'));
  assert.ok(acpArguments('copilot', 'full_access', '/repo').includes('--no-sandbox'));
  const options = [{ optionId: 'reject', kind: 'reject_once' }, { optionId: 'allow', kind: 'allow_once' }];
  assert.equal(acpPermission('cursor', 'read_only', options).outcome.optionId, 'reject');
  assert.equal(acpPermission('grok', 'allowed', options).outcome.optionId, 'allow');
  assert.equal(acpPermission('copilot', 'allowed', options).outcome.outcome, 'cancelled');
  assert.equal(acpPermission('copilot', 'full_access', options).outcome.optionId, 'allow');
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-permissions-')), workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const sessions = new ProcessSessions(path.join(root, 'state'));
  const ctx = { owner: 'alice', workspace, taskId: 'permissions', signal: new AbortController().signal, progress() {} };
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const input: AgentRunInput = { ...ctx, id: 'agent', cwd: workspace, target: { id: 'pi', provider: 'pi' }, prompt: 'test', onSession() {}, onProcess() {}, onText() {} };
  return { root, workspace, sessions, ctx, input };
}
function fakeSdk() {
  const factory = (name: string) => (_cwd: string, { operations }: any) => ({ name, parameters: { type: 'object' }, async execute(_id: string, args: any, signal?: AbortSignal) {
    if (name === 'read') return operations.readFile(args.path);
    if (name === 'write') return operations.writeFile(args.path, args.content);
    if (name === 'bash') return operations.exec(args.command, args.cwd, { signal, onData() {} });
    return operations;
  } });
  return { createReadTool: factory('read'), createGrepTool: factory('grep'), createFindTool: factory('find'), createLsTool: factory('ls'), createWriteTool: factory('write'), createEditTool: factory('edit'), createBashTool: factory('bash') };
}
test('restricted Pi installs only permitted tools and checks real filesystem boundaries', async t => {
  const f = await fixture(t); await writeFile(path.join(f.workspace, 'readme'), 'inside'); await writeFile(path.join(f.root, 'outside'), 'secret'); await symlink(f.root, path.join(f.workspace, 'shortcut'));
  const events: string[] = [];
  const sandbox = { SandboxManager: { async initialize() { events.push('initialize'); }, async reset() { events.push('reset'); }, async wrapWithSandboxArgv() { throw new Error('should not execute'); }, cleanupAfterCommand() {} } };
  const readonly = await restrictedPiTools(fakeSdk(), sandbox, f.sessions, { ...f.input, writeMode: 'read_only' });
  assert.deepEqual(readonly.tools!.map(tool => tool.name).sort(), ['find', 'grep', 'ls', 'read']);
  const reader = readonly.tools!.find(tool => tool.name === 'read')!;
  assert.equal(String(await reader.execute('one', { path: 'readme' })), 'inside');
  await assert.rejects(reader.execute('two', { path: path.join(f.root, 'outside') }), /outside/);
  await assert.rejects(reader.execute('three', { path: 'shortcut/outside' }), /symbolic/);
  await readonly.release(); assert.deepEqual(events, ['initialize', 'reset']);
  const allowed = await restrictedPiTools(fakeSdk(), sandbox, f.sessions, { ...f.input, writeMode: 'allowed' });
  const writer = allowed.tools!.find(tool => tool.name === 'write')!;
  await writer.execute('write', { path: 'created', content: 'ok' }); assert.equal(await readFile(path.join(f.workspace, 'created'), 'utf8'), 'ok');
  await assert.rejects(writer.execute('escape', { path: path.join(f.root, 'outside'), content: 'bad' }), /outside/);
  await assert.rejects(piWorkspacePath('.capyra/credentials', f.workspace, true), /protected/);
  await allowed.release();
});
test('Pi sandbox initialization failure does not create tools or start an unsandboxed process', async t => {
  const f = await fixture(t);
  const sandbox = { SandboxManager: { async initialize() { throw new Error('sandbox unavailable'); }, async reset() {}, wrapWithSandboxArgv() {}, cleanupAfterCommand() {} } };
  await assert.rejects(restrictedPiTools(fakeSdk(), sandbox, f.sessions, { ...f.input, writeMode: 'allowed' }), /could not initialize/);
  assert.equal(f.sessions.listLocal().length, 0);
});
test('allowed Pi command executes only the sandbox runtime argv and releases the runtime', async t => {
  const f = await fixture(t), captured: any[] = [];
  const sandbox = { SandboxManager: { async initialize(config: unknown) { captured.push(config); }, async reset() { captured.push('reset'); },
    async wrapWithSandboxArgv(command: string, _shell: unknown, config: unknown) { captured.push({ command, config }); return { argv: [process.execPath, '-e', 'process.stdout.write("wrapped")'], env: {} }; }, cleanupAfterCommand() { captured.push('cleanup'); } } };
  const permission = await restrictedPiTools(fakeSdk(), sandbox, f.sessions, { ...f.input, writeMode: 'allowed' });
  const bash = permission.tools!.find(tool => tool.name === 'bash')!;
  assert.equal((await bash.execute('bash', { command: 'do not execute this unwrapped', cwd: f.workspace })).exitCode, 0);
  assert.equal((captured[1] as any).command, 'do not execute this unwrapped');
  assert.deepEqual((captured[1] as any).config.filesystem.allowWrite, [f.workspace]);
  assert.equal(f.sessions.listLocal()[0].command, process.execPath);
  await permission.release(); assert.deepEqual(captured.slice(-2), ['cleanup', 'reset']);
});
test('role writeMode defaults, explicit continuation and disk restoration preserve actual mode', async t => {
  const f = await fixture(t), manager = new AgentManager(f.sessions, path.join(f.root, 'state'), { profileDirs: [], roles: { reviewer: { provider: 'codex', writeMode: 'read_only' } } }); t.after(() => manager.close());
  const modes: string[] = [];
  manager.drivers.set('codex', { async run(input) { modes.push(input.writeMode!); input.onSession('native'); return { providerSessionId: 'native', response: 'done' }; } });
  const started = await manager.run({ target: 'reviewer', prompt: 'review' }, f.ctx); await manager.wait([started.id], 'alice', f.workspace);
  await manager.continue(started.id, { prompt: 'modify', writeMode: 'allowed' }, f.ctx); await manager.wait([started.id], 'alice', f.workspace);
  await manager.continue(started.id, { prompt: 'continue' }, f.ctx); await manager.wait([started.id], 'alice', f.workspace);
  assert.deepEqual(modes, ['read_only', 'allowed', 'allowed']);
  const restored = new AgentManager(undefined, path.join(f.root, 'state'), {}, { readOnly: true });
  assert.equal(restored.get(started.id, 'alice', f.workspace).writeMode, 'allowed');
  assert.deepEqual(restored.get(started.id, 'alice', f.workspace).turns.map(turn => turn.writeMode), modes);
  await assert.rejects(manager.run({ target: 'reviewer', prompt: 'bad', writeMode: 'invalid' as any }, f.ctx), /writeMode/);
});

test('installed Pi SDK and OS sandbox enforce workspace writes without a model call', async t => {
  const extensions = process.env.CAPYRA_TEST_PI_EXTENSIONS;
  if (!extensions) { t.skip('Set CAPYRA_TEST_PI_EXTENSIONS to a real Pi + sandbox-runtime installation for native sandbox acceptance'); return; }
  const { resolveExtension } = await import('../src/execution/extension-resolver.js');
  const { pathToFileURL } = await import('node:url');
  // 放在工程内而不是系统临时目录，避免OS沙箱默认允许临时目录写入掩盖边界错误。
  const root = await mkdtemp(path.join(process.cwd(), '.capyra-tmp-pi-sandbox-')), workspace = path.join(root, 'workspace'), state = path.join(root, 'state');
  await mkdir(workspace); await mkdir(path.join(state, 'extensions', 'pi'), { recursive: true });
  await symlink(path.join(extensions, 'node_modules'), path.join(state, 'extensions', 'pi', 'node_modules'));
  const sessions = new ProcessSessions(state);
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const sdk = await import(pathToFileURL(resolveExtension(state, 'pi', '@earendil-works/pi-coding-agent')).href);
  const sandbox = await import(pathToFileURL(resolveExtension(state, 'pi', '@anthropic-ai/sandbox-runtime')).href);
  const input: AgentRunInput = { id: 'native-pi', taskId: 'native-pi', owner: 'local-console', workspace, cwd: workspace, target: { id: 'pi', provider: 'pi' }, prompt: '', writeMode: 'allowed', signal: new AbortController().signal, onSession() {}, onProcess() {}, onText() {} };
  const permission = await restrictedPiTools(sdk, sandbox, sessions, input); t.after(() => permission.release());
  const writer = permission.tools!.find(tool => tool.name === 'write')!;
  await writer.execute('write', { path: 'inside.txt', content: 'inside' }, input.signal);
  assert.equal(await readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
  await assert.rejects(writer.execute('outside', { path: path.join(root, 'outside.txt'), content: 'outside' }, input.signal), /outside/);
  const bash = permission.tools!.find(tool => tool.name === 'bash')!;
  await bash.execute('allowed', { command: 'printf sandbox-ok > command.txt' }, input.signal);
  assert.equal(await readFile(path.join(workspace, 'command.txt'), 'utf8'), 'sandbox-ok');
  const destination = path.join(root, 'outside-command.txt').replaceAll("'", "'\\''");
  await assert.rejects(bash.execute('denied', { command: `printf escaped > '${destination}'` }, input.signal), /code|denied|permitted|sandbox/i);
  await assert.rejects(readFile(path.join(root, 'outside-command.txt')), { code: 'ENOENT' });
  const agentDir = path.join(root, 'native-state'); await mkdir(agentDir);
  const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json')), modelRegistry = sdk.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
  const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, authStorage, modelRegistry, sessionManager: sdk.SessionManager.inMemory(workspace), tools: permission.tools!.map(tool => tool.name), customTools: permission.tools });
  assert.deepEqual(session.getActiveToolNames().sort(), permission.tools!.map(tool => tool.name).sort());
  session.dispose();
  await permission.release();
});

test('a rejected continuation cannot change the saved permission mode', async t => {
  const f = await fixture(t), manager = new AgentManager(f.sessions, path.join(f.root, 'state'), { profileDirs: [] }); t.after(() => manager.close());
  manager.drivers.set('codex', { async run(input) { input.onSession('native'); return { providerSessionId: 'native', response: 'done' }; } });
  const started = await manager.run({ target: 'codex', prompt: 'read', writeMode: 'read_only' }, f.ctx); await manager.wait([started.id], 'alice', f.workspace);
  await assert.rejects(manager.continue(started.id, { prompt: '', writeMode: 'full_access' }, f.ctx), /nonempty/);
  assert.equal(manager.get(started.id, 'alice', f.workspace).writeMode, 'read_only');
});

test('continuation revalidates a saved cwd before changing permissions or starting another turn', async t => {
  const f = await fixture(t), directory = path.join(f.workspace, 'nested'); await mkdir(directory);
  const manager = new AgentManager(f.sessions, path.join(f.root, 'state'), { profileDirs: [] }); t.after(() => manager.close());
  let turns = 0;
  manager.drivers.set('codex', { async run(input) { turns++; input.onSession('native'); return { providerSessionId: 'native', response: 'done' }; } });
  const started = await manager.run({ target: 'codex', prompt: 'read', cwd: 'nested', writeMode: 'read_only' }, f.ctx); await manager.wait([started.id], 'alice', f.workspace);
  await rename(directory, path.join(f.workspace, 'previous-nested')); await symlink(f.root, directory);
  await assert.rejects(manager.continue(started.id, { prompt: 'continue', writeMode: 'full_access' }, f.ctx), /Symbolic links/);
  assert.equal(turns, 1); assert.equal(manager.get(started.id, 'alice', f.workspace).turns.length, 1); assert.equal(manager.get(started.id, 'alice', f.workspace).writeMode, 'read_only');
});

test('role changes after preview are rejected before dispatch or continuation changes state', async t => {
  const f = await fixture(t), profiles = path.join(f.root, 'profiles'); await mkdir(profiles);
  const role = path.join(profiles, 'reviewer.md');
  const content = (mode: string, body: string) => `---\nprovider: codex\ndescription: Review\nwriteMode: ${mode}\n---\n${body}`;
  await writeFile(role, content('read_only', 'Original role'));
  const manager = new AgentManager(f.sessions, path.join(f.root, 'state'), { profileDirs: [profiles] }); t.after(() => manager.close());
  let invocations = 0;
  manager.drivers.set('codex', { async run(input) { invocations++; input.onSession('native'); return { providerSessionId: 'native', response: 'done' }; } });
  const preview = manager.preview('reviewer', f.workspace);
  await writeFile(role, content('full_access', 'Changed role'));
  await assert.rejects(manager.run({ target: 'reviewer', prompt: 'review', writeMode: preview.writeMode, expectedTargetHash: preview.targetHash }, f.ctx), /changed after preview/);
  assert.equal(invocations, 0); assert.equal(manager.list('alice', f.workspace).length, 0);
  const current = manager.preview('reviewer', f.workspace);
  const record = await manager.run({ target: 'reviewer', prompt: 'review', writeMode: 'read_only', expectedTargetHash: current.targetHash }, f.ctx); await manager.wait([record.id], 'alice', f.workspace);
  const continuedPreview = manager.preview('reviewer', f.workspace);
  await writeFile(role, content('full_access', 'Another role change'));
  await assert.rejects(manager.continue(record.id, { prompt: 'continue', writeMode: 'full_access', expectedTargetHash: continuedPreview.targetHash }, f.ctx), /changed after preview/);
  assert.equal(manager.get(record.id, 'alice', f.workspace).writeMode, 'read_only');
  assert.equal(manager.get(record.id, 'alice', f.workspace).turns.length, 1); assert.equal(invocations, 1);
});
