import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, SUPPORTED_PROTOCOL_VERSIONS, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredTool, RuntimeConfig, RuntimeEvent, TaskRecord } from '../core/types.js';
import { createOAuth, type OAuthController } from './oauth.js';
import { publicBaseUrl, publicEndpoint } from '../connection/urls.js';
import { createAccessController, DEFAULT_APPROVAL_TIMEOUT_MS, type AccessController } from './access.js';

export interface McpRuntime {
  config: RuntimeConfig;
  listTools(): RegisteredTool[];
  instructions(): string;
  submit(name: string, args: Record<string, unknown>, owner: string, workspace?: string, clientSession?: string): Promise<TaskRecord>;
  getTask(id: string, owner?: string): TaskRecord | undefined;
  listTasks(owner?: string): TaskRecord[];
  cancelTask(id: string, owner?: string): Promise<unknown>;
  cancelOwner?(owner: string): Promise<unknown>;
  isPaused?: boolean | (() => boolean);
  currentWorkspace?(): string;
  waitTask?(id: string, timeoutMs: number): Promise<unknown>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  service?<T>(name: string): T;
  hasService?(name: string): boolean;
}
export interface McpEvidence {
  type: 'authorization' | 'tool-call'; at: string; owner?: string; clientId?: string; clientName?: string; method?: string; tool?: string;
}
export type TemplateDiagnosticReason = 'request_received' | 'oauth_authorized' | 'unauthorized' | 'forbidden' | 'identity_authorized' | 'identity_rejected' | 'paused' | 'request_cancelled' | 'protocol_accepted' | 'protocol_rejected' | 'invalid_metadata' | 'unsupported_version' | 'header_mismatch' | 'unacceptable_response_type' | 'template_unavailable' | 'template_returned' | 'handler_rejected' | 'response_finished' | 'connection_closed';
export interface McpTemplateDiagnostic {
  requestId: string;
  stage: 'received' | 'auth' | 'protocol' | 'returned' | 'closed';
  reason: TemplateDiagnosticReason;
  httpStatus?: number;
  templateBytes: number;
  templateSha256: string;
}
export type McpRequestDiagnosticReason = TemplateDiagnosticReason | 'invalid_json' | 'body_too_large' | 'host_rejected' | 'origin_rejected' | 'invalid_session_id' | 'session_unavailable' | 'initialize_required' | 'session_limit' | 'session_setup_failed' | 'modern_dispatch' | 'legacy_stateless_dispatch' | 'legacy_session_dispatch';
export interface McpRequestDiagnostic {
  requestId: string;
  operation: 'initialize' | 'tools_list' | 'tools_call' | 'resources_read' | 'other';
  stage: McpTemplateDiagnostic['stage'];
  reason: McpRequestDiagnosticReason;
  httpStatus?: number;
}
export interface McpOptions { approvalTimeoutMs?: number; onEvidence?(event: McpEvidence): void; onTemplateDiagnostic?(event: McpTemplateDiagnostic): void; onRequestDiagnostic?(event: McpRequestDiagnostic): void }
/** 安装时确定的公开 UI 外壳；不得包含工作区数据或按请求生成的内容。 */
export interface McpPublicUiTemplate {
  readonly uri: string;
  readonly mimeType: 'text/html;profile=mcp-app';
  readonly text: string;
  readonly _meta?: Record<string, unknown>;
}
export interface McpExtensions {
  capabilities: { resources?: Record<string, unknown>; prompts?: Record<string, unknown> };
  readonly publicUiTemplates?: ReadonlyMap<string, McpPublicUiTemplate>;
  handle(method: string, params: Record<string, unknown>, context: { owner: string; signal: AbortSignal }): Promise<Record<string, unknown>>;
}
interface TemplateTrace {
  emit(stage: McpTemplateDiagnostic['stage'], reason: TemplateDiagnosticReason, httpStatus?: number): void;
  readonly stages: Set<McpTemplateDiagnostic['stage']>;
}
const httpScope = new AsyncLocalStorage<{ signal: AbortSignal; cancel(): void; templateTrace?: TemplateTrace }>();
const publicInstructions = 'Capyra connects each conversation to a local workspace. Changing the local console workspace affects new conversations only; use capyra_workspace to change this conversation without reconnecting. Data access and actions follow the approval settings chosen in the local console: ask mode waits for an individual local decision, and auto mode approves new requests automatically. OAuth, owner isolation, scope and pause still apply. Results marked local stay on the computer, including earlier local-only task results. A task status is not an execution result.';
const info = { name: 'capyra', version: '0.2.0' };
const modernVersion = '2026-07-28';
const versions = [modernVersion, ...SUPPORTED_PROTOCOL_VERSIONS];
const taskTool = {
  name: 'capyra_tasks', title: 'Capyra tasks', description: 'List tasks or inspect a result according to local approval settings. Local-only task content is never returned, including in auto mode.',
  inputSchema: { type: 'object' as const, properties: { action: { type: 'string', enum: ['list', 'get'] }, id: { type: 'string', minLength: 1 } }, required: ['action'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const cancelTool = {
  name: 'capyra_cancel', title: 'Cancel a Capyra task', description: 'Cancel a task according to the approval settings chosen in the local console.',
  inputSchema: { type: 'object' as const, properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const workspaceTool = {
  name: 'capyra_workspace', title: 'Choose a Capyra workspace',
  description: 'Inspect registered local workspaces or select one for this conversation. Use action=list before select when needed. Local-console changes do not move existing conversations. The MCP address and OAuth connection stay unchanged; existing tasks retain their original workspace.',
  inputSchema: { type: 'object' as const, properties: {
    action: { type: 'string', enum: ['current', 'list', 'select'] },
    id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
  }, required: ['action'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
function exposeTool(tool: RegisteredTool) {
  return {
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { destructiveHint: tool.effect !== 'read', openWorldHint: tool.effect === 'execute', ...tool.annotations, readOnlyHint: tool.effect === 'read' },
    ...(tool.icons ? { icons: tool.icons } : {}),
    _meta: { ...tool._meta, 'capyra/plugin': tool.pluginId, 'capyra/effect': tool.effect, 'capyra/permissions': tool.permissions, 'capyra/approval': tool.alwaysConfirm ? 'always' : 'configured' },
  };
}
function jsonResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}
function safeTask(task: TaskRecord): CallToolResult { return jsonResult({ taskId: task.id, status: task.status }); }
function taskResult(task: TaskRecord): CallToolResult {
  // 未显式选定发给客户端的任务，包括旧版本记录，默认只在本机可见。
  if (task.resultVisibility === 'client' && ['succeeded', 'failed'].includes(task.status) && task.result) {
    return { ...task.result, ...(task.status === 'failed' ? { isError: true } : {}), _meta: { ...task.result._meta, 'capyra/taskId': task.id, 'capyra/status': task.status } };
  }
  return safeTask(task);
}
const paused = (runtime: McpRuntime) => typeof runtime.isPaused === 'function' ? runtime.isPaused() : Boolean(runtime.isPaused);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
interface McpProject { id: string; name: string; path: string }
interface McpProjectsService {
  list(): McpProject[];
  current(): McpProject;
  resolve(id?: string): McpProject;
  session(id: string): Promise<McpProject>;
  conversation?(key: string): McpProject | undefined;
  bindConversation?(key: string, id?: string): Promise<McpProject>;
}
interface WorkspaceBinding {
  projectId?: string;
  scope: 'conversation' | 'mcp_session' | 'request';
  scopeId?: string;
  persist?(id: string): Promise<void>;
}
const projectService = (runtime: McpRuntime) => runtime.hasService?.('projects') ? runtime.service!<McpProjectsService>('projects') : undefined;
function conversationWorkspaceKey(owner: string, params: Record<string, unknown>): string | undefined {
  const meta = object(params._meta) ? params._meta : undefined;
  const session = meta?.['openai/session'];
  if (typeof session !== 'string' || !session || Buffer.byteLength(session) > 1024) return undefined;
  // openai/session 只用于区分对话工作区，不作为调用者身份或授权凭据保存。
  return createHash('sha256').update(owner).update('\0').update(session).digest('hex');
}
async function requestWorkspaceBinding(runtime: McpRuntime, owner: string, params: Record<string, unknown>): Promise<WorkspaceBinding | undefined> {
  const key = conversationWorkspaceKey(owner, params);
  const service = projectService(runtime);
  if (!key || !service?.conversation || !service.bindConversation) return undefined;
  const selected = service.conversation(key) ?? await service.bindConversation(key);
  return {
    projectId: selected.id,
    scope: 'conversation',
    scopeId: key,
    async persist(id) { await service.bindConversation!(key, id); },
  };
}
function extensions(runtime: McpRuntime): McpExtensions | undefined {
  return runtime.hasService?.('mcp.extensions') ? runtime.service?.<McpExtensions>('mcp.extensions') : undefined;
}
function templateTrace(runtime: McpRuntime, options: McpOptions, method: string, params: Record<string, unknown>): TemplateTrace | undefined {
  if (!options.onTemplateDiagnostic || method !== 'resources/read' || typeof params.uri !== 'string') return undefined;
  let template: McpPublicUiTemplate | undefined;
  try { template = extensions(runtime)?.publicUiTemplates?.get(params.uri); } catch { return undefined; }
  if (!template) return undefined;
  // 不记录 URI、调用者或异常；只对已注册静态产品字节生成诊断指纹。
  const base = { requestId: randomUUID(), templateBytes: Buffer.byteLength(template.text), templateSha256: createHash('sha256').update(template.text).digest('hex') };
  const stages = new Set<McpTemplateDiagnostic['stage']>();
  const trace: TemplateTrace = { stages, emit(stage, reason, httpStatus) {
    if (stages.has('closed')) return;
    stages.add(stage);
    try { options.onTemplateDiagnostic!({ ...base, stage, reason, ...(httpStatus === undefined ? {} : { httpStatus }) }); } catch { /* 诊断输出失败不改变授权或响应。 */ }
  } };
  trace.emit('received', 'request_received');
  return trace;
}
function isNativeClientTool(tool: RegisteredTool): boolean {
  const fileParams = tool._meta?.['openai/fileParams'];
  return tool.clientCatalog === true
    || object(tool._meta?.ui) && typeof tool._meta.ui.resourceUri === 'string'
    || Array.isArray(fileParams) && fileParams.length > 0 && object(tool.inputSchema.properties)
      && fileParams.every(name => typeof name === 'string' && Object.hasOwn(tool.inputSchema.properties!, name));
}
function dispatcher(runtime: McpRuntime, owner: string, access: AccessController, options: McpOptions, binding?: WorkspaceBinding) {
  let sessionProjectId = binding?.projectId;
  const sessionScopeId = binding?.scopeId ?? randomUUID();
  const projects = () => projectService(runtime);
  if (!sessionProjectId) {
    try { sessionProjectId = projects()?.current().id; } catch { /* 没有项目服务时沿用运行时默认工作区。 */ }
  }
  const currentProject = () => {
    const service = projects();
    if (!service) return { id: 'primary', name: '当前工作区', path: runtime.currentWorkspace?.() ?? runtime.config.workspace };
    if (sessionProjectId) {
      try { return service.resolve(sessionProjectId); }
      catch { sessionProjectId = undefined; }
    }
    const selected = service.current();
    sessionProjectId = selected.id;
    if (binding) binding.projectId = selected.id;
    return selected;
  };
  // 会话创建时冻结工作区；本机切换只改变以后建立的对话，不改动已有对话。
  const workspace = () => currentProject().path;
  const fresh = async (signal: AbortSignal, generation: string, target = workspace(), capability?: string) => {
    const alive = () => { if (signal.aborted || paused(runtime) || generation !== access.generation(owner)) throw new Error('Request is no longer authorized.'); };
    alive();
    if (owner !== 'local-console') {
      if (runtime.hasService?.('identity')) await runtime.service!<{ authorize(input: { workspace: string; capability?: string }): Promise<void> }>('identity').authorize({ workspace: target, capability });
      else if (runtime.config.plugins?.some(plugin => plugin.id === 'identity')) throw new Error('Configured identity service is unavailable.');
    }
    alive();
  };
  const ask = async (method: string, args: Record<string, unknown>, signal: AbortSignal, target = workspace()) => {
    if (paused(runtime) || signal.aborted) return { allowed: false, visibility: 'local' as const };
    // 只跳过交互式确认；调用前后的身份、scope 和 generation 检查保持相同。
    if (runtime.config.approvalMode === 'auto') return { allowed: true, visibility: runtime.config.autoResultVisibility ?? 'client' };
    return access.request({ owner, workspace: target, method, args, description: method === 'capyra_discover' ? '读取项目指令与能力目录' : method === 'capyra_tasks' ? '读取历史任务或结果' : method === 'capyra_cancel' ? '取消任务' : method === 'capyra_workspace' ? (args.action === 'select' ? '为当前 ChatGPT 会话切换工作区' : '读取可用工作区') : '读取 MCP 目录或资源' }, signal);
  };
  const workspaceOperation = async (args: Record<string, unknown>, signal: AbortSignal, generation: string): Promise<CallToolResult> => {
    if (Object.keys(args).some(key => !['action', 'id'].includes(key)) || !['current', 'list', 'select'].includes(String(args.action)) || (args.action === 'select') !== (typeof args.id === 'string')) throw new Error('Invalid parameters.');
    const service = projects();
    if (!service) throw new Error('Workspace selection is unavailable.');
    const selected = args.action === 'select' ? await service.session(String(args.id)) : currentProject();
    await fresh(signal, generation, selected.path, 'projects__list');
    const decision = await ask('capyra_workspace', args, signal, selected.path);
    if (!decision.allowed || signal.aborted || paused(runtime)) return jsonResult({ status: 'not_approved' }, true);
    await fresh(signal, generation, selected.path, 'projects__list');
    if (args.action === 'select') {
      // 选择只属于当前 MCP 会话，多个 ChatGPT 账号或对话不会互相改动目标工作区。
      await binding?.persist?.(selected.id);
      sessionProjectId = selected.id;
      if (binding) binding.projectId = selected.id;
      return decision.visibility === 'client' ? jsonResult({ status: 'selected', project: selected, connectionChanged: false }) : jsonResult({ status: 'selected' });
    }
    if (decision.visibility !== 'client') return jsonResult({ status: 'local_only' });
    if (args.action === 'current') return jsonResult({ project: selected, scope: binding?.scope ?? 'mcp_session', connectionChanged: false });
    const available: { id: string; name: string; path: string }[] = [];
    for (const item of service.list()) {
      try { await fresh(signal, generation, item.path, 'projects__list'); available.push(item); }
      catch { /* 身份范围之外的工作区不进入远程目录。 */ }
    }
    return jsonResult({ projects: available, selectedId: selected.id, connectionChanged: false });
  };
  const compactCatalog = () => [
    workspaceTool,
    { name: 'capyra_discover', title: 'Find a local capability', description: 'Request capability schemas and instructions for the workspace currently selected in this MCP session. Call again after changing workspaces. Use a tool name or short keywords such as workspace read; omit query to list all enabled capabilities.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200, description: 'A tool name or space-separated keywords; matches any keyword.' } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: false } },
    { name: 'capyra_call', title: 'Run a local capability', description: 'Submit a discovered capability. Reads and actions follow local approval settings. Result delivery follows the local owner’s selected visibility.', inputSchema: { type: 'object', properties: { tool: { type: 'string', minLength: 1 }, args: { type: 'object', additionalProperties: true } }, required: ['tool', 'args'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, taskTool, cancelTool,
  ];
  return {
    async list(signal: AbortSignal) {
      const generation = access.generation(owner); const root = workspace();
      const exposure = runtime.config.exposure;
      await fresh(signal, generation, root);
      let includePrivate = false;
      // 原生元数据只决定宿主可见的入口；仅插件显式声明的固定描述符免于目录审批。
      if (exposure === 'direct' || runtime.listTools().some(tool => isNativeClientTool(tool) && tool.publicCatalog !== true)) {
        const decision = await ask('tools/list', {}, signal);
        includePrivate = decision.allowed && decision.visibility === 'client';
      }
      await fresh(signal, generation, root);
      if (workspace() !== root || runtime.config.exposure !== exposure) throw new Error('Workspace or exposure changed. Submit a new request.');
      // 等待身份检查或审批后重新取当前注册项，卸载与同名替换不能继承旧声明。
      const current = runtime.listTools();
      return { tools: exposure === 'direct'
        ? includePrivate ? [...current.map(exposeTool), workspaceTool, taskTool, cancelTool] : []
        : [...compactCatalog(), ...current.filter(tool => isNativeClientTool(tool) && (includePrivate || tool.publicCatalog === true)).map(exposeTool)] };
    },
    async extension(method: string, params: Record<string, unknown>, signal: AbortSignal, httpTrace = httpScope.getStore()?.templateTrace) {
      const trace = httpTrace ?? templateTrace(runtime, options, method, params);
      try {
        if (trace && !trace.stages.has('protocol')) trace.emit('protocol', 'protocol_accepted');
        const generation = access.generation(owner); const root = workspace();
        try { await fresh(signal, generation, root); }
        catch (error) { trace?.emit('auth', signal.aborted ? 'request_cancelled' : paused(runtime) ? 'paused' : 'identity_rejected'); throw error; }
        trace?.emit('auth', 'identity_authorized');
        const registered = extensions(runtime);
        const template = method === 'resources/read' && typeof params.uri === 'string' ? registered?.publicUiTemplates?.get(params.uri) : undefined;
        if (template) {
          // 只交付注册时冻结的产品外壳，不调用 provider.handle，也不按 URI/MIME 或客户端声明推断公开性。
          try { await fresh(signal, generation, root); }
          catch (error) { trace?.emit('auth', signal.aborted ? 'request_cancelled' : paused(runtime) ? 'paused' : 'identity_rejected'); throw error; }
          if (workspace() !== root || extensions(runtime) !== registered || registered?.publicUiTemplates?.get(template.uri) !== template) { trace?.emit('protocol', 'template_unavailable'); throw new Error('UI template was changed or unloaded.'); }
          trace?.emit('returned', 'template_returned');
          return { contents: [structuredClone(template)] };
        }
        const decision = await ask(method, params, signal);
        if (!decision.allowed || decision.visibility !== 'client' || signal.aborted || paused(runtime)) throw new Error('Local approval is required.');
        const provider = extensions(runtime);
        if (!provider) throw new Error('Method not available.');
        await fresh(signal, generation, root);
        if (workspace() !== root) throw new Error('Workspace changed.');
        const result = await provider.handle(method, params, { owner, signal });
        await fresh(signal, generation, root);
        if (workspace() !== root) throw new Error('Workspace changed.');
        return result;
      } catch (error) { if (trace && !trace.stages.has('returned')) trace.emit('protocol', 'handler_rejected'); throw error; }
      finally { if (!httpTrace) trace?.emit('closed', 'response_finished'); }
    },
    async call(params: { name: string; arguments?: Record<string, unknown> }, signal: AbortSignal): Promise<CallToolResult> {
      try {
        if (paused(runtime) || signal.aborted) return jsonResult({ status: 'paused' }, true);
        const generation = access.generation(owner); const root = workspace();
        const args = params.arguments ?? {};
        options.onEvidence?.({ type: 'tool-call', at: new Date().toISOString(), owner, method: 'tools/call', tool: params.name });
        if (['capyra_tasks', 'capyra_cancel', 'capyra_discover', 'capyra_workspace'].includes(params.name)) {
          const referenced = ['capyra_tasks', 'capyra_cancel'].includes(params.name) && typeof args.id === 'string' ? runtime.getTask(args.id, owner) : undefined;
          const target = referenced?.workspace ?? root;
          await fresh(signal, generation, target, referenced?.tool);
          if (params.name === 'capyra_workspace') {
            return await workspaceOperation(args, signal, generation);
          }
          const decision = await ask(params.name, args, signal);
          if (!decision.allowed || signal.aborted || paused(runtime)) return jsonResult({ status: 'not_approved' }, true);
          await fresh(signal, generation, target, referenced?.tool);
          if (params.name === 'capyra_tasks') {
            if (Object.keys(args).some(key => !['action', 'id'].includes(key)) || !['get', 'list'].includes(String(args.action))) throw new Error('Invalid parameters.');
            if (decision.visibility !== 'client') return jsonResult({ status: 'local_only' });
            if (args.action === 'list') {
              const tasks = runtime.listTasks(owner);
              const roots = [...new Set(tasks.map(task => task.workspace ?? root))];
              const allowed = new Set<string>();
              await Promise.all(roots.map(async target => { try { await fresh(signal, generation, target); allowed.add(target); } catch {} }));
              await fresh(signal, generation, root);
              return jsonResult({ tasks: tasks.filter(task => allowed.has(task.workspace ?? root)).map(({ id, status }) => ({ taskId: id, status })) });
            }
            if (typeof args.id !== 'string') throw new Error('Invalid parameters.');
            const task = runtime.getTask(args.id, owner);
            if (!task) throw new Error('Task unavailable.');
            await fresh(signal, generation, task.workspace ?? root, task.tool);
            return taskResult(task);
          }
          if (params.name === 'capyra_cancel') {
            if (Object.keys(args).some(key => key !== 'id') || typeof args.id !== 'string' || !args.id) throw new Error('Invalid parameters.');
            if (!runtime.getTask(args.id, owner)) throw new Error('Task unavailable.');
            await runtime.cancelTask(args.id, owner);
            await fresh(signal, generation, target, referenced?.tool);
            return safeTask(runtime.getTask(args.id, owner)!);
          }
          if (runtime.config.exposure !== 'compact' || Object.keys(args).some(key => key !== 'query') || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200))) throw new Error('Invalid parameters.');
          if (decision.visibility !== 'client') return jsonResult({ status: 'local_only' });
          if (workspace() !== root) throw new Error('Workspace changed.');
          const query = String(args.query ?? '').toLocaleLowerCase().trim();
          // 客户端常用短句描述能力；保留完整名称匹配，同时接受任一空白/标点分隔的关键词。
          const words = query.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
          const discovered = [workspaceTool, ...runtime.listTools().map(tool => ({ ...exposeTool(tool), ...(tool.outputSchema ? { sourceOutputSchema: tool.outputSchema } : {}) }))];
          return jsonResult({ workspace: currentProject(), instructions: runtime.instructions(), tools: discovered.filter(tool => {
            const text = `${tool.name} ${tool.title} ${tool.description} ${tool === workspaceTool ? 'projects workspace' : ''}`.toLocaleLowerCase();
            return !query || text.includes(query) || words.some(word => text.includes(word));
          }) });
        }
        let name = params.name;
        let input = args;
        // 界面与文件入站依赖主机读取真实 descriptor；保留这些原生入口，执行仍走同一审批链。
        const nativeTool = runtime.config.exposure === 'compact' && runtime.listTools().some(tool => tool.name === name && isNativeClientTool(tool));
        if (runtime.config.exposure === 'compact' && !nativeTool) {
          if (name !== 'capyra_call' || Object.keys(args).some(key => !['tool', 'args'].includes(key)) || typeof args.tool !== 'string' || !args.tool || !object(args.args)) throw new Error('Invalid parameters.');
          name = args.tool;
          input = args.args;
        }
        // 老连接已经缓存了 capyra_call，也能通过 discover 获得并调用新的会话级工作区能力。
        if (name === workspaceTool.name) return await workspaceOperation(input, signal, generation);
        const task = await runtime.submit(name, input, owner, root, sessionScopeId);
        const abort = () => { void runtime.cancelTask(task.id, owner).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (signal.aborted) { abort(); return safeTask(task); }
          if (!['succeeded', 'failed', 'denied', 'cancelled', 'interrupted'].includes(task.status)) {
            // 审批只交付给截止时间内仍在等待的原始请求；断连先发生时立即取消。
            await Promise.race([
              runtime.waitTask ? runtime.waitTask(task.id, options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS) : Promise.resolve(),
              new Promise<void>(done => { timer = setTimeout(done, options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS); signal.addEventListener('abort', () => done(), { once: true }); }),
            ]);
          }
          const latest = runtime.getTask(task.id, owner) ?? task;
          if (['awaiting_approval', 'preparing'].includes(latest.status)) await runtime.cancelTask(task.id, owner);
          if (signal.aborted || paused(runtime)) return safeTask(runtime.getTask(task.id, owner) ?? task);
          await fresh(signal, generation, task.workspace ?? root, task.tool);
          return taskResult(runtime.getTask(task.id, owner) ?? task);
        } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      } catch { return jsonResult({ error: 'Request could not be completed. Review details in the local Capyra console.' }, true); }
    },
  };
}

export function createMcpServer(runtime: McpRuntime, owner: string, options: McpOptions & { access?: AccessController; workspaceBinding?: WorkspaceBinding } = {}): Server {
  const access = options.access ?? createAccessController(options.approvalTimeoutMs);
  const handlers = dispatcher(runtime, owner, access, options, options.workspaceBinding);
  const server = new Server(info, { capabilities: { tools: { listChanged: true }, ...extensions(runtime)?.capabilities }, instructions: publicInstructions });
  const signal = (other: AbortSignal) => {
    const scope = httpScope.getStore();
    if (!scope) return other;
    // SDK 的会话关闭或 cancellation 也要结束对应 HTTP 响应，避免残留活请求。
    other.addEventListener('abort', scope.cancel, { once: true });
    return AbortSignal.any([other, scope.signal]);
  };
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try { return await handlers.list(signal(extra.signal)); }
    catch { throw new Error('Request could not be completed. Review the local Capyra console.'); }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => handlers.call(params, signal(extra.signal)));
  server.fallbackRequestHandler = async (request, extra) => {
    if (!['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get'].includes(request.method)) throw new Error('Method not found.');
    try { return await handlers.extension(request.method, request.params ?? {}, signal(extra.signal)); }
    catch { throw new Error('Request could not be completed. Review the local Capyra console.'); }
  };
  const dispose = runtime.onEvent(event => {
    if (event.type === 'runtime.approval_settings_changed') access.cancelOwner();
    // 工作区切换不改变工具描述符；通知目录变化会让部分客户端误判旧对话中的连接已失效。
    if (event.type.startsWith('plugin') || event.type === 'tools.changed' || event.type === 'runtime.approval_settings_changed') void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
  });
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    dispose();
    if (!options.access) access.close();
  };
  server.onclose = cleanup;
  const close = server.close.bind(server);
  // SDK 在尚未 connect 时不会触发 onclose；两条关闭路径共用幂等释放逻辑。
  server.close = async () => { try { await close(); } finally { cleanup(); } };
  return server;
}

function issuerUrl(value: string): URL {
  return new URL(`${publicBaseUrl(value)}/`);
}
function decodedHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  return Buffer.from(encoded, 'base64').toString('utf8');
}
function parameterHeadersMatch(schema: Record<string, unknown>, args: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): boolean {
  const seen = new Set<string>();
  const visit = (definition: Record<string, unknown>, value: unknown): boolean => {
    if (definition['x-mcp-header'] !== undefined) {
      const name = definition['x-mcp-header'];
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || seen.has(name.toLowerCase()) || !['integer', 'string', 'boolean'].includes(String(definition.type))) return false;
      seen.add(name.toLowerCase());
      const header = decodedHeader(headers[`mcp-param-${name.toLowerCase()}`]);
      if (value === undefined || value === null) { if (header !== undefined) return false; }
      else if (header !== String(value) || (definition.type === 'integer' && !Number.isSafeInteger(value))) return false;
    }
    return !object(definition.properties) || Object.entries(definition.properties).every(([key, child]) => !object(child) || visit(child, object(value) ? value[key] : undefined));
  };
  return visit(schema, args);
}
export interface McpHttpController {
  localUrl: string;
  readonly url: string; readonly oauth: OAuthController; access: AccessController;
  setPublicUrl(url?: string): Promise<void>;
  setTunnelUrl(url?: string): void;
  close(): Promise<void>;
}
export async function startMcpHttp(runtime: McpRuntime, config: RuntimeConfig, options: McpOptions = {}): Promise<McpHttpController> {
  if (config.publicUrl) issuerUrl(config.publicUrl);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const http = createHttpServer(app);
  http.requestTimeout = 30_000; http.headersTimeout = 15_000; http.maxHeadersCount = 64;
  const sessions = new Map<string, { owner: string; transport: StreamableHTTPServerTransport; server: Server; touchedAt: number }>();
  const active = new Map<AbortController, string>();
  const access = createAccessController(options.approvalTimeoutMs);
  let initializing = 0;
  let closing = false;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
  const address = http.address();
  const localUrl = `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : config.port}`;
  const local = new URL(localUrl);
  let issuer = issuerUrl(config.publicUrl ?? localUrl);
  let tunnelHost: string | undefined;
  const revoked = (grantId?: string) => {
    const owner = grantId ? `oauth:${grantId}` : undefined;
    access.cancelOwner(owner);
    for (const [controller, requestOwner] of active) if (!owner || owner === requestOwner) controller.abort();
    for (const [id, session] of sessions) if (!owner || session.owner === owner) { sessions.delete(id); void session.server.close().catch(() => {}); }
    const owners = owner ? [owner] : [...new Set(runtime.listTasks().map(task => task.owner).filter(value => value !== 'local-console'))];
    for (const value of owners) void runtime.cancelOwner?.(value).catch(() => {});
  };
  const makeOAuth = (origin = issuer) => createOAuth(origin, revoked, { stateDir: config.stateDir, onAuthorized: event => options.onEvidence?.({ type: 'authorization', at: new Date().toISOString(), ...event }) });
  let oauth: OAuthController;
  try { oauth = makeOAuth(); }
  catch (error) { await new Promise<void>(resolve => http.close(() => resolve())); throw error; }
  const requestTraces = new WeakMap<express.Request, TemplateTrace>();
  const lifecycleTraces = new WeakMap<express.Request, { emit(stage: McpRequestDiagnostic['stage'], reason: McpRequestDiagnosticReason, httpStatus?: number): void }>();
  if (options.onRequestDiagnostic) {
    app.all('/mcp', (req, res, next) => {
      const requestId = randomUUID(); let received = false, closed = false, rejected = false;
      const operation = (): McpRequestDiagnostic['operation'] => {
        switch (req.body?.method) {
          case 'initialize': return 'initialize'; case 'tools/list': return 'tools_list';
          case 'tools/call': return 'tools_call'; case 'resources/read': return 'resources_read';
          default: return 'other';
        }
      };
      const report = (stage: McpRequestDiagnostic['stage'], reason: McpRequestDiagnosticReason, httpStatus?: number) => {
        try { options.onRequestDiagnostic!({ requestId, operation: operation(), stage, reason, ...(httpStatus === undefined ? {} : { httpStatus }) }); } catch { /* 诊断回调不能中断 MCP 请求。 */ }
      };
      const trace = { emit(stage: McpRequestDiagnostic['stage'], reason: McpRequestDiagnosticReason, httpStatus?: number) {
        if (closed) return;
        // JSON 解析成功后才确定分类；解析失败也会在拒绝/关闭时以 other 留下记录。
        if (!received) { received = true; report('received', 'request_received'); }
        if (stage === 'received') return;
        if (httpStatus !== undefined && httpStatus >= 400) rejected = true;
        if (stage === 'closed') closed = true;
        report(stage, reason, httpStatus);
      } };
      lifecycleTraces.set(req, trace);
      const finish = (finished: boolean) => {
        if (!rejected && res.statusCode >= 400) trace.emit(res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 423 ? 'auth' : 'protocol', res.statusCode === 401 ? 'unauthorized' : res.statusCode === 403 ? 'forbidden' : res.statusCode === 423 ? 'paused' : 'protocol_rejected', res.statusCode);
        if (finished && res.statusCode < 400) trace.emit('returned', 'response_finished', res.statusCode);
        trace.emit('closed', finished ? 'response_finished' : 'connection_closed', finished || res.headersSent ? res.statusCode : undefined);
      };
      res.once('finish', () => finish(true)); res.once('close', () => finish(res.writableFinished));
      next();
    });
  }
  if (options.onTemplateDiagnostic || options.onRequestDiagnostic) {
    // 显式诊断模式才提前解析有界 MCP JSON，以便观察 Host/Origin/OAuth 在处理器前的拒绝。
    // 原有 Host、Origin、OAuth 和请求校验仍逐项执行；默认模式不改变中间件顺序。
    app.post('/mcp', express.json({ limit: '1mb' }), (req, res, next) => {
      lifecycleTraces.get(req)?.emit('received', 'request_received');
      const trace = templateTrace(runtime, options, req.body?.method, object(req.body?.params) ? req.body.params : {});
      if (trace) {
        requestTraces.set(req, trace);
        const closed = (finished: boolean) => {
          if (!trace.stages.has('closed') && !trace.stages.has('returned')) {
            if (res.statusCode === 401 || res.statusCode === 403) trace.emit('auth', res.statusCode === 401 ? 'unauthorized' : 'forbidden', res.statusCode);
            else if (res.statusCode === 423) trace.emit('auth', 'paused', res.statusCode);
            else if (res.statusCode >= 400) trace.emit('protocol', 'protocol_rejected', res.statusCode);
          }
          trace.emit('closed', finished ? 'response_finished' : 'connection_closed', finished || res.headersSent ? res.statusCode : undefined);
        };
        res.once('finish', () => closed(true)); res.once('close', () => closed(res.writableFinished));
      }
      next();
    });
  }
  app.use((req, res, next) => {
    const hosts = new Set([issuer.host, local.host, `localhost:${local.port}`, ...(tunnelHost ? [tunnelHost] : [])]);
    const origins = new Set([issuer.origin, local.origin, `http://localhost:${local.port}`]);
    if (!req.headers.host || !hosts.has(req.headers.host.toLowerCase())) { lifecycleTraces.get(req)?.emit('auth', 'host_rejected', 403); res.status(403).json({ error: 'Invalid Host header.' }); return; }
    // 固定入口隔离授权页的 origin；仅无凭据的随机请求状态 GET 可从 opaque 页面轮询。
    const opaquePending = req.headers.origin === 'null' && req.method === 'GET' && /^\/oauth\/pending\/[A-Za-z0-9_-]{43}$/.test(req.path) && !req.headers.cookie && !req.headers.authorization;
    if (req.headers.origin && !origins.has(req.headers.origin) && !opaquePending) { lifecycleTraces.get(req)?.emit('auth', 'origin_rejected', 403); res.status(403).json({ error: 'Invalid Origin header.' }); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, WWW-Authenticate');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => { res.json({ ok: true, service: 'capyra' }); });
  app.use((req, res, next) => oauth.router(req, res, next));
  app.all('/mcp', (req, res, next) => oauth.requireAuth(req, res, next), async (req, res) => {
    const trace = requestTraces.get(req); trace?.emit('auth', 'oauth_authorized');
    const lifecycle = lifecycleTraces.get(req); lifecycle?.emit('auth', 'oauth_authorized');
    const owner = res.locals.capyraOwner as string;
    if (paused(runtime)) { lifecycle?.emit('auth', 'paused', 423); res.status(423).json({ error: 'Local access is paused.' }); return; }
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { if (!res.writableEnded) res.destroy(); }, { once: true });
    // 入口验签不延长令牌寿命：已批准的在飞请求也在访问令牌/授权的精确到期点失效。
    const expiresAt = req.auth?.expiresAt;
    const expiryTimer = expiresAt === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(0, expiresAt * 1000 - Date.now()));
    active.set(controller, owner);
    const disconnect = () => { clearTimeout(expiryTimer); if (!res.writableEnded) controller.abort(); active.delete(controller); };
    res.once('close', disconnect);
    const fail = (status: number, code: number, message: string, data?: unknown) => {
      const reason = code === -32602 ? 'invalid_metadata' : code === -32022 ? 'unsupported_version' : code === -32020 ? 'header_mismatch' : status === 406 ? 'unacceptable_response_type' : 'protocol_rejected';
      trace?.emit('protocol', reason, status); lifecycle?.emit('protocol', reason, status);
      res.status(status).json({ jsonrpc: '2.0', ...(typeof req.body?.id === 'string' || Number.isInteger(req.body?.id) ? { id: req.body.id } : {}), error: { code, message, ...(data ? { data } : {}) } });
    };
    try {
      const meta = req.body?.params?._meta;
      const requestedVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
      const modern = requestedVersion !== undefined || req.headers['mcp-protocol-version'] === modernVersion || req.body?.method === 'server/discover';
      if (modern) {
        if (req.method !== 'POST') { res.sendStatus(405); return; }
        if (!object(req.body) || req.body.jsonrpc !== '2.0' || (typeof req.body.id !== 'string' && !Number.isInteger(req.body.id)) || typeof req.body.method !== 'string' || !object(meta) || typeof requestedVersion !== 'string' || !object(meta['io.modelcontextprotocol/clientCapabilities'])) { fail(400, -32602, 'Required per-request metadata is missing or malformed.'); return; }
        if (requestedVersion !== modernVersion) { fail(400, -32022, 'Unsupported protocol version', { requested: requestedVersion, supported: versions }); return; }
        const decodedName = decodedHeader(req.headers['mcp-name']);
        const bodyParams = object(req.body.params) ? req.body.params : {};
        const needsName = ['tools/call', 'resources/read', 'prompts/get'].includes(req.body.method);
        if (req.headers['mcp-protocol-version'] !== requestedVersion || req.headers['mcp-method'] !== req.body.method || (needsName && decodedName !== (bodyParams.name ?? bodyParams.uri))) { fail(400, -32020, 'Header mismatch.'); return; }
        if (!req.headers.accept?.includes('application/json') || !req.headers.accept.includes('text/event-stream')) { fail(406, -32600, 'Accept must include application/json and text/event-stream.'); return; }
        lifecycle?.emit('protocol', 'modern_dispatch');
        const conversationBinding = await requestWorkspaceBinding(runtime, owner, bodyParams);
        const handlers = dispatcher(runtime, owner, access, options, conversationBinding ?? { scope: 'request' });
        let result: Record<string, unknown>;
        if (req.body.method === 'server/discover') result = { supportedVersions: versions, capabilities: { tools: {}, ...extensions(runtime)?.capabilities }, instructions: publicInstructions };
        else if (req.body.method === 'ping') result = {};
        else if (req.body.method === 'tools/list') result = await handlers.list(controller.signal);
        else if (req.body.method === 'tools/call') {
          const parsed = CallToolRequestSchema.safeParse(req.body);
          if (!parsed.success) { fail(400, -32602, 'Invalid tool request.'); return; }
          const definition = runtime.listTools().find(tool => tool.name === parsed.data.params.name && (runtime.config.exposure === 'direct' || isNativeClientTool(tool)));
          if (definition && !parameterHeadersMatch(definition.inputSchema, parsed.data.params.arguments ?? {}, req.headers)) { fail(400, -32020, 'Header mismatch.'); return; }
          result = await handlers.call(parsed.data.params, controller.signal);
        } else if (['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get'].includes(req.body.method) && extensions(runtime)) result = await handlers.extension(req.body.method, bodyParams, controller.signal, trace);
        else { fail(404, -32601, 'Method not found.'); return; }
        if (!controller.signal.aborted) res.json({ jsonrpc: '2.0', id: req.body.id, result: { ...result, resultType: 'complete', _meta: { ...(object(result._meta) ? result._meta : {}), 'io.modelcontextprotocol/serverInfo': info } } });
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      if (Array.isArray(sessionId)) { lifecycle?.emit('protocol', 'invalid_session_id', 400); res.status(400).json({ error: 'Invalid session id.' }); return; }
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && (!session || session.owner !== owner)) { lifecycle?.emit('protocol', 'session_unavailable', 404); res.status(404).json({ error: 'Session not found.' }); return; }
      // 兼容不保存会话的旧版 HTTP 客户端：每个 POST 使用独立 SDK 实例，仍执行完全相同的审批。
      const legacyVersion = req.headers['mcp-protocol-version'];
      if (!sessionId && req.method === 'POST' && !isInitializeRequest(req.body) && typeof legacyVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(legacyVersion)) {
        lifecycle?.emit('protocol', 'legacy_stateless_dispatch');
        const params = object(req.body?.params) ? req.body.params : {};
        const workspaceBinding = await requestWorkspaceBinding(runtime, owner, params);
        const server = createMcpServer(runtime, owner, { ...options, access, workspaceBinding: workspaceBinding ?? { scope: 'request' } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try { await server.connect(transport); await httpScope.run({ signal: controller.signal, cancel: () => controller.abort(), templateTrace: trace }, () => transport.handleRequest(req, res, req.body)); }
        finally { await server.close(); }
        return;
      }
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) { lifecycle?.emit('protocol', 'initialize_required', 400); res.status(400).json({ error: 'Initialize an MCP session first.' }); return; }
        if (sessions.size + initializing >= 64 || [...sessions.values()].filter(item => item.owner === owner).length >= 8) { lifecycle?.emit('protocol', 'session_limit', 503); res.status(503).json({ error: 'Too many active MCP sessions.' }); return; }
        const params = object(req.body?.params) ? req.body.params : {};
        const workspaceBinding = await requestWorkspaceBinding(runtime, owner, params);
        initializing++;
        const server = createMcpServer(runtime, owner, { ...options, access, workspaceBinding });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: id => { sessions.set(id, { owner, transport, server, touchedAt: Date.now() }); } });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        try { await server.connect(transport); }
        catch { initializing--; await server.close(); lifecycle?.emit('protocol', 'session_setup_failed', 500); res.status(500).json({ error: 'Unable to initialize MCP session.' }); return; }
        session = { owner, transport, server, touchedAt: Date.now() };
      }
      session.touchedAt = Date.now();
      lifecycle?.emit('protocol', 'legacy_session_dispatch');
      try { await httpScope.run({ signal: controller.signal, cancel: () => controller.abort(), templateTrace: trace }, () => session!.transport.handleRequest(req, res, req.body)); }
      finally { if (!sessionId) { initializing--; if (!session.transport.sessionId) await session.server.close(); } }
    } catch { if (!res.headersSent && !controller.signal.aborted) fail(400, -32603, 'MCP request could not be completed. Review the local console.'); }
    finally { if (res.writableEnded) { clearTimeout(expiryTimer); active.delete(controller); } }
  });
  // JSON 解析和中间件错误使用固定回复，禁止 Express 默认错误页暴露本机堆栈路径。
  const handleError: express.ErrorRequestHandler = (error, req, res, _next) => {
    lifecycleTraces.get(req)?.emit('protocol', error?.status === 413 ? 'body_too_large' : error?.type === 'entity.parse.failed' ? 'invalid_json' : 'protocol_rejected', error?.status === 413 ? 413 : 400);
    if (!res.headersSent) res.status(error?.status === 413 ? 413 : 400).json({ error: 'Invalid request.' });
  };
  app.use(handleError);
  const dispose = runtime.onEvent(event => {
    if (event.type === 'runtime.approval_settings_changed') { access.cancelOwner(); for (const controller of active.keys()) controller.abort(); }
    if (paused(runtime)) { access.pause(true); for (const controller of active.keys()) controller.abort(); } else access.pause(false);
  });
  const sweep = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touchedAt > 30 * 60_000) { sessions.delete(id); void session.server.close().catch(() => {}); }
  }, 60_000);
  sweep.unref();
  return {
    localUrl, get url() { return publicEndpoint(issuer, 'mcp'); }, get oauth() { return oauth; }, access,
    setTunnelUrl(value) {
      if (value === undefined) { tunnelHost = undefined; return; }
      if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/.test(value)) throw new Error('Tunnel URL must be an assigned Quick Tunnel origin');
      tunnelHost = new URL(value).host;
    },
    async setPublicUrl(value) {
      const next = issuerUrl(value ?? localUrl);
      if (next.href === issuer.href) return;
      const replacement = makeOAuth(next);
      try { oauth.revoke(); } catch (error) { replacement.close(); throw error; }
      oauth.close(); issuer = next; oauth = replacement;
    },
    async close() {
      if (closing) return;
      closing = true; dispose(); clearInterval(sweep); access.close(); oauth.close();
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled([...sessions.values()].map(session => session.server.close())); sessions.clear();
      await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); });
    },
  };
}
