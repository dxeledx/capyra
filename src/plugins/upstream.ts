import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CapyraPlugin, JsonSchema, PluginContext, ToolDefinition } from '../core/types.js';

interface UpstreamConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowTools?: string[];
  readOnlyTools?: string[];
  timeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
}

function stringList(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${key} must be an array of strings`);
  return value as string[];
}

function stringMap(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error(`${key} must be an object with string values`);
  }
  return value as Record<string, string>;
}

function parseConfig(raw: Record<string, unknown>): UpstreamConfig {
  if (!['stdio', 'http', 'sse'].includes(String(raw.transport))) throw new Error('Upstream transport must be stdio, http or sse');
  for (const key of ['command', 'cwd', 'url']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key])) throw new Error(`${key} must be a non-empty string`);
  }
  const timeoutMs = raw.timeoutMs ?? 60_000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error('timeoutMs must be an integer between 1 and 3600000');
  }
  if (raw.transport === 'stdio' && !raw.command) throw new Error('A stdio upstream needs a command');
  if (raw.transport !== 'stdio' && !raw.url) throw new Error('An HTTP or SSE upstream needs a url');
  const reconnectAttempts = raw.reconnectAttempts ?? 3;
  const reconnectDelayMs = raw.reconnectDelayMs ?? 1000;
  if (!Number.isInteger(reconnectAttempts) || Number(reconnectAttempts) < 0 || Number(reconnectAttempts) > 10) throw new Error('reconnectAttempts must be an integer between 0 and 10');
  if (!Number.isInteger(reconnectDelayMs) || Number(reconnectDelayMs) < 20 || Number(reconnectDelayMs) > 60_000) throw new Error('reconnectDelayMs must be an integer between 20 and 60000');
  let headers = stringMap(raw.headers, 'headers');
  if (raw.auth !== undefined) {
    const auth = raw.auth as { type?: unknown; tokenEnv?: unknown };
    if (!auth || typeof auth !== 'object' || auth.type !== 'bearer' || typeof auth.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.tokenEnv)) throw new Error('auth must specify type bearer and tokenEnv');
    if (!process.env[auth.tokenEnv]) throw new Error('The configured upstream token environment variable is empty');
    if (Object.keys(headers ?? {}).some(name => name.toLowerCase() === 'authorization')) throw new Error('Configure upstream authorization through auth or headers, not both');
    headers = { ...headers, Authorization: `Bearer ${process.env[auth.tokenEnv]}` };
  }
  return {
    transport: raw.transport as UpstreamConfig['transport'],
    command: raw.command as string | undefined,
    cwd: raw.cwd as string | undefined,
    url: raw.url as string | undefined,
    args: stringList(raw.args, 'args'),
    env: stringMap(raw.env, 'env'),
    headers,
    allowTools: stringList(raw.allowTools, 'allowTools'),
    readOnlyTools: stringList(raw.readOnlyTools, 'readOnlyTools'),
    timeoutMs,
    reconnectAttempts: Number(reconnectAttempts),
    reconnectDelayMs: Number(reconnectDelayMs),
  };
}

function localToolName(original: string): string {
  if (/^[a-z][a-z0-9_]{0,47}$/.test(original)) return original;
  const normalized = original.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const prefix = /^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`;
  return `${prefix.slice(0, 35)}_${createHash('sha256').update(original).digest('hex').slice(0, 12)}`;
}

function childEnvironment(explicit: Record<string, string> = {}): Record<string, string> {
  // SDK 会补入自己的默认变量；先覆盖这些值，再只继承启动进程所需的变量。
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
  const inherited = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
  if (process.platform === 'win32') inherited.push('SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA');
  for (const key of inherited) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  return { ...env, ...explicit };
}

