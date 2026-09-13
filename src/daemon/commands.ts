import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../core/types.js';
import type { AgentRecord } from '../execution/agent-manager.js';
import { agentWriteMode } from '../execution/agent-permissions.js';
import { AgentWorkflow } from '../execution/agent-workflow.js';
import { AgentDaemonClient } from './client.js';

export const agentCommandHelp = `capyra agents targets
capyra agents run <target> <prompt> [--model name] [--effort level] [--cwd path] [--write-mode allowed]
capyra agents continue <id> <prompt> [--model name] [--effort level] [--write-mode allowed]
capyra agents show <id>
capyra agents output <id> [--session-id id] [--cursor 0] [--limit 16384]
capyra agents wait <id...> [--wait-ms 12000]
capyra agents ls
capyra agents cancel <id>
capyra agents workflow status|show|install
capyra agents daemon status|stop|logs [--force] [--lines 100]
Use --json for full structured output. Existing provider login and quota apply.
--write-mode accepts read_only, allowed, or full_access. full_access authorizes unrestricted provider execution as the local user.`;

export async function runAgentCommand(args: string[], config: RuntimeConfig, options: {
  write?(text: string): void; flags?: Record<string, string | boolean | undefined>; owner?: string;
} = {}): Promise<void> {
  const flags = options.flags ?? {}, write = options.write ?? (text => process.stdout.write(text + '\n'));
  const entry = config.plugins.find(plugin => plugin.id === 'agents');
  const client = new AgentDaemonClient(config.stateDir, entry?.config ?? {});
  const context = { owner: options.owner ?? 'local-console', workspace: config.workspace, taskId: `cli-${randomUUID()}`, signal: new AbortController().signal, progress() {} };
  const string = (key: string) => typeof flags[key] === 'string' ? flags[key] as string : undefined;
  const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`Missing ${name}.\n${agentCommandHelp}`); return value; };
  const writeMode = () => string('write-mode') === undefined ? undefined : agentWriteMode(string('write-mode'));
  const emit = (value: unknown) => write(JSON.stringify(value, null, flags.json ? 2 : undefined));
  const output = (record: AgentRecord) => flags.json ? emit(record) : write(`${record.id} ${record.status}\n${record.response ?? record.error ?? record.progress ?? ''}`.trimEnd());
  try {
    if (args[0] === 'daemon') {
      switch (args[1] ?? 'status') {
        case 'status': emit(await client.status()); return;
        case 'stop': emit(await client.stop(flags.force === true)); return;
        case 'logs': { const logs = client.logs(Number(string('lines') ?? 100)); if (flags.json) emit({ logs }); else if (logs) write(logs); return; }
        default: throw new Error(agentCommandHelp);
      }
    }
    if (!entry?.enabled) throw new Error('The agents plugin is disabled. Enable it before using agent commands.');
    switch (args[0] ?? 'targets') {
      case 'workflow': {
        const workflow = new AgentWorkflow(config.stateDir, entry.config?.workflow as ConstructorParameters<typeof AgentWorkflow>[1]);
        switch (args[1] ?? 'status') {
          case 'status': emit(workflow.context()); return;
          case 'show': { const skill = workflow.read('subagents'); if (flags.json) emit(skill); else write(skill.content); return; }
          case 'install': emit(workflow.install()); return;
          default: throw new Error('Use capyra agents workflow status, show, or install.');
        }
      }
      case 'targets': emit(await client.catalog(config.workspace)); return;
      case 'run': {
        const record = await client.run({ target: required(args[1], 'target'), prompt: required(string('prompt') ?? args.slice(2).join(' '), 'prompt'), cwd: string('cwd'), model: string('model'), effort: string('effort'), writeMode: writeMode() }, context);
        emit(flags.json ? record : { id: record.id, status: record.status }); return;
      }
      case 'continue': {
        const record = await client.continue(required(args[1], 'agent ID'), { prompt: required(string('prompt') ?? args.slice(2).join(' '), 'prompt'), model: string('model'), effort: string('effort'), writeMode: writeMode() }, context);
        emit(flags.json ? record : { id: record.id, status: record.status }); return;
      }
      case 'show': output(await client.get(required(args[1], 'agent ID'), context.owner, config.workspace)); return;
      case 'output': emit(await client.readOutput(required(args[1], 'agent ID'), string('session-id'), context.owner, config.workspace, { cursor: Number(string('cursor') ?? 0), limit: Number(string('limit') ?? 16_384), waitMs: Number(string('wait-ms') ?? 0) })); return;
      case 'list': case 'ls': {
        const records = await client.list(context.owner, config.workspace);
        emit(flags.json ? records : records.map(record => ({ id: record.id, target: record.target, status: record.status }))); return;
      }
      case 'wait': {
        const records = await client.wait(args.slice(1), context.owner, config.workspace, Number(string('wait-ms') ?? 12_000));
        if (flags.json) emit(records); else for (const record of records) output(record); return;
      }
      case 'cancel': output(await client.cancel(required(args[1], 'agent ID'), context.owner, config.workspace)); return;
      default: throw new Error(agentCommandHelp);
    }
  } finally { await client.close(); }
}
