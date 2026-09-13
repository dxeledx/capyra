import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIdentityService, validateCloudUrl } from '../src/identity/client.js';
import { startIdentityCloud } from '../src/identity/cloud.js';
import { hash, secret, signProof } from '../src/identity/security.js';
import type { ConnectionProvider } from '../src/identity/types.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'capyra-identity-')));
  const providerCalls: string[] = [];
  const provider: ConnectionProvider = {
    async provision({ deviceId }) { providerCalls.push('provision'); return { tunnelId: deviceId, dnsRecordId: `dns-${deviceId}`, publicUrl: `https://${deviceId}.devices.example`, token: `run-${deviceId}` }; },
    async rotate({ tunnelId }) { providerCalls.push('rotate'); return { token: `rotated-${tunnelId}` }; },
    async revoke() { providerCalls.push('revoke'); },
  };
  let cloud: Awaited<ReturnType<typeof startIdentityCloud>>;
  try { cloud = await startIdentityCloud({ stateDir: join(root, 'cloud'), provider }); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const localA = createIdentityService({ stateDir: join(root, 'alice'), cloudUrl: cloud.url, pollIntervalMs: 0 });
  const localB = createIdentityService({ stateDir: join(root, 'bob'), cloudUrl: cloud.url, pollIntervalMs: 0 });
  return { root, cloud, localA, localB, provider, providerCalls, async close() { localA.close(); localB.close(); await cloud.close(); await rm(root, { recursive: true, force: true }); } };
}
const pass = 'a correct long test password';

test('two independent accounts bind only locally proven devices, isolate management, scopes, and connection credentials', async () => {
  const f = await fixture();
  try {
    const alice = await f.localA.register({ email: 'alice@example.test', password: pass });
    const bob = await f.localB.register({ email: 'bob@example.test', password: pass });
    assert.notEqual(alice.user!.id, bob.user!.id);
    await assert.rejects(f.localA.bind({ code: 'remote-name-is-not-proof', name: 'Known laptop', scope: { workspaces: [f.root], capabilities: ['workspace:*'] } }), /Start pairing/);
    const pairing = await f.localA.startPairing();
    assert.equal(pairing.code.length, 20);
    await assert.rejects(f.localB.bind({ code: pairing.code, name: 'Known laptop', scope: { workspaces: [f.root], capabilities: ['*'] } }), /Start pairing/);
    const bound = await f.localA.bind({ code: pairing.code, name: 'Alice laptop', scope: { workspaces: [f.root], capabilities: ['workspace:*'] } });
    assert.equal(bound.device!.ownerId, alice.user!.id);
    assert.equal(bound.active, true);
    assert.equal((await f.localA.listDevices()).length, 1);
    assert.deepEqual(await f.localB.listDevices(), []);
    await assert.rejects(f.localB.updateScope(bound.device!.id, { workspaces: [f.root], capabilities: ['*'] }), /Device not found/);
    await assert.rejects(f.localB.revokeDevice(bound.device!.id), /Device not found/);
    await f.localA.authorize({ workspace: f.root, capability: 'workspace:read' });
    await assert.rejects(f.localA.authorize({ workspace: tmpdir(), capability: 'workspace:read' }), /workspace.*outside/);
    await assert.rejects(f.localA.authorize({ workspace: f.root, capability: 'process:run' }), /capability.*outside/);
    await assert.rejects(f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } }), /Start pairing/);
    const connection = await f.localA.provisionConnection({ mcpPort: 4317 });
    assert.equal(connection.token, `run-${bound.device!.id}`);
    const deviceList = JSON.stringify(await f.localA.listDevices());
    assert.doesNotMatch(deviceList, /run-|privateKey|connectionToken/);
    assert.equal((await f.localA.rotateConnection()).token, `rotated-${bound.device!.id}`);
    assert.deepEqual(f.providerCalls, ['provision', 'rotate']);
    const statusText = JSON.stringify(f.localA.status());
    assert.doesNotMatch(statusText, /privateKey|csrfToken|"token"|password/);
    assert.doesNotMatch(JSON.stringify(f.localA), /BEGIN PRIVATE KEY|csrfToken|"token"|passwordHash/);
    const statePath = join(f.root, 'alice', 'identity', 'device.json');
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(statePath, 'utf8'), new RegExp(pass));
  } finally { await f.close(); }
});

