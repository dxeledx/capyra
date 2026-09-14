import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { Runtime } from '../src/core/runtime.js';
import { startControl } from '../src/transport/control.js';
import type { RuntimeConfig } from '../src/core/types.js';

const source = await readFile(new URL('../public/computer.js', import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
class Element {
  children: Element[] = [];
  content = '';
  hidden = false;
  disabled = false;
  src = '';
  alt = '';
  handlers = new Map<string, (event?: any) => unknown>();
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.content = value; this.children = []; }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Use text nodes, not executable markup'); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.content = ''; this.children = nodes; }
  addEventListener(name: string, handler: (event?: any) => unknown) { this.handlers.set(name, handler); }
  querySelector(tag: string): Element | undefined { for (const child of this.children) { if (child.tag === tag) return child; const found = child.querySelector(tag); if (found) return found; } }
}
function fixture() {
  const ids = new Map<string, Element>();
  const $ = (id: string) => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id)!; };
  const make = (tag: string, _className?: string, value?: unknown) => { const item = new Element(tag); if (value !== undefined) item.textContent = String(value); return item; };
  const state: any = { online: true, authRequired: false, data: { plugins: [{ id: 'computer', enabled: true }], metrics: { paused: false } } };
  const project = { path: '/fixture/workspace' };
  const calls: any[] = [], mutations: any[] = [], timers: (() => void)[] = [];
  const events = new Map<string, () => void>(), wired = new Map<string, () => unknown>();
  let execute: (name: string, args: unknown, options: unknown) => Promise<unknown> = async () => ({ content: [] });
  const window: any = { addEventListener(name: string, fn: () => void) { events.set(name, fn); } };
  const environment: any = {
    window, document: { addEventListener(name: string, fn: () => void) { events.set(name, fn); } },
    state, $, node: make, currentProject: () => project,
    hasTool: (name: string) => state.data.plugins.some((p: any) => p.id === 'computer' && p.enabled) && ['computer__prepare', 'computer__status', 'computer__screenshot'].includes(name),
    text(id: string, value: unknown) { $(id).textContent = String(value); },
    empty(title: string, description: string) { return make('empty', '', `${title} ${description}`); },
    rawDisclosure(title: string, value: unknown) { return make('details', '', title + JSON.stringify(value)); },
    resultView(value: unknown) { return make('result', '', JSON.stringify(value)); },
    decodedResult: ({ result }: any) => result.structuredContent ?? result,
    submitTool(name: string, args: unknown, options: unknown) { calls.push({ name, args, options }); return execute(name, args, options); },
    async mutation(path: string, body: any) { mutations.push({ path, body }); state.data.plugins.push({ id: body.id, enabled: false }); },
    wire(id: string, _event: string, fn: () => unknown) { wired.set(id, fn); },
    configurePlugin() {}, copyText() {},
    setInterval(fn: () => void) { timers.push(fn); return timers.length; }, clearInterval() {},
  };
  vm.runInNewContext(source, environment);
  return { panel: window.capyraComputer, state, project, ids, $, calls, mutations, timers, events, wired, execute(fn: typeof execute) { execute = fn; } };
}
const frame = () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }, { type: 'text', text: '<script>untrusted()</script>' }], structuredContent: { screenshotId: 'fixture-frame', width: 100, height: 50 } });

test('desktop panel never captures or changes permissions on load, navigation or polling', () => {
  const f = fixture();
  f.events.get('DOMContentLoaded')!();
  f.panel.render(); for (const tick of f.timers) tick();
  assert.equal(f.calls.length, 0); assert.equal(f.mutations.length, 0);
  assert.equal(f.$('computer-capture').disabled, false);
  assert.ok(f.wired.has('computer-capture'));
  f.state.data.metrics.paused = true; f.panel.render();
  assert.equal(f.$('computer-capture').disabled, true);
  assert.equal(f.calls.length, 0);
});

test('desktop UI registers only an ungranted, disabled builtin after an explicit action', async () => {
  const f = fixture(); f.state.data.plugins = []; f.panel.render();
  assert.equal(f.mutations.length, 0);
  await f.panel.register(); await f.panel.register();
  assert.deepEqual(plain(f.mutations), [{ path: '/api/plugins/install', body: { id: 'computer', module: 'builtin:computer', grants: [], config: {} } }]);
  assert.equal(f.$('computer-capture').disabled, true);
});

