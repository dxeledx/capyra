import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url)), project = path.dirname(path.dirname(cli));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Running = { child: ChildProcessWithoutNullStreams; output(): string; stdout(): string; done: Promise<number | null> };
async function fixture(t: { after(fn: () => Promise<void>): void }, plugins: unknown[], ports = { port: 0, controlPort: 0 }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'capyra-cli-')), filename = path.join(workspace, 'capyra.json'), running: Running[] = [];
  await writeFile(filename, JSON.stringify({ version: 1, workspace, exposure: 'compact', plugins, ...ports }), { mode: 0o600 });
  t.after(async () => { for (const process of running) await stop(process); await rm(workspace, { recursive: true, force: true }); });
  const launch = (args: string[] = ['start'], env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args, '--config', filename], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout = (stdout + data).slice(-64_000); }); child.stderr.on('data', data => { stderr = (stderr + data).slice(-64_000); });
    const done = new Promise<number | null>((resolve, reject) => { child.once('close', code => resolve(code)); child.once('error', reject); });
    const entry = { child, output: () => stdout + stderr, stdout: () => stdout, done }; running.push(entry); return entry;
  };
  return { workspace, filename, launch, lock: path.join(workspace, '.capyra', 'runtime.lock') };
}
async function stop(process: Running) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) { await process.done; return; }
  process.child.kill('SIGTERM'); const timer = setTimeout(() => process.child.kill('SIGKILL'), 3000);
  try { await process.done; } finally { clearTimeout(timer); }
}
async function ready(process: Running, pattern = /能力\s+\d+ 个工具/) {
  for (let i = 0; i < 750; i++) {
    if (pattern.test(process.output())) return;
    if (process.child.exitCode !== null || process.child.signalCode !== null) throw new Error(`CLI exited before startup: ${process.output()}`);
    await pause(20);
  }
  throw new Error(`CLI startup timed out: ${process.output()}`);
}
async function occupied(t: { after(fn: () => Promise<void>): void }) {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}
const adapter = (id: string, enabled = true) => ({ id, enabled, grants: [] });

test('CLI console-only honors disabled MCP and resolves port zero for both open commands', async t => {
  const occupiedMcp = await occupied(t), f = await fixture(t, [adapter('mcp', false), adapter('console')], { port: occupiedMcp, controlPort: 0 });
  const openLog = path.join(f.workspace, 'opened.txt');
  const opener = path.join(f.workspace, 'opener-probe.mjs');
  // 测试只替换操作系统浏览器启动，不打开用户真实浏览器；HTTP/open与一次性地址仍走实际CLI。
  await writeFile(opener, `import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';export default {apiVersion:1,id:'opener-probe',version:'1',title:'Browser probe',permissions:[],setup(ctx){const original=childProcess.spawn;childProcess.spawn=function(command,args,options){if(['open','xdg-open','explorer.exe'].includes(command)){appendFileSync(${JSON.stringify(openLog)},String(args[0])+'\\n');return {on(){return this},unref(){}}}return original(command,args,options)};syncBuiltinESMExports();ctx.onDispose(()=>{childProcess.spawn=original;syncBuiltinESMExports()})}};`);
  await writeFile(f.filename, JSON.stringify({ version: 1, workspace: f.workspace, port: occupiedMcp, controlPort: 0, plugins: [adapter('mcp', false), adapter('console'), { ...adapter('opener-probe'), module: opener }] }));
  const running = f.launch(['start', '--open']); await ready(running);
  assert.match(running.output(), /MCP\s+未启用/);
  const instance = JSON.parse(await readFile(f.lock, 'utf8'));
  assert.ok(instance.endpoints.controlPort > 0); assert.equal(instance.endpoints.mcpPort, undefined);
  const health = await fetch(`http://127.0.0.1:${instance.endpoints.controlPort}/health`); assert.equal(health.status, 200);
  const opened = f.launch(['open']); assert.equal(await opened.done, 0, opened.output());
  for (let i = 0; i < 100 && !(await readFile(openLog, 'utf8').catch(() => '')).includes('\nhttp'); i++) await pause(20);
  const urls = (await readFile(openLog, 'utf8')).trim().split('\n'); assert.equal(urls.length, 2);
  assert.equal(urls.every(url => url.startsWith(`http://127.0.0.1:${instance.endpoints.controlPort}/#bootstrap=`)), true);
  const origin = new URL(urls.at(-1)!).origin, headers = { 'X-Capyra-Local': '1', Origin: origin, 'Content-Type': 'application/json' };
  const bootstrap = await fetch(origin + '/api/bootstrap', { method: 'POST', headers, body: JSON.stringify({ nonce: new URL(urls.at(-1)!).hash.slice('#bootstrap='.length) }) });
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const enable = await fetch(origin + '/api/plugins/mcp', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ enabled: true }) });
  assert.equal(enable.status, 400); assert.match((await enable.json() as { error: string }).error, /更改需重启/);
  assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).endpoints.mcpPort, undefined);
  await stop(running); await assert.rejects(access(f.lock), { code: 'ENOENT' });
});

