export type { CapyraPlugin, PluginContext, ToolDefinition, ToolContext, Preview, JsonSchema } from './core/types.js';
export type { TaskRecord, RuntimeEvent } from './core/types.js';
export type { TaskStore } from './core/store.js';
export type { ExecutionPolicy } from './core/runtime.js';
export function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
export function definePlugin<T extends CapyraPlugin>(plugin: T): T { return plugin; }
import type { CapyraPlugin } from './core/types.js';
