#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  target: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' },
  combination: { type: 'string', default: 'default' }, label: { type: 'string' },
  samples: { type: 'string', default: '3' }, 'idle-seconds': { type: 'string', default: '30' },
  'warmup-seconds': { type: 'string', default: '15' },
  exposure: { type: 'string' },
  'config-template': { type: 'string' }, 'package-tgz': { type: 'string' }, commit: { type: 'string' },
  'extensions-root': { type: 'string' },
  'catalog-only': { type: 'boolean' },
  'context-probe': { type: 'boolean' },
  'cli-check': { type: 'boolean' },
  'require-native-file-tool': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help || !values.target || !values.root) {
  console.log(`Usage: node scripts/benchmark.mjs --target devspace|capyra --root INSTALLED_PACKAGE
  --combination default|full|compact|empty --samples 3 --warmup-seconds 15 --idle-seconds 30
  --output REPORT.json [--config-template CONFIG.json] [--package-tgz PACKAGE.tgz]
  [--exposure direct|compact]
  [--extensions-root INSTALLED_OPTIONAL_SDK_DIRECTORY]
  [--catalog-only]  # one discovery check, without repeating idle measurements
  [--context-probe] # read only the generated README fixture through actual MCP tools
  [--cli-check]     # validate actual init, version and doctor commands (Capyra only)
  [--require-native-file-tool NAME] # require the real file descriptor in tools/list
  [--commit SOURCE_SHA] [--label NAME]

Runs built production CLI with generated temporary config/state and local OAuth.
Only initializes MCP and lists tools unless context-probe is selected; no agents or user files are accessed.
Config templates must be benchmark-owned and contain no credentials or user data.
Reports UTF-8 bytes and Unicode character counts, not model tokens or billing.
The caller should run repeated measurements in a codex-prefixed tmux session.`);
  process.exit(values.help ? 0 : 2);
}
const target = values.target;
const root = path.resolve(values.root);
const combination = values.combination;
const catalogOnly = values['catalog-only'] ?? false;
const samples = catalogOnly ? 1 : Number(values.samples);
const idleSeconds = catalogOnly ? 0 : Number(values['idle-seconds']);
const warmupSeconds = catalogOnly ? 0 : Number(values['warmup-seconds']);
if (!['devspace', 'capyra'].includes(target)) throw new Error('Unknown target');
if (values.exposure && !['direct', 'compact'].includes(values.exposure)) throw new Error('exposure must be direct or compact');
if (target === 'devspace' && values.exposure) throw new Error('DevSpace does not support Capyra exposure modes');
if (target !== 'capyra' && values['cli-check']) throw new Error('cli-check is a Capyra option');
if (process.platform === 'win32') throw new Error('This ps/du benchmark supports macOS and Linux; Windows measurement needs a platform adapter');
if (!['default', 'full', 'compact', 'empty'].includes(combination)) throw new Error('Unknown combination');
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('samples must be 1–30');
if (!catalogOnly && (!Number.isFinite(idleSeconds) || idleSeconds < 3 || idleSeconds > 300)) throw new Error('idle-seconds must be 3–300');
if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0 || warmupSeconds > 300) throw new Error('warmup-seconds must be 0–300');
if (target === 'devspace' && ['empty', 'compact'].includes(combination)) throw new Error('DevSpace has no equivalent empty/compact preset');
const template = values['config-template'] ? JSON.parse(await readFile(path.resolve(values['config-template']), 'utf8')) : undefined;
const capyraDefaults = target === 'capyra' ? (await import(pathToFileURL(path.join(root, 'dist/config.js')).href)).defaults : undefined;
const extensionsRoot = values['extensions-root'] ? path.resolve(values['extensions-root']) : undefined;
if (extensionsRoot && target !== 'capyra') throw new Error('extensions-root is a Capyra option');
if (target === 'capyra' && combination === 'full' && !template?.plugins) throw new Error('Capyra full preset requires --config-template documenting the exact plugin combination');
const sha = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const exists = async name => access(name).then(() => true, () => false);
const sizeOf = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { utf8Bytes: Buffer.byteLength(text), unicodeCharacters: [...text].length, sha256: sha(text) };
};
const controlCookies = new Map();

