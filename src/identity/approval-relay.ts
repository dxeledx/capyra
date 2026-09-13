import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeEvent, TaskRecord } from '../core/types.js';
import type { AccessController, AccessRequest } from '../transport/access.js';
import type { IdentityService, ApprovalBinding } from './client.js';
import type { ApprovalRelayStatus } from './types.js';
import type { MobileApprovalRequest, MobileApprovalDecision } from './mobile-approvals.js';

interface RelayRuntime {
  readonly isPaused: boolean;
  currentWorkspace(): string;
  listTasks(): TaskRecord[];
  getTask(id: string, owner?: string): TaskRecord | undefined;
  approveTask(id: string, approve: boolean, visibility?: 'local' | 'client'): Promise<unknown>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
export type RelayIdentity = Pick<IdentityService, 'status' | 'approvalBinding' | 'onBindingChanged' | 'syncApprovals' | 'setApprovalRelayStatus'>;
export interface ApprovalRelayOptions {
  runtime: RelayRuntime; access: AccessController; identity(): RelayIdentity | undefined;
  intervalMs?: number; now?(): number;
}
interface FrozenRequest { key: string; localId: string; owner: string; source: string; request: MobileApprovalRequest }
interface Source { localId: string; owner: string; kind: 'access' | 'task'; workspace: string; description: string; expiresAt: number; details: Record<string, unknown> }
const maxDetailBytes = 32 * 1024;
const maxSnapshotBytes = 256 * 1024;

/** 规范化完整待批准输入，属性顺序变化不会制造新批准，命令、正文和归属的变化必定更换摘要。 */
export function canonicalApproval(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => current && typeof current === 'object' && !Array.isArray(current)
    ? Object.fromEntries(Object.keys(current).sort().map(key => [key, (current as Record<string, unknown>)[key]])) : current);
}
const bindingKey = (binding: ApprovalBinding | undefined) => binding ? canonicalApproval(binding) : '';

