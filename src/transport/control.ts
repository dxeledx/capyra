import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PluginState, RegisteredTool, RuntimeConfig, TaskRecord } from '../core/types.js';
import { createPluginProject, pluginDevelopmentPrompt, pluginAuthoringSpec, validatePluginProject } from '../plugin-devkit.js';

type MaybePromise<T> = T | Promise<T>;

export interface RuntimeLike {
  config: RuntimeConfig;
  listPlugins(): MaybePromise<PluginState[]>;
  listTools(): MaybePromise<RegisteredTool[]>;
  listTasks(owner?: string): MaybePromise<TaskRecord[]>;
  getTask(id: string, owner?: string): MaybePromise<TaskRecord | undefined>;
  submit(name: string, args: Record<string, unknown>, owner: string, workspace?: string, clientSession?: string): MaybePromise<unknown>;
  approveTask(id: string, approve: boolean, visibility?: 'client' | 'local'): MaybePromise<unknown>;
  cancelTask(id: string, owner?: string): MaybePromise<unknown>;
  setPluginEnabled(id: string, enabled: boolean): MaybePromise<unknown>;
  metrics(): MaybePromise<object>;
  hasService?(name: string): boolean;
  service?<T>(name: string): T;
  currentWorkspace?(): string;
  installPlugin?(entry: RuntimeConfig['plugins'][number]): MaybePromise<unknown>;
  configurePlugin?(id: string, config: Record<string, unknown>, grants?: string[]): MaybePromise<unknown>;
  configureApprovalSettings?(settings: { approvalMode: 'ask' | 'auto'; autoResultVisibility: 'local' | 'client' }): MaybePromise<unknown>;
  pause?(paused: boolean): MaybePromise<unknown>;
  waitTask?(id: string, timeoutMs: number): MaybePromise<unknown>;
  preparePreview?(id: string): MaybePromise<TaskRecord>;
}

export interface ControlOAuth {
  pending(): MaybePromise<Array<{ id: string; clientName: string; redirectUri: string; createdAt: string; verificationCode?: string }>>;
  decide(id: string, approve: boolean, label?: string): MaybePromise<unknown>;
  setLabel?(id: string, label?: string): MaybePromise<unknown>;
  setPaused?(id: string, paused: boolean): MaybePromise<unknown>;
  revoke(id?: string): MaybePromise<unknown>;
  grants?(): MaybePromise<unknown>;
}
interface AccessController {
  pending(): unknown[];
  decide(id: string, allow: boolean, visibility?: 'client' | 'local'): MaybePromise<unknown>;
  pause?(paused: boolean): MaybePromise<unknown>;
}
type Service = Record<string, (...args: any[]) => any>;
function agentInWorkspace(record: { workspace?: string; cwd?: string }, workspace: string, workspaceRoot: string) {
  if (record.workspace !== workspace || typeof record.cwd !== 'string') return false;
  const directory = relative(workspaceRoot, resolve(record.cwd));
  return !isAbsolute(directory) && directory !== '..' && !directory.startsWith(`..${sep}`);
}
export interface ControlOptions {
  mcpUrl?: string; publicUrl?: string; localMcpUrl?: string; access?: AccessController;
  onPause?(paused: boolean): MaybePromise<unknown>;
  onOpen?(url: string): MaybePromise<unknown>;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    throw new RequestError(415, '请求必须使用 application/json。');
  }
  if (Number(request.headers['content-length']) > 2_000_000) throw new RequestError(413, '请求内容过大。');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new RequestError(413, '请求内容过大。');
    chunks.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, '请求不是有效的 JSON。'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new RequestError(400, '请求内容必须是对象。');
  return value as Record<string, unknown>;
}

function booleanField(body: Record<string, unknown>, field: string): boolean {
  if (typeof body[field] !== 'boolean') throw new RequestError(400, `${field} 必须是布尔值。`);
  return body[field];
}

interface PickerCommand { file: string; args: string[]; cancelledCodes: number[] }

