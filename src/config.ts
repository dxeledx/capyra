import { readFile, realpath, writeFile, rename, unlink, lstat, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { CapyraPlugin, PluginEntry, RuntimeConfig } from './core/types.js';

export const defaults = {
  version: 1,
  workspace: '.',
  port: 4317,
  controlPort: 4318,
  exposure: 'compact' as 'direct' | 'compact',
  approvalMode: 'auto' as 'ask' | 'auto',
  autoResultVisibility: 'client' as 'local' | 'client',
  storagePlugin: 'storage',
  plugins: [
    { id: 'storage', enabled: true, grants: [] },
    { id: 'policy', enabled: true, grants: [] },
    { id: 'projects', enabled: true, grants: ['projects:read'] },
    { id: 'workspace', enabled: true, grants: ['workspace:read', 'workspace:write'] },
    { id: 'skills', enabled: true, grants: ['workspace:read', 'skills:read'] },
    { id: 'git', enabled: true, grants: ['git:read', 'git:write', 'workspace:read', 'workspace:write'] },
    { id: 'process', enabled: true, grants: ['process:read', 'process:execute'], config: { commands: { check: { command: 'npm', args: ['test'], timeoutMs: 60_000 } } } },
    { id: 'terminal', enabled: true, grants: ['terminal:read', 'terminal:execute'] },
    { id: 'agents', enabled: true, grants: ['agents:read', 'agents:execute'] },
    { id: 'computer', enabled: false, grants: [], requestedPermissions: ['computer:prepare', 'computer:read', 'computer:execute'] },
    { id: 'plugin-dev', enabled: true, grants: ['plugin:read', 'plugin:write', 'plugin:execute', 'host:update'] },
    { id: 'connection', enabled: true, grants: [] },
    { id: 'presentation', enabled: true, grants: [] },
    { id: 'ui', enabled: true, grants: [] },
    { id: 'mcp', enabled: true, grants: [] },
    { id: 'client-ui', enabled: true, grants: ['workspace:read', 'git:read', 'skills:read', 'projects:read'] },
    { id: 'console', enabled: true, grants: [] },
  ]
};

export async function initConfig(path: string): Promise<void> {
  await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
/** 调用者持有实例锁；先重置连接，最后提交配置，失败时旧身份约束仍然有效。 */
export async function migrateLocalConfig(path: string, stateDir: string): Promise<{ backupPath: string; connectionBackups: string[] }> {
  const readOrdinary = async (filename: string): Promise<Buffer | undefined> => {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('迁移文件必须为普通独立文件');
      return await readFile(filename);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const original = await readOrdinary(path);
  if (!original) throw new Error('配置文件不存在，请先运行 capyra init。');
  const raw = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.plugins)) throw new Error('配置 version 或 plugins 无效');
  const plugins = (raw.plugins as PluginEntry[]).filter(entry => entry.id !== 'identity' && entry.module !== 'builtin:identity').map(entry => {
    if (entry.id !== 'connection' && entry.module !== 'builtin:connection') return entry;
    const { publicUrl: _publicUrl, tunnelId: _tunnelId, token: _token, clearToken: _clearToken, ...config } = entry.config ?? {};
    return { ...entry, config: { ...config, mode: 'quick', autoStart: false } };
  });
  const { publicUrl: _publicUrl, ...preserved } = raw;
  const connectionDir = resolve(stateDir, 'connection');
  // 不沿用符号链接指向的其他工作区；只操作本次连接的状态与运行凭据。
  for (const directory of [stateDir, connectionDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('迁移状态目录必须为真实目录');
  }
  const statePath = resolve(connectionDir, 'connection.json'), tokenPath = resolve(connectionDir, 'tunnel-token');
  const savedState = await readOrdinary(statePath), savedToken = await readOrdinary(tokenPath);
  const suffix = `.before-local-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.bak`;
  const backupPath = path + suffix, connectionBackups: string[] = [];
  await writeFile(backupPath, original, { flag: 'wx', mode: 0o600 });
  for (const [filename, content] of [[statePath, savedState], [tokenPath, savedToken]] as const) {
    if (content !== undefined) { const backup = filename + suffix; await writeFile(backup, content, { flag: 'wx', mode: 0o600 }); connectionBackups.push(backup); }
  }
  const replace = async (filename: string, value: unknown) => {
    const temporary = resolve(dirname(filename), `.capyra-local-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
    finally { await unlink(temporary).catch(() => {}); }
  };
  await replace(statePath, { version: 1, configuration: { mode: 'quick', autoStart: false, protocol: 'http2' }, desiredRunning: false });
  if (savedToken !== undefined) await unlink(tokenPath);
  await replace(path, { ...preserved, plugins });
  return { backupPath, connectionBackups };
}
export async function loadConfig(path: string, overrides: Record<string, string | boolean> = {}): Promise<RuntimeConfig> {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; raw = structuredClone(defaults); }
  if (raw.version !== 1) throw new Error('配置 version 必须为 1');
  const base = dirname(resolve(path));
  const workspace = await realpath(resolve(base, String(overrides.workspace ?? raw.workspace ?? '.')));
  const exposure = overrides.compact ? 'compact' : raw.exposure ?? 'direct';
  if (!['direct', 'compact'].includes(String(exposure))) throw new Error('exposure 只能是 direct 或 compact');
  const approvalMode = raw.approvalMode ?? 'auto', autoResultVisibility = raw.autoResultVisibility ?? 'client';
  if (approvalMode !== 'ask' && approvalMode !== 'auto') throw new Error('approvalMode 只能是 ask 或 auto');
  if (autoResultVisibility !== 'local' && autoResultVisibility !== 'client') throw new Error('autoResultVisibility 只能是 local 或 client');
  const port = int(overrides.port ?? raw.port ?? 4317, 0, 65535, 'port');
  const controlPort = int(overrides['control-port'] ?? raw.controlPort ?? 4318, 0, 65535, 'controlPort');
  if (port !== 0 && port === controlPort) throw new Error('MCP 与本机控制台必须使用不同端口');
  const entries = raw.plugins;
  if (!Array.isArray(entries)) throw new Error('plugins 必须是数组');
  const plugins = entries.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('插件配置无效');
    const p = value as PluginEntry;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id) || typeof p.enabled !== 'boolean' || !Array.isArray(p.grants) || p.grants.some(g => typeof g !== 'string')) throw new Error('插件必须有有效 id、enabled 和 grants');
    if (p.module !== undefined && typeof p.module !== 'string') throw new Error('插件 module 必须是路径');
    if (p.manifest !== undefined && typeof p.manifest !== 'string') throw new Error('插件 manifest 必须是路径');
    if (p.requestedPermissions !== undefined && (!Array.isArray(p.requestedPermissions) || p.requestedPermissions.some(permission => typeof permission !== 'string'))) throw new Error('插件 requestedPermissions 必须是字符串列表');
    if (p.requestedPermissions && p.grants.some(permission => !p.requestedPermissions!.includes(permission))) throw new Error('不能授予插件未声明的权限');
    if (p.module && p.module !== 'mcp' && !p.module.startsWith('builtin:')) p.module = resolve(base, p.module);
    if (p.manifest) p.manifest = resolve(base, p.manifest);
    return p;
  });
  let publicUrl = overrides['public-url'] ?? raw.publicUrl;
  if (publicUrl !== undefined) {
    const url = new URL(String(publicUrl));
    if (url.protocol !== 'https:' || url.username || url.password || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname) || url.search || url.hash) throw new Error('publicUrl 必须是 HTTPS 地址，可包含固定设备路径');
    // 固定设备入口把身份和OAuth绑定到同一前缀，不能截掉路径退回整个账号站点。
    publicUrl = url.origin + url.pathname.replace(/\/$/, '');
  }
  return { workspace, stateDir: resolve(workspace, '.capyra'), configPath: resolve(path), storagePlugin: typeof raw.storagePlugin === 'string' ? raw.storagePlugin : undefined, port, controlPort, exposure: exposure as RuntimeConfig['exposure'], approvalMode, autoResultVisibility, publicUrl: publicUrl as string | undefined, plugins, maxConcurrent: int(raw.maxConcurrent ?? 2, 1, 8, 'maxConcurrent'), maxTasks: int(raw.maxTasks ?? 100, 10, 500, 'maxTasks') };
}
export async function resolvePlugin(entry: PluginEntry): Promise<CapyraPlugin> {
  const module = entry.module ?? `builtin:${entry.id}`;
  switch (module) {
    case 'builtin:workspace': return (await import('./plugins/workspace.js')).default;
    case 'builtin:process': return (await import('./plugins/process.js')).default;
    case 'builtin:projects': return (await import('./plugins/projects.js')).default;
    case 'builtin:skills': return (await import('./plugins/skills.js')).default;
    case 'builtin:git': return (await import('./plugins/git.js')).default;
    case 'builtin:terminal': return (await import('./plugins/terminal.js')).default;
    case 'builtin:agents': return (await import('./plugins/agents.js')).default;
    case 'builtin:computer': return (await import('./plugins/computer.js')).default;
    case 'builtin:plugin-dev': return (await import('./plugins/plugin-dev.js')).default;
    case 'builtin:identity': return (await import('./plugins/identity.js')).default;
    case 'builtin:connection': return (await import('./plugins/connection.js')).default;
    case 'builtin:storage': return (await import('./plugins/storage.js')).default;
    case 'builtin:policy': return (await import('./plugins/policy.js')).default;
    case 'builtin:presentation': return (await import('./plugins/presentation.js')).default;
    case 'builtin:ui': return (await import('./plugins/ui.js')).default;
    case 'builtin:console': return (await import('./plugins/console.js')).default;
    case 'builtin:mcp': return (await import('./plugins/mcp.js')).default;
    case 'builtin:client-ui': return (await import('./plugins/client-ui.js')).default;
    case 'mcp': return (await import('./plugins/upstream.js')).createUpstreamPlugin(entry.id);
    default: {
      if (!isAbsolute(module)) throw new Error('原生插件 module 必须是本地路径');
      if (entry.manifest) {
        const { validatePluginProject } = await import('./plugin-devkit.js');
        const report = await validatePluginProject(dirname(entry.manifest));
        if (!report.ok || report.entryPath !== module || report.manifest?.id !== entry.id) throw new Error(`插件 manifest 预检失败：${report.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
        // 先在隔离预检后校验配置；错误配置不会把第三方入口加载进宿主进程。
        const validateConfig = new Ajv2020({ allErrors: true, strict: false }).compile(report.manifest.configSchema);
        if (!validateConfig(entry.config ?? {})) throw new Error(`插件配置不符合 manifest：${(validateConfig.errors ?? []).map(error => `${error.instancePath || '/'} ${error.keyword}`).join(', ')}`);
      }
      const definition = (await import(pathToFileURL(module).href)).default;
      return definition as CapyraPlugin;
    }
  }
}
/** 控制台改动原子持久化；保留用户配置中宿主不认识的字段。 */
export function configWriter(path: string) {
  let queue = Promise.resolve();
  return (config: RuntimeConfig): Promise<void> => {
    const operation = queue.then(async () => {
      let raw: Record<string, unknown> = {};
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('配置文件必须为普通独立文件');
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const value = { ...raw, version: 1, workspace: config.workspace, port: config.port, controlPort: config.controlPort, exposure: config.exposure, approvalMode: config.approvalMode ?? 'auto', autoResultVisibility: config.autoResultVisibility ?? 'client', publicUrl: config.publicUrl, storagePlugin: config.storagePlugin, plugins: config.plugins, maxConcurrent: config.maxConcurrent, maxTasks: config.maxTasks };
      const temporary = resolve(dirname(path), `.capyra-config-${randomUUID()}.tmp`);
      await mkdir(dirname(path), { recursive: true });
      try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    queue = operation.catch(() => {});
    return operation;
  };
}
function int(value: unknown, min: number, max: number, name: string): number {
  const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须在 ${min}–${max} 之间`); return n;
}
