import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../core/types.js';
import type { GitReview } from '../plugins/git.js';

export type ReviewSince = 'workspace_open' | 'last_shown';
export interface SnapshotSkip { path: string; reason: 'large_file' | 'unsupported_path' | 'unreadable' | 'excluded'; bytes?: number }
export interface ReviewSnapshot { tree: string; binary: string[]; skipped: SnapshotSkip[] }
export interface ReviewFile { path: string; previousPath?: string; type: 'new' | 'deleted' | 'change' | 'rename'; additions: number; removals: number; binary?: boolean; contentOmitted?: string }
interface Checkpoints { version: 1; owner: string; workspace: string; openedAt: string; open: ReviewSnapshot; last: ReviewSnapshot }
interface Backend {
  capture(ctx: ToolContext): Promise<ReviewSnapshot>;
  compare(ctx: ToolContext, before: ReviewSnapshot, after: ReviewSnapshot): Promise<{ diff: string; truncated: boolean; files: ReviewFile[] }>;
  ref(ctx: ToolContext, name: string): Promise<string | undefined>;
  retain(ctx: ToolContext, name: string, tree: string): Promise<void>;
  hasTree(ctx: ToolContext, tree: string): Promise<boolean>;
}

/** 串行化同一调用者的同一工作区；展示新审阅推进 last，历史读取完全不进入此状态机。 */
export function createReviewBaselines(stateDir: string, backend: Backend) {
  const queues = new Map<string, Promise<unknown>>();
  let closed = false;
  const keyFor = (ctx: ToolContext) => createHash('sha256').update(JSON.stringify([ctx.owner, ctx.workspace])).digest('hex');
  const fileFor = (key: string) => path.join(stateDir, 'review-checkpoints', `${key}.json`);
  const refFor = (key: string, name: string) => `refs/capyra/review/${key}/${name}`;
  const validTree = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const alive = (ctx: ToolContext) => { ctx.signal.throwIfAborted(); if (closed) throw new Error('Review service was unloaded'); };
  const serial = <T>(ctx: ToolContext, operation: (key: string) => Promise<T>) => {
    const key = keyFor(ctx); const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => { alive(ctx); return operation(key); });
    queues.set(key, run); void run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {}); return run;
  };
  async function save(key: string, state: Checkpoints, ctx: ToolContext) {
    alive(ctx); const file = fileFor(key); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); alive(ctx); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  async function open(key: string, ctx: ToolContext) {
    let state: Checkpoints | undefined;
    try { state = JSON.parse(await readFile(fileFor(key), 'utf8')) as Checkpoints; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Review checkpoint manifest is invalid; it cannot be reconstructed from current files'); }
    const [openRef, lastRef] = await Promise.all([backend.ref(ctx, refFor(key, 'open')), backend.ref(ctx, refFor(key, 'last'))]);
    if (state) {
      if (state.version !== 1 || state.owner !== ctx.owner || state.workspace !== ctx.workspace || !validTree(state.open?.tree) || !validTree(state.last?.tree) || !Array.isArray(state.open.skipped) || !Array.isArray(state.last.skipped) || !Array.isArray(state.open.binary) || !Array.isArray(state.last.binary)) throw new Error('Review checkpoint manifest is invalid');
      if (!await backend.hasTree(ctx, state.open.tree) || !await backend.hasTree(ctx, state.last.tree)) throw new Error('Review checkpoint objects are missing; current files cannot reconstruct that history');
      // 已落盘 manifest 是提交点；中断只可能留下滞后/超前的 refs，按原有对象恢复即可。
      if (openRef !== state.open.tree) await backend.retain(ctx, refFor(key, 'open'), state.open.tree);
      if (lastRef !== state.last.tree) await backend.retain(ctx, refFor(key, 'last'), state.last.tree);
      alive(ctx); return { state, created: false };
    }
    if (openRef || lastRef) throw new Error('Review checkpoint manifest is missing; current files cannot reconstruct that history');
    const snapshot = await backend.capture(ctx); alive(ctx);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 120 * 1024) throw new Error('Review checkpoint metadata exceeds the client output limit');
    state = { version: 1, owner: ctx.owner, workspace: ctx.workspace, openedAt: new Date().toISOString(), open: snapshot, last: snapshot };
    // 初始 manifest 先提交：之后任一 ref 写入被取消，也能由准确的初始对象恢复。
    await save(key, state, ctx);
    await backend.retain(ctx, refFor(key, 'open'), snapshot.tree);
    await backend.retain(ctx, refFor(key, 'last'), snapshot.tree);
    return { state, created: true };
  }
  return {
    open(ctx: ToolContext) { return serial(ctx, async key => { const value = await open(key, ctx); return { available: true, openedAt: value.state.openedAt, reused: !value.created, skipped: value.state.open.skipped }; }); },
    changes(ctx: ToolContext, options: { since?: ReviewSince } = {}): Promise<GitReview> {
      if (options.since !== undefined && !['workspace_open', 'last_shown'].includes(options.since)) return Promise.reject(new Error('Invalid review baseline'));
      return serial(ctx, async key => {
        const { state, created } = await open(key, ctx); const since = options.since ?? 'last_shown';
        const before = since === 'workspace_open' ? state.open : state.last;
        const after = await backend.capture(ctx); const compared = await backend.compare(ctx, before, after); alive(ctx);
        const skipped = [...new Map([...before.skipped, ...after.skipped].map(item => [item.path, item])).values()];
        const review: GitReview = { id: randomUUID(), owner: ctx.owner, workspace: ctx.workspace, createdAt: new Date().toISOString(), base: before.tree, staged: false, scope: 'workspace', since, baselineCreated: created, snapshot: after.tree, skipped, ...compared };
        if (Buffer.byteLength(JSON.stringify(review), 'utf8') > 240 * 1024) throw new Error('Review metadata exceeds the client output limit; no review checkpoint was advanced');
        const folder = path.join(stateDir, 'reviews'); await mkdir(folder, { recursive: true, mode: 0o700 });
        await backend.retain(ctx, refFor(key, `${review.id}/before`), before.tree);
        await backend.retain(ctx, refFor(key, `${review.id}/after`), after.tree);
        alive(ctx); await writeFile(path.join(folder, `${review.id}.json`), JSON.stringify(review), { flag: 'wx', mode: 0o600 });
        // 只有审阅记录持久化后才推进 last；异常时保留已有记录，不回滚用户文件或 index。
        await backend.retain(ctx, refFor(key, 'last'), after.tree);
        await save(key, { ...state, last: after }, ctx); return review;
      });
    },
    async close() { closed = true; await Promise.allSettled(queues.values()); },
  };
}