function pickerCommands(): PickerCommand[] {
  // 浏览器不会向网页暴露所选目录的绝对路径，因此由只监听本机的管理服务调用系统目录面板。
  if (process.platform === 'darwin') return [{
    file: '/usr/bin/osascript',
    args: ['-e', 'POSIX path of (choose folder with prompt "选择要注册到 Capyra 的工作区文件夹")'],
    cancelledCodes: [1],
  }];
  if (process.platform === 'win32') return [{
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object -TypeName System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择要注册到 Capyra 的工作区文件夹'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit 2 }"],
    cancelledCodes: [2],
  }];
  if (process.platform === 'linux') return [
    { file: 'zenity', args: ['--file-selection', '--directory', '--title=选择要注册到 Capyra 的工作区文件夹'], cancelledCodes: [1] },
    { file: 'kdialog', args: ['--title', 'Capyra', '--getexistingdirectory', process.env.HOME ?? '.'], cancelledCodes: [1] },
  ];
  return [];
}

function executePicker(command: PickerCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 16_384, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout.trim()); return; }
      const code = typeof error.code === 'number' ? error.code : undefined;
      if (code !== undefined && command.cancelledCodes.includes(code)) { resolve(''); return; }
      reject(Object.assign(error, { pickerStderr: stderr }));
    });
  });
}

async function pickWorkspaceDirectory(): Promise<{ path?: string; cancelled?: true }> {
  const commands = pickerCommands();
  if (!commands.length) throw new RequestError(501, '当前系统暂不支持文件夹选择器，请粘贴目录的绝对路径。');
  let unavailable = true;
  for (const command of commands) {
    try {
      const selected = await executePicker(command);
      if (!selected) return { cancelled: true };
      // 只把规范化后的现有目录交给工作区注册流程，避免信任选择器返回的原始文本。
      const path = await realpath(selected);
      const info = await lstat(path);
      if (!info.isDirectory()) throw new RequestError(400, '选择的路径不是文件夹。');
      return { path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      unavailable = false;
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '文件夹选择已超时，请重新选择。' : '无法打开文件夹选择器，请粘贴目录的绝对路径。');
    }
  }
  if (unavailable) throw new RequestError(501, '系统没有可用的文件夹选择器，请安装 Zenity 或 KDialog，或粘贴目录的绝对路径。');
  throw new RequestError(400, '无法打开文件夹选择器，请粘贴目录的绝对路径。');
}