test('cloud sessions require same-origin and CSRF, pairing and signed challenges are single-use under concurrency', async () => {
  const f = await fixture();
  const request = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => fetch(f.cloud.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const registration = await request('/v1/register', { email: 'alice@example.test', password: pass });
    const session = await registration.json();
    const cookie = registration.headers.getSetCookie()[0].split(';')[0];
    const bearer = cookie.slice(15);
    assert.match(registration.headers.getSetCookie()[0], /HttpOnly/);
    assert.match(registration.headers.getSetCookie()[0], /SameSite=Strict/);
    assert.equal((await request('/v1/session/refresh', {}, { Cookie: cookie })).status, 403);
    assert.equal((await request('/v1/session/refresh', {}, { Cookie: cookie, Origin: 'https://attacker.test', 'x-csrf-token': session.csrfToken })).status, 403);
    assert.equal((await request('/v1/session/refresh', {}, { Authorization: `Bearer ${bearer}` })).status, 403);
    const sessionHeaders = { Authorization: `Bearer ${bearer}`, 'x-csrf-token': session.csrfToken };
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const code = secret(); const codeHash = hash(code); const nonce = secret(); const expiresAt = Date.now() + 5 * 60_000;
    const invalid = await request('/v1/pairings', { publicKey, codeHash, nonce, expiresAt, signature: 'fake' });
    assert.equal(invalid.status, 403);
    const pairProof = { publicKey, codeHash, nonce, expiresAt, signature: signProof(privateKey, 'pair', codeHash, nonce, expiresAt) };
    const pairing = await (await request('/v1/pairings', pairProof)).json();
    assert.equal((await request('/v1/pairings', pairProof)).status, 403);
    const scope = { workspaces: [f.root], capabilities: ['workspace:read'] }; const name = 'Signed device';
    const body = { pairingId: pairing.id, code, name, scope, signature: signProof(privateKey, 'bind', pairing.id, session.user.id, name, scope) };
    const competing = await Promise.all([request('/v1/devices/pair', body, sessionHeaders), request('/v1/devices/pair', body, sessionHeaders)]);
    assert.deepEqual(competing.map(item => item.status).sort(), [201, 403]);
    const device = await competing.find(item => item.status === 201)!.json();
    const challenge = await (await request('/v1/device/challenge', { deviceId: device.id })).json();
    const proof = { deviceId: device.id, challenge: challenge.challenge, signature: signProof(privateKey, 'authenticate', device.id, challenge.challenge) };
    const exchanges = await Promise.all([request('/v1/device/authenticate', proof), request('/v1/device/authenticate', proof)]);
    assert.deepEqual(exchanges.map(item => item.status).sort(), [200, 401]);
    const runtime = await exchanges.find(item => item.status === 200)!.json();
    assert.equal((await fetch(f.cloud.url + '/v1/devices', { headers: { Authorization: `Bearer ${runtime.token}` } })).status, 401);
    assert.equal((await fetch(f.cloud.url + '/v1/device', { headers: { Authorization: `Bearer ${bearer}` } })).status, 401);
    assert.equal((await request(`/v1/devices/${device.id}/revoke`, {}, sessionHeaders)).status, 200);
    assert.equal((await fetch(f.cloud.url + '/v1/device', { headers: { Authorization: `Bearer ${runtime.token}` } })).status, 401);
    assert.equal((await request('/v1/device/authenticate', proof)).status, 401);
  } finally { await f.close(); }
});

