import type { CapyraPlugin } from '../core/types.js';
import { startControl } from '../transport/control.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'console', version: '0.2.0', title: '本机工作台',
  description: '只在本机开放的管理、审批和结果界面。', permissions: [],
  setup(ctx) {
    const handles: Awaited<ReturnType<typeof startControl>>[] = [];
    const pending = new Set<Promise<unknown>>();
    let closed = false;
    ctx.provide('console.transport', { async start(...args: Parameters<typeof startControl>) {
      if (closed) throw new Error('控制台插件已停止');
      const operation = startControl(...args); pending.add(operation);
      try {
        const handle = await operation;
        if (closed) { await handle.close(); throw new Error('控制台插件已停止'); }
        handles.push(handle); return handle;
      } finally { pending.delete(operation); }
    } });
    ctx.onDispose(async () => { closed = true; await Promise.allSettled(pending); await Promise.allSettled(handles.map(handle => handle.close())); });
  },
};
export default plugin;