// 只继承定位基础程序所需的环境，避免真实模型凭据进入被测服务。
function cleanEnvironment(temp) {
  return {
    PATH: [...new Set([path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', TMPDIR: temp,
    DEVSPACE_CONFIG_DIR: path.join(temp, 'config'),
    CODEX_HOME: path.join(temp, 'agent-home'),
    PI_CODING_AGENT_DIR: path.join(temp, 'pi-home'),
    NO_COLOR: '1',
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function treeSize(directory) {
  const inodes = new Set();
  let logicalBytes = 0;
  let files = 0;
  const dependencies = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const filename = path.join(current, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(filename); continue; }
      if (!info.isFile()) continue;
      const key = `${info.dev}:${info.ino}`;
      if (!inodes.has(key)) { inodes.add(key); logicalBytes += info.size; files++; }
      if (/[/\\]node_modules[/\\](?:@[^/\\]+[/\\])?[^/\\]+[/\\]package\.json$/.test(filename)) {
        try {
          const item = JSON.parse(await readFile(filename, 'utf8'));
          if (item.name && item.version) dependencies.set(`${item.name}@${item.version}`, { name: item.name, version: item.version });
        } catch { /* 非有效依赖manifest不计入依赖目录，不影响体积。 */ }
      }
    }
  }
  await walk(directory);
  let allocatedBytes = null;
  try { allocatedBytes = Number((await exec('du', ['-sk', directory])).stdout.trim().split(/\s+/)[0]) * 1024; } catch {}
  return { logicalBytes, allocatedBytes, files, installedPackages: [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)) };
}

async function installedInventory() {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const total = await treeSize(root);
  const modules = await treeSize(path.join(root, 'node_modules'));
  const lockfiles = {};
  for (const file of ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml']) {
    if (await exists(path.join(root, file))) lockfiles[file] = sha(await readFile(path.join(root, file)));
  }
  const build = createHash('sha256');
  async function hashBuild(directory, hash = build) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashBuild(filename, hash);
      else if (entry.isFile()) { hash.update(path.relative(root, filename)); hash.update('\0'); hash.update(await readFile(filename)); }
    }
  }
  await hashBuild(path.join(root, 'dist'));
  const runtimeAssets = createHash('sha256');
  for (const directory of ['dist', 'public', 'cloud']) if (await exists(path.join(root, directory))) await hashBuild(path.join(root, directory), runtimeAssets);
  const extensions = extensionsRoot ? await treeSize(extensionsRoot) : undefined;
  let shrinkwrapConformance;
  if (lockfiles['npm-shrinkwrap.json']) {
    const lock = JSON.parse(await readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
    const locked = new Set(Object.entries(lock.packages ?? {}).filter(([name]) => name.includes('node_modules/')).map(([name, entry]) => `${entry.name ?? name.split('node_modules/').at(-1)}@${entry.version}`));
    const unexpected = modules.installedPackages.filter(entry => !locked.has(`${entry.name}@${entry.version}`));
    shrinkwrapConformance = { lockfileVersion: lock.lockfileVersion, allInstalledVersionsInLock: unexpected.length === 0, unexpectedInstalledVersions: unexpected, note: 'Checks installed name/version membership; npm ci additionally validates lock and tarball integrity.' };
    if (unexpected.length) throw new Error('Installed package versions do not match the published npm shrinkwrap');
  }
  return {
    package: { name: packageJson.name, version: packageJson.version, engines: packageJson.engines },
    sourceCommit: values.commit ?? null, buildSha256: build.digest('hex'), runtimeAssetsSha256: runtimeAssets.digest('hex'), runtimeAssetsScope: 'sorted relative paths and file bytes in dist, public and cloud; excludes docs and metadata', lockfiles,
    manifest: { productionDependencies: packageJson.dependencies ?? {}, optionalDependencies: packageJson.optionalDependencies ?? {} },
    ...(shrinkwrapConformance ? { shrinkwrapConformance } : {}),
    packageTgz: values['package-tgz'] ? { bytes: (await stat(values['package-tgz'])).size, sha256: sha(await readFile(values['package-tgz'])) } : null,
    installation: { rootLogicalBytes: total.logicalBytes, rootAllocatedBytes: total.allocatedBytes, rootFiles: total.files, nodeModulesLogicalBytes: modules.logicalBytes, nodeModulesAllocatedBytes: modules.allocatedBytes, installedPackageVersions: modules.installedPackages.length, packages: modules.installedPackages },
    containsSourceCheckout: await exists(path.join(root, 'src')),
    optionalRuntimePresence: { nodePty: await exists(path.join(root, 'node_modules/node-pty')) },
    ...(extensions ? { extensions: { logicalBytes: extensions.logicalBytes, allocatedBytes: extensions.allocatedBytes, installedPackageVersions: extensions.installedPackages.length, packages: extensions.installedPackages, manifest: JSON.parse(await readFile(path.join(extensionsRoot, 'package.json'), 'utf8')), lockSha256: sha(await readFile(path.join(extensionsRoot, 'pnpm-lock.yaml'))), combinedLogicalBytes: total.logicalBytes + extensions.logicalBytes, combinedAllocatedBytes: total.allocatedBytes + extensions.allocatedBytes } } : {}),
  };
}

function cpuSeconds(text) {
  const [dayPart, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock.split(':').map(Number);
  return Number(dayPart) * 86400 + parts.reduce((value, part) => value * 60 + part, 0);
}

async function processTree(pid) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
  const rows = stdout.trim().split('\n').map(line => {
    const [id, parent, rss, cpu] = line.trim().split(/\s+/);
    return { pid: Number(id), parentPid: Number(parent), rssBytes: Number(rss) * 1024, cpuSeconds: cpuSeconds(cpu) };
  });
  const owned = new Set([pid]);
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.parentPid)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  const selected = rows.filter(row => owned.has(row.pid));
  return { atMonotonicMs: performance.now(), count: selected.length, rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0), cpuSeconds: selected.reduce((sum, row) => sum + row.cpuSeconds, 0) };
}