test('CLI MCP-only respects a disabled console and still answers protocol health', async t => {
  const occupiedControl = await occupied(t), f = await fixture(t, [adapter('mcp'), adapter('console', false)], { port: 0, controlPort: occupiedControl });
  const process = f.launch(['start', '--open']); await ready(process, /需要本机批准的请求将立即被拒绝/);
  assert.match(process.output(), /控制台\s+未启用/); assert.match(process.output(), /需要本机批准的请求将立即被拒绝/);
  const instance = JSON.parse(await readFile(f.lock, 'utf8'));
  assert.equal(instance.endpoints.controlPort, undefined); assert.ok(instance.endpoints.mcpPort > 0);
  const health = await fetch(`http://127.0.0.1:${instance.endpoints.mcpPort}/health`); assert.equal(health.status, 200);
  const doctor = f.launch(['doctor']); assert.equal(await doctor.done, 0, doctor.output()); const report = JSON.parse(doctor.stdout());
  assert.equal(report.mcp, `http://127.0.0.1:${instance.endpoints.mcpPort}/mcp`); assert.equal(report.console, null);
  const opened = f.launch(['open']); assert.equal(await opened.done, 1); assert.match(opened.output(), /工作台插件已停用/);
  await stop(process); await assert.rejects(access(f.lock), { code: 'ENOENT' });
});

test('explicit adapter load failure cannot trigger a built-in fallback', async t => {
  const occupiedMcp = await occupied(t), f = await fixture(t, [], { port: occupiedMcp, controlPort: 0 });
  const broken = path.join(f.workspace, 'broken.mjs');
  await writeFile(broken, `export default {apiVersion:1,id:'mcp',version:'1',title:'Broken MCP',permissions:[],setup(){throw new Error('fixture adapter failure')}};`);
  await writeFile(f.filename, JSON.stringify({ version: 1, workspace: f.workspace, port: occupiedMcp, controlPort: 0, plugins: [{ ...adapter('mcp'), module: broken }, adapter('console')] }));
  const process = f.launch(); await ready(process, /插件 mcp 未加载：fixture adapter failure/);
  assert.match(process.output(), /MCP\s+未启用/); assert.match(process.output(), /插件 mcp 未加载：fixture adapter failure/);
  assert.ok(JSON.parse(await readFile(f.lock, 'utf8')).endpoints.controlPort > 0);
});

test('no entrypoints and stdio with disabled MCP exit clearly and release the workspace lock', async t => {
  const f = await fixture(t, [adapter('mcp', false), adapter('console', false)]);
  const none = f.launch(); assert.equal(await none.done, 1); assert.match(none.output(), /没有可启动的入口/); await assert.rejects(access(f.lock), { code: 'ENOENT' });
  const stdio = f.launch(['start', '--stdio']); assert.equal(await stdio.done, 1); assert.match(stdio.output(), /--stdio 需要已启用且成功加载的 MCP 插件/);
  assert.equal(stdio.stdout(), ''); await assert.rejects(access(f.lock), { code: 'ENOENT' });
});

test('legacy configurations without transport entries retain the compatibility entrypoints', async t => {
  const f = await fixture(t, []), process = f.launch(); await ready(process);
  const endpoints = JSON.parse(await readFile(f.lock, 'utf8')).endpoints;
  assert.ok(endpoints.controlPort > 0 && endpoints.mcpPort > 0 && endpoints.controlPort !== endpoints.mcpPort);
  assert.equal((await fetch(`http://127.0.0.1:${endpoints.controlPort}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${endpoints.mcpPort}/health`)).status, 200);
});

