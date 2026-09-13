import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveExtension } from '../src/execution/extension-resolver.js';

function fixture(t: { after(fn: () => void): void }, metadata: Record<string, unknown>, entries: Record<string, string> = {}) {
  const state = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'capyra-esm-extension-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const root = path.join(state, 'extensions', 'pi', 'node_modules', 'fixture-sdk');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-sdk', type: 'module', ...metadata }));
  for (const [file, contents] of Object.entries(entries)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), contents); }
  return { state, root, resolve: (request = 'fixture-sdk') => resolveExtension(state, 'pi', request) };
}
test('ESM resolution uses import-only exports and resolves without evaluating the SDK', async t => {
  const { root, resolve } = fixture(t, { exports: { '.': { types: './index.d.ts', import: './entry.mjs' } } }, {
    'entry.mjs': 'export const selected = "import";',
  });
  assert.equal(resolve(), path.join(root, 'entry.mjs'));
  assert.equal((await import(pathToFileURL(resolve()).href)).selected, 'import');
  writeFileSync(path.join(root, 'entry.mjs'), 'throw new Error("SDK evaluated during resolution")');
  assert.equal(resolve(), path.join(root, 'entry.mjs'));
});
test('Node condition order and nested import/default conditions follow native package exports', t => {
  const { root, resolve } = fixture(t, { exports: {
    '.': { node: { import: './node.mjs', require: './wrong.cjs' }, default: './default.mjs' },
    './default-first': { default: './default.mjs', import: './node.mjs' },
  } }, { 'node.mjs': '', 'default.mjs': '', 'wrong.cjs': '' });
  assert.equal(resolve(), path.join(root, 'node.mjs'));
  assert.equal(resolve('fixture-sdk/default-first'), path.join(root, 'default.mjs'));
});
test('exported subpaths, wildcard mappings and array fallbacks work while private files stay private', t => {
  const { root, resolve } = fixture(t, { exports: {
    './v2': { import: './dist/v2/index.mjs' }, './features/*': './dist/features/*.mjs',
    './fallback': ['invalid-package-target', './dist/v2/index.mjs'], './private': null,
  } }, { 'dist/v2/index.mjs': '', 'dist/features/one.mjs': '', 'private.mjs': '' });
  assert.equal(resolve('fixture-sdk/v2'), path.join(root, 'dist/v2/index.mjs'));
  assert.equal(resolve('fixture-sdk/features/one'), path.join(root, 'dist/features/one.mjs'));
  assert.equal(resolve('fixture-sdk/fallback'), path.join(root, 'dist/v2/index.mjs'));
  for (const request of ['fixture-sdk', 'fixture-sdk/private', 'fixture-sdk/private.mjs', 'fixture-sdk/dist/v2/index.mjs']) {
    assert.throws(() => resolve(request), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
test('absolute mjs files and legacy main entry resolve; nonexistent files and non-file modules fail', t => {
  const { state, root, resolve } = fixture(t, { main: './legacy.mjs' }, { 'legacy.mjs': '' });
  assert.equal(resolve(), path.join(root, 'legacy.mjs'));
  assert.equal(resolveExtension(state, 'pi', path.join(root, 'legacy.mjs')), path.join(root, 'legacy.mjs'));
  assert.throws(() => resolveExtension(state, 'pi', path.join(root, 'missing.mjs')), { code: 'ENOENT' });
  assert.throws(() => resolve('node:fs'), /local file/);
  assert.throws(() => resolveExtension(state, '../pi', 'fixture-sdk'), /Invalid extension/);
});
test('a missing provider directory still resolves packages in the enclosing extension directory', t => {
  const { state } = fixture(t, {}, {});
  const root = path.join(state, 'extensions', 'node_modules', 'shared-sdk');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ exports: { import: './entry.mjs' } }));
  writeFileSync(path.join(root, 'entry.mjs'), '');
  assert.equal(resolveExtension(state, 'opencode', 'shared-sdk'), path.join(root, 'entry.mjs'));
});
test('missing SDKs create no resolver process; cache shares repeated lookups and observes manifest changes and removal', t => {
  const { state, root, resolve } = fixture(t, { exports: { import: './entry.mjs' } }, { 'entry.mjs': '', 'replacement.mjs': '' });
  const original = childProcess.execFileSync; let probes = 0;
  t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof original>) => { probes++; return Reflect.apply(original, childProcess, args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let i = 0; i < 3; i++) assert.throws(() => resolveExtension(state, 'pi', 'missing-sdk'), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(probes, 0);
  assert.equal(resolve(), path.join(root, 'entry.mjs'));
  for (let i = 0; i < 5; i++) assert.equal(resolve(), path.join(root, 'entry.mjs'));
  assert.equal(probes, 1);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ exports: { import: './replacement.mjs' } }));
  assert.equal(resolve(), path.join(root, 'replacement.mjs'));
  assert.equal(probes, 2);
  rmSync(path.join(root, 'replacement.mjs'));
  assert.throws(() => resolve(), { code: 'ENOENT' });
  assert.equal(probes, 3);
  rmSync(path.join(root, 'package.json'));
  assert.throws(() => resolve(), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(probes, 3);
});
test('installed Pi 0.80.3 and OpenCode SDK 1.17.13 resolve and import without a model call', async t => {
  const installation = process.env.CAPYRA_REAL_EXTENSION_ROOT;
  if (!installation) { t.skip('Set CAPYRA_REAL_EXTENSION_ROOT to an isolated installation of the pinned SDK versions'); return; }
  const state = mkdtempSync(path.join(os.tmpdir(), 'capyra-real-esm-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  mkdirSync(path.join(state, 'extensions'), { recursive: true });
  for (const [provider, name, version, request, expectedExport] of [
    ['pi', '@earendil-works/pi-coding-agent', '0.80.3', '@earendil-works/pi-coding-agent', 'createAgentSession'],
    ['opencode', '@opencode-ai/sdk', '1.17.13', '@opencode-ai/sdk/v2', 'createOpencodeClient'],
  ]) {
    const packageFile = path.join(installation, 'node_modules', name, 'package.json');
    assert.ok(existsSync(packageFile));
    assert.equal(JSON.parse(readFileSync(packageFile, 'utf8')).version, version);
    symlinkSync(installation, path.join(state, 'extensions', provider), 'junction');
    const filename = resolveExtension(state, provider, request);
    assert.equal(typeof (await import(pathToFileURL(filename).href))[expectedExport], 'function');
    assert.throws(() => resolveExtension(state, provider, `${name}/dist/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
