export const writeModes = ['read_only', 'allowed', 'full_access'] as const;
export type AgentWriteMode = typeof writeModes[number];
export function agentWriteMode(value: unknown, fallback: AgentWriteMode = 'allowed'): AgentWriteMode {
  if (value === undefined) return fallback;
  if (!writeModes.includes(value as AgentWriteMode)) throw new Error('writeMode must be read_only, allowed, or full_access');
  return value as AgentWriteMode;
}
export function codexSandbox(mode: AgentWriteMode, cwd: string) {
  return mode === 'full_access' ? { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    : mode === 'read_only' ? { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
      : { sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true } };
}
export function claudeAuthority(mode: AgentWriteMode, cwd: string) {
  if (mode === 'full_access') return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    sandbox: { enabled: false, allowUnsandboxedCommands: true }, settings: { permissions: { defaultMode: 'bypassPermissions' }, sandbox: { enabled: false, allowUnsandboxedCommands: true } } };
  const sandbox = { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    filesystem: { allowWrite: mode === 'allowed' ? [cwd] : [], denyWrite: mode === 'read_only' ? [cwd] : [] } };
  const permissions = { defaultMode: 'dontAsk', deny: mode === 'read_only' ? ['Bash', 'Edit', 'Write'] : [] };
  return { permissionMode: 'dontAsk', allowedTools: mode === 'read_only' ? ['Read(/**)'] : ['Read(/**)', 'Edit(/**)', 'Bash'], sandbox, settings: { permissions, sandbox } };
}
export function opencodePermissions(mode: AgentWriteMode) {
  return { read: 'allow', edit: mode === 'read_only' ? 'deny' : 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    bash: mode === 'read_only' ? 'deny' : 'allow', task: 'deny', external_directory: mode === 'full_access' ? 'allow' : 'deny' };
}
export function acpArguments(provider: string, mode: AgentWriteMode, cwd: string, effort?: string): string[] {
  if (provider === 'cursor') return ['acp', '--sandbox', mode === 'full_access' ? 'disabled' : 'enabled', '--workspace', cwd,
    ...(mode === 'read_only' ? ['--mode', 'plan'] : []), ...(mode === 'full_access' ? ['--force'] : [])];
  if (provider === 'copilot') return ['--acp', ...(mode === 'full_access' ? ['--no-sandbox', '--allow-all'] : ['--experimental', '--sandbox', '--allow-all-tools', '--add-dir', cwd]), '-C', cwd, ...(mode === 'read_only' ? ['--mode', 'plan'] : [])];
  return ['agent', ...(effort ? ['--reasoning-effort', effort] : []), 'stdio'];
}
export function acpPermission(provider: string, mode: AgentWriteMode, options: { optionId: string; kind: string }[]) {
  // Copilot restricted 模式的普通工具已放行；额外permission请求是权限升级，必须拒绝。
  if (provider === 'copilot' && mode !== 'full_access') return { outcome: { outcome: 'cancelled' } };
  const kinds = mode === 'read_only' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
  const selected = kinds.map(kind => options.find(option => option.kind === kind)).find(Boolean);
  return { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } };
}
