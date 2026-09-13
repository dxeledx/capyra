import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { cardHtml } from '../src/client-ui/html.js';

class Node {
  children: Node[] = [];
  content = '';
  className = '';
  hidden = false;
  open = false;
  disabled = false;
  value = '';
  dataset: Record<string, string> = {};
  handlers = new Map<string, (event?: any) => unknown>();
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.content = value; this.children = []; }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Untrusted content must not use innerHTML'); }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.content = ''; this.children = nodes; }
  setAttribute() {}
  addEventListener(name: string, handler: (event?: any) => unknown) { this.handlers.set(name, handler); }
  querySelector(tag: string): Node | undefined { for (const child of this.children) { if (child.tag === tag) return child; const found = child.querySelector(tag); if (found) return found; } }
}

function fixture() {
  const ids = new Map(['card', 'title', 'status'].map(id => [id, new Node(id)]));
  const handlers = new Map<string, (event: any) => unknown>();
  const sent: any[] = [];
  const parent = { postMessage(message: unknown) { sent.push(message); } };
  const window = { parent, addEventListener(name: string, handler: (event: any) => unknown) { handlers.set(name, handler); }, removeEventListener(name: string) { handlers.delete(name); } };
  const document = { getElementById: (id: string) => ids.get(id), createElement: (tag: string) => new Node(tag), documentElement: { dataset: {}, scrollHeight: 400 } };
  vm.runInNewContext(cardHtml.match(/<script>([\s\S]*)<\/script>/)![1]!, { window, document, setTimeout, clearTimeout });
  const dispatch = (message: unknown, source: unknown = parent) => handlers.get('message')!({ source, data: message });
  const deliver = (value: unknown, source?: unknown) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: value } }, source);
  const dispose = () => handlers.get('pagehide')!({});
  return { ids, sent, dispatch, deliver, dispose, document };
}

const reference = { kind: 'review', version: 1, workspaceId: 'a'.repeat(64), reviewRef: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };

test('Apps bridge accepts only the parent, renders hostile text safely, and rereads references only after a click', async () => {
  const f = fixture();
  try {
    assert.equal(f.sent[0].method, 'ui/initialize');
    f.dispatch({ jsonrpc: '2.0', id: f.sent[0].id, result: { hostContext: { theme: 'dark' } } }); await Promise.resolve();
    assert.equal(f.sent[1].method, 'ui/notifications/initialized');
    const malicious = { ...reference, files: [{ path: '<img src=x onerror=attack()>', additions: 1, removals: 1, patch: '-old\n+<script>attack()</script>' }], summary: { files: 1, additions: 1, removals: 1 } };
    f.deliver(malicious, {}); assert.equal(f.ids.get('card')!.children.length, 0);
    f.deliver(malicious); const details = f.ids.get('card')!.querySelector('details')!;
    assert.match(details.textContent, /<img src=x/);
    details.open = true; details.handlers.get('toggle')!();
    assert.equal(details.querySelector('pre')!.children.length, 2);
    assert.match(details.querySelector('pre')!.textContent, /<script>attack/);
    f.deliver(reference);
    assert.equal(f.sent.filter(item => item.method === 'tools/call').length, 0);
    const button = f.ids.get('card')!.querySelector('button')!;
    const clicked = button.handlers.get('click')!();
    const call = f.sent.find(item => item.method === 'tools/call');
    assert.equal(call.params.name, 'client-ui__review');
    assert.deepEqual(JSON.parse(JSON.stringify(call.params.arguments)), { workspaceId: reference.workspaceId, reviewRef: reference.reviewRef });
    assert.equal(button.disabled, true);
    f.dispatch({ jsonrpc: '2.0', id: call.id, result: { structuredContent: malicious } }); await clicked;
    assert.equal(button.disabled, false); assert.match(f.ids.get('card')!.textContent, /<img/);
  } finally { f.dispose(); }
  assert.equal(f.ids.get('card')!.children.length, 0);
});

test('a delayed history result cannot replace a more recent workspace result', async () => {
  const f = fixture();
  try {
    f.dispatch({ jsonrpc: '2.0', id: f.sent[0].id, result: {} }); await Promise.resolve();
    f.deliver(reference);
    const clicked = f.ids.get('card')!.querySelector('button')!.handlers.get('click')!();
    const call = f.sent.find(item => item.method === 'tools/call');
    f.deliver({ kind: 'workspace', version: 1, name: 'Current project', root: '/safe/current', git: { available: false } });
    f.dispatch({ jsonrpc: '2.0', id: call.id, result: { structuredContent: { ...reference, files: [] } } }); await clicked;
    assert.equal(f.ids.get('title')!.textContent, 'Current project');
    assert.match(f.ids.get('card')!.textContent, /safe\/current/);
  } finally { f.dispose(); }
});
