import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { CapyraPlugin } from '../core/types.js';
import type { GitService } from './git.js';
import type { ProjectsService } from './projects.js';
import type { SkillsService } from './skills.js';
import type { McpExtensionRegistry } from '../client-ui/extensions.js';
import { CARD_MIME, CARD_URI, cardMeta, cardResult, plainResultMeta, resourceMeta, reviewCard, reviewCardOutputSchema, workspaceCardOutputSchema, workspaceId } from '../client-ui/cards.js';
import { cardHtml } from '../client-ui/html.js';

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'client-ui', version: '0.2.0', title: '客户端工作区结果',
  description: '向客户端返回工作区、文件差异和冻结历史审阅；交互卡片可按需启用。',
  permissions: ['workspace:read', 'git:read', 'skills:read', 'projects:read'],
  requires: ['mcp', 'git', 'skills', 'projects'],
  instructions: 'Use client-ui workspace to display the selected workspace, changes to save and display an immutable review, and review to reopen that exact review. All calls, including historical review reads, require local approval. The UI never grants access. Text results remain usable in clients without MCP Apps.',
  setup(context) {
    const git = context.service<GitService>('git');
    const projects = context.service<ProjectsService>('projects');
    const skills = context.service<SkillsService>('skills');
    const extensions = context.service<McpExtensionRegistry>('mcp.extensions');
    // ChatGPT 当前可能在工具成功后卡在模板快照；默认使用结构化结果，显式开启才关联交互卡片。
    const toolMeta = context.config.cards === true ? cardMeta : plainResultMeta;
    const dispose = extensions.register('client-ui', {
      capabilities: { resources: {} },
      owns: (method, params) => method === 'resources/read' && params.uri === CARD_URI,
      async handle(method, params, ctx) {
        ctx.signal.throwIfAborted();
        if (method === 'resources/list') return { resources: [{ uri: CARD_URI, name: 'capyra-workspace-card', title: 'Capyra 工作卡', description: '工作区与变更审阅的通用界面模板。', mimeType: CARD_MIME, _meta: resourceMeta }] };
        if (method === 'resources/templates/list') return { resourceTemplates: [] };
        if (method !== 'resources/read' || params.uri !== CARD_URI) throw new Error('Unknown client UI resource');
        return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml, _meta: resourceMeta }] };
      },
    }, { publicUiTemplates: [{ uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml, _meta: resourceMeta }] });
    context.onDispose(dispose);
    context.registerTool({
      name: 'workspace', title: '显示工作区', description: 'Display the workspace bound to this approved request, its Git state, project rules and available skills. Does not select a different workspace.',
      publicCatalog: true, clientCatalog: true,
      effect: 'read', permissions: ['workspace:read', 'git:read', 'skills:read', 'projects:read'],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: workspaceCardOutputSchema, _meta: toolMeta,
      async execute(_args, ctx) {
        const root = await realpath(ctx.workspace); ctx.signal.throwIfAborted();
        const project = projects.list().find(item => item.path === root);
        const discovery = await skills.discover(root, ctx.signal);
        let state: Record<string, unknown> = { available: false };
        let review: Record<string, unknown> = { available: false };
        try { state = { ...(await git.status(root, ctx.signal) as Record<string, unknown>), available: true }; review = await git.reviewOpen(ctx); }
        catch { ctx.signal.throwIfAborted(); }
        return cardResult({ kind: 'workspace', version: 1, workspaceId: workspaceId(ctx.workspace), name: project?.name ?? path.basename(root), root, git: state, review, rules: discovery.rules, skills: discovery.skills, diagnostics: discovery.diagnostics });
      },
    });
    context.registerTool({
      name: 'changes', title: '显示并保存变更审阅', description: 'Show full accessible working-tree changes since workspace open or last shown, including staged, unstaged and untracked files. Save reviewRef and advance the last-shown checkpoint. First call workspace to establish the original baseline. Binary/oversized contents are marked omitted. staged=true explicitly selects a separate staged-only review.',
      publicCatalog: true, clientCatalog: true,
      effect: 'read', permissions: ['git:read', 'workspace:read'], inputSchema: { type: 'object', properties: { since: { type: 'string', enum: ['workspace_open', 'last_shown'] }, staged: { type: 'boolean' } }, additionalProperties: false }, outputSchema: reviewCardOutputSchema, _meta: toolMeta,
      async execute(args, ctx) {
        if (args.staged === true && args.since !== undefined) throw new Error('A staged-only review does not use workspace checkpoints');
        return cardResult(reviewCard(args.staged === true ? await git.reviewSave(ctx, { staged: true }) : await git.reviewChanges(ctx, { since: args.since as 'workspace_open' | 'last_shown' | undefined })));
      },
    });
    context.registerTool({
      name: 'review', title: '读取历史审阅', description: 'Read a frozen reviewRef only for its original authenticated caller and workspaceId. Requires fresh local approval; does not change workspace files or reconstruct history from current content.',
      publicCatalog: true, clientCatalog: true,
      effect: 'read', permissions: ['git:read', 'workspace:read'],
      inputSchema: { type: 'object', properties: { reviewRef: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, workspaceId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['reviewRef', 'workspaceId'], additionalProperties: false }, outputSchema: reviewCardOutputSchema, _meta: toolMeta,
      async execute(args, ctx) {
        if (args.workspaceId !== workspaceId(ctx.workspace)) throw new Error('Review belongs to another workspace');
        if (typeof args.reviewRef !== 'string' || !/^[a-f0-9-]{36}$/.test(args.reviewRef)) throw new Error('Invalid review reference');
        return cardResult(reviewCard(await git.reviewRead(ctx, args.reviewRef)));
      },
    });
  },
};
export default plugin;
