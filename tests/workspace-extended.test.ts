import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import workspace, { downloadIncomingFile, validateIncomingFile } from '../src/plugins/workspace.js';
import { sha256 } from '../src/plugins/workspace-paths.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

const hash = (text: string) => sha256(Buffer.from(text));
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-workspace-extra-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const tools = new Map<string, ToolDefinition>();
  await workspace.setup({ workspace: root, stateDir: path.join(root, '.capyra'), config: {}, registerTool(tool) { tools.set(tool.name, tool); return () => {}; }, provide() {}, service() { throw new Error('unused'); }, onDispose() {}, onEvent() {}, guard() {} } as PluginContext);
  const ctx = { workspace: root, taskId: 'test', owner: 'alice', signal: new AbortController().signal, progress() {} } as ToolContext;
  const call = async (name: string, args: Record<string, unknown>) => { const result = await tools.get(name)!.execute(args, ctx); return JSON.parse((result.content[0] as { text: string }).text); };
  return { root, tools, ctx, call };
}

test('recursive search excludes secrets, links and binary files and returns original line numbers', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'nested'));
  await writeFile(path.join(f.root, 'nested/file.txt'), 'first\nNeedle in haystack\nthird');
  await writeFile(path.join(f.root, '.env'), 'Needle secret');
  await writeFile(path.join(f.root, 'binary'), Buffer.from([255, 0, 1]));
  await symlink(path.join(f.root, '.env'), path.join(f.root, 'leak'));
  const result = await f.call('search', { query: 'needle', caseSensitive: false });
  assert.deepEqual(result.matches, [{ path: 'nested/file.txt', line: 2, text: 'Needle in haystack' }]);
  assert.equal(result.skipped, 1);
  const paths = await f.call('search', { query: 'nested', mode: 'path' });
  assert.equal(paths.matches.length, 2);
  await assert.rejects(f.call('search', { query: 'x', path: '../' }), /traversal/);
});

test('patch changes several files, moves with edits, and rechecks every original before mutation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(f.root, 'delete.txt'), 'old\n');
  const args = { patch: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n one\n-two\n+new\n three\n*** Delete File: delete.txt\n*** Add File: added.txt\n+hello\n*** End Patch', expectedHashes: { 'a.txt': hash('one\ntwo\nthree\n'), 'delete.txt': hash('old\n') } };
  const preview = await f.tools.get('apply_patch')!.preview!(args, f.ctx);
  assert.match(preview.description, /moved.txt/);
  await writeFile(path.join(f.root, 'delete.txt'), 'concurrent');
  await assert.rejects(f.call('apply_patch', args), /File changed/);
  assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  await writeFile(path.join(f.root, 'delete.txt'), 'old\n');
  await f.call('apply_patch', args);
  assert.deepEqual((await readdir(f.root)).sort(), ['added.txt', 'moved.txt']);
  assert.equal(await readFile(path.join(f.root, 'moved.txt'), 'utf8'), 'one\nnew\nthree\n');
  assert.equal(await readFile(path.join(f.root, 'added.txt'), 'utf8'), 'hello\n');
});

test('patch ambiguity, duplicate paths and protected deletes preserve user files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'a.txt'), 'repeat\nrepeat\n');
  await assert.rejects(f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-repeat\n+unique\n*** End Patch', expectedHashes: { 'a.txt': hash('repeat\nrepeat\n') } }), /exactly once/);
  await assert.rejects(f.call('apply_patch', { patch: '*** Begin Patch\n*** Add File: new.txt\n+a\n*** Add File: new.txt\n+b\n*** End Patch', expectedHashes: {} }), /only once/);
  await assert.rejects(f.call('apply_patch', { patch: '*** Begin Patch\n*** Delete File: .env\n*** End Patch', expectedHashes: { '.env': hash('secret') } }), /protected/);
  assert.deepEqual(await readdir(f.root), ['a.txt']);
});

test('binary inbound upload is exclusive and image reads preserve native MCP image content', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
  await f.call('upload', { path: 'image.png', base64: png.toString('base64') });
  const image = await f.tools.get('read_image')!.execute({ path: 'image.png' }, f.ctx);
  assert.equal(image.content[1]?.type, 'image');
  if (image.content[1]?.type === 'image') assert.equal(image.content[1].data, png.toString('base64'));
  await assert.rejects(f.call('upload', { path: 'image.png', base64: 'YQ==' }), /already exists/);
  await assert.rejects(f.call('upload', { path: 'invalid.bin', base64: 'YQ===extra' }), /base64/);
  assert.deepEqual(await readFile(path.join(f.root, 'image.png')), png);
});

test('native file URL validation rejects arbitrary hosts and unsafe redirects without leaking signed URLs', async t => {
  for (const download_url of ['http://files.oaiusercontent.com/x', 'https://127.0.0.1/x', 'https://arbitrary.blob.core.windows.net/x', 'https://files.oaiusercontent.com.evil.test/x', 'https://user:pass@files.oaiusercontent.com/x', 'file:///etc/passwd']) assert.throws(() => validateIncomingFile({ file_id: 'file-a', download_url }), /URL|trusted/);
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    seen.push(String(url)); assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private?sig=secret' } });
  });
  await assert.rejects(downloadIncomingFile({ file_id: 'file-a', download_url: 'https://files.oaiusercontent.com/a?sig=secret' }, new AbortController().signal), error => error instanceof Error && /trusted/.test(error.message) && !error.message.includes('secret'));
  assert.equal(seen.length, 1);
});

test('native downloads validate metadata against bounded streamed bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from([0, 255, 10]), { status: 200, headers: { 'content-length': '3' } }));
  const file = { file_id: 'file-a', download_url: 'https://oaisdmntprcentralindia.blob.core.windows.net/file', size: 3 };
  assert.deepEqual(await downloadIncomingFile(file, new AbortController().signal), Buffer.from([0, 255, 10]));
  await assert.rejects(downloadIncomingFile({ ...file, size: 4 }, new AbortController().signal), /metadata/);
});

test('a failed multi-file patch restores deleted file bytes and executable permissions', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'script.sh'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(f.root, 'script.sh'), 0o750);
  await writeFile(path.join(f.root, 'next.txt'), 'original\n');
  const handle = await open(path.join(f.root, 'next.txt'), 'r'); const prototype = Object.getPrototypeOf(handle) as FileHandle; const original = prototype.sync; await handle.close();
  let calls = 0;
  t.mock.method(prototype, 'sync', async function (this: FileHandle) { if (++calls === 1) throw new Error('simulated patch disk failure'); return original.call(this); });
  const args = { patch: '*** Begin Patch\n*** Delete File: script.sh\n*** Update File: next.txt\n@@\n-original\n+replacement\n*** End Patch', expectedHashes: { 'script.sh': hash('#!/bin/sh\nexit 0\n'), 'next.txt': hash('original\n') } };
  await assert.rejects(f.call('apply_patch', args), /earlier patch changes were restored/);
  assert.equal(await readFile(path.join(f.root, 'script.sh'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal((await stat(path.join(f.root, 'script.sh'))).mode & 0o777, 0o750);
  assert.equal(await readFile(path.join(f.root, 'next.txt'), 'utf8'), 'original\n');
  assert.deepEqual((await readdir(f.root)).sort(), ['next.txt', 'script.sh']);
});
