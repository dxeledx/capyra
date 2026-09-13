import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

export const PLUGIN_MANIFEST_FILENAME = 'capyra.plugin.json';

export interface PluginManifestV1 {
  schemaVersion: 1;
  apiVersion: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  entry: string;
  permissions: string[];
  requires: string[];
  configSchema: Record<string, unknown>;
  ai?: { brief: string };
}

export interface PluginDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  file?: string;
  jsonPointer?: string;
  message: string;
  hint?: string;
}

export interface PluginValidationReport {
  ok: boolean;
  kind: 'project' | 'legacy';
  projectPath: string;
  manifestPath?: string;
  entryPath?: string;
  manifest?: PluginManifestV1;
  plugin?: {
    apiVersion?: number;
    id?: string;
    version?: string;
    title?: string;
    description?: string;
    permissions: string[];
    requires: string[];
    hasSetup: boolean;
    hasCreateStore: boolean;
  };
  diagnostics: PluginDiagnostic[];
}

export interface CreatePluginProjectInput {
  rootDirectory: string;
  id: string;
  title: string;
  description: string;
  brief?: string;
}

export interface CreatedPluginProject {
  rootDirectory: string;
  manifest: PluginManifestV1;
  files: string[];
}

const idPattern = '^[a-z][a-z0-9-]{0,31}$';
const versionPattern = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
const entryPattern = '^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*//)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\\.(?:mjs|js)$';

export const pluginManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://capyra.local/schemas/capyra-plugin.schema.json',
  title: 'Capyra Plugin Manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'apiVersion', 'id', 'version', 'title', 'description', 'entry', 'permissions', 'requires', 'configSchema'],
  properties: {
    schemaVersion: { const: 1 },
    apiVersion: { const: 1 },
    id: { type: 'string', pattern: idPattern },
    version: { type: 'string', pattern: versionPattern },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    entry: { type: 'string', minLength: 1, maxLength: 240, pattern: entryPattern },
    permissions: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    requires: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: idPattern } },
    configSchema: { type: 'object' },
    ai: { type: 'object', additionalProperties: false, required: ['brief'], properties: { brief: { type: 'string', minLength: 1, maxLength: 12000 } } },
  },
} as const;

/**
 * 这份对象只包含稳定的公开契约，CLI 和编码代理可以直接消费，不必从说明文档猜测字段。
 * commands 保留占位符，调用方可以按自己的工作目录和插件 ID 生成实际命令。
 */
export const pluginAuthoringSpec = {
  specVersion: 1,
  pluginApiVersion: 1,
  manifest: {
    filename: PLUGIN_MANIFEST_FILENAME,
    schema: 'schemas/capyra-plugin.schema.json',
    authority: 'Manifest metadata and the module default export must agree. Secrets and grants do not belong in the manifest.',
  },
  definition: {
    required: ['apiVersion', 'id', 'version', 'title', 'description', 'permissions', 'setup'],
    optional: ['requires', 'instructions', 'createStore'],
    module: 'Native ESM with one default plugin export.',
  },
  contextMethods: {
    registerTool: 'Register one tool and retain the returned disposer only when manual early removal is needed.',
    provide: 'Provide a uniquely named service for enabled dependants.',
    service: 'Read a service from an enabled dependency; declare the provider in requires.',
    guard: 'Add a policy that may only narrow access.',
    onEvent: 'Observe runtime events. The host unregisters the listener during disposal.',
    emit: 'Publish a non-sensitive runtime event when available.',
    onDispose: 'Close every timer, process, socket, watcher, and other owned resource.',
  },
  tool: {
    required: ['name', 'title', 'description', 'inputSchema', 'effect', 'permissions', 'execute'],
    namePattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$',
    effects: ['read', 'write', 'execute'],
    inputSchema: 'Synchronous JSON Schema for an object. Draft 2020-12 is the default; draft-07 is supported; $async is forbidden.',
    result: 'Return an MCP CallToolResult. Use isError: true for an unsuccessful tool result.',
    preview: 'Must be read-only, bounded, and cancellation-aware.',
  },
  constraints: {
    encodedInputBytes: 2_000_000,
    encodedResultBytes: 2_000_000,
    defaultTimeoutMs: 60_000,
    cancellation: 'Propagate ToolContext.signal and stop owned work before execute or preview settles.',
    lifecycle: 'Register cleanup with onDispose. A plugin may be disabled or reloaded while the process remains alive.',
    permissions: 'A tool permission must be declared by the plugin. Only the local owner grants permissions; plugin code must never grant itself access.',
    secrets: 'Read credentials from local configuration at runtime. Never write credentials into source, manifest, fixtures, logs, or diagnostics.',
  },
  commands: {
    create: 'capyra plugin create <id> --title <title> --description <description> --dir <directory> --json',
    spec: 'capyra plugin spec --json',
    validate: 'capyra plugin validate <plugin-directory> --json',
    install: 'capyra plugin install <plugin-directory>',
    inspect: 'capyra plugin inspect <id> --json',
  },
} as const;

