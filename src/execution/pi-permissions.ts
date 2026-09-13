import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { isBlockedName } from '../plugins/workspace-paths.js';
import type { AgentRunInput } from './agent-drivers.js';
import type { ProcessSessions } from './sessions.js';
import { executionEnvironment } from './sessions.js';
import { agentWriteMode } from './agent-permissions.js';

const networkDomains = ['npmjs.org', '*.npmjs.org', 'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', '*.pypi.org', 'files.pythonhosted.org', 'github.com', '*.github.com', 'api.github.com', 'raw.githubusercontent.com', 'gitlab.com', '*.gitlab.com', 'bitbucket.org', '*.bitbucket.org', 'crates.io', '*.crates.io', 'rubygems.org', '*.rubygems.org'];
const pools = new Map<object, { refs: number; lifecycle: Promise<void> }>();
let windowsTurn = Promise.resolve();

export async function piWorkspacePath(input: string, workspace: string, missing = false): Promise<string> {
  const root = await realpath(workspace), selected = path.resolve(workspace), target = path.resolve(selected, input);
  let relative = path.relative(selected, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Pi path is outside the selected workspace');
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some(isBlockedName)) throw new Error('Pi path is protected');
  let current = root, absent = false;
  for (const segment of segments) {
    current = path.join(current, segment); if (absent) continue;
    try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error('Pi cannot follow symbolic links'); if (info.isFile() && info.nlink > 1) throw new Error('Pi cannot access hard-link aliases'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && missing) absent = true; else throw error; }
  }
  return current;
}
function filesystem(workspace: string, allowed: boolean) {
  return { allowRead: [], denyRead: ['.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.config/gcloud'].map(name => path.join(homedir(), name)).concat([path.join(workspace, '.capyra'), path.join(workspace, 'capyra.json'), path.join(workspace, 'capyra.local.json')]),
    allowWrite: allowed ? [workspace] : [], denyWrite: [path.join(workspace, '.capyra'), path.join(workspace, 'capyra.json'), path.join(workspace, 'capyra.local.json'), path.join(workspace, '.env'), path.join(workspace, '.env.local'), ...(!allowed ? [workspace] : [])] };
}
async function windowsLease(signal: AbortSignal): Promise<() => void> {
  const previous = windowsTurn; let release!: () => void;
  windowsTurn = new Promise(resolve => { release = resolve; });
  let abort!: () => void;
  try { await Promise.race([previous, new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Pi cancelled while waiting for Windows sandbox')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  catch (error) { void previous.then(release); throw error; }
  finally { signal.removeEventListener('abort', abort); }
  return release;
}

/** Pi 没有原生 OS 沙箱；受限模式使用可选 sandbox-runtime，初始化失败绝不回落到本机执行。 */
export async function restrictedPiTools(sdk: any, sandbox: any, sessions: ProcessSessions, input: AgentRunInput) {
  const mode = agentWriteMode(input.writeMode), writable = mode === 'allowed';
  if (mode === 'full_access') return { tools: undefined, release: async () => {} };
  const manager = sandbox.SandboxManager;
  if (!manager || !['initialize', 'wrapWithSandboxArgv', 'cleanupAfterCommand', 'reset'].every(name => typeof manager[name] === 'function')) throw new Error('Pi restricted mode needs a compatible @anthropic-ai/sandbox-runtime');
  const unlock = process.platform === 'win32' ? await windowsLease(input.signal) : () => {};
  let entry = pools.get(manager);
  if (!entry) { entry = { refs: 0, lifecycle: Promise.resolve() }; pools.set(manager, entry); }
  if (entry.refs++ === 0) entry.lifecycle = entry.lifecycle.catch(() => {}).then(() => manager.initialize({
    network: { allowedDomains: networkDomains, deniedDomains: [], strictAllowlist: true },
    filesystem: process.platform === 'win32' ? filesystem(input.cwd, writable) : { ...filesystem('/', false), denyWrite: [] },
  }));
  let released = false;
  const release = async () => {
    if (released) return; released = true;
    try { if (--entry!.refs === 0) { entry!.lifecycle = entry!.lifecycle.catch(() => {}).then(() => manager.reset()); await entry!.lifecycle; } }
    finally { unlock(); }
  };
  try { await entry.lifecycle; input.signal.throwIfAborted(); }
  catch (error) { await release(); throw new Error(`Pi restricted sandbox could not initialize: ${error instanceof Error ? error.message : String(error)}`); }
  const checked = (value: string, missing = false) => piWorkspacePath(value, input.cwd, missing);
  const exists = async (value: string) => { try { await access(await checked(value)); return true; } catch { return false; } };
  const readable = {
    read: { readFile: async (value: string) => readFile(await checked(value)), access: async (value: string) => access(await checked(value)) },
    grep: { isDirectory: async (value: string) => (await lstat(await checked(value))).isDirectory(), readFile: async (value: string) => readFile(await checked(value), 'utf8') },
    ls: { exists, stat: async (value: string) => lstat(await checked(value)), readdir: async (value: string) => (await readdir(await checked(value))).filter(name => !isBlockedName(name)) },
    find: { exists, glob: async (pattern: string, cwd: string, options: { limit?: number }) => {
      const root = await checked(cwd), found: string[] = [], limit = Math.min(10_000, Math.max(1, options.limit ?? 1000));
      const visit = async (directory: string) => {
        input.signal.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (found.length >= limit) return;
          if (entry.isSymbolicLink() || isBlockedName(entry.name)) continue;
          const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute).split(path.sep).join('/');
          if (path.matchesGlob(pattern.includes('/') ? relative : entry.name, pattern)) found.push(absolute);
          if (entry.isDirectory()) await visit(absolute);
        }
      };
      await visit(root); return found;
    } },
  };
  const protect = (tool: any, write = false) => ({ ...tool, execute: async (...args: any[]) => {
    input.signal.throwIfAborted(); if (write && !writable) throw new Error('Pi read_only mode does not allow write tools'); return tool.execute(...args);
  } });
  try {
    const required = ['createReadTool', 'createGrepTool', 'createLsTool', 'createFindTool', ...(writable ? ['createWriteTool', 'createEditTool', 'createBashTool'] : [])];
    if (!required.every(name => typeof sdk[name] === 'function')) throw new Error('Pi SDK does not expose the restricted tool factory API');
    const tools = [protect(sdk.createReadTool(input.cwd, { operations: readable.read })), protect(sdk.createGrepTool(input.cwd, { operations: readable.grep })), protect(sdk.createLsTool(input.cwd, { operations: readable.ls })), protect(sdk.createFindTool(input.cwd, { operations: readable.find }))];
    if (writable) {
      tools.push(protect(sdk.createWriteTool(input.cwd, { operations: {
        writeFile: async (value: string, content: string) => writeFile(await checked(value, true), content),
        mkdir: async (value: string) => { await mkdir(await checked(value, true), { recursive: true }); },
      } }), true));
      tools.push(protect(sdk.createEditTool(input.cwd, { operations: {
        ...readable.read, writeFile: async (value: string, content: string) => writeFile(await checked(value, true), content),
      } }), true));
      tools.push(protect(sdk.createBashTool(input.cwd, { operations: { exec: async (command: string, cwd: string, options: { signal?: AbortSignal; timeout?: number; env?: Record<string, string>; onData(data: Buffer): void }) => {
        const working = await checked(cwd), signal = options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal;
        signal.throwIfAborted();
        const wrapped = await manager.wrapWithSandboxArgv(command, undefined, process.platform === 'win32' ? undefined : { filesystem: filesystem(input.cwd, true) }, signal, working);
        if (!Array.isArray(wrapped?.argv) || !wrapped.argv.length || typeof wrapped.argv[0] !== 'string') throw new Error('Sandbox runtime returned no executable argv');
        try {
          const record = await sessions.start({ command: wrapped.argv[0], args: wrapped.argv.slice(1), cwd: working, workspace: input.workspace, taskId: input.taskId, owner: input.owner, kind: 'agent', signal,
            env: { ...executionEnvironment({ login: true, inherit: input.target.inheritEnv, env: input.target.env }), ...options.env, ...wrapped.env },
            timeoutMs: options.timeout && options.timeout > 0 ? options.timeout * 1000 : input.target.timeoutMs,
            onOutput: entry => options.onData(Buffer.from(entry.text)) });
          input.onProcess(record.id);
          const ended = await sessions.wait(record.id, input.owner, input.workspace, signal); signal.throwIfAborted();
          if (ended.status === 'timed_out') throw new Error(`timeout:${options.timeout}`);
          return { exitCode: ended.exitCode ?? null };
        } finally { await manager.cleanupAfterCommand(); }
      } } }), true));
    }
    return { tools, release };
  } catch (error) { await release(); throw error; }
}
