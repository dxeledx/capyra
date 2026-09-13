import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import plugin, { type GitService } from '../src/plugins/git.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';
import { createReviewBaselines } from '../src/client-ui/review-baseline.js';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const folder = await mkdtemp(path.join(tmpdir(), 'capyra-review-baseline-')); const workspace = path.join(folder, 'project'); const stateDir = path.join(folder, 'state');
  await mkdir(workspace);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workspace })).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'Review Test'); await git('config', 'user.email', 'review@example.test');
  await writeFile(path.join(workspace, 'note.txt'), 'initial\n'); await writeFile(path.join(workspace, 'rename.txt'), 'unchanged rename\n');
  await mkdir(path.join(workspace, 'nested')); await writeFile(path.join(workspace, 'nested/delete.txt'), 'deleted later\n');
  await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await git('add', '.'); await git('commit', '-qm', 'Initial');
  let service: GitService; let disposals: (() => void | Promise<void>)[] = []; const tools = new Map<string, ToolDefinition>();
  const context: PluginContext = { workspace, stateDir, config: {}, provide(name, value) { if (name === 'git') service = value as GitService; }, service() { throw new Error('No optional service'); }, registerTool(tool) { tools.set(tool.name, tool); return () => {}; }, guard() {}, onEvent() {}, onDispose(dispose) { disposals.push(dispose); } };
  await plugin.setup(context);
  const ctx: ToolContext = { workspace, owner: 'alice', taskId: 'test', signal: new AbortController().signal, progress() {} };
  const restart = async () => { for (const dispose of disposals) await dispose(); disposals = []; await plugin.setup(context); };
  t.after(async () => { for (const dispose of disposals) await dispose(); await rm(folder, { recursive: true, force: true }); });
  return { folder, workspace, stateDir, ctx, git, restart, tools, service: () => service! };
}

test('full reviews compare from first open then last shown across staged, working, untracked, deleted, renamed and binary paths', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'note.txt'), 'preexisting work\n');
  await writeFile(path.join(f.workspace, 'already-untracked.txt'), 'existing untracked\n');
  await writeFile(path.join(f.workspace, '.env'), 'PRIVATE=hidden\n');
  await writeFile(path.join(f.workspace, 'large.bin'), Buffer.alloc(1024 * 1024 + 1, 88));
  const opened = await f.service().reviewOpen(f.ctx); assert.equal(opened.reused, false);
  await writeFile(path.join(f.workspace, 'note.txt'), 'staged\n'); await f.git('add', 'note.txt');
  await writeFile(path.join(f.workspace, 'note.txt'), 'working final\n');
  await writeFile(path.join(f.workspace, 'new.txt'), 'brand new\n');
  await f.git('mv', 'rename.txt', 'renamed.txt'); await rm(path.join(f.workspace, 'nested'), { recursive: true });
  await writeFile(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 8, 9]));
  const status = await f.git('status', '--porcelain'); const head = await f.git('rev-parse', 'HEAD');
  const index = await readFile(path.join(f.workspace, '.git/index'));
  const first = await f.service().reviewChanges(f.ctx);
  assert.equal(first.scope, 'workspace'); assert.equal(first.since, 'last_shown');
  assert.match(first.diff, /-preexisting work/); assert.match(first.diff, /\+working final/); assert.doesNotMatch(first.diff, /\+staged|PRIVATE|\.env|existing untracked/);
  assert.ok(first.files?.some(file => file.path === 'new.txt' && file.type === 'new'));
  assert.ok(first.files?.some(file => file.path === 'nested/delete.txt' && file.type === 'deleted'));
  assert.ok(first.files?.some(file => file.path === 'renamed.txt' && file.previousPath === 'rename.txt'));
  assert.ok(first.files?.some(file => file.path === 'binary.bin' && file.binary && file.contentOmitted === 'binary'));
  assert.deepEqual(first.skipped?.find(file => file.path === 'large.bin'), { path: 'large.bin', reason: 'large_file', bytes: 1024 * 1024 + 1 });
  assert.deepEqual(await readFile(path.join(f.workspace, '.git/index')), index); assert.equal(await f.git('status', '--porcelain'), status); assert.equal(await f.git('rev-parse', 'HEAD'), head);
  assert.equal((await f.service().reviewOpen(f.ctx)).reused, true);
  await writeFile(path.join(f.workspace, 'new.txt'), 'second round\n');
  const second = await f.service().reviewChanges(f.ctx); assert.deepEqual(second.files?.map(file => file.path), ['new.txt']); assert.match(second.diff, /-brand new/); assert.match(second.diff, /\+second round/);
  await f.service().reviewRead(f.ctx, first.id);
  const unchanged = await f.service().reviewChanges(f.ctx); assert.deepEqual(unchanged.files, []);
  const whole = await f.service().reviewChanges(f.ctx, { since: 'workspace_open' }); assert.match(whole.diff, /-preexisting work/); assert.match(whole.diff, /\+second round/);
  await f.restart(); assert.deepEqual(await f.service().reviewRead(f.ctx, first.id), first);
  assert.deepEqual((await f.service().reviewChanges(f.ctx)).files, []);
  assert.deepEqual((await readdir(f.stateDir)).filter(name => name.startsWith('review-index-')), []);
});