export function pluginDevelopmentPrompt(directory: string): string {
  return `在 ${directory} 中完成 Capyra 插件。你可以在当前 ChatGPT 对话中直接使用 Capyra 文件工具开发，无需另开编码代理。先读取 AGENTS.md 和 capyra.plugin.json，再读取 plugin-dev__spec 或运行 capyra plugin spec --json。根据 manifest 的 ai.brief 实现需求；每轮修改后调用 plugin-dev__validate 或运行 capyra plugin validate . --json，修复所有 error。不要安装、启用插件或自行授予权限，不要写入任何凭据。完成时说明实现内容、校验结果和建议授予的最小权限。`;
}

function diagnostic(code: string, message: string, options: Omit<PluginDiagnostic, 'code' | 'message' | 'severity'> & { severity?: PluginDiagnostic['severity'] } = {}): PluginDiagnostic {
  const { severity = 'error', ...rest } = options;
  return { severity, code, message, ...rest };
}

function assertAuthoringText(value: string, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name} 必须是 1–${maximum} 个字符的非空文本`);
  return value.trim();
}

function starterModule(manifest: PluginManifestV1): string {
  const instructions = manifest.ai?.brief
    ? `Follow the plugin brief while using ${manifest.id}__run: ${manifest.ai.brief}`
    : `Use ${manifest.id}__run when the user asks to run this plugin.`;
  return `// 这个入口保持零依赖，便于先验证完整的插件加载和调用链。\nexport default {\n  apiVersion: 1,\n  id: ${JSON.stringify(manifest.id)},\n  version: ${JSON.stringify(manifest.version)},\n  title: ${JSON.stringify(manifest.title)},\n  description: ${JSON.stringify(manifest.description)},\n  permissions: [],\n  requires: [],\n  instructions: ${JSON.stringify(instructions)},\n  setup(context) {\n    context.registerTool({\n      name: 'run',\n      title: ${JSON.stringify(manifest.title)},\n      description: ${JSON.stringify(manifest.description)},\n      effect: 'read',\n      permissions: [],\n      inputSchema: {\n        type: 'object',\n        properties: { message: { type: 'string', maxLength: 10000 } },\n        required: ['message'],\n        additionalProperties: false,\n      },\n      async execute({ message }, execution) {\n        execution.signal.throwIfAborted();\n        return {\n          content: [{ type: 'text', text: message }],\n          structuredContent: { message },\n        };\n      },\n    });\n  },\n};\n`;
}

function authoringInstructions(manifest: PluginManifestV1): string {
  return `# ${manifest.title} 插件开发约束\n\n在修改代码前，先读取 \`${PLUGIN_MANIFEST_FILENAME}\` 中的 \`ai.brief\`，再通过 \`plugin-dev__spec\` 或 \`capyra plugin spec --json\` 读取当前机器可用的插件契约。ChatGPT 可以直接使用 Capyra 的工作区工具完成开发；编码代理不是必需步骤。\n\n- 保持 manifest 与 \`${manifest.entry}\` 默认导出的 ID、版本、标题、描述、permissions 和 requires 一致。\n- 每次修改后调用 \`plugin-dev__validate\` 或运行 \`capyra plugin validate . --json\`，根据结构化 diagnostic 的 code、file 和 jsonPointer 修正问题。\n- 所有工具都要传播 \`execution.signal\`；preview 只读且有界。\n- 定时器、进程、socket、watcher 等资源必须通过 \`context.onDispose\` 完整关闭。\n- 插件只能声明所需权限，不能自行授予 grant，也不能修改 Capyra 配置来启用自己。\n- 不把令牌、密码、cookie、私钥或其他凭据写入源码、manifest、测试数据、日志与诊断。运行凭据只从本机插件配置读取。\n- 完成后保留插件为未安装或未启用状态，由本机用户检查权限并决定安装和启用。\n`;
}

