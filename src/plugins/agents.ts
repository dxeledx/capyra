import type { CapyraPlugin } from '../core/types.js';
import { AgentDaemonClient } from '../daemon/client.js';
import { textResult } from '../sdk.js';
import { actor, sessionInput } from './process.js';
import { stringArg, checkCancelled } from './workspace-paths.js';
import type { AgentRecord } from '../execution/agent-manager.js';
import { agentWriteMode, writeModes, type AgentWriteMode } from '../execution/agent-permissions.js';
import { AgentWorkflow, type WorkflowMode } from '../execution/agent-workflow.js';

function presentAgent(record: AgentRecord, offset = Math.max(0, record.turns.length - 1), limit = 1, outputOffset = 0, outputLimit = 8192) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2) throw new Error('Invalid turnOffset or turnLimit');
  if (!Number.isInteger(outputOffset) || outputOffset < 0 || !Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 16384) throw new Error('Invalid outputOffset or outputLimit');
  const page = (value: string | undefined) => value?.slice(outputOffset, outputOffset + outputLimit);
  const turns = record.turns.slice(offset, offset + limit).map(turn => ({ ...turn, prompt: turn.prompt.slice(0, 16384), promptTruncated: turn.prompt.length > 16384,
    response: page(turn.response), responseLength: turn.response?.length ?? 0, error: turn.error?.slice(0, 2000) }));
  const longest = Math.max(record.response?.length ?? 0, ...turns.map(turn => turn.responseLength));
  return { ...record, response: page(record.response), responseLength: record.response?.length ?? 0, progress: record.progress?.slice(-4000), error: record.error?.slice(0, 2000),
    turns, totalTurns: record.turns.length, turnOffset: offset, outputOffset,
    ...(outputOffset + outputLimit < longest ? { nextOutputOffset: outputOffset + outputLimit } : {}),
    ...(offset + turns.length < record.turns.length ? { nextTurnOffset: offset + turns.length } : {}) };
}

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'agents', version: '0.2.0', title: 'Coding agents', requires: ['process'],
  description: 'Delegate tasks to coding agents, resume their native sessions, and inspect durable progress and results.',
  permissions: ['agents:read', 'agents:execute'],
  instructions: 'List targets before dispatch. Targets include the configured workflow instructions or a skill ID to read using agents__workflow. run returns a logical agent ID immediately; inspect it using show/wait, or continue that ID for another turn. Agent execution may consume provider quota. Role instructions are local configuration, loaded only when selected. One turn runs at a time per agent. All dispatch, continuation and cancellation require local approval.',
  setup(context) {
    const manager = new AgentDaemonClient(context.stateDir, context.config);
    if (context.config.workflow !== undefined && (!context.config.workflow || typeof context.config.workflow !== 'object' || Array.isArray(context.config.workflow))) throw new Error('agents.workflow must be an object');
    const workflow = new AgentWorkflow(context.stateDir, context.config.workflow as { enabled?: boolean; instructions?: WorkflowMode } | undefined);
    if (workflow.enabled) workflow.install();
    context.provide('agents.workflow', workflow);
    const previews = new Map<string, { expectedTargetHash: string; writeMode: AgentWriteMode; model?: string; effort?: string; at: number }>();
    const remember = (taskId: string, value: { expectedTargetHash: string; writeMode: AgentWriteMode; model?: string; effort?: string }) => {
      for (const [id, preview] of previews) if (Date.now() - preview.at > 10 * 60_000) previews.delete(id);
      if (previews.size >= 1000) throw new Error('Too many pending agent previews; finish existing requests first');
      previews.set(taskId, { ...value, at: Date.now() });
    };
    const approved = (taskId: string) => {
      const preview = previews.get(taskId); previews.delete(taskId);
      if (!preview || Date.now() - preview.at > 10 * 60_000) throw new Error('Agent preview is no longer available. Prepare a new request.');
      const { at: _at, ...snapshot } = preview; return snapshot;
    };
    context.onDispose(() => previews.clear());
    context.provide('agents.manager', Object.assign(manager, {
      // 仅供可信本机控制面调用；MCP 工具仍按 ctx.owner 读取，不能指定代办 owner。
      async getLocal(id: string, workspace: string, page: { turnOffset?: number; turnLimit?: number; outputOffset?: number; outputLimit?: number } = {}) {
        const record = (await manager.listLocal(workspace)).find(record => record.id === id && record.workspace === workspace);
        if (!record) throw new Error('Unknown agent session in the selected workspace');
        return presentAgent(await manager.get(id, record.owner, workspace), page.turnOffset, page.turnLimit, page.outputOffset, page.outputLimit);
      },
    })); context.onDispose(() => manager.close());
    context.registerTool({ name: 'targets', title: 'Available coding agents', description: 'List configured providers and role profiles with locally detected availability; no provider process is started.', effect: 'read', permissions: ['agents:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult(await manager.catalog(ctx.workspace)); } });
    context.registerTool({ name: 'workflow', title: 'Read agent workflow skill', description: 'Read the managed subagents workflow by its stable ID. Includes complete briefs, waiting, continuation and project skill discovery guidance.', effect: 'read', permissions: ['agents:read'], inputSchema: { type: 'object', properties: { id: { type: 'string', enum: ['subagents'] } }, additionalProperties: false },
      async execute(args, ctx) { checkCancelled(ctx.signal); return textResult(workflow.read(args.id as string | undefined)); } });
    context.registerTool({ name: 'install_workflow', title: 'Install agent workflow skill', description: 'Synchronize the bundled subagents skill to private Capyra state. Does not change global skills, install SDKs or start a provider.', effect: 'execute', permissions: ['agents:execute'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async preview() { return { title: 'Install subagents workflow', description: 'Synchronize the application-managed subagents skill in this project’s private Capyra state. User global skill directories are not modified.' }; },
      async execute(_args, ctx) { checkCancelled(ctx.signal); return textResult(workflow.install()); } });
    context.registerTool({ name: 'run', title: 'Dispatch an agent', description: 'Start a background coding-agent turn using an installed provider and its existing local login. The returned agent ID can be queried or continued.', effect: 'execute', permissions: ['agents:execute'],
      inputSchema: { type: 'object', properties: { target: { type: 'string' }, prompt: { type: 'string', minLength: 1, maxLength: 128000 }, cwd: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, writeMode: { type: 'string', enum: [...writeModes] } }, required: ['target', 'prompt'], additionalProperties: false },
      async preview(args, ctx) { const target = await manager.preview(stringArg(args, 'target'), ctx.workspace); const mode = agentWriteMode(args.writeMode, target.writeMode); if (target.provider === 'command' && mode !== 'full_access') throw new Error('Custom command providers support only full_access'); remember(ctx.taskId, { expectedTargetHash: target.targetHash, writeMode: mode, model: args.model as string | undefined ?? target.model, effort: args.effort as string | undefined ?? target.effort }); return { title: `Dispatch ${target.target}`, description: `${target.notice}\nProvider: ${target.provider}\nWrite mode: ${mode}${mode === 'full_access' ? ' (unrestricted provider access)' : ''}\nModel: ${args.model ?? target.model ?? 'provider default'}\nEffort: ${args.effort ?? target.effort ?? 'provider default'}\nDirectory: ${args.cwd ?? '.'}\n${target.instructions ?? ''}\n\n${stringArg(args, 'prompt')}` }; },
      async execute(args, ctx) { return textResult({ agent: presentAgent(await manager.run({ ...(args as { target: string; prompt: string; cwd?: string }), ...approved(ctx.taskId) }, ctx)) }); } });
    context.registerTool({ name: 'continue', title: 'Continue an agent', description: 'Resume the exact native session associated with this logical agent ID and send a new prompt.', effect: 'execute', permissions: ['agents:execute'],
      inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, prompt: { type: 'string', minLength: 1, maxLength: 128000 }, model: { type: 'string' }, effort: { type: 'string' }, writeMode: { type: 'string', enum: [...writeModes] } }, required: ['agentId', 'prompt'], additionalProperties: false },
      async preview(args, ctx) { const record = await manager.get(stringArg(args, 'agentId'), actor(ctx), ctx.workspace); const target = await manager.preview(record.target, ctx.workspace); const mode = agentWriteMode(args.writeMode, agentWriteMode(record.writeMode, record.provider === 'command' ? 'full_access' : 'read_only')); remember(ctx.taskId, { expectedTargetHash: target.targetHash, writeMode: mode, model: args.model as string | undefined ?? record.model, effort: args.effort as string | undefined ?? record.effort }); return { title: `Continue ${record.target}`, description: `Provider: ${record.provider}\nWrite mode: ${mode}${mode === 'full_access' ? ' (unrestricted provider access)' : ''}\nUses the existing provider session and may consume paid quota.\n\n${stringArg(args, 'prompt')}` }; },
      async execute(args, ctx) { return textResult({ agent: presentAgent(await manager.continue(stringArg(args, 'agentId'), { prompt: stringArg(args, 'prompt'), ...approved(ctx.taskId) }, ctx)) }); } });
    context.registerTool({ name: 'list', title: 'List agent sessions', description: 'List your coding agents and latest status in the current workspace.', effect: 'read', permissions: ['agents:read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, ctx) { return textResult({ agents: await manager.list(actor(ctx), ctx.workspace), runtime: await manager.status() }); } });
    context.registerTool({ name: 'show', title: 'Read agent result', description: 'Read the latest turn by default; use turnOffset/turnLimit for history and outputOffset/outputLimit for full response pagination.', effect: 'read', permissions: ['agents:read'], inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, turnOffset: { type: 'integer', minimum: 0 }, turnLimit: { type: 'integer', minimum: 1, maximum: 2 }, outputOffset: { type: 'integer', minimum: 0 }, outputLimit: { type: 'integer', minimum: 1, maximum: 16384 } }, required: ['agentId'], additionalProperties: false }, async execute(args, ctx) { return textResult({ agent: presentAgent(await manager.get(stringArg(args, 'agentId'), actor(ctx), ctx.workspace), args.turnOffset as number | undefined, args.turnLimit as number | undefined, args.outputOffset as number | undefined, args.outputLimit as number | undefined) }); } });
    context.registerTool({ name: 'output', title: 'Read provider process output', description: 'Read the latest native provider process log, or select a process session ID from the agent turn. SDK-only providers expose structured progress through show.', effect: 'read', permissions: ['agents:read'], timeoutMs: 15000,
      inputSchema: { type: 'object', properties: { ...sessionInput, agentId: { type: 'string' } }, required: ['agentId'], additionalProperties: false },
      async execute(args, ctx) { return textResult(await manager.readOutput(stringArg(args, 'agentId'), args.sessionId as string | undefined, actor(ctx), ctx.workspace, args as { cursor?: number; limit?: number; waitMs?: number }, ctx.signal)); } });
    context.registerTool({ name: 'wait', title: 'Wait for agent results', description: 'Wait up to 12 seconds for up to 20 agent sessions. Returns compact states; use show for complete results.', effect: 'read', permissions: ['agents:read'], timeoutMs: 15000, inputSchema: { type: 'object', properties: { agentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, waitMs: { type: 'integer', minimum: 0, maximum: 12000 } }, required: ['agentIds'], additionalProperties: false }, async execute(args, ctx) { return textResult({ agents: (await manager.wait(args.agentIds as string[], actor(ctx), ctx.workspace, args.waitMs as number | undefined, ctx.signal)).map(record => ({ id: record.id, target: record.target, status: record.status, response: record.response?.slice(0, 12000), error: record.error, updatedAt: record.updatedAt, turnCount: record.turns.length })) }); } });
    context.registerTool({ name: 'cancel', title: 'Cancel an agent', description: 'Cancel the active provider turn and release its process resources; preserve existing output and session identity.', effect: 'execute', permissions: ['agents:execute'], inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'], additionalProperties: false }, async execute(args, ctx) { checkCancelled(ctx.signal); return textResult({ agent: presentAgent(await manager.cancel(stringArg(args, 'agentId'), actor(ctx), ctx.workspace)) }); } });
  },
};
export default plugin;