test('local approval bounds cloud scope expansion; revocation and credentials survive restart and offline access fails closed', async () => {
  const f = await fixture();
  let restartedCloud: Awaited<ReturnType<typeof startIdentityCloud>> | undefined;
  let restartedLocal: ReturnType<typeof createIdentityService> | undefined;
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    const pairing = await f.localA.startPairing();
    const bound = await f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['workspace:read'] } });
    const disk = JSON.parse(await readFile(join(f.root, 'alice', 'identity', 'device.json'), 'utf8'));
    const headers = { 'content-type': 'application/json', Authorization: `Bearer ${disk.account.token}`, 'x-csrf-token': disk.account.csrfToken };
    const expansion = await fetch(f.cloud.url + `/v1/devices/${bound.device!.id}/scope`, { method: 'PATCH', headers, body: JSON.stringify({ scope: { workspaces: [f.root, tmpdir()], capabilities: ['*'] } }) });
    assert.equal(expansion.status, 200);
    await assert.rejects(f.localA.authorize({ workspace: f.root, capability: 'process:run' }), /capability.*outside/);
    await assert.rejects(f.localA.authorize({ workspace: tmpdir(), capability: 'workspace:read' }), /workspace.*outside/);
    f.localA.close();
    const port = Number(new URL(f.cloud.url).port);
    await f.cloud.close();
    restartedLocal = createIdentityService({ stateDir: join(f.root, 'alice'), pollIntervalMs: 0 });
    assert.equal(restartedLocal.status().user!.email, 'alice@example.test');
    assert.equal(restartedLocal.status().active, false);
    await assert.rejects(restartedLocal.authorize({ workspace: f.root, capability: 'workspace:read' }), /unreachable/);
    restartedCloud = await startIdentityCloud({ stateDir: join(f.root, 'cloud'), port, provider: f.provider });
    await restartedLocal.authorize({ workspace: f.root, capability: 'workspace:read' });
    let changes = 0;
    restartedLocal.onBindingChanged(status => { if (!status.active) changes++; });
    await restartedLocal.refreshSession();
    await restartedLocal.revokeDevice(bound.device!.id);
    await assert.rejects(restartedLocal.authorize({ workspace: f.root, capability: 'workspace:read' }), /active local device/);
    assert.ok(changes > 0);
    restartedLocal.close();
    restartedLocal = createIdentityService({ stateDir: join(f.root, 'alice'), pollIntervalMs: 0 });
    await assert.rejects(restartedLocal.authorize({ workspace: f.root, capability: 'workspace:read' }), /active local device/);
    assert.ok((await restartedLocal.listDevices())[0].revokedAt);
    await restartedLocal.unbind();
    assert.equal(restartedLocal.status().device, undefined);
  } finally { restartedLocal?.close(); await restartedCloud?.close(); await f.close(); }
});

test('account password rotation invalidates old sessions and single-writer locking prevents lost revocations', async () => {
  const f = await fixture();
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    await f.localB.login({ email: 'alice@example.test', password: pass });
    await f.localA.changePassword({ currentPassword: pass, password: 'a different secure test password' });
    await assert.rejects(f.localB.listDevices(), /Sign in/);
    await assert.rejects(f.localB.login({ email: 'alice@example.test', password: pass }), /incorrect/);
    await f.localB.login({ email: 'alice@example.test', password: 'a different secure test password' });
    await assert.rejects(startIdentityCloud({ stateDir: join(f.root, 'cloud') }), /already open/);
  } finally { await f.close(); }
});

