import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../core/types.js';
import { workspacePath } from '../plugins/workspace-paths.js';
import { builtInDrivers, providerIds, targetAvailability, type AgentDriver, type AgentTarget, type ProviderId } from './agent-drivers.js';
import type { ProcessSessions } from './sessions.js';
import { agentWriteMode, type AgentWriteMode } from './agent-permissions.js';
import { AgentWorkflow, type WorkflowMode } from './agent-workflow.js';

export interface AgentTurn { taskId: string; prompt: string; startedAt: string; endedAt?: string; status: AgentRecord['status']; response?: string; responseTruncated?: boolean; error?: string; processSessionIds: string[]; writeMode?: AgentWriteMode }
export interface AgentRecord {
  id: string; owner: string; workspace: string; cwd: string; target: string; provider: ProviderId;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; providerSessionId?: string; response?: string; error?: string;
  progress?: string; model?: string; effort?: string; turns: AgentTurn[];
  responseTruncated?: boolean;
  writeMode?: AgentWriteMode;
}
interface ActiveAgent { controller: AbortController; promise: Promise<void> }
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const validName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const idPattern = /^[a-f0-9-]{36}$/;
function validatePrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 128_000) throw new Error('Agent prompt must be nonempty and at most 128 KiB');
}
function targetHash(target: AgentTarget): string {
  // 凭据由配置代次固定，角色文件不能修改env；指纹只绑定执行目标与角色行为，不包含凭据。
  const { env: _env, ...publicTarget } = target;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(publicTarget))).digest('hex');
}
function verifyTarget(target: AgentTarget, expected?: string) {
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || targetHash(target) !== expected)) throw new Error('Agent target changed after preview. Prepare a new request so the current provider, role and permissions can be reviewed.');
}
function targetConfig(id: string, input: unknown, fallback?: AgentTarget): AgentTarget {
  if (!validName.test(id) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid agent target: ${id}`);
  const item = input as Record<string, unknown>;
  const provider = item.provider ?? fallback?.provider ?? id;
  if (!providerIds.includes(provider as ProviderId)) throw new Error(`Unknown agent provider: ${String(provider)}`);
  for (const key of ['executable', 'model', 'effort', 'prompt', 'description', 'title', 'module', 'sandboxModule']) if (item[key] !== undefined && (typeof item[key] !== 'string' || String(item[key]).includes('\0'))) throw new Error(`Invalid ${key} for agent ${id}`);
  if (item.writeMode !== undefined) agentWriteMode(item.writeMode);
  for (const key of ['args', 'resumeArgs', 'inheritEnv']) if (item[key] !== undefined && (!Array.isArray(item[key]) || !(item[key] as unknown[]).every(value => typeof value === 'string' && !value.includes('\0')))) throw new Error(`Invalid ${key} for agent ${id}`);
  if (item.env !== undefined && (!item.env || typeof item.env !== 'object' || Array.isArray(item.env) || Object.values(item.env).some(value => typeof value !== 'string' || value.includes('\0')))) throw new Error(`Invalid env for agent ${id}`);
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error(`Invalid enabled for agent ${id}`);
  if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 1000 || Number(item.timeoutMs) > 86_400_000)) throw new Error(`Invalid timeoutMs for agent ${id}`);
  return { ...fallback, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)), id, provider } as AgentTarget;
}
function scalar(value: string): string | boolean {
  if (value === 'true' || value === 'false') return value === 'true';
  if (value.startsWith('"')) { const result = JSON.parse(value); if (typeof result !== 'string') throw new Error('Profile value must be a scalar string'); return result; }
  if (value.startsWith("'")) { if (!value.endsWith("'")) throw new Error('Unterminated profile string'); return value.slice(1, -1).replaceAll("''", "'"); }
  return value.replace(/\s+#.*$/, '').trim();
}
function profile(filename: string): AgentTarget {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) throw new Error('Agent profile must be a regular file smaller than 64 KiB');
  const source = readFileSync(filename, 'utf8'), match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('Agent profile needs YAML frontmatter');
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const field = line.match(/^([a-zA-Z]+):\s*(.*?)\s*$/); if (!field) throw new Error('Agent profile supports flat scalar frontmatter fields');
    if (!['schema', 'name', 'description', 'provider', 'model', 'effort', 'disabled', 'writeMode'].includes(field[1])) throw new Error(`Unsupported profile field: ${field[1]}`);
    if (Object.hasOwn(fields, field[1])) throw new Error(`Duplicate profile field: ${field[1]}`);
    fields[field[1]] = scalar(field[2]);
  }
  if (fields.schema !== undefined && !['capyra-agent/v1', 'devspace-agent/v1'].includes(String(fields.schema))) throw new Error('Unsupported agent profile schema');
  if (fields.disabled !== undefined && typeof fields.disabled !== 'boolean') throw new Error('disabled must be true or false');
  if (typeof fields.description !== 'string' || !fields.description.trim() || typeof fields.provider !== 'string') throw new Error('Agent profile requires description and provider');
  return targetConfig(String(fields.name ?? path.basename(filename, '.md')), { provider: fields.provider, description: fields.description, model: fields.model, effort: fields.effort, writeMode: fields.writeMode, enabled: fields.disabled !== true, prompt: match[2].trim() });
}

/** durable logical sessions; only an explicitly approved run/continue starts provider work. */
export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private active = new Map<string, ActiveAgent>();
  private targetsById = new Map<string, AgentTarget>();
  private closed = false;
  readonly drivers: Map<ProviderId, AgentDriver>;
  readonly directory: string;
  readonly workflow: AgentWorkflow;
  constructor(sessions: ProcessSessions | undefined, readonly stateDir: string, private config: Record<string, unknown> = {}, private options: { readOnly?: boolean } = {}) {
    if (!sessions && !options.readOnly) throw new Error('Agent execution requires a process service');
    this.drivers = sessions && !options.readOnly ? builtInDrivers(sessions, stateDir) : new Map();
    if (config.workflow !== undefined && (!config.workflow || typeof config.workflow !== 'object' || Array.isArray(config.workflow))) throw new Error('agents.workflow must be an object');
    this.workflow = new AgentWorkflow(stateDir, { ...(config.workflow as { enabled?: boolean; instructions?: WorkflowMode } | undefined), readOnly: options.readOnly });
    this.directory = path.join(stateDir, 'agent-sessions');
    if (!options.readOnly) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let savedFiles: string[] = [];
    try { if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Agent state directory cannot be a symbolic link'); savedFiles = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const provider of providerIds) if (provider !== 'command') this.targetsById.set(provider, { id: provider, provider, title: provider, description: `Native ${provider} coding agent`, enabled: true });
    for (const category of ['providers', 'roles']) {
      const raw = config[category];
      if (raw === undefined) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${category} must be an object keyed by target ID`);
      for (const [id, item] of Object.entries(raw)) {
        const provider = (item as AgentTarget)?.provider ?? id;
        this.targetsById.set(id, targetConfig(id, item, this.targetsById.get(provider)));
      }
    }
    for (const file of savedFiles) {
      if (!file.endsWith('.json') || !idPattern.test(file.slice(0, -5))) continue;
      try {
        const filename = path.join(this.directory, file), info = lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) continue;
        const record = JSON.parse(readFileSync(filename, 'utf8')) as AgentRecord;
        if (record.id + '.json' !== file || typeof record.owner !== 'string' || typeof record.workspace !== 'string' || !Array.isArray(record.turns)) continue;
        if (!terminal.has(record.status) && !options.readOnly) {
          record.status = 'interrupted'; record.error = 'Agent execution was interrupted by restart. Continue explicitly to resume its native session; the previous prompt was not replayed.';
          const turn = record.turns.at(-1); if (turn) { turn.status = 'interrupted'; turn.error = record.error; turn.endedAt = new Date().toISOString(); }
          this.save(record);
        }
        this.records.set(record.id, record);
      } catch { /* 单条损坏记录不妨碍其他会话恢复，也不启动任何进程。 */ }
    }
  }
  private save(record: AgentRecord) {
    if (this.options.readOnly) throw new Error('Agent manager is read-only');
    record.updatedAt = new Date().toISOString();
    // 历史按实际 JSON 字节裁剪，避免多字节文字或转义序列超过重启读取上限。
    let encoded = JSON.stringify(record);
    while (Buffer.byteLength(encoded) > 4 * 1024 * 1024 && record.turns.length > 1) { record.turns.shift(); encoded = JSON.stringify(record); }
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Agent state exceeds its persistence budget');
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path.join(this.directory, `${record.id}.json`)); }
    finally { rmSync(temporary, { force: true }); }
  }
  private require(id: string, owner: string, workspace: string) {
    const record = this.records.get(id); if (!record || record.owner !== owner || record.workspace !== workspace) throw new Error('Unknown agent session'); return record;
  }
  get(id: string, owner: string, workspace: string) { return structuredClone(this.require(id, owner, workspace)); }
  list(owner: string, workspace: string) { return [...this.records.values()].filter(record => record.owner === owner && record.workspace === workspace).reverse().map(record => ({ id: record.id, target: record.target, provider: record.provider, status: record.status, writeMode: record.writeMode, updatedAt: record.updatedAt, response: record.response?.slice(0, 4000), error: record.error, turnCount: record.turns.length })); }
  listLocal(workspace?: string) { return [...this.records.values()].filter(record => workspace === undefined || record.workspace === workspace).reverse().map(record => structuredClone(record)); }
  async cancelOwner(owner?: string) {
    if (this.options.readOnly) throw new Error('Agent manager is read-only');
    const selected = [...this.records.values()].filter(record => this.active.has(record.id) && (owner === undefined ? record.owner !== 'local-console' : record.owner === owner));
    return Promise.all(selected.map(record => this.cancel(record.id, record.owner, record.workspace)));
  }
  targets(workspace: string) {
    const result = new Map(this.targetsById), warnings: { file: string; error: string }[] = [];
    const profileDirs = this.config.profileDirs ?? [path.join(homedir(), '.capyra', 'agents'), path.join(workspace, '.capyra', 'agents')];
    if (!Array.isArray(profileDirs) || !profileDirs.every(value => typeof value === 'string')) throw new Error('profileDirs must be a list of local directories');
    for (const directory of profileDirs) {
      let files: string[];
      try { if (lstatSync(directory).isSymbolicLink()) throw new Error('Profile directory cannot be a symbolic link'); files = readdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push({ file: directory, error: String(error) }); continue; }
      for (const file of files.filter(file => file.endsWith('.md')).slice(0, 100)) {
        try { const item = profile(path.join(directory, file)); result.set(item.id, targetConfig(item.id, item, result.get(item.provider))); }
        catch (error) { warnings.push({ file: path.join(directory, file), error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    return { entries: result, warnings };
  }
  catalog(workspace: string) {
    const { entries, warnings } = this.targets(workspace);
    return { targets: [...entries.values()].filter(target => target.enabled !== false).map(target => ({ id: target.id, provider: target.provider, title: target.title ?? target.id, description: target.description, model: target.model, effort: target.effort, writeMode: agentWriteMode(target.writeMode, target.provider === 'command' ? 'full_access' : 'allowed'), supportedWriteModes: target.provider === 'command' ? ['full_access'] : ['read_only', 'allowed', 'full_access'], ...targetAvailability(this.stateDir, target) })), warnings, workflow: this.workflow.context() };
  }
  preview(targetId: string, workspace: string) {
    const target = this.targets(workspace).entries.get(targetId);
    if (!target || target.enabled === false) throw new Error('Unknown or disabled agent target');
    return { target: target.id, targetHash: targetHash(target), provider: target.provider, model: target.model, effort: target.effort, writeMode: agentWriteMode(target.writeMode, target.provider === 'command' ? 'full_access' : 'allowed'), executable: target.executable, args: target.args, instructions: target.prompt,
      availability: targetAvailability(this.stateDir, target), notice: 'Uses the provider’s existing local login and may consume its paid quota. Agent tools run with provider permissions as the local user.' };
  }
  async run(args: { target: string; prompt: string; cwd?: string; model?: string; effort?: string; writeMode?: AgentWriteMode; expectedTargetHash?: string }, ctx: ToolContext) {
    if (this.options.readOnly) throw new Error('Agent manager is read-only');
    if (this.closed) throw new Error('Agent manager has been unloaded');
    ctx.signal.throwIfAborted();
    const target = this.targets(ctx.workspace).entries.get(args.target);
    if (!target || target.enabled === false) throw new Error('Unknown or disabled agent target');
    verifyTarget(target, args.expectedTargetHash);
    const writeMode = agentWriteMode(args.writeMode, agentWriteMode(target.writeMode, target.provider === 'command' ? 'full_access' : 'allowed'));
    if (target.provider === 'command' && writeMode !== 'full_access') throw new Error('Custom command providers support only full_access; restricted modes require a native provider');
    const cwd = await workspacePath(ctx.workspace, args.cwd ?? '.', { allowRoot: true }); ctx.signal.throwIfAborted();
    if (this.active.size >= Number(this.config.maxActive ?? 4)) throw new Error('Too many active agents; wait or cancel one first');
    const record: AgentRecord = { id: randomUUID(), owner: ctx.owner ?? 'local', workspace: ctx.workspace, cwd, target: target.id, provider: target.provider,
      status: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [], model: args.model ?? target.model, effort: args.effort ?? target.effort, writeMode };
    this.records.set(record.id, record);
    try { this.begin(record, args.prompt, target, ctx.taskId); } catch (error) { this.records.delete(record.id); throw error; }
    this.prune();
    return this.get(record.id, record.owner, record.workspace);
  }
  async continue(id: string, args: { prompt: string; model?: string; effort?: string; writeMode?: AgentWriteMode; expectedTargetHash?: string }, ctx: ToolContext) {
    if (this.options.readOnly) throw new Error('Agent manager is read-only');
    ctx.signal.throwIfAborted();
    if (this.closed) throw new Error('Agent manager has been unloaded');
    const record = this.require(id, ctx.owner ?? 'local', ctx.workspace);
    // 会话可能跨多次本机修改继续；原目录若被换成符号链接，不能沿旧路径启动新 turn。
    const workspaceRoot = await workspacePath(ctx.workspace, '.', { allowRoot: true });
    await workspacePath(ctx.workspace, path.relative(workspaceRoot, record.cwd).split(path.sep).join('/'), { allowRoot: true });
    ctx.signal.throwIfAborted(); this.require(id, ctx.owner ?? 'local', ctx.workspace);
    if (this.closed) throw new Error('Agent manager has been unloaded');
    if (this.active.has(id)) throw new Error('This agent already has an active turn');
    if (this.active.size >= Number(this.config.maxActive ?? 4)) throw new Error('Too many active agents; wait or cancel one first');
    const target = this.targets(ctx.workspace).entries.get(record.target);
    if (!target || target.enabled === false || target.provider !== record.provider) throw new Error('The original provider target is unavailable or changed; restore its configuration before continuing');
    verifyTarget(target, args.expectedTargetHash);
    if (!record.providerSessionId && record.turns.length) throw new Error('No native session was created. Start a new agent explicitly.');
    validatePrompt(args.prompt);
    // 新版记录保留此前明确批准的模式；没有权限字段的旧记录不得悄悄获得完整访问。
    const writeMode = agentWriteMode(args.writeMode, agentWriteMode(record.writeMode, record.provider === 'command' ? 'full_access' : 'read_only'));
    if (target.provider === 'command' && writeMode !== 'full_access') throw new Error('Custom command providers support only full_access; restricted modes require a native provider');
    record.writeMode = writeMode;
    record.model = args.model ?? record.model; record.effort = args.effort ?? record.effort;
    this.begin(record, args.prompt, target, ctx.taskId);
    return this.get(id, record.owner, record.workspace);
  }
  private begin(record: AgentRecord, prompt: string, target: AgentTarget, taskId: string) {
    validatePrompt(prompt);
    const driver = this.drivers.get(target.provider); if (!driver) throw new Error('No driver registered for this provider');
    const controller = new AbortController();
    const turn: AgentTurn = { taskId, prompt, startedAt: new Date().toISOString(), status: 'starting', processSessionIds: [], writeMode: record.writeMode };
    record.turns = [...record.turns.slice(-19), turn]; record.status = 'starting'; delete record.error; delete record.progress;
    this.save(record);
    let lastSave = Date.now();
    const execution = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted(); record.status = 'running'; turn.status = 'running'; this.save(record);
        const result = await driver.run({ id: record.id, taskId, owner: record.owner, workspace: record.workspace, cwd: record.cwd,
          prompt: this.workflow.enabled ? this.workflow.taskPrompt({ prompt, roleInstructions: target.prompt,
            target: { id: record.target, provider: record.provider, description: target.description, model: record.model, effort: record.effort, writeMode: record.writeMode }, workspace: record.workspace, cwd: record.cwd }) : [target.prompt, prompt].filter(Boolean).join('\n\n'), providerSessionId: record.providerSessionId,
          target: { ...target, model: record.model, effort: record.effort, writeMode: record.writeMode }, writeMode: record.writeMode, signal: controller.signal,
          onSession: id => { if (!id || Buffer.byteLength(id) > 4096 || /[\x00-\x1f]/.test(id)) throw new Error('Provider returned an invalid session ID'); record.providerSessionId = id; this.save(record); },
          onProcess: id => { turn.processSessionIds.push(id); this.save(record); },
          onText: text => { record.progress = ((record.progress ?? '') + text).slice(-16_000); if (Date.now() - lastSave > 1000) { this.save(record); lastSave = Date.now(); } },
        });
        controller.signal.throwIfAborted(); record.providerSessionId = result.providerSessionId ?? record.providerSessionId;
        const responseBytes = Buffer.from(result.response);
        record.responseTruncated = responseBytes.length > 128_000; turn.responseTruncated = record.responseTruncated;
        record.response = responseBytes.subarray(-128_000).toString('utf8'); turn.response = record.response;
        record.status = 'completed'; turn.status = 'completed';
      } catch (error) {
        record.status = controller.signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : 'failed'; turn.status = record.status;
        record.error = (error instanceof Error ? error.message : String(error)).slice(0, 8000); turn.error = record.error;
      } finally {
        turn.endedAt = new Date().toISOString(); this.active.delete(record.id);
        try { this.save(record); } catch { record.status = 'failed'; record.error = 'Agent state could not be persisted. Inspect the local disk before retrying.'; }
      }
    });
    this.active.set(record.id, { controller, promise: execution });
  }
  private prune() {
    const max = Math.max(10, Math.min(1000, Number(this.config.maxSessions ?? 100)));
    for (const record of [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (this.records.size <= max) break;
      if (this.active.has(record.id)) continue;
      rmSync(path.join(this.directory, `${record.id}.json`), { force: true }); this.records.delete(record.id);
    }
  }
  async wait(ids: string[], owner: string, workspace: string, waitMs = 12_000, signal?: AbortSignal) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12_000) throw new Error('waitMs must be between 0 and 12000');
    const unique = [...new Set(ids)]; if (!unique.length || unique.length > 20) throw new Error('Wait accepts between 1 and 20 agent IDs');
    for (const id of unique) this.require(id, owner, workspace);
    const deadline = Date.now() + waitMs;
    while (unique.some(id => this.active.has(id)) && Date.now() < deadline) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 50)); }
    signal?.throwIfAborted();
    return unique.map(id => this.get(id, owner, workspace));
  }
  async cancel(id: string, owner: string, workspace: string) {
    if (this.options.readOnly) throw new Error('Agent manager is read-only');
    this.require(id, owner, workspace); const active = this.active.get(id);
    if (active) { active.controller.abort(); await active.promise; }
    return this.get(id, owner, workspace);
  }
  async close() { this.closed = true; const active = [...this.active.values()]; for (const item of active) item.controller.abort(); await Promise.all(active.map(item => item.promise)); }
  status() { return { active: this.active.size, sessions: this.records.size, processModel: 'on-demand', recovery: 'Explicit continue resumes native sessions. Restarted in-flight turns are never replayed.' }; }
}