test('checkpoints isolate caller/workspace, serialize concurrent reviews and refuse missing history after restart', async t => {
  const f = await fixture(t); await f.service().reviewOpen(f.ctx);
  await writeFile(path.join(f.workspace, 'note.txt'), 'alice first\n');
  const bob = { ...f.ctx, owner: 'bob' }; await f.service().reviewOpen(bob);
  const [first, next] = await Promise.all([f.service().reviewChanges(f.ctx), f.service().reviewChanges(f.ctx)]);
  assert.match(first.diff, /alice first/); assert.equal(next.diff, '');
  assert.equal((await f.service().reviewChanges(bob)).diff, '');
  await assert.rejects(f.service().reviewRead(bob, first.id), /another caller/);
  await assert.rejects(f.service().reviewRead({ ...f.ctx, workspace: f.folder }, first.id), /another caller/);
  const key = createHash('sha256').update(JSON.stringify([f.ctx.owner, f.ctx.workspace])).digest('hex');
  const privateRoot = path.join(f.stateDir, 'review-objects', `${key}.git`);
  await exec('git', ['update-ref', '-d', `refs/capyra/review/${key}/open`], { cwd: privateRoot });
  await f.restart(); assert.equal((await f.service().reviewChanges(f.ctx)).diff, '');
  const manifest = JSON.parse(await readFile(path.join(f.stateDir, 'review-checkpoints', `${key}.json`), 'utf8'));
  await rm(path.join(privateRoot, 'objects', manifest.open.tree.slice(0, 2), manifest.open.tree.slice(2)));
  await f.restart(); await assert.rejects(f.service().reviewChanges(f.ctx), /objects are missing/);
  assert.deepEqual(await f.service().reviewRead(f.ctx, first.id), first);
});

test('private snapshot objects cannot be read through ordinary history or transferred by a source repository mirror', async t => {
  const f = await fixture(t); const secret = 'ALICE_UNTRACKED_SNAPSHOT_ONLY';
  await writeFile(path.join(f.workspace, 'private.txt'), secret);
  await f.service().reviewOpen(f.ctx); const review = await f.service().reviewChanges(f.ctx);
  await rm(path.join(f.workspace, 'private.txt'));
  const bob = { ...f.ctx, owner: 'bob' };
  await assert.rejects(f.tools.get('show')!.execute({ commit: review.base, path: 'private.txt' }, bob));
  await assert.rejects(f.service().diff(f.workspace, bob.signal, { commit: review.base! }));
  await assert.rejects(f.tools.get('restore')!.execute({ commit: review.base, path: 'private.txt', expectedMissing: true }, bob));
  assert.equal(await f.git('for-each-ref', '--format=%(refname)', 'refs/capyra/review'), '');
  await assert.rejects(f.git('cat-file', '-e', review.base!));
  const mirror = path.join(f.folder, 'mirror.git'); await exec('git', ['init', '--bare', '-q', mirror]);
  await f.git('push', '--mirror', mirror);
  await assert.rejects(exec('git', ['show', `${review.base}:private.txt`], { cwd: mirror }));
  const sourceTree = await f.git('rev-parse', 'HEAD^{tree}');
  await assert.rejects(f.tools.get('show')!.execute({ commit: sourceTree, path: 'note.txt' }, bob), /commit object/);
});

test('new ignore rules omit an existing baseline file instead of disclosing its old contents as a deletion', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'private.tmp'), 'IGNORED_UNTRACKED_PRIVATE_CONTENT');
  await f.service().reviewOpen(f.ctx);
  await writeFile(path.join(f.workspace, '.gitignore'), 'private.tmp\n');
  const review = await f.service().reviewChanges(f.ctx);
  assert.doesNotMatch(JSON.stringify(review), /IGNORED_UNTRACKED_PRIVATE_CONTENT/);
  assert.ok(review.files?.some(file => file.path === 'private.tmp' && file.type === 'change' && file.contentOmitted === 'excluded'));
  assert.ok(review.skipped?.some(file => file.path === 'private.tmp' && file.reason === 'excluded'));
});

