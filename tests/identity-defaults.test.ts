import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { initConfig, loadConfig } from '../src/config.js';
import type { PluginContext } from '../src/core/types.js';
import { createIdentityService, type IdentityService } from '../src/identity/client.js';
import { DEFAULT_ACCOUNT_SERVICE_URL } from '../src/identity/defaults.js';
import identityPlugin from '../src/plugins/identity.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'capyra-identity-defaults-')));
  const disposers: Array<() => void | Promise<void>> = [];
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Default configuration must not contact an account service'); });
  t.after(async () => {
    try {
      for (const dispose of disposers.reverse()) await dispose();
      assert.equal(network.mock.callCount(), 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  async function start(stateDir: string, config: Record<string, unknown> = {}) {
    const services = new Map<string, unknown>();
    const context: PluginContext = {
      workspace: root, stateDir, config,
      provide(name, service) { services.set(name, service); },
      service<T>(name: string) { assert(services.has(name)); return services.get(name) as T; },
      onDispose(dispose) { disposers.push(dispose); },
      registerTool() { throw new Error('Identity must not expose management tools'); },
      guard() {}, onEvent() {},
    };
    await identityPlugin.setup(context);
    return context.service<IdentityService>('identity');
  }
  return { root, start };
}

test('new and implicit configurations are local and do not configure an account service', async t => {
  const f = await fixture(t);
  const configPath = join(f.root, 'capyra.config.json');
  const implicit = await loadConfig(configPath);
  assert.equal(implicit.plugins.some(plugin => plugin.id === 'identity'), false);
  await initConfig(configPath);
  const generated = await loadConfig(configPath);
  assert.equal(generated.plugins.some(plugin => plugin.id === 'identity'), false);
  assert.equal(generated.plugins.find(plugin => plugin.id === 'connection')?.enabled, true);
  assert.doesNotMatch(await readFile(configPath, 'utf8'), /cloudUrl|62\.234\.38\.84/);
});

test('an existing plugin entry without an address receives the default only at setup', async t => {
  const f = await fixture(t);
  const configPath = join(f.root, 'capyra.config.json');
  const original = JSON.stringify({ version: 1, workspace: '.', plugins: [{ id: 'identity', enabled: true, grants: [] }] });
  await writeFile(configPath, original);
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.plugins[0].config, undefined);
  assert.equal((await f.start(loaded.stateDir, loaded.plugins[0].config)).status().cloudUrl, DEFAULT_ACCOUNT_SERVICE_URL);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('explicit custom and local self-hosted addresses survive config loading and plugin setup', async t => {
  const f = await fixture(t);
  for (const [index, cloudUrl] of ['https://accounts.example.test/team', 'http://127.0.0.1:44320/capyra', ''].entries()) {
    const configPath = join(f.root, `custom-${index}.json`);
    const original = JSON.stringify({ version: 1, workspace: '.', plugins: [{ id: 'identity', enabled: true, grants: [], config: { cloudUrl } }] });
    await writeFile(configPath, original);
    const config = await loadConfig(configPath);
    assert.equal(config.plugins[0].config?.cloudUrl, cloudUrl);
    const service = await f.start(join(f.root, `state-${index}`), config.plugins[0].config);
    assert.equal(service.status().cloudUrl, cloudUrl || undefined);
    assert.equal(service.status().configured, Boolean(cloudUrl));
    assert.equal(await readFile(configPath, 'utf8'), original);
  }
});

test('persisted account service and local identity keys remain unchanged when defaults are introduced', async t => {
  const f = await fixture(t);
  const stateDir = join(f.root, 'existing');
  const cloudUrl = 'http://localhost:44320/self-hosted';
  const original = createIdentityService({ stateDir, cloudUrl, pollIntervalMs: 0 });
  original.close();
  const statePath = join(stateDir, 'identity', 'device.json');
  // 只比较摘要，避免断言失败时将私钥打印到测试日志。
  const digest = async () => createHash('sha256').update(await readFile(statePath)).digest('hex');
  const before = await digest();
  const resumed = await f.start(stateDir, { cloudUrl: DEFAULT_ACCOUNT_SERVICE_URL });
  assert.equal(resumed.status().cloudUrl, cloudUrl);
  assert.equal(await digest(), before);
});

test('the standalone identity service retains its explicit configuration contract', async t => {
  const f = await fixture(t);
  const service = createIdentityService({ stateDir: join(f.root, 'standalone'), pollIntervalMs: 0 });
  try { assert.equal(service.status().configured, false); assert.equal(service.status().cloudUrl, undefined); }
  finally { service.close(); }
});
