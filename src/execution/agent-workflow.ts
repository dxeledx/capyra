import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type WorkflowMode = 'on-demand' | 'preload';
export interface WorkflowTarget {
  id: string; provider: string; title?: string; description?: string; model?: string; effort?: string; writeMode?: string; available?: boolean;
}
export interface WorkflowSkill {
  id: string; name: string; description: string; version: string; hash: string; bytes: number;
  source: 'managed' | 'bundled'; installed: boolean; readTool: 'agents__workflow';
}
export interface WorkflowContext {
  enabled: boolean; mode: WorkflowMode; version: string; installed: boolean;
  skills: WorkflowSkill[]; targets: WorkflowTarget[]; instructions: string;
}
const version = '1';
const description = 'Delegate a bounded task, inspect its result, and continue related work with an available Capyra coding agent.';
// 正文随应用代码发布，托管副本仅写入显式传入的状态目录；不接触用户全局 Skills。
const bundledSkill = `---
name: subagents
description: ${description}
version: ${version}
---

# Capyra subagents

Delegate when a separate worker helps through independent context, specialization, or focused verification. Routine work can use the existing workspace tools directly.

## Choose an available target

Use agents__targets to discover configured providers and roles. Select a matching role by its returned target ID; use a provider target when a specific provider is needed. Check availability and retain its configured model, effort, and write mode unless the task requires an explicitly authorized override.

## Give a complete brief

Use agents__run with target and prompt. Include the objective, workspace-relative paths, scope and ownership, relevant findings, constraints, and expected result. The worker receives this brief, selected role instructions, and its task context; it does not inherit the parent conversation. For parallel edits, assign separate files or responsibilities and tell each worker to preserve other workers' changes.

Before editing, obtain the project rules and relevant skills. If Capyra tools are available, use skills__rules for the target path, skills__discover to find skills, then skills__read with a discovered ID. Read a matching skill before applying it. A native provider does not automatically inherit the parent's MCP connection or private state access; when these tools are unavailable, ask the coordinating parent to include the needed rules or skill content in the brief.

## Inspect or wait

Keep the logical agent ID returned by agents__run. Use agents__wait with agentIds (an array) and optional waitMs to express a dependency; one call accepts several agent IDs and waits up to 12000 ms. If work remains running, continue independent work or wait again. Use agents__show with agentId for an immediate snapshot and agents__list for agents in the current workspace. Use agents__output with agentId, optional sessionId, and its returned cursor when persistent raw output is needed. A running receipt or partial output is not a completed result; inspect status, response, and error before using the result.

## Continue or stop

Use agents__continue with the existing agentId and a self-contained follow-up prompt when its provider context remains relevant. Start another agent for unrelated work. One turn runs at a time per logical agent. Use agents__cancel with agentId when the assigned work should stop. After a restart, inspect interrupted work and explicitly continue it; prompts are not replayed automatically.

## Local CLI

When local CLI access is authorized and configured, the same workflow is available through capyra agents targets; capyra agents run TARGET --prompt BRIEF; capyra agents wait ID --wait-ms 12000; capyra agents show ID; capyra agents continue ID --prompt BRIEF; and capyra agents cancel ID. Select the intended --config and --workspace. CLI dispatch uses local-console ownership and is a separate local entry point; it must not be used to bypass the current task's approval or permission boundary.

Use the tools actually exposed by the client. In compact MCP mode, discover the corresponding tool ID and invoke it through capyra_call. Skill guidance does not grant access, approve requests, or change provider permissions. Report the files or findings produced, the verification performed, and any remaining limitation.
`;
const hash = createHash('sha256').update(bundledSkill).digest('hex');
const bytes = Buffer.byteLength(bundledSkill);
const compactInstructions = 'For bounded delegation, discover available targets and read the subagents skill with agents__workflow (id: subagents) when needed. If Capyra MCP tools are available, discover project skills with skills__discover and read selected IDs with skills__read; obtain applicable rules with skills__rules. Native providers do not automatically receive the parent MCP connection. If these tools are unavailable, ask the coordinating parent to include the required instructions in the brief.';
const maxSkillBytes = 65_536;

function targetMetadata(target: WorkflowTarget): WorkflowTarget {
  const { id, provider, title, description, model, effort, writeMode, available } = target;
  return { id, provider, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    ...(writeMode === undefined ? {} : { writeMode }), ...(available === undefined ? {} : { available }) };
}

