import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProcessCommand } from '../src/execution/windows-command.js';

// 固定 npm/cmd-shim 的 Windows 输出作为协议样本；这些测试在非 Windows 主机也执行。
const modern = (target = 'node_modules\\@openai\\codex\\bin\\codex.js') => `@ECHO off
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

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*
`;
const legacy = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "%~dp0\\node_modules\\tool\\cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node "%~dp0\\node_modules\\tool\\cli.js" %*
)
`;
const npm = (name: 'npm' | 'npx') => {
  const variable = name.toUpperCase();
  return `:: Created by npm, please don't edit manually.
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

"%NODE_EXE%" "%${variable}_CLI_JS%" %*
`;
};
const cwd = 'C:\\workspace';
const bin = 'C:\\Program Files\\Node';
const hostileArgs = ['', 'spaces and 中文', 'hello & echo injected', 'a|b', '%PATH%', '!SECRET!', '"quoted"', 'end\\', '^<>();', '\r\nnext line', '" & echo injected > injected.txt & "'];
function fixture(entries: Record<string, string>, env: NodeJS.ProcessEnv = { Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }) {
  const contents = new Map(Object.entries(entries).map(([name, text]) => [path.win32.normalize(name).toLowerCase(), text]));
  return (command: string, args: string[] = hostileArgs) => resolveProcessCommand(command, args, { cwd, env, platform: 'win32' }, {
    isFile: filename => contents.has(filename.toLowerCase()),
    read: filename => { const source = contents.get(filename.toLowerCase()); assert.notEqual(source, undefined); return source!; },
  });
}
test('Windows PATH/PATHEXT selects native executables and preserves argv without a shell', () => {
  const resolve = fixture({ [`${bin}\\tool.exe`]: '', [`${bin}\\tool.cmd`]: 'unexpected batch' });
  const result = resolve('tool');
  assert.deepEqual(result, { command: `${bin}\\tool.EXE`, args: hostileArgs });
  assert.notEqual(result.args, hostileArgs);
  assert.deepEqual(resolve(`${bin}\\tool.exe`), { command: `${bin}\\tool.exe`, args: hostileArgs });
});
test('case-insensitive environment keys and quoted PATH entries resolve from the supplied cwd', () => {
  const resolve = fixture({ 'C:\\workspace\\bin\\tool.com': '' }, { pAtH: '"bin"', PaThExT: '.COM' });
  assert.equal(resolve('tool').command, 'C:\\workspace\\bin\\tool.COM');
  assert.equal(resolve('.\\bin\\tool.com').command, 'C:\\workspace\\bin\\tool.com');
});
test('npm-generated modern cmd shim bypasses cmd.exe and its sibling POSIX shim', () => {
  const script = `${bin}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const resolve = fixture({ [`${bin}\\codex`]: '#!/bin/sh', [`${bin}\\codex.cmd`]: modern().replace(/\n/g, '\r\n'), [`${bin}\\node.exe`]: '', [script]: '' });
  assert.deepEqual(resolve('codex'), { command: `${bin}\\node.exe`, args: [script, ...hostileArgs] });
  assert.deepEqual(resolve(`${bin}\\codex.cmd`), resolve('codex'));
});
test('legacy Node batch shims support .bat and fall back to node.exe on PATH', () => {
  const script = 'C:\\tools\\node_modules\\tool\\cli.js';
  const resolve = fixture({ 'C:\\tools\\tool.bat': legacy, [script]: '', [`${bin}\\node.exe`]: '' });
  assert.deepEqual(resolve('C:\\tools\\tool.bat'), { command: `${bin}\\node.exe`, args: [script, ...hostileArgs] });
});
test('extensionless Node shebang files use Node while other shebang interpreters remain explicit', () => {
  const resolve = fixture({ [`${bin}\\tool`]: '#!/usr/bin/env node\nconsole.log(1)', [`${bin}\\python-tool`]: '#!/usr/bin/env python\n', [`${bin}\\node.exe`]: '' });
  assert.deepEqual(resolve('tool'), { command: `${bin}\\node.exe`, args: [`${bin}\\tool`, ...hostileArgs] });
  assert.throws(() => resolve('python-tool'), /Unsupported Windows command shim/);
});
test('Node shim with extra commands, environment changes or altered control flow is rejected', () => {
  for (const source of [modern() + 'echo injected', 'echo injected\n' + modern(), modern().replace('SETLOCAL', 'SETLOCAL\nSET TOKEN=changed'), modern().replace('GOTO start', 'CALL injected'), modern().replace('"%_prog%"  ', '"%_prog%" --require injected ')]) {
    const resolve = fixture({ [`${bin}\\tool.cmd`]: source });
    assert.throws(() => resolve('tool'), /Unsupported Windows command shim.*process\.execute/);
  }
  assert.throws(() => fixture({ [`${bin}\\tool.cmd`]: '@echo %*' })('tool'), /Unsupported Windows command shim/);
  assert.throws(() => fixture({ [`${bin}\\npm.cmd`]: npm('npm') + 'echo injected' })('npm'), /Unsupported Windows command shim/);
});
test('missing shim targets, missing Node and unresolved commands fail before shell execution', () => {
  assert.throws(() => fixture({ [`${bin}\\tool.cmd`]: modern(), [`${bin}\\node.exe`]: '' })('tool'), /shim target was not found/);
  assert.throws(() => fixture({ [`${bin}\\tool.cmd`]: modern() })('tool'), /Node executable was not found/);
  assert.throws(() => fixture({})('missing'), /Windows executable was not found/);
});
test('npm and npx official wrappers keep argv separate from their fixed bootstrap code', () => {
  for (const name of ['npm', 'npx'] as const) {
    const script = `${bin}\\node_modules\\npm\\bin\\${name}-cli.js`;
    const resolve = fixture({ [`${bin}\\${name}.cmd`]: npm(name), [`${bin}\\node.exe`]: '', [script]: '' });
    const result = resolve(name);
    assert.equal(result.command, `${bin}\\node.exe`);
    assert.equal(result.args[0], '--eval');
    assert.equal(result.args[2], '--');
    assert.equal(result.args[3], `${bin}\\node_modules\\npm\\bin\\npm-prefix.js`);
    assert.deepEqual(result.args.slice(4), [script, ...hostileArgs]);
    for (const value of hostileArgs.filter(value => value.length > 8)) assert.ok(!result.args[1].includes(value));
  }
});
test('emitted npm Node bootstrap preserves actual argv, global-prefix selection and fallback without shell interpolation', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capyra-windows-argv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix.js'), local = path.join(root, 'npm-cli.js');
  const global = path.join(root, 'global prefix & percent% !', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(path.dirname(global), { recursive: true });
  const capture = (origin: string) => `process.stdout.write(JSON.stringify({origin:${JSON.stringify(origin)},args:process.argv.slice(2)}));`;
  writeFileSync(local, capture('local')); writeFileSync(global, capture('global'));
  const script = `${bin}\\node_modules\\npm\\bin\\npm-cli.js`;
  const invocation = fixture({ [`${bin}\\npm.cmd`]: npm('npm'), [`${bin}\\node.exe`]: '', [script]: '' })('npm');
  const run = () => JSON.parse(execFileSync(process.execPath, [...invocation.args.slice(0, 3), prefix, local, ...hostileArgs], { cwd: root, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
  writeFileSync(prefix, `console.log(${JSON.stringify(path.resolve(path.dirname(global), '..', '..', '..'))})`);
  assert.deepEqual(run(), { origin: 'global', args: hostileArgs });
  writeFileSync(prefix, 'process.exit(1)');
  assert.deepEqual(run(), { origin: 'local', args: hostileArgs });
  writeFileSync(prefix, 'console.log("missing-prefix")');
  assert.deepEqual(run(), { origin: 'local', args: hostileArgs });
  assert.equal(existsSync(path.join(root, 'injected.txt')), false);
});
test('non-Windows execution is unchanged and does not inspect command files', () => {
  assert.deepEqual(resolveProcessCommand('tool', hostileArgs, { cwd: '/workspace', env: {}, platform: 'darwin' }, {
    isFile() { throw new Error('unexpected file lookup'); }, read() { throw new Error('unexpected file read'); },
  }), { command: 'tool', args: hostileArgs });
});