async function jsonFetch(url, options = {}) {
  const origin = new URL(url).origin;
  const cookie = controlCookies.get(origin);
  const headers = { ...(cookie ? { Cookie: cookie, 'X-Capyra-Local': '1', Origin: origin } : {}), ...options.headers };
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'manual', ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}`);
  return { response, value: text ? JSON.parse(text) : undefined };
}
const postJson = (url, body, headers = {}) => jsonFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const postForm = (url, body) => jsonFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

async function bootstrapControl(control, openerFile) {
  const deadline = performance.now() + 10_000;
  while (!await exists(openerFile) && performance.now() < deadline) await delay(25);
  const url = new URL(await readFile(openerFile, 'utf8'));
  if (url.origin !== control) throw new Error('Captured opener URL does not match this benchmark console');
  const nonce = new URLSearchParams(url.hash.slice(1)).get('bootstrap');
  if (!nonce) throw new Error('CLI opener did not receive a bootstrap nonce');
  const response = (await postJson(`${control}/api/bootstrap`, { nonce }, { 'X-Capyra-Local': '1', Origin: control })).response;
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Local bootstrap did not issue a control session');
  controlCookies.set(control, cookie);
}

async function bindBenchmarkDevice(control, cloudUrl, workspace) {
  await postJson(`${control}/api/services/identity/configure`, { cloudUrl });
  await postJson(`${control}/api/services/identity/register`, { email: 'cost-fixture@example.test', password: randomBytes(32).toString('base64url') });
  const pairing = (await postJson(`${control}/api/services/identity/startPairing`, {})).value;
  const bound = (await postJson(`${control}/api/services/identity/bind`, { code: pairing.code, name: 'Performance fixture', scope: { workspaces: [workspace], capabilities: ['*'] } })).value;
  if (!bound.active) throw new Error('Temporary benchmark device did not become active');
}

async function withCatalogApproval(control, operation, method = 'tools/list', taskTool) {
  let settled = false;
  const pending = operation();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const deadline = performance.now() + 30_000;
  while (!settled && performance.now() < deadline) {
    const state = (await jsonFetch(`${control}/api/state`)).value;
    for (const request of state.accessRequests ?? []) {
      if (request.method === method) await postJson(`${control}/api/access/${encodeURIComponent(request.id)}/decide`, { approve: true, resultVisibility: 'client' });
    }
    // 仅批准本次合成文件的只读任务，仍通过产品的独立本机审批入口。
    if (taskTool) for (const task of state.tasks ?? []) {
      if (task.tool === taskTool && task.status === 'awaiting_approval') await postJson(`${control}/api/tasks/${encodeURIComponent(task.id)}/approve`, { approve: true, resultVisibility: 'client' });
    }
    if (!settled) await delay(25);
  }
  return pending;
}

async function authorize(base, control, ownerToken) {
  const metadata = (await jsonFetch(`${base}/.well-known/oauth-authorization-server`)).value;
  const callback = 'http://127.0.0.1/capyra-benchmark-callback';
  const client = (await postJson(metadata.registration_endpoint, { client_name: 'Capyra performance benchmark', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })).value;
  const verifier = randomBytes(32).toString('base64url');
  const fields = { client_id: client.client_id, redirect_uri: callback, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: target === 'devspace' ? 'devspace' : 'mcp', state: 'performance-fixture', resource: `${base}/mcp` };
  let code;
  if (target === 'devspace') {
    const response = await fetch(metadata.authorization_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, owner_token: ownerToken }), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    await response.arrayBuffer();
    if (response.status !== 302) throw new Error(`Temporary reference OAuth approval returned HTTP ${response.status}`);
    code = new URL(response.headers.get('location')).searchParams.get('code');
  } else {
    const url = new URL(metadata.authorization_endpoint); url.search = new URLSearchParams(fields).toString();
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Temporary Capyra OAuth request returned HTTP ${response.status}`);
    const state = (await jsonFetch(`${control}/api/state`, { headers: { 'X-Capyra-Local': '1' } })).value;
    const request = state.authorizations?.find(item => item.clientName === 'Capyra performance benchmark') ?? state.authorizations?.at(-1);
    if (!request?.id) throw new Error('Benchmark OAuth request was not visible in the private control API');
    await postJson(`${control}/api/oauth/${encodeURIComponent(request.id)}/decide`, { approve: true }, { 'X-Capyra-Local': '1', Origin: control });
    const pending = (await jsonFetch(`${base}/oauth/pending/${encodeURIComponent(request.id)}`)).value;
    code = new URL(pending.redirect).searchParams.get('code');
  }
  const tokens = (await postForm(metadata.token_endpoint, { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, resource: `${base}/mcp`, code, code_verifier: verifier })).value;
  if (!tokens.access_token) throw new Error('No temporary access token issued');
  return tokens.access_token;
}

