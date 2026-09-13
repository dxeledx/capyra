import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { OutputEntry, ProcessSessions } from './sessions.js';
import { executionEnvironment } from './sessions.js';
import { agentWriteMode, acpArguments, acpPermission, claudeAuthority, codexSandbox, opencodePermissions, type AgentWriteMode } from './agent-permissions.js';
import { restrictedPiTools } from './pi-permissions.js';
import { resolveExtension } from './extension-resolver.js';

export const providerIds = ['codex', 'claude', 'opencode', 'pi', 'cursor', 'copilot', 'grok', 'command'] as const;
export type ProviderId = typeof providerIds[number];
export interface AgentTarget {
  id: string; provider: ProviderId; title?: string; executable?: string; args?: string[]; resumeArgs?: string[];
  model?: string; effort?: string; prompt?: string; description?: string; enabled?: boolean;
  env?: Record<string, string>; inheritEnv?: string[]; module?: string; timeoutMs?: number;
  writeMode?: AgentWriteMode; sandboxModule?: string;
}
export interface AgentRunInput {
  id: string; taskId: string; owner: string; workspace: string; cwd: string; prompt: string;
  target: AgentTarget; providerSessionId?: string; signal: AbortSignal;
  writeMode?: AgentWriteMode;
  onSession(id: string): void; onProcess(id: string): void; onText(text: string): void;
}
export interface AgentDriver { run(input: AgentRunInput): Promise<{ providerSessionId?: string; response: string }> }
interface RpcMessage { jsonrpc?: string; id?: string | number; method?: string; params?: any; result?: any; error?: { message?: string } }
const packages: Partial<Record<ProviderId, string>> = { claude: '@anthropic-ai/claude-agent-sdk', opencode: '@opencode-ai/sdk/v2', pi: '@earendil-works/pi-coding-agent' };
const executables: Partial<Record<ProviderId, string>> = { codex: 'codex', cursor: 'cursor-agent', copilot: 'copilot', grok: 'grok', opencode: 'opencode' };

function modulePath(stateDir: string, target: AgentTarget) {
  const request = target.module ?? packages[target.provider];
  if (!request) throw new Error(`No SDK for ${target.provider}`);
  try { return resolveExtension(stateDir, target.provider, request); }
  catch { throw new Error(`${target.provider} needs ${request} installed in ${path.join(stateDir, 'extensions', target.provider)}. Install this optional capability from local settings.`); }
}
function executableExists(executable?: string) {
  if (!executable) return false;
  const candidates = executable.includes('/') || executable.includes('\\') ? [executable] : (process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
    (process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : ['']).map(extension => path.join(directory, executable + extension)));
  return candidates.some(filename => { try { accessSync(filename, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } });
}
export function targetAvailability(stateDir: string, target: AgentTarget) {
  try {
    const sdk = packages[target.provider] ? modulePath(stateDir, target) : undefined;
    if (target.provider === 'pi' && agentWriteMode(target.writeMode) !== 'full_access') resolveExtension(stateDir, 'pi', target.sandboxModule ?? '@anthropic-ai/sandbox-runtime');
    const command = target.executable ?? executables[target.provider];
    if (command && !executableExists(command)) return { available: false, reason: `Executable ${command} was not found on PATH.` };
    if (target.provider === 'command' && !target.executable) return { available: false, reason: 'Configure an executable and argument template.' };
    return { available: true, integration: sdk ? 'sdk' : target.provider === 'command' ? 'command' : target.provider === 'codex' ? 'app-server' : 'acp' };
  } catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/** NDJSON RPC：仅提供者协议连接使用，不向调用方暴露凭据、宿主文件或审批控制。 */
class AgentRpc {
  private pending = new Map<string | number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private buffer = '';
  private sessionId?: string;
  private failure?: Error;
  onNotification: (message: RpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  onRequest: (message: RpcMessage) => Promise<unknown> = async () => { throw new Error('Unsupported provider request'); };
  constructor(private sessions: ProcessSessions, private input: AgentRunInput) {}
  async start(command: string, args: string[]) {
    const record = await this.sessions.start({ owner: this.input.owner, workspace: this.input.workspace, taskId: this.input.taskId,
      command, args, cwd: this.input.cwd, kind: 'agent', signal: this.input.signal,
      env: executionEnvironment({ login: true, inherit: this.input.target.inheritEnv, env: this.input.target.env }),
      onOutput: entry => this.receive(entry), onExit: () => this.fail(new Error('Agent provider process disconnected')) });
    this.sessionId = record.id; this.input.onProcess(record.id);
  }
  private receive(entry: OutputEntry) {
    if (entry.stream !== 'stdout' || this.failure) return;
    this.buffer += entry.text;
    if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) { this.fail(new Error('Provider protocol message exceeded 2 MiB')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.fail(new Error('Provider emitted invalid JSON protocol output')); return; }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message).then(result => this.send({ jsonrpc: '2.0', id: message.id, result }), error => this.send({ jsonrpc: '2.0', id: message.id, error: { message: error instanceof Error ? error.message : String(error), code: -32601 } } as RpcMessage)).catch(error => this.fail(error));
      } else if (message.method) { try { this.onNotification(message); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); } }
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'Provider rejected request')); else pending.resolve(message.result);
      }
    }
  }
  async send(message: RpcMessage) {
    if (this.failure) throw this.failure;
    if (!this.sessionId) throw new Error('Provider process has not started');
    await this.sessions.write(this.sessionId, this.input.owner, this.input.workspace, JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Provider ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  fail(error: Error) { if (!this.failure) this.onFailure(error); this.failure ??= error; for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); }
  async close() { this.fail(new Error('Provider connection closed')); if (this.sessionId) await this.sessions.stop(this.sessionId, this.input.owner, this.input.workspace); }
}