function projectReadme(manifest: PluginManifestV1): string {
  return `# ${manifest.title}\n\n${manifest.description}\n\n## 开发\n\n插件需求位于 \`${PLUGIN_MANIFEST_FILENAME}\` 的 \`ai.brief\`。先读取机器契约，再校验项目：\n\n\`\`\`sh\ncapyra plugin spec --json\ncapyra plugin validate . --json\n\`\`\`\n\n校验通过后，由本机用户安装、核对权限并启用：\n\n\`\`\`sh\ncapyra plugin install .\ncapyra plugin enable ${manifest.id}\n\`\`\`\n`;
}

/** 创建一个可立即加载的零依赖插件项目；任何已存在内容都会使创建失败。 */
export async function createPluginProject(input: CreatePluginProjectInput): Promise<CreatedPluginProject> {
  if (!new RegExp(idPattern).test(input.id)) throw new Error('插件 ID 必须以小写字母开头，只包含小写字母、数字和连字符，最长 32 个字符');
  const title = assertAuthoringText(input.title, 'title', 120);
  const description = assertAuthoringText(input.description, 'description', 2000);
  const brief = input.brief === undefined ? undefined : assertAuthoringText(input.brief, 'brief', 12000);
  const rootDirectory = resolve(input.rootDirectory);
  let createdRoot = false;
  const createdFiles: string[] = [];
  try {
    await mkdir(dirname(rootDirectory), { recursive: true, mode: 0o700 });
    try {
      await mkdir(rootDirectory, { mode: 0o700 });
      createdRoot = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(rootDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('插件目标必须是普通目录，不能是文件或符号链接');
      if ((await readdir(rootDirectory)).length) throw new Error('插件目标目录不是空目录；请选择新目录，现有文件不会被覆盖');
    }
    const rootInfo = await lstat(rootDirectory);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('插件目标必须是普通目录，不能是符号链接');
    const manifest: PluginManifestV1 = {
      schemaVersion: 1,
      apiVersion: 1,
      id: input.id,
      version: '0.1.0',
      title,
      description,
      entry: 'index.mjs',
      permissions: [],
      requires: [],
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      ...(brief ? { ai: { brief } } : {}),
    };
    const files = new Map<string, string>([
      [PLUGIN_MANIFEST_FILENAME, JSON.stringify(manifest, null, 2) + '\n'],
      ['index.mjs', starterModule(manifest)],
      ['AGENTS.md', authoringInstructions(manifest)],
      ['README.md', projectReadme(manifest)],
      ['package.json', JSON.stringify({ name: `capyra-plugin-${manifest.id}`, version: manifest.version, private: true, type: 'module' }, null, 2) + '\n'],
      ['.gitignore', 'node_modules/\n.env\n.env.*\n*.log\n'],
    ]);
    for (const [name, content] of files) {
      const path = resolve(rootDirectory, name);
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      createdFiles.push(path);
    }
    return { rootDirectory, manifest, files: [...createdFiles] };
  } catch (error) {
    for (const path of createdFiles.reverse()) await unlink(path).catch(() => {});
    if (createdRoot) await rmdir(rootDirectory).catch(() => {});
    throw error;
  }
}

interface PluginProbe {
  status: 'ok' | 'error';
  plugin?: PluginValidationReport['plugin'];
  issues?: Array<{ code: string; field?: string }>;
  error?: { name?: string; code?: string };
}

const importProbeSource = String.raw`
const emit = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
console.log = console.info = console.warn = console.error = () => {};
const issues = [];
const issue = (code, field) => issues.push({ code, field });
const text = (plugin, field, maximum) => {
  let value;
  try { value = plugin?.[field]; } catch { issue('PLUGIN_FIELD_GETTER_FAILED', field); return undefined; }
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) { issue('PLUGIN_FIELD_INVALID', field); return undefined; }
  return value;
};
const strings = (plugin, field, optional = false) => {
  let value;
  try { value = plugin?.[field]; } catch { issue('PLUGIN_FIELD_GETTER_FAILED', field); return []; }
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || !item || item.length > 128)) { issue('PLUGIN_FIELD_INVALID', field); return []; }
  if (new Set(value).size !== value.length) issue('PLUGIN_FIELD_DUPLICATE', field);
  return value;
};
try {
  const imported = await import(process.argv[1]);
  const plugin = imported?.default;
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) issue('PLUGIN_DEFAULT_EXPORT_INVALID', 'default');
  let apiVersion;
  try { apiVersion = plugin?.apiVersion; } catch { issue('PLUGIN_FIELD_GETTER_FAILED', 'apiVersion'); }
  if (apiVersion !== 1) issue('PLUGIN_API_VERSION_INVALID', 'apiVersion');
  let setup;
  try { setup = plugin?.setup; } catch { issue('PLUGIN_FIELD_GETTER_FAILED', 'setup'); }
  if (typeof setup !== 'function') issue('PLUGIN_SETUP_INVALID', 'setup');
  let createStore;
  try { createStore = plugin?.createStore; } catch { issue('PLUGIN_FIELD_GETTER_FAILED', 'createStore'); }
  if (createStore !== undefined && typeof createStore !== 'function') issue('PLUGIN_CREATE_STORE_INVALID', 'createStore');
  const result = {
    status: 'ok',
    plugin: {
      apiVersion: apiVersion === 1 ? 1 : undefined,
      id: text(plugin, 'id', 32),
      version: text(plugin, 'version', 128),
      title: text(plugin, 'title', 120),
      description: text(plugin, 'description', 2000),
      permissions: strings(plugin, 'permissions'),
      requires: strings(plugin, 'requires', true),
      hasSetup: typeof setup === 'function',
      hasCreateStore: typeof createStore === 'function',
    },
    issues,
  };
  emit(JSON.stringify(result));
  process.exit(0);
} catch (error) {
  emit(JSON.stringify({ status: 'error', error: { name: error?.name, code: typeof error?.code === 'string' ? error.code : undefined } }));
  process.exit(2);
}
`;

async function probePlugin(entryPath: string, cwd: string): Promise<PluginProbe> {
  return new Promise(resolveProbe => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', importProbeSource, pathToFileURL(entryPath).href], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
        CAPYRA_PLUGIN_VALIDATION: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    let exceeded = false;
    const settle = (result: PluginProbe) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ status: 'error', error: { code: 'PLUGIN_IMPORT_TIMEOUT' } });
    }, 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      output.push(chunk);
    });
    // stderr 只计大小而不返回正文，避免插件把源码或凭据混入诊断。
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { exceeded = true; child.kill('SIGKILL'); }
    });
    child.once('error', error => settle({ status: 'error', error: { name: error.name, code: (error as NodeJS.ErrnoException).code } }));
    child.once('close', () => {
      if (finished) return;
      if (exceeded) { settle({ status: 'error', error: { code: 'PLUGIN_IMPORT_OUTPUT_LIMIT' } }); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(output).toString('utf8')) as PluginProbe;
        if (parsed?.status !== 'ok' && parsed?.status !== 'error') throw new Error('invalid probe result');
        settle(parsed);
      } catch {
        settle({ status: 'error', error: { code: 'PLUGIN_IMPORT_NO_RESULT' } });
      }
    });
  });
}

