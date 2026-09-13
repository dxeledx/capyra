import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '../core/types.js';
import { AgentManager, type AgentRecord } from '../execution/agent-manager.js';
import { agentWriteMode, type AgentWriteMode } from '../execution/agent-permissions.js';
import { executionEnvironment, type SessionPage } from '../execution/sessions.js';
import { configurationRevision, DaemonError, daemonPaths, daemonSecret, processAlive, protocolVersion, readPrivate, readPublished, signRequest, validateTargetHash, type Scope } from './security.js';
import type { DaemonStatus } from './server.js';
import { outputOptions, readSavedOutput, type OutputOptions } from './output.js';

const starts = new Map<string, Promise<void>>();
const stopped: DaemonStatus = { running: false, active: 0, sessions: 0, processModel: 'detached-on-demand', state: 'stopped' };
const offline = (error: unknown) => ['ENOENT', 'ECONNREFUSED', 'DAEMON_UNAVAILABLE'].includes((error as NodeJS.ErrnoException).code ?? '');
type RunArgs = { target: string; prompt: string; cwd?: string; model?: string; effort?: string; writeMode?: AgentWriteMode; expectedTargetHash?: string };
type ContinueArgs = { prompt: string; model?: string; effort?: string; writeMode?: AgentWriteMode; expectedTargetHash?: string };