async function rpc(url, token, body, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${body.method} returned HTTP ${response.status}`);
  let value;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = text.split(/\r?\n\r?\n/).map(item => item.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean);
    value = events.map(item => JSON.parse(item)).find(item => item.id === body.id);
  } else value = text ? JSON.parse(text) : undefined;
  if (value?.error) throw new Error(`MCP ${body.method}: ${value.error.code} ${value.error.message}`);
  return { value, sessionId: response.headers.get('mcp-session-id') ?? sessionId, responseBytes: Buffer.byteLength(text), requestBytes: Buffer.byteLength(JSON.stringify(body)) };
}

async function catalog(base, control, ownerToken, workspace) {
  const token = await authorize(base, control, ownerToken);
  const initialized = await rpc(`${base}/mcp`, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'capyra-benchmark', version: '1' } } });
  await rpc(`${base}/mcp`, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, initialized.sessionId);
  const list = () => rpc(`${base}/mcp`, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, initialized.sessionId);
  const listing = target === 'capyra' ? await withCatalogApproval(control, list) : await list();
  const tools = listing.value?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('MCP tools/list did not return an array');
  if (values['require-native-file-tool']) {
    const descriptor = tools.find(tool => tool.name === values['require-native-file-tool']);
    const fields = descriptor?._meta?.['openai/fileParams'];
    if (!Array.isArray(fields) || !fields.length || fields.some(name => typeof name !== 'string' || !Object.hasOwn(descriptor.inputSchema?.properties ?? {}, name))) throw new Error('Required native file tool is missing its valid file-binding descriptor');
  }
  let availableLocalTools;
  let optionalAvailability;
  let exposure;
  if (target === 'capyra') {
    const state = (await jsonFetch(`${control}/api/state`)).value;
    const failed = state.plugins.filter(plugin => ['error', 'loading'].includes(plugin.status));
    if (failed.length) throw new Error(`Configured plugins are not ready: ${failed.map(plugin => `${plugin.id}:${plugin.status}`).join(', ')}`);
    availableLocalTools = state.tools.length;
    exposure = state.config.exposure;
    if (state.config.exposure === 'direct' && tools.length !== availableLocalTools + 2) throw new Error('Direct MCP catalog is withheld or incomplete; do not treat it as a context saving');
    if (state.config.exposure === 'compact' && tools.length < 4) throw new Error('Compact MCP catalog is incomplete');
    for (const tool of state.tools.filter(tool => tool.pluginId === 'client-ui')) if (!tools.some(item => item.name === tool.name)) throw new Error('MCP catalog withheld a configured client UI tool; complete request-specific sharing first');
    optionalAvailability = { terminal: state.services?.process?.terminal ? { available: state.services.process.terminal.available } : undefined,
      agents: state.services?.agents?.targets?.map(({ id, provider, available, integration, reason }) => ({ id, provider, available, integration, reason })) };
  }
  let contextProbe;
  if (values['context-probe']) {
    const calls = [];
    let id = 10;
    const call = async (name, args, taskTool) => {
      const operation = () => rpc(`${base}/mcp`, token, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }, initialized.sessionId);
      const response = target === 'capyra' ? await withCatalogApproval(control, operation, name, taskTool) : await operation();
      if (response.value?.result?.isError) throw new Error(`Synthetic context probe ${name} failed`);
      calls.push({ name, requestBytes: response.requestBytes, responseWireBytes: response.responseBytes, result: sizeOf(response.value.result) });
      return response.value.result;
    };
    let result;
    if (target === 'devspace') {
      const opened = await call('open_workspace', { path: workspace, mode: 'checkout' });
      const workspaceId = opened.structuredContent?.workspace_id;
      if (!workspaceId) throw new Error('Reference context probe did not return workspace_id');
      result = await call('read', { workspace_id: workspaceId, path: 'README.md' });
    } else {
      if (exposure === 'compact') {
        const found = await call('capyra_discover', { query: 'workspace__read' });
        if (!JSON.stringify(found).includes('workspace__read')) throw new Error('Synthetic file read was not discovered');
      }
      result = await call(exposure === 'compact' ? 'capyra_call' : 'workspace__read', exposure === 'compact' ? { tool: 'workspace__read', args: { path: 'README.md' } } : { path: 'README.md' }, 'workspace__read');
    }
    if (!JSON.stringify(result).includes('This directory contains no user data.')) throw new Error('Synthetic context probe did not return the fixture content');
    contextProbe = { task: 'Read the complete generated two-line README.md in a newly selected workspace', fixtureBytes: Buffer.byteLength(await readFile(path.join(workspace, 'README.md'))), contentVerified: true, calls, callRequestBytes: calls.reduce((n, c) => n + c.requestBytes, 0), callResponseWireBytes: calls.reduce((n, c) => n + c.responseWireBytes, 0), initialCatalogPlusCallResultsBytes: sizeOf(tools).utf8Bytes + calls.reduce((n, c) => n + c.result.utf8Bytes, 0), note: 'Serialized protocol content for one scripted read; does not include model reasoning, tokenizer costs, HTTP headers, account pairing, or local approval traffic. Reference includes workspace opening; Capyra uses its configured workspace.' };
  }
  return {
    requestedProtocol: '2025-11-25', negotiatedProtocol: initialized.value.result.protocolVersion,
    tools: tools.map(tool => tool.name), toolCount: tools.length,
    nativeClientDescriptors: tools.filter(tool => tool._meta?.ui?.resourceUri || tool._meta?.['openai/fileParams']).map(tool => ({ name: tool.name, fileParams: tool._meta?.['openai/fileParams'], uiResourceUri: tool._meta?.ui?.resourceUri })),
    toolCatalog: sizeOf(tools), toolListResult: sizeOf(listing.value.result),
    initializationInstructions: sizeOf(initialized.value.result.instructions ?? ''),
    initializationWireBytes: initialized.responseBytes,
    toolListWireBytes: listing.responseBytes,
    discoveryRequestBytes: initialized.requestBytes + listing.requestBytes,
    callsExecuted: contextProbe?.calls.length ?? 0,
    ...(contextProbe ? { contextProbe } : {}),
    ...(availableLocalTools !== undefined ? { availableLocalToolCount: availableLocalTools } : {}),
    ...(optionalAvailability ? { optionalAvailability } : {}),
    ...(target === 'capyra' ? { localApproval: 'one-use bootstrap, HttpOnly cookie, and request-bound catalog approval' } : {}),
  };
}

async function accountFixture(temp, environment) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(root, 'cloud/start.mjs')], { cwd: temp, env: { ...environment, CAPYRA_IDENTITY_STATE: path.join(temp, 'identity-cloud'), CAPYRA_IDENTITY_PORT: String(port), CAPYRA_IDENTITY_HOST: '127.0.0.1' }, detached: true, stdio: 'ignore' });
  try {
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Account fixture exited ${child.exitCode}`);
      try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) return { child, url, startupMs: round(performance.now() - started) }; } catch {}
      if (performance.now() - started > 15_000) throw new Error('Account fixture health timed out');
      await delay(25);
    }
  } catch (error) { await stop(child); throw error; }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = name => { try { process.kill(-child.pid, name); } catch {} };
  signal('SIGTERM');
  const ended = new Promise(resolve => child.once('exit', resolve));
  await Promise.race([ended, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { signal('SIGKILL'); await Promise.race([ended, delay(2000)]); }
}

async function measure(index) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'capyra-cost-sample-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace); await mkdir(path.join(temp, 'config'));
  await writeFile(path.join(workspace, 'README.md'), '# Performance fixture\nThis directory contains no user data.\n');
  const port = await freePort();
  let controlPort = await freePort();
  while (controlPort === port) controlPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const control = `http://127.0.0.1:${controlPort}`;
  const ownerToken = randomBytes(32).toString('base64url');
  const openerFile = path.join(temp, 'opener-url');
  let command;
  let config;
  let cliChecks;
  if (target === 'devspace') {
    config = { ...template, configVersion: 1,
      server: { ...template?.server, host: '127.0.0.1', port, publicBaseUrl: base },
      workspaces: { allowedRoots: [workspace], worktreeRoot: path.join(temp, 'worktrees') },
      storage: { stateDir: path.join(temp, 'state') }, tools: { mode: 'codex' },
      ui: { enabled: true },
      skills: { enabled: true, paths: [], agentDir: path.join(temp, 'agent-home') },
      artifacts: { enabled: combination === 'full' },
      subagents: { enabled: combination === 'full', providers: combination === 'full' ? ['codex', 'claude', 'opencode', 'pi', 'cursor', 'copilot', 'grok'].map(id => ({ id, enabled: true })) : [] },
    };
    await writeFile(path.join(temp, 'config/config.jsonc'), JSON.stringify(config), { mode: 0o600 });
    await writeFile(path.join(temp, 'config/auth.json'), JSON.stringify({ ownerToken }), { mode: 0o600 });
    command = [path.join(root, 'dist/cli.js'), 'serve'];
  } else {
    if (values['cli-check']) {
      const command = [path.join(root, 'dist/cli.js')];
      const options = { cwd: workspace, env: cleanEnvironment(temp), timeout: 15_000 };
      const filename = path.join(temp, 'config/capyra.json');
      const version = (await exec(process.execPath, [...command, '--version'], options)).stdout.trim();
      await exec(process.execPath, [...command, 'init', '--config', filename], options);
      const initial = await readFile(filename, 'utf8');
      let refused = false;
      try { await exec(process.execPath, [...command, 'init', '--config', filename], options); } catch (error) { refused = error.code === 1; }
      if (!refused || await readFile(filename, 'utf8') !== initial) throw new Error('CLI init did not preserve the existing fixture configuration');
      cliChecks = { version, init: { created: true, mode: (await stat(filename)).mode & 0o777, defaultPluginCount: JSON.parse(initial).plugins.length, repeatInitRefused: refused, existingConfigPreserved: true } };
    }
    const configured = { ...capyraDefaults, ...template };
    const infrastructure = new Set(['storage', 'policy', 'identity', 'connection', 'presentation', 'ui', 'mcp', 'console']);
    config = { ...configured, version: 1, workspace, stateDir: path.join(temp, 'state'), port, controlPort,
      exposure: values.exposure ?? (combination === 'compact' ? 'compact' : configured.exposure ?? 'direct'),
      plugins: combination === 'empty' ? configured.plugins.filter(entry => infrastructure.has(entry.id)) : configured.plugins,
    };
    config.plugins = config.plugins.map(entry => entry.id === 'agents'
      ? { ...entry, config: { ...entry.config, profileDirs: [path.join(temp, 'agent-profiles')] } }
      : entry.id === 'skills' ? { ...entry, config: { ...entry.config, paths: [] } } : entry);
    // CLI 的公网 origin 只允许 HTTPS；本地基准使用自动生成的 loopback OAuth issuer。
    delete config.publicUrl;
    if (extensionsRoot) {
      const extensionDir = path.join(workspace, '.capyra', 'extensions'); await mkdir(extensionDir, { recursive: true });
      // 同一安装的公开依赖可由多个提供者共享；只在本次私有状态树建立模块解析链接。
      for (const provider of ['terminal', 'claude', 'opencode', 'pi']) await symlink(extensionsRoot, path.join(extensionDir, provider), 'dir');
    }
    await writeFile(path.join(temp, 'config/capyra.json'), JSON.stringify(config), { mode: 0o600 });
    command = [path.join(root, 'dist/cli.js'), 'start', '--config', path.join(temp, 'config/capyra.json'), '--open'];
  }
  const environment = cleanEnvironment(temp);
  const doctor = async () => JSON.parse((await exec(process.execPath, [path.join(root, 'dist/cli.js'), 'doctor', '--config', path.join(temp, 'config/capyra.json')], { cwd: workspace, env: environment, timeout: 15_000 })).stdout);
  if (cliChecks) { cliChecks.doctorBeforeStart = await doctor(); if (cliChecks.doctorBeforeStart.running !== null) throw new Error('Fresh CLI doctor found an unexpected running instance'); }
  if (target === 'capyra') {
    // 只替被测子进程接收启动器URL，保留产品真实的一次性bootstrap和cookie校验。
    const openerDir = path.join(temp, 'opener-bin'); await mkdir(openerDir);
    const opener = `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPYRA_BENCH_OPEN_LOG, process.argv[2], { mode: 0o600 });\n`;
    for (const name of ['open', 'xdg-open']) await writeFile(path.join(openerDir, name), opener, { mode: 0o700 });
    environment.PATH = `${openerDir}${path.delimiter}${environment.PATH}`;
    environment.CAPYRA_BENCH_OPEN_LOG = openerFile;
  }
  let child;
  let fixture;
  let startupLog = '';
  try {
    const start = performance.now();
    child = spawn(process.execPath, command, { cwd: workspace, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { startupLog += error.message; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (startupLog.length < 16_384) startupLog += chunk.toString(); });
    const readyUrl = target === 'devspace' ? `${base}/healthz` : `${control}/health`;
    let ready = false;
    while (performance.now() - start < 60_000) {
      if (child.exitCode !== null) throw new Error(`Built CLI exited ${child.exitCode}: ${startupLog.replaceAll(ownerToken, '[redacted]')}`);
      try {
        const response = await fetch(readyUrl, { headers: target === 'capyra' ? { 'X-Capyra-Local': '1' } : {}, signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer(); if (response.ok) { ready = true; break; }
      } catch {}
      await delay(25);
    }
    if (!ready) throw new Error('Built CLI readiness timed out');
    const startupMs = performance.now() - start;
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'tools/list', params: {} }), signal: AbortSignal.timeout(1000) });
    await unauthorized.arrayBuffer();
    if (unauthorized.status !== 401) throw new Error(`Unauthenticated MCP probe returned ${unauthorized.status}, expected 401`);
    const startupToMcpResponseMs = performance.now() - start;
    if (cliChecks) { cliChecks.doctorAfterStart = await doctor(); if (!cliChecks.doctorAfterStart.running) throw new Error('CLI doctor did not detect the started instance'); }
    // 在授权与工具目录请求之前测空闲，避免把一次调用的分配混入默认空闲成本。
    await delay(warmupSeconds * 1000);
    const idle = [await processTree(child.pid)];
    const idleStart = performance.now();
    while (performance.now() - idleStart < idleSeconds * 1000) { await delay(1000); idle.push(await processTree(child.pid)); }
    const first = idle[0]; const last = idle.at(-1);
    const elapsedSeconds = (last.atMonotonicMs - first.atMonotonicMs) / 1000;
    let accountEvidence;
    if (target === 'capyra') {
      await bootstrapControl(control, openerFile);
      if (config.plugins.some(entry => entry.id === 'identity' && entry.enabled)) {
        fixture = await accountFixture(temp, environment);
        await bindBenchmarkDevice(control, fixture.url, workspace);
        const snapshot = await processTree(fixture.child.pid);
        accountEvidence = { kind: 'independent loopback account-service fixture', launchedAfterLocalIdle: true, includedInLocalRss: false, deviceBound: true, startupMs: fixture.startupMs, afterPairingRssBytes: snapshot.rssBytes, processCount: snapshot.count, note: 'Snapshot after local registration/pairing; not a settled cloud deployment benchmark.' };
      }
    }
    const discovery = await catalog(base, control, ownerToken, workspace);
    const afterDiscovery = await processTree(child.pid);
    return {
      index, startupMs: round(startupMs), startupToUnauthenticatedMcpMs: round(startupToMcpResponseMs),
      readinessPath: new URL(readyUrl).pathname, idleObservationSeconds: round(elapsedSeconds),
      idle: { measured: !catalogOnly, rssMedianBytes: median(idle.map(row => row.rssBytes)), rssMinBytes: Math.min(...idle.map(row => row.rssBytes)), rssMaxBytes: Math.max(...idle.map(row => row.rssBytes)), processCountMin: Math.min(...idle.map(row => row.count)), processCountMax: Math.max(...idle.map(row => row.count)), cpuSecondsDelta: round(last.cpuSeconds - first.cpuSeconds), cpuPercentOneCore: elapsedSeconds ? round(Math.max(0, last.cpuSeconds - first.cpuSeconds) / elapsedSeconds * 100) : null, samples: idle.map(({ atMonotonicMs, ...row }) => ({ elapsedMs: round(atMonotonicMs - first.atMonotonicMs), ...row })) },
      afterDiscovery: { rssBytes: afterDiscovery.rssBytes, processCount: afterDiscovery.count }, discovery,
      ...(cliChecks ? { cliChecks } : {}),
      ...(accountEvidence ? { accountFixture: accountEvidence } : {}),
      effectiveCombination: target === 'devspace' ? { toolMode: 'codex', uiEnabled: true, skillsEnabled: true, subagentsEnabled: combination === 'full', artifactsEnabled: combination === 'full', artifactsPlatformSupported: process.platform === 'linux', providerRuntimesStarted: false } : { exposure: config.exposure, optionalExtensionsInstalled: Boolean(extensionsRoot), userContext: 'empty benchmark-owned agent profiles and skill search paths', plugins: config.plugins.map(({ id, module, enabled, grants }) => ({ id, module, enabled, grants })) },
    };
  } finally { if (child) await stop(child); if (fixture) await stop(fixture.child); controlCookies.delete(control); await rm(temp, { recursive: true, force: true }); }
}

