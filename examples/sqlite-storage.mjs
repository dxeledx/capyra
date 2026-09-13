import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function integer(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return result;
}
function metadata(filename) { try { return lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function validTask(task) {
  return task && typeof task === 'object' && /^[a-f0-9-]{36}$/.test(task.id)
    && typeof task.owner === 'string' && typeof task.tool === 'string' && typeof task.pluginId === 'string'
    && typeof task.inputHash === 'string' && typeof task.status === 'string'
    && typeof task.createdAt === 'string' && Number.isFinite(Date.parse(task.createdAt))
    && typeof task.updatedAt === 'string' && ['read', 'write', 'execute'].includes(task.effect)
    && task.args && typeof task.args === 'object' && !Array.isArray(task.args);
}

/** 只在此插件被选为 storagePlugin 时打开数据库；不引入 npm 依赖。 */
export class SQLiteTaskStore {
  #database;
  #statements;
  #closed = false;
  #auditLimit;
  #path;

  constructor(stateDir, config = {}) {
    const filename = config.filename ?? 'tasks.sqlite';
    if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.sqlite$/.test(filename)) throw new Error('filename must be a plain .sqlite filename');
    this.#auditLimit = integer(config.auditLimit, 5000, 100, 100_000, 'auditLimit');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (lstatSync(stateDir).isSymbolicLink()) throw new Error('SQLite state directory must not be a symbolic link');
    this.#path = path.join(stateDir, filename);
    const file = metadata(this.#path);
    if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)) throw new Error('SQLite state file must be an independent regular file');
    for (const suffix of ['-journal', '-wal', '-shm']) { const sidecar = metadata(this.#path + suffix); if (sidecar && (sidecar.isSymbolicLink() || sidecar.nlink !== 1)) throw new Error('Unsafe SQLite sidecar file'); }
    this.#database = new DatabaseSync(this.#path);
    try {
      chmodSync(this.#path, 0o600);
      this.#database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      this.#statements = {
        load: this.#database.prepare('SELECT id, payload FROM tasks ORDER BY created_at, id'),
        save: this.#database.prepare('INSERT INTO tasks (id, created_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, payload=excluded.payload'),
        remove: this.#database.prepare('DELETE FROM tasks WHERE id = ?'),
        event: this.#database.prepare('INSERT INTO audit (payload) VALUES (?)'),
        pruneAudit: this.#database.prepare('DELETE FROM audit WHERE sequence NOT IN (SELECT sequence FROM audit ORDER BY sequence DESC LIMIT ?)'),
        taskCount: this.#database.prepare('SELECT COUNT(*) AS count FROM tasks'),
        eventCount: this.#database.prepare('SELECT COUNT(*) AS count FROM audit'),
      };
      if (config.importJsonTasks !== undefined && typeof config.importJsonTasks !== 'boolean') throw new Error('importJsonTasks must be a boolean');
      if (config.importJsonTasks !== false) this.#importJsonTasks(stateDir);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }
  #importJsonTasks(stateDir) {
    if (this.#database.prepare("SELECT value FROM metadata WHERE key = 'json-import-complete'").get()) return;
    const directory = path.join(stateDir, 'tasks');
    if (!existsSync(directory)) return;
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('JSON task source must be a real directory');
    const insert = this.#database.prepare('INSERT OR IGNORE INTO tasks (id, created_at, payload) VALUES (?, ?, ?)');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const filename of readdirSync(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
        const file = path.join(directory, filename); const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 5_000_000) continue;
        let task;
        try { task = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
        if (validTask(task) && filename === task.id + '.json') insert.run(task.id, task.createdAt, JSON.stringify(task));
      }
      // 整个导入一次提交，之后不会让旧 JSON 覆盖 SQLite 中较新的任务；源文件保留原样。
      this.#database.prepare("INSERT INTO metadata (key, value) VALUES ('json-import-complete', ?)").run(new Date().toISOString());
      this.#database.exec('COMMIT');
    } catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }
  #active() { if (this.#closed) throw new Error('SQLite task store is closed'); }
  load() {
    this.#active();
    const records = [];
    for (const row of this.#statements.load.all()) {
      // 单条坏记录不应阻止其他任务恢复；宿主负责把未完成任务标为 interrupted。
      try { const task = JSON.parse(row.payload); if (task.id === row.id && validTask(task)) records.push(task); } catch {}
    }
    return records;
  }
  save(task) {
    this.#active();
    if (!validTask(task)) throw new Error('Invalid task record');
    const encoded = JSON.stringify(task);
    if (Buffer.byteLength(encoded) > 5_000_000) throw new Error('Task record exceeds 5 MB');
    this.#statements.save.run(task.id, task.createdAt, encoded);
  }
  remove(id) { this.#active(); this.#statements.remove.run(id); }
  event(event) {
    this.#active();
    const encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > 64_000) throw new Error('Audit event exceeds 64 KB');
    // 一次事务完成写入与清理，让磁盘占用始终受到 auditLimit 约束。
    this.#database.exec('BEGIN IMMEDIATE');
    try { this.#statements.event.run(encoded); this.#statements.pruneAudit.run(this.#auditLimit); this.#database.exec('COMMIT'); }
    catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }
  status() {
    return { backend: 'node:sqlite', path: this.#path, closed: this.#closed, auditLimit: this.#auditLimit, ...(this.#closed ? {} : { tasks: this.#statements.taskCount.get().count, auditEvents: this.#statements.eventCount.get().count }) };
  }
  close() { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}

export default {
  apiVersion: 1, id: 'sqlite-storage', version: '1.0.0', title: 'SQLite task storage',
  description: 'An external storage provider using the Node.js built-in SQLite database.', permissions: [],
  createStore(stateDir, config) { return new SQLiteTaskStore(stateDir, config); },
  setup(ctx) {
    const store = ctx.service('host.store');
    if (!(store instanceof SQLiteTaskStore)) throw new Error('Select sqlite-storage as storagePlugin before enabling it');
    ctx.provide('storage', store);
    ctx.provide('sqlite-storage.status', { snapshot: () => store.status() });
    // host.store 的关闭由宿主在全部插件及审计退出后统一完成。
  },
};
