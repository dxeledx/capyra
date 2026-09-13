import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveProcessCommand } from './windows-command.js';

export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface ProcessSession {
  id: string; owner: string; workspace: string; taskId: string; kind: 'command' | 'terminal' | 'agent';
  command: string; args: string[]; cwd: string; status: SessionStatus; startedAt: string; endedAt?: string;
  pid?: number; exitCode?: number | null; signal?: string | null; error?: string; tty: boolean;
  sequence: number; capturedBytes: number; columns?: number; rows?: number;
  cleanupWarning?: string;
}
export interface OutputEntry { cursor: number; stream: 'stdout' | 'stderr'; text: string }
export interface SessionPage {
  session: ProcessSession; output: OutputEntry[]; nextCursor: number; firstCursor: number;
  hasMore: boolean; outputTruncated: boolean;
}
export interface StartProcess {
  owner: string; workspace: string; taskId: string; kind?: ProcessSession['kind']; command: string;
  args?: string[]; cwd: string; env?: NodeJS.ProcessEnv; tty?: boolean; columns?: number; rows?: number;
  timeoutMs?: number; signal?: AbortSignal;
  onOutput?(entry: OutputEntry): void; onExit?(session: ProcessSession): void;
}
interface Managed {
  record: ProcessSession; child?: ChildProcess; pty?: Pty; timeout?: NodeJS.Timeout;
  done: Promise<void>; resolveDone(): void; ended: boolean; stopping?: SessionStatus;
  onOutput?: StartProcess['onOutput']; onExit?: StartProcess['onExit']; logBytes: number;
}
interface Pty {
  pid: number; write(data: string): void; resize(columns: number, rows: number): void; kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
}
interface PtyModule { spawn(command: string, args: string[], options: Record<string, unknown>): Pty }
const clone = <T>(value: T): T => structuredClone(value);
const validId = /^[a-f0-9-]{36}$/;

export function executionEnvironment(options: { login?: boolean; inherit?: string[]; env?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'SystemRoot', 'WINDIR', 'PATHEXT',
    ...(options.login ? ['HOME', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] : []),
    ...(options.inherit ?? [])]) if (process.env[key] !== undefined) result[key] = process.env[key];
  // 登录态由各提供者的本机配置读取；宿主的令牌与 NODE_OPTIONS 不会隐式传入子进程。
  return { ...result, ...options.env };
}

