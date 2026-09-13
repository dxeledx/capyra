import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, ftruncateSync, linkSync, lstatSync, openSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { AgentManager, type AgentRecord } from '../execution/agent-manager.js';
import { agentWriteMode } from '../execution/agent-permissions.js';
import { ProcessSessions } from '../execution/sessions.js';
import { configurationRevision, DaemonError, daemonPaths, daemonSecret, privateDirectory, processAlive, protocolVersion, readPrivate, validateTargetHash, verifyRequest, type DaemonRequest } from './security.js';
import { agentProcessId, outputOptions, type OutputOptions } from './output.js';

export interface DaemonStatus { running: boolean; pid?: number; active: number; sessions: number; startedAt?: string; processModel: string; state?: string }

export class AgentDaemon {
  private server?: Server;
  private manager?: AgentManager;
  private sessions?: ProcessSessions;
  private sockets = new Set<Socket>();
  private seen = new Map<string, number>();
  private interval?: NodeJS.Timeout;
  private lockNonce = randomBytes(16).toString('hex');
  private locked = false;
  private closing?: Promise<void>;
  private draining = false;
  private lastBusy = Date.now();
  private startedAt = new Date().toISOString();
  readonly paths;
  readonly revision: string;
  constructor(readonly stateDir: string, readonly config: Record<string, unknown> = {}, private options: { idleMs?: number; onClosed?(): void } = {}) {
    this.paths = daemonPaths(stateDir); this.revision = configurationRevision(config);
  }
  private log(event: string) {
    // 诊断仅记录生命周期，不写入提示词、owner、工作区路径、配置或凭据。
    try {
      const fd = openSync(this.paths.log, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) return;
        if (info.size > 256_000) ftruncateSync(fd, 0);
        appendFileSync(fd, `${new Date().toISOString()} ${event}\n`);
      } finally { closeSync(fd); }
    } catch { /* 日志写入失败不能取消已经获准的代理工作。 */ }
  }
  private acquire() {
    privateDirectory(path.resolve(this.stateDir)); privateDirectory(this.paths.directory);
    const temporary = path.join(this.paths.directory, `.lock-${this.lockNonce}`);
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, nonce: this.lockNonce }), { flag: 'wx', mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { linkSync(temporary, this.paths.lock); this.locked = true; return; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const stat = lstatSync(this.paths.lock), previous = JSON.parse(readPrivate(this.paths.lock, 256));
          if (!Number.isInteger(previous.pid) || previous.pid < 1 || processAlive(previous.pid)) throw new DaemonError('DAEMON_ALREADY_RUNNING', 'Agent daemon is already running or starting.');
          // 只清理已经退出的拥有者；读取失败或未知 PID 都保留现场。
          const current = lstatSync(this.paths.lock);
          if (current.ino === stat.ino && current.dev === stat.dev) rmSync(this.paths.lock);
        }
      }
      throw new DaemonError('DAEMON_ALREADY_RUNNING', 'Another client is starting the daemon.');
    } finally { rmSync(temporary, { force: true }); }
  }
  async start() {
    this.acquire();
    try {
      const secret = daemonSecret(this.stateDir, true)!;
      if (process.platform !== 'win32') {
        privateDirectory(this.paths.socketDirectory);
        try { const info = lstatSync(this.paths.endpoint); if (!info.isSocket()) throw new DaemonError('DAEMON_UNSAFE_SOCKET', 'Daemon socket path is occupied by a non-socket file.'); rmSync(this.paths.endpoint); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      // 取得唯一进程所有权后才能恢复状态，竞争启动的失败者绝不重写运行中记录。
      this.sessions = new ProcessSessions(path.join(this.paths.directory, 'runtime'));
      this.manager = new AgentManager(this.sessions, this.stateDir, this.config);
      this.server = createServer(socket => {
        if (this.closing || this.sockets.size >= 32) { socket.destroy(); return; }
        this.sockets.add(socket); const controller = new AbortController();
        socket.once('close', () => { this.sockets.delete(socket); controller.abort(); });
        socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy());
        let input = Buffer.alloc(0), handled = false;
        socket.on('data', chunk => {
          if (handled) { socket.destroy(); return; }
          input = Buffer.concat([input, chunk]);
          if (input.length > 256_000) { socket.destroy(); return; }
          const end = input.indexOf(10); if (end < 0) return;
          handled = true; socket.setTimeout(15_000); this.lastBusy = Date.now();
          void (async () => {
            let id = '';
            try {
              const request = verifyRequest(secret, JSON.parse(input.subarray(0, end).toString('utf8'))); id = request.id;
              if (request.instance !== this.lockNonce) throw new DaemonError('DAEMON_AUTH_EXPIRED', 'This request belongs to a previous daemon instance.');
              if (this.seen.has(id)) throw new DaemonError('DAEMON_REPLAY', 'This daemon request has already been used.');
              for (const [key, created] of this.seen) if (created < Date.now() - 10 * 60_000) this.seen.delete(key);
              if (this.seen.size >= 10_000) throw new DaemonError('DAEMON_BUSY', 'Daemon request limit reached; retry later.');
              this.seen.set(id, Date.now());
              const result = await this.dispatch(request, controller.signal);
              const encoded = JSON.stringify({ version: protocolVersion, id, ok: true, result });
              if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 - 1) throw new DaemonError('DAEMON_RESPONSE_TOO_LARGE', 'Result exceeds the IPC limit. Query fewer agent IDs or read one agent at a time.');
              socket.end(encoded + '\n');
            } catch (error) {
              socket.end(JSON.stringify({ version: protocolVersion, id, ok: false, error: { code: error instanceof DaemonError ? error.code : 'AGENT_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Agent operation failed.' } }) + '\n');
            }
          })();
        });
      });
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.paths.endpoint, () => { this.server!.removeListener('error', reject); resolve(); }); });
      this.server.on('error', () => { this.log('daemon_socket_error'); void this.close(); });
      if (process.platform !== 'win32') chmodSync(this.paths.endpoint, 0o600);
      this.log('daemon_started');
      const idleMs = this.options.idleMs ?? Number(this.config.daemonIdleMs ?? 30_000);
      if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 24 * 60 * 60_000) throw new DaemonError('DAEMON_CONFIG', 'daemonIdleMs must be between 100 and 86400000.');
      this.interval = setInterval(() => {
        if (this.manager!.status().active || this.sockets.size) this.lastBusy = Date.now();
        else if (Date.now() - this.lastBusy >= idleMs) { this.log('daemon_idle_stop'); void this.close(); }
      }, Math.min(250, idleMs));
      return this.status();
    } catch (error) { await this.close(); throw error; }
  }
  status(): DaemonStatus { return { running: !!this.server?.listening && !this.closing, pid: process.pid, active: this.manager?.status().active ?? 0, sessions: this.manager?.status().sessions ?? 0, startedAt: this.startedAt, state: this.closing ? 'stopping' : 'ready', processModel: 'detached-on-demand' }; }
  private async dispatch(request: DaemonRequest, signal: AbortSignal): Promise<unknown> {
    if (this.closing || this.draining) throw new DaemonError('DAEMON_STOPPING', 'Agent daemon is stopping.');
    const manager = this.manager!, args = request.params;
    if (request.method === 'hello') return { status: this.status(), configMatches: request.revision === this.revision };
    if (request.method === 'status') return this.status();
    if (request.method === 'stop') {
      if (request.scope) throw new DaemonError('DAEMON_SCOPE', 'Daemon management requires local administration.');
      if (manager.status().active && args.force !== true) throw new DaemonError('DAEMON_ACTIVE', 'Agents are still running. Wait for completion or explicitly use --force to interrupt them.');
      this.draining = true; setTimeout(() => { void this.close(); }, 20); return { stopping: true };
    }
    if (request.method === 'listLocal' || request.method === 'cancelOwner') {
      if (request.scope) throw new DaemonError('DAEMON_SCOPE', 'Local administration is required.');
      if (request.method === 'listLocal') return manager.listLocal(optionalString(args.workspace)).map(compactRecord);
      return (await manager.cancelOwner(optionalString(args.owner))).map(compactRecord);
    }
    const scope = request.scope;
    if (!scope) throw new DaemonError('DAEMON_SCOPE', 'An authenticated owner and workspace are required.');
    // owner/workspace 来自整条请求的本机签名；参数中的同名字段不能改变权限范围。
    if ('owner' in args || 'workspace' in args || 'scope' in args) throw new DaemonError('DAEMON_SCOPE', 'Agent parameters cannot override the authenticated scope.');
    const context = { ...scope, taskId: requiredString(args.taskId ?? request.id), signal: new AbortController().signal, progress() {} };
    const values = { prompt: ['run', 'continue'].includes(request.method) ? requiredString(args.prompt) : '', model: optionalString(args.model), effort: optionalString(args.effort), writeMode: args.writeMode === undefined ? undefined : agentWriteMode(args.writeMode), expectedTargetHash: validateTargetHash(args.expectedTargetHash) };
    if (['run', 'continue'].includes(request.method) && request.revision !== this.revision) throw new DaemonError('DAEMON_CONFIG_CHANGED', 'Agent configuration changed; wait for active agents to finish before starting another turn.');
    switch (request.method) {
      case 'run': return manager.run({ ...values, target: requiredString(args.target), cwd: optionalString(args.cwd) }, context);
      case 'continue': return manager.continue(requiredString(args.id), values, context);
      case 'get': return manager.get(requiredString(args.id), scope.owner, scope.workspace);
      case 'list': return manager.list(scope.owner, scope.workspace);
      case 'wait': {
        if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) throw new Error('Agent IDs must be a string list.');
        const records = await manager.wait(args.ids, scope.owner, scope.workspace, args.waitMs as number | undefined, signal);
        // 等待返回当前结果和turn元数据；历史正文按需show，避免多agent放大IPC负载。
        return records.map(record => compactRecord(record, 128_000));
      }
      case 'cancel': return manager.cancel(requiredString(args.id), scope.owner, scope.workspace);
      case 'readOutput': {
        const agent = manager.get(requiredString(args.id), scope.owner, scope.workspace), id = agentProcessId(agent, optionalString(args.sessionId));
        return this.sessions!.read(id, scope.owner, scope.workspace, outputOptions(args as OutputOptions), signal);
      }
      default: throw new DaemonError('DAEMON_METHOD', 'Unknown daemon operation.');
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearInterval(this.interval);
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      await this.manager?.close(); await this.sessions?.close();
      if (this.locked) {
        try {
          const record = JSON.parse(readPrivate(this.paths.lock, 256));
          if (record.nonce === this.lockNonce) {
            if (process.platform !== 'win32') { rmSync(this.paths.endpoint, { force: true }); if (this.paths.socketDirectory !== this.paths.directory) rmdirSync(this.paths.socketDirectory); }
            rmSync(this.paths.lock, { force: true });
          }
        } catch { /* 清理只处理仍由本进程持有的锁。 */ }
        this.locked = false; this.log('daemon_stopped');
      }
      this.options.onClosed?.();
    })();
    return this.closing;
  }
}
function requiredString(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Expected a nonempty string.'); return value; }
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : requiredString(value); }
function compactRecord(record: AgentRecord, limit = 4000) {
  return { ...record, response: record.response?.slice(-limit), progress: record.progress?.slice(-4000), turns: record.turns.map(({ prompt: _prompt, response: _response, error: _error, ...turn }) => ({ ...turn, prompt: '' })) };
}