test('revocation wins a concurrent provisioning operation and cleanup failure keeps access revoked', async () => {
  const f = await fixture();
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    const pairing = await f.localA.startPairing();
    const bound = await f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(done => { started = done; });
    const releasePromise = new Promise<void>(done => { release = done; });
    f.provider.provision = async ({ deviceId }) => { started(); await releasePromise; return { tunnelId: deviceId, publicUrl: 'https://device.example', token: 'device-runtime-secret' }; };
    const provisioning = f.localA.provisionConnection({ mcpPort: 4317 });
    const rejectedProvisioning = assert.rejects(provisioning, /authorization changed/);
    await startedPromise;
    const disk = JSON.parse(await readFile(join(f.root, 'alice', 'identity', 'device.json'), 'utf8'));
    const revoke = await fetch(f.cloud.url + `/v1/devices/${bound.device!.id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${disk.account.token}`, 'x-csrf-token': disk.account.csrfToken }, body: '{}' });
    assert.equal(revoke.status, 200);
    release(); await rejectedProvisioning;
    assert.deepEqual(f.providerCalls, ['revoke']);
    await assert.rejects(f.localA.authorize({ workspace: f.root, capability: 'workspace:read' }), /unavailable/);
    assert.equal(f.localA.status().active, false);
    await f.localA.unbind();
    const secondPairing = await f.localA.startPairing();
    const second = await f.localA.bind({ code: secondPairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } });
    await f.localA.provisionConnection({ mcpPort: 4317 });
    f.provider.revoke = async () => { throw new Error('vendor unavailable'); };
    await assert.rejects(f.localA.revokeDevice(second.device!.id), /cleanup failed/);
    await assert.rejects(f.localA.authorize({ workspace: f.root, capability: 'workspace:read' }), /unavailable/);
    assert.ok((await f.localA.listDevices()).find(device => device.id === second.device!.id)!.revokedAt);
    f.provider.revoke = async () => undefined;
    await f.localA.unbind();
    assert.equal(f.localA.status().device, undefined);
  } finally { await f.close(); }
});

test('cloud maintenance backup is private and restore cannot revive previously granted device access', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = await fixture();
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    const pairing = await f.localA.startPairing();
    await f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } });
    const stateDir = join(f.root, 'cloud'); const backup = join(f.root, 'account-backup.json');
    const admin = (...args: string[]) => spawnSync(process.execPath, ['cloud/admin.mjs', ...args], { encoding: 'utf8' });
    const firstBackup = admin('backup', stateDir, backup);
    assert.equal(firstBackup.status, 0, firstBackup.stderr);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.notEqual(admin('backup', stateDir, backup).status, 0);
    assert.match(admin('restore', stateDir, backup).stderr, /Stop the account service/);
    await f.cloud.close();
    const restored = admin('restore', stateDir, backup);
    assert.equal(restored.status, 0, restored.stderr);
    const database = JSON.parse(await readFile(join(stateDir, 'identity.json'), 'utf8'));
    assert.equal(database.sessions.length, 0);
    assert.equal(database.deviceTokens.length, 0);
    assert.ok(database.devices.every((device: { revokedAt: string; connectionToken?: string }) => device.revokedAt && !device.connectionToken));
    const stats = admin('inspect', stateDir);
    assert.equal(stats.status, 0, stats.stderr);
    assert.equal(JSON.parse(stats.stdout).activeDevices, 0);
  } finally { await f.close(); }
});

test('an earlier cloud response cannot reactivate a local revocation or overwrite a narrower local scope', async () => {
  const f = await fixture();
  const nativeFetch = globalThis.fetch;
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    const pairing = await f.localA.startPairing();
    const bound = await f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } });
    async function holdDeviceResponse() {
      let release!: () => void; let observed!: () => void;
      const blocked = new Promise<void>(done => { observed = done; });
      const gate = new Promise<void>(done => { release = done; });
      let held = false;
      globalThis.fetch = async (input, options) => {
        const response = await nativeFetch(input, options);
        if (!held && String(input) === f.cloud.url + '/v1/device') {
          held = true; const text = await response.text(); observed(); await gate;
          return new Response(text, { status: response.status, headers: response.headers });
        }
        return response;
      };
      const request = f.localA.refreshBinding();
      const rejection = assert.rejects(request, /binding changed/);
      await blocked;
      return { release, rejection };
    }
    const oldScope = await holdDeviceResponse();
    await f.localA.updateScope(bound.device!.id, { workspaces: [f.root], capabilities: ['workspace:read'] });
    oldScope.release(); await oldScope.rejection;
    assert.deepEqual(f.localA.status().device!.scope.capabilities, ['workspace:read']);
    assert.equal(f.localA.status().active, true);
    await assert.rejects(f.localA.authorize({ workspace: f.root, capability: 'process:run' }), /capability.*outside/);
    const oldAuthorization = await holdDeviceResponse();
    await f.localA.revokeDevice(bound.device!.id);
    oldAuthorization.release(); await oldAuthorization.rejection;
    assert.equal(f.localA.status().active, false);
    assert.ok(f.localA.status().device!.revokedAt);
  } finally { globalThis.fetch = nativeFetch; await f.close(); }
});

