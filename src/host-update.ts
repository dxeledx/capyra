import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostUpdateResult {
  updateId: string;
  status: 'scheduled';
  version: string;
  packageSha256: string;
  connectionWillRestart: true;
}

interface HostUpdatePlan {
  updateId: string;
  targetPid: number;
  packagePath: string;
  packageSha256: string;
  version: string;
  installPrefix: string;
  packageRoot: string;
  cliPath: string;
  restartArgs: string[];
  cwd: string;
  stateDir: string;
  npmPath: string;
  nodePath: string;
  environment: Record<string, string>;
}

export const UPDATER_SOURCE = String.raw`
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const directory = path.dirname(process.argv[2]);
const statusPath = path.join(plan.stateDir, 'host-updates', 'latest.json');
const logPath = path.join(directory, 'update.log');
const record = (status, message, extra = {}) => {
  const value = { updateId: plan.updateId, status, version: plan.version, packageSha256: plan.packageSha256, message, updatedAt: new Date().toISOString(), ...extra };
  const temporary = statusPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, statusPath);
  appendFileSync(logPath, '[' + value.updatedAt + '] ' + status + ': ' + message + '\n', { mode: 0o600 });
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const restart = () => {
  const descriptor = openSync(logPath, 'a', 0o600);
  const child = spawn(plan.nodePath, [plan.cliPath, ...plan.restartArgs], { cwd: plan.cwd, detached: true, stdio: ['ignore', descriptor, descriptor], env: plan.environment });
  child.unref(); closeSync(descriptor); return child.pid;
};

let backup, launchedPid;
try {
  await delay(3000);
  const bytes = readFileSync(plan.packagePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== plan.packageSha256) throw new Error('The approved package SHA-256 changed before installation.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  backup = path.join(directory, 'previous-package');
  record('backing_up', 'Saving the currently installed package for rollback.');
  cpSync(plan.packageRoot, backup, { recursive: true, errorOnExist: true, force: false });

  record('stopping', 'Stopping the current Capyra process.');
  process.kill(plan.targetPid, 'SIGTERM');
  const lockPath = path.join(plan.stateDir, 'runtime.lock');
  for (let attempt = 0; attempt < 100 && (alive(plan.targetPid) || existsSync(lockPath)); attempt++) await delay(200);
  if (alive(plan.targetPid) || existsSync(lockPath)) throw new Error('The current Capyra process did not stop cleanly; installation was not started.');

  record('installing', 'Installing the approved local package.');
  const installed = spawnSync(plan.npmPath, ['install', '-g', '--prefix', plan.installPrefix, plan.packagePath], { env: plan.environment, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  appendFileSync(logPath, (installed.stdout || '') + (installed.stderr || ''));
  if (installed.error || installed.status !== 0) throw new Error('npm could not install the approved package.');
  const manifest = JSON.parse(readFileSync(path.join(plan.packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'capyra' || manifest.version !== plan.version || !existsSync(plan.cliPath)) throw new Error('The installed package did not match the approved Capyra version.');

  launchedPid = restart();
  record('restarting', 'The new Capyra process was launched; waiting for its runtime lock.', { pid: launchedPid });
  let ready = false;
  for (let attempt = 0; attempt < 75; attempt++) {
    await delay(200);
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (lock.pid === launchedPid && alive(launchedPid)) { ready = true; break; }
    } catch {}
    if (!alive(launchedPid)) break;
  }
  if (!ready) throw new Error('The updated Capyra process did not become ready.');
  record('succeeded', 'The approved Capyra version is running.', { pid: launchedPid });
  rmSync(backup, { recursive: true, force: true });
} catch (error) {
  let rolledBack = false;
  try {
    if (launchedPid && alive(launchedPid)) {
      process.kill(launchedPid, 'SIGTERM');
      for (let attempt = 0; attempt < 50 && alive(launchedPid); attempt++) await delay(200);
    }
    if (backup && existsSync(backup)) {
      rmSync(plan.packageRoot, { recursive: true, force: true });
      cpSync(backup, plan.packageRoot, { recursive: true });
      rolledBack = true;
    }
    if (!alive(plan.targetPid)) restart();
  } catch (rollbackError) {
    appendFileSync(logPath, 'Rollback error: ' + (rollbackError?.message || String(rollbackError)) + '\n');
  }
  record('failed', error?.message || String(error), { rolledBack });
}
`;

function execute(file: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 128_000, signal }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

