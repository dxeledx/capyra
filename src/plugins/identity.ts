import type { CapyraPlugin } from '../core/types.js';
import { createIdentityService } from '../identity/client.js';
import { DEFAULT_ACCOUNT_SERVICE_URL } from '../identity/defaults.js';

export const identityPlugin: CapyraPlugin = {
  apiVersion: 1, id: 'identity', version: '0.1.0', title: 'Capyra 账号与设备',
  description: '独立账号、本机可信配对、设备范围与撤销。', permissions: [],
  setup(context) {
    // 仅为缺省配置提供入口；IdentityService 仍优先使用本机已保存的服务地址，避免迁移账号归属。
    const service = createIdentityService({ stateDir: context.stateDir, cloudUrl: typeof context.config.cloudUrl === 'string' ? context.config.cloudUrl : DEFAULT_ACCOUNT_SERVICE_URL });
    context.provide('identity', service);
    context.onDispose(() => service.close());
    if (service.status().device) void service.refreshBinding().catch(() => undefined);
  },
};
export default identityPlugin;
