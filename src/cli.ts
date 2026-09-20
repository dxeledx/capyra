#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { resolve, dirname, isAbsolute } from 'node:path';
import { readFile, writeFile, mkdir, unlink, rename, lstat, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, initConfig, migrateLocalConfig, resolvePlugin, defaults, configWriter } from './config.js';
import { Runtime, createRuntime } from './core/runtime.js';
import type { ConnectionService } from './connection/types.js';
import type { IdentityService } from './identity/client.js';
import type { AccessController } from './transport/access.js';
import type { startMcpHttp, createMcpServer, McpTemplateDiagnostic, McpRequestDiagnostic } from './transport/mcp.js';
import type { startControl } from './transport/control.js';
import { createPluginProject, pluginDevelopmentPrompt, pluginAuthoringSpec, validatePluginProject } from './plugin-devkit.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', short: 'c' }, workspace: { type: 'string', short: 'w' }, port: { type: 'string' },
  'control-port': { type: 'string' }, 'public-url': { type: 'string' }, compact: { type: 'boolean' },
  stdio: { type: 'boolean' }, open: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }, id: { type: 'string' }, json: { type: 'boolean' },
  tunnel: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
  cwd: { type: 'string' }, 'wait-ms': { type: 'string' }, lines: { type: 'string' }, force: { type: 'boolean' },
  'session-id': { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'string' },
  'write-mode': { type: 'string' },
  dir: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, grant: { type: 'string', multiple: true },
} });

// 插件开发专用参数包含数组，启动配置和代理 CLI 只接收标量参数。
const scalarValues = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'string' || typeof value === 'boolean')) as Record<string, string | boolean>;

const usage = `Capyra · 把对话中的想法，交给本机执行

  capyra start                    启动 MCP 和本机控制台
  capyra start --open             启动并打开控制台
  capyra open                     打开已运行实例的本机工作台
  capyra start --compact          使用精简工具目录
  capyra start --public-url URL   使用已有 HTTPS 隧道地址
  capyra start --tunnel cloudflare  启动免登录 Cloudflare 连接
  capyra start --stdio            接入本机 MCP 客户端或官方 Secure MCP Tunnel
  capyra init                     创建可编辑的 capyra.json
  capyra local                    备份配置并切换到本地模式
  capyra doctor                   检查本机配置与运行状态
  capyra agents targets           查看编码代理和角色
  capyra agents run TARGET --prompt TEXT  启动后台代理
  capyra agents continue ID --prompt TEXT  继续原生代理会话
  capyra agents daemon status     查看按需后台服务状态
  capyra plugin create ID --prompt TEXT  创建 AI 可直接开发的插件目录
  capyra plugin spec --json       输出机器可读的插件开发契约
  capyra plugin validate PATH     预检 manifest、入口和模块元数据
  capyra plugin install PATH      验证并安装目录插件（初始禁用）
  capyra plugin inspect ID        查看已安装插件与预检报告
  capyra plugin add FILE --id ID  兼容添加旧式单文件插件
  capyra plugin enable ID         修改插件启动配置
  capyra plugin disable ID        修改插件启动配置

  -c, --config FILE               配置文件，默认 ./capyra.json
  -w, --workspace DIR             工作区，默认配置文件所在目录
  --port / --control-port         MCP / 本机控制端口，默认 4317 / 4318
`;

