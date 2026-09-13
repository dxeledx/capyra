import type { CapyraPlugin } from '../core/types.js';
const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'ui', version: '0.2.0', title: 'Capyra 界面',
  description: '默认工作台的页面、样式和交互；可由外部界面插件替换。', permissions: [],
  setup(ctx) { ctx.provide('ui', { assetsRoot: new URL('../../public/', import.meta.url) }); },
};
export default plugin;
