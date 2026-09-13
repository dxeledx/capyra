import { randomUUID } from 'node:crypto';

export type ResultVisibility = 'client' | 'local';
export interface AccessRequest {
  id: string;
  owner: string;
  /** 冻结请求发起时的工作区，手机批准不能跟随之后的项目切换。 */
  workspace?: string;
  method: string;
  description: string;
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}
export interface AccessDecision { allowed: boolean; visibility: ResultVisibility; reason?: 'denied' | 'expired' | 'cancelled' | 'paused' }
export interface AccessController {
  pending(): AccessRequest[];
  request(input: Omit<AccessRequest, 'id' | 'createdAt' | 'expiresAt'>, signal?: AbortSignal): Promise<AccessDecision>;
  decide(id: string, allow: boolean, visibility?: ResultVisibility): void;
  cancelOwner(owner?: string): void;
  generation(owner: string): string;
  pause(paused: boolean): void;
  close(): void;
}

// 给本机操作者留出核对时间，并在常见 MCP 客户端的 60 秒请求截止前返回。
export const DEFAULT_APPROVAL_TIMEOUT_MS = 50_000;
/** 审批绑定内存中的单次请求回调；ID 只供本机控制台使用，不是可轮询的读取凭据。 */
export function createAccessController(timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS): AccessController {
  const pending = new Map<string, { request: AccessRequest; finish(decision: AccessDecision): void }>();
  let paused = false;
  let closed = false;
  let generation = 0;
  const ownerGenerations = new Map<string, number>();
  const cancelOwner = (owner?: string) => {
    if (owner) ownerGenerations.set(owner, (ownerGenerations.get(owner) ?? 0) + 1);
    else { generation++; ownerGenerations.clear(); }
    for (const entry of [...pending.values()]) if (!owner || entry.request.owner === owner) entry.finish({ allowed: false, visibility: 'local', reason: 'cancelled' });
  };
  return {
    pending: () => [...pending.values()].map(entry => structuredClone(entry.request)),
    request(input, signal) {
      if (closed || signal?.aborted) return Promise.resolve({ allowed: false, visibility: 'local', reason: 'cancelled' });
      if (paused) return Promise.resolve({ allowed: false, visibility: 'local', reason: 'paused' });
      if (pending.size >= 128 || [...pending.values()].filter(entry => entry.request.owner === input.owner).length >= 32) return Promise.resolve({ allowed: false, visibility: 'local', reason: 'denied' });
      return new Promise(resolve => {
        const now = Date.now();
        const request: AccessRequest = { ...structuredClone(input), id: randomUUID(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString() };
        let settled = false;
        const abort = () => finish({ allowed: false, visibility: 'local', reason: 'cancelled' });
        const finish = (decision: AccessDecision) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pending.delete(request.id);
          resolve(decision);
        };
        const timer = setTimeout(() => finish({ allowed: false, visibility: 'local', reason: 'expired' }), timeoutMs);
        pending.set(request.id, { request, finish });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    decide(id, allow, visibility = 'local') {
      if (visibility !== 'client' && visibility !== 'local') throw new Error('Invalid result visibility.');
      const entry = pending.get(id);
      if (!entry) throw new Error('This request has expired, disconnected, or already been decided.');
      if (Date.parse(entry.request.expiresAt) <= Date.now()) {
        entry.finish({ allowed: false, visibility: 'local', reason: 'expired' });
        throw new Error('This request has expired.');
      }
      entry.finish({ allowed: allow, visibility: allow ? visibility : 'local', ...(!allow ? { reason: 'denied' as const } : {}) });
    },
    cancelOwner,
    generation(owner) { return `${generation}:${ownerGenerations.get(owner) ?? 0}`; },
    pause(value) { if (value && !paused) cancelOwner(); paused = value; },
    close() { closed = true; cancelOwner(); },
  };
}