test('preview coordinates map CSS size to screenshot pixels without dispatching desktop input', () => {
  const f = fixture(); const rect = { left: 10, top: 20, width: 640, height: 360 };
  assert.deepEqual(plain(f.panel.point(330, 200, rect, 1280, 720)), { x: 640, y: 360 });
  assert.deepEqual(plain(f.panel.point(649.9, 379.9, rect, 1280, 720)), { x: 1279, y: 719 });
  for (const p of [[650, 200], [9, 20], [10, 380], [NaN, 20]]) assert.equal(f.panel.point(...p, rect, 1280, 720), null);
  assert.equal(f.panel.point(10, 20, { ...rect, width: 0 }, 1280, 720), null);
  assert.equal(f.panel.point(10, 20, rect, 1280.5, 720), null);
  assert.equal(f.calls.length, 0);
});

test('an explicit screenshot uses approved raw tool output and renders a native image', async () => {
  const f = fixture(); f.execute(async () => frame());
  await f.panel.run('screenshot');
  assert.deepEqual(plain(f.calls), [{ name: 'computer__screenshot', args: {}, options: { raw: true } }]);
  assert.equal(f.$('computer-preview').querySelector('img')?.src, 'data:image/png;base64,AA==');
  assert.match(f.$('computer-preview').textContent, /fixture-frame/);
  assert.equal(f.$('computer-capture').disabled, false);
});

for (const mode of ['clear', 'workspace', 'pause', 'disable', 'disconnect'] as const) {
  test(`late screenshot cannot replace a preview after ${mode}`, async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.execute(() => new Promise(done => { resolve = done; }));
    const pending = f.panel.run('screenshot');
    await assert.rejects(f.panel.run('status'), /已有桌面诊断/);
    if (mode === 'clear') f.panel.clear();
    else if (mode === 'workspace') f.project.path = '/fixture/other';
    else if (mode === 'pause') f.state.data.metrics.paused = true;
    else if (mode === 'disable') f.state.data.plugins[0].enabled = false;
    else f.state.online = false;
    f.panel.render(); resolve(frame()); await pending;
    assert.equal(f.$('computer-preview').querySelector('img'), undefined);
    assert.equal(f.calls.length, 1);
  });
}

test('desktop preview rejects error, missing, oversized or active-content image results', () => {
  const f = fixture();
  for (const value of [
    { isError: true, content: [{ type: 'text', text: 'Permission unavailable' }] },
    { content: [] }, { content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'AA==' }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(1700000) }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: 'javascript:attack()' }] },
  ]) assert.throws(() => f.panel.screenshotView(value));
  const result = f.panel.screenshotView({ content: [...frame().content] });
  assert.match(result.textContent, /<script>untrusted\(\)<\/script>/);
  assert.equal(result.querySelector('script'), undefined);
});

test('permission diagnostics distinguish enabled plugin from actual desktop readiness', async () => {
  const f = fixture();
  const diagnosis = { supported: true, backendReady: true, screenRecording: 'granted', accessibility: 'not_granted', message: '<img src=x onerror=attack()>' };
  f.execute(async () => ({ structuredContent: diagnosis, content: [] }));
  await f.panel.run('status');
  assert.match(f.$('computer-state').textContent, /插件已启用/);
  assert.match(f.$('computer-diagnostics').textContent, /屏幕录制：已授权/);
  assert.match(f.$('computer-diagnostics').textContent, /辅助功能：未授权/);
  assert.equal(f.$('computer-diagnostics').querySelector('img'), undefined);
  assert.deepEqual(f.calls.map(call => call.name), ['computer__status']);
  assert.equal(f.mutations.length, 0);
});

test('failed screenshot is not retried and re-enables explicit controls', async () => {
  const f = fixture(); f.execute(async () => { throw new Error('Screen recording required'); });
  await assert.rejects(f.panel.run('screenshot'), /Screen recording/);
  assert.match(f.$('computer-preview').textContent, /Screen recording/);
  assert.equal(f.calls.length, 1); assert.equal(f.$('computer-capture').disabled, false);
  await assert.rejects(f.panel.run('click'), /未知的桌面诊断/);
  assert.equal(f.calls.length, 1);
});

test('local console serves the desktop panel script and navigation under existing CSP', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'capyra-desktop-ui-'));
  const config: RuntimeConfig = { workspace, stateDir: join(workspace, '.capyra'), port: 0, controlPort: 0, exposure: 'compact', plugins: [], maxTasks: 10, maxConcurrent: 2 };
  const runtime = new Runtime(config, async () => { throw new Error('No plugins'); });
  await runtime.start();
  const control = await startControl(runtime, config, { pending: () => [], decide() {}, revoke() {} });
  t.after(async () => { await control.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  const response = await fetch(control.url), html = await response.text();
  assert.match(html, /data-nav="computer"/);
  assert.match(html, /<script src="\/computer\.js" defer><\/script>/);
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const script = await fetch(control.url + '/computer.js');
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await script.text(), source);
});
