import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/plugins/workspace.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-files-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map<string, ToolDefinition>();
  const context: PluginContext = {
    workspace, stateDir: path.join(root, 'state'), config: {},
    registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    provide() {}, service() { throw new Error('unused'); }, guard() {}, onEvent() {}, onDispose() {},
  };
  await plugin.setup(context);
  const ctx: ToolContext = { workspace, taskId: 'test', signal: new AbortController().signal, progress() {} };
  const call = async (name: string, args: Record<string, unknown>, current = ctx) => tools.get(name)!.execute(args, current);
  return { root, workspace, tools, ctx, call };
}

test('workspace lists useful files and rejects traversal, protected paths and symlinks', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'visible.txt'), 'hello');
  await writeFile(path.join(f.workspace, '.env'), 'SECRET=hidden');
  await writeFile(path.join(f.workspace, 'capyra.json'), '{}');
  await writeFile(path.join(f.workspace, 'capyra.local.json'), '{}');
  await writeFile(path.join(f.root, 'outside.txt'), 'outside');
  await mkdir(path.join(f.workspace, '.git'));
  await symlink(path.join(f.root, 'outside.txt'), path.join(f.workspace, 'shortcut'));
  await symlink(f.root, path.join(f.workspace, 'outside-dir'));
  const result = await f.call('list', {});
  const listing = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(listing.entries.map((entry: { name: string }) => entry.name), ['visible.txt']);
  for (const name of ['../outside.txt', '/etc/passwd', 'C:\\secret', '.env', '.env.production', '.git/config', 'node_modules/index.js', 'shortcut', 'outside-dir/outside.txt', 'capyra.json', 'capyra.local.json']) {
    await assert.rejects(f.call('read', { path: name }), undefined, name);
  }
  await assert.rejects(f.call('write', { path: 'capyra.json', content: '{"plugins":[]}', expectedHash: hash('{}') }), /protected/);
  await assert.rejects(f.call('write', { path: 'outside-dir/new.txt', content: 'no', expectedMissing: true }), /Symbolic/);
  assert.equal(await readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'outside');
});

test('read windows reconstruct the file with continuous UTF-16 offsets and a stable full-file hash', async t => {
  const f = await fixture(t);
  const content = 'a'.repeat(16383) + '🦫中文\n'.repeat(17000);
  await writeFile(path.join(f.workspace, 'long.txt'), content);
  const read = async (args: Record<string, unknown>) => {
    const result = await f.call('read', args);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  let page = await read({ path: 'long.txt' });
  assert.equal(page.content, content.slice(0, 16384));
  assert.equal(page.offset, 0);
  assert.equal(page.nextOffset, 16384);
  assert.equal(page.truncated, true);
  let reconstructed = '';
  for (;;) {
    assert.equal(page.hash, hash(content));
    assert.equal(page.hashScope, 'full-file');
    assert.equal(page.bytes, Buffer.byteLength(content));
    assert.equal(page.totalCharacters, content.length);
    assert.equal(page.offset, reconstructed.length);
    reconstructed += page.content;
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, reconstructed.length);
    page = await read({ path: 'long.txt', offset: page.nextOffset, limit: 8193 });
  }
  assert.equal(page.truncated, false);
  assert.equal(reconstructed, content);
  assert.equal((await read({ path: 'long.txt', limit: 65536 })).content.length, 65536);
  assert.equal((await read({ path: 'long.txt', offset: content.length + 1 })).content, '');
  await assert.rejects(read({ path: 'long.txt', limit: 65537 }), /limit/);
  await assert.rejects(read({ path: 'long.txt', offset: -1 }), /offset/);
  await writeFile(path.join(f.workspace, 'short.txt'), 'small file');
  const small = await read({ path: 'short.txt' });
  assert.equal(small.content, 'small file');
  assert.equal(small.nextOffset, null);
  assert.equal(small.truncated, false);
});

test('file approval includes hashes and execution rechecks writes and edits after a race', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'note.txt'), 'before');
  const writeArgs = { path: 'note.txt', content: 'after', expectedHash: hash('before') };
  const preview = await f.tools.get('write')!.preview!(writeArgs, f.ctx);
  assert.equal(preview.before, 'before');
  assert.equal(preview.after, 'after');
  assert.match(preview.description, new RegExp(hash('after')));
  await writeFile(path.join(f.workspace, 'note.txt'), 'external update');
  await assert.rejects(f.call('write', writeArgs), /File changed/);
  assert.equal(await readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'external update');
  const editArgs = { path: 'note.txt', oldText: 'external', newText: 'approved', expectedHash: hash('external update') };
  await f.tools.get('edit')!.preview!(editArgs, f.ctx);
  await writeFile(path.join(f.workspace, 'note.txt'), 'another update');
  await assert.rejects(f.call('edit', editArgs), /File changed/);
});