function authorizationOrigins(publicUrl?: string, localMcpUrl?: string) {
  try {
    const remote = new URL(publicUrl ?? ''), local = new URL(localMcpUrl ?? '');
    if (remote.protocol !== 'https:' || remote.username || remote.password || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(remote.pathname) || remote.search || remote.hash
      || local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password || local.pathname !== '/mcp' || local.search || local.hash) throw new Error('Invalid authorization endpoints');
    const prefix = remote.pathname.replace(/\/$/, '');
    return { publicOrigin: remote.origin, authorizePath: `${prefix}/authorize`, localOrigin: local.origin, resource: `${remote.origin}${prefix}/mcp` };
  } catch { throw new RequestError(409, '当前公网 MCP 与本机 HTTP 入口尚未准备好，请先建立连接。'); }
}
function localAuthorizationUrl(value: unknown, publicUrl?: string, localMcpUrl?: string): string {
  const endpoints = authorizationOrigins(publicUrl, localMcpUrl);
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16_384) throw new RequestError(400, '请粘贴当前连接的完整 HTTPS /authorize 授权链接。');
  const source = value.trim(), match = source.match(/^https:\/\/([^/?#]+)(\/[^?#]*)(\?[^#]*)?$/i);
  if (!match || /[\u0000-\u0020\u007f\\]/.test(source) || match[1].includes('@')) throw new RequestError(400, '授权链接不能包含其他路径、用户信息或片段。');
  let request: URL;
  try { request = new URL(source); } catch { throw new RequestError(400, '授权链接格式无效。'); }
  if (request.origin !== endpoints.publicOrigin || match[2] !== endpoints.authorizePath || request.pathname !== endpoints.authorizePath || request.username || request.password || request.hash) throw new RequestError(400, '授权链接不属于当前公网连接，请在 ChatGPT 中重新 Connect 并复制新链接。');
  if (request.searchParams.getAll('resource').some(resource => resource !== endpoints.resource)) throw new RequestError(400, '授权链接的 resource 必须保持为当前公网 MCP 地址。');
  // 仅将已核验的公网授权路径映射到本机路由；query原始编码和次序全部保留。
  // 本机URL继续进入同一个SDK OAuth控制器，仍需本机批准且兑换时验证公网resource和PKCE。
  return `${endpoints.localOrigin}/authorize${match[3] ?? ''}`;
}

/** 本机管理入口与公开 MCP 入口分开监听，隧道只能转发 MCP 端口。 */
export async function startControl(
  runtime: RuntimeLike,
  config: RuntimeConfig,
  oauth: ControlOAuth,
  extra: ControlOptions = {},
): Promise<{ url: string; openUrl: string; close(): Promise<void> }> {
  let bootstrap = randomBytes(32).toString('base64url');
  const localSession = randomBytes(32).toString('base64url');
  let lastOpen = 0;
  const matches = (left: string, right: string) => Boolean(left) && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
  const getService = (name: string): Service | undefined => runtime.hasService?.(name) ? runtime.service!<Service>(name) : undefined;
  const pluginDraftLocation = async (value: unknown, id: string) => {
    const input = typeof value === 'string' && value.trim() ? value.trim() : `capyra-plugins/${id}`;
    if (input.length > 1024 || input.includes('\0') || input.includes('\\') || isAbsolute(input)) throw new RequestError(400, '插件开发目录必须是当前工作区内的相对路径。');
    const blocked = new Set(['.git', '.capyra', '.ssh', '.aws', '.azure', '.kube', '.gnupg', 'node_modules']);
    const segments = input.split('/').filter(segment => segment && segment !== '.');
    if (!segments.length || segments.some(segment => segment === '..' || blocked.has(segment.toLowerCase()) || segment.toLowerCase().startsWith('.env'))) throw new RequestError(400, '插件开发目录包含受保护的路径。');
    const workspace = await realpath(runtime.currentWorkspace?.() ?? config.workspace);
    const absolute = resolve(workspace, ...segments);
    const local = relative(workspace, absolute);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new RequestError(400, '插件开发目录必须位于当前工作区内。');
    let current = workspace;
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new RequestError(400, '插件开发目录不能经过符号链接或普通文件。');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    return { absolute, relative: local.split(sep).join('/') };
  };
  const assetNames = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/computer.js', ['computer.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  async function asset(path: string) {
    const item = assetNames.get(path);
    if (!item) return undefined;
    const ui = runtime.hasService?.('ui') ? runtime.service!<{ assetsRoot: URL | string }>('ui') : undefined;
    const root = ui?.assetsRoot ?? new URL('../../public/', import.meta.url);
    const base = typeof root === 'string' ? pathToFileURL(resolve(root) + '/') : root;
    if (base.protocol !== 'file:') throw new Error('界面插件必须提供本机静态文件目录');
    return { contentType: item[1], body: await readFile(new URL(item[0], base)) };
  }
  async function serviceStates() {
    const services: Record<string, unknown> = {};
    const workspace = runtime.currentWorkspace?.() ?? config.workspace;
    for (const name of ['identity', 'connection', 'projects', 'agents.manager', 'process.sessions']) {
      const service = getService(name);
      if (!service) continue;
      try {
        if (name === 'projects') services.projects = { items: service.list(), current: service.current() };
        else if (name === 'process.sessions') {
          const tasks = await runtime.listTasks();
          const owners = [...new Set(['local-console', ...tasks.filter(task => (task.workspace ?? config.workspace) === workspace).map(task => task.owner)])];
          services.process = { sessions: owners.flatMap(owner => service.list(owner, workspace)), terminal: await service.ptyStatus?.() };
        } else if (name === 'agents.manager') { const workspaceRoot = await realpath(workspace); services.agents = { ...await service.catalog(workspace),
          sessions: (await service.listLocal(workspace)).filter((record: { workspace?: string; cwd?: string }) => agentInWorkspace(record, workspace, workspaceRoot)).map((record: Record<string, any>) => ({
            id: record.id, target: record.target, provider: record.provider, status: record.status, writeMode: record.writeMode, updatedAt: record.updatedAt,
            source: record.owner === 'local-console' ? 'local' : 'client', turnCount: record.turns?.length ?? record.turnCount ?? 0,
          })), runtime: await service.status() }; }
        else services[name] = await service.status();
      } catch (error) { services[name === 'process.sessions' ? 'process' : name] = { error: error instanceof Error ? error.message : '服务状态读取失败' }; }
    }
    return services;
  }
  async function serviceAction(name: string, method: string, body: Record<string, unknown>) {
    // 控制台只开放显式管理方法；MCP 从不复用此分发器，也不能调用批准入口。
    const allowed: Record<string, string[]> = {
      identity: ['configure', 'register', 'login', 'logout', 'refreshSession', 'startPairing', 'bind', 'listDevices', 'updateScope', 'revokeDevice', 'refreshBinding', 'unbind'],
      connection: ['configure', 'detect', 'install', 'start', 'stop', 'restart', 'diagnose', 'prepare', 'rotate'],
      projects: ['register', 'select', 'remove'],
      terminal: ['install'],
      process: ['read'],
      agents: ['read', 'continue', 'cancel'],
    };
    if (!allowed[name]?.includes(method)) throw new RequestError(404, '管理操作不存在。');
    if (name === 'agents') {
      const fields = method === 'read' ? ['agentId', 'turnOffset', 'turnLimit', 'outputOffset', 'outputLimit'] : method === 'continue' ? ['agentId', 'prompt'] : ['agentId'];
      if (Object.keys(body).some(key => !fields.includes(key)) || typeof body.agentId !== 'string' || !body.agentId) throw new RequestError(400, '代理操作参数无效。');
      const manager = getService('agents.manager'); if (!manager) throw new Error('编码代理插件未启用');
      const workspace = runtime.currentWorkspace?.() ?? config.workspace;
      const workspaceRoot = await realpath(workspace);
      const record = (await manager.listLocal(workspace)).find((record: { id: string; workspace?: string; cwd?: string }) => record.id === body.agentId && agentInWorkspace(record, workspace, workspaceRoot));
      if (!record) throw new RequestError(404, '当前工作区没有这项代理会话。');
      const current = () => { if ((runtime.currentWorkspace?.() ?? config.workspace) !== workspace) throw new RequestError(409, '工作区已变化，请重新打开这项代理任务。'); };
      current();
      if (method === 'read') { const agent = await manager.getLocal(record.id, workspace, body); current(); return { agent }; }
      // owner 只取已存会话；继续/取消仍走原工具、参数冻结与本机批准，不把管理员身份传给 MCP。
      const args = { agentId: record.id, ...(method === 'continue' ? { prompt: body.prompt } : {}) };
      const task = await runtime.submit(`agents__${method}`, args, record.owner) as TaskRecord;
      await runtime.waitTask?.(task.id, 500);
      return await runtime.getTask(task.id) ?? task;
    }
    if (name === 'process') {
      const sessions = getService('process.sessions'); if (!sessions) throw new Error('进程插件未启用');
      const workspace = runtime.currentWorkspace?.() ?? config.workspace;
      const tasks = await runtime.listTasks();
      const records = sessions.listLocal ? sessions.listLocal(workspace) : [...new Set(['local-console', ...tasks.map(task => task.owner)])].flatMap(owner => sessions.list(owner, workspace));
      const record = records.find((session: { id: string }) => session.id === body.sessionId);
      if (!record) throw new Error('当前工作区没有这项进程会话');
      return sessions.read(record.id, record.owner, record.workspace, { cursor: body.cursor, limit: body.limit, waitMs: body.waitMs }, AbortSignal.timeout(15_000));
    }
    if (name === 'connection' && ['prepare', 'rotate'].includes(method)) {
      const identity = getService('identity'); const connection = getService('connection');
      if (!identity || !connection) throw new Error('请先启用账号与连接插件');
      const provisioned = method === 'rotate' ? await identity.rotateConnection() : await identity.provisionConnection({ mcpPort: config.port });
      await connection.configure({ mode: 'managed', tunnelId: provisioned.tunnelId, publicUrl: provisioned.publicUrl, token: provisioned.token, autoStart: true });
      return connection.start();
    }
    if (name === 'terminal') {
      const sessions = getService('process.sessions');
      if (!sessions?.installPty) throw new Error('交互终端安装尚不可用，请查看插件说明');
      return sessions.installPty();
    }
    const service = getService(name);
    if (!service || typeof service[method] !== 'function') throw new Error('此服务未启用或不支持这项操作');
    if (name === 'projects' && method !== 'register') return service[method](String(body.id ?? ''));
    if (name === 'identity' && method === 'updateScope') return service.updateScope(String(body.deviceId ?? ''), body.scope);
    if (name === 'identity' && method === 'revokeDevice') return service.revokeDevice(String(body.deviceId ?? ''));
    return service[method](body);
  }
  let port = config.controlPort;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    void (async () => {
      const host = request.headers.host;
      const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
      // 不读取 Forwarded/X-Forwarded-*，避免把隧道或外部站点误认成本机。Host 必须包含当前端口。
      if (hostCount !== 1 || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        throw new RequestError(403, '仅允许本机地址访问控制台。');
      }
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) throw new RequestError(403, '不允许跨站访问控制台。');
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      if (path === '/health' && request.method === 'GET') { json(response, 200, { ok: true, service: 'capyra-console' }); return; }
      if (!path.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, '不支持此请求方法。');
        const page = await asset(path);
        if (!page) throw new RequestError(404, '页面不存在。');
        response.writeHead(200, { 'Content-Type': page.contentType });
        response.end(request.method === 'HEAD' ? undefined : page.body);
        return;
      }
      // 自定义请求头阻止第三方网页发送简单请求；不提供 CORS 或预检授权。
      if (request.headers['x-capyra-local'] !== '1' || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
        throw new RequestError(403, '请从本机控制台发起操作。');
      }
      if (path === '/api/bootstrap' && request.method === 'POST') {
        if (origin !== `http://${host}`) throw new RequestError(403, '本机操作需要同源 Origin。');
        const body = await readObject(request);
        if (typeof body.nonce !== 'string' || !matches(body.nonce, bootstrap)) throw new RequestError(403, '启动链接已使用或失效，请重新从 Capyra 启动器打开。');
        bootstrap = '';
        response.setHeader('Set-Cookie', `capyra_local_${port}=${localSession}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { ok: true }); return;
      }
      if (path === '/api/open' && request.method === 'POST') {
        if (origin !== `http://${host}` || !extra.onOpen) throw new RequestError(403, '请从 Capyra 启动器打开工作台。');
        await readObject(request);
        if (Date.now() - lastOpen < 10_000) throw new RequestError(429, '工作台正在打开，请稍候。');
        lastOpen = Date.now(); bootstrap = randomBytes(32).toString('base64url');
        // 启动器只能请宿主打开浏览器，响应不返回可用来批准请求的会话凭据。
        await extra.onOpen(`http://127.0.0.1:${port}/#bootstrap=${bootstrap}`);
        json(response, 200, { ok: true }); return;
      }
      const cookieName = `capyra_local_${port}=`;
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName))?.slice(cookieName.length) ?? '';
      if (!matches(cookie, localSession)) throw new RequestError(401, '请从 Capyra 启动器打开本机工作台。');
      if (request.method === 'GET' && path === '/api/state') {
        const [plugins, tools, tasks, authorizations, metrics, services] = await Promise.all([
          runtime.listPlugins(), runtime.listTools(), runtime.listTasks(), oauth.pending(), runtime.metrics(), serviceStates(),
        ]);
        const publicUrl = extra.publicUrl ?? config.publicUrl;
        let localAuthorizationAvailable = false;
        try { authorizationOrigins(publicUrl, extra.localMcpUrl); localAuthorizationAvailable = true; } catch { /* HTTP或公网入口尚未就绪时不提供备用授权。 */ }
        json(response, 200, {
          config: { workspace: runtime.currentWorkspace?.() ?? config.workspace, exposure: config.exposure, port: config.port, controlPort: port, publicUrl, approvalMode: runtime.config.approvalMode ?? 'auto', autoResultVisibility: runtime.config.autoResultVisibility ?? 'client' },
          plugins,
          tools: tools.map(({ name, title, description, inputSchema, effect, permissions, pluginId }) => ({ name, title, description, inputSchema, effect, permissions, pluginId })),
          // 轮询只发送轻量摘要，文件内容与完整结果在用户打开详情时按需获取。
          tasks: [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(({ id, owner, workspace, resultVisibility, tool, pluginId, effect, status, inputHash, createdAt, updatedAt, expiresAt, progress, error, preview }) => ({
            id, owner, workspace, resultVisibility, tool, pluginId, effect, status, inputHash, createdAt, updatedAt, expiresAt, progress, error,
            ...(status === 'awaiting_approval' ? { preview } : {}),
          })),
          authorizations,
          metrics,
          services, accessRequests: extra.access?.pending() ?? [], grants: await oauth.grants?.() ?? [],
          connection: { mcpUrl: extra.mcpUrl ?? `http://127.0.0.1:${config.port}/mcp`, publicUrl, controlUrl: `http://127.0.0.1:${port}`, localAuthorizationAvailable },
        });
        return;
      }
      if (request.method === 'GET' && path === '/api/plugin-authoring/spec') {
        json(response, 200, pluginAuthoringSpec); return;
      }
      const detailMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === 'GET' && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        let task = await runtime.getTask(id);
        if (!task) throw new RequestError(404, '任务记录不存在。');
        if (task.status === 'awaiting_approval') task = await runtime.preparePreview?.(id) ?? task;
        const presentation = getService('presentation');
        json(response, 200, { ...task, views: presentation ? await presentation.render(task) : [] });
        return;
      }
      const pluginConfigMatch = path.match(/^\/api\/plugins\/([^/]+)\/config$/);
      if (request.method === 'GET' && pluginConfigMatch) {
        const plugin = config.plugins.find(entry => entry.id === decodeURIComponent(pluginConfigMatch[1]));
        if (!plugin) throw new RequestError(404, '插件不存在');
        json(response, 200, { config: plugin.config ?? {}, grants: plugin.grants, module: plugin.module }); return;
      }
      if (request.method !== 'POST') throw new RequestError(405, '不支持此请求方法。');
      if (origin !== `http://${host}`) throw new RequestError(403, '本机操作需要同源 Origin。');
      const body = await readObject(request);
      let match: RegExpMatchArray | null;
      if (path === '/api/projects/pick-directory') {
        if (Object.keys(body).length) throw new RequestError(400, '文件夹选择不接受额外参数。');
        json(response, 200, await pickWorkspaceDirectory()); return;
      } else if ((match = path.match(/^\/api\/tasks\/([^/]+)\/approve$/))) {
        await runtime.approveTask(decodeURIComponent(match[1]), booleanField(body, 'approve'), visibility(body));
      } else if ((match = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/))) {
        await runtime.cancelTask(decodeURIComponent(match[1]));
      } else if (path === '/api/plugin-authoring/scaffold') {
        if (Object.keys(body).some(key => !['id', 'title', 'description', 'brief', 'directory'].includes(key))) throw new RequestError(400, '插件草稿参数无效。');
        if (typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(body.id) || typeof body.title !== 'string' || typeof body.description !== 'string' || typeof body.brief !== 'string') throw new RequestError(400, '请填写有效的插件 ID、名称和需求。');
        const target = await pluginDraftLocation(body.directory, body.id);
        const created = await createPluginProject({ rootDirectory: target.absolute, id: body.id, title: body.title, description: body.description, brief: body.brief });
        const validation = await validatePluginProject(created.rootDirectory);
        if (!validation.ok) throw new Error(`插件模板预检失败：${validation.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
        json(response, 200, { relativePath: target.relative, manifest: created.manifest, validation, developmentPrompt: pluginDevelopmentPrompt(target.relative) }); return;
      } else if (path === '/api/plugin-authoring/validate') {
        if (Object.keys(body).some(key => key !== 'path') || typeof body.path !== 'string') throw new RequestError(400, '请选择插件目录。');
        const target = await pluginDraftLocation(body.path, 'plugin');
        json(response, 200, await validatePluginProject(target.absolute)); return;
      } else if (path === '/api/plugins/install') {
        if (!runtime.installPlugin) throw new Error('宿主不支持插件安装');
        const module = String(body.module ?? '');
        const grants = body.grants ?? [];
        if (!Array.isArray(grants) || grants.some(value => typeof value !== 'string')) throw new RequestError(400, '插件权限必须是字符串列表。');
        if (module === 'mcp' || module.startsWith('builtin:')) {
          if (typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(body.id)) throw new RequestError(400, '此插件需要有效的插件 ID。');
          await runtime.installPlugin({ id: body.id, module, enabled: false, grants, config: objectField(body.config ?? {}) });
        } else {
          if (!module) throw new RequestError(400, '请选择插件目录或模块。');
          const requested = isAbsolute(module) ? module : (await pluginDraftLocation(module, 'plugin')).absolute;
          const validation = await validatePluginProject(requested);
          if (!validation.ok || !validation.entryPath || !validation.plugin?.id) throw new RequestError(400, `插件预检失败：${validation.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
          const id = typeof body.id === 'string' && body.id ? body.id : validation.manifest?.id ?? validation.plugin.id;
          if (id !== validation.plugin.id) throw new RequestError(400, '插件 ID 与入口模块不一致。');
          if (grants.some(permission => !validation.plugin!.permissions.includes(permission))) throw new RequestError(400, '不能授予插件未声明的权限。');
          await runtime.installPlugin({ id, module: validation.entryPath, ...(validation.manifestPath ? { manifest: validation.manifestPath } : {}), requestedPermissions: validation.plugin.permissions, enabled: false, grants, config: objectField(body.config ?? {}) });
          json(response, 200, { ok: true, validation, installed: { id, enabled: false, grants } }); return;
        }
      } else if ((match = path.match(/^\/api\/plugins\/([^/]+)\/config$/))) {
        if (!runtime.configurePlugin) throw new Error('宿主不支持插件配置');
        await runtime.configurePlugin(decodeURIComponent(match[1]), objectField(body.config), body.grants as string[] | undefined);
      } else if ((match = path.match(/^\/api\/plugins\/([^/]+)$/))) {
        await runtime.setPluginEnabled(decodeURIComponent(match[1]), booleanField(body, 'enabled'));
      } else if (path === '/api/oauth/local-authorize') {
        if (Object.keys(body).some(key => key !== 'url')) throw new RequestError(400, '备用授权只接受原始授权链接。');
        const localAuthorizeUrl = localAuthorizationUrl(body.url, extra.publicUrl ?? config.publicUrl, extra.localMcpUrl);
        // 返回给已登录的本机浏览器，由用户点击打开；不发起请求、不记录链接、不自动批准。
        json(response, 200, { localAuthorizeUrl }); return;
      } else if ((match = path.match(/^\/api\/oauth\/([^/]+)\/decide$/))) {
        if (Object.keys(body).some(key => !['approve', 'label'].includes(key)) || body.label !== undefined && typeof body.label !== 'string') throw new RequestError(400, '连接批准参数无效。');
        await oauth.decide(decodeURIComponent(match[1]), booleanField(body, 'approve'), body.label as string | undefined);
      } else if ((match = path.match(/^\/api\/oauth\/([^/]+)\/label$/))) {
        if (Object.keys(body).some(key => key !== 'label') || body.label !== undefined && typeof body.label !== 'string') throw new RequestError(400, '连接备注参数无效。');
        if (!oauth.setLabel) throw new RequestError(409, '当前授权服务不支持连接备注。');
        await oauth.setLabel(decodeURIComponent(match[1]), body.label as string | undefined);
      } else if ((match = path.match(/^\/api\/oauth\/([^/]+)\/pause$/))) {
        if (Object.keys(body).some(key => key !== 'paused')) throw new RequestError(400, '连接暂停参数无效。');
        if (!oauth.setPaused) throw new RequestError(409, '当前授权服务不支持单独暂停连接。');
        await oauth.setPaused(decodeURIComponent(match[1]), booleanField(body, 'paused'));
      } else if ((match = path.match(/^\/api\/oauth\/([^/]+)\/revoke$/))) {
        if (Object.keys(body).length) throw new RequestError(400, '撤销连接不接受额外参数。');
        await oauth.revoke(decodeURIComponent(match[1]));
      } else if (path === '/api/oauth/revoke') {
        await oauth.revoke();
      } else if ((match = path.match(/^\/api\/access\/([^/]+)\/decide$/))) {
        if (!extra.access) throw new Error('当前入口没有待确认的远程请求');
        await extra.access.decide(decodeURIComponent(match[1]), booleanField(body, 'approve'), visibility(body));
      } else if (path === '/api/approval-settings') {
        if (Object.keys(body).some(key => !['approvalMode', 'autoResultVisibility'].includes(key)) || (body.approvalMode !== 'ask' && body.approvalMode !== 'auto') || (body.autoResultVisibility !== 'local' && body.autoResultVisibility !== 'client')) throw new RequestError(400, '请选择有效的审批模式和自动结果可见范围。');
        if (!runtime.configureApprovalSettings) throw new RequestError(409, '当前宿主不支持修改审批设置。');
        const result = await runtime.configureApprovalSettings({ approvalMode: body.approvalMode, autoResultVisibility: body.autoResultVisibility });
        json(response, 200, result); return;
      } else if (path === '/api/pause') {
        const paused = booleanField(body, 'paused');
        await extra.access?.pause?.(paused); await runtime.pause?.(paused); await extra.onPause?.(paused);
      } else if (path === '/api/tools/call') {
        if (typeof body.name !== 'string') throw new Error('请选择要使用的工具');
        const task = await runtime.submit(body.name, objectField(body.args ?? {}), 'local-console') as TaskRecord;
        await runtime.waitTask?.(task.id, 500);
        json(response, 200, await runtime.getTask(task.id) ?? task); return;
      } else if ((match = path.match(/^\/api\/services\/([a-z.-]+)\/([a-zA-Z]+)$/))) {
        const result = await serviceAction(match[1], match[2], body);
        json(response, 200, result ?? { ok: true }); return;
      } else if (path === '/api/try') {
        await runtime.submit('workspace__list', { path: '.' }, 'local-console');
      } else {
        throw new RequestError(404, '操作不存在。');
      }
      json(response, 200, { ok: true });
    })().catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      json(response, error instanceof RequestError ? error.status : 400, { error: error instanceof Error ? error.message : '操作未完成，请重试。' });
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.controlPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (address && typeof address !== 'string') port = address.port;
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    get openUrl() { return `http://127.0.0.1:${port}/#bootstrap=${bootstrap}`; },
    close: () => { if (closed) return Promise.resolve(); closed = true; return new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}
function objectField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, '参数必须为对象。');
  return value as Record<string, unknown>;
}
function visibility(body: Record<string, unknown>): 'local' | 'client' {
  const value = body.resultVisibility ?? 'local';
  if (value !== 'local' && value !== 'client') throw new RequestError(400, '请选择结果可见范围。');
  return value;
}