test('MCP-only stdio keeps initialization and ping available while refusing unapproved data access', async t => {
  const f = await fixture(t, []), module = path.join(f.workspace, 'fixture.mjs'), marker = path.join(f.workspace, 'executed.txt');
  await writeFile(module, `import {writeFileSync} from 'node:fs';export default {apiVersion:1,id:'fixture',version:'1',title:'Fixture',permissions:[],setup(ctx){ctx.registerTool({name:'read',title:'Private read',description:'private',effect:'read',permissions:[],inputSchema:{type:'object',additionalProperties:false},execute(){writeFileSync(${JSON.stringify(marker)},'executed');return {content:[{type:'text',text:'private data'}]}}})}};`);
  await writeFile(f.filename, JSON.stringify({ version: 1, workspace: f.workspace, port: 0, controlPort: 0, exposure: 'compact', plugins: [adapter('mcp'), adapter('console', false), { ...adapter('fixture'), module }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'start', '--stdio', '--config', f.filename], cwd: project, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'cli-entrypoint-test', version: '1' }); t.after(() => client.close());
  await client.connect(transport); await client.ping();
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'capyra_discover'));
  const discovery = await client.callTool({ name: 'capyra_discover', arguments: {} }); assert.equal(JSON.parse((discovery.content as any[])[0].text).status, 'not_approved');
  const result = await client.callTool({ name: 'capyra_call', arguments: { tool: 'fixture__read', args: {} } });
  assert.equal(JSON.parse((result.content as any[])[0].text).status, 'cancelled');
  await assert.rejects(access(marker), { code: 'ENOENT' }); assert.match(stderr, /本机工作台未启用/);
  await client.close();
  for (let i = 0; i < 100 && await access(f.lock).then(() => true, () => false); i++) await pause(20);
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
});

test('CLI template diagnostics are silent by default and explicit enablement emits only short static summaries', async t => {
  for (const enabled of [false, true]) await t.test(enabled ? 'enabled' : 'default-off', async t => {
    const f = await fixture(t, []), module = path.join(f.workspace, 'shell.mjs');
    await writeFile(module, `export default {apiVersion:1,id:'shell',version:'1',title:'Shell',permissions:[],requires:['mcp'],setup(ctx){const uri='ui://PRIVATE_TEMPLATE_URI';ctx.onDispose(ctx.service('mcp.extensions').register('shell',{capabilities:{resources:{}},owns:(method,params)=>method==='resources/read'&&params.uri===uri,async handle(){throw Error('PRIVATE_DYNAMIC_ERROR')}},{publicUiTemplates:[{uri,mimeType:'text/html;profile=mcp-app',text:'<p>PRIVATE_TEMPLATE_BODY</p>'}]}))}};`);
    await writeFile(f.filename, JSON.stringify({ version: 1, workspace: f.workspace, port: 0, controlPort: 0, exposure: 'compact', plugins: [adapter('mcp'), adapter('console', false), { ...adapter('shell'), module }] }));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'start', '--stdio', '--config', f.filename], cwd: project, env: { ...process.env, CAPYRA_TEMPLATE_DIAGNOSTICS: enabled ? '1' : '' } as Record<string, string>, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'template-diagnostics-test', version: '1' }); t.after(() => client.close());
    await client.connect(transport); assert.equal((await client.readResource({ uri: 'ui://PRIVATE_TEMPLATE_URI' })).contents.length, 1); await client.close();
    const lines = stderr.split('\n').filter(line => line.startsWith('{"type":"capyra.template"'));
    assert.equal(lines.length, enabled ? 5 : 0);
    assert.doesNotMatch(lines.join('\n'), /PRIVATE|token|owner|workspace|headers|text|stack/i);
    for (const line of lines) { assert.ok(line.length < 320); assert.match(JSON.parse(line).templateSha256, /^[a-f0-9]{64}$/); }
  });
});

test('doctor probes real Git, shell and optional in-memory SQLite without starting services or writing workspace files', async t => {
  const f = await fixture(t, []), before = await readdir(f.workspace), check = f.launch(['doctor', '--json']);
  assert.equal(await check.done, 0, check.output()); const report = JSON.parse(check.stdout());
  assert.equal(report.checks.workspace.directory, true); assert.equal(report.checks.workspace.readable, true); assert.equal(report.checks.workspace.writable, true);
  assert.equal(report.checks.sqlite.required, false); assert.equal(report.checks.sqlite.provider, 'node:sqlite');
  for (const name of ['git', 'shell', 'sqlite']) assert.ok(['ok', 'missing', 'error'].includes(report.checks[name].status));
  assert.ok(report.checks.elapsedMs < 8000); assert.deepEqual(await readdir(f.workspace), before);
  const missing = f.launch(['doctor', '--json'], { PATH: '', SHELL: path.join(f.workspace, 'no-shell'), ComSpec: path.join(f.workspace, 'no-shell.exe') });
  assert.equal(await missing.done, 0, missing.output()); const unavailable = JSON.parse(missing.stdout());
  assert.equal(unavailable.checks.git.status, 'missing'); assert.equal(unavailable.checks.shell.status, 'missing'); assert.ok(unavailable.hints.length >= 2);
  assert.deepEqual(await readdir(f.workspace), before);
});