async function main() {
  if (values.version) { console.log('0.5.2'); return; }
  if (values.help) { console.log(usage); return; }
  const configPath = resolve(values.config ?? 'capyra.json');
  const command = positionals[0] ?? 'start';
  if (command === 'init') {
    await initConfig(configPath); console.log(`已创建 ${configPath}\n运行 capyra start --open 开始使用。`); return;
  }
  if (command === 'plugin') { await managePlugin(configPath, positionals.slice(1)); return; }
  if (command === 'local') {
    // 迁移始终跟随配置原工作区，运行参数不能把连接状态重置到另一个目录。
    await readFile(configPath, 'utf8');
    const local = await loadConfig(configPath), lock = await acquireLock(local.stateDir);
    try {
      const result = await migrateLocalConfig(configPath, local.stateDir);
      console.log(`已切换到本地模式。工作区、能力插件和数据已保留。\n配置备份：${result.backupPath}${result.connectionBackups.map(path => `\n连接备份：${path}`).join('')}\n运行 capyra start --config ${JSON.stringify(configPath)} --open，然后在连接向导中启动免登录连接。`);
    } finally { await lock.release(); }
    return;
  }
  if (values.config) await readFile(configPath, 'utf8');
  const config = await loadConfig(configPath, scalarValues);
  if (command === 'open') {
    if (config.plugins.some(plugin => plugin.id === 'console' && !plugin.enabled)) throw new Error('本机工作台插件已停用，请先启用 console 插件。');
    const origin = `http://127.0.0.1:${await runningControlPort(config.stateDir, config.controlPort)}`;
    const response = await fetch(origin + '/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Capyra-Local': '1', Origin: origin }, body: '{}', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('无法打开已有实例。请用 capyra start --open 启动工作台。');
    console.log('已在本机浏览器中打开 Capyra。'); return;
  }
  if (command === 'agents') {
    const { runAgentCommand } = await import('./daemon/commands.js');
    await runAgentCommand(positionals.slice(1), config, { flags: scalarValues }); return;
  }
  if (command === 'doctor') {
    const enabled = (id: string) => config.plugins.find(plugin => plugin.id === id)?.enabled ?? true;
    const checksPromise = doctorChecks(config.workspace, config.plugins.some(plugin => plugin.id === 'git' && plugin.enabled), config.plugins.some(plugin => ['process', 'terminal'].includes(plugin.id) && plugin.enabled));
    let running: unknown = null, controlPort = config.controlPort, mcpPort = config.port;
    try {
      if (enabled('console')) { controlPort = await runningControlPort(config.stateDir, controlPort); const response = await fetch(`http://127.0.0.1:${controlPort}/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) running = await response.json(); }
    } catch {}
    try {
      if (enabled('mcp')) {
        mcpPort = await runningEndpointPort(config.stateDir, 'mcpPort', mcpPort);
        if (!running && mcpPort) { const response = await fetch(`http://127.0.0.1:${mcpPort}/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) running = await response.json(); }
      }
    } catch {}
    const checks = await checksPromise;
    const hints = [!checks.workspace.directory || !checks.workspace.readable || !checks.workspace.writable ? '工作区不可用，请检查目录及其读取和写入权限。' : undefined,
      checks.git.status !== 'ok' ? '未检测到可用 Git；需要 Git/worktree 能力时安装 Git 并加入 PATH。' : undefined,
      checks.shell.status !== 'ok' ? 'Shell 检查未通过，请检查 SHELL/ComSpec 指向可执行的本机 shell。' : undefined,
      checks.sqlite.status !== 'ok' ? '当前 Node 的 SQLite 扩展不可用；默认 JSON 存储可继续使用，SQLite 存储插件需要兼容的 Node 运行时。' : undefined].filter(Boolean);
    const report = { node: process.version, platform: `${process.platform}/${process.arch}`, workspace: config.workspace, configPath, exposure: config.exposure,
      mcp: enabled('mcp') ? config.publicUrl ? `${config.publicUrl}/mcp` : mcpPort ? `http://127.0.0.1:${mcpPort}/mcp` : null : null,
      console: enabled('console') && controlPort ? `http://127.0.0.1:${controlPort}` : null, plugins: config.plugins.map(p => ({ id: p.id, enabled: p.enabled, grants: p.grants })), running, checks, hints };
    console.log(JSON.stringify(report, null, 2)); return;
  }
  if (command !== 'start') throw new Error(`未知命令：${command}\n${usage}`);
  const instanceLock = await acquireLock(config.stateDir);
  let runtime: Runtime | undefined;
  let closeControl: (() => Promise<void>) | undefined;
  let closeMcp: (() => Promise<void>) | undefined;
  let closeApprovalRelay: (() => void) | undefined;
  let approvalAccess: AccessController | undefined;
  let stopping = false;
  let startupComplete = false;
  let stdinEnded = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    closeApprovalRelay?.();
    // 停止入口后，等待插件的取消和资源回收，再移除单实例锁。
    try { await closeControl?.(); }
    finally { try { await closeMcp?.(); } finally { try { await runtime?.close(); } finally { await instanceLock.release(); } } }
  };
  try {
    if (values.tunnel && (values.tunnel !== 'cloudflare' || values.stdio || config.port === 0)) throw new Error('--tunnel cloudflare 需要固定 MCP 端口和 HTTP 模式');
    runtime = await createRuntime(config, resolvePlugin);
    runtime.setConfigWriter(configWriter(configPath));
    await runtime.start();
    // 只有显式开关才向 stderr 写固定分类诊断；不接收或输出原始 HTTP/工具上下文。
    const templateDiagnostics = process.env.CAPYRA_TEMPLATE_DIAGNOSTICS === '1' ? { onTemplateDiagnostic: (event: McpTemplateDiagnostic) => {
      process.stderr.write(JSON.stringify({ type: 'capyra.template', requestId: event.requestId, stage: event.stage, reason: event.reason, ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }), templateBytes: event.templateBytes, templateSha256: event.templateSha256 }) + '\n');
    }, onRequestDiagnostic: (event: McpRequestDiagnostic) => {
      process.stderr.write(JSON.stringify({ type: 'capyra.mcp', requestId: event.requestId, operation: event.operation, stage: event.stage, reason: event.reason, ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }) }) + '\n');
    } } : {};
    // 只有未声明adapter的旧配置可用兼容入口；显式停用、加载失败或缺少服务都不能被fallback绕过。
    const available = (id: string, service: string) => !config.plugins.some(plugin => plugin.id === id)
      || (runtime!.listPlugins().some(plugin => plugin.id === id && plugin.enabled && plugin.status === 'ready') && runtime!.hasService(service));
    const mcpProvider = !available('mcp', 'mcp.transport') ? undefined : runtime.hasService('mcp.transport')
      ? runtime.service<{ createServer: typeof createMcpServer; start: typeof startMcpHttp }>('mcp.transport')
      : { createServer: (await import('./transport/mcp.js')).createMcpServer, start: (await import('./transport/mcp.js')).startMcpHttp };
    const consoleProvider = !available('console', 'console.transport') ? undefined : runtime.hasService('console.transport')
      ? runtime.service<{ start: typeof startControl }>('console.transport')
      : { start: (await import('./transport/control.js')).startControl };
    if (values.stdio && !mcpProvider) throw new Error('--stdio 需要已启用且成功加载的 MCP 插件。');
    if (values.tunnel && !mcpProvider) throw new Error('--tunnel 需要已启用且成功加载的 MCP 插件。');
    if (!mcpProvider && !consoleProvider) {
      const errors = runtime.listPlugins().filter(plugin => ['mcp', 'console'].includes(plugin.id) && plugin.status === 'error').map(plugin => `${plugin.id}: ${plugin.error}`);
      throw new Error(`没有可启动的入口，请启用 mcp 或 console 插件。${errors.length ? ` ${errors.join('; ')}` : ''}`);
    }
    const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
    const restart = `capyra start --config ${quote(configPath)} --workspace ${quote(config.workspace)}${values.stdio ? ' --stdio' : ''}${values.compact ? ' --compact' : ''}${values.open ? ' --open' : ''}${['port', 'control-port', 'public-url', 'tunnel'].filter(key => typeof values[key as keyof typeof values] === 'string').map(key => ` --${key} ${quote(String(values[key as keyof typeof values]))}`).join('')}`;
    runtime.requireRestartForPluginChanges(['mcp', 'console'], id => `插件 ${id} 属于本次启动入口，更改需重启。请先停止当前实例${values.stdio ? '（或停止使用它的 MCP 客户端）' : '（Ctrl+C）'}，再运行 capyra plugin enable ${id} --config ${quote(configPath)} 或 capyra plugin disable ${id} --config ${quote(configPath)}；修改插件配置请编辑 ${quote(configPath)}。完成后运行 ${restart}${process.platform === 'win32' ? '（以上命令使用 PowerShell）' : ''}。`, ['mcp.transport', 'console.transport']);
    const connection = () => runtime?.hasService('connection') ? runtime.service<ConnectionService>('connection') : undefined;
    const identity = () => runtime?.hasService('identity') ? runtime.service<IdentityService>('identity') : undefined;
    const watchIdentity = (access: { cancelOwner(owner?: string): void }, revoke: () => void) => {
      const service = identity();
      let previous = service?.status();
      return service?.onBindingChanged(next => {
        const changed = previous?.device && (!next.device || previous.device.id !== next.device.id || previous.device.ownerId !== next.device.ownerId || previous.device.version !== next.device.version || next.device.revokedAt);
        previous = next;
        if (changed || !next.active) {
          access.cancelOwner(); void runtime!.cancelOwner();
          if (changed) { revoke(); connection()?.observeOAuth({ status: 'revoked' }); }
        }
      });
    };
    let control: Awaited<ReturnType<typeof startControl>> | undefined;
    if (values.stdio || !mcpProvider) {
      if (values.stdio) process.stdin.once('end', () => { stdinEnded = true; if (startupComplete) void shutdown(); });
      const { createAccessController } = await import('./transport/access.js');
      const access = createAccessController(consoleProvider ? undefined : 0);
      approvalAccess = access;
      let offIdentity = watchIdentity(access, () => access.cancelOwner());
      const offEvents = runtime.onEvent(event => {
        if (event.type === 'plugin.ready' && event.pluginId === 'identity') { offIdentity?.(); offIdentity = watchIdentity(access, () => access.cancelOwner()); }
        if (event.type === 'plugin.disabled' && event.pluginId === 'identity') { access.cancelOwner(); void runtime!.cancelOwner(); }
      });
      const server = values.stdio ? mcpProvider!.createServer(runtime, 'stdio:local', { access, approvalTimeoutMs: consoleProvider ? undefined : 0, ...templateDiagnostics }) : undefined;
      closeMcp = async () => { offIdentity?.(); offEvents(); access.close(); await server?.close(); };
      if (server) await server.connect(new StdioServerTransport());
      if (consoleProvider) {
        control = await consoleProvider.start(runtime, config, { pending: () => [], decide: () => { throw new Error('当前入口无需 OAuth'); }, revoke: () => { access.cancelOwner(); return runtime!.cancelOwner(); } }, { access, onOpen: openBrowser });
        closeControl = () => control!.close();
      }
    } else {
      // 固定地址在 OAuth 控制器创建前确定。Sites/Named 的已保存入口与身份插件入口
      // 都必须直接进入原 realm，避免重启时先创建本机 issuer 再替换。
      const rememberedConnection = connection()?.status().configuration;
      const fixedDeviceUrl = identity()?.bridgePublicUrl()
        ?? (rememberedConnection && ['sites', 'managed'].includes(rememberedConnection.mode) ? rememberedConnection.publicUrl : undefined);
      if (fixedDeviceUrl) config.publicUrl = fixedDeviceUrl;
      const mcp = await mcpProvider.start(runtime, config, { approvalTimeoutMs: consoleProvider ? undefined : 0, ...templateDiagnostics, onEvidence: event => {
        if (event.type === 'authorization') connection()?.observeOAuth({ status: 'authorized', clientName: event.clientName });
        else if (event.type === 'tool-call') connection()?.observeToolCall({ clientName: event.clientName, tool: event.tool });
      } });
      approvalAccess = mcp.access;
      if (config.port === 0) config.port = Number(new URL(mcp.localUrl).port);
      closeMcp = () => mcp.close();
      // 隧道地址变更会替换 OAuth 控制器；本机管理入口始终读取当前这一代。
      const syncOAuthStatus = () => {
        const grants = mcp.oauth.grants();
        const active = grants.filter(grant => grant.status === 'active');
        connection()?.observeOAuth({ status: active.length ? 'authorized' : grants.length ? 'paused' : 'revoked', clientName: (active.at(-1) ?? grants.at(-1))?.clientName });
      };
      const oauthBridge = {
        pending: () => mcp.oauth.pending(), decide: (id: string, approve: boolean, label?: string) => mcp.oauth.decide(id, approve, label),
        grants: () => mcp.oauth.grants(),
        setLabel: (id: string, label?: string) => mcp.oauth.setLabel(id, label),
        setPaused: (id: string, paused: boolean) => { mcp.oauth.setPaused(id, paused); syncOAuthStatus(); },
        revoke: (id?: string) => { mcp.oauth.revoke(id); syncOAuthStatus(); },
      };
      if (consoleProvider) {
        control = await consoleProvider.start(runtime, config, oauthBridge, { get mcpUrl() { return mcp.url; }, localMcpUrl: new URL('/mcp', mcp.localUrl).href, get publicUrl() { return config.publicUrl; }, access: mcp.access, onOpen: openBrowser });
        closeControl = () => control!.close();
      }
      const bindConnection = async () => {
        const connected = connection();
        if (!connected) return;
        await connected.configureHost({
          mcpPort: config.port, controlPort: control ? Number(new URL(control.url).port) : config.controlPort,
          onPublicUrl: async url => { await mcp.setPublicUrl(url); config.publicUrl = url; },
          onTunnelUrl: url => mcp.setTunnelUrl(url),
          // 每次读取当前身份插件，停用或换绑后不会继续沿用旧设备的发布能力。
          bridge: config.plugins.some(plugin => plugin.id === 'identity') ? {
            publicUrl: () => identity()?.bridgePublicUrl(),
            publish: async upstream => {
              const service = identity();
              if (!service) throw new Error('固定连接入口需要已绑定的账号设备。');
              return service.publishBridge(upstream);
            },
            remove: async () => { await identity()?.removeBridge(); },
          } : undefined,
        });
        if (values.tunnel) { await connected.configure({ mode: 'quick', autoStart: false }); await connected.start(); }
        else await connected.restore();
        // 重启后从当前 OAuth 存储恢复授权摘要，避免把仍有效的连接显示成“未检测”。
        const existingGrants = mcp.oauth.grants();
        const activeGrants = existingGrants.filter(grant => grant.status === 'active');
        if (existingGrants.length) connected.observeOAuth({ status: activeGrants.length ? 'authorized' : 'paused', clientName: (activeGrants.at(-1) ?? existingGrants.at(-1))?.clientName });
      };
      const bindIdentity = () => watchIdentity(mcp.access, () => mcp.oauth.revoke());
      let offIdentity = bindIdentity();
      const offEvents = runtime.onEvent(event => {
        if (event.type === 'plugin.ready' && event.pluginId === 'connection') void bindConnection().catch(error => console.error(`Capyra: ${error instanceof Error ? error.message : '连接初始化失败'}`));
        if (event.type === 'plugin.ready' && event.pluginId === 'identity') { offIdentity?.(); offIdentity = bindIdentity(); }
        if (event.type === 'plugin.disabled' && event.pluginId === 'identity') { mcp.access.cancelOwner(); mcp.oauth.revoke(); void runtime!.cancelOwner(); }
      });
      const stopMcp = closeMcp;
      closeMcp = async () => { offIdentity?.(); offEvents(); await stopMcp(); };
      await bindConnection();
    }
    if (approvalAccess && control && config.plugins.some(plugin => plugin.id === 'identity')) {
      // 手机和本机都消费同一份单次请求；身份服务停用、暂停或关闭会中止同步与旧决定。
      const { createApprovalRelay } = await import('./identity/approval-relay.js');
      const relay = createApprovalRelay({ runtime, access: approvalAccess, identity });
      closeApprovalRelay = () => relay.close();
    }
    if (control) config.controlPort = Number(new URL(control.url).port);
    await instanceLock.publish(control ? config.controlPort : undefined, mcpProvider && !values.stdio ? config.port : undefined);
    startupComplete = true;
    if (values.stdio && (stdinEnded || process.stdin.readableEnded)) { await shutdown(); return; }
    const log = values.stdio ? console.error : console.log;
    log(`\n  Capyra 0.5.2\n  工作区   ${config.workspace}\n  控制台   ${control?.url ?? '未启用'}\n  MCP      ${!mcpProvider ? '未启用' : values.stdio ? 'stdio' : `${config.publicUrl ?? `http://127.0.0.1:${config.port}`}/mcp`}\n  能力     ${runtime.listTools().length} 个工具 · ${config.exposure === 'compact' ? '精简目录' : '直接展示'}\n`);
    for (const plugin of runtime.listPlugins()) if (plugin.status === 'error') log(`  插件 ${plugin.id} 未加载：${plugin.error}`);
    if (!control) log('  本机工作台未启用；MCP 协议入口可用，需要本机批准的请求将立即被拒绝。启用 console 插件后可完成授权和请求审批。\n');
    else if (!mcpProvider) log('  本机工作台已就绪；MCP 插件未启用，客户端连接入口已关闭。\n');
    else if (!values.stdio && !config.publicUrl) log(config.plugins.some(plugin => plugin.id === 'identity')
      ? '  已可在本机使用。打开控制台的连接向导，登录、绑定本机并连接 ChatGPT。\n'
      : '  已可在本机使用。打开控制台的连接向导连接 ChatGPT；默认个人模式，需要时可开启共享账号保护。\n');
    if (values.open) { if (control) openBrowser(control.openUrl); else log('  无法自动打开：本机工作台未启用。'); }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
  } catch (error) { await shutdown(); throw error; }
}

