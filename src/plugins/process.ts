import type { CapyraPlugin, ToolContext } from '../core/types.js';
import { textResult } from '../sdk.js';
import { ProcessSessions, executionEnvironment } from '../execution/sessions.js';
import { checkCancelled, stringArg, workspacePath } from './workspace-paths.js';

interface Command { command: string; args: string[]; cwd: string; timeoutMs: number }
function readCommands(value: unknown): Map<string, Command> {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('commands must be an object keyed by command ID');
  const result = new Map<string, Command>();
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error(`Invalid command ID: ${id}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid command configuration: ${id}`);
    const item = raw as Record<string, unknown>;
    if (typeof item.command !== 'string' || !item.command.trim() || item.command.includes('\0')) throw new Error(`Invalid executable for ${id}`);
    if (!Array.isArray(item.args) || !item.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error(`args for ${id} must be a string array`);
    const cwd = item.cwd ?? '.';
    if (typeof cwd !== 'string') throw new Error(`Invalid cwd for ${id}`);
    const timeoutMs = integer(item.timeoutMs, 30_000, 1, 600_000, 'timeoutMs');
    result.set(id, { command: item.command, args: [...item.args] as string[], cwd, timeoutMs });
  }
  return result;
}
function commandById(commands: Map<string, Command>, args: Record<string, unknown>) {
  if (Object.keys(args).some(key => key !== 'id')) throw new Error('run accepts only a configured command ID');
  const id = stringArg(args, 'id'), command = commands.get(id);
  if (!command) throw new Error(`Unknown configured command: ${id}`);
  return { id, ...command };
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
export function actor(context: ToolContext) { return context.owner ?? 'local'; }
export function shellCommand(command: string, shell?: string) {
  if (command.includes('\0')) throw new Error('Command cannot contain NUL');
  return process.platform === 'win32'
    ? { command: shell ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { command: shell ?? '/bin/sh', args: ['-c', command] };
}
export const sessionInput = { sessionId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 262144 }, waitMs: { type: 'integer', minimum: 0, maximum: 12000 } };

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'process', version: '0.2.0', title: 'Commands and background sessions',
  description: 'Execute commands, stream paged output, send input, and manage long-running processes.',
  permissions: ['process:read', 'process:execute'],
  instructions: 'execute starts a process and returns a session ID. Read output using cursor, then write stdin or stop the session. The process outlives the launch task. Every launch/input/interrupt/stop requires local approval. Processes run as the local user; this is not an OS sandbox. Logs survive restart; interrupted commands are never replayed.',
  setup(context) {
    const commands = readCommands(context.config.commands);
    const sessions = new ProcessSessions(context.stateDir, {
      maxSessions: integer(context.config.maxSessions, 100, 10, 1000, 'maxSessions'),
      maxActive: integer(context.config.maxActive, 8, 1, 64, 'maxActive'),
      maxLogBytes: integer(context.config.maxLogBytes, 2 * 1024 * 1024, 65536, 64 * 1024 * 1024, 'maxLogBytes'),
    });
    context.provide('process.sessions', sessions);
    context.onDispose(() => sessions.close());
    context.registerTool({ name: 'list_commands', title: 'List configured commands', effect: 'read', permissions: ['process:read'],
      description: 'Show locally configured command presets.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return textResult({ commands: [...commands].map(([id, command]) => ({ id, ...command })) }); } });
    context.registerTool({ name: 'run', title: 'Run a configured command', effect: 'execute', permissions: ['process:execute'],
      description: 'Run a locally configured command and wait for its result. Combined output is limited to 64 KiB; sessionId allows reading the durable log.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      timeoutMs: Math.max(30_000, ...[...commands.values()].map(command => command.timeoutMs)) + 3000,
      async preview(args, ctx) {
        const command = commandById(commands, args); await workspacePath(ctx.workspace, command.cwd, { allowRoot: true });
        return { title: `Run ${command.id}`, description: `${command.command} ${JSON.stringify(command.args)}\nDirectory: ${command.cwd}\nTimeout: ${command.timeoutMs} ms\nRuns as your local user.` };
      },
      async execute(args, ctx) {
        const command = commandById(commands, args); checkCancelled(ctx.signal);
        const cwd = await workspacePath(ctx.workspace, command.cwd, { allowRoot: true });
        const stdout: string[] = [], stderr: string[] = []; let capturedBytes = 0, truncated = false;
        const record = await sessions.start({ ...command, cwd, taskId: ctx.taskId, owner: actor(ctx), workspace: ctx.workspace, signal: ctx.signal,
          onOutput(entry) { const bytes = Buffer.from(entry.text), available = Math.max(0, 65536 - capturedBytes); const captured = bytes.subarray(0, available); if (captured.length) (entry.stream === 'stdout' ? stdout : stderr).push(captured.toString('utf8')); capturedBytes += captured.length; truncated ||= captured.length !== bytes.length; } });
        ctx.progress(`Running ${command.id}`);
        const finished = await sessions.wait(record.id, actor(ctx), ctx.workspace, ctx.signal);
        if (ctx.signal.aborted) throw new Error('Command cancelled');
        const result = textResult({ id: command.id, sessionId: record.id, exitCode: finished.exitCode, signal: finished.signal, timedOut: finished.status === 'timed_out', stdout: stdout.join(''), stderr: stderr.join(''), truncated, capturedBytes });
        return { ...result, ...(finished.status !== 'completed' ? { isError: true } : {}) };
      } });
    context.registerTool({ name: 'execute', title: 'Start a command', effect: 'execute', permissions: ['process:execute'],
      description: 'Start an arbitrary shell command or executable with arguments. Returns a session ID immediately. Shell commands can use pipelines; execution has the local user permissions.',
      inputSchema: { type: 'object', properties: { command: { type: 'string', maxLength: 65536 }, executable: { type: 'string', maxLength: 4096 }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 86400000 } }, oneOf: [{ required: ['command'], not: { anyOf: [{ required: ['executable'] }, { required: ['args'] }] } }, { required: ['executable'], not: { required: ['command'] } }], additionalProperties: false },
      async preview(args, ctx) { await workspacePath(ctx.workspace, String(args.cwd ?? '.'), { allowRoot: true }); return { title: 'Start command', description: `${args.command ?? args.executable}\nArguments: ${JSON.stringify(args.args ?? [])}\nDirectory: ${args.cwd ?? '.'}\nRuns as your local user until exit or explicit stop.` }; },
      async execute(args, ctx) {
        checkCancelled(ctx.signal);
        if ((typeof args.command === 'string') === (typeof args.executable === 'string')) throw new Error('Provide exactly one of command or executable');
        const invocation = args.command !== undefined ? shellCommand(stringArg(args, 'command')) : { command: stringArg(args, 'executable'), args: (args.args ?? []) as string[] };
        const cwd = await workspacePath(ctx.workspace, String(args.cwd ?? '.'), { allowRoot: true });
        return textResult({ session: await sessions.start({ ...invocation, cwd, owner: actor(ctx), workspace: ctx.workspace, taskId: ctx.taskId, signal: ctx.signal,
          env: executionEnvironment({ login: true }), timeoutMs: args.timeoutMs === undefined ? undefined : integer(args.timeoutMs, 0, 1, 86400000, 'timeoutMs') }) });
      } });
    context.registerTool({ name: 'list', title: 'List process sessions', effect: 'read', permissions: ['process:read'], description: 'List your process sessions in the selected workspace, including preserved exit and restart states.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult({ sessions: sessions.list(actor(ctx), ctx.workspace) }); } });
    context.registerTool({ name: 'read', title: 'Read process output', effect: 'read', permissions: ['process:read'], description: 'Read persistent output using a cursor; wait up to 12 seconds for new output. outputTruncated reports history rotated away.', inputSchema: { type: 'object', properties: sessionInput, required: ['sessionId'], additionalProperties: false }, timeoutMs: 15000,
      async execute(args, ctx) { return textResult(await sessions.read(stringArg(args, 'sessionId'), actor(ctx), ctx.workspace, args as { cursor?: number; limit?: number; waitMs?: number }, ctx.signal)); } });
    context.registerTool({ name: 'write', title: 'Send process input', effect: 'execute', permissions: ['process:execute'], description: 'Send stdin text; set end=true to close stdin after writing.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, text: { type: 'string', maxLength: 65536 }, end: { type: 'boolean' } }, required: ['sessionId', 'text'], additionalProperties: false },
      async execute(args, ctx) { checkCancelled(ctx.signal); return textResult({ session: await sessions.write(stringArg(args, 'sessionId'), actor(ctx), ctx.workspace, stringArg(args, 'text'), args.end === true) }); } });
    for (const operation of ['interrupt', 'stop'] as const) context.registerTool({ name: operation, title: operation === 'stop' ? 'Stop process tree' : 'Interrupt process', effect: 'execute', permissions: ['process:execute'], description: operation === 'stop' ? 'Stop the process and its child process group; wait until the process exits.' : 'Send SIGINT (Ctrl-C). Use stop if the command ignores interrupt.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
      async execute(args, ctx) { checkCancelled(ctx.signal); return textResult({ session: await sessions[operation](stringArg(args, 'sessionId'), actor(ctx), ctx.workspace) }); } });
  },
};
export default plugin;
