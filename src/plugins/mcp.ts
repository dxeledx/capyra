import type { CapyraPlugin } from '../core/types.js';
import { startMcpHttp, createMcpServer } from '../transport/mcp.js';
import { createMcpExtensions } from '../client-ui/extensions.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'mcp', version: '0.2.1', title: 'MCP 连接',
  description: '支持 HTTP、stdio 与 OAuth 的客户端连接入口。', permissions: [],
  setup(ctx) {
    ctx.provide('mcp.extensions', createMcpExtensions());
    const handles: Awaited<ReturnType<typeof startMcpHttp>>[] = [];
    const servers: ReturnType<typeof createMcpServer>[] = [];
    const pending = new Set<Promise<unknown>>();
    let closed = false;
    ctx.provide('mcp.transport', { createServer(...args: Parameters<typeof createMcpServer>) {
      if (closed) throw new Error('MCP 插件已停止');
      const server = createMcpServer(...args); servers.push(server); return server;
    }, async start(...args: Parameters<typeof startMcpHttp>) {
      if (closed) throw new Error('MCP 插件已停止');
      const operation = startMcpHttp(...args); pending.add(operation);
      try {
        const handle = await operation;
        if (closed) { await handle.close(); throw new Error('MCP 插件已停止'); }
        handles.push(handle); return handle;
      } finally { pending.delete(operation); }
    } });
    ctx.onDispose(async () => { closed = true; await Promise.allSettled(pending); await Promise.allSettled([...handles, ...servers].map(handle => handle.close())); });
  },
};
export default plugin;
