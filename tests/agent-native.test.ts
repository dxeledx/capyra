import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { ProcessSessions, executionEnvironment } from '../src/execution/sessions.js';

test('installed Codex accepts app-server initialize without invoking a model', async t => {
  const executable = process.env.CAPYRA_TEST_NATIVE_CODEX;
  if (!executable) { t.skip('Set CAPYRA_TEST_NATIVE_CODEX for a model-free installed-provider protocol check'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-native-codex-')), sessions = new ProcessSessions(path.join(root, 'state'));
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'codex'));
  const record = await sessions.start({ command: executable, args: ['app-server'], owner: 'local-console', workspace: root, cwd: root, taskId: 'initialize',
    env: { ...executionEnvironment(), HOME: root, CODEX_HOME: path.join(root, 'codex') } });
  await sessions.write(record.id, 'local-console', root, JSON.stringify({ id: 7, method: 'initialize', params: { clientInfo: { name: 'capyra', title: 'Capyra', version: '0.2.0' }, capabilities: {} } }) + '\n');
  let output = '', stderr = '', cursor = 0, initialized: unknown;
  for (let attempt = 0; attempt < 40 && !initialized; attempt++) {
    const page = await sessions.read(record.id, 'local-console', root, { cursor, waitMs: 250 }); cursor = page.nextCursor;
    output += page.output.filter(entry => entry.stream === 'stdout').map(entry => entry.text).join('');
    stderr += page.output.filter(entry => entry.stream === 'stderr').map(entry => entry.text).join('');
    for (const line of output.split('\n').slice(0, -1)) { const message = JSON.parse(line); if (message.id === 7) { assert.equal(message.error, undefined); initialized = message.result; } }
  }
  assert.ok(initialized, `native app-server initialization returned no result: ${stderr.slice(-2000)}`);
  await sessions.stop(record.id, 'local-console', root);
});