const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), label: values.label ?? `${target}-${combination}`, target, combination,
  measurementScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  environment: { platform: process.platform, architecture: process.arch, node: process.version, nodeExecutable: process.execPath, osRelease: os.release(), cpuModel: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytesAtStart: os.freemem(), loadAverageAtStart: os.loadavg() },
  methodology: { samples, idleSeconds, purpose: catalogOnly ? 'catalog-only; incidental timing and memory snapshots are not benchmark samples' : 'runtime and catalog benchmark', readinessPollMs: 25, idleSampleMs: 1000, warmupAfterReadyMs: warmupSeconds * 1000, apiActivityDuringIdle: false, paidProviderCalls: 0, userFilesRead: false, filesystemCache: 'not flushed; sequential warm-machine runs', memory: 'ps RSS sum for main process and current descendants; shared pages are not deduplicated', cpu: 'change in ps cumulative CPU time across the idle window, divided by wall time and one core; exited descendants may be undercounted', context: 'serialized MCP UTF-8 bytes and Unicode characters; no tokenizer, model invocation, token fee or end-to-end reasoning claim' },
  inventory: await installedInventory(), runs: [],
};
for (let i = 1; i <= samples; i++) {
  console.error(`[${report.label}] sample ${i}/${samples}`);
  try { report.runs.push(await measure(i)); }
  catch (error) {
    report.failure = { sample: i, error: error instanceof Error ? error.message : String(error) };
    if (values.output) { await mkdir(path.dirname(path.resolve(values.output)), { recursive: true }); await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n'); }
    throw error;
  }
  if (values.output) { await mkdir(path.dirname(path.resolve(values.output)), { recursive: true }); await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n'); }
}
report.summary = {
  ...(!catalogOnly ? {
  startupMedianMs: median(report.runs.map(run => run.startupMs)),
  startupToUnauthenticatedMcpMedianMs: median(report.runs.map(run => run.startupToUnauthenticatedMcpMs)),
  idleRssMedianBytes: median(report.runs.map(run => run.idle.rssMedianBytes)),
  idleCpuMedianPercentOneCore: median(report.runs.map(run => run.idle.cpuPercentOneCore)),
  idleProcessCountMax: Math.max(...report.runs.map(run => run.idle.processCountMax)),
  } : {}),
  toolCount: report.runs[0].discovery.toolCount,
  initialCatalogBytes: report.runs[0].discovery.toolCatalog.utf8Bytes,
};
if (values.output) await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
