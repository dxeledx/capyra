import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import plugin from '../src/plugins/git.js';
import { sha256 } from '../src/plugins/workspace-paths.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';
const exec = promisify(execFile);
const hash = (text: string) => sha256(Buffer.from(text));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'capyra-git-')); const root = path.join(temporary, 'project');
  await mkdir(root); t.after(() => rm(temporary, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'Capyra Test'); await git('config', 'user.email', 'capyra@example.test');
  await writeFile(path.join(root, 'note.txt'), 'initial\n'); await git('add', 'note.txt'); await git('commit', '-qm', 'Initial commit');
  const initial = await git('rev-parse', 'HEAD');
  const tools = new Map<string, ToolDefinition>();
  const context: PluginContext = { workspace: root, stateDir: path.join(temporary, 'state'), config: {}, provide() {}, service() { throw new Error('unused'); }, registerTool(tool) { tools.set(tool.name, tool); return () => {}; }, guard() {}, onEvent() {}, onDispose() {} };
  await plugin.setup(context);
  const ctx = { workspace: root, taskId: 'test', owner: 'alice', signal: new AbortController().signal, progress() {} } as ToolContext;
  const call = async (name: string, args: Record<string, unknown> = {}, toolContext = ctx) => { const result = await tools.get(name)!.execute(args, toolContext); return JSON.parse((result.content[0] as { text: string }).text); };
  return { temporary, root, git, initial, tools, context, ctx, call };
}

function failRegistryWrite(t: TestContext, stateDir: string, at = 1, beforeFailure?: () => Promise<void>, stage: 'write' | 'publish' = 'publish') {
  const stateFile = path.join(stateDir, 'git-worktrees.json'); let writes = 0;
  const failure = async () => { await beforeFailure?.(); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  // 只让受管记录的写入或原子发布遇到一次正常磁盘故障；Git 和真实工作树操作仍然执行。
  if (stage === 'write') {
    const original = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof original>) => {
      if (typeof args[0] === 'string' && args[0].startsWith(stateFile + '.') && ++writes === at) {
        await original(args[0], '[partial', { flag: 'wx', mode: 0o600 });
        return failure();
      }
      return original(...args);
    });
  } else {
    const original = fs.rename;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof original>) => {
      if (args[1] === stateFile && ++writes === at) return failure();
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

async function noRegistryTemps(stateDir: string) {
  assert.deepEqual((await readdir(stateDir)).filter(name => /^git-worktrees\.json\..*\.tmp$/.test(name)), []);
}

test('Git review excludes protected paths, binds saved reviews to owner and preserves immutable history', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.env'), 'PRIVATE=before\n'); await f.git('add', '.env'); await f.git('commit', '-qm', 'Track test protected path');
  await writeFile(path.join(f.root, '.env'), 'PRIVATE=secret\n'); await writeFile(path.join(f.root, 'note.txt'), 'reviewed\n');
  const status = await f.call('status'); assert.deepEqual(status.entries.map((entry: { path: string }) => entry.path), ['note.txt']);
  const diff = await f.call('diff'); assert.match(diff.diff, /reviewed/); assert.doesNotMatch(diff.diff, /PRIVATE|secret|\.env/);
  await assert.rejects(f.call('show', { commit: f.initial, path: '.env' }), /protected/);
  const saved = await f.call('review_save');
  await writeFile(path.join(f.root, 'note.txt'), 'later\n');
  await plugin.setup(f.context);
  assert.match((await f.call('review_read', { id: saved.id })).diff, /reviewed/);
  await assert.rejects(f.call('review_read', { id: saved.id }, { ...f.ctx, owner: 'bob' } as ToolContext), /another caller/);
  assert.equal((await f.call('show', { commit: f.initial, path: 'note.txt' })).content, 'initial\n');
});

