import path from 'node:path';
import type { AgentRecord } from '../execution/agent-manager.js';
import type { OutputEntry, ProcessSession, SessionPage } from '../execution/sessions.js';
import { readPrivate } from './security.js';

export interface OutputOptions { cursor?: number; limit?: number; waitMs?: number }
export function agentProcessId(record: AgentRecord, requested?: string) {
  const processIds = record.turns.flatMap(turn => turn.processSessionIds), id = requested ?? processIds.at(-1);
  if (!id) throw new Error('This provider has no captured process stream. Use show for its response and progress.');
  if (!/^[a-f0-9-]{36}$/.test(id) || !processIds.includes(id)) throw new Error('Unknown agent process stream.');
  return id;
}
export function outputOptions(options: OutputOptions) {
  const cursor = options.cursor ?? 0, limit = options.limit ?? 16_384, waitMs = options.waitMs ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 262_144 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12_000) throw new Error('Invalid output cursor, limit or wait duration.');
  return { cursor, limit, waitMs };
}

/** 后台停止后的读取仅查看私有持久文件，不构造会执行恢复写入的ProcessSessions。 */
export function readSavedOutput(directory: string, agent: AgentRecord, requested: string | undefined, options: OutputOptions, daemonOwnerAlive: boolean): SessionPage {
  const id = agentProcessId(agent, requested), { cursor, limit } = outputOptions(options);
  const session = JSON.parse(readPrivate(path.join(directory, `${id}.json`), 512_000)) as ProcessSession;
  if (session.id !== id || session.owner !== agent.owner || session.workspace !== agent.workspace || !Number.isSafeInteger(session.sequence)) throw new Error('Unknown agent process stream.');
  if (session.status === 'running' && !daemonOwnerAlive) { session.status = 'interrupted'; session.error = 'Agent daemon stopped during execution; this process was not replayed.'; delete session.pid; }
  else if (session.status === 'running') session.error = 'Daemon owner exists but cannot be reached; current progress is unverified.';
  const entries: OutputEntry[] = [];
  for (const suffix of ['.jsonl.1', '.jsonl']) {
    try {
      for (const line of readPrivate(path.join(directory, `${id}${suffix}`), 4 * 1024 * 1024).split('\n')) {
        if (!line) continue; const entry = JSON.parse(line) as OutputEntry;
        if (!Number.isSafeInteger(entry.cursor) || !['stdout', 'stderr'].includes(entry.stream) || typeof entry.text !== 'string') throw new Error('Invalid persisted agent output.');
        entries.push(entry);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const output: OutputEntry[] = []; let bytes = 0;
  for (const entry of entries) if (entry.cursor > cursor) { if (output.length && bytes + Buffer.byteLength(entry.text) > limit) break; output.push(entry); bytes += Buffer.byteLength(entry.text); }
  const nextCursor = output.at(-1)?.cursor ?? cursor, firstCursor = entries[0]?.cursor ?? session.sequence + 1;
  return { session, output, nextCursor, firstCursor, hasMore: entries.some(entry => entry.cursor > nextCursor), outputTruncated: cursor < firstCursor - 1 };
}
