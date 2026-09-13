import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CapyraPlugin, ToolContext } from '../core/types.js';
import { textResult } from '../sdk.js';
import { applyWrite } from './workspace.js';
import { assertHash, checkCancelled, expectedHash, isBlockedName, MAX_FILE_BYTES, readBinaryHandle, readWorkspaceFile, sha256, stringArg, textBytes, workspacePath } from './workspace-paths.js';
import type { ProjectsService } from './projects.js';
import { createReviewBaselines, type ReviewFile, type ReviewSince, type ReviewSnapshot, type SnapshotSkip } from '../client-ui/review-baseline.js';

const exec = promisify(execFile);
const pathSchema = { type: 'string', description: 'A relative workspace path.' };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const commitSchema = { type: 'string', pattern: '^[a-f0-9]{40,64}$', description: 'Full commit object ID returned by status or log.' };
interface ManagedWorktree { id: string; source: string; path: string; base: string; createdAt: string; removedAt?: string; recovery?: string; recoveryKind?: 'head' | 'stash' }
export interface GitReview { id: string; workspace: string; owner: string; createdAt: string; base: string | null; staged: boolean; diff: string; truncated: boolean; scope?: 'workspace'; since?: ReviewSince; baselineCreated?: boolean; snapshot?: string; skipped?: SnapshotSkip[]; files?: ReviewFile[] }
export interface GitService {
  status(workspace: string, signal: AbortSignal): Promise<unknown>;
  diff(workspace: string, signal: AbortSignal, options?: { staged?: boolean; path?: string; commit?: string }): Promise<unknown>;
  worktrees(workspace: string, signal: AbortSignal): Promise<unknown>;
  reviewSave(ctx: ToolContext, options?: { staged?: boolean }): Promise<GitReview>;
  reviewRead(ctx: ToolContext, id: string): Promise<GitReview>;
  reviewOpen(ctx: ToolContext): Promise<{ available: boolean; openedAt: string; reused: boolean; skipped: SnapshotSkip[] }>;
  reviewChanges(ctx: ToolContext, options?: { since?: ReviewSince }): Promise<GitReview>;
}

