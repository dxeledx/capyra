import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GitReview } from '../plugins/git.js';

export const CARD_URI = 'ui://capyra/workspace-v2.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
export const cardMeta = {
  ui: { resourceUri: CARD_URI, visibility: ['model', 'app'] },
  'openai/toolInvocation/invoking': '等待本机确认并准备卡片',
  'openai/toolInvocation/invoked': '操作已完成',
};
export const plainResultMeta = {
  'openai/toolInvocation/invoking': '等待本机确认并读取结果',
  'openai/toolInvocation/invoked': '操作已完成',
};
export const resourceMeta = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
  'openai/widgetDescription': 'Capyra 工作区与冻结变更审阅。重新读取需要电脑主人确认。',
};

const cardFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' }, additions: { type: 'integer', minimum: 0 }, removals: { type: 'integer', minimum: 0 }, patch: { type: 'string' },
    binary: { type: 'boolean' }, contentOmitted: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
  },
  required: ['path', 'additions', 'removals', 'patch'],
  additionalProperties: true,
};

/** ChatGPT 会校验 structuredContent；卡片工具必须公布与实际结果一致的输出结构。 */
export const workspaceCardOutputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'workspace' }, version: { type: 'integer', const: 1 },
    workspaceId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, name: { type: 'string' }, root: { type: 'string' },
    git: { type: 'object', additionalProperties: true }, review: { type: 'object', additionalProperties: true },
    rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
    skills: { type: 'array', items: { type: 'object', additionalProperties: true } },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'version', 'workspaceId', 'name', 'root', 'git', 'review', 'rules', 'skills', 'diagnostics'],
  additionalProperties: false,
};

export const reviewCardOutputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'review' }, version: { type: 'integer', const: 1 },
    workspaceId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reviewRef: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    createdAt: { type: 'string' }, base: { anyOf: [{ type: 'string' }, { type: 'null' }] }, staged: { type: 'boolean' }, truncated: { type: 'boolean' },
    scope: { type: 'string', const: 'workspace' }, since: { type: 'string', enum: ['workspace_open', 'last_shown'] }, baselineCreated: { type: 'boolean' },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: true } }, files: { type: 'array', items: cardFileSchema },
    summary: {
      type: 'object',
      properties: { files: { type: 'integer', minimum: 0 }, additions: { type: 'integer', minimum: 0 }, removals: { type: 'integer', minimum: 0 } },
      required: ['files', 'additions', 'removals'], additionalProperties: false,
    },
  },
  required: ['kind', 'version', 'workspaceId', 'reviewRef', 'createdAt', 'base', 'staged', 'truncated', 'files', 'summary'],
  additionalProperties: false,
};

export function workspaceId(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex');
}

export function reviewCard(review: GitReview) {
  const files: { path: string; additions: number; removals: number; patch: string }[] = [];
  for (const section of review.diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    // Git patch 原样保留；路径仅用于展示，绝不作为文件读取参数。
    const lines = section.split('\n');
    const added = lines.find(line => line.startsWith('+++ '))?.slice(4);
    const removed = lines.find(line => line.startsWith('--- '))?.slice(4);
    const header = lines[0]?.match(/^diff --git .+ (?:b\/|"b\/)(.+?)(?:")?$/)?.[1];
    const file = (added && added !== '/dev/null' ? added : removed)?.replace(/\t$/, '').replace(/^(?:[ab]\/|"[ab]\/)/, '').replace(/"$/, '') ?? header ?? '变更';
    const body = lines.slice(lines.findIndex(line => line.startsWith('@@')) < 0 ? lines.length : lines.findIndex(line => line.startsWith('@@')));
    files.push({ path: file, additions: body.filter(line => line.startsWith('+')).length, removals: body.filter(line => line.startsWith('-')).length, patch: section });
  }
  const displayed = review.files ? review.files.map(file => ({ ...file, patch: files.find(item => item.path === file.path)?.patch ?? '', ...(file.contentOmitted ? {} : !files.some(item => item.path === file.path) && review.truncated ? { contentOmitted: 'display_limit' } : {}) })) : files;
  return {
    kind: 'review', version: 1, workspaceId: workspaceId(review.workspace), reviewRef: review.id,
    createdAt: review.createdAt, base: review.base, staged: review.staged, truncated: review.truncated,
    ...(review.scope ? { scope: review.scope, since: review.since, baselineCreated: review.baselineCreated, skipped: review.skipped ?? [] } : {}),
    files: displayed, summary: { files: displayed.length, additions: displayed.reduce((sum, file) => sum + file.additions, 0), removals: displayed.reduce((sum, file) => sum + file.removals, 0) },
  };
}

export function cardResult(card: Record<string, unknown>): CallToolResult {
  // 标准文本包含同一份获准结果；不渲染 Apps 的客户端仍可完整审阅。
  return { content: [{ type: 'text', text: JSON.stringify(card, null, 2) }], structuredContent: card, _meta: { 'capyra/cardVersion': 1 } };
}
