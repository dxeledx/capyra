import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/plugins/agents.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';
import { AgentManager } from '../src/execution/agent-manager.js';
import { AgentWorkflow } from '../src/execution/agent-workflow.js';
import { ProcessSessions } from '../src/execution/sessions.js';

test('agents plugin installs and exposes the private workflow through real tool registrations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-workflow-plugin-')), state = path.join(root, 'state'), tools = new Map<string, ToolDefinition>(), services = new Map<string, unknown>(), disposers: (() => void | Promise<void>)[] = [];
  const context = { workspace: root, stateDir: state, config: { profileDirs: [], workflow: { instructions: 'preload' } }, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {}; }, provide(name: string, value: unknown) { services.set(name, value); }, service(name: string) { return services.get(name); }, onDispose(fn: () => void | Promise<void>) { disposers.push(fn); }, onEvent() {}, guard() {} } as PluginContext;
  await plugin.setup(context);
  t.after(async () => { for (const dispose of disposers) await dispose(); await rm(root, { recursive: true, force: true }); });
  const workflow = services.get('agents.workflow') as AgentWorkflow;
  assert.equal(await readFile(workflow.managedPath, 'utf8'), workflow.read().content);
  const ctx: ToolContext = { owner: 'local-console', workspace: root, taskId: 'workflow', signal: new AbortController().signal, progress() {} };
  const invoke = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await tools.get(name)!.execute(args, ctx)).content[0] as { text: string }).text);
  assert.equal(tools.get('workflow')!.effect, 'read'); assert.equal(tools.get('install_workflow')!.effect, 'execute');
  const catalog = await invoke('targets'); assert.equal(catalog.workflow.mode, 'preload'); assert.equal(catalog.workflow.installed, true); assert.match(catalog.workflow.instructions, /# Capyra subagents/);
  const skill = await invoke('workflow', { id: 'subagents' }); assert.equal(skill.source, 'managed'); assert.match(skill.content, /agentIds/);
  assert.equal((await invoke('install_workflow')).hash, skill.hash);
});

test('agent dispatch receives the selected role and real workflow mode without configuration secrets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-workflow-dispatch-')), sessions = new ProcessSessions(path.join(root, 'state'));
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const ctx: ToolContext = { owner: 'local-console', workspace: root, taskId: 'workflow', signal: new AbortController().signal, progress() {} };
  for (const mode of ['on-demand', 'preload'] as const) {
    const manager = new AgentManager(sessions, path.join(root, mode), { profileDirs: [], workflow: { instructions: mode }, providers: { command: { provider: 'command', executable: process.execPath, args: [], env: { NEVER_IN_PROMPT: 'private-value' } } }, roles: { reviewer: { provider: 'command', prompt: 'Read the relevant code and preserve unrelated changes.' } } }); t.after(() => manager.close());
    let prompt = '';
    manager.drivers.set('command', { async run(input) { prompt = input.prompt; input.onSession('native'); return { providerSessionId: 'native', response: 'done' }; } });
    const record = await manager.run({ target: 'reviewer', prompt: 'Inspect fixture.txt' }, ctx); await manager.wait([record.id], 'local-console', root);
    assert.match(prompt, /Capyra task context/); assert.match(prompt, /reviewer/); assert.match(prompt, /Role instructions\nRead the relevant code/); assert.match(prompt, /Assigned task\nInspect fixture.txt/);
    assert.equal(prompt.includes('private-value'), false); assert.match(prompt, /Native provider/i);
    if (mode === 'preload') assert.match(prompt, /# Capyra subagents/); else { assert.match(prompt, /agents__workflow/); assert.equal(prompt.includes('# Capyra subagents'), false); }
    assert.equal(manager.get(record.id, 'local-console', root).turns[0].prompt, 'Inspect fixture.txt');
  }
});
