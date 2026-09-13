import type { CapyraPlugin, TaskRecord } from '../core/types.js';

export type ResultView = { kind: 'text' | 'code' | 'table'; title: string; text?: string; language?: string; columns?: string[]; rows?: unknown[][] };
export interface PresentationService { render(task: TaskRecord): ResultView[] }

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'presentation', version: '0.2.0', title: '结果展示',
  description: '把工具结果呈现为易读文本、代码和表格。', permissions: [],
  setup(ctx) {
    const presentation: PresentationService = { render(task) {
      return (task.result?.content ?? []).flatMap<ResultView>(content => {
        if (content.type !== 'text') return [];
        try {
          const parsed = JSON.parse(content.text);
          const entries = Array.isArray(parsed) ? parsed : parsed?.entries ?? parsed?.files;
          if (Array.isArray(entries) && entries.length && entries.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
            const columns = [...new Set(entries.flatMap(row => Object.keys(row)))].slice(0, 8);
            return [{ kind: 'table' as const, title: '结果', columns, rows: entries.slice(0, 500).map(row => columns.map(column => row[column] ?? '')) }];
          }
          return [{ kind: 'code' as const, title: '结果', text: JSON.stringify(parsed, null, 2), language: 'json' }];
        } catch { return [{ kind: 'text' as const, title: '结果', text: content.text }]; }
      });
    } };
    ctx.provide('presentation', presentation);
  },
};
export default plugin;
