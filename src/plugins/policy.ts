import type { CapyraPlugin } from '../core/types.js';
import type { ExecutionPolicy } from '../core/runtime.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'policy', version: '0.2.0', title: '访问策略',
  description: '在请求级本机确认之外，限定当前组合可用的工具。', permissions: [],
  setup(ctx) {
    const deny = ctx.config.deniedTools ?? [];
    if (!Array.isArray(deny) || deny.some(name => typeof name !== 'string')) throw new Error('deniedTools 必须为工具名数组');
    const policy: ExecutionPolicy = { check: tool => deny.includes(tool.name) ? `本机策略已停用工具：${tool.name}` : undefined };
    ctx.provide('execution.policy', policy);
  },
};
export default plugin;