function objectId(args: Record<string, unknown>, field = 'commit'): string {
  const value = stringArg(args, field);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`${field} must be a full Git object ID`);
  return value;
}
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LANG: 'C.UTF-8' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function git(cwd: string, args: string[], signal: AbortSignal, strictText = false, options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  checkCancelled(signal);
  const base = ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', '-c', 'commit.gpgsign=false'];
  try {
    // status/add/checkout 也可能触发仓库定义的过滤器；禁用它们，避免读取工具隐式运行仓库脚本。
    const objectOnly = ['rev-parse', 'cat-file', 'update-ref', 'ls-files', 'write-tree'].includes(args[0]!) || (args[0] === 'read-tree' && args.includes('--empty')) || (args[0] === 'update-index' && args.includes('--index-info')) || (args[0] === 'hash-object' && args.includes('--no-filters'));
    const filters = objectOnly ? { stdout: '' } : await exec('git', ['config', '--includes', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], { cwd, env: environment(), signal, timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8' }).catch((error: { code?: number | string }) => { if (error.code === 1) return { stdout: '' }; throw error; });
    for (const key of filters.stdout.split('\n').filter(Boolean)) {
      if (!/^filter\.[^\x00-\x20=]+\.(clean|smudge|process|required)$/.test(key)) throw new Error('Unsupported Git filter configuration');
      base.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    const result = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
      const child = execFile('git', [...base, ...args], { cwd, env: { ...environment(), ...options.env }, signal, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => { if (error) reject(Object.assign(error, { stderr })); else resolve({ stdout }); });
      // 快照只将已安全读取的字节交给 hash-object，不让 Git 自行重新打开用户路径。
      child.stdin?.on('error', () => {}); child.stdin?.end(options.input);
    });
    if (strictText) { try { return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); } catch { throw new Error('Only UTF-8 historical files are supported'); } }
    return result.stdout.toString('utf8');
  } catch (error) {
    checkCancelled(signal);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Git is not installed or not on PATH');
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    throw new Error(stderr?.toString().trim().slice(0, 3000) || (error instanceof Error ? error.message : 'Git command failed'));
  }
}
async function head(root: string, signal: AbortSignal): Promise<string | null> {
  try { return (await git(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim(); }
  catch (error) {
    checkCancelled(signal);
    const empty = await git(root, ['rev-parse', '--is-inside-work-tree'], signal);
    if (empty.trim() === 'true' && /unknown revision|single revision|ambiguous argument|Needed a single revision/.test(String(error))) return null;
    throw error;
  }
}
async function safePaths(root: string, names: string[], signal: AbortSignal) {
  const valid: string[] = [];
  for (const name of names) {
    checkCancelled(signal);
    try {
      const target = await workspacePath(root, name, { allowMissing: true });
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (!info.isFile() || info.nlink > 1)) continue;
      valid.push(name);
    }
    catch { /* Git 可以记录已删除或被保护路径；内容审阅只包含当前边界可访问的路径。 */ }
  }
  return valid;
}
async function rawStaged(root: string, signal: AbortSignal) { return git(root, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--'], signal); }
async function changesHash(root: string, signal: AbortSignal) {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], signal);
  const staged = await rawStaged(root, signal);
  const working = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--'], signal);
  return sha256(Buffer.from(JSON.stringify({ status, staged, working })));
}
async function requireHead(root: string, args: Record<string, unknown>, signal: AbortSignal) {
  const current = await head(root, signal);
  const expected = args.expectedHead;
  if (expected !== null && (typeof expected !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected))) throw new Error('expectedHead must be the full current commit ID or null for an unborn repository');
  if (current !== expected) throw new Error('Repository HEAD changed; inspect status and prepare a new operation');
  return current;
}
async function requireCommit(root: string, value: string, signal: AbortSignal) {
  objectId({ commit: value });
  if ((await git(root, ['cat-file', '-t', value], signal)).trim() !== 'commit') throw new Error('A regular Git commit object is required');
}

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'git', version: '0.1.0', title: 'Git and worktrees',
  description: 'Review changes and history, commit approved staged changes, and manage isolated Git worktrees.',
  permissions: ['git:read', 'git:write', 'workspace:read', 'workspace:write'],
  instructions: 'Git must be installed. Workspaces must be repository roots. status returns immutable HEAD and staged hashes for approval preconditions. commit, restore and worktree changes require local approval. Managed worktrees start from a committed object and leave the source checkout intact.',
  async setup(context) {
    const author: Record<string, string> = {};
    for (const field of ['name', 'email']) {
      const configured = context.config[field === 'name' ? 'authorName' : 'authorEmail'];
      if (configured !== undefined && (typeof configured !== 'string' || !configured.trim() || configured.length > 320 || /[\x00-\x1f]/.test(configured))) throw new Error('Git author name/email must be nonempty single-line text');
      if (typeof configured === 'string') { author[field] = configured; continue; }
      // 只读取全局身份这两个值；Git操作仍不载入全局helpers、凭据或别名配置。
      const env: NodeJS.ProcessEnv = { ...environment(), HOME: homedir() }; delete env.GIT_CONFIG_GLOBAL;
      try { const value = (await exec('git', ['config', '--global', '--get', `user.${field}`], { env, timeout: 5_000, maxBuffer: 4096, encoding: 'utf8' })).stdout.trim(); if (value && value.length <= 320 && !/[\x00-\x1f]/.test(value)) author[field] = value; }
      catch { /* A repository-local identity can still be used when no global identity exists. */ }
    }
    const stateFile = path.join(context.stateDir, 'git-worktrees.json');
    let managed: ManagedWorktree[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
      if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || typeof entry.source !== 'string' || !path.isAbsolute(entry.source))) throw new Error('Invalid managed worktree registry');
      managed = value as ManagedWorktree[];
      for (const entry of managed) {
        if (entry.recovery && !entry.removedAt) {
          try { await lstat(entry.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') entry.removedAt = new Date().toISOString(); else throw error; }
        }
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const save = async (next = managed) => {
      await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, stateFile);
        managed = next;
      } finally {
        // 写入或发布失败也清理临时文件；已发布的旧注册表始终保留。
        await rm(temporary, { force: true }).catch(() => {});
      }
    };
    const repository = async (workspace: string, signal: AbortSignal) => {
      const root = await workspacePath(workspace, '.', { allowRoot: true });
      const actual = await realpath((await git(root, ['rev-parse', '--show-toplevel'], signal)).trim());
      if (root !== actual) throw new Error('Select the Git repository root as the workspace');
      const dotgit = await lstat(path.join(root, '.git'));
      if (dotgit.isSymbolicLink()) throw new Error('Symbolic Git metadata is not allowed');
      const common = await realpath(path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'], signal)).trim()));
      const allowed = new Set([path.join(root, '.git')]);
      for (const entry of managed.filter(item => item.path === root)) allowed.add(path.join(entry.source, '.git'));
      try { for (const entry of context.service<ProjectsService>('projects').list()) allowed.add(path.join(entry.path, '.git')); } catch { /* Projects are optional when only the primary workspace is configured. */ }
      if (!allowed.has(common)) throw new Error('Git metadata is outside the registered project boundary');
      return root;
    };
    const status = async (workspace: string, signal: AbortSignal) => {
      const root = await repository(workspace, signal);
      const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
      const records = raw.split('\0');
      const entries: { path: string; status: string; from?: string }[] = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (!record) continue;
        const code = record.slice(0, 2); const name = record.slice(3);
        const from = /[RC]/.test(code) ? records[++i] : undefined;
        if (!(await safePaths(root, [name], signal)).length || (from && !(await safePaths(root, [from], signal)).length)) continue;
        entries.push({ path: name, status: code, ...(from ? { from } : {}) });
      }
      const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], signal).catch(() => '')).trim() || null;
      return { head: await head(root, signal), branch, entries, stagedHash: sha256(Buffer.from(await rawStaged(root, signal))), changesHash: await changesHash(root, signal) };
    };
    const diff = async (workspace: string, signal: AbortSignal, options: { staged?: boolean; path?: string; commit?: string } = {}) => {
      const root = await repository(workspace, signal);
      if (options.commit) await requireCommit(root, options.commit, signal);
      const flags = options.commit ? [objectId({ commit: options.commit }), objectId({ commit: options.commit }) + '^'] : options.staged ? ['--cached'] : [];
      // 历史 diff 的方向为父提交到选定提交；首个提交使用 show --root。
      const command = options.commit ? ['show', '--format=', '--root', options.commit] : ['diff', ...flags];
      const candidates = (await git(root, [...command, '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--'], signal)).split('\0').filter(Boolean);
      let names = candidates;
      if (options.path) {
        await workspacePath(root, options.path, { allowMissing: true, allowRoot: true });
        const selected = path.posix.normalize(options.path).replace(/\/$/, '');
        names = selected === '.' ? candidates : candidates.filter(name => name === selected || name.startsWith(selected + '/'));
      }
      const paths = await safePaths(root, names, signal);
      let output = '';
      let truncated = false;
      for (const name of paths) {
        const item = await git(root, [...command, '--no-ext-diff', '--no-textconv', '--no-renames', '--', name], signal);
        if (output.length + item.length > 128 * 1024) { output += item.slice(0, Math.max(0, 128 * 1024 - output.length)); truncated = true; break; }
        output += item;
      }
      return { diff: output, files: paths, truncated, head: await head(root, signal), staged: options.staged === true };
    };
    const listWorktrees = async (workspace: string, signal: AbortSignal) => {
      const root = await repository(workspace, signal);
      const output = await git(root, ['worktree', 'list', '--porcelain', '-z'], signal);
      const worktrees: Record<string, unknown>[] = [];
      let item: Record<string, unknown> = {};
      for (const line of output.split('\0')) {
        if (!line) { if (item.path) worktrees.push(item); item = {}; continue; }
        const space = line.indexOf(' '); const key = space < 0 ? line : line.slice(0, space); const value = space < 0 ? true : line.slice(space + 1);
        item[key === 'worktree' ? 'path' : key] = value;
      }
      if (item.path) worktrees.push(item);
      const allowed = managed.filter(entry => entry.source === root || entry.path === root);
      return { worktrees: worktrees.filter(entry => entry.path === root || allowed.some(item => item.path === entry.path)).map(entry => ({ ...entry, managedId: allowed.find(item => item.path === entry.path)?.id ?? null })), recoverable: allowed.filter(entry => entry.removedAt) };
    };
    const reviewSave = async (ctx: ToolContext, options: { staged?: boolean } = {}): Promise<GitReview> => {
      const snapshot = await diff(ctx.workspace, ctx.signal, { staged: options.staged === true });
      const review: GitReview = { id: randomUUID(), workspace: ctx.workspace, owner: 'owner' in ctx && typeof ctx.owner === 'string' ? ctx.owner : 'local', createdAt: new Date().toISOString(), base: snapshot.head, staged: snapshot.staged, diff: snapshot.diff, truncated: snapshot.truncated };
      const folder = path.join(context.stateDir, 'reviews'); await mkdir(folder, { recursive: true, mode: 0o700 });
      checkCancelled(ctx.signal);
      await writeFile(path.join(folder, `${review.id}.json`), JSON.stringify(review), { flag: 'wx', mode: 0o600 });
      return review;
    };
    const reviewRead = async (ctx: ToolContext, id: string): Promise<GitReview> => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid review ID');
      checkCancelled(ctx.signal);
      const review = JSON.parse(await readFile(path.join(context.stateDir, 'reviews', `${id}.json`), 'utf8')) as GitReview;
      const owner = 'owner' in ctx && typeof ctx.owner === 'string' ? ctx.owner : 'local';
      if (review.workspace !== ctx.workspace || review.owner !== owner) throw new Error('Review belongs to another caller or workspace');
      checkCancelled(ctx.signal);
      return review;
    };
    const reviewRepositories = new Map<string, Promise<string>>();
    const reviewRepository = (ctx: ToolContext): Promise<string> => {
      const key = createHash('sha256').update(JSON.stringify([ctx.owner, ctx.workspace])).digest('hex');
      let pending = reviewRepositories.get(key);
      if (!pending) {
        pending = (async () => {
          const source = await repository(ctx.workspace, ctx.signal);
          const parent = path.join(context.stateDir, 'review-objects'); const directory = path.join(parent, `${key}.git`);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          if ((await lstat(parent)).isSymbolicLink()) throw new Error('Review object directory must not be a symbolic link');
          try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid private review repository'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const temporary = await mkdtemp(path.join(parent, '.init-'));
            try {
              const format = (await git(source, ['rev-parse', '--show-object-format'], ctx.signal)).trim();
              if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported Git object format');
              await git(temporary, ['init', '--bare', '--quiet', '--template=', `--object-format=${format}`], ctx.signal);
              await chmod(temporary, 0o700); await rename(temporary, directory);
            } finally { await rm(temporary, { recursive: true, force: true }); }
          }
          if ((await git(directory, ['rev-parse', '--is-bare-repository'], ctx.signal)).trim() !== 'true') throw new Error('Private review repository must be bare');
          // 旧版只迁移 manifest 能证明属于此 owner/workspace 的精确 refs；原始内容保存在私有库后再移除源引用。
          let manifest: any;
          try { manifest = JSON.parse(await readFile(path.join(context.stateDir, 'review-checkpoints', `${key}.json`), 'utf8')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (manifest?.owner === ctx.owner && manifest?.workspace === ctx.workspace) {
            const prefix = `refs/capyra/review/${key}/`;
            const references = (await git(source, ['for-each-ref', '--format=%(refname)%09%(objectname)', prefix], ctx.signal)).trim().split('\n').filter(Boolean);
            const migrate: { name: string; object: string }[] = [];
            for (const line of references) {
              const [name, object] = line.split('\t'); if (!name?.startsWith(prefix) || !object || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) continue;
              const suffix = name.slice(prefix.length); let expected: unknown;
              if (suffix === 'open') expected = manifest.open?.tree;
              else if (suffix === 'last') expected = manifest.last?.tree;
              else {
                const match = /^([a-f0-9-]{36})\/(before|after)$/.exec(suffix); if (!match) continue;
                try { const record = JSON.parse(await readFile(path.join(context.stateDir, 'reviews', `${match[1]}.json`), 'utf8')); if (record.owner === ctx.owner && record.workspace === ctx.workspace && record.scope === 'workspace') expected = record[match[2] === 'before' ? 'base' : 'snapshot']; }
                catch { continue; }
              }
              if (expected === object) migrate.push({ name, object });
            }
            const knownObjects = new Set(migrate.map(item => item.object));
            for (const line of references) {
              const [name, object] = line.split('\t');
              if ((name === prefix + 'open' || name === prefix + 'last') && object && knownObjects.has(object) && !migrate.some(item => item.name === name)) migrate.push({ name, object });
            }
            for (let start = 0; start < migrate.length; start += 32) {
              const batch = migrate.slice(start, start + 32);
              await git(directory, ['-c', 'protocol.file.allow=always', '-c', 'uploadpack.packObjectsHook=', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', source, ...batch.map(item => `+${item.name}:${item.name}`)], ctx.signal);
              for (const item of batch) {
                if ((await git(directory, ['rev-parse', '--verify', `${item.name}^{tree}`], ctx.signal)).trim() !== item.object) throw new Error('Review reference changed during private migration');
                await git(source, ['update-ref', '-d', item.name, item.object], ctx.signal);
              }
            }
          }
          return directory;
        })();
        reviewRepositories.set(key, pending);
        void pending.catch(() => { if (reviewRepositories.get(key) === pending) reviewRepositories.delete(key); });
      }
      return pending;
    };
    const reviewGit = async (ctx: ToolContext, args: string[], options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}) => git(await reviewRepository(ctx), args, ctx.signal, false, options);
    const captureReview = async (ctx: ToolContext): Promise<ReviewSnapshot> => {
      const root = await repository(ctx.workspace, ctx.signal);
      const names = [...new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], ctx.signal)).split('\0').filter(Boolean))].sort();
      if (names.length > 20_000) throw new Error('Review snapshot exceeds 20000 paths; select a smaller workspace');
      const captured: { name: string; mode: string; file: string }[] = []; const binary: string[] = []; const skipped: SnapshotSkip[] = []; let bytes = 0;
      await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(path.join(context.stateDir, 'review-index-'));
      const env = { GIT_INDEX_FILE: path.join(temporary, 'index') };
      try {
        for (const name of names) {
          checkCancelled(ctx.signal);
          if (name.split('/').some(isBlockedName)) continue;
          const absolute = path.resolve(root, name);
          if (absolute === path.resolve(context.stateDir) || absolute.startsWith(path.resolve(context.stateDir) + path.sep)) continue;
          let target: string;
          try { target = await workspacePath(root, name, { allowMissing: true }); }
          catch (error) {
            // 被删除的父目录没有内容；其旧条目仍在基线树中，可生成完整目录删除差异。
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            skipped.push({ path: name, reason: 'unsupported_path' }); continue;
          }
          let info;
          try { info = await lstat(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; skipped.push({ path: name, reason: 'unreadable' }); continue; }
          if (!info.isFile() || info.nlink > 1) { skipped.push({ path: name, reason: 'unsupported_path' }); continue; }
          if (info.size > MAX_FILE_BYTES) { skipped.push({ path: name, reason: 'large_file', bytes: info.size }); continue; }
          let data: Buffer;
          try {
            const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { data = await readBinaryHandle(handle, ctx.signal); } finally { await handle.close(); }
          } catch (error) {
            checkCancelled(ctx.signal);
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            skipped.push({ path: name, reason: /limit|exceeds/.test(String(error)) ? 'large_file' : 'unreadable' }); continue;
          }
          bytes += data.length;
          if (bytes > 64 * 1024 * 1024) throw new Error('Review snapshot exceeds 64 MiB; select a smaller workspace');
          try { if (new TextDecoder('utf-8', { fatal: true }).decode(data).includes('\0')) binary.push(name); }
          catch { binary.push(name); }
          const file = path.join(temporary, `blob-${captured.length}`);
          await writeFile(file, data, { flag: 'wx', mode: 0o600 });
          captured.push({ name, mode: info.mode & 0o111 ? '100755' : '100644', file });
        }
        // 批量散列私有临时副本：保留逐文件安全读取，避免每个文件额外启动一个 Git 进程。
        const hashes = captured.length ? (await reviewGit(ctx, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: captured.map(item => JSON.stringify(item.file)).join('\n') + '\n' })).trim().split('\n') : [];
        if (hashes.length !== captured.length) throw new Error('Git snapshot object count does not match captured files');
        const entries = captured.map((item, index) => `${item.mode} ${objectId({ commit: hashes[index] })}\t${item.name}\0`);
        await reviewGit(ctx, ['read-tree', '--empty'], { env });
        if (entries.length) await reviewGit(ctx, ['update-index', '-z', '--index-info'], { env, input: entries.join('') });
        const tree = (await reviewGit(ctx, ['write-tree'], { env })).trim(); objectId({ commit: tree });
        return { tree, binary, skipped };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    };
    const compareReview = async (ctx: ToolContext, before: ReviewSnapshot, after: ReviewSnapshot) => {
      const root = await repository(ctx.workspace, ctx.signal);
      const command = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-l1000', before.tree, after.tree];
      const statusParts = (await reviewGit(ctx, [...command, '--name-status', '-z', '--'])).split('\0');
      const stats = new Map<string, { additions: number; removals: number }>();
      const numstat = (await reviewGit(ctx, [...command, '--numstat', '-z', '--'])).split('\0');
      for (let i = 0; i < numstat.length; i++) {
        const field = numstat[i]!; if (!field) continue;
        const first = field.indexOf('\t'); const second = field.indexOf('\t', first + 1);
        if (first < 0 || second < 0) throw new Error('Invalid Git review statistics');
        let name = field.slice(second + 1);
        if (!name) { i++; name = numstat[++i]!; }
        stats.set(name, { additions: Number(field.slice(0, first)) || 0, removals: Number(field.slice(first + 1, second)) || 0 });
      }
      const skipped = new Map([...before.skipped, ...after.skipped].map(item => [item.path, item.reason]));
      const binary = new Set([...before.binary, ...after.binary]);
      const files: ReviewFile[] = []; let output = ''; let truncated = false;
      for (let i = 0; i < statusParts.length;) {
        const code = statusParts[i++]!; if (!code) continue;
        const first = statusParts[i++]!; const previousPath = code.startsWith('R') ? first : undefined;
        const name = previousPath ? statusParts[i++]! : first;
        if ((code.startsWith('D') || previousPath) && !skipped.has(previousPath ?? name)) {
          const oldPath = previousPath ?? name;
          try {
            const target = await workspacePath(root, oldPath, { allowMissing: true });
            if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) {
              skipped.set(oldPath, 'excluded');
              if (!after.skipped.some(item => item.path === oldPath)) after.skipped.push({ path: oldPath, reason: 'excluded' });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped.set(oldPath, 'unsupported_path'); if (!after.skipped.some(item => item.path === oldPath)) after.skipped.push({ path: oldPath, reason: 'unsupported_path' }); }
          }
        }
        const omitted = skipped.get(name) ?? (previousPath ? skipped.get(previousPath) : undefined);
        const isBinary = binary.has(name) || Boolean(previousPath && binary.has(previousPath));
        const file: ReviewFile = { path: name, ...(previousPath ? { previousPath } : {}), type: omitted ? 'change' : previousPath ? 'rename' : code.startsWith('A') ? 'new' : code.startsWith('D') ? 'deleted' : 'change', ...(omitted || isBinary ? { additions: 0, removals: 0 } : stats.get(name) ?? { additions: 0, removals: 0 }), ...(isBinary ? { binary: true, contentOmitted: 'binary' } : {}), ...(omitted ? { contentOmitted: omitted } : {}) };
        files.push(file);
        if (omitted || isBinary) continue;
        if (output.length >= 128 * 1024) { truncated = true; continue; }
        const patch = await reviewGit(ctx, [...command, '--', ...(previousPath ? [previousPath, name] : [name])]);
        const remaining = 128 * 1024 - output.length;
        output += patch.slice(0, remaining); if (patch.length > remaining) truncated = true;
      }
      if (files.length > 5000) throw new Error('Review exceeds 5000 changed or skipped files; select a smaller workspace');
      return { diff: output, truncated, files };
    };
    const baselines = createReviewBaselines(context.stateDir, {
      capture: captureReview, compare: compareReview,
      async ref(ctx, name) { try { return (await reviewGit(ctx, ['rev-parse', '--verify', `${name}^{tree}`])).trim(); } catch (error) { checkCancelled(ctx.signal); if (/unknown revision|single revision|ambiguous argument|Needed a single revision|bad revision|Not a valid object/.test(String(error))) return undefined; throw error; } },
      async retain(ctx, name, tree) { await reviewGit(ctx, ['update-ref', name, objectId({ commit: tree })]); },
      async hasTree(ctx, tree) { try { return (await reviewGit(ctx, ['cat-file', '-t', objectId({ commit: tree })])).trim() === 'tree'; } catch { checkCancelled(ctx.signal); return false; } },
    });
    context.onDispose(() => baselines.close());
    context.provide<GitService>('git', { status, diff, worktrees: listWorktrees, reviewSave, reviewRead, reviewOpen: baselines.open, reviewChanges: baselines.changes });
    context.registerTool({ name: 'review_open', title: 'Open the workspace review baseline', description: 'Freeze the accessible working-tree state on the first approved open for this caller and workspace, including staged, unstaged and untracked paths. Repeated opens retain the original checkpoint. Does not change the user index.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult(await baselines.open(ctx)); } });
    context.registerTool({ name: 'review_changes', title: 'Review changes since workspace open or last shown', description: 'Save a full workspace review against the original open or last-shown checkpoint and advance last-shown. Includes accessible staged, unstaged, untracked, removed and renamed files; binary and oversized contents are marked omitted. Reopen returned ID with review_read without advancing checkpoints.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { since: { type: 'string', enum: ['workspace_open', 'last_shown'] } }, additionalProperties: false }, async execute(args, ctx) { return textResult(await baselines.changes(ctx, { since: args.since as ReviewSince | undefined })); } });
    context.registerTool({ name: 'status', title: 'Inspect Git status', description: 'List accessible changed files, current branch, immutable HEAD and staged SHA-256 for an approved commit.', effect: 'read', permissions: ['git:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult(await status(ctx.workspace, ctx.signal)); } });
    context.registerTool({ name: 'diff', title: 'Review Git changes', description: 'Review working-tree, staged or historical commit differences. Protected file contents and external diff/textconv helpers are excluded. Up to 128 KiB.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { staged: { type: 'boolean' }, path: pathSchema, commit: commitSchema }, additionalProperties: false }, async execute(args, ctx) { return textResult(await diff(ctx.workspace, ctx.signal, args as { staged?: boolean; path?: string; commit?: string })); } });
    context.registerTool({ name: 'log', title: 'Read commit history', description: 'Return recent commit IDs, author names, timestamps and subjects. Optional path restricts history to one accessible file.', effect: 'read', permissions: ['git:read'], inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, path: pathSchema }, additionalProperties: false }, async execute(args, ctx) {
      const root = await repository(ctx.workspace, ctx.signal); const limit = args.limit ?? 20;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
      if (args.path !== undefined) await workspacePath(root, stringArg(args, 'path'), { allowMissing: true });
      if (!await head(root, ctx.signal)) return textResult({ commits: [] });
      const output = await git(root, ['log', `-${limit}`, '--format=%H%x00%an%x00%aI%x00%s%x00', '--', ...(typeof args.path === 'string' ? [args.path] : [])], ctx.signal);
      const parts = output.split('\0'); const commits = [];
      for (let i = 0; i + 3 < parts.length; i += 4) commits.push({ id: parts[i]!.trim(), author: parts[i + 1], at: parts[i + 2], subject: parts[i + 3] });
      return textResult({ commits });
    } });
    const historical = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const root = await repository(ctx.workspace, ctx.signal); const name = stringArg(args, 'path'); const commit = objectId(args);
      await requireCommit(root, commit, ctx.signal);
      await workspacePath(root, name, { allowMissing: true });
      const tree = await git(root, ['ls-tree', '-z', commit, '--', name], ctx.signal);
      if (!/^100[0-7]{3} blob [a-f0-9]+\t/.test(tree)) throw new Error('Historical path must be a regular file');
      const blob = /^100[0-7]{3} blob ([a-f0-9]+)\t/.exec(tree)![1]!;
      if (Number((await git(root, ['cat-file', '-s', blob], ctx.signal)).trim()) > MAX_FILE_BYTES) throw new Error('Historical file exceeds the 1 MiB limit');
      const content = await git(root, ['cat-file', 'blob', blob], ctx.signal, true);
      textBytes(content);
      return { path: name, commit, content, hash: sha256(textBytes(content)) };
    };
    context.registerTool({ name: 'show', title: 'Read a file from a commit', description: 'Read a regular UTF-8 file from a full commit ID within the workspace path boundary.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { path: pathSchema, commit: commitSchema }, required: ['path', 'commit'], additionalProperties: false }, async execute(args, ctx) { return textResult(await historical(args, ctx)); } });
    context.registerTool({ name: 'restore', title: 'Restore one historical file', description: 'Restore one regular text file from an immutable commit. Existing files require expectedHash; new paths require expectedMissing. This updates the working file and preserves Git history and the index.', effect: 'write', permissions: ['git:read', 'workspace:write'], inputSchema: { type: 'object', properties: { path: pathSchema, commit: commitSchema, expectedHash: hashSchema, expectedMissing: { type: 'boolean', const: true } }, required: ['path', 'commit'], oneOf: [{ required: ['expectedHash'] }, { required: ['expectedMissing'] }], additionalProperties: false }, async preview(args, ctx) {
      const file = await historical(args, ctx); let before = '(missing)';
      if (args.expectedMissing !== true) { const old = await readWorkspaceFile(ctx.workspace, file.path, ctx.signal); assertHash(old.hash, expectedHash(args)); before = old.content; }
      return { title: `恢复 ${file.path}`, description: `Commit: ${file.commit}\nRestored SHA-256: ${file.hash}`, before: before.slice(0, 12_000), after: file.content.slice(0, 12_000) };
    }, async execute(args, ctx) { const file = await historical(args, ctx); return applyWrite(file.path, file.content, args.expectedMissing === true ? undefined : expectedHash(args), ctx); } });
    const preparedCommit = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const root = await repository(ctx.workspace, ctx.signal); await requireHead(root, args, ctx.signal);
      const staged = await rawStaged(root, ctx.signal); assertHash(sha256(Buffer.from(staged)), expectedHash({ expectedHash: args.expectedStagedHash }));
      if (!staged) throw new Error('No staged changes to commit');
      const names = (await git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--'], ctx.signal)).split('\0').filter(Boolean);
      if ((await safePaths(root, names, ctx.signal)).length !== names.length) throw new Error('Staged changes include protected or inaccessible paths; review them locally');
      const message = stringArg(args, 'message'); if (!message.trim() || message.length > 10_000 || message.includes('\0')) throw new Error('Commit message must contain 1–10000 characters');
      const identity: string[] = [];
      const selected: Record<string, string> = {};
      for (const field of ['name', 'email']) {
        const local = (await git(root, ['config', '--get', `user.${field}`], ctx.signal).catch(() => '')).trim();
        const value = local || author[field];
        if (!value) throw new Error(`Git user.${field} is not configured; set a Git identity or configure the Git plugin author`);
        selected[field] = value;
        if (!local) identity.push('-c', `user.${field}=${value}`);
      }
      return { root, staged: (await diff(root, ctx.signal, { staged: true })).diff, message, identity, author: selected };
    };
    context.registerTool({ name: 'commit', title: 'Commit staged changes', description: 'Commit exactly the staged changes observed in status using expectedHead and expectedStagedHash. Hooks and GPG signing are disabled. Uses repository identity, then configured/global author name and email.', effect: 'execute', permissions: ['git:write'], inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 10000 }, expectedHead: { anyOf: [commitSchema, { type: 'null' }] }, expectedStagedHash: hashSchema }, required: ['message', 'expectedHead', 'expectedStagedHash'], additionalProperties: false }, async preview(args, ctx) { const item = await preparedCommit(args, ctx); return { title: '提交暂存区变更', description: `Message: ${item.message}\nAuthor: ${item.author.name} <${item.author.email}>\nStaged SHA-256: ${args.expectedStagedHash}\nRepository: ${ctx.workspace}`, after: item.staged.slice(0, 12_000) }; }, async execute(args, ctx) { const item = await preparedCommit(args, ctx); await git(item.root, [...item.identity, 'commit', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '-m', item.message], ctx.signal); return textResult({ commit: await head(item.root, ctx.signal) }); } });
    context.registerTool({ name: 'worktrees', title: 'List isolated worktrees', description: 'List this checkout and Capyra-managed worktrees, including removed worktrees that can be recovered.', effect: 'read', permissions: ['git:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult(await listWorktrees(ctx.workspace, ctx.signal)); } });
    const prepareWorktree = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const root = await repository(ctx.workspace, ctx.signal); const base = objectId(args, 'base');
      const name = stringArg(args, 'path'); const destination = await workspacePath(root, name, { allowMissing: true });
      try { await lstat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { root, base: (await git(root, ['rev-parse', '--verify', `${base}^{commit}`], ctx.signal)).trim(), name, destination }; }
      throw new Error('Worktree destination already exists');
    };
    context.registerTool({ name: 'worktree_create', title: 'Create an isolated worktree', description: 'Create a detached worktree at an unused relative directory from an immutable commit ID. The parent directory must exist. Source uncommitted changes remain in the source checkout.', effect: 'execute', permissions: ['git:write', 'workspace:write'], inputSchema: { type: 'object', properties: { path: pathSchema, base: commitSchema }, required: ['path', 'base'], additionalProperties: false }, timeoutMs: 45_000, async preview(args, ctx) { const item = await prepareWorktree(args, ctx); return { title: `创建隔离工作区 ${item.name}`, description: `Base commit: ${item.base}\nDestination: ${item.destination}` }; }, async execute(args, ctx) {
      const item = await prepareWorktree(args, ctx);
      await git(item.root, ['worktree', 'add', '--detach', item.destination, item.base], ctx.signal);
      const entry: ManagedWorktree = { id: randomUUID(), source: item.root, path: item.destination, base: item.base, createdAt: new Date().toISOString() };
      try { await save([...managed, entry]); }
      catch (error) {
        // 注册失败只能撤销仍干净的新目录；用户已经写入的内容不随失败回滚删除。
        const cleanup = new AbortController().signal;
        try {
          if ((await git(entry.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], cleanup)).trim()) throw new Error('New worktree contains changes');
          await git(item.root, ['worktree', 'remove', entry.path], cleanup);
        } catch {
          throw new Error(`Worktree registration failed; directory ${entry.path} is preserved but is not registered in Capyra. Inspect it with git worktree list before retrying. ${String(error)}`, { cause: error });
        }
        throw new Error(`Worktree registration failed; the clean new checkout was removed. Existing source files are unchanged; retry after fixing state storage. ${String(error)}`, { cause: error });
      }
      return textResult({ ...entry, instructions: 'Register this directory in the local project console to select it for new tasks.' });
    } });
    const managedEntry = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const root = await repository(ctx.workspace, ctx.signal); const id = stringArg(args, 'id'); const entry = managed.find(item => item.id === id && item.source === root);
      if (!entry) throw new Error('Unknown managed worktree in this source repository');
      await workspacePath(root, path.relative(root, entry.path).split(path.sep).join('/'), { allowMissing: true });
      if (entry.path === root) throw new Error('Cannot remove the current workspace');
      return { root, entry };
    };
    const assertInactive = (entry: ManagedWorktree) => {
      let active: string | undefined;
      try { active = context.service<ProjectsService>('projects').current().path; } catch { /* Without a project registry only the source workspace can be active. */ }
      if (active === entry.path) throw new Error('Select another project before removing its active worktree');
    };
    const saveArchive = async (entry: ManagedWorktree, recovery: string, kind: 'head' | 'stash') => {
      entry.recovery = recovery; entry.recoveryKind = kind;
      try { await save(); }
      catch (error) { throw new Error(`Worktree archive record save failed; directory ${entry.path} was not removed. Recovery ${recovery} is retained; fix state storage and retry. ${String(error)}`, { cause: error }); }
    };
    const saveRemoved = async (entry: ManagedWorktree) => {
      entry.removedAt = new Date().toISOString();
      try { await save(); }
      catch (error) { throw new Error(`Worktree ${entry.id} was removed but the final registry update failed. Its saved recovery ${entry.recovery} remains available; inspect or restore this ID after fixing state storage, including after restart. ${String(error)}`, { cause: error }); }
    };
    context.registerTool({ name: 'worktree_remove', title: 'Remove a clean managed worktree', description: 'Remove a Capyra-managed worktree only when tracked, untracked and ignored files are clean. Its current commit is saved as a recovery reference, so detached commits remain recoverable.', effect: 'execute', permissions: ['git:write', 'workspace:write'], inputSchema: { type: 'object', properties: { id: { type: 'string' }, expectedHead: commitSchema }, required: ['id', 'expectedHead'], additionalProperties: false }, async preview(args, ctx) { const { entry } = await managedEntry(args, ctx); await requireHead(entry.path, args, ctx.signal); const dirty = await git(entry.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], ctx.signal); if (dirty.trim()) throw new Error('Worktree contains tracked, untracked or ignored changes; commit or move them before removal'); return { title: '移除干净的隔离工作区', description: `Directory: ${entry.path}\nRecovery commit: ${args.expectedHead}` }; }, async execute(args, ctx) {
      const { root, entry } = await managedEntry(args, ctx); if (entry.removedAt) throw new Error('Worktree is already removed'); assertInactive(entry);
      const current = await requireHead(entry.path, args, ctx.signal);
      if ((await git(entry.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], ctx.signal)).trim()) throw new Error('Worktree is not clean; removal stopped');
      const recovery = `refs/capyra/worktrees/${entry.id}`;
      await git(root, ['update-ref', recovery, current!], ctx.signal);
      await saveArchive(entry, current!, 'head');
      await git(root, ['worktree', 'remove', entry.path], ctx.signal);
      await saveRemoved(entry);
      return textResult({ id: entry.id, removed: true, recovery: entry.recovery });
    } });
    const preparePrune = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const { root, entry } = await managedEntry(args, ctx); assertInactive(entry);
      if (entry.removedAt) throw new Error('Worktree is already removed');
      const current = await requireHead(entry.path, args, ctx.signal);
      assertHash(await changesHash(entry.path, ctx.signal), expectedHash({ expectedHash: args.expectedChangesHash }));
      const raw = await git(entry.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], ctx.signal);
      if (raw.split('\n').some(line => line.startsWith('??') || line.startsWith('!!'))) throw new Error('Untracked or ignored files prevent pruning; move or commit them first');
      const changed = (await git(entry.path, ['diff', 'HEAD', '--name-only', '-z', '--no-renames', '--'], ctx.signal)).split('\0').filter(Boolean);
      if ((await safePaths(entry.path, changed, ctx.signal)).length !== changed.length) throw new Error('Protected or inaccessible changed files prevent pruning; review them locally');
      return { root, entry, current: current!, dirty: raw.trim().length > 0 };
    };
    context.registerTool({ name: 'worktree_inspect', title: 'Inspect a managed worktree', description: 'Read the status and immutable change hash of one managed worktree without switching projects. An interrupted restore reports any existing directory and its retained archive.', effect: 'read', permissions: ['git:read'], inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, async execute(args, ctx) {
      const { entry } = await managedEntry(args, ctx);
      if (entry.removedAt) {
        const present = await lstat(entry.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!present) return textResult(entry);
        return textResult({ ...entry, recoveryState: 'directory_present', instructions: 'The directory exists while the registry still records removal. Its archive is retained. Restore can finish the registry update only if tracked files and index match the archive; changed files are preserved for local inspection.', status: await status(entry.path, ctx.signal) });
      }
      return textResult({ ...entry, status: await status(entry.path, ctx.signal) });
    } });
    context.registerTool({ name: 'worktree_prune', title: 'Archive and prune a managed worktree', description: 'Save tracked staged and unstaged changes in a retained Git recovery object, then remove the managed directory. Requires exact HEAD and changesHash from worktree_inspect. Untracked and ignored files prevent pruning.', effect: 'execute', permissions: ['git:write', 'workspace:write'], inputSchema: { type: 'object', properties: { id: { type: 'string' }, expectedHead: commitSchema, expectedChangesHash: hashSchema }, required: ['id', 'expectedHead', 'expectedChangesHash'], additionalProperties: false }, async preview(args, ctx) { const item = await preparePrune(args, ctx); return { title: '归档并清理隔离工作区', description: `Directory: ${item.entry.path}\nHEAD: ${item.current}\nChange hash: ${args.expectedChangesHash}\nTracked changes will be retained for recovery.` }; }, async execute(args, ctx) {
      const item = await preparePrune(args, ctx);
      const recovery = item.dirty ? (await git(item.entry.path, ['stash', 'create', `Capyra worktree ${item.entry.id}`], ctx.signal)).trim() : item.current;
      objectId({ commit: recovery });
      await git(item.root, ['update-ref', `refs/capyra/worktrees/${item.entry.id}`, recovery], ctx.signal);
      // 恢复引用先落盘，再重新核对被审阅的变更；新出现的用户改动不会被清理。
      await preparePrune(args, ctx);
      await saveArchive(item.entry, recovery, item.dirty ? 'stash' : 'head');
      await git(item.root, ['worktree', 'remove', '--force', item.entry.path], ctx.signal);
      await saveRemoved(item.entry);
      return textResult({ id: item.entry.id, removed: true, recovery, recoveryKind: item.entry.recoveryKind });
    } });
    const prepareRestore = async (args: Record<string, unknown>, ctx: ToolContext) => {
      const { root, entry } = await managedEntry(args, ctx); if (!entry.removedAt || !entry.recovery) throw new Error('Worktree is not in a recoverable removed state');
      const recovery = objectId({ commit: entry.recovery });
      const base = entry.recoveryKind === 'stash' ? `${recovery}^1` : recovery;
      const present = await lstat(entry.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (present) {
        // 最终记录发布失败时，显式重试只校验并登记已恢复的目录，不再次套用 stash。
        const existing = await repository(entry.path, ctx.signal);
        const common = async (location: string) => realpath(path.resolve(location, (await git(location, ['rev-parse', '--git-common-dir'], ctx.signal)).trim()));
        const flags = ['--name-only', '--no-ext-diff', '--no-textconv'];
        if (await common(existing) !== await common(root) || await head(existing, ctx.signal) !== (await git(root, ['rev-parse', base], ctx.signal)).trim()
          || (await git(existing, ['diff', ...flags, recovery, '--'], ctx.signal)).trim()
          || (await git(existing, ['diff', '--cached', ...flags, entry.recoveryKind === 'stash' ? `${recovery}^2` : recovery, '--'], ctx.signal)).trim()) {
          throw new Error(`Existing worktree differs from its saved archive; all files are preserved and recovery ${recovery} is retained. Inspect ${entry.path} locally before completing recovery.`);
        }
      }
      return { root, entry, recovery, base, present: !!present };
    };
    context.registerTool({ name: 'worktree_restore', title: 'Recover a managed worktree', description: 'Recreate a removed worktree, restoring tracked staged and unstaged changes. If a previous restore finished but its registry save failed, verify the existing files and repair only the registry.', effect: 'execute', permissions: ['git:write', 'workspace:write'], inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, async preview(args, ctx) { const item = await prepareRestore(args, ctx); return { title: item.present ? '确认已恢复工作区的登记' : '恢复隔离工作区', description: `Directory: ${item.entry.path}\nCommit: ${item.recovery}` }; }, async execute(args, ctx) {
      const { root, entry, recovery, base, present } = await prepareRestore(args, ctx);
      if (!present) {
        await git(root, ['worktree', 'add', '--detach', entry.path, base], ctx.signal);
        // 应用失败时保留恢复目录及引用，便于本机处理冲突，绝不强制删除部分恢复的文件。
        if (entry.recoveryKind === 'stash') await git(entry.path, ['stash', 'apply', '--index', recovery], ctx.signal);
      }
      const restored = { ...entry }; delete restored.removedAt;
      try { await save(managed.map(item => item === entry ? restored : item)); }
      catch (error) { throw new Error(`Worktree files were restored but the registry update failed; all files and recovery ${recovery} are preserved. Fix state storage, inspect ${entry.id}, and retry restore to finish registration. ${String(error)}`, { cause: error }); }
      return textResult({ ...restored, ...(present ? { reconciled: true } : {}) });
    } });
    context.registerTool({ name: 'review_save', title: 'Save an immutable change review', description: 'Save the current accessible diff locally and return a review ID that can be reopened after edits or a service restart.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { staged: { type: 'boolean' } }, additionalProperties: false }, async execute(args, ctx) { return textResult(await reviewSave(ctx, { staged: args.staged === true })); } });
    context.registerTool({ name: 'review_read', title: 'Reopen a saved change review', description: 'Read an immutable saved diff by review ID for its original caller and workspace.', effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, required: ['id'], additionalProperties: false }, async execute(args, ctx) { return textResult(await reviewRead(ctx, stringArg(args, 'id'))); } });
  },
};
export default plugin;