async function acquireLock(stateDir: string): Promise<{ release(): Promise<void>; publish(controlPort?: number, mcpPort?: number): Promise<void> }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if ((await lstat(stateDir)).isSymbolicLink()) throw new Error('状态目录不能为软链接');
  const path = resolve(stateDir, 'runtime.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(path, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await lstat(path)).isSymbolicLink()) throw new Error('实例锁无效');
      const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
      try { process.kill(previous.pid, 0); throw new Error('此工作区的 Capyra 已在运行。请打开本机控制台。'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      if (attempt === 1) throw new Error('无法取得工作区实例锁');
      await unlink(path);
    }
  }
  return {
    async release() { try { const current = JSON.parse(await readFile(path, 'utf8')); if (current.nonce === nonce) await unlink(path); } catch {} },
    async publish(controlPort, mcpPort) {
      const current = JSON.parse(await readFile(path, 'utf8')); if (current.nonce !== nonce) throw new Error('当前实例锁已变化');
      const temporary = resolve(stateDir, `.runtime-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify({ ...current, endpoints: { controlPort, mcpPort } }), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    },
  };
}

async function runningControlPort(stateDir: string, configuredPort: number): Promise<number> {
  return runningEndpointPort(stateDir, 'controlPort', configuredPort);
}
async function runningEndpointPort(stateDir: string, key: 'controlPort' | 'mcpPort', configuredPort: number): Promise<number> {
  try {
    const filename = resolve(stateDir, 'runtime.lock');
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('实例锁无效');
    const running = JSON.parse(await readFile(filename, 'utf8'));
    if (!Number.isSafeInteger(running.pid) || running.pid < 1) throw new Error('实例锁无效');
    process.kill(running.pid, 0);
    if (running.endpoints) {
      const port = running.endpoints[key];
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(key === 'controlPort' ? '当前实例未启用本机工作台。' : '当前实例未启用 MCP HTTP 入口。');
      return port;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!configuredPort) throw new Error(key === 'controlPort' ? '尚未找到运行中的本机工作台，请先运行 capyra start --open。' : '尚未找到运行中的 MCP HTTP 入口。');
  return configuredPort;
}

async function doctorChecks(workspace: string, gitRequired: boolean, shellRequired: boolean) {
  const started = performance.now(), execute = promisify(execFile);
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'LANG', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const probe = async (command: string, args: string[]) => {
    try {
      const { stdout, stderr } = await execute(command, args, { timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 16_384, windowsHide: true, env: environment });
      return { status: 'ok' as const, command, version: (stdout || stderr).trim().split(/\r?\n/)[0].slice(0, 200) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      return { status: failure.code === 'ENOENT' ? 'missing' as const : 'error' as const, command, reason: failure.killed ? '检查超过 2500ms，已停止。' : failure.code === 'ENOENT' ? '未找到可执行文件。' : '命令版本检查未通过。' };
    }
  };
  const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh';
  const name = shell.split(/[\\/]/).at(-1)?.toLowerCase();
  const shellArgs = name === 'cmd.exe' || name === 'cmd' ? ['/d', '/c', 'ver'] : name === 'pwsh' || name === 'powershell.exe' || name === 'powershell'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
    : name === 'sh' || name === 'dash' ? ['-c', 'printf "%s\\n" "${BASH_VERSION:-${ZSH_VERSION:-POSIX-compatible shell}}"'] : ['--version'];
  const permission = async (mode: number) => { try { await access(workspace, mode); return true; } catch { return false; } };
  const [git, shellCheck, sqlite, readable, writable, directory] = await Promise.all([
    probe('git', ['--version']), probe(shell, shellArgs),
    // SQLite只在独立进程内打开内存数据库，不加载业务插件、不创建数据库文件。
    probe(process.execPath, ['--no-warnings', '--input-type=module', '-e', 'const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(":memory:");try{console.log(db.prepare("select sqlite_version() as version").get().version)}finally{db.close()}']),
    permission(constants.R_OK), permission(constants.W_OK), stat(workspace).then(value => value.isDirectory()).catch(() => false),
  ]);
  return { git: { ...git, required: gitRequired }, shell: { ...shellCheck, required: shellRequired }, sqlite: { ...sqlite, required: false, provider: 'node:sqlite', note: '可选存储扩展；默认 JSON 存储无需 SQLite。' },
    workspace: { directory, readable, writable, verification: '系统权限检查；没有创建或修改文件。' }, elapsedMs: Math.round(performance.now() - started) };
}

async function managePlugin(configPath: string, args: string[]) {
  let config: typeof defaults & { plugins: Array<Record<string, unknown>> };
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; config = structuredClone(defaults) as typeof config; }
  const [action, target] = args;
  const print = (value: unknown, message?: string) => console.log(values.json || !message ? JSON.stringify(value, null, 2) : message);
  if (action === 'spec') { print(pluginAuthoringSpec); return; }
  if (action === 'create') {
    const id = target;
    if (!id) throw new Error('用法：capyra plugin create ID --prompt TEXT [--title TITLE] [--dir DIRECTORY]');
    const rootDirectory = values.dir ? resolve(values.dir) : resolve(dirname(configPath), 'capyra-plugins', id);
    const brief = values.prompt?.trim();
    const created = await createPluginProject({ rootDirectory, id, title: values.title?.trim() || id, description: values.description?.trim() || brief?.slice(0, 2000) || `${id} Capyra plugin`, brief });
    const report = await validatePluginProject(created.rootDirectory);
    if (!report.ok) throw new Error(`插件模板创建后校验失败：${report.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
    print({ ...created, validation: report, developmentPrompt: pluginDevelopmentPrompt(created.rootDirectory) }, `已创建 ${created.rootDirectory}\n当前 ChatGPT 对话可直接按 developmentPrompt 继续开发；也可按需交给编码代理。`);
    return;
  }
  if (action === 'validate') {
    if (!target) throw new Error('用法：capyra plugin validate PATH [--json]');
    const report = await validatePluginProject(resolve(target)); print(report, report.ok ? '插件预检通过。' : `插件预检失败：\n${report.diagnostics.map(item => `${item.severity} ${item.code}: ${item.message}${item.hint ? ` ${item.hint}` : ''}`).join('\n')}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'inspect') {
    const entry = config.plugins.find(plugin => plugin.id === target) as Record<string, unknown> | undefined;
    if (!entry) throw new Error('插件未配置');
    const module = String(entry.module ?? `builtin:${entry.id}`);
    const candidate = isAbsolute(module) ? resolve(module) : undefined;
    let validation;
    if (candidate) {
      const manifest = resolve(dirname(candidate), 'capyra.plugin.json');
      validation = await validatePluginProject(await access(manifest, constants.R_OK).then(() => dirname(candidate)).catch(() => candidate));
    }
    print({ config: entry, validation: validation ?? null }); return;
  }
  if (action === 'add' || action === 'install') {
    if (!target) throw new Error(action === 'install' ? '用法：capyra plugin install PATH [--grant PERMISSION]' : '用法：capyra plugin add FILE --id ID');
    const report = await validatePluginProject(resolve(target));
    if (!report.ok || !report.entryPath || !report.plugin) throw new Error(`插件预检失败：${report.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join(', ')}`);
    const id = values.id ?? report.manifest?.id ?? report.plugin.id;
    if (!id || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || id !== report.plugin.id) throw new Error('插件 ID 缺失或与模块导出不一致');
    if (config.plugins.some(p => p.id === id)) throw new Error('插件 ID 已存在');
    const declared = new Set(report.plugin.permissions);
    const grants = values.grant ?? [];
    if (grants.some(permission => !declared.has(permission))) throw new Error('不能授予插件未声明的权限');
    config.plugins.push({ id, module: report.entryPath, ...(report.manifestPath ? { manifest: report.manifestPath } : {}), requestedPermissions: report.plugin.permissions, enabled: false, grants, config: {} } as never);
  } else if (action === 'enable' || action === 'disable') {
    const plugin = config.plugins.find(p => p.id === target);
    if (!plugin) throw new Error('插件未配置'); plugin.enabled = action === 'enable';
  } else throw new Error('用法：capyra plugin create|spec|validate|install|inspect|add|enable|disable');
  const temp = resolve(dirname(configPath), `.capyra-config-${randomUUID()}.tmp`);
  try { await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, configPath); }
  finally { await unlink(temp).catch(() => {}); }
  print({ configPath, action, id: target }, `已更新 ${configPath}。启动配置会在下次运行时生效。`);
}

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true }); child.on('error', () => console.error(`请手动打开 ${url}`)); child.unref();
}

void main().catch(error => { console.error(`Capyra: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
