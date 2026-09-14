import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CapyraPlugin, PluginEntry, RuntimeConfig } from '../core/types.js';
import { createPluginProject, pluginDevelopmentPrompt, pluginAuthoringSpec, validatePluginProject } from '../plugin-devkit.js';
import { readHostUpdateStatus, scheduleHostUpdate } from '../host-update.js';
import { isBlockedName, stringArg, workspacePath } from './workspace-paths.js';
import { textResult } from '../sdk.js';

interface PluginHost {
  config: RuntimeConfig;
  installPlugin(entry: PluginEntry): Promise<void>;
  configurePlugin(id: string, config: Record<string, unknown>, grants?: string[]): Promise<void>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
}

const protectedHostPlugins = new Set(['storage', 'policy', 'projects', 'workspace', 'skills', 'git', 'process', 'terminal', 'agents', 'plugin-dev', 'identity', 'connection', 'presentation', 'ui', 'mcp', 'client-ui', 'console']);

async function draftRoot(workspace: string, input: string, id: string): Promise<{ absolute: string; relative: string }> {
  const name = input || `capyra-plugins/${id}`;
  if (name.length > 1024 || name.includes('\0') || name.includes('\\') || path.isAbsolute(name) || path.win32.isAbsolute(name)) throw new Error('开发目录必须是当前工作区内的相对路径');
  const segments = name.split('/').filter(segment => segment && segment !== '.');
  if (!segments.length || segments.some(segment => segment === '..' || isBlockedName(segment))) throw new Error('开发目录包含受保护的路径');
  const root = await realpath(workspace);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('开发目录的父路径必须是真实目录');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(parent, { mode: 0o700 });
    }
  }
  const absolute = path.join(root, ...segments);
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
}