function ensureResponse(response: string) { if (!response.trim()) throw new Error('Provider completed without an assistant response'); return response.trim(); }
function timeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Agent cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Agent turn timed out')); }, ms);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function runCodex(sessions: ProcessSessions, input: AgentRunInput) {
  const authority = codexSandbox(agentWriteMode(input.writeMode), input.cwd);
  const rpc = new AgentRpc(sessions, input); let response = '';
  let resolveTurn!: () => void, rejectTurn!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  completed.catch(() => {});
  rpc.onFailure = rejectTurn;
  rpc.onRequest = async message => {
    // Capyra 批准具体派发后仍不能让提供者自行升级其 sandbox。
    if (message.method?.includes('requestApproval')) return { decision: 'decline' };
    throw new Error('Provider request requires unsupported interactive input');
  };
  rpc.onNotification = message => {
    const params = message.params ?? {};
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') { response += params.delta; input.onText(params.delta); }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') response = params.item.text ?? response;
    if (message.method === 'turn/completed') {
      if (params.turn?.status === 'failed' || params.turn?.status === 'interrupted') { rejectTurn(new Error(params.turn?.error?.message ?? `Codex turn ${params.turn.status}`)); return; }
      for (const item of params.turn?.items ?? []) if (item.type === 'agentMessage') response = item.text ?? response;
      resolveTurn();
    }
    if (message.method === 'error' && params.willRetry === false) rejectTurn(new Error(params.error?.message ?? 'Codex turn failed'));
  };
  const abort = () => { rpc.fail(new Error('Agent cancelled')); rejectTurn(new Error('Agent cancelled')); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await rpc.start(input.target.executable ?? 'codex', input.target.args ?? ['app-server']);
    await rpc.request('initialize', { clientInfo: { name: 'capyra', title: 'Capyra', version: '0.2.0' }, capabilities: {} });
    await rpc.send({ jsonrpc: '2.0', method: 'initialized' });
    const opened = await rpc.request(input.providerSessionId ? 'thread/resume' : 'thread/start', {
      ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}), cwd: input.cwd,
      approvalPolicy: 'never', sandbox: authority.sandbox, ...(input.target.model ? { model: input.target.model } : {}) });
    const providerSessionId = opened?.thread?.id;
    if (typeof providerSessionId !== 'string') throw new Error('Codex did not return a thread ID');
    input.onSession(providerSessionId);
    await rpc.request('turn/start', { threadId: providerSessionId, input: [{ type: 'text', text: input.prompt }], approvalPolicy: 'never', sandboxPolicy: authority.sandboxPolicy, ...(input.target.model ? { model: input.target.model } : {}), ...(input.target.effort ? { effort: input.target.effort } : {}) });
    await timeout(completed, input.target.timeoutMs ?? 30 * 60_000, input.signal);
    return { providerSessionId, response: ensureResponse(response) };
  } finally { input.signal.removeEventListener('abort', abort); await rpc.close(); }
}