function ajvDiagnostics(errors: ErrorObject[] | null | undefined, file: string): PluginDiagnostic[] {
  return (errors ?? []).map(error => diagnostic('MANIFEST_SCHEMA_INVALID', `插件 manifest 字段不符合规范：${error.keyword}`, {
    file,
    jsonPointer: error.instancePath || '/',
    hint: '运行 capyra plugin spec --json 查看当前 manifest 规范。',
  }));
}

async function safeEntry(root: string, entry: string, diagnostics: PluginDiagnostic[]): Promise<string | undefined> {
  if (isAbsolute(entry) || entry.includes('\\') || entry.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    diagnostics.push(diagnostic('ENTRY_PATH_INVALID', 'entry 必须是插件目录内的普通相对 JavaScript 模块路径。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/entry' }));
    return undefined;
  }
  const candidate = resolve(root, ...entry.split('/'));
  const lexical = relative(root, candidate);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    diagnostics.push(diagnostic('ENTRY_OUTSIDE_PROJECT', 'entry 不能离开插件根目录。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/entry' }));
    return undefined;
  }
  let current = root;
  try {
    for (const segment of entry.split('/')) {
      current = resolve(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        diagnostics.push(diagnostic('ENTRY_SYMLINK_FORBIDDEN', 'entry 路径不能经过符号链接。', { file: entry, hint: '把入口及其父目录保存为插件根内的真实文件和目录。' }));
        return undefined;
      }
    }
    const info = await lstat(candidate);
    if (!info.isFile()) {
      diagnostics.push(diagnostic('ENTRY_NOT_FILE', 'entry 必须指向普通文件。', { file: entry }));
      return undefined;
    }
    if (!['.mjs', '.js'].includes(extname(candidate))) {
      diagnostics.push(diagnostic('ENTRY_EXTENSION_INVALID', 'entry 必须使用 .mjs 或 .js 扩展名。', { file: entry }));
      return undefined;
    }
    const actual = await realpath(candidate);
    const physical = relative(root, actual);
    if (!physical || physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
      diagnostics.push(diagnostic('ENTRY_REALPATH_OUTSIDE_PROJECT', 'entry 的真实路径离开了插件根目录。', { file: entry }));
      return undefined;
    }
    return actual;
  } catch (error) {
    diagnostics.push(diagnostic('ENTRY_UNREADABLE', '无法读取插件 entry。', { file: entry, hint: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '确认 manifest 中的 entry 文件已经生成。' : '检查入口路径和文件权限。' }));
    return undefined;
  }
}