const plugin: CapyraPlugin = {
  apiVersion: 1,
  id: 'plugin-dev',
  version: '0.2.1',
  title: 'AI 插件开发台',
  description: '让 ChatGPT 或编码 AI 创建标准插件项目，并提供机器契约、隔离预检和受控安装。',
  permissions: ['plugin:read', 'plugin:write', 'plugin:execute', 'host:update'],
  instructions: 'When the user wants to create a Capyra plugin, read plugin-dev spec and create a draft. Implement it directly with Capyra workspace tools in this conversation, or delegate to a coding agent only when the user asks or that clearly helps. Validate the finished draft. When the user asks to install or use the result, complete the approved install and enable flow with plugin-dev tools instead of asking them to run terminal commands. Supply grants and enable=true only when the user requested those capabilities; every change still passes through the configured local approval policy. Use install_builtin for a bundled optional capability such as computer, and manage for an already installed optional plugin. Core host plugins cannot be managed from this MCP surface.',
  setup(context) {
    context.registerTool({
      name: 'spec', title: '读取插件开发规范', description: 'Return the complete machine-readable Capyra plugin authoring contract without reading workspace data.',
      publicCatalog: true, effect: 'read', permissions: ['plugin:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return textResult(pluginAuthoringSpec); },
    });
    context.registerTool({
      name: 'create', title: '创建 AI 插件草稿', description: 'Create a new manifest-based plugin project inside the current workspace. Existing files are never overwritten.',
      effect: 'write', permissions: ['plugin:write'], inputSchema: { type: 'object', properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 2000 }, brief: { type: 'string', minLength: 1, maxLength: 12000 },
        directory: { type: 'string', minLength: 1, maxLength: 1024 },
      }, required: ['id', 'title', 'description', 'brief'], additionalProperties: false },
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const id = stringArg(args, 'id');
        const target = await draftRoot(execution.workspace, args.directory === undefined ? '' : stringArg(args, 'directory'), id);
        const created = await createPluginProject({ rootDirectory: target.absolute, id, title: stringArg(args, 'title'), description: stringArg(args, 'description'), brief: stringArg(args, 'brief') });
        execution.signal.throwIfAborted();
        return textResult({ path: target.relative, manifest: created.manifest, developmentPrompt: pluginDevelopmentPrompt(target.relative), installed: false, enabled: false });
      },
    });
    context.registerTool({
      name: 'validate', title: '预检插件草稿', description: 'Validate a plugin project inside the current workspace. The entry module is imported in a bounded child process, so treat this as code execution.',
      effect: 'execute', permissions: ['plugin:execute'], inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } }, required: ['path'], additionalProperties: false },
      async execute(args, execution) {
        const target = await workspacePath(execution.workspace, stringArg(args, 'path'));
        execution.signal.throwIfAborted();
        return textResult(await validatePluginProject(target));
      },
    });
    context.registerTool({
      name: 'install', title: '安装已验证插件', description: 'Validate and add a workspace plugin to Capyra. Only explicitly supplied declared grants are stored; enable it immediately only when the user requested enable=true.',
      effect: 'execute', permissions: ['plugin:execute'], inputSchema: { type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 }, grants: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
        config: { type: 'object', additionalProperties: true }, enable: { type: 'boolean', default: false },
      }, required: ['path'], additionalProperties: false },
      async preview(args) {
        return { title: args.enable === true ? 'Install and enable a Capyra plugin' : 'Install a Capyra plugin', description: `Plugin path: ${String(args.path)}\nGrants: ${JSON.stringify(args.grants ?? [])}\nEnable now: ${args.enable === true}` };
      },
      async execute(args, execution) {
        const target = await workspacePath(execution.workspace, stringArg(args, 'path'));
        const report = await validatePluginProject(target);
        execution.signal.throwIfAborted();
        if (!report.ok || !report.entryPath || !report.plugin?.id) throw new Error(`插件预检失败：${report.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
        const grants = args.grants ?? [];
        if (!Array.isArray(grants) || grants.some(permission => typeof permission !== 'string' || !report.plugin!.permissions.includes(permission))) throw new Error('只能授予插件已经声明的权限');
        const host = context.service<PluginHost>('host.runtime');
        await host.installPlugin({ id: report.plugin.id, module: report.entryPath, ...(report.manifestPath ? { manifest: report.manifestPath } : {}), requestedPermissions: report.plugin.permissions, enabled: false, grants: [...grants], config: (args.config ?? {}) as Record<string, unknown> });
        if (args.enable === true) await host.setPluginEnabled(report.plugin.id, true);
        return textResult({ id: report.plugin.id, installed: true, enabled: args.enable === true, requestedPermissions: report.plugin.permissions, grants });
      },
    });
    context.registerTool({
      name: 'install_builtin', title: '安装内置可选能力', description: 'Install the named optional capability bundled with this Capyra version, apply only explicitly requested grants, and optionally enable it immediately. This is for capabilities already present in the running host, not for updating host source code.',
      effect: 'execute', permissions: ['plugin:execute'], inputSchema: { type: 'object', properties: {
        id: { type: 'string', enum: ['computer'] },
        grants: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
        enable: { type: 'boolean', default: true },
      }, required: ['id', 'grants'], additionalProperties: false },
      async preview(args) {
        return { title: 'Install an optional built-in capability', description: `Capability: ${String(args.id)}\nGrants: ${JSON.stringify(args.grants)}\nEnable now: ${args.enable !== false}` };
      },
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const id = stringArg(args, 'id');
        if (id !== 'computer') throw new Error('当前版本没有这个可安装的内置可选能力');
        const grants = args.grants;
        if (!Array.isArray(grants) || grants.some(permission => typeof permission !== 'string')) throw new Error('grants 必须是权限字符串数组');
        const host = context.service<PluginHost>('host.runtime');
        const existing = host.config.plugins.find(entry => entry.id === id);
        if (!existing) await host.installPlugin({ id, module: `builtin:${id}`, enabled: false, grants: [...grants], config: { approvalMode: 'inherit' } });
        else {
          if (existing.module && existing.module !== `builtin:${id}`) throw new Error('同名插件已经指向其他模块，不能替换');
          await host.configurePlugin(id, existing.config ?? {}, [...grants]);
        }
        if (args.enable !== false && !host.config.plugins.find(entry => entry.id === id)?.enabled) await host.setPluginEnabled(id, true);
        return textResult({ id, installed: true, enabled: host.config.plugins.find(entry => entry.id === id)?.enabled === true, grants });
      },
    });
    context.registerTool({
      name: 'manage', title: '管理已安装的可选插件', description: 'Update grants/config and enable or disable an installed optional or external plugin. Core host plugins and plugin-dev itself cannot be changed through this tool.',
      effect: 'execute', permissions: ['plugin:execute'], inputSchema: { type: 'object', properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, enabled: { type: 'boolean' },
        grants: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
        config: { type: 'object', additionalProperties: true },
      }, required: ['id', 'enabled'], additionalProperties: false },
      async preview(args) {
        return { title: 'Manage an installed Capyra plugin', description: `Plugin: ${String(args.id)}\nEnabled: ${String(args.enabled)}\nGrants: ${args.grants === undefined ? 'preserve current grants' : JSON.stringify(args.grants)}\nConfig: ${args.config === undefined ? 'preserve current config' : 'replace with the reviewed object'}` };
      },
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const id = stringArg(args, 'id'), host = context.service<PluginHost>('host.runtime');
        if (protectedHostPlugins.has(id)) throw new Error('核心宿主插件不能通过远程插件管理工具修改');
        const entry = host.config.plugins.find(item => item.id === id);
        if (!entry) throw new Error('插件尚未安装');
        const grants = args.grants === undefined ? undefined : args.grants;
        if (grants !== undefined && (!Array.isArray(grants) || grants.some(permission => typeof permission !== 'string'))) throw new Error('grants 必须是权限字符串数组');
        if (args.config !== undefined || grants !== undefined) await host.configurePlugin(id, (args.config ?? entry.config ?? {}) as Record<string, unknown>, grants as string[] | undefined);
        const desired = args.enabled === true;
        if (host.config.plugins.find(item => item.id === id)?.enabled !== desired) await host.setPluginEnabled(id, desired);
        return textResult({ id, installed: true, enabled: desired, grants: host.config.plugins.find(item => item.id === id)?.grants ?? [] });
      },
    });
    context.registerTool({
      name: 'host_update', title: '安装并重启 Capyra 宿主', description: 'Install an already built local Capyra .tgz whose exact SHA-256 is supplied, then restart the same global Capyra instance. Runs in a detached updater, preserves the fixed MCP configuration, and restores the previous package if installation fails. The MCP connection will briefly disconnect.',
      effect: 'execute', permissions: ['host:update'], clientCatalog: true, alwaysConfirm: true,
      inputSchema: { type: 'object', properties: {
        packagePath: { type: 'string', minLength: 1, maxLength: 1024, description: 'Workspace-relative path to the reviewed local .tgz.' },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedVersion: { type: 'string', pattern: '^0\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$' },
      }, required: ['packagePath', 'expectedSha256'], additionalProperties: false },
      async preview(args) {
        return { title: 'Update and restart the Capyra host', description: `Package: ${String(args.packagePath)}\nExpected SHA-256: ${String(args.expectedSha256)}\nExpected version: ${String(args.expectedVersion ?? 'read from package')}\n\nThe current MCP connection will close briefly. The updater backs up the installed package, installs this exact archive, restarts the same command, and restores the previous package if installation fails.` };
      },
      async execute(args, execution) {
        const packagePath = await workspacePath(execution.workspace, stringArg(args, 'packagePath'));
        execution.signal.throwIfAborted();
        return textResult(await scheduleHostUpdate({ workspace: execution.workspace, stateDir: context.stateDir, packagePath, expectedSha256: stringArg(args, 'expectedSha256'), expectedVersion: args.expectedVersion as string | undefined, signal: execution.signal }));
      },
    });
    context.registerTool({
      name: 'host_update_status', title: '读取 Capyra 宿主更新状态', description: 'Read the latest local self-update status after the fixed MCP connection returns. Does not return updater logs or package contents.',
      effect: 'read', permissions: ['host:update'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return textResult(await readHostUpdateStatus(context.stateDir)); },
    });
  },
};

export default plugin;
