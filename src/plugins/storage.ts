import type { CapyraPlugin } from '../core/types.js';
import { DiskTaskStore, type TaskStore } from '../core/store.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'storage', version: '0.2.0', title: '本机记录',
  description: '原子保存任务和有界审计，重启后恢复记录。', permissions: [],
  createStore: stateDir => new DiskTaskStore(stateDir),
  setup(ctx) { ctx.provide('storage', ctx.service<TaskStore>('host.store')); },
};
export default plugin;