function probeDiagnostics(probe: PluginProbe, file: string): PluginDiagnostic[] {
  if (probe.status === 'error') {
    const code = probe.error?.code ?? 'PLUGIN_IMPORT_FAILED';
    const messages: Record<string, string> = {
      PLUGIN_IMPORT_TIMEOUT: '插件入口导入超过 5 秒。',
      PLUGIN_IMPORT_OUTPUT_LIMIT: '插件入口导入时产生了过多输出。',
      PLUGIN_IMPORT_NO_RESULT: '隔离导入进程没有返回有效结果。',
    };
    return [diagnostic(code, messages[code] ?? `插件入口导入失败${probe.error?.name ? `（${probe.error.name}）` : ''}。`, {
      file,
      hint: '入口模块的顶层代码应快速完成且不启动常驻工作；详细排查请在不含真实凭据的开发环境运行。',
    })];
  }
  return (probe.issues ?? []).map(issue => diagnostic(issue.code, `插件默认导出的 ${issue.field ?? '对象'} 不符合 API v1 契约。`, {
    file,
    jsonPointer: issue.field ? `/${issue.field}` : '/',
    hint: '运行 capyra plugin spec --json 查看必需字段和类型。',
  }));
}

function compareManifest(manifest: PluginManifestV1, plugin: NonNullable<PluginValidationReport['plugin']>, file: string): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  for (const field of ['apiVersion', 'id', 'version', 'title', 'description'] as const) {
    if (plugin[field] !== manifest[field]) diagnostics.push(diagnostic('MANIFEST_EXPORT_MISMATCH', `manifest 与入口默认导出的 ${field} 不一致。`, { file, jsonPointer: `/${field}`, hint: `让 ${PLUGIN_MANIFEST_FILENAME} 与入口模块使用相同的 ${field}。` }));
  }
  for (const field of ['permissions', 'requires'] as const) {
    if (JSON.stringify(plugin[field]) !== JSON.stringify(manifest[field])) diagnostics.push(diagnostic('MANIFEST_EXPORT_MISMATCH', `manifest 与入口默认导出的 ${field} 不一致。`, { file, jsonPointer: `/${field}`, hint: `保持顺序和内容完全一致；grant 由本机用户另行授予。` }));
  }
  return diagnostics;
}

/**
 * 验证目录项目或旧式单文件 .mjs。导入发生在隔离的短生命周期 Node 进程中，setup 不会执行。
 * 报告仅返回元数据和诊断，不回传子进程 stdout、stderr、源码或环境凭据。
 */