/** 仅派发时启动独立进程；客户端生命周期不会传播成代理任务取消。 */
export class AgentDaemonClient {
  private sockets = new Set<Socket>();
  private closed = false;
  readonly paths;
  readonly revision: string;
  constructor(readonly stateDir: string, readonly config: Record<string, unknown> = {}) { this.paths = daemonPaths(stateDir); this.revision = configurationRevision(config); }
  private reader() { return new AgentManager(undefined, this.stateDir, this.config, { readOnly: true }); }
  async catalog(workspace: string) { return this.reader().catalog(workspace); }
  async preview(target: string, workspace: string) { return this.reader().preview(target, workspace); }
  private async request<T>(method: string, params: Record<string, unknown> = {}, scope?: Scope, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new DaemonError('DAEMON_CLIENT_CLOSED', 'Agent daemon client has been closed.');
    signal?.throwIfAborted();
    const secret = await readPublished(() => daemonSecret(this.stateDir), signal); if (!secret) throw new DaemonError('DAEMON_UNAVAILABLE', 'Agent daemon is not running.');
    const lock = await readPublished(() => JSON.parse(readPrivate(this.paths.lock, 256)), signal);
    const request = signRequest(secret, { version: protocolVersion, id: randomUUID(), method, params, ...(scope ? { scope } : {}), revision: this.revision, instance: String(lock.nonce) });
    return new Promise<T>((resolve, reject) => {
      const socket = connect(this.paths.endpoint); this.sockets.add(socket); let input = Buffer.alloc(0), finished = false;
      const finish = (error?: unknown, result?: T) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); this.sockets.delete(socket); socket.destroy(); if (error) reject(error); else resolve(result!); };
      const abort = () => finish(signal?.reason ?? new Error('Daemon request cancelled.'));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
      socket.setTimeout(15_000, () => finish(new DaemonError('DAEMON_TIMEOUT', 'Daemon request timed out. Inspect existing sessions before retrying a dispatch.')));
      socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
      socket.on('error', finish); socket.once('close', () => { if (!finished) finish(new DaemonError('DAEMON_UNAVAILABLE', 'Daemon disconnected. Inspect existing sessions before retrying a dispatch.')); });
      socket.on('data', chunk => {
        input = Buffer.concat([input, chunk]); if (input.length > 8 * 1024 * 1024) { finish(new DaemonError('DAEMON_RESPONSE_TOO_LARGE', 'Daemon response exceeded its limit.')); return; }
        const end = input.indexOf(10); if (end < 0) return;
        try {
          const response = JSON.parse(input.subarray(0, end).toString('utf8'));
          if (response.version !== protocolVersion || response.id !== request.id || typeof response.ok !== 'boolean') throw new DaemonError('DAEMON_PROTOCOL', 'Invalid daemon response.');
          if (!response.ok) throw new DaemonError(String(response.error?.code ?? 'DAEMON_FAILED'), String(response.error?.message ?? 'Daemon request failed.'));
          finish(undefined, response.result);
        } catch (error) { finish(error); }
      });
    });
  }
  private async ensure(): Promise<void> {
    try {
      const hello = await this.request<{ configMatches: boolean; status: DaemonStatus }>('hello');
      if (hello.configMatches) return;
      if (hello.status.active) throw new DaemonError('DAEMON_CONFIG_CHANGED', 'Agent configuration changed while tasks are running. Wait for their completion before dispatching with the new configuration.');
      await this.stop();
    } catch (error) { if (!offline(error)) throw error; }
    const key = this.paths.directory;
    if (starts.has(key)) { await starts.get(key); return this.ensure(); }
    const operation = this.start(); starts.set(key, operation);
    try { await operation; } finally { starts.delete(key); }
    const hello = await this.request<{ configMatches: boolean }>('hello');
    if (!hello.configMatches) throw new DaemonError('DAEMON_CONFIG_CHANGED', 'Another client started the daemon with a different provider configuration. Retry after its active work finishes.');
  }
  private async start() {
    await readPublished(() => daemonSecret(this.stateDir, true));
    const filename = path.join(this.paths.directory, `boot-${randomBytes(16).toString('hex')}.json`);
    writeFileSync(filename, JSON.stringify({ stateDir: path.resolve(this.stateDir), config: this.config }), { flag: 'wx', mode: 0o600 });
    const log = openSync(this.paths.log, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './main.ts' : './main.js', import.meta.url));
    const args = entry.endsWith('.ts') ? ['--import', fileURLToPath(import.meta.resolve('tsx')), entry, filename] : [entry, filename];
    let failed: Error | undefined;
    try {
      // 不继承MCP标准输入/输出与IPC channel；unref使启动者退出后后台仍持有代理。
      const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', log, log], cwd: this.stateDir,
        env: executionEnvironment({ login: true, inherit: this.providerEnvironmentKeys() }) });
      child.once('error', error => { failed = error; }); child.unref();
    } finally { closeSync(log); }
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (failed) throw new DaemonError('DAEMON_START_FAILED', 'Could not start the agent daemon. Check the local daemon log.');
        try { await this.request('hello'); return; } catch (error) { if (!offline(error)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new DaemonError('DAEMON_START_FAILED', 'Agent daemon did not become ready. Check agents daemon logs.');
    } finally { rmSync(filename, { force: true }); }
  }
  private providerEnvironmentKeys(): string[] {
    return [...new Set(['providers', 'roles'].flatMap(category => Object.values((this.config[category] ?? {}) as Record<string, unknown>).flatMap(value => {
      const keys = (value as { inheritEnv?: unknown })?.inheritEnv; return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && key !== 'NODE_OPTIONS') : [];
    })))];
  }
  async run(args: RunArgs, ctx: ToolContext) { ctx.signal.throwIfAborted(); if (args.writeMode !== undefined) agentWriteMode(args.writeMode); validateTargetHash(args.expectedTargetHash); await this.ensure(); ctx.signal.throwIfAborted(); return this.request<AgentRecord>('run', { ...args, taskId: ctx.taskId }, { owner: ctx.owner, workspace: ctx.workspace }, ctx.signal); }
  async continue(id: string, args: ContinueArgs, ctx: ToolContext) { ctx.signal.throwIfAborted(); if (args.writeMode !== undefined) agentWriteMode(args.writeMode); validateTargetHash(args.expectedTargetHash); await this.ensure(); ctx.signal.throwIfAborted(); return this.request<AgentRecord>('continue', { id, ...args, taskId: ctx.taskId }, { owner: ctx.owner, workspace: ctx.workspace }, ctx.signal); }
  async get(id: string, owner: string, workspace: string): Promise<AgentRecord> {
    try { return await this.request('get', { id }, { owner, workspace }); } catch (error) { if (!offline(error)) throw error; return this.offlineRecord(this.reader().get(id, owner, workspace)); }
  }
  async list(owner: string, workspace: string): Promise<ReturnType<AgentManager['list']>> {
    try { return await this.request('list', {}, { owner, workspace }); } catch (error) {
      if (!offline(error)) throw error; const alive = this.lockAlive();
      return this.reader().list(owner, workspace).map(record => ['starting', 'running'].includes(record.status) ? { ...record, status: alive ? record.status : 'interrupted' as const, error: alive ? 'Daemon owner exists but progress is unverified.' : 'Daemon unavailable; previous work was not replayed. Inspect effects before continuing.' } : record);
    }
  }
  async listLocal(workspace?: string): Promise<AgentRecord[]> {
    try { return await this.request('listLocal', { workspace }); } catch (error) { if (!offline(error)) throw error; return this.reader().listLocal(workspace).map(record => this.offlineRecord(record)); }
  }
  private offlineRecord(record: AgentRecord) {
    if (!['starting', 'running'].includes(record.status)) return record;
    return this.lockAlive() ? { ...record, error: 'Daemon owner process exists but cannot be reached; current progress is unverified.' }
      : { ...record, status: 'interrupted' as const, error: 'Daemon unavailable; previous work was not replayed. Inspect effects before continuing.' };
  }
  async wait(ids: string[], owner: string, workspace: string, waitMs = 12_000, signal?: AbortSignal): Promise<AgentRecord[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(id => typeof id === 'string') || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12_000) throw new Error('Wait accepts 1–20 IDs and waitMs between 0 and 12000.');
    try { return await this.request('wait', { ids, waitMs }, { owner, workspace }, signal); } catch (error) { if (!offline(error)) throw error; return Promise.all(ids.map(id => this.get(id, owner, workspace))); }
  }
  async cancel(id: string, owner: string, workspace: string): Promise<AgentRecord> { try { return await this.request('cancel', { id }, { owner, workspace }); } catch (error) { if (!offline(error)) throw error; return this.get(id, owner, workspace); } }
  async readOutput(agentId: string, sessionId: string | undefined, owner: string, workspace: string, options: OutputOptions = {}, signal?: AbortSignal): Promise<SessionPage> {
    outputOptions(options); signal?.throwIfAborted();
    try { return await this.request('readOutput', { id: agentId, sessionId, ...options }, { owner, workspace }, signal); }
    catch (error) {
      if (!offline(error)) throw error;
      return readSavedOutput(path.join(this.paths.directory, 'runtime', 'process-sessions'), this.reader().get(agentId, owner, workspace), sessionId, options, this.lockAlive());
    }
  }
  async cancelOwner(owner?: string): Promise<AgentRecord[]> { try { return await this.request('cancelOwner', { owner }); } catch (error) { if (!offline(error)) throw error; if (this.lockAlive()) throw new DaemonError('DAEMON_UNREACHABLE', 'Daemon owner still exists; cancellation could not be confirmed.'); return []; } }
  async status(): Promise<DaemonStatus> { try { return await this.request('status'); } catch (error) { if (!offline(error)) throw error; const alive = this.lockAlive(); return { ...stopped, state: alive ? 'unreachable' : 'stopped', sessions: this.reader().status().sessions }; } }
  async stop(force = false) {
    try { await this.request('stop', { force }); } catch (error) { if (offline(error)) { if (this.lockAlive()) throw new DaemonError('DAEMON_UNREACHABLE', 'Daemon owner still exists; stopping could not be confirmed.'); return { stopped: true }; } throw error; }
    for (let attempt = 0; attempt < 220; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); try { await this.request('status'); } catch (error) { if (offline(error)) { if (!this.lockAlive()) return { stopped: true }; } else if ((error as DaemonError).code !== 'DAEMON_STOPPING') throw error; } }
    throw new DaemonError('DAEMON_STOP_TIMEOUT', 'Daemon is still stopping; check status before dispatching again.');
  }
  private lockAlive() { try { const lock = JSON.parse(readPrivate(this.paths.lock, 256)); return Number.isInteger(lock.pid) && processAlive(lock.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  logs(lines = 100) { if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error('Log lines must be between 1 and 1000.'); try { return readPrivate(this.paths.log, 1024 * 1024).trimEnd().split('\n').slice(-lines).join('\n'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
  async close() { this.closed = true; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
}