test('owned legacy snapshot refs migrate into the private repository while preserving exact history', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'legacy-private.txt'), 'LEGACY_PRIVATE_SNAPSHOT');
  await f.service().reviewOpen(f.ctx); const review = await f.service().reviewChanges(f.ctx);
  const key = createHash('sha256').update(JSON.stringify([f.ctx.owner, f.ctx.workspace])).digest('hex');
  const privateRoot = path.join(f.stateDir, 'review-objects', `${key}.git`); const prefix = `refs/capyra/review/${key}`;
  // 此处只在临时仓库重建旧版存储布局，再由真实新插件完成迁移。
  await f.git('fetch', '--quiet', '--no-tags', privateRoot, `+${prefix}/*:${prefix}/*`);
  await rm(privateRoot, { recursive: true, force: true });
  await f.restart(); await f.service().reviewOpen(f.ctx);
  assert.deepEqual(await f.service().reviewRead(f.ctx, review.id), review);
  assert.equal(await f.git('for-each-ref', '--format=%(refname)', prefix), '');
  assert.equal((await f.service().reviewChanges(f.ctx)).diff, '');
  const mirror = path.join(f.folder, 'after-migration.git'); await exec('git', ['init', '--bare', '-q', mirror]); await f.git('push', '--mirror', mirror);
  await assert.rejects(exec('git', ['show', `${review.base}:legacy-private.txt`], { cwd: mirror }));
});

test('ref write interruption recovers the persisted checkpoint without capturing replacement history', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'capyra-baseline-recovery-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const ctx: ToolContext = { workspace: '/test/workspace', owner: 'alice', taskId: 'test', signal: new AbortController().signal, progress() {} };
  const first = 'a'.repeat(40), second = 'b'.repeat(40); let tree = first; let captures = 0; let fail = false;
  const refs = new Map<string, string>();
  const manager = createReviewBaselines(folder, {
    async capture() { captures++; return { tree, binary: [], skipped: [] }; },
    async compare() { return { diff: '', truncated: false, files: [] }; },
    async ref(_ctx, name) { return refs.get(name); },
    async hasTree(_ctx, id) { return [first, second].includes(id); },
    async retain(_ctx, name, id) { refs.set(name, id); if (fail && name.endsWith('/last')) throw new Error('interrupted after ref write'); },
  });
  t.after(() => manager.close());
  fail = true; await assert.rejects(manager.open(ctx), /interrupted/);
  const initialCaptures = captures; fail = false; await manager.open(ctx); assert.equal(captures, initialCaptures);
  tree = second; fail = true; await assert.rejects(manager.changes(ctx), /interrupted/);
  const priorCaptures = captures; fail = false; await manager.open(ctx); assert.equal(captures, priorCaptures);
  assert.equal([...refs.entries()].find(([name]) => name.endsWith('/last'))?.[1], first);
  await manager.changes(ctx); assert.equal([...refs.entries()].find(([name]) => name.endsWith('/last'))?.[1], second);
});

test('snapshot safety preserves filters/hooks, excludes unsafe paths, and marks content unavailable instead of fabricating deletion', async t => {
  const f = await fixture(t);
  const marker = path.join(f.folder, 'filter-ran');
  await writeFile(path.join(f.workspace, '.gitattributes'), '*.txt filter=hostile diff=hostile\n');
  await f.git('config', 'filter.hostile.clean', `touch '${marker}'; cat`);
  await f.git('config', 'filter.hostile.process', `touch '${marker}'; cat`);
  await f.git('config', 'diff.hostile.command', `touch '${marker}'`);
  await f.git('config', 'diff.hostile.textconv', `touch '${marker}'`);
  await f.service().reviewOpen(f.ctx);
  await writeFile(path.join(f.workspace, 'note.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await writeFile(path.join(f.folder, 'secret'), 'OUTSIDE_SECRET'); await symlink(path.join(f.folder, 'secret'), path.join(f.workspace, 'escape.txt'));
  const review = await f.service().reviewChanges(f.ctx);
  assert.ok(review.files?.some(file => file.path === 'note.txt' && file.type === 'change' && file.contentOmitted === 'large_file'));
  assert.ok(review.skipped?.some(file => file.path === 'escape.txt' && file.reason === 'unsupported_path'));
  assert.doesNotMatch(JSON.stringify(review), /OUTSIDE_SECRET|-initial/);
  await assert.rejects(readFile(marker), /ENOENT/);
});
