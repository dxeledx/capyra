import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccessController } from '../src/transport/access.js';
const input = { owner: 'shared-grant', method: 'history', description: 'Read history', args: { id: '1' } };

test('each live callback consumes exactly one local decision with local-only default', async () => {
  const access = createAccessController(1000);
  const first = access.request(input); const second = access.request(input);
  const [a, b] = access.pending();
  assert.notEqual(a.id, b.id); access.decide(a.id, true);
  assert.deepEqual(await first, { allowed: true, visibility: 'local' });
  assert.equal(access.pending()[0].id, b.id);
  assert.throws(() => access.decide(a.id, true, 'client'));
  access.decide(b.id, true, 'client'); assert.deepEqual(await second, { allowed: true, visibility: 'client' });
  access.close();
});
test('expiry, disconnect, pause and grant revocation clear live approvals', async () => {
  const access = createAccessController(20);
  const expired = access.request(input); const id = access.pending()[0].id;
  await delay(30); assert.equal((await expired).reason, 'expired'); assert.throws(() => access.decide(id, true));
  const controller = new AbortController(); const disconnected = access.request(input, controller.signal); controller.abort();
  assert.equal((await disconnected).reason, 'cancelled');
  const revoked = access.request(input); access.cancelOwner(input.owner); assert.equal((await revoked).allowed, false);
  const other = access.request({ ...input, owner: 'another' }); access.cancelOwner(input.owner); assert.equal(access.pending().length, 1);
  access.pause(true); assert.equal((await other).allowed, false); assert.equal((await access.request(input)).reason, 'paused');
  access.pause(false); const closed = access.request(input); access.close(); assert.equal((await closed).allowed, false);
});
