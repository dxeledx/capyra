const effects = new Set(['read', 'write', 'execute']);

export default {
  apiVersion: 1, id: 'strict-policy', version: '1.0.0', title: 'Read-first execution policy',
  description: 'An external policy that narrows allowed effects and tool names without changing local approval or identity checks.',
  permissions: [],
  setup(ctx) {
    const deniedEffects = ctx.config.deniedEffects ?? ['write', 'execute'];
    const allowedTools = ctx.config.allowedTools;
    if (!Array.isArray(deniedEffects) || deniedEffects.some(effect => !effects.has(effect))) throw new Error('deniedEffects must contain read, write or execute');
    if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9-]*__[A-Za-z][A-Za-z0-9_-]*$/.test(name)))) throw new Error('allowedTools must contain fully qualified tool names');
    const denied = new Set(deniedEffects);
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    let active = true;
    let deniedRequests = 0;
    ctx.provide('execution.policy', {
      check(tool) {
        if (!active) return 'The strict policy instance has been stopped';
        if (denied.has(tool.effect)) { deniedRequests++; return `Strict policy blocks ${tool.effect} requests`; }
        if (allowed && !allowed.has(tool.name)) { deniedRequests++; return `Strict policy does not allow ${tool.name}`; }
        return undefined;
      },
    });
    ctx.provide('strict-policy.status', {
      snapshot() {
        // 查找服务也验证 context 世代，停用后的旧引用不能继续访问宿主。
        ctx.service('host.runtime');
        return { deniedEffects: [...denied], allowedTools: allowed ? [...allowed] : null, deniedRequests };
      },
    });
    ctx.onDispose(() => { active = false; });
  },
};