test('CLI startup adapters reject GUI toggles and configuration before closing listeners or changing persisted settings', async t => {
  const f = await fixture(t, []), consoleModule = path.join(f.workspace, 'console-observer.mjs'), businessModule = path.join(f.workspace, 'business.mjs');
  const opened = path.join(f.workspace, 'console-url'), activity = path.join(f.workspace, 'business-events');
  const builtin = new URL('../src/plugins/console.ts', import.meta.url).href;
  await writeFile(consoleModule, `import plugin from ${JSON.stringify(builtin)};import {writeFileSync} from 'node:fs';export default {...plugin,setup(ctx){return plugin.setup({...ctx,provide(name,service){if(name==='console.transport'){const start=service.start;service.start=async(...args)=>{const handle=await start(...args);writeFileSync(${JSON.stringify(opened)},handle.openUrl,{mode:0o600});return handle}}ctx.provide(name,service)}})}};`);
  await writeFile(businessModule, `import {appendFileSync} from 'node:fs';export default {apiVersion:1,id:'business',version:'1',title:'Business',permissions:[],setup(ctx){appendFileSync(${JSON.stringify(activity)},'setup:'+String(ctx.config.value??'initial')+'\\n');ctx.onDispose(()=>appendFileSync(${JSON.stringify(activity)},'dispose\\n'))}};`);
  await writeFile(f.filename, JSON.stringify({ version: 1, workspace: f.workspace, port: 0, controlPort: 0, plugins: [adapter('mcp'), { ...adapter('console'), module: consoleModule }, { ...adapter('business'), module: businessModule }] }));
  const initialConfig = await readFile(f.filename, 'utf8'), process = f.launch(); await ready(process);
  const url = new URL(await readFile(opened, 'utf8')), origin = url.origin;
  const headers = { 'X-Capyra-Local': '1', Origin: origin, 'Content-Type': 'application/json' };
  const bootstrap = await fetch(origin + '/api/bootstrap', { method: 'POST', headers, body: JSON.stringify({ nonce: url.hash.slice('#bootstrap='.length) }) });
  assert.equal(bootstrap.status, 200); const authenticated = { ...headers, Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0] };
  const endpoints = JSON.parse(await readFile(f.lock, 'utf8')).endpoints;
  for (const id of ['mcp', 'console']) {
    for (const [route, body] of [[`/api/plugins/${id}`, { enabled: false }], [`/api/plugins/${id}`, { enabled: true }], [`/api/plugins/${id}/config`, { config: { changed: true }, grants: [] }]] as const) {
      const response = await fetch(origin + route, { method: 'POST', headers: authenticated, body: JSON.stringify(body) });
      assert.equal(response.status, 400); const error = (await response.json() as { error: string }).error;
      assert.match(error, /更改需重启/); assert.ok(error.includes(`capyra plugin disable ${id}`)); assert.ok(error.includes(f.filename)); assert.match(error, /capyra start --config/);
    }
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${endpoints.mcpPort}/health`)).status, 200);
  }
  assert.equal(await readFile(f.filename, 'utf8'), initialConfig);
  const state = await (await fetch(origin + '/api/state', { headers: authenticated })).json() as { plugins: { id: string; enabled: boolean; status: string; restartRequired?: boolean; restartReason?: string }[] };
  for (const id of ['mcp', 'console']) { const entry = state.plugins.find(plugin => plugin.id === id)!; assert.equal(entry.enabled, true); assert.equal(entry.status, 'ready'); assert.equal(entry.restartRequired, true); assert.match(entry.restartReason!, /更改需重启/); }
  assert.equal(state.plugins.find(plugin => plugin.id === 'business')!.restartRequired, undefined);
  const changed = await fetch(origin + '/api/plugins/business/config', { method: 'POST', headers: authenticated, body: JSON.stringify({ config: { value: 'updated' } }) });
  assert.equal(changed.status, 200); assert.match(await readFile(activity, 'utf8'), /setup:initial\ndispose\nsetup:updated/);
  for (const enabled of [false, true]) assert.equal((await fetch(origin + '/api/plugins/business', { method: 'POST', headers: authenticated, body: JSON.stringify({ enabled }) })).status, 200);
  assert.equal((await fetch(origin + '/health')).status, 200); await stop(process); await assert.rejects(access(f.lock), { code: 'ENOENT' });
});