test('approved commit pins staged content and HEAD, disables hooks and rejects protected staged changes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'note.txt'), 'second\n'); await f.git('add', 'note.txt');
  let status = await f.call('status');
  const args = { message: 'Second commit', expectedHead: status.head, expectedStagedHash: status.stagedHash };
  await f.tools.get('commit')!.preview!(args, f.ctx);
  await writeFile(path.join(f.root, 'note.txt'), 'raced\n'); await f.git('add', 'note.txt');
  await assert.rejects(f.call('commit', args), /File changed/);
  await writeFile(path.join(f.root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  status = await f.call('status');
  const committed = await f.call('commit', { ...args, expectedStagedHash: status.stagedHash });
  assert.notEqual(committed.commit, f.initial);
  await writeFile(path.join(f.root, '.env'), 'SECRET=hidden'); await f.git('add', '.env'); status = await f.call('status');
  await assert.rejects(f.call('commit', { ...args, expectedHead: status.head, expectedStagedHash: status.stagedHash }), /protected/);
});

test('restore is hash-checked, limits edits to one working file, and preserves index/history', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'note.txt'), 'modified\n');
  const args = { path: 'note.txt', commit: f.initial, expectedHash: hash('modified\n') };
  await f.tools.get('restore')!.preview!(args, f.ctx);
  await writeFile(path.join(f.root, 'note.txt'), 'concurrent\n');
  await assert.rejects(f.call('restore', args), /File changed/);
  await f.call('restore', { ...args, expectedHash: hash('concurrent\n') });
  assert.equal(await readFile(path.join(f.root, 'note.txt'), 'utf8'), 'initial\n');
  assert.equal(await f.git('rev-parse', 'HEAD'), f.initial);
  assert.equal(await f.git('status', '--porcelain'), '');
});

test('worktrees isolate committed state, refuse dirty deletion and restore retained detached commits after restart', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'worktrees'));
  await writeFile(path.join(f.root, 'note.txt'), 'source dirty\n');
  const created = await f.call('worktree_create', { path: 'worktrees/task-a', base: f.initial });
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'initial\n');
  assert.equal(await readFile(path.join(f.root, 'note.txt'), 'utf8'), 'source dirty\n');
  const listed = await f.call('worktrees'); assert.equal(listed.worktrees.length, 2);
  await writeFile(path.join(created.path, 'untracked.txt'), 'valuable');
  await assert.rejects(f.call('worktree_remove', { id: created.id, expectedHead: f.initial }), /not clean/);
  await rm(path.join(created.path, 'untracked.txt'));
  await f.call('worktree_remove', { id: created.id, expectedHead: f.initial });
  assert.deepEqual(await readdir(path.join(f.root, 'worktrees')), []);
  await plugin.setup(f.context);
  await f.call('worktree_restore', { id: created.id });
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'initial\n');
  await symlink(f.temporary, path.join(f.root, 'escape'));
  await assert.rejects(f.call('worktree_create', { path: 'escape/task', base: f.initial }), /Symbolic/);
});

test('Git refuses repositories reached through unregistered linked metadata and rejects historical binary files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'binary'), Buffer.from([255, 254])); await f.git('add', 'binary'); await f.git('commit', '-qm', 'Binary file');
  const commit = await f.git('rev-parse', 'HEAD');
  await assert.rejects(f.call('show', { commit, path: 'binary' }), /UTF-8/);
  const external = path.join(f.temporary, 'external'); await f.git('worktree', 'add', '--detach', external, f.initial);
  await assert.rejects(f.call('status', {}, { ...f.ctx, workspace: external }), /outside the registered/);
});

test('worktree pruning retains both staged and unstaged tracked edits for restart recovery', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'worktrees'));
  const created = await f.call('worktree_create', { path: 'worktrees/recoverable', base: f.initial });
  await writeFile(path.join(created.path, 'note.txt'), 'staged\n');
  await exec('git', ['add', 'note.txt'], { cwd: created.path });
  await writeFile(path.join(created.path, 'note.txt'), 'unstaged\n');
  const inspection = await f.call('worktree_inspect', { id: created.id });
  const args = { id: created.id, expectedHead: inspection.status.head, expectedChangesHash: inspection.status.changesHash };
  await f.tools.get('worktree_prune')!.preview!(args, f.ctx);
  await f.call('worktree_prune', args);
  await assert.rejects(readFile(path.join(created.path, 'note.txt')), /ENOENT/);
  await plugin.setup(f.context);
  await f.call('worktree_restore', { id: created.id });
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'unstaged\n');
  assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'staged\n');
});