/** 托管工作流的只读发现与显式安装分离；构造、发现和生成任务上下文均不写盘。 */
export class AgentWorkflow {
  readonly mode: WorkflowMode;
  readonly enabled: boolean;
  readonly managedPath: string;
  private readonly stateDir: string;
  constructor(stateDir: string, private readonly options: { instructions?: WorkflowMode; enabled?: boolean; readOnly?: boolean } = {}) {
    if (options.instructions !== undefined && !['on-demand', 'preload'].includes(options.instructions)) throw new Error('Agent workflow instructions must be on-demand or preload');
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error('Agent workflow enabled must be a boolean');
    this.mode = options.instructions ?? 'on-demand'; this.enabled = options.enabled ?? true;
    this.stateDir = path.resolve(stateDir);
    this.managedPath = path.join(this.stateDir, 'agent-workflow', 'skills', 'subagents', 'SKILL.md');
  }
  private checkDirectories(create: boolean) {
    const directories = [this.stateDir, path.dirname(path.dirname(path.dirname(this.managedPath))), path.dirname(path.dirname(this.managedPath)), path.dirname(this.managedPath)];
    for (const [index, directory] of directories.entries()) {
      let info;
      try { info = lstatSync(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return false;
        mkdirSync(directory, { recursive: index === 0, mode: 0o700 });
        info = lstatSync(directory);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Agent workflow directory must be a regular directory without symbolic links');
    }
    return true;
  }
  private managedContent(): string | undefined {
    if (!this.checkDirectories(false)) return;
    let info;
    try { info = lstatSync(this.managedPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('Managed workflow skill must be a regular file without symbolic or hard links');
    const descriptor = openSync(this.managedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Managed workflow skill changed while opening');
      if (opened.size > maxSkillBytes) throw new Error('Managed workflow skill exceeds 64 KiB');
      const data = Buffer.alloc(maxSkillBytes + 1); let length = 0;
      while (length < data.length) {
        const count = readSync(descriptor, data, length, data.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length > maxSkillBytes) throw new Error('Managed workflow skill exceeds 64 KiB');
      this.checkDirectories(false);
      const after = lstatSync(this.managedPath);
      if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) throw new Error('Managed workflow skill changed while reading');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length));
      if (content.includes('\0')) throw new Error('Managed workflow skill must be UTF-8 text');
      return content;
    } finally { closeSync(descriptor); }
  }
  read(id = 'subagents'): WorkflowSkill & { content: string } {
    if (!this.enabled) throw new Error('Agent workflow is disabled');
    if (id !== 'subagents') throw new Error('Unknown agent workflow skill ID');
    const installed = this.managedContent() === bundledSkill;
    return { id, name: 'subagents', description, version, hash, bytes, installed, source: installed ? 'managed' : 'bundled', readTool: 'agents__workflow', content: bundledSkill };
  }
  discover(): WorkflowSkill[] {
    if (!this.enabled) return [];
    const { content: _content, ...skill } = this.read();
    return [skill];
  }
  install(): WorkflowSkill {
    if (this.options.readOnly) throw new Error('Agent workflow is read-only');
    if (!this.enabled) throw new Error('Agent workflow is disabled');
    this.checkDirectories(true);
    if (this.managedContent() !== bundledSkill) {
      const temporary = path.join(path.dirname(this.managedPath), `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bundledSkill, { flag: 'wx', mode: 0o600 });
        this.checkDirectories(false);
        this.managedContent();
        renameSync(temporary, this.managedPath);
      } finally { rmSync(temporary, { force: true }); }
    }
    return this.discover()[0];
  }
  context(targets: readonly WorkflowTarget[] = []): WorkflowContext {
    const skill = this.enabled ? this.read() : undefined;
    const { content: _content, ...metadata } = skill ?? { content: '' };
    return { enabled: this.enabled, mode: this.mode, version, installed: skill?.installed ?? false,
      skills: skill && this.mode === 'on-demand' ? [metadata as WorkflowSkill] : [], targets: targets.map(targetMetadata),
      instructions: !skill ? '' : this.mode === 'preload' ? skill.content : compactInstructions };
  }
  taskPrompt(input: { prompt: string; roleInstructions?: string; target?: WorkflowTarget; workspace?: string; cwd?: string }): string {
    const context = this.context();
    const location = { ...(input.target ? { target: targetMetadata(input.target) } : {}), ...(input.workspace ? { workspace: input.workspace } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) };
    return [`Capyra task context\n${JSON.stringify(location)}`, context.instructions,
      input.roleInstructions ? `Role instructions\n${input.roleInstructions}` : '', `Assigned task\n${input.prompt}`].filter(Boolean).join('\n\n');
  }
}