test('account service retains the writer lock until in-flight provisioning has committed during shutdown', async () => {
  const f = await fixture();
  try {
    await f.localA.register({ email: 'alice@example.test', password: pass });
    const pairing = await f.localA.startPairing();
    await f.localA.bind({ code: pairing.code, scope: { workspaces: [f.root], capabilities: ['*'] } });
    let release!: () => void; let started!: () => void;
    const blocked = new Promise<void>(done => { started = done; });
    const gate = new Promise<void>(done => { release = done; });
    f.provider.provision = async ({ deviceId }) => { started(); await gate; return { tunnelId: deviceId, publicUrl: 'https://shutdown-test.example', token: 'runtime-token-at-shutdown' }; };
    const provisioning = f.localA.provisionConnection({ mcpPort: 4317 });
    const rejected = assert.rejects(provisioning, /unreachable/);
    await blocked;
    const closing = f.cloud.close();
    await assert.rejects(startIdentityCloud({ stateDir: join(f.root, 'cloud') }), /already open/);
    release(); await closing; await rejected;
    const database = JSON.parse(await readFile(join(f.root, 'cloud', 'identity.json'), 'utf8'));
    assert.equal(database.devices[0].connection.publicUrl, 'https://shutdown-test.example');
    const reopened = await startIdentityCloud({ stateDir: join(f.root, 'cloud') });
    await reopened.close();
  } finally { await f.close(); }
});

test('account base URL accepts canonical prefixes and rejects parser-normalized traversal and ambiguous URLs', () => {
  for (const [value, expected] of [
    ['https://203.0.113.10/capyra', 'https://203.0.113.10/capyra'],
    ['https://accounts.example.test/capyra/', 'https://accounts.example.test/capyra'],
    ['https://accounts.example.test/api/v1', 'https://accounts.example.test/api/v1'],
    ['https://accounts.example.test/', 'https://accounts.example.test'],
    ['http://127.0.0.1:4320/capyra/', 'http://127.0.0.1:4320/capyra'],
    ['http://[::1]:4320', 'http://[::1]:4320'],
  ]) assert.equal(validateCloudUrl(value), expected);
  for (const value of [
    'https://user:password@accounts.example.test/capyra', 'https://@accounts.example.test/capyra',
    'https://accounts.example.test/capyra?secret=x', 'https://accounts.example.test/capyra?',
    'https://accounts.example.test/capyra#fragment', 'https://accounts.example.test/capyra#',
    'https://accounts.example.test/capyra/../other', 'https://accounts.example.test/capyra/./other',
    'https://accounts.example.test/capyra/%2e%2e/other', 'https://accounts.example.test/capyra/%252e%252e/other',
    'https://accounts.example.test/capyra%2f..%2fother', 'https://accounts.example.test/capyra%5cother',
    'https://accounts.example.test/capyra\\other', 'https://accounts.example.test/capyra//other',
    'https://accounts.example.test/capyra\n', ' https://accounts.example.test/capyra',
    'http://203.0.113.10/capyra', 'https:///accounts.example.test/capyra',
  ]) assert.throws(() => validateCloudUrl(value), undefined, value);
});

