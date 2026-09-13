import type { McpExtensions, McpPublicUiTemplate } from '../transport/mcp.js';

export interface McpExtensionProvider extends McpExtensions {
  /** 精确声明资源/提示归属；目录方法由注册表聚合，不用前缀猜测调用者身份。 */
  owns(method: string, params: Record<string, unknown>): boolean;
}
export interface McpExtensionRegistry extends McpExtensions {
  register(id: string, provider: McpExtensionProvider, options?: { publicUiTemplates?: readonly McpPublicUiTemplate[] }): () => void;
}

const lists: Record<string, { capability: 'resources' | 'prompts'; field: string; key: string }> = {
  'resources/list': { capability: 'resources', field: 'resources', key: 'uri' },
  'resources/templates/list': { capability: 'resources', field: 'resourceTemplates', key: 'uriTemplate' },
  'prompts/list': { capability: 'prompts', field: 'prompts', key: 'name' },
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

/** MCP 插件持有注册表的生命周期；业务插件只注册并回收自己的 provider。 */
export function createMcpExtensions(): McpExtensionRegistry {
  const providers = new Map<string, McpExtensionProvider>();
  const templates = new Map<string, { id: string; value: McpPublicUiTemplate }>();
  return {
    get publicUiTemplates() {
      // 返回独立 Map，值为深冻结副本；调用方改 Map 或原始 options 都不会修改注册内容。
      return new Map([...templates].filter(([uri, template]) => {
        const matches = [...providers].filter(([, provider]) => provider.owns('resources/read', { uri }));
        return matches.length === 1 && matches[0]![0] === template.id;
      }).map(([uri, template]) => [uri, template.value]));
    },
    get capabilities() {
      const capabilities: McpExtensions['capabilities'] = {};
      for (const provider of providers.values()) {
        if (provider.capabilities.resources) capabilities.resources = {};
        if (provider.capabilities.prompts) capabilities.prompts = {};
      }
      return capabilities;
    },
    register(id, provider, options = {}) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id) || providers.has(id)) throw new Error('MCP extension provider ID is invalid or already registered');
      if (!provider || typeof provider.handle !== 'function' || typeof provider.owns !== 'function' || !object(provider.capabilities)) throw new Error('Invalid MCP extension provider');
      const declared = options.publicUiTemplates ?? [];
      if (!Array.isArray(declared) || declared.length > 16) throw new Error('Invalid public UI templates');
      // 公开性由本机安装的插件在 setup 时显式声明，仅接受有界 HTML 模板值。
      const snapshots = declared.map(value => {
        const encoded = JSON.stringify(value);
        if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) throw new Error('Public UI template exceeds the size limit');
        const copy = JSON.parse(encoded) as McpPublicUiTemplate;
        if (!object(copy) || typeof copy.uri !== 'string' || !copy.uri || copy.uri.length > 2048 || copy.mimeType !== 'text/html;profile=mcp-app' || typeof copy.text !== 'string'
          || copy._meta !== undefined && !object(copy._meta) || Object.keys(copy).some(key => !['uri', 'mimeType', 'text', '_meta'].includes(key))) throw new Error('Invalid public UI template');
        if (!provider.capabilities.resources || !provider.owns('resources/read', { uri: copy.uri })) throw new Error('Public UI template must belong to its resource provider');
        return freezeJson(copy);
      });
      if (new Set(snapshots.map(value => value.uri)).size !== snapshots.length
        || snapshots.some(value => templates.has(value.uri) || [...providers.values()].some(existing => existing.owns('resources/read', { uri: value.uri })))
        || [...templates.keys()].some(uri => provider.owns('resources/read', { uri }))) throw new Error('Public UI template resource conflicts with another provider');
      providers.set(id, provider);
      for (const value of snapshots) templates.set(value.uri, { id, value });
      let disposed = false;
      return () => {
        if (disposed) return; disposed = true;
        if (providers.get(id) === provider) {
          providers.delete(id);
          for (const value of snapshots) if (templates.get(value.uri)?.id === id) templates.delete(value.uri);
        }
      };
    },
    async handle(method, params, context) {
      context.signal.throwIfAborted();
      const listing = lists[method];
      if (listing) {
        if (params.cursor !== undefined) throw new Error('MCP extension catalogs do not accept an aggregate cursor');
        const active = [...providers.entries()].filter(([, provider]) => provider.capabilities[listing.capability]);
        const pages = await Promise.all(active.map(async ([id, provider]) => {
          const items: Record<string, unknown>[] = []; const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            context.signal.throwIfAborted();
            const page = await provider.handle(method, { ...params, ...(cursor ? { cursor } : {}) }, context);
            if (providers.get(id) !== provider) throw new Error('MCP extension provider was unloaded');
            if (!Array.isArray(page[listing.field])) throw new Error('Invalid MCP extension catalog');
            for (const entry of page[listing.field] as unknown[]) {
              if (!object(entry) || typeof entry[listing.key] !== 'string') throw new Error('Invalid MCP extension catalog entry');
              items.push(entry);
            }
            if (items.length > 1000) throw new Error('MCP extension catalog exceeds 1000 entries');
            if (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor))) throw new Error('Invalid MCP extension catalog cursor');
            cursor = page.nextCursor as string | undefined;
            if (cursor) cursors.add(cursor);
            if (cursors.size > 100) throw new Error('MCP extension catalog exceeds 100 pages');
          } while (cursor);
          return items;
        }));
        context.signal.throwIfAborted();
        if (active.some(([id, provider]) => providers.get(id) !== provider)) throw new Error('MCP extension provider was unloaded');
        const items = pages.flat(); const identifiers = items.map(item => item[listing.key]);
        if (items.length > 1000 || new Set(identifiers).size !== items.length) throw new Error('MCP extension catalog contains duplicate or excessive entries');
        return { [listing.field]: items };
      }
      if (!['resources/read', 'prompts/get'].includes(method)) throw new Error('MCP extension method is not available');
      const matches = [...providers.entries()].filter(([, provider]) => provider.owns(method, params));
      if (matches.length !== 1) throw new Error('MCP extension target is unavailable or ambiguous');
      const [id, provider] = matches[0]!;
      const result = await provider.handle(method, params, context);
      context.signal.throwIfAborted();
      if (providers.get(id) !== provider) throw new Error('MCP extension provider was unloaded');
      return result;
    },
  };
}
