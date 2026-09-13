import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentWorkflow } from '../src/execution/agent-workflow.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capyra-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, state: path.join(root, 'state') };
}
test('construction, discovery and bundled reads leave an absent state directory untouched', t => {
  const { state } = fixture(t);
  const workflow = new AgentWorkflow(state);
  assert.equal(existsSync(state), false);
  const skill = workflow.discover()[0];
  assert.equal(skill.id, 'subagents'); assert.equal(skill.readTool, 'agents__workflow');
  assert.equal(skill.installed, false); assert.equal(skill.source, 'bundled');
  assert.equal('content' in skill, false); assert.equal('path' in skill, false);
  assert.match(workflow.read().content, /# Capyra subagents/);
  assert.match(workflow.read().content, /agents__wait with agentIds/);
  assert.match(workflow.read().content, /agents__show with agentId/);
  assert.match(workflow.read().content, /agents__output with agentId, optional sessionId/);
  const context = workflow.context();
  assert.equal(context.mode, 'on-demand'); assert.equal(context.skills.length, 1);
  assert.equal(context.installed, false);
  workflow.taskPrompt({ prompt: 'Review parser', roleInstructions: 'Find correctness issues' });
  assert.equal(existsSync(state), false);
});
test('explicit installation writes the current managed skill privately and repeat installs do not rewrite it', t => {
  const { root, state } = fixture(t);
  const outside = path.join(root, 'unrelated-global-skill.md'); writeFileSync(outside, 'preserve me');
  const workflow = new AgentWorkflow(state);
  const metadata = workflow.install();
  assert.equal(metadata.installed, true); assert.equal(metadata.source, 'managed');
  assert.equal(metadata.version, '1');
  const source = readFileSync(workflow.managedPath, 'utf8');
  assert.equal(source, workflow.read().content);
  assert.equal(metadata.hash, createHash('sha256').update(source).digest('hex'));
  assert.equal(metadata.bytes, Buffer.byteLength(source));
  const before = lstatSync(workflow.managedPath, { bigint: true });
  workflow.install();
  const after = lstatSync(workflow.managedPath, { bigint: true });
  assert.equal(before.mtimeNs, after.mtimeNs); assert.equal(before.ino, after.ino);
  if (process.platform !== 'win32') assert.equal(Number(after.mode) & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(workflow.managedPath)), ['SKILL.md']);
  assert.equal(readFileSync(outside, 'utf8'), 'preserve me');
});
test('stale managed text is never injected and changes only during explicit installation', t => {
  const { state } = fixture(t); const workflow = new AgentWorkflow(state, { instructions: 'preload' });
  workflow.install(); writeFileSync(workflow.managedPath, '# Older workflow version\n');
  assert.equal(workflow.read().source, 'bundled'); assert.equal(workflow.context().installed, false);
  assert.doesNotMatch(workflow.context().instructions, /Older workflow/);
  assert.equal(readFileSync(workflow.managedPath, 'utf8'), '# Older workflow version\n');
  assert.equal(workflow.install().installed, true);
  assert.equal(readFileSync(workflow.managedPath, 'utf8'), workflow.read().content);
  assert.deepEqual(readdirSync(path.dirname(workflow.managedPath)), ['SKILL.md']);
});
test('preload injects the actual full skill while on-demand offers a compact readable locator', t => {
  const { state } = fixture(t);
  const lazy = new AgentWorkflow(state), preload = new AgentWorkflow(state, { instructions: 'preload' });
  const source = lazy.read().content;
  assert.equal(preload.context().instructions, source);
  assert.equal(preload.context().skills.length, 0);
  assert.match(lazy.context().instructions, /agents__workflow/);
  assert.ok(Buffer.byteLength(lazy.context().instructions) < Buffer.byteLength(source) / 3);
  assert.doesNotMatch(lazy.context().instructions, /## Continue or stop/);
  assert.equal(existsSync(state), false);
});
test('native task context contains the selected role and location without assuming parent MCP access', t => {
  const { state } = fixture(t);
  const input = { prompt: 'Verify the parser boundary', roleInstructions: 'Report concrete correctness defects',
    target: { id: 'reviewer', provider: 'pi', description: 'Focused source review', model: 'configured-model' }, workspace: '/project', cwd: '/project/src' };
  const lazy = new AgentWorkflow(state), preload = new AgentWorkflow(state, { instructions: 'preload' });
  const prompt = lazy.taskPrompt(input);
  for (const expected of ['Focused source review', 'Report concrete correctness defects', 'Verify the parser boundary', '/project/src', 'configured-model']) assert.ok(prompt.includes(expected));
  assert.match(prompt, /Native providers do not automatically receive the parent MCP connection/);
  assert.match(prompt, /ask the coordinating parent to include/);
  assert.match(prompt, /skills__discover/); assert.match(prompt, /skills__read/); assert.match(prompt, /skills__rules/);
  assert.ok(!prompt.includes(lazy.managedPath)); assert.ok(!prompt.includes(lazy.read().content));
  assert.ok(preload.taskPrompt(input).includes(preload.read().content));
});
test('target metadata exposes capabilities without environment, executable or role-prompt material', t => {
  const { state } = fixture(t); const workflow = new AgentWorkflow(state);
  const target = { id: 'reviewer', provider: 'pi', title: 'Reviewer', description: 'Review code', available: true,
    env: { TOKEN: 'private-value' }, executable: '/private/tool', prompt: 'private-role-text' };
  assert.deepEqual(workflow.context([target]).targets, [{ id: 'reviewer', provider: 'pi', title: 'Reviewer', description: 'Review code', available: true }]);
});
test('unknown IDs and traversal inputs cannot select managed resources or outside files', t => {
  const { state } = fixture(t); const workflow = new AgentWorkflow(state);
  for (const id of ['../secret', '/tmp/secret', 'subagents/SKILL.md', 'subagents/../secret', 'subagents\\SKILL.md', '%2e%2e/secret', 'subagents\0']) {
    assert.throws(() => workflow.read(id), /Unknown agent workflow skill ID/);
  }
  assert.equal(existsSync(state), false);
});
test('state, managed-directory and file symlinks are rejected during reading and installation', t => {
  const { root, state } = fixture(t);
  const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'SKILL.md'), 'private outside content');
  for (const component of ['', 'agent-workflow', 'agent-workflow/skills', 'agent-workflow/skills/subagents', 'agent-workflow/skills/subagents/SKILL.md']) {
    rmSync(state, { recursive: true, force: true });
    const target = component ? path.join(state, component) : state;
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(component.endsWith('SKILL.md') ? path.join(outside, 'SKILL.md') : outside, target, component.endsWith('SKILL.md') ? 'file' : 'junction');
    const workflow = new AgentWorkflow(state);
    assert.throws(() => workflow.read(), /symbolic/i);
    assert.throws(() => workflow.discover(), /symbolic/i);
    assert.throws(() => workflow.install(), /symbolic/i);
    assert.equal(readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'private outside content');
    assert.deepEqual(readdirSync(outside), ['SKILL.md']);
  }
});
test('hard links, directories, oversized and binary managed entries are rejected', t => {
  const { root, state } = fixture(t); const workflow = new AgentWorkflow(state); workflow.install();
  const outside = path.join(root, 'outside.md'); writeFileSync(outside, 'outside');
  rmSync(workflow.managedPath); linkSync(outside, workflow.managedPath);
  assert.throws(() => workflow.read(), /hard links/);
  assert.throws(() => workflow.install(), /hard links/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
  rmSync(workflow.managedPath); mkdirSync(workflow.managedPath);
  assert.throws(() => workflow.read(), /regular file/);
  rmSync(workflow.managedPath, { recursive: true }); writeFileSync(workflow.managedPath, 'x'.repeat(65_537));
  assert.throws(() => workflow.read(), /64 KiB/);
  writeFileSync(workflow.managedPath, 'binary\0'); assert.throws(() => workflow.read(), /UTF-8/);
});
test('read-only and disabled instances preserve read boundaries and configuration is validated', t => {
  const { state } = fixture(t);
  const readonly = new AgentWorkflow(state, { readOnly: true });
  assert.equal(readonly.context().installed, false);
  assert.throws(() => readonly.install(), /read-only/);
  const disabled = new AgentWorkflow(state, { enabled: false });
  assert.deepEqual(disabled.discover(), []); assert.equal(disabled.context().instructions, '');
  assert.throws(() => disabled.read(), /disabled/); assert.throws(() => disabled.install(), /disabled/);
  assert.throws(() => new AgentWorkflow(state, { instructions: 'unknown' as never }), /on-demand or preload/);
  assert.equal(existsSync(state), false);
});