test('failed worktree registration rolls back only the clean new checkout and permits a fresh retry', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'note.txt'), 'existing source edits\n');
  failRegistryWrite(t, f.context.stateDir);
  await assert.rejects(f.call('worktree_create', { path: 'retry-create', base: f.initial }), /registration.*failed.*clean.*removed/i);
  await assert.rejects(readFile(path.join(f.root, 'retry-create/note.txt')), /ENOENT/);
  assert.equal(await readFile(path.join(f.root, 'note.txt'), 'utf8'), 'existing source edits\n');
  assert.doesNotMatch(await f.git('worktree', 'list', '--porcelain'), /retry-create/);
  await noRegistryTemps(f.context.stateDir);
  await plugin.setup(f.context);
  const created = await f.call('worktree_create', { path: 'retry-create', base: f.initial });
  assert.equal((await f.call('worktree_inspect', { id: created.id })).status.head, f.initial);
});

test('failed registration preserves edits made in the new checkout and explains its unregistered state', async t => {
  const f = await fixture(t); const target = path.join(f.root, 'preserved-create');
  failRegistryWrite(t, f.context.stateDir, 1, () => writeFile(path.join(target, 'note.txt'), 'user edits while registration saves\n'));
  await assert.rejects(f.call('worktree_create', { path: 'preserved-create', base: f.initial }), /registration.*failed.*preserved.*git worktree list/i);
  assert.equal(await readFile(path.join(target, 'note.txt'), 'utf8'), 'user edits while registration saves\n');
  assert.match(await f.git('worktree', 'list', '--porcelain'), /preserved-create/);
  await noRegistryTemps(f.context.stateDir);
});

test('archive registry failure before pruning leaves staged and unstaged edits intact for retry after restart', async t => {
  const f = await fixture(t);
  const created = await f.call('worktree_create', { path: 'archive-before', base: f.initial });
  await writeFile(path.join(created.path, 'note.txt'), 'staged before failure\n'); await exec('git', ['add', 'note.txt'], { cwd: created.path });
  await writeFile(path.join(created.path, 'note.txt'), 'working before failure\n');
  const stateFile = path.join(f.context.stateDir, 'git-worktrees.json'); const before = await readFile(stateFile, 'utf8');
  const inspection = await f.call('worktree_inspect', { id: created.id });
  const args = { id: created.id, expectedHead: inspection.status.head, expectedChangesHash: inspection.status.changesHash };
  failRegistryWrite(t, f.context.stateDir, 1, undefined, 'write');
  await assert.rejects(f.call('worktree_prune', args), /archive.*record.*failed.*not removed/i);
  assert.equal(await readFile(stateFile, 'utf8'), before);
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'working before failure\n');
  assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'staged before failure\n');
  await noRegistryTemps(f.context.stateDir);
  await plugin.setup(f.context); await f.call('worktree_prune', args); await f.call('worktree_restore', { id: created.id });
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'working before failure\n');
  assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'staged before failure\n');
});

test('registry failure after clean removal or tracked pruning remains recoverable across restart', async t => {
  for (const kind of ['remove', 'prune']) await t.test(kind, async t => {
    const f = await fixture(t); const created = await f.call('worktree_create', { path: `after-${kind}`, base: f.initial });
    if (kind === 'prune') {
      await writeFile(path.join(created.path, 'note.txt'), 'archived index\n'); await exec('git', ['add', 'note.txt'], { cwd: created.path });
      await writeFile(path.join(created.path, 'note.txt'), 'archived working\n');
    }
    const inspection = await f.call('worktree_inspect', { id: created.id });
    failRegistryWrite(t, f.context.stateDir, 2);
    await assert.rejects(f.call(`worktree_${kind}`, { id: created.id, expectedHead: inspection.status.head, expectedChangesHash: inspection.status.changesHash }), /removed.*registry.*failed.*recover/i);
    const persisted = JSON.parse(await readFile(path.join(f.context.stateDir, 'git-worktrees.json'), 'utf8'))[0];
    assert.ok(persisted.recovery); assert.equal(persisted.removedAt, undefined);
    assert.equal(await f.git('rev-parse', `refs/capyra/worktrees/${created.id}`), persisted.recovery);
    await noRegistryTemps(f.context.stateDir);
    await plugin.setup(f.context);
    assert.equal((await f.call('worktrees')).recoverable[0].id, created.id);
    await f.call('worktree_restore', { id: created.id });
    assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), kind === 'prune' ? 'archived working\n' : 'initial\n');
    if (kind === 'prune') assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'archived index\n');
  });
});

