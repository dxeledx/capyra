import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../core/types.js';
import { executionEnvironment, type ProcessSessions } from './sessions.js';

export const terminalExtension = {
  name: 'node-pty', version: '1.1.0',
  integrity: 'sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==',
  registry: 'https://registry.npmjs.org',
};
const addon = { version: '7.1.1', integrity: 'sha512-5m3bsyrjFWE1xf7nz7YXdN4udnVtXK6/Yfgn5qnahL6bCkf2yKt4k3nuTKAtT4r3IG8JNR2ncsIMdZuAzJjHQQ==' };

/** 固定官方包及传递依赖；下载完成并按 SRI 验证后，才运行可选 native 构建脚本。 */
export async function installTerminalExtension(sessions: ProcessSessions, stateDir: string, ctx: ToolContext) {
  const parent = path.join(stateDir, 'extensions'), directory = path.join(parent, 'terminal');
  for (const current of [parent, directory]) {
    await mkdir(current, { recursive: true, mode: 0o700 });
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Extension directory cannot be a symbolic link');
  }
  const manifest = { name: 'capyra-terminal-extension', private: true, version: '1.0.0', dependencies: { 'node-pty': terminalExtension.version, 'node-addon-api': addon.version } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {
    '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
    'node_modules/node-pty': { version: terminalExtension.version, resolved: `${terminalExtension.registry}/node-pty/-/node-pty-${terminalExtension.version}.tgz`, integrity: terminalExtension.integrity, hasInstallScript: true, license: 'MIT', dependencies: { 'node-addon-api': '^7.1.0' } },
    'node_modules/node-addon-api': { version: addon.version, resolved: `${terminalExtension.registry}/node-addon-api/-/node-addon-api-${addon.version}.tgz`, integrity: addon.integrity, license: 'MIT' },
  } };
  // 该目录只归本扩展所有，避免 npm ci 删除用户手工添加的其他能力。
  try {
    const previous = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (previous.name !== manifest.name) throw new Error('This extension directory contains another installation. Move it aside locally before installing.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const [filename, value] of [['package.json', manifest], ['package-lock.json', lock]] as const) {
    const target = path.join(directory, filename);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Extension configuration cannot be a symbolic link'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
  const configFile = path.join(directory, 'npm-userconfig'); await writeFile(configFile, '', { mode: 0o600 });
  const env = { ...executionEnvironment({ login: true }), npm_config_registry: terminalExtension.registry, npm_config_userconfig: configFile, npm_config_cache: path.join(directory, 'cache') };
  const run = async (args: string[]) => {
    ctx.signal.throwIfAborted();
    const invocation = process.platform === 'win32' ? { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] } : { command: 'npm', args };
    const started = await sessions.start({ ...invocation, env, cwd: directory, workspace: ctx.workspace, owner: ctx.owner ?? 'local-console', taskId: ctx.taskId, timeoutMs: 300000, signal: ctx.signal });
    ctx.progress(`Installing terminal extension: ${started.id}`);
    const ended = await sessions.wait(started.id, ctx.owner ?? 'local-console', ctx.workspace, ctx.signal);
    if (ended.status !== 'completed') throw new Error(`Terminal extension installation ${ended.status}; inspect process session ${started.id}. Linux builds require a C/C++ compiler and Python.`);
    return started.id;
  };
  const downloadSessionId = await run(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = JSON.parse(await readFile(path.join(directory, 'node_modules', 'node-pty', 'package.json'), 'utf8'));
  if (installed.version !== terminalExtension.version) throw new Error('Installed terminal extension version did not match the verified lock');
  const buildSessionId = await run(['rebuild', 'node-pty', '--no-audit', '--no-fund']);
  return { ...(await sessions.ptyStatus()), version: terminalExtension.version, integrity: terminalExtension.integrity, downloadSessionId, buildSessionId };
}