export function createApprovalRelay(options: ApprovalRelayOptions) {
  const now = options.now ?? Date.now;
  const instance = randomUUID();
  let epoch = 0;
  let closed = false;
  let service: RelayIdentity | undefined;
  let identityKey = '';
  let offBinding: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operation: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let frozen = new Map<string, FrozenRequest>();
  let status: ApprovalRelayStatus = { state: 'inactive', pending: 0, requiresLocalApproval: [] };
  const setStatus = (value: Partial<ApprovalRelayStatus>) => { status = { ...status, ...value }; service?.setApprovalRelayStatus(status); };
  const reset = () => { epoch++; clearTimeout(timer); controller?.abort(); frozen.clear(); };
  const bind = () => {
    const current = options.identity();
    if (current === service) return;
    reset(); offBinding?.();
    service?.setApprovalRelayStatus({ state: 'inactive', pending: 0, requiresLocalApproval: [] });
    service = current; identityKey = bindingKey(service?.approvalBinding());
    offBinding = service?.onBindingChanged(() => {
      const next = bindingKey(service?.approvalBinding());
      const cloudUrl = service?.status().cloudUrl;
      setStatus({ approvalUrl: cloudUrl ? cloudUrl + '/approve' : undefined });
      if (next !== identityKey) { identityKey = next; reset(); setStatus({ state: next ? 'ready' : 'inactive', pending: 0, requiresLocalApproval: [] }); schedule(); }
    });
    setStatus({ state: identityKey ? 'ready' : 'inactive', pending: 0, error: undefined, requiresLocalApproval: [], approvalUrl: service?.status().cloudUrl ? service.status().cloudUrl + '/approve' : undefined });
  };
  const source = (kind: 'access' | 'task', value: AccessRequest | TaskRecord, binding: ApprovalBinding): Source => {
    const workspace = value.workspace ?? '';
    const details = { originalRequestId: value.id, request: value, workspace,
      binding, generation: { instance, epoch, owner: options.access.generation(value.owner) },
      ...(kind === 'task' ? { previewState: (value as TaskRecord).preview ? 'ready' : (value as TaskRecord).previewError ? 'failed' : 'not_prepared' } : {}) };
    return { localId: value.id, owner: value.owner, kind, workspace,
      description: kind === 'access' ? (value as AccessRequest).description : `批准${(value as TaskRecord).effect === 'execute' ? '执行' : (value as TaskRecord).effect === 'write' ? '修改' : '读取'}：${(value as TaskRecord).tool}`,
      expiresAt: Date.parse(value.expiresAt ?? ''), details };
  };
  const currentSource = (entry: FrozenRequest, binding: ApprovalBinding) => {
    const value = entry.request.kind === 'access' ? options.access.pending().find(item => item.id === entry.localId && item.owner === entry.owner)
      : options.runtime.getTask(entry.localId, entry.owner);
    if (!value || (entry.request.kind === 'task' && (value as TaskRecord).status !== 'awaiting_approval')) return undefined;
    return source(entry.request.kind, value, binding);
  };
  const collect = (binding: ApprovalBinding) => {
    const skipped: ApprovalRelayStatus['requiresLocalApproval'] = [];
    const requests: MobileApprovalRequest[] = [];
    const next = new Map<string, FrozenRequest>();
    const pending: Source[] = [
      ...options.access.pending().map(value => source('access', value, binding)),
      ...options.runtime.listTasks().filter(value => value.status === 'awaiting_approval').map(value => source('task', value, binding)),
    ].sort((a, b) => a.expiresAt - b.expiresAt || a.localId.localeCompare(b.localId));
    for (const item of pending) {
      const key = `${item.kind}:${item.localId}`;
      let reason: string | undefined;
      let encoded = '';
      try { encoded = canonicalApproval(item); }
      catch { reason = '请求无法完整序列化，请在本机批准。'; }
      if (!reason && (!item.workspace || item.workspace.length > 4096)) reason = '缺少准确的原始工作区，请在本机批准。';
      if (!reason && (!Number.isFinite(item.expiresAt) || item.expiresAt <= now())) reason = '请求已过期或缺少明确的有效期，请在本机重新发起。';
      if (!reason && (item.description.length > 4096 || Buffer.byteLength(canonicalApproval(item.details)) > maxDetailBytes)) reason = '完整请求详情超过手机批准限制，请在本机核对并批准；内容没有截断上传。';
      if (reason) { skipped.push({ id: item.localId, kind: item.kind, reason }); continue; }
      let entry = frozen.get(key);
      if (!entry || entry.source !== encoded || entry.request.expiresAt <= now()) {
        // 任务可在本机等待十分钟，但每个手机快照最多四分钟且到期不续写原 ID。
        const expiresAt = Math.min(item.expiresAt, now() + 4 * 60_000);
        const digest = createHash('sha256').update(canonicalApproval({ source: item, expiresAt })).digest('hex');
        entry = { key, localId: item.localId, owner: item.owner, source: encoded, request: {
          id: randomUUID(), kind: item.kind, digest, description: item.description, workspace: item.workspace,
          details: JSON.parse(canonicalApproval(item.details)) as Record<string, unknown>, expiresAt,
        } };
      }
      if (requests.length >= 128 || Buffer.byteLength(JSON.stringify({ requests: [...requests, entry.request] })) > maxSnapshotBytes) {
        skipped.push({ id: item.localId, kind: item.kind, reason: '本轮完整手机批准队列已满，请在本机批准或等待前面的请求处理完成。' }); continue;
      }
      next.set(key, entry); requests.push(entry.request);
    }
    frozen = next;
    setStatus({ pending: requests.length, requiresLocalApproval: skipped });
    return requests;
  };
  const validDecision = (value: MobileApprovalDecision) => value && typeof value === 'object' && ['access', 'task'].includes(value.kind)
    && typeof value.id === 'string' && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.approve === 'boolean' && ['local', 'client'].includes(value.visibility);
  const synchronize = async () => {
    bind();
    if (closed) return;
    if (options.runtime.isPaused) { reset(); setStatus({ state: 'paused', pending: 0, requiresLocalApproval: [] }); return; }
    const binding = service?.approvalBinding();
    if (!service || !binding) { reset(); setStatus({ state: 'inactive', pending: 0, requiresLocalApproval: [] }); return; }
    if (identityKey !== bindingKey(binding)) { identityKey = bindingKey(binding); reset(); }
    const activeService = service, activeEpoch = epoch;
    controller = new AbortController(); const signal = controller.signal;
    const requests = collect(binding);
    const sent = new Map([...frozen.values()].map(item => [item.request.id, item]));
    const fresh = () => !closed && !signal.aborted && !options.runtime.isPaused && options.identity() === activeService && epoch === activeEpoch && bindingKey(activeService.approvalBinding()) === bindingKey(binding);
    setStatus({ state: 'syncing', error: undefined });
    try {
      const response = await activeService.syncApprovals(requests, { signal });
      if (!fresh()) return;
      if (response.deviceId !== binding.deviceId || response.version !== binding.version || !Array.isArray(response.decisions) || response.decisions.some(item => !validDecision(item))) throw new Error('Invalid approval response');
      for (const decision of response.decisions) {
        if (!fresh()) break;
        const entry = sent.get(decision.id);
        if (!entry || decision.kind !== entry.request.kind || decision.digest !== entry.request.digest || entry.request.expiresAt <= now()) continue;
        const current = currentSource(entry, binding);
        // 核对与消费之间没有 await；本机按钮和手机决定只能有一个先占用原请求。
        if (!current || canonicalApproval(current) !== entry.source || current.expiresAt <= now()) continue;
        sent.delete(decision.id); frozen.delete(entry.key);
        try {
          if (entry.request.kind === 'access') options.access.decide(entry.localId, decision.approve, decision.visibility);
          else await options.runtime.approveTask(entry.localId, decision.approve, decision.visibility);
        } catch { /* 本机先处理、取消或过期时，手机旧决定直接失效，不重新申请批准。 */ }
      }
      if (fresh()) setStatus({ state: 'ready', lastSyncedAt: new Date(now()).toISOString(), error: undefined });
    } catch {
      if (fresh()) setStatus({ state: 'error', error: '手机批准同步失败；本机批准仍可用。' });
    }
  };
  const syncNow = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (operation) return operation;
    const pending = synchronize(); operation = pending;
    void pending.finally(() => { if (operation === pending) operation = undefined; }).catch(() => undefined);
    return pending;
  };
  function schedule() {
    clearTimeout(timer);
    if (closed || options.intervalMs === 0 || options.runtime.isPaused || !service?.approvalBinding()) return;
    timer = setTimeout(() => { void syncNow().then(schedule, schedule); }, options.intervalMs ?? 2000); timer.unref();
  }
  const offEvents = options.runtime.onEvent(event => {
    if (event.type.startsWith('plugin.') || ['runtime.paused', 'runtime.resumed', 'runtime.stopped'].includes(event.type)) {
      reset(); bind();
      if (event.type === 'runtime.paused') setStatus({ state: 'paused', pending: 0, requiresLocalApproval: [] });
      schedule();
    }
  });
  bind(); schedule();
  return {
    syncNow,
    status: () => structuredClone(status),
    close() { if (closed) return; closed = true; clearTimeout(timer); reset(); offEvents(); offBinding?.(); setStatus({ state: 'inactive', pending: 0, requiresLocalApproval: [] }); },
  };
}