function createTransport(config: UpstreamConfig, workspace: string) {
  if (config.transport === 'stdio') {
    const command = config.command!;
    return new StdioClientTransport({
      command: !isAbsolute(command) && /[/\\]/.test(command) ? resolve(workspace, command) : command,
      args: config.args,
      cwd: config.cwd ? resolve(workspace, config.cwd) : workspace,
      env: childEnvironment(config.env),
      // 上游 stderr 不写入 MCP stdout，也不允许无人读取的 pipe 持续堆积。
      stderr: 'inherit',
    });
  }
  const url = new URL(config.url!);
  if (url.username || url.password) throw new Error('Put upstream credentials in headers, not in the URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('HTTP upstreams require HTTPS, except on loopback');
  if (config.transport === 'sse') return new SSEClientTransport(url, {
    requestInit: { headers: config.headers, redirect: 'error' },
    // EventSource 的 GET 与后续 POST 共用认证配置，禁止重定向泄漏凭据。
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: config.headers, redirect: 'error' },
    // 失败交给任务记录与用户处理，避免对具有外部副作用的调用进行隐式重放。
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
}

/** 每个上游是一份独立插件实例；只有启用后的 setup 才建立连接或启动子进程。 */
export function createUpstreamPlugin(id: string): CapyraPlugin {
  return {
    apiVersion: 1,
    id,
    version: '0.1.0',
    title: `MCP · ${id}`,
    description: 'Use an existing MCP server through the same local approvals and task records.',
    permissions: ['mcp:call'],
    instructions: 'Discover the available tools before calling them. Upstream actions may need approval in the local Capyra console. If a connection fails, inspect the task result before making another call.',
    async setup(context: PluginContext) {
      const config = parseConfig(context.config);
      let client = new Client({ name: `capyra-${id}`, version: '0.1.0' });
      let transport = createTransport(config, context.workspace);
      const lifetime = new AbortController();
      const readOnly = new Set(config.readOnlyTools ?? []);
      const allowed = config.allowTools ? new Set(config.allowTools) : undefined;
      let closed = false;
      let connected = false;
      let current: ToolDefinition[] = [];
      let disposers: Array<() => void> = [];
      let refreshQueue = Promise.resolve();
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let reconnecting: Promise<void> | undefined;
      let attempts = 0;
      const status = { connected: false, reconnecting: false, toolCount: 0, error: undefined as string | undefined, reconnect: async () => { attempts = 0; await reconnect(); } };
      context.provide(`${id}.status`, status);
      const safeError = (error: unknown) => {
        let message = error instanceof Error ? error.message : String(error);
        const credentials = [...Object.values(config.headers ?? {}), ...Object.values(config.env ?? {})];
        for (const [name, value] of Object.entries(config.headers ?? {})) if (name.toLowerCase() === 'authorization') credentials.push(value.replace(/^\S+\s+/, ''));
        for (const value of credentials) if (value) message = message.replaceAll(value, '[redacted]');
        message = message.replace(/https?:\/\/[^\s"'<>]+/g, '[upstream endpoint]');
        return message.slice(0, 1000);
      };
      const scheduleReconnect = () => {
        if (closed || reconnectTimer || reconnecting || attempts >= config.reconnectAttempts) return;
        status.reconnecting = true;
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void reconnect().catch(() => {}); }, Math.min(30_000, config.reconnectDelayMs * 2 ** attempts));
        reconnectTimer.unref();
      };

      const close = async () => {
        if (closed) return;
        closed = true;
        connected = false;
        status.connected = false;
        status.reconnecting = false;
        clearTimeout(reconnectTimer);
        lifetime.abort(new Error('Upstream plugin was disabled'));
        for (const dispose of disposers) dispose();
        disposers = [];
        current = [];
        status.toolCount = 0;
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
          // 显式释放远端会话；离线端点最多等待一秒，随后 close 会中止请求。
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              transport.terminateSession().catch(() => undefined),
              new Promise<void>(done => { timer = setTimeout(done, 1000); }),
            ]);
          } finally { clearTimeout(timer); }
        }
        // close() 终止 stdio 子进程、HTTP SSE 及所有尚未完成的请求。
        await client.close();
        await reconnecting?.catch(() => {});
        await refreshQueue;
      };
      context.onDispose(close);

      const discover = async (): Promise<Tool[]> => {
        const result: Tool[] = [];
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal: lifetime.signal, timeout: config.timeoutMs });
          for (const tool of page.tools) {
            if (names.has(tool.name)) throw new Error(`Upstream returned duplicate tool name: ${tool.name}`);
            names.add(tool.name);
            if (!allowed || allowed.has(tool.name)) result.push(tool);
          }
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            if (cursors.has(cursor) || cursors.size >= 1000) throw new Error('Upstream tool pagination did not terminate');
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        return result;
      };

      const definitions = (tools: Tool[]): ToolDefinition[] => {
        const localNames = new Set<string>();
        return tools.map(tool => {
          const name = localToolName(tool.name);
          if (localNames.has(name)) throw new Error(`Upstream tool names collide after normalization: ${tool.name}`);
          localNames.add(name);
          const effect = readOnly.has(tool.name) ? 'read' : 'execute';
          const definition: ToolDefinition = {
            ...tool,
            name,
            title: tool.title ?? tool.annotations?.title ?? tool.name,
            description: tool.description ?? `Call ${tool.name} on ${id}.`,
            inputSchema: tool.inputSchema as JsonSchema,
            effect,
            permissions: ['mcp:call'],
            // 上游的提示不能授予本机权限；只读名单由本机配置的操作者负责授权。
            annotations: { ...tool.annotations, readOnlyHint: effect === 'read' },
            timeoutMs: config.timeoutMs,
            async preview(args) {
              return {
                title: `${id} · ${tool.title ?? tool.name}`,
                description: `Call the configured ${config.transport} MCP server. This server controls how the operation is performed.`,
                after: JSON.stringify({ tool: tool.name, arguments: args }, null, 2),
              };
            },
            async execute(args, toolContext) {
              if (closed || !connected) throw new Error('Upstream is disconnected. Re-enable the plugin to reconnect; this call was not retried.');
              if (!current.includes(definition)) throw new Error('Upstream tools changed. Discover the current tool and submit a new request.');
              const signal = AbortSignal.any([lifetime.signal, toolContext.signal]);
              try {
                return await client.callTool({ name: tool.name, arguments: args }, CallToolResultSchema, {
                  signal,
                  timeout: config.timeoutMs,
                  maxTotalTimeout: config.timeoutMs,
                  onprogress: progress => toolContext.progress(progress.message ?? `${progress.progress}${progress.total === undefined ? '' : `/${progress.total}`}`),
                }) as CallToolResult;
              } catch (error) {
                // 只修复后续连接；已提交的调用可能已经生效，绝不自动再次提交。
                if (!signal.aborted && /fetch failed|connection|ECONN|session|HTTP 50[234]/i.test(safeError(error))) { connected = false; status.connected = false; scheduleReconnect(); }
                throw new Error(safeError(error), { cause: error });
              }
            },
          };
          return definition;
        });
      };

      const refresh = async () => {
        const next = definitions(await discover());
        if (closed) return;
        const previous = current;
        for (const dispose of disposers) dispose();
        const installed: Array<() => void> = [];
        try {
          // 目录读取完成后同步切换注册；没有 await 的区段不会让调用看到半套目录。
          for (const definition of next) installed.push(context.registerTool(definition));
          current = next;
          disposers = installed;
          status.toolCount = next.length;
          status.error = undefined;
        } catch (error) {
          for (const dispose of installed) dispose();
          disposers = previous.map(definition => context.registerTool(definition));
          throw error;
        }
      };

      const bindClient = () => {
        const bound = client;
        client.onclose = () => { if (closed || bound !== client) return; connected = false; status.connected = false; scheduleReconnect(); };
        client.onerror = error => {
          if (bound !== client) return;
          status.error = safeError(error);
          if (transport instanceof SSEClientTransport && connected) { connected = false; status.connected = false; scheduleReconnect(); }
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          refreshQueue = refreshQueue.then(async () => { if (!closed && connected && bound === client) await refresh(); }).catch(error => { status.error = safeError(error); });
        });
      };
      const reconnect = async (): Promise<void> => {
        if (closed) throw new Error('Upstream plugin was disabled');
        if (reconnecting) return reconnecting;
        clearTimeout(reconnectTimer); reconnectTimer = undefined;
        attempts++; connected = false; status.connected = false; status.reconnecting = true;
        reconnecting = (async () => {
          const old = client;
          client = new Client({ name: `capyra-${id}`, version: '0.1.0' });
          transport = createTransport(config, context.workspace);
          bindClient();
          await old.close().catch(() => {});
          await client.connect(transport, { signal: lifetime.signal, timeout: config.timeoutMs });
          connected = true; status.connected = true;
          refreshQueue = refreshQueue.then(refresh); await refreshQueue;
          attempts = 0; status.error = undefined;
        })().catch(async error => {
          connected = false; status.connected = false; status.error = safeError(error);
          await client.close().catch(() => {});
          throw error;
        }).finally(() => { reconnecting = undefined; status.reconnecting = false; if (!connected) scheduleReconnect(); });
        return reconnecting;
      };
      bindClient();
      try {
        await client.connect(transport, { signal: lifetime.signal, timeout: config.timeoutMs });
        connected = true;
        status.connected = true;
        // 初始发现也加入串行队列，防止初始化期间的 list_changed 与其交错。
        refreshQueue = refreshQueue.then(refresh);
        await refreshQueue;
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    },
  };
}
