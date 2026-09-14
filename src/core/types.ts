import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type Effect = 'read' | 'write' | 'execute';
export type JsonSchema = { type: 'object'; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; [key: string]: unknown };
export interface Preview { title: string; description: string; before?: string; after?: string }
export interface ToolContext { workspace: string; owner: string; session?: string; signal: AbortSignal; taskId: string; progress(message: string): void }
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  effect: Effect;
  permissions: string[];
  /** 插件明确保证整个描述符仅含固定产品信息，可在精简目录公开；不改变调用、数据或历史审批。 */
  publicCatalog?: boolean;
  /** 即使没有 UI 或原生文件参数，也可作为客户端直达工具进入精简目录。 */
  clientCatalog?: boolean;
  /** 即使宿主处于自动批准模式，这个工具仍要求本机逐次确认。 */
  alwaysConfirm?: boolean;
  annotations?: ToolAnnotations;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  icons?: { src: string; mimeType?: string; sizes?: string[] }[];
  timeoutMs?: number;
  preview?(args: Record<string, unknown>, context: ToolContext): Promise<Preview>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult>;
}
export interface RegisteredTool extends ToolDefinition { pluginId: string; localName: string }
export interface RuntimeEvent { type: string; at: string; taskId?: string; pluginId?: string; detail?: string }
export interface PluginContext {
  workspace: string;
  stateDir: string;
  config: Record<string, unknown>;
  registerTool(tool: ToolDefinition): () => void;
  provide<T>(name: string, service: T): void;
  service<T>(name: string): T;
  guard(check: (tool: RegisteredTool, args: Readonly<Record<string, unknown>>) => string | undefined): void;
  onEvent(listener: (event: RuntimeEvent) => void): void;
  /** 插件可发布不含敏感数据的运行时状态变化，让现有客户端刷新目录或界面。 */
  emit?(event: Omit<RuntimeEvent, 'at'>): void;
  onDispose(dispose: () => void | Promise<void>): void;
}
export interface CapyraPlugin {
  apiVersion: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  permissions: string[];
  requires?: string[];
  instructions?: string;
  /** 存储在恢复任务之前装配；其他插件仍按普通生命周期启停。 */
  createStore?(stateDir: string, config: Record<string, unknown>): import('./store.js').TaskStore;
  setup(context: PluginContext): void | Promise<void>;
}
export interface PluginEntry { id: string; module?: string; manifest?: string; requestedPermissions?: string[]; enabled: boolean; grants: string[]; config?: Record<string, unknown> }
export type TaskStatus = 'preparing' | 'awaiting_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  id: string;
  owner: string;
  clientSession?: string;
  workspace?: string;
  resultVisibility?: 'client' | 'local';
  tool: string;
  pluginId: string;
  effect: Effect;
  status: TaskStatus;
  args: Record<string, unknown>;
  inputHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  preview?: Preview;
  previewError?: string;
  result?: CallToolResult;
  error?: string;
  progress?: string;
}
export interface RuntimeConfig {
  workspace: string;
  stateDir: string;
  port: number;
  controlPort: number;
  publicUrl?: string;
  exposure: 'direct' | 'compact';
  approvalMode?: 'ask' | 'auto';
  autoResultVisibility?: 'local' | 'client';
  plugins: PluginEntry[];
  maxConcurrent: number;
  maxTasks: number;
  configPath?: string;
  storagePlugin?: string;
}
export interface PluginState { id: string; title: string; description: string; version: string; enabled: boolean; status: 'disabled' | 'loading' | 'ready' | 'error'; permissions: string[]; grants: string[]; toolCount: number; error?: string; instructions?: string; restartRequired?: boolean; restartReason?: string }
