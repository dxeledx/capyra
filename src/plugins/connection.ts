import { join } from 'node:path';
import type { CapyraPlugin } from '../core/types.js';
import { createConnectionService } from '../connection/service.js';
import type { ConnectionHost, ConnectionConfigurationInput } from '../connection/types.js';

export function createConnectionPlugin(host: Partial<ConnectionHost> = {}): CapyraPlugin {
  return { apiVersion: 1, id: 'connection', version: '0.1.0', title: '客户端连接', description: 'Sites 固定入口、Cloudflare 备用连接、客户端准备与分层诊断。', permissions: [],
    async setup(ctx) {
      const { mcpPort = 4317, controlPort = 4318, ...config } = ctx.config;
      const service = await createConnectionService({ stateDir: join(ctx.stateDir, 'connection'), mcpPort: Number(mcpPort), controlPort: Number(controlPort), configuration: config as ConnectionConfigurationInput, ...host });
      ctx.provide('connection', service);
      ctx.onDispose(() => service.close());
      // 启动入口准备好 MCP/OAuth 后调用 restore；插件初始化不自动公开尚未就绪的服务。
    },
  };
}
export default createConnectionPlugin();