async function runAcp(sessions: ProcessSessions, input: AgentRunInput) {
  const rpc = new AgentRpc(sessions, input); let response = '';
  const mode = agentWriteMode(input.writeMode);
  const promptId = randomUUID(); let nativeSessionId: string | undefined, promptActive = false;
  let completeGrok!: () => void, failGrok!: (error: Error) => void;
  const grokCompletion = new Promise<void>((resolve, reject) => { completeGrok = resolve; failGrok = reject; });
  grokCompletion.catch(() => {}); rpc.onFailure = failGrok;
  rpc.onRequest = async message => {
    if (message.method !== 'session/request_permission') throw new Error('Client-side file and terminal operations are not advertised');
    const options = message.params?.options ?? [];
    return acpPermission(input.target.provider, mode, options);
  };
  rpc.onNotification = message => {
    const update = message.params?.update;
    if (message.method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') { response += update.content.text; input.onText(update.content.text); }
    if (input.target.provider === 'grok' && promptActive && message.params?.sessionId === nativeSessionId &&
      ['x.ai/session/prompt_complete', '_x.ai/session/prompt_complete', 'x.ai/session/update', '_x.ai/session/update'].includes(message.method ?? '')) {
      if (update && update.sessionUpdate !== 'turn_completed') return;
      const receivedId = message.params?.promptId ?? message.params?.requestId ?? update?.promptId ?? update?.requestId ?? message.params?._meta?.promptId ?? update?._meta?.promptId;
      // 后台子代理完成通知不能提前结束当前用户派发的 turn。
      if (receivedId !== undefined && receivedId !== promptId) return;
      completeGrok();
    }
  };
  const args = [...(input.target.args ?? []), ...acpArguments(input.target.provider, mode, input.cwd, input.target.effort)];
  const abort = () => rpc.fail(new Error('Agent cancelled'));
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await rpc.start(input.target.executable ?? executables[input.target.provider]!, args);
    const initialized = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'Capyra', version: '0.2.0' }, clientCapabilities: {} });
    const caps = initialized?.agentCapabilities;
    let opened: any;
    if (input.providerSessionId) {
      if (caps?.sessionCapabilities?.resume) opened = await rpc.request('session/resume', { sessionId: input.providerSessionId, cwd: input.cwd, mcpServers: [] });
      else if (caps?.loadSession) opened = await rpc.request('session/load', { sessionId: input.providerSessionId, cwd: input.cwd, mcpServers: [] });
      else throw new Error('This provider does not advertise durable session resume; start a new agent explicitly.');
    } else opened = await rpc.request('session/new', { cwd: input.cwd, mcpServers: [] });
    const providerSessionId = input.providerSessionId ?? opened?.sessionId;
    if (typeof providerSessionId !== 'string') throw new Error('ACP provider did not return a session ID');
    nativeSessionId = providerSessionId;
    input.onSession(providerSessionId);
    for (const [category, value] of [['model', input.target.model], ['thought_level', input.target.effort]] as const) {
      if (!value || (category === 'thought_level' && input.target.provider === 'grok')) continue;
      const option = opened?.configOptions?.find((item: any) => item.category === category && item.type === 'select');
      if (!option) {
        if (input.target.provider === 'grok' && category === 'model') { await rpc.request('session/set_model', { sessionId: providerSessionId, modelId: value }); continue; }
        throw new Error(`Provider does not advertise a configurable ${category}; remove the override or update the provider.`);
      }
      const values = (option.options ?? []).flatMap((item: any) => item.options ?? [item]);
      if (!values.some((item: any) => item.value === value)) throw new Error(`Provider does not support requested ${category}: ${value}`);
      await rpc.request('session/set_config_option', { sessionId: providerSessionId, configId: option.id, value });
    }
    response = '';
    promptActive = true;
    const responsePromise = rpc.request('session/prompt', { sessionId: providerSessionId, prompt: [{ type: 'text', text: input.prompt }], ...(input.target.provider === 'grok' ? { _meta: { promptId, requestId: promptId } } : {}) }, input.target.timeoutMs ?? 30 * 60_000);
    await (input.target.provider === 'grok' ? timeout(Promise.race([responsePromise, grokCompletion]), input.target.timeoutMs ?? 30 * 60_000, input.signal) : responsePromise);
    return { providerSessionId, response: ensureResponse(response) };
  } finally { input.signal.removeEventListener('abort', abort); await rpc.close(); }
}