/** 有界磁盘日志与会话独立于单次工具 Promise；停止插件会等待子进程树退出。 */
export class ProcessSessions {
  private records = new Map<string, ProcessSession>();
  private active = new Map<string, Managed>();
  private stops = new Map<string, Promise<ProcessSession>>();
  private closed = false;
  readonly directory: string;
  constructor(readonly stateDir: string, private options: { maxSessions?: number; maxLogBytes?: number; maxActive?: number } = {}) {
    this.directory = path.join(stateDir, 'process-sessions');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (lstatSync(stateDir).isSymbolicLink()) throw new Error('Process state directory cannot be a symbolic link');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Process sessions directory cannot be a symbolic link');
    for (const file of readdirSync(this.directory)) {
      if (!validId.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) continue;
      const filename = path.join(this.directory, file);
      try {
        const info = lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000) continue;
        const record = JSON.parse(readFileSync(filename, 'utf8')) as ProcessSession;
        if (record.id + '.json' !== file || typeof record.owner !== 'string' || typeof record.workspace !== 'string' || !Array.isArray(record.args)) continue;
        if (record.status === 'running') {
          // PID 可被操作系统复用，重启后不能据旧 PID 杀进程或重放命令。
          record.status = 'interrupted'; record.endedAt = new Date().toISOString();
          record.error = 'Capyra restarted during execution. The command was not replayed. The previous process is no longer supervised and may still be running; inspect its effects before starting again.';
          delete record.pid;
          this.save(record);
        }
        this.records.set(record.id, record);
      } catch { /* 损坏条目不能变成新的执行请求。 */ }
    }
    this.prune();
  }
  private file(id: string, suffix: string) { if (!validId.test(id)) throw new Error('Unknown process session'); return path.join(this.directory, `${id}${suffix}`); }
  private save(record: ProcessSession) {
    const temporary = this.file(record.id, `.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.file(record.id, '.json')); }
    finally { rmSync(temporary, { force: true }); }
  }
  private prune() {
    const keep = this.options.maxSessions ?? 100;
    const completed = [...this.records.values()].filter(record => record.status !== 'running').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.records.size >= keep && completed.length) {
      const record = completed.shift()!;
      for (const suffix of ['.json', '.jsonl', '.jsonl.1']) rmSync(this.file(record.id, suffix), { force: true });
      this.records.delete(record.id);
    }
  }
  private require(id: string, owner: string, workspace: string) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner || record.workspace !== workspace) throw new Error('Unknown process session');
    return record;
  }
  get(id: string, owner: string, workspace: string) { return clone(this.require(id, owner, workspace)); }
  list(owner: string, workspace: string, kind?: ProcessSession['kind']) {
    return [...this.records.values()].filter(record => record.owner === owner && record.workspace === workspace && (!kind || record.kind === kind)).reverse().map(clone);
  }
  listLocal(workspace?: string) { return [...this.records.values()].filter(record => workspace === undefined || record.workspace === workspace).reverse().map(clone); }
  async cancelOwner(owner?: string) {
    const selected = [...this.active.values()].filter(managed => owner === undefined ? managed.record.owner !== 'local-console' : managed.record.owner === owner);
    return Promise.all(selected.map(managed => this.stop(managed.record.id, managed.record.owner, managed.record.workspace)));
  }
  async ptyStatus() {
    try { this.loadPty(); return { available: true, installDirectory: path.join(this.stateDir, 'extensions', 'terminal') }; }
    catch { return { available: false, installDirectory: path.join(this.stateDir, 'extensions', 'terminal'), message: 'Install node-pty@1.1.0 in this directory to enable interactive terminals.' }; }
  }
  private loadPty(repairHelper = false): PtyModule {
    const extensionRequire = createRequire(path.join(this.stateDir, 'extensions', 'terminal', 'package.json'));
    const load = (require: NodeJS.Require) => {
      const entry = require.resolve('node-pty');
      if (repairHelper && process.platform === 'darwin') {
        const helper = path.resolve(path.dirname(entry), '..', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
        if (existsSync(helper)) {
          const info = lstatSync(helper);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid node-pty spawn helper');
          // 官方 1.1.0 npm 包漏了 macOS helper 执行位；仅在已批准的终端启动阶段修正。
          if (!(info.mode & 0o100)) chmodSync(helper, info.mode | 0o100);
        }
      }
      return require('node-pty') as PtyModule;
    };
    try { return load(extensionRequire); }
    catch {
      try { return load(createRequire(import.meta.url)); }
      catch { throw new Error('Interactive terminal needs the optional node-pty@1.1.0 extension. Install it from the local Capyra extension settings, then retry.'); }
    }
  }
  async start(input: StartProcess): Promise<ProcessSession> {
    if (this.closed) throw new Error('Process service has been unloaded');
    input.signal?.throwIfAborted();
    if (this.active.size >= (this.options.maxActive ?? 8)) throw new Error('Too many active process sessions; stop one before starting another');
    if (!input.owner || !input.workspace || !input.command || input.command.includes('\0') || (input.args ?? []).some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid process input');
    const ptyModule = input.tty ? this.loadPty(true) : undefined;
    this.prune();
    const record: ProcessSession = { id: randomUUID(), owner: input.owner, workspace: input.workspace, taskId: input.taskId,
      kind: input.kind ?? 'command', command: input.command, args: [...input.args ?? []], cwd: input.cwd,
      tty: !!input.tty, status: 'running', startedAt: new Date().toISOString(), sequence: 0, capturedBytes: 0,
      ...(input.tty ? { columns: input.columns ?? 100, rows: input.rows ?? 30 } : {}) };
    this.save(record);
    this.records.set(record.id, record);
    let resolveDone!: () => void;
    const managed: Managed = { record, done: new Promise(resolve => { resolveDone = resolve; }), resolveDone: () => resolveDone(), ended: false, onOutput: input.onOutput, onExit: input.onExit, logBytes: 0 };
    this.active.set(record.id, managed);
    try {
      if (ptyModule) {
        managed.pty = ptyModule.spawn(input.command, record.args, { cwd: input.cwd, env: input.env ?? executionEnvironment({ login: true }), cols: record.columns, rows: record.rows, name: 'xterm-256color' });
        record.pid = managed.pty.pid;
        managed.pty.onData(text => this.append(managed, 'stdout', text));
        managed.pty.onExit(({ exitCode, signal }) => this.finish(managed, exitCode, signal ? String(signal) : null));
      } else {
        const env = input.env ?? executionEnvironment();
        const invocation = resolveProcessCommand(input.command, record.args, { cwd: input.cwd, env });
        const child = spawn(invocation.command, invocation.args, { cwd: input.cwd, env, shell: false,
          detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        managed.child = child; record.pid = child.pid;
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
        for (const stream of ['stdout', 'stderr'] as const) {
          child[stream]!.on('data', (chunk: Buffer) => this.append(managed, stream, decoders[stream].write(chunk)));
          child[stream]!.on('end', () => this.append(managed, stream, decoders[stream].end()));
        }
        child.stdin!.on('error', () => {});
        child.on('error', error => this.finish(managed, null, null, `Unable to start process: ${error.message}`));
        child.on('close', (code, signal) => this.finish(managed, code, signal));
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      }
      this.save(record);
      if (input.timeoutMs) managed.timeout = setTimeout(() => {
        void this.stop(record.id, record.owner, record.workspace, 'timed_out').catch(error => {
          record.error = `Timeout termination could not be verified: ${String(error)}`;
          try { this.save(record); } catch { /* 原始进程仍由 active 集合跟踪，宿主关闭时会再次清理。 */ }
        });
      }, input.timeoutMs);
      if (input.signal?.aborted || this.closed) { await this.stop(record.id, record.owner, record.workspace); input.signal?.throwIfAborted(); throw new Error('Process service has been unloaded'); }
      return clone(record);
    } catch (error) {
      if (!managed.ended) this.finish(managed, null, null, error instanceof Error ? error.message : String(error));
      throw new Error(`Unable to start process: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private append(managed: Managed, stream: OutputEntry['stream'], text: string) {
    if (!text || managed.ended) return;
    const entry: OutputEntry = { cursor: ++managed.record.sequence, stream, text };
    try {
      const filename = this.file(managed.record.id, '.jsonl');
      const line = JSON.stringify(entry) + '\n';
      // 两代滚动文件限制磁盘与读取内存；cursor 让客户端发现自己错过了哪些历史输出。
      if (managed.logBytes >= (this.options.maxLogBytes ?? 2 * 1024 * 1024)) { renameSync(filename, this.file(managed.record.id, '.jsonl.1')); managed.logBytes = 0; }
      const descriptor = openSync(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { appendFileSync(descriptor, line); } finally { closeSync(descriptor); }
      managed.logBytes += Buffer.byteLength(line); managed.record.capturedBytes += Buffer.byteLength(text);
      managed.onOutput?.(entry);
    } catch (error) {
      managed.record.error = `Output capture failed: ${error instanceof Error ? error.message : String(error)}`;
      void this.stop(managed.record.id, managed.record.owner, managed.record.workspace, 'failed').catch(() => {});
    }
  }
  private finish(managed: Managed, exitCode: number | null, signal: string | null, error?: string) {
    if (managed.ended) return;
    managed.ended = true;
    clearTimeout(managed.timeout);
    Object.assign(managed.record, { status: managed.stopping ?? (error || exitCode !== 0 ? 'failed' : 'completed'), exitCode, signal, endedAt: new Date().toISOString(), ...(error ? { error } : {}) });
    this.active.delete(managed.record.id);
    try { this.save(managed.record); } catch (failure) { managed.record.error = `State persistence failed: ${String(failure)}`; managed.record.status = 'failed'; }
    managed.resolveDone();
    try { managed.onExit?.(clone(managed.record)); } catch { /* 观察者错误不改变已经退出的进程状态。 */ }
  }
  async read(id: string, owner: string, workspace: string, options: { cursor?: number; limit?: number; waitMs?: number } = {}, signal?: AbortSignal): Promise<SessionPage> {
    const record = this.require(id, owner, workspace);
    const cursor = options.cursor ?? 0, limit = options.limit ?? 16_384;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 262_144) throw new Error('Invalid cursor or output limit');
    const waitMs = options.waitMs ?? 0;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12_000) throw new Error('waitMs must be between 0 and 12000');
    const deadline = Date.now() + waitMs;
    while (record.status === 'running' && record.sequence <= cursor && Date.now() < deadline) {
      signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
    signal?.throwIfAborted();
    const entries: OutputEntry[] = [];
    for (const suffix of ['.jsonl.1', '.jsonl']) {
      const filename = this.file(id, suffix);
      if (!existsSync(filename)) continue;
      const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { for (const line of readFileSync(descriptor, 'utf8').split('\n')) if (line) entries.push(JSON.parse(line) as OutputEntry); }
      finally { closeSync(descriptor); }
    }
    const selected: OutputEntry[] = []; let bytes = 0;
    for (const entry of entries) if (entry.cursor > cursor) {
      // 一条输出最多来自一个 OS 管道块，保留整条以避免 cursor 截断时丢字。
      if (selected.length && bytes + Buffer.byteLength(entry.text) > limit) break;
      selected.push(entry); bytes += Buffer.byteLength(entry.text);
    }
    const nextCursor = selected.at(-1)?.cursor ?? cursor;
    const firstCursor = entries[0]?.cursor ?? record.sequence + 1;
    return { session: clone(record), output: selected, nextCursor, firstCursor, hasMore: entries.some(entry => entry.cursor > nextCursor), outputTruncated: cursor < firstCursor - 1 };
  }
  async wait(id: string, owner: string, workspace: string, signal?: AbortSignal) {
    this.require(id, owner, workspace);
    const managed = this.active.get(id);
    if (managed) {
      const abort = () => { void this.stop(id, owner, workspace).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { await managed.done; await this.stops.get(id); } finally { signal?.removeEventListener('abort', abort); }
    }
    return this.get(id, owner, workspace);
  }
  async write(id: string, owner: string, workspace: string, text: string, end = false) {
    this.require(id, owner, workspace);
    if (Buffer.byteLength(text) > 65_536) throw new Error('stdin is limited to 64 KiB per request');
    const managed = this.active.get(id); if (!managed) throw new Error('Process has already exited');
    if (managed.pty) { managed.pty.write(text); if (end) managed.pty.write('\x04'); }
    else await new Promise<void>((resolve, reject) => {
      if (!managed.child?.stdin || managed.child.stdin.destroyed || managed.child.stdin.writableEnded) { reject(new Error('Process stdin is closed')); return; }
      managed.child.stdin.write(text, error => { if (error) reject(error); else { if (end) managed.child!.stdin!.end(); resolve(); } });
    });
    return this.get(id, owner, workspace);
  }
  resize(id: string, owner: string, workspace: string, columns: number, rows: number) {
    const record = this.require(id, owner, workspace);
    if (![columns, rows].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) throw new Error('Terminal dimensions must be between 1 and 1000');
    const managed = this.active.get(id); if (!managed?.pty) throw new Error('No active PTY for this session');
    managed.pty.resize(columns, rows); record.columns = columns; record.rows = rows; this.save(record); return clone(record);
  }
  private async signalTree(managed: Managed, signal: NodeJS.Signals) {
    const pid = managed.record.pid; if (!pid) return;
    if (process.platform === 'win32') {
      if (signal === 'SIGINT') { managed.pty?.write('\x03'); if (!managed.pty) managed.child?.kill(signal); return; }
      await new Promise<void>(resolve => { const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); child.once('close', () => resolve()); child.once('error', () => resolve()); });
      return;
    }
    try { process.kill(-pid, signal); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code === 'EPERM' && (managed.ended || managed.stopping)) {
        // 后代的 SIGKILL、内核退出与 Node close 回调并不同步。只观察原组的退出，不重发到更大范围；活成员持续存在仍保留 EPERM。
        const deadline = Date.now() + 1000;
        for (;;) {
          try {
            const groups = execFileSync('/bin/ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
            if (!groups.trim().split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && !/^[ZX]/.test(state ?? ''); })) return;
          } catch { break; /* 无法检查组状态时保留原始错误，不假定已经停止。 */ }
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      throw error;
    }
    // PTY 前台作业可能自行创建新的进程组；Ctrl-C 必须送到终端前台组。
    if (managed.pty && signal === 'SIGINT') managed.pty.write('\x03');
  }
  async interrupt(id: string, owner: string, workspace: string) {
    this.require(id, owner, workspace);
    const managed = this.active.get(id); if (managed) await this.signalTree(managed, 'SIGINT');
    return this.get(id, owner, workspace);
  }
  async stop(id: string, owner: string, workspace: string, status: SessionStatus = 'cancelled') {
    this.require(id, owner, workspace);
    const pending = this.stops.get(id); if (pending) return pending;
    const managed = this.active.get(id); if (!managed) return this.get(id, owner, workspace);
    const stopping = (async () => {
      managed.stopping ??= status;
      // 交互 shell 的前台任务可能有独立进程组；取消前记录树关系，以便父进程退出后仍能清理。
      const descendants: number[] = [];
      if (process.platform !== 'win32' && managed.record.pid) {
        try {
          const rows = execFileSync('/bin/ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
          const parents = new Set([managed.record.pid]); let changed = true;
          while (changed) { changed = false; for (const [pid, parent] of rows) if (parents.has(parent) && !parents.has(pid)) { parents.add(pid); descendants.push(pid); changed = true; } }
        } catch { managed.record.cleanupWarning = 'Process-group cleanup completed; this environment prevents process-tree inspection, so independently detached descendants cannot be verified.'; }
      }
      const signalDescendants = (signal: NodeJS.Signals) => { for (const pid of [...descendants].reverse()) { try { process.kill(pid, signal); } catch {} } };
      signalDescendants('SIGTERM');
      await this.signalTree(managed, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 250));
      // 即使父进程先退出，也继续强杀原进程组，避免忽略 SIGTERM 的后代泄漏。
      signalDescendants('SIGKILL'); await this.signalTree(managed, 'SIGKILL');
      if (managed.pty) { try { managed.pty.kill('SIGKILL'); } catch {} }
      if (descendants.length) {
        // SIGKILL 发出后等待内核调度完成；僵尸进程已退出，只等待其父进程回收 PID。
        const deadline = Date.now() + 1000;
        for (;;) {
          let alive = false;
          for (const pid of descendants) {
            try { const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim(); if (state && !/^[ZX]/.test(state)) alive = true; }
            catch (error) { if ((error as { status?: number }).status !== 1) throw new Error('Process descendant termination could not be verified'); }
          }
          if (!alive) break;
          if (Date.now() >= deadline) throw new Error('Process descendant is still running after cancellation');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([managed.done, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
      if (!managed.ended) throw new Error('Process did not report exit after cancellation');
      this.save(managed.record);
      return clone(managed.record);
    })();
    this.stops.set(id, stopping);
    try { return await stopping; }
    catch (error) {
      // 主进程退出不代表整棵树已经停止；历史查询也必须能看到后代清理失败。
      managed.record.error = `Process termination could not be verified: ${error instanceof Error ? error.message : String(error)}`;
      if (managed.ended) managed.record.status = 'failed';
      try { this.save(managed.record); } catch { /* 保留最初的终止错误。 */ }
      throw error;
    } finally { this.stops.delete(id); }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.active.values()].map(managed => this.stop(managed.record.id, managed.record.owner, managed.record.workspace, 'interrupted')).concat([...this.stops.values()]));
  }
}