function installedPackageRoot(): { packageRoot: string; installPrefix: string; cliPath: string } {
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const posixSuffix = path.join('lib', 'node_modules', 'capyra');
  const windowsSuffix = path.join('node_modules', 'capyra');
  let installPrefix: string | undefined;
  if (packageRoot.endsWith(path.sep + posixSuffix)) installPrefix = packageRoot.slice(0, -(posixSuffix.length + 1));
  else if (packageRoot.toLowerCase().endsWith(path.sep + windowsSuffix.toLowerCase())) installPrefix = packageRoot.slice(0, -(windowsSuffix.length + 1));
  if (!installPrefix) throw new Error('宿主更新只支持从 npm 全局安装的 Capyra；源码开发实例请继续使用外部插件安装流程');
  return { packageRoot, installPrefix, cliPath: path.join(packageRoot, 'dist', 'cli.js') };
}

async function packageManifest(packagePath: string, signal: AbortSignal): Promise<{ name?: string; version?: string }> {
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
  const content = await execute(tar, ['-xOf', packagePath, 'package/package.json'], signal);
  try { return JSON.parse(content); } catch { throw new Error('更新包中的 package.json 无效'); }
}

async function npmExecutable(signal: AbortSignal): Promise<string> {
  if (process.platform === 'win32') return (await execute('where.exe', ['npm.cmd'], signal)).split(/\r?\n/)[0];
  return execute('/usr/bin/which', ['npm'], signal);
}

/**
 * 宿主更新由独立短生命周期进程完成：先复核包摘要并备份，再等待当前实例干净退出、安装和重启。
 * 调用返回后三秒才停服务，让 MCP 结果先送达；失败时恢复旧包并重启。
 */
export async function scheduleHostUpdate(input: { workspace: string; stateDir: string; packagePath: string; expectedSha256: string; expectedVersion?: string; signal: AbortSignal }): Promise<HostUpdateResult> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error('expectedSha256 必须是更新包的小写 SHA-256');
  input.signal.throwIfAborted();
  const packagePath = await realpath(input.packagePath);
  const relative = path.relative(await realpath(input.workspace), packagePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('更新包必须位于当前工作区内');
  const info = await lstat(packagePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 100 * 1024 * 1024 || !packagePath.endsWith('.tgz')) throw new Error('更新包必须是工作区内不超过 100 MB 的普通 .tgz 文件');
  const packageBytes = await readFile(packagePath);
  const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  if (packageSha256 !== input.expectedSha256) throw new Error('更新包 SHA-256 与批准值不一致');
  const updateId = randomUUID(), directory = path.join(input.stateDir, 'host-updates', updateId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // 复制获批字节到私有目录，后续安装不再读取可能被其他进程替换的工作区路径。
  const stagedPackage = path.join(directory, 'approved-package.tgz');
  await writeFile(stagedPackage, packageBytes, { flag: 'wx', mode: 0o600 });
  const manifest = await packageManifest(stagedPackage, input.signal);
  if (manifest.name !== 'capyra' || typeof manifest.version !== 'string' || !/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('更新包不是有效的 Capyra 0.x 版本');
  if (input.expectedVersion && manifest.version !== input.expectedVersion) throw new Error('更新包版本与 expectedVersion 不一致');
  const installed = installedPackageRoot();
  const restartArgs = process.argv.slice(2).filter(argument => argument !== '--open');
  if (restartArgs[0] !== 'start') throw new Error('当前实例不是标准 capyra start 进程，不能自动恢复原启动方式');
  const environment = Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(name => typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : []));
  const plan: HostUpdatePlan = {
    updateId, targetPid: process.pid, packagePath: stagedPackage, packageSha256, version: manifest.version,
    installPrefix: installed.installPrefix, packageRoot: installed.packageRoot, cliPath: installed.cliPath,
    restartArgs, cwd: process.cwd(), stateDir: input.stateDir, npmPath: await npmExecutable(input.signal), nodePath: process.execPath, environment,
  };
  const planPath = path.join(directory, 'plan.json'), updaterPath = path.join(directory, 'updater.mjs');
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(updaterPath, UPDATER_SOURCE, { flag: 'wx', mode: 0o700 });
  const latestPath = path.join(input.stateDir, 'host-updates', 'latest.json'), latestTemp = path.join(input.stateDir, 'host-updates', `.latest-${updateId}.tmp`);
  await writeFile(latestTemp, JSON.stringify({ updateId, status: 'scheduled', version: manifest.version, packageSha256, updatedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await (await import('node:fs/promises')).rename(latestTemp, latestPath);
  const child = (await import('node:child_process')).spawn(process.execPath, [updaterPath, planPath], { detached: true, stdio: 'ignore', env: environment });
  child.unref();
  return { updateId, status: 'scheduled', version: manifest.version, packageSha256, connectionWillRestart: true };
}

export async function readHostUpdateStatus(stateDir: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, 'host-updates', 'latest.json'), 'utf8')) as Record<string, unknown>;
    return { updateId: value.updateId, status: value.status, version: value.version, packageSha256: value.packageSha256, message: value.message, updatedAt: value.updatedAt, pid: value.pid, rolledBack: value.rolledBack };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' };
    throw new Error('无法读取宿主更新状态');
  }
}