test('restored files survive a final registry failure and an explicit retry repairs metadata without reapplying changes', async t => {
  const f = await fixture(t); const created = await f.call('worktree_create', { path: 'restore-after', base: f.initial });
  await writeFile(path.join(created.path, 'note.txt'), 'restored index\n'); await exec('git', ['add', 'note.txt'], { cwd: created.path });
  await writeFile(path.join(created.path, 'note.txt'), 'restored working\n');
  const inspection = await f.call('worktree_inspect', { id: created.id });
  await f.call('worktree_prune', { id: created.id, expectedHead: inspection.status.head, expectedChangesHash: inspection.status.changesHash });
  failRegistryWrite(t, f.context.stateDir);
  await assert.rejects(f.call('worktree_restore', { id: created.id }), /restored.*registry.*failed.*preserved/i);
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'restored working\n');
  assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'restored index\n');
  await noRegistryTemps(f.context.stateDir); await plugin.setup(f.context);
  const pending = await f.call('worktree_inspect', { id: created.id });
  assert.equal(pending.recoveryState, 'directory_present'); assert.equal(pending.status.head, f.initial);
  await writeFile(path.join(created.path, 'note.txt'), 'new user edits after failure\n');
  await assert.rejects(f.call('worktree_restore', { id: created.id }), /differs.*preserved.*recovery/i);
  assert.equal(await readFile(path.join(created.path, 'note.txt'), 'utf8'), 'new user edits after failure\n');
  await writeFile(path.join(created.path, 'note.txt'), 'restored working\n');
  const recovered = await f.call('worktree_restore', { id: created.id });
  assert.equal(recovered.reconciled, true); assert.equal(recovered.removedAt, undefined);
  await plugin.setup(f.context);
  assert.equal((await f.call('worktree_inspect', { id: created.id })).removedAt, undefined);
  assert.equal((await exec('git', ['show', ':note.txt'], { cwd: created.path })).stdout, 'restored index\n');
});

test('Git reads and worktree checkouts do not execute repository clean/smudge filters', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.gitattributes'), '*.txt filter=sneaky\n');
  await f.git('add', '.gitattributes'); await f.git('commit', '-qm', 'Attributes');
  const marker = path.join(f.temporary, 'filter-ran');
  await f.git('config', 'filter.sneaky.clean', `touch '${marker}'; cat`);
  await f.git('config', 'filter.sneaky.smudge', `touch '${marker}'; cat`);
  await f.git('config', 'filter.sneaky.required', 'true');
  await writeFile(path.join(f.root, 'note.txt'), 'changed\n');
  const state = await f.call('status');
  assert.equal(state.entries[0]?.path, 'note.txt');
  await f.call('diff');
  await f.call('worktree_create', { path: 'isolated', base: state.head });
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('directory-scoped Git diffs still filter nested protected paths and hard-linked files', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'nested'));
  await writeFile(path.join(f.root, 'nested/.env'), 'OLD=secret\n'); await writeFile(path.join(f.root, 'nested/public.txt'), 'old\n');
  await f.git('add', 'nested'); await f.git('commit', '-qm', 'Nested fixtures');
  await writeFile(path.join(f.root, 'nested/.env'), 'NEW=private\n'); await writeFile(path.join(f.root, 'nested/public.txt'), 'safe\n');
  const directory = await f.call('diff', { path: 'nested' });
  assert.match(directory.diff, /safe/); assert.doesNotMatch(directory.diff, /secret|private|\.env/);
  await rm(path.join(f.root, 'nested/public.txt'));
  await writeFile(path.join(f.temporary, 'outside'), 'outside secret');
  await link(path.join(f.temporary, 'outside'), path.join(f.root, 'nested/public.txt'));
  assert.equal((await f.call('diff', { path: 'nested' })).diff, '');
});

test('configured author identity permits reviewed commits without per-repository identity setup', async t => {
  const f = await fixture(t);
  await f.git('config', '--unset', 'user.name'); await f.git('config', '--unset', 'user.email');
  f.context.config = { authorName: 'Configured Author', authorEmail: 'configured@example.test' }; await plugin.setup(f.context);
  await writeFile(path.join(f.root, 'note.txt'), 'configured identity\n'); await f.git('add', 'note.txt');
  const state = await f.call('status');
  const args = { message: 'Configured identity commit', expectedHead: state.head, expectedStagedHash: state.stagedHash };
  assert.match((await f.tools.get('commit')!.preview!(args, f.ctx)).description, /Configured Author/);
  await f.call('commit', args);
  assert.equal(await f.git('log', '-1', '--format=%an <%ae>'), 'Configured Author <configured@example.test>');
});
