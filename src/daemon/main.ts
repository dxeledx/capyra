import { rmSync } from 'node:fs';
import path from 'node:path';
import { AgentDaemon } from './server.js';
import { DaemonError, daemonPaths, readPrivate } from './security.js';

// 内部入口只接收0600一次性配置文件路径；密钥与provider环境从不进入argv。
const filename = process.argv[2];
let daemon: AgentDaemon | undefined;
let shuttingDown = false;
let started = false;
try {
  if (!filename || !path.isAbsolute(filename) || !/^boot-[a-f0-9]{32}\.json$/.test(path.basename(filename))) throw new Error('Invalid daemon bootstrap file.');
  const bootstrap = JSON.parse(readPrivate(filename, 1024 * 1024)) as { stateDir: string; config: Record<string, unknown> };
  if (!bootstrap.stateDir || path.dirname(filename) !== daemonPaths(bootstrap.stateDir).directory || !bootstrap.config || typeof bootstrap.config !== 'object') throw new Error('Invalid daemon bootstrap scope.');
  rmSync(filename);
  const shutdown = () => {
    if (shuttingDown) return; shuttingDown = true;
    const timer = setTimeout(() => process.exit(1), 10_000); timer.unref();
    void daemon?.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  daemon = new AgentDaemon(bootstrap.stateDir, bootstrap.config, { onClosed() { if (started && !shuttingDown) process.exit(0); } });
  await daemon.start();
  started = true;
} catch (error) {
  // bootstrap/provider配置可能包含密钥，启动错误只输出稳定错误类别。
  process.stderr.write(`${error instanceof DaemonError ? error.code : 'DAEMON_START_FAILED'}\n`);
  process.exitCode = error instanceof DaemonError && error.code === 'DAEMON_ALREADY_RUNNING' ? 0 : 1;
  await daemon?.close();
}