async function runCommand(sessions: ProcessSessions, input: AgentRunInput) {
  if (agentWriteMode(input.writeMode, 'full_access') !== 'full_access') throw new Error('Custom command providers support only full_access; use a native provider for enforced restricted modes');
  const template = input.providerSessionId ? input.target.resumeArgs : input.target.args;
  if (!input.target.executable || !template) throw new Error(input.providerSessionId ? 'Configure resumeArgs to continue this command provider' : 'Configure executable and args for this command provider');
  const replacements: Record<string, string> = { prompt: input.prompt, sessionId: input.providerSessionId ?? input.id, workspace: input.cwd, model: input.target.model ?? '', effort: input.target.effort ?? '' };
  // 模板替换只产生独立 argv 项，不经过 shell 解释用户提示词。
  const args = template.map(arg => arg.replace(/\{(prompt|sessionId|workspace|model|effort)\}/g, (_match, key: string) => replacements[key]));
  let response = '';
  const record = await sessions.start({ command: input.target.executable, args, cwd: input.cwd, workspace: input.workspace, owner: input.owner, taskId: input.taskId, kind: 'agent', signal: input.signal, timeoutMs: input.target.timeoutMs ?? 30 * 60_000,
    env: executionEnvironment({ login: true, inherit: input.target.inheritEnv, env: input.target.env }),
    onOutput(entry) { if (entry.stream === 'stdout') { response = (response + entry.text).slice(-256_000); input.onText(entry.text); } } });
  input.onProcess(record.id); input.onSession(input.providerSessionId ?? input.id);
  const result = await sessions.wait(record.id, input.owner, input.workspace, input.signal);
  if (result.status !== 'completed') throw new Error(`Agent command ${result.status} (exit ${result.exitCode ?? 'unknown'})`);
  return { providerSessionId: input.providerSessionId ?? input.id, response: ensureResponse(response) };
}

async function runClaude(stateDir: string, input: AgentRunInput) {
  const sdk = await import(pathToFileURL(modulePath(stateDir, input.target)).href);
  const query = sdk.query({ prompt: input.prompt, options: { cwd: input.cwd, ...claudeAuthority(agentWriteMode(input.writeMode), input.cwd),
    env: executionEnvironment({ login: true, inherit: input.target.inheritEnv, env: input.target.env }),
    ...(input.target.executable ? { pathToClaudeCodeExecutable: input.target.executable } : {}),
    ...(input.providerSessionId ? { resume: input.providerSessionId } : {}), ...(input.target.model ? { model: input.target.model } : {}),
    ...(input.target.effort ? { effort: input.target.effort, thinking: { type: 'adaptive' } } : {}) } });
  let providerSessionId = input.providerSessionId, response = '';
  const abort = () => query.close(); input.signal.addEventListener('abort', abort, { once: true });
  try {
    await timeout((async () => {
      for await (const message of query) {
        input.signal.throwIfAborted();
        if (typeof message.session_id === 'string') { providerSessionId = message.session_id; input.onSession(providerSessionId!); }
        if (message.type === 'assistant') for (const part of message.message?.content ?? []) if (part.type === 'text') { response += part.text; input.onText(part.text); }
        if (message.type === 'result') { if (message.is_error || message.subtype !== 'success') throw new Error('Claude agent turn failed'); response = message.result ?? response; }
      }
    })(), input.target.timeoutMs ?? 30 * 60_000, input.signal);
    return { providerSessionId, response: ensureResponse(response) };
  } finally { input.signal.removeEventListener('abort', abort); query.close(); }
}