export async function validatePluginProject(path: string): Promise<PluginValidationReport> {
  const requested = resolve(path);
  const diagnostics: PluginDiagnostic[] = [];
  let inputInfo;
  try { inputInfo = await lstat(requested); }
  catch {
    return { ok: false, kind: 'project', projectPath: requested, diagnostics: [diagnostic('PLUGIN_PATH_MISSING', '插件路径不存在。', { file: requested })] };
  }
  if (inputInfo.isSymbolicLink()) return { ok: false, kind: 'project', projectPath: requested, diagnostics: [diagnostic('PLUGIN_PATH_SYMLINK_FORBIDDEN', '插件路径不能是符号链接。', { file: requested })] };

  if (inputInfo.isFile()) {
    const report: PluginValidationReport = { ok: false, kind: 'legacy', projectPath: dirname(requested), entryPath: requested, diagnostics };
    if (extname(requested) !== '.mjs') {
      diagnostics.push(diagnostic('LEGACY_EXTENSION_INVALID', '旧式单文件插件必须使用 .mjs 扩展名。', { file: requested }));
      return report;
    }
    diagnostics.push(diagnostic('LEGACY_MANIFEST_MISSING', '旧式单文件插件没有 manifest；可以加载，但无法提供完整的 AI 开发与安装元数据。', { severity: 'warning', file: requested, hint: `为插件创建包含 ${PLUGIN_MANIFEST_FILENAME} 的目录项目。` }));
    const probe = await probePlugin(await realpath(requested), dirname(requested));
    report.plugin = probe.plugin;
    diagnostics.push(...probeDiagnostics(probe, basename(requested)));
    if (probe.plugin?.id && !new RegExp(idPattern).test(probe.plugin.id)) diagnostics.push(diagnostic('PLUGIN_ID_INVALID', '插件默认导出的 id 格式无效。', { file: basename(requested), jsonPointer: '/id' }));
    if (probe.plugin?.version && !new RegExp(versionPattern).test(probe.plugin.version)) diagnostics.push(diagnostic('PLUGIN_VERSION_INVALID', '插件默认导出的 version 不是有效的 SemVer。', { file: basename(requested), jsonPointer: '/version' }));
    report.ok = diagnostics.every(item => item.severity !== 'error');
    return report;
  }

  if (!inputInfo.isDirectory()) return { ok: false, kind: 'project', projectPath: requested, diagnostics: [diagnostic('PLUGIN_PATH_INVALID', '插件路径必须是普通目录或旧式 .mjs 文件。', { file: requested })] };
  const root = await realpath(requested);
  const manifestPath = resolve(root, PLUGIN_MANIFEST_FILENAME);
  const report: PluginValidationReport = { ok: false, kind: 'project', projectPath: root, manifestPath, diagnostics };
  let raw: string;
  try {
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' });
    if (info.size > 1_000_000) {
      diagnostics.push(diagnostic('MANIFEST_TOO_LARGE', '插件 manifest 超过 1 MB。', { file: PLUGIN_MANIFEST_FILENAME }));
      return report;
    }
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    diagnostics.push(diagnostic((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MANIFEST_MISSING' : 'MANIFEST_NOT_REGULAR', `插件目录必须包含普通文件 ${PLUGIN_MANIFEST_FILENAME}，且不能使用符号链接。`, { file: PLUGIN_MANIFEST_FILENAME }));
    return report;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    diagnostics.push(diagnostic('MANIFEST_JSON_INVALID', '插件 manifest 不是有效 JSON。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/' }));
    return report;
  }
  const manifestAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateManifest = manifestAjv.compile(pluginManifestSchema);
  if (!validateManifest(value)) {
    diagnostics.push(...ajvDiagnostics(validateManifest.errors, PLUGIN_MANIFEST_FILENAME));
    return report;
  }
  const manifest = value as PluginManifestV1;
  report.manifest = manifest;
  if (manifest.configSchema.$async) diagnostics.push(diagnostic('CONFIG_SCHEMA_ASYNC_FORBIDDEN', 'configSchema 不能启用异步校验。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/configSchema/$async' }));
  if (manifest.configSchema.type !== 'object') diagnostics.push(diagnostic('CONFIG_SCHEMA_ROOT_INVALID', 'configSchema 必须描述一个 object。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/configSchema/type' }));
  try {
    if (!manifest.configSchema.$async) new Ajv2020({ allErrors: true, strict: false }).compile(manifest.configSchema);
  } catch {
    diagnostics.push(diagnostic('CONFIG_SCHEMA_INVALID', 'configSchema 无法编译。', { file: PLUGIN_MANIFEST_FILENAME, jsonPointer: '/configSchema', hint: '检查 JSON Schema 关键字、引用和正则表达式。' }));
  }
  const entryPath = await safeEntry(root, manifest.entry, diagnostics);
  report.entryPath = entryPath;
  if (entryPath && diagnostics.every(item => item.severity !== 'error')) {
    const probe = await probePlugin(entryPath, root);
    report.plugin = probe.plugin;
    diagnostics.push(...probeDiagnostics(probe, manifest.entry));
    if (probe.plugin) diagnostics.push(...compareManifest(manifest, probe.plugin, manifest.entry));
  }
  report.ok = diagnostics.every(item => item.severity !== 'error');
  return report;
}
