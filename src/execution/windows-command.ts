import { readFileSync, statSync } from 'node:fs';
import { win32 as path } from 'node:path';

export interface ProcessCommand { command: string; args: string[] }
interface CommandFiles { isFile(filename: string): boolean; read(filename: string): string }
const files: CommandFiles = {
  isFile(filename) { try { return statSync(filename).isFile(); } catch { return false; } },
  read(filename) {
    if (statSync(filename).size > 65_536) throw new Error('Windows command shim exceeds 64 KiB');
    return readFileSync(filename, 'utf8');
  },
};

function environmentValue(env: NodeJS.ProcessEnv, name: string) {
  // Node 在 Windows 上对环境键不区分大小写；同名键采用排序后的第一项。
  return env[Object.keys(env).sort().find(key => key.toUpperCase() === name) ?? name];
}
function resolveFile(command: string, cwd: string, env: NodeJS.ProcessEnv, fs: CommandFiles): string | undefined {
  const extensions = path.extname(command) ? [''] :
    [...(environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => /^\.[a-z0-9]+$/i.test(extension)), ''];
  const directories = /[\\/]/.test(command) || /^[a-z]:/i.test(command) ? [''] :
    [cwd, ...(environmentValue(env, 'PATH') ?? '').split(';').filter(Boolean).map(directory => directory.replace(/^"(.*)"$/, '$1'))];
  for (const directory of directories) for (const extension of extensions) {
    const filename = path.resolve(cwd, directory, command + extension);
    if (fs.isFile(filename)) return filename;
  }
}
const normalized = (text: string) => text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
const sameTemplate = (actual: string, expected: string) => actual.toLowerCase() === normalized(expected).toLowerCase();

function nodeShimTarget(source: string): string | undefined {
  const text = normalized(source);
  const modern = text.match(/"%_prog%"\s+"%dp0%\\([^"\r\n%]+)" %\*$/i)?.[1];
  if (modern && sameTemplate(text, `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
SET "_prog=%dp0%\\node.exe"
) ELSE (
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${modern}" %*`)) return modern;
  const legacy = text.match(/^@IF EXIST "%~dp0\\node\.exe" \(\n"%~dp0\\node\.exe"\s+"%~dp0\\([^"\r\n%]+)" %\*/i)?.[1];
  if (legacy && sameTemplate(text, `@IF EXIST "%~dp0\\node.exe" (
"%~dp0\\node.exe" "%~dp0\\${legacy}" %*
) ELSE (
@SETLOCAL
@SET PATHEXT=%PATHEXT:;.JS;=;%
node "%~dp0\\${legacy}" %*
)`)) return legacy;
}

function npmShim(source: string): 'npm' | 'npx' | undefined {
  const text = normalized(source);
  for (const name of ['npm', 'npx'] as const) {
    const variable = name.toUpperCase();
    if (sameTemplate(text, `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
SET "NODE_EXE=node"
)
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "${variable}_CLI_JS=%~dp0\\node_modules\\npm\\bin\\${name}-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
SET "NPM_PREFIX_${variable}_CLI_JS=%%F\\node_modules\\npm\\bin\\${name}-cli.js"
)
IF EXIST "%NPM_PREFIX_${variable}_CLI_JS%" (
SET "${variable}_CLI_JS=%NPM_PREFIX_${variable}_CLI_JS%"
)
"%NODE_EXE%" "%${variable}_CLI_JS%" %*`)) return name;
  }
}

// npm 官方 shim 根据 npm-prefix.js 选择全局升级后的 CLI。参数始终走 argv，
// 不拼入代码或 cmd.exe；bootstrap 与实际 CLI 共用受监督的 Node 进程。
const npmBootstrap = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [prefixScript, localCli, ...args] = process.argv.slice(1);
let cli = localCli;
const prefix = spawnSync(process.execPath, [prefixScript], { env: process.env, cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 65536 });
if (!prefix.error && prefix.status === 0) {
  const directory = prefix.stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1);
  if (directory) {
    const candidate = path.join(directory, 'node_modules', 'npm', 'bin', path.basename(localCli));
    try { if (fs.statSync(candidate).isFile()) cli = candidate; } catch {}
  }
}
process.argv = [process.execPath, cli, ...args];
require(cli);
`;

/** Windows 的原生 argv 执行：只展开完整匹配的 Node/npm shim，其他脚本要求显式 shell。 */
export function resolveProcessCommand(command: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}, fs: CommandFiles = files): ProcessCommand {
  if ((options.platform ?? process.platform) !== 'win32') return { command, args: [...args] };
  const filename = resolveFile(command, options.cwd, options.env, fs);
  if (!filename) throw new Error(`Windows executable was not found: ${command}`);
  if (/\.(exe|com)$/i.test(filename)) return { command: filename, args: [...args] };
  const source = fs.read(filename);
  const batch = /\.(cmd|bat)$/i.test(filename);
  const target = batch ? nodeShimTarget(source) : undefined;
  const npm = batch ? npmShim(source) : undefined;
  const nodeScript = !batch && /^#!\s*(?:\/usr\/bin\/env\s+node|\/usr\/bin\/node)\s*(?:\r?\n|$)/.test(source);
  if (!target && !npm && !nodeScript) throw new Error(
    `Unsupported Windows command shim: ${filename}. Use an explicit executable with args, or process.execute({command: "..."}) for a shell command.`);
  const directory = path.dirname(filename);
  const adjacentNode = path.join(directory, 'node.exe');
  const node = fs.isFile(adjacentNode) ? adjacentNode : resolveFile('node.exe', options.cwd, options.env, fs);
  if (!node) throw new Error(`Node executable was not found for Windows command shim: ${filename}`);
  const script = npm ? path.join(directory, 'node_modules', 'npm', 'bin', `${npm}-cli.js`) : target ? path.resolve(directory, target) : filename;
  if (!fs.isFile(script)) throw new Error(`Windows command shim target was not found: ${script}`);
  return { command: node, args: npm ?
    ['--eval', npmBootstrap, '--', path.join(directory, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), script, ...args] :
    [script, ...args] };
}
