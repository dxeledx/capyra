#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [command, stateArgument, fileArgument] = process.argv.slice(2);
if (!['inspect', 'backup', 'restore', 'invalidate-sessions'].includes(command) || !stateArgument || (['backup', 'restore'].includes(command) && !fileArgument)) {
  console.error('Usage: node cloud/admin.mjs inspect|invalidate-sessions STATE_DIR');
  console.error('       node cloud/admin.mjs backup|restore STATE_DIR BACKUP_FILE');
  process.exit(2);
}
const stateDir = resolve(stateArgument);
const statePath = resolve(stateDir, 'identity.json');
function readState(path) {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.devices) || !Array.isArray(state.sessions)) throw new Error('Invalid account state');
  return state;
}
function writeState(path, state, exclusive = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) { writeFileSync(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600); }
  finally { try { unlinkSync(temporary); } catch {} }
}
function requireStopped() {
  const lock = resolve(stateDir, 'identity.lock');
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Inspect the invalid process lock before changing account state');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw new Error('Stop the account service before restoring or invalidating sessions');
}
if (command === 'inspect') {
  const state = readState(statePath);
  console.log(JSON.stringify({ accounts: state.users.length, devices: state.devices.length, activeDevices: state.devices.filter(device => !device.revokedAt).length, pendingConnectionCleanup: state.devices.filter(device => device.revokedAt && device.connection).length }, null, 2));
} else if (command === 'backup') {
  // 账号服务原子替换整个状态文件，在线读取会得到一份完整提交。备份绝不覆盖已有文件。
  writeState(resolve(fileArgument), readState(statePath), true);
  console.log('Account state backup created with private file permissions. Keep it on encrypted storage.');
} else if (command === 'restore') {
  requireStopped();
  const state = readState(resolve(fileArgument));
  // 恢复旧快照不能恢复当时有效、此后已撤销的权限；全部设备须重新在本机绑定。
  for (const device of state.devices) { device.revokedAt = new Date().toISOString(); device.version++; delete device.connectionToken; }
  state.sessions = []; state.deviceTokens = []; state.challenges = []; state.pairings = []; state.pairReplays = [];
  if (existsSync(statePath)) writeState(`${statePath}.before-restore-${Date.now()}`, readState(statePath), true);
  writeState(statePath, state);
  console.log('State restored. Sessions and device access were revoked; owners must clean up old connections and pair devices again.');
} else {
  requireStopped();
  const state = readState(statePath);
  state.sessions = []; state.deviceTokens = []; state.challenges = []; state.pairings = []; state.pairReplays = [];
  writeState(statePath, state);
  console.log('Account sessions and transient proofs invalidated. Device owners retain their keys and can renew device credentials.');
}