test('real path-stripping proxy preserves account login, pairing, scope, CSRF origin and cookie path', async () => {
  const { createServer, request: httpRequest } = await import('node:http');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'capyra-identity-prefix-')));
  const paths: string[] = [];
  let upstream = '';
  let cloud: Awaited<ReturnType<typeof startIdentityCloud>> | undefined;
  let localA: ReturnType<typeof createIdentityService> | undefined;
  let localB: ReturnType<typeof createIdentityService> | undefined;
  const proxy = createServer((req, res) => {
    paths.push(req.url ?? '');
    if (!req.url?.startsWith('/capyra/')) { res.end('existing application'); return; }
    // 等价于 Nginx location /capyra/ + proxy_pass http://127.0.0.1:4320/，保留外部 Host。
    const target = httpRequest(upstream + req.url.slice('/capyra'.length), { method: req.method, headers: req.headers }, response => {
      const headers = { ...response.headers };
      if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(cookie => cookie.replace(/Path=\/v1(?=;|$)/, 'Path=/capyra/v1'));
      res.writeHead(response.statusCode!, headers); response.pipe(res);
    });
    target.on('error', () => { res.statusCode = 502; res.end('upstream unavailable'); });
    req.pipe(target);
  });
  try {
    await new Promise<void>((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`;
    cloud = await startIdentityCloud({ stateDir: join(root, 'cloud'), publicOrigin: origin });
    upstream = cloud.url;
    localA = createIdentityService({ stateDir: join(root, 'alice'), cloudUrl: origin + '/capyra/', pollIntervalMs: 0 });
    localB = createIdentityService({ stateDir: join(root, 'bob'), cloudUrl: origin + '/capyra', pollIntervalMs: 0 });
    assert.equal(localA.status().cloudUrl, origin + '/capyra');
    assert.equal(await (await fetch(origin + '/')).text(), 'existing application');
    assert.equal((await (await fetch(origin + '/capyra/health')).json()).service, 'capyra-identity');
    await localA.register({ email: 'alice@example.test', password: pass });
    await localB.register({ email: 'bob@example.test', password: pass });
    const pairing = await localA.startPairing();
    const bound = await localA.bind({ code: pairing.code, scope: { workspaces: [root], capabilities: ['workspace:read'] } });
    await localA.authorize({ workspace: root, capability: 'workspace:read' });
    assert.deepEqual(await localB.listDevices(), []);
    await assert.rejects(localB.revokeDevice(bound.device!.id), /Device not found/);
    await localA.refreshSession();
    const login = await fetch(origin + '/capyra/v1/login', { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'alice@example.test', password: pass }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const setCookie = login.headers.getSetCookie()[0];
    assert.match(setCookie, /Path=\/capyra\/v1;/);
    const cookie = setCookie.split(';')[0];
    const refresh = (requestOrigin: string) => fetch(origin + '/capyra/v1/session/refresh', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie, Origin: requestOrigin, 'x-csrf-token': session.csrfToken }, body: '{}' });
    assert.equal((await refresh(origin + '/capyra')).status, 403);
    assert.equal((await refresh(origin)).status, 200);
    await localA.revokeDevice(bound.device!.id);
    await assert.rejects(localA.authorize({ workspace: root, capability: 'workspace:read' }), /active local device/);
    assert.ok(paths.includes('/capyra/v1/register'));
    assert.ok(paths.includes('/capyra/v1/device/authenticate'));
    assert.ok(paths.includes('/capyra/v1/session/refresh'));
    assert.ok(paths.every(path => path === '/' || path.startsWith('/capyra/')));
  } finally {
    localA?.close(); localB?.close(); await cloud?.close();
    proxy.closeAllConnections();
    await new Promise<void>(done => { proxy.close(() => done()); });
    await rm(root, { recursive: true, force: true });
  }
});