test('new-file precondition is exclusive and edit is literal and unambiguous', async t => {
  const f = await fixture(t);
  const args = { path: 'new.txt', content: 'hello hello', expectedMissing: true };
  await f.tools.get('write')!.preview!(args, f.ctx);
  await writeFile(path.join(f.workspace, 'new.txt'), 'user created');
  await assert.rejects(f.call('write', args), /already exists/);
  assert.equal(await readFile(path.join(f.workspace, 'new.txt'), 'utf8'), 'user created');
  await f.call('write', { ...args, path: 'edit.txt' });
  const edit = { path: 'edit.txt', oldText: 'hello', newText: '$&', expectedHash: hash('hello hello') };
  await assert.rejects(f.call('edit', edit), /more than once/);
  await f.call('edit', { ...edit, replaceAll: true });
  assert.equal(await readFile(path.join(f.workspace, 'edit.txt'), 'utf8'), '$& $&');
  await assert.rejects(f.call('write', { path: 'missing-parent/file.txt', content: 'x', expectedMissing: true }), /ENOENT/);
});

test('move rejects changed sources and destination collisions, then preserves content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'source.txt'), 'original');
  const args = { from: 'source.txt', to: 'target.txt', expectedHash: hash('original') };
  await f.tools.get('move')!.preview!(args, f.ctx);
  await writeFile(path.join(f.workspace, 'target.txt'), 'owned by user');
  await assert.rejects(f.call('move', args), /Destination already exists/);
  assert.equal(await readFile(path.join(f.workspace, 'target.txt'), 'utf8'), 'owned by user');
  await rm(path.join(f.workspace, 'target.txt'));
  await writeFile(path.join(f.workspace, 'source.txt'), 'updated');
  await assert.rejects(f.call('move', args), /File changed/);
  await f.call('move', { ...args, expectedHash: hash('updated') });
  assert.equal(await readFile(path.join(f.workspace, 'target.txt'), 'utf8'), 'updated');
  await assert.rejects(readFile(path.join(f.workspace, 'source.txt')), /ENOENT/);
});

test('large and binary files are rejected and cancellation prevents mutations', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 97));
  await writeFile(path.join(f.workspace, 'binary.txt'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.call('read', { path: 'large.txt' }), /limit/);
  await assert.rejects(f.call('read', { path: 'binary.txt' }), /UTF-8/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.call('write', { path: 'cancelled.txt', content: 'should not exist', expectedMissing: true }, { ...f.ctx, signal: controller.signal }), /cancelled/);
  await assert.rejects(readFile(path.join(f.workspace, 'cancelled.txt')), /ENOENT/);
});

test('hard-link aliases and oversized replacement expansion cannot mutate files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outside.txt'), 'private');
  await link(path.join(f.root, 'outside.txt'), path.join(f.workspace, 'alias.txt'));
  await assert.rejects(f.call('read', { path: 'alias.txt' }), /hard links/);
  await assert.rejects(f.call('write', { path: 'alias.txt', content: 'changed', expectedHash: hash('private') }), /hard links/);
  assert.equal(await readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'private');
  await writeFile(path.join(f.workspace, 'repeat.txt'), 'a'.repeat(10000));
  await assert.rejects(f.call('edit', { path: 'repeat.txt', oldText: 'a', newText: 'b'.repeat(10000), replaceAll: true, expectedHash: hash('a'.repeat(10000)) }), /limit/);
  assert.equal(await readFile(path.join(f.workspace, 'repeat.txt'), 'utf8'), 'a'.repeat(10000));
});

test('atomic writes preserve permissions and leave no staging file', async t => {
  const f = await fixture(t);
  const target = path.join(f.workspace, 'script.sh');
  await writeFile(target, '#!/bin/sh\necho old\n');
  await chmod(target, 0o750);
  const before = await stat(target);
  await f.call('write', { path: 'script.sh', content: '#!/bin/sh\necho new\n', expectedHash: hash('#!/bin/sh\necho old\n') });
  const after = await stat(target);
  assert.equal(await readFile(target, 'utf8'), '#!/bin/sh\necho new\n');
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual(await readdir(f.workspace), ['script.sh']);
});

test('staging fsync failure preserves the original and never publishes a new file', async t => {
  const f = await fixture(t);
  const target = path.join(f.workspace, 'original.txt');
  await writeFile(target, 'valuable original');
  const handle = await open(target, 'r');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  t.mock.method(prototype, 'sync', async () => { throw new Error('simulated disk sync failure'); });
  await assert.rejects(f.call('write', { path: 'original.txt', content: 'replacement', expectedHash: hash('valuable original') }), /simulated disk sync failure/);
  await assert.rejects(f.call('write', { path: 'new.txt', content: 'new content', expectedMissing: true }), /simulated disk sync failure/);
  assert.equal(await readFile(target, 'utf8'), 'valuable original');
  assert.deepEqual(await readdir(f.workspace), ['original.txt']);
});

test('a file changed while staging is rechecked before publication', async t => {
  const f = await fixture(t);
  const target = path.join(f.workspace, 'original.txt');
  await writeFile(target, 'before');
  const handle = await open(target, 'r');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const originalSync = prototype.sync;
  await handle.close();
  t.mock.method(prototype, 'sync', async function (this: FileHandle) {
    await originalSync.call(this);
    await writeFile(target, 'external change during staging');
  });
  await assert.rejects(f.call('write', { path: 'original.txt', content: 'approved replacement', expectedHash: hash('before') }), /File changed/);
  assert.equal(await readFile(target, 'utf8'), 'external change during staging');
  assert.deepEqual(await readdir(f.workspace), ['original.txt']);
});
