import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapyraPlugin } from '../core/types.js';
import { textResult } from '../sdk.js';

export interface Project { id: string; name: string; path: string }
export interface ProjectsService {
  list(): Project[];
  current(): Project;
  resolve(id?: string): Project;
  session(id: string): Promise<Project>;
  conversation(key: string): Project | undefined;
  bindConversation(key: string, id?: string): Promise<Project>;
  register(input: { id?: string; name?: string; path: string }): Promise<Project>;
  select(id: string): Promise<Project>;
  remove(id: string): Promise<void>;
}
interface ConversationBinding { key: string; projectId: string; updatedAt: string }
interface Registry { entries: Project[]; activeId: string; conversationBindings: ConversationBinding[] }

function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value); }
async function project(input: { id?: unknown; name?: unknown; path: unknown }): Promise<Project> {
  if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0')) throw new Error('Project path must be an absolute directory');
  const root = await realpath(input.path);
  if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory');
  const id = input.id ?? randomUUID();
  if (!validId(id)) throw new Error('Invalid project ID');
  const name = input.name ?? (path.basename(root) || root);
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Project name must contain 1–120 characters');
  return { id, name, path: root };
}

const plugin: CapyraPlugin = {
  apiVersion: 1, id: 'projects', version: '0.2.0', title: 'Projects',
  description: 'Register local project directories and keep each client conversation bound to its workspace.',
  permissions: ['projects:read'],
  instructions: 'Projects are registered and selected in the local console. An existing task retains the workspace it was created in.',
  async setup(context) {
    const file = path.join(context.stateDir, 'projects.json');
    const primary = await project({ id: 'primary', path: context.workspace });
    let registry: Registry = { entries: [primary], activeId: primary.id, conversationBindings: [] };
    let loaded = false;
    try {
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!saved || typeof saved !== 'object' || !Array.isArray((saved as Registry).entries)) throw new Error('Invalid project registry');
      const parsed = saved as Registry;
      const bindings = (parsed as Partial<Registry>).conversationBindings ?? [];
      if (!validId(parsed.activeId) || parsed.entries.length > 100 || !Array.isArray(bindings) || bindings.length > 2048) throw new Error('Invalid project registry');
      // 不丢弃离线磁盘上的项目；每次实际使用才重新验证目录是否可达。
      for (const entry of parsed.entries) {
        if (!entry || !validId(entry.id) || typeof entry.name !== 'string' || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) throw new Error('Invalid project registry entry');
      }
      if (new Set(parsed.entries.map(entry => entry.id)).size !== parsed.entries.length || !parsed.entries.some(entry => entry.id === parsed.activeId)) throw new Error('Invalid project registry selection');
      for (const binding of bindings) {
        if (!binding || !/^[a-f0-9]{64}$/.test(binding.key) || !validId(binding.projectId) || typeof binding.updatedAt !== 'string' || !Number.isFinite(Date.parse(binding.updatedAt)) || !parsed.entries.some(entry => entry.id === binding.projectId)) throw new Error('Invalid conversation workspace binding');
      }
      if (new Set(bindings.map(binding => binding.key)).size !== bindings.length) throw new Error('Duplicate conversation workspace binding');
      registry = { entries: parsed.entries, activeId: parsed.activeId, conversationBindings: bindings };
      loaded = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (context.config.entries !== undefined) {
      if (!Array.isArray(context.config.entries) || context.config.entries.length > 100) throw new Error('projects.entries must be an array of at most 100 projects');
      for (const raw of context.config.entries) {
        const entry = await project(raw as Project);
        const existing = registry.entries.find(item => item.id === entry.id || item.path === entry.path);
        if (!existing) registry.entries.push(entry);
      }
    }
    if (!loaded && context.config.activeId !== undefined && registry.entries.some(entry => entry.id === context.config.activeId)) registry.activeId = String(context.config.activeId);
    let queue: Promise<unknown> = Promise.resolve();
    const change = <T>(operation: (next: Registry) => T | Promise<T>): Promise<T> => {
      const result = queue.then(async () => {
        const next = structuredClone(registry);
        const value = await operation(next);
        await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
        registry = next;
        return value;
      });
      queue = result.catch(() => undefined);
      return result;
    };
    const service: ProjectsService = {
      list: () => structuredClone(registry.entries),
      current() { return this.resolve(); },
      resolve(id = registry.activeId) {
        const entry = registry.entries.find(item => item.id === id);
        if (!entry) throw new Error('Unknown project');
        return { ...entry };
      },
      async session(id) {
        const entry = this.resolve(id);
        const resolved = await project(entry);
        if (resolved.path !== entry.path) throw new Error('Project directory changed; register its current path again');
        return entry;
      },
      conversation(key) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid conversation workspace key');
        const binding = registry.conversationBindings.find(item => item.key === key);
        return binding ? this.resolve(binding.projectId) : undefined;
      },
      bindConversation: (key, id) => change(next => {
        if (!/^[a-f0-9]{64}$/.test(key) || id !== undefined && !validId(id)) throw new Error('Invalid conversation workspace binding');
        const existing = next.conversationBindings.find(item => item.key === key);
        // 首次请求冻结当时的活动项目；后续请求只有显式选择时才更新该对话。
        const projectId = id ?? existing?.projectId ?? next.activeId;
        const entry = next.entries.find(item => item.id === projectId);
        if (!entry) throw new Error('Unknown project');
        const updatedAt = new Date().toISOString();
        if (existing) {
          if (id !== undefined) { existing.projectId = projectId; existing.updatedAt = updatedAt; }
        } else {
          next.conversationBindings.push({ key, projectId, updatedAt });
          next.conversationBindings.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
          next.conversationBindings.splice(0, Math.max(0, next.conversationBindings.length - 2048));
        }
        return { ...entry };
      }),
      register: input => change(async next => {
        const entry = await project(input);
        if (next.entries.some(item => item.path === entry.path)) throw new Error('This project directory is already registered');
        if (next.entries.some(item => item.id === entry.id)) throw new Error('Project ID already exists');
        if (next.entries.length >= 100) throw new Error('Project limit reached');
        next.entries.push(entry);
        return { ...entry };
      }),
      select: async id => {
        const previous = registry.activeId;
        const selected = await change(async next => {
          const entry = next.entries.find(item => item.id === id);
          if (!entry) throw new Error('Unknown project');
          const resolved = await project(entry);
          if (resolved.path !== entry.path) throw new Error('Project directory changed; register its current path again');
          next.activeId = id;
          return { ...entry };
        });
        // 只发布项目 ID；路径和名称仍需经过 MCP 数据访问批准才能返回远程客户端。
        if (previous !== selected.id) context.emit?.({ type: 'workspace.changed', detail: selected.id });
        return selected;
      },
      remove: id => change(next => {
        if (id === next.activeId) throw new Error('Select another project before removing the active project');
        if (!next.entries.some(item => item.id === id)) throw new Error('Unknown project');
        next.entries = next.entries.filter(item => item.id !== id);
        next.conversationBindings = next.conversationBindings.filter(item => item.projectId !== id);
      }),
    };
    context.provide('projects', service);
    context.onDispose(() => queue.then(() => undefined));
    context.registerTool({
      name: 'list', title: 'Inspect the selected project', effect: 'read', permissions: ['projects:read'],
      description: 'Show the project bound to this request. The local console lists all registered projects and supports selection or registration.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        // 远程请求只获得已授权工作区的信息；本机控制台通过 service.list 查看完整注册表。
        const workspace = await realpath(ctx.workspace);
        const projects = service.list().filter(entry => entry.path === workspace);
        return textResult({ projects, activeId: projects[0]?.id ?? null });
      },
    });
  },
};
export default plugin;