async function runPi(sessions: ProcessSessions, stateDir: string, input: AgentRunInput) {
  const sdk = await import(pathToFileURL(modulePath(stateDir, input.target)).href);
  const mode = agentWriteMode(input.writeMode);
  let permissions: { tools: any[] | undefined; release(): Promise<void> } = { tools: undefined, release: async () => {} };
  if (mode !== 'full_access') {
    const sandboxPath = resolveExtension(stateDir, 'pi', input.target.sandboxModule ?? '@anthropic-ai/sandbox-runtime');
    const sandbox = await import(pathToFileURL(sandboxPath).href);
    permissions = await restrictedPiTools(sdk, sandbox, sessions, input);
  }
  let session: any, unsubscribe: (() => void) | undefined, abort: (() => void) | undefined;
  try {
  const agentDir = sdk.getAgentDir(), authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
  const modelRegistry = sdk.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
  if (typeof modelRegistry.getApiKeyAndHeaders === 'function') {
    const original = modelRegistry.getApiKeyAndHeaders.bind(modelRegistry);
    const providerEnv = executionEnvironment({ login: true, inherit: input.target.inheritEnv, env: input.target.env });
    modelRegistry.getApiKeyAndHeaders = async (model: unknown) => { const auth = await original(model); return auth.ok ? { ...auth, env: { ...auth.env, ...providerEnv } } : auth; };
  }
  let sessionManager;
  if (input.providerSessionId) {
    const match = (await sdk.SessionManager.list(input.cwd)).find((item: any) => item.id === input.providerSessionId);
    if (!match) throw new Error('Native Pi session no longer exists; start a new agent explicitly');
    sessionManager = sdk.SessionManager.open(match.path);
  } else sessionManager = sdk.SessionManager.create(input.cwd);
  let model;
  if (input.target.model) {
    const slash = input.target.model.indexOf('/');
    model = slash < 0 ? modelRegistry.getAll().find((item: any) => item.id === input.target.model) : modelRegistry.find(input.target.model.slice(0, slash), input.target.model.slice(slash + 1));
    if (!model) throw new Error('Requested model was not found in the Pi registry');
  }
  ({ session } = await sdk.createAgentSession({ cwd: input.cwd, agentDir, authStorage, modelRegistry, sessionManager,
    tools: permissions.tools?.map(tool => tool.name) ?? ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
    ...(permissions.tools ? { customTools: permissions.tools } : {}),
    ...(model ? { model } : {}), ...(input.target.effort ? { thinkingLevel: input.target.effort } : {}) }));
  if (mode !== 'full_access') {
    if (typeof session.setActiveToolsByName !== 'function') throw new Error('Pi SDK cannot enforce the selected tool set');
    session.setActiveToolsByName(permissions.tools!.map(tool => tool.name));
  }
  input.onSession(session.sessionId);
  const before = session.messages.length;
  unsubscribe = session.subscribe((event: any) => { if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') input.onText(event.assistantMessageEvent.delta); });
  abort = () => { void session.abort?.(); }; input.signal.addEventListener('abort', abort, { once: true });
    await timeout(session.prompt(input.prompt), input.target.timeoutMs ?? 30 * 60_000, input.signal);
    const messages = session.messages.slice(before).filter((message: any) => message.role === 'assistant');
    const response = (messages.at(-1)?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    return { providerSessionId: session.sessionId as string, response: ensureResponse(response) };
  } finally {
    if (abort) input.signal.removeEventListener('abort', abort);
    try { await session?.abort?.(); }
    finally { try { unsubscribe?.(); } finally { try { session?.dispose(); } finally { await permissions.release(); } } }
  }
}

async function runOpencode(sessions: ProcessSessions, stateDir: string, input: AgentRunInput) {
  const sdk = await import(pathToFileURL(modulePath(stateDir, input.target)).href);
  const mode = agentWriteMode(input.writeMode), agent = `capyra_${mode}`;
  let address = '', resolveAddress!: (address: string) => void, rejectAddress!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveAddress = resolve; rejectAddress = reject; }); ready.catch(() => {});
  const record = await sessions.start({ command: input.target.executable ?? 'opencode', args: input.target.args ?? ['serve', '--hostname=127.0.0.1', '--port=0'], kind: 'agent', cwd: input.cwd, owner: input.owner, workspace: input.workspace, taskId: input.taskId, signal: input.signal,
    env: { ...executionEnvironment({ login: true, inherit: input.target.inheritEnv, env: input.target.env }), OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { [agent]: { mode: 'primary', permission: opencodePermissions(mode) } } }) },
    onOutput(entry) { if (entry.stream === 'stdout') { address = (address + entry.text).slice(-8192); const match = address.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolveAddress(match[1]); } }, onExit() { rejectAddress(new Error('OpenCode server exited before becoming ready')); } });
  input.onProcess(record.id);
  const abort = () => { void sessions.stop(record.id, input.owner, input.workspace).catch(() => {}); }; input.signal.addEventListener('abort', abort, { once: true });
  let client: any, providerSessionId = input.providerSessionId;
  try {
    const baseUrl = await timeout(ready, 15000, input.signal);
    client = sdk.createOpencodeClient({ baseUrl });
    if (!providerSessionId) {
      const created = await client.session.create({ directory: input.cwd }, { throwOnError: true, signal: input.signal });
      providerSessionId = created.data?.id;
      if (!providerSessionId) throw new Error('OpenCode did not return a session ID');
    }
    input.onSession(providerSessionId!);
    const slash = input.target.model?.indexOf('/') ?? -1;
    const model = input.target.model ? { providerID: slash < 0 ? 'opencode' : input.target.model.slice(0, slash), modelID: slash < 0 ? input.target.model : input.target.model.slice(slash + 1) } : undefined;
    const result = await timeout(client.session.prompt({ sessionID: providerSessionId, directory: input.cwd, agent, parts: [{ type: 'text', text: input.prompt }], ...(model ? { model } : {}), ...(input.target.effort ? { variant: input.target.effort } : {}) }, { throwOnError: true, signal: input.signal }), input.target.timeoutMs ?? 30 * 60_000, input.signal) as any;
    const data = result.data ?? result;
    if (data.info?.error) throw new Error('OpenCode agent turn failed');
    const response = (data.parts ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    input.onText(response);
    return { providerSessionId, response: ensureResponse(response) };
  } finally { input.signal.removeEventListener('abort', abort); if (input.signal.aborted && client && providerSessionId) await client.session.abort({ sessionID: providerSessionId, directory: input.cwd }).catch(() => {}); await sessions.stop(record.id, input.owner, input.workspace); }
}

export function builtInDrivers(sessions: ProcessSessions, stateDir: string): Map<ProviderId, AgentDriver> {
  return new Map(providerIds.map(provider => [provider, { run: (input: AgentRunInput) => provider === 'codex' ? runCodex(sessions, input)
    : provider === 'claude' ? runClaude(stateDir, input) : provider === 'opencode' ? runOpencode(sessions, stateDir, input)
      : provider === 'pi' ? runPi(sessions, stateDir, input) : provider === 'command' ? runCommand(sessions, input) : runAcp(sessions, input) }]));
}
