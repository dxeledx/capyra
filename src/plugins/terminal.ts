import type { CapyraPlugin } from '../core/types.js';
import type { ProcessSessions } from '../execution/sessions.js';
import { executionEnvironment } from '../execution/sessions.js';
import { textResult } from '../sdk.js';
import { actor, integer, sessionInput, shellCommand } from './process.js';
import { checkCancelled, stringArg, workspacePath } from './workspace-paths.js';
import { installTerminalExtension, terminalExtension } from '../execution/terminal-extension.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'terminal', version: '0.2.0', title: 'Interactive terminal',
  description: 'Real on-demand PTY shells with input, output, resize and interrupt.', requires: ['process'],
  permissions: ['terminal:read', 'terminal:execute'],
  instructions: 'open starts a real PTY. Use read and its nextCursor for incremental output, write for keys (including Ctrl-C), resize for viewport size, close to release the terminal. The optional PTY extension is loaded only when a terminal is opened.',
  setup(context) {
    const sessions = context.service<ProcessSessions>('process.sessions');
    const owns = (id: string, owner: string, workspace: string) => { if (sessions.get(id, owner, workspace).kind !== 'terminal') throw new Error('Unknown terminal session'); };
    const launched = new Map<string, { owner: string; workspace: string }>();
    context.onDispose(async () => { await Promise.all([...launched].map(([id, scope]) => sessions.stop(id, scope.owner, scope.workspace, 'interrupted'))); launched.clear(); });
    context.registerTool({ name: 'status', title: 'Terminal availability', effect: 'read', permissions: ['terminal:read'], description: 'Check whether the optional terminal extension is installed. This check starts no shell.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute() { return textResult(await sessions.ptyStatus()); } });
    context.registerTool({ name: 'install_extension', title: 'Install interactive terminal capability', effect: 'execute', permissions: ['terminal:execute'], timeoutMs: 610000,
      description: 'Install the fixed official node-pty extension with a verified dependency lock. Downloads native code; Linux requires local compiler tools. Runs only after local approval.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async preview() { return { title: 'Install terminal extension', description: `Package: ${terminalExtension.name}@${terminalExtension.version}\nRegistry: ${terminalExtension.registry}\nIntegrity: ${terminalExtension.integrity}\nInstallation is isolated under Capyra state/extensions/terminal. Native package build scripts run after download verification. Linux needs a C/C++ compiler and Python.` }; },
      async execute(_args, ctx) { return textResult(await installTerminalExtension(sessions, context.stateDir, ctx)); } });
    context.registerTool({ name: 'open', title: 'Open interactive terminal', effect: 'execute', permissions: ['terminal:execute'], description: 'Open a real pseudo-terminal using the locally configured shell; optionally start a shell command.', inputSchema: { type: 'object', properties: { command: { type: 'string', maxLength: 65536 }, cwd: { type: 'string' }, columns: { type: 'integer', minimum: 1, maximum: 1000 }, rows: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false },
      async preview(args, ctx) { await workspacePath(ctx.workspace, String(args.cwd ?? '.'), { allowRoot: true }); return { title: 'Open terminal', description: `${args.command ?? 'Interactive shell'}\nDirectory: ${args.cwd ?? '.'}\nShell runs as your local user.` }; },
      async execute(args, ctx) {
        const cwd = await workspacePath(ctx.workspace, String(args.cwd ?? '.'), { allowRoot: true }); checkCancelled(ctx.signal);
        const shell = typeof context.config.shell === 'string' ? context.config.shell : process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh';
        const invocation = args.command === undefined ? { command: shell, args: process.platform === 'win32' ? [] : ['-i'] } : shellCommand(stringArg(args, 'command'), shell);
        const session = await sessions.start({ ...invocation, kind: 'terminal', tty: true, cwd, workspace: ctx.workspace, owner: actor(ctx), taskId: ctx.taskId, signal: ctx.signal,
          env: { ...executionEnvironment({ login: true }), TERM: 'xterm-256color' }, columns: integer(args.columns, 100, 1, 1000, 'columns'), rows: integer(args.rows, 30, 1, 1000, 'rows'), onExit(record) { launched.delete(record.id); } });
        launched.set(session.id, { owner: actor(ctx), workspace: ctx.workspace }); return textResult({ session });
      } });
    context.registerTool({ name: 'list', title: 'List terminals', effect: 'read', permissions: ['terminal:read'], description: 'List terminal sessions for your current workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult({ sessions: sessions.list(actor(ctx), ctx.workspace, 'terminal') }); } });
    context.registerTool({ name: 'read', title: 'Read terminal output', effect: 'read', permissions: ['terminal:read'], description: 'Read PTY output by cursor, including ANSI control sequences.', inputSchema: { type: 'object', properties: sessionInput, required: ['sessionId'], additionalProperties: false }, timeoutMs: 15000,
      async execute(args, ctx) { const id = stringArg(args, 'sessionId'); owns(id, actor(ctx), ctx.workspace); return textResult(await sessions.read(id, actor(ctx), ctx.workspace, args as { cursor?: number; limit?: number; waitMs?: number }, ctx.signal)); } });
    context.registerTool({ name: 'write', title: 'Send terminal input', effect: 'execute', permissions: ['terminal:execute'], description: 'Send text or control characters, such as newline, Ctrl-C (\\u0003), or Ctrl-D (\\u0004).', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, text: { type: 'string', maxLength: 65536 } }, required: ['sessionId', 'text'], additionalProperties: false }, async execute(args, ctx) { const id = stringArg(args, 'sessionId'); owns(id, actor(ctx), ctx.workspace); checkCancelled(ctx.signal); return textResult({ session: await sessions.write(id, actor(ctx), ctx.workspace, stringArg(args, 'text')) }); } });
    context.registerTool({ name: 'resize', title: 'Resize terminal', effect: 'execute', permissions: ['terminal:execute'], description: 'Set terminal columns and rows; applications receive the PTY resize event.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, columns: { type: 'integer', minimum: 1, maximum: 1000 }, rows: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['sessionId', 'columns', 'rows'], additionalProperties: false }, async execute(args, ctx) { const id = stringArg(args, 'sessionId'); owns(id, actor(ctx), ctx.workspace); checkCancelled(ctx.signal); return textResult({ session: sessions.resize(id, actor(ctx), ctx.workspace, Number(args.columns), Number(args.rows)) }); } });
    context.registerTool({ name: 'close', title: 'Close terminal', effect: 'execute', permissions: ['terminal:execute'], description: 'Stop the terminal process tree and preserve the log.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false }, async execute(args, ctx) { const id = stringArg(args, 'sessionId'); owns(id, actor(ctx), ctx.workspace); checkCancelled(ctx.signal); return textResult({ session: await sessions.stop(id, actor(ctx), ctx.workspace) }); } });
  },
};
export default plugin;
