import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskRecord, RuntimeEvent } from './types.js';

export interface TaskStore { load(): TaskRecord[]; save(task: TaskRecord): void; remove(id: string): void; event(event: RuntimeEvent): void; close?(): void | Promise<void> }

/** 状态与审计留在工作区的私有目录，不进入文件插件的可访问范围。 */
export class DiskTaskStore implements TaskStore {
  private tasksDir: string;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('状态目录不能是软链接');
    this.tasksDir = join(directory, 'tasks');
    mkdirSync(this.tasksDir, { mode: 0o700, recursive: true });
    if (lstatSync(this.tasksDir).isSymbolicLink()) throw new Error('任务目录不能是软链接');
  }
  load(): TaskRecord[] {
    const tasks: TaskRecord[] = [];
    for (const file of readdirSync(this.tasksDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const path = join(this.tasksDir, file);
      if (lstatSync(path).isSymbolicLink() || statSync(path).size > 5_000_000) continue;
      try {
        const task = JSON.parse(readFileSync(path, 'utf8')) as TaskRecord;
        if (task.id + '.json' === file && typeof task.owner === 'string' && typeof task.status === 'string' &&
          typeof task.createdAt === 'string' && Number.isFinite(Date.parse(task.createdAt)) && typeof task.updatedAt === 'string' &&
          typeof task.tool === 'string' && typeof task.pluginId === 'string' && typeof task.inputHash === 'string' &&
          ['read', 'write', 'execute'].includes(task.effect) && task.args && typeof task.args === 'object' && !Array.isArray(task.args)) tasks.push(task);
      } catch { /* 单条损坏记录不影响其他记录；不会重放未完成动作。 */ }
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  save(task: TaskRecord): void {
    const temp = join(this.tasksDir, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(task), { mode: 0o600, flag: 'wx' });
      renameSync(temp, join(this.tasksDir, `${task.id}.json`));
    } finally { try { unlinkSync(temp); } catch {} }
  }
  remove(id: string): void { try { unlinkSync(join(this.tasksDir, `${id}.json`)); } catch {} }
  event(event: RuntimeEvent): void {
    const path = join(this.directory, 'audit.jsonl');
    if (lstatSafe(path)?.isSymbolicLink()) throw new Error('审计路径不能是软链接');
    // 两代有界审计，避免常驻进程持续占用磁盘。事件不保存文件内容与调用参数。
    if ((lstatSafe(path)?.size ?? 0) > 5_000_000) renameSync(path, `${path}.1`);
    appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600 });
  }
}
function lstatSafe(path: string) { try { return lstatSync(path); } catch { return undefined; } }
