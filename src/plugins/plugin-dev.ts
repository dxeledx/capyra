import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CapyraPlugin, PluginEntry } from '../core/types.js';
import { createPluginProject, pluginDevelopmentPrompt, pluginAuthoringSpec, validatePluginProject } from '../plugin-devkit.js';
import { isBlockedName, stringArg, workspacePath } from './workspace-paths.js';
import { textResult } from '../sdk.js';

interface PluginHost {
  installPlugin(entry: PluginEntry): Promise<void>;
}

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
  version: '0.1.0',
  title: 'AI 插件开发台',
  description: '让 ChatGPT 或编码 AI 创建标准插件项目，并提供机器契约、隔离预检和受控安装。',
  permissions: ['plugin:read', 'plugin:write', 'plugin:execute'],
  instructions: 'When the user wants to create a Capyra plugin, read plugin-dev spec and create a draft. Implement it directly with Capyra workspace tools in this conversation, or delegate to a coding agent only when the user asks or that clearly helps. Validate the finished draft. If the user asks to install it, call plugin-dev install; installation remains disabled and passes through the configured local approval policy. Never choose grants or enable a plugin without the user’s instruction.',
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
      name: 'install', title: '安装已验证插件', description: 'Validate and add a workspace plugin to Capyra in the disabled state. Only explicitly supplied declared grants are stored.',
      effect: 'execute', permissions: ['plugin:execute'], inputSchema: { type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 }, grants: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
        config: { type: 'object', additionalProperties: true },
      }, required: ['path'], additionalProperties: false },
      async execute(args, execution) {
        const target = await workspacePath(execution.workspace, stringArg(args, 'path'));
        const report = await validatePluginProject(target);
        execution.signal.throwIfAborted();
        if (!report.ok || !report.entryPath || !report.plugin?.id) throw new Error(`插件预检失败：${report.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
        const grants = args.grants ?? [];
        if (!Array.isArray(grants) || grants.some(permission => typeof permission !== 'string' || !report.plugin!.permissions.includes(permission))) throw new Error('只能授予插件已经声明的权限');
        const host = context.service<PluginHost>('host.runtime');
        await host.installPlugin({ id: report.plugin.id, module: report.entryPath, ...(report.manifestPath ? { manifest: report.manifestPath } : {}), requestedPermissions: report.plugin.permissions, enabled: false, grants: [...grants], config: (args.config ?? {}) as Record<string, unknown> });
        return textResult({ id: report.plugin.id, installed: true, enabled: false, requestedPermissions: report.plugin.permissions, grants });
      },
    });
  },
};

export default plugin;
