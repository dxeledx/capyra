import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { AgentDaemonClient } from '../src/daemon/client.js';
import { executionEnvironment } from '../src/execution/sessions.js';
import type { AgentRecord } from '../src/execution/agent-manager.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const diagnostic = (value: unknown) => typeof value === 'string' ? value.slice(0, 4000).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]') : undefined;
test('existing ChatGPT Codex subscription completes and continues a real read-only fixture task', { timeout: 270_000 }, async t => {
  if (process.env.CAPYRA_REAL_CODEX_MODEL !== '1') { t.skip('Explicit CAPYRA_REAL_CODEX_MODEL=1 is required; this test consumes existing ChatGPT subscription quota'); return; }
  const executable = process.env.CAPYRA_TEST_NATIVE_CODEX ?? 'codex';
  const login = spawnSync(executable, ['login', 'status'], { env: executionEnvironment({ login: true }), encoding: 'utf8', timeout: 15000 });
  const loginText = `${login.stdout ?? ''}\n${login.stderr ?? ''}`;
  assert.ok(login.status === 0 && /Logged in using ChatGPT/i.test(loginText) && !/Logged in using an API key/i.test(loginText), 'Existing ChatGPT login was not confirmed; no model call was made');
  const root = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'capyra-real-codeX-'))), state = path.join(root, '.capyra');
  const challenge = randomBytes(8).toString('hex');
  const files = { 'fixture.txt': `alpha=17\nbeta=25\nchallenge=${challenge}\n`, 'followup.txt': 'gamma=19\ndelta=4\n' };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const model = process.env.CAPYRA_REAL_CODEX_MODEL_ID;
  const config = { profileDirs: [], workflow: { instructions: 'on-demand' }, providers: { codex: { executable, timeoutMs: 100000, ...(model ? { model, effort: 'low' } : {}) } }, roles: { 'fixture-reader': { provider: 'codex', writeMode: 'read_only', prompt: 'Read only the fixture files explicitly named in this task. Do not edit files, use the network, inspect authentication files, or dispatch other agents. The task has all needed instructions; report only the requested result.' } } };
  const client = new AgentDaemonClient(state, config), evidence: Record<string, unknown> = { schema: 'capyra-real-agent-e2e/v1', date: new Date().toISOString(), provider: 'codex', loginMode: 'chatgpt', requestedWriteMode: 'read_only', model: model ?? 'existing provider default', modelTurnsRequested: 0, status: 'started' };
  const ctx = { owner: 'local-console', workspace: root, taskId: 'real-e2e-first', signal: new AbortController().signal, progress() {} };
  const finish = async (id: string) => {
    const deadline = Date.now() + 110000;
    for (;;) {
      const [record] = await client.wait([id], 'local-console', root, 12000);
      if (!['starting', 'running'].includes(record.status)) return client.get(id, 'local-console', root);
      if (Date.now() > deadline) { await client.cancel(id, 'local-console', root); throw new Error('Real agent fixture timed out; no automatic retry was made'); }
    }
  };
  const output = async (record: AgentRecord) => {
    const commands: unknown[] = [], errors: unknown[] = [], nativeParameters: unknown[] = [];
    for (const processId of record.turns.flatMap(turn => turn.processSessionIds)) {
      let cursor = 0, stdout = '';
      for (;;) { const page = await client.readOutput(record.id, processId, 'local-console', root, { cursor, limit: 262144 }); stdout += page.output.filter(entry => entry.stream === 'stdout').map(entry => entry.text).join(''); cursor = page.nextCursor; if (!page.hasMore) break; }
      for (const line of stdout.split('\n')) {
        try {
          const message = JSON.parse(line), item = message.params?.item;
          if (message.method === 'item/completed' && item?.type === 'commandExecution') commands.push({ command: item.command, cwd: item.cwd, status: item.status });
          const error = message.error ?? message.params?.error ?? message.params?.turn?.error;
          if (error) errors.push({ method: message.method, message: diagnostic(error.message), code: error.code, willRetry: message.params?.willRetry });
          if (message.result?.model) nativeParameters.push({ model: message.result.model, modelProvider: message.result.modelProvider, approvalPolicy: message.result.approvalPolicy, sandbox: message.result.sandbox });
        } catch {}
      }
    }
    return { commands, errors, nativeParameters };
  };
  try {
    evidence.modelTurnsRequested = 1;
    const started = await client.run({ target: 'fixture-reader', prompt: 'Read fixture.txt in the current working directory. Add alpha and beta, then reply with exactly SUM=<sum> CHALLENGE=<challenge value from the file>. Read the file to obtain the challenge.', writeMode: 'read_only' }, ctx);
    const first = await finish(started.id);
    evidence.firstStatus = first.status; evidence.firstResponse = first.response; evidence.firstError = diagnostic(first.error); evidence.firstProtocol = await output(first);
    assert.equal(first.status, 'completed', 'First native model turn did not complete; inspect the provider locally before retrying');
    assert.match(first.response!, /SUM=42/); assert.ok(first.response!.includes(`CHALLENGE=${challenge}`));
    assert.equal(first.writeMode, 'read_only'); assert.ok(first.providerSessionId);
    evidence.modelTurnsRequested = 2;
    await client.continue(started.id, { prompt: 'Read followup.txt in the same working directory. Multiply gamma and delta, and retain the challenge value from our previous turn. Reply with exactly PRODUCT=<product> CHALLENGE=<previous challenge>.' }, { ...ctx, taskId: 'real-e2e-continue' });
    const second = await finish(started.id);
    evidence.secondStatus = second.status; evidence.secondResponse = second.response; evidence.secondError = diagnostic(second.error); evidence.secondProtocol = await output(second);
    assert.equal(second.status, 'completed', 'Continuation did not complete; no automatic retry was made');
    assert.match(second.response!, /PRODUCT=76/); assert.ok(second.response!.includes(`CHALLENGE=${challenge}`));
    assert.equal(second.providerSessionId, first.providerSessionId); assert.equal(second.writeMode, 'read_only'); assert.equal(second.turns.length, 2);
    const persisted = JSON.parse(await readFile(path.join(state, 'agent-sessions', `${started.id}.json`), 'utf8')) as AgentRecord;
    assert.equal(persisted.status, 'completed'); assert.equal(persisted.providerSessionId, first.providerSessionId); assert.deepEqual(persisted.turns.map(turn => turn.writeMode), ['read_only', 'read_only']);
    const fixtureHashes: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) { const actual = await readFile(path.join(root, name)); assert.equal(digest(actual), digest(content)); fixtureHashes[name] = digest(actual); }
    evidence.fixtureHashes = fixtureHashes; evidence.fixtureFilesUnchanged = true; evidence.sameNativeSession = true; evidence.nativeSessionHash = digest(first.providerSessionId!); evidence.persistedTurnStatuses = persisted.turns.map(turn => turn.status); evidence.persistedWriteModes = persisted.turns.map(turn => turn.writeMode);
    evidence.observedCommands = (await output(second)).commands; evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = diagnostic(error instanceof Error ? error.message : String(error)); throw error;
  } finally {
    await client.stop(true); await client.close(); await rm(root, { recursive: true, force: true }); evidence.fixtureRemoved = true;
    const filename = process.env.CAPYRA_REAL_CODEX_EVIDENCE;
    if (filename) { await mkdir(path.dirname(path.resolve(filename)), { recursive: true }); await writeFile(filename, JSON.stringify(evidence, null, 2) + '\n'); }
  }
});
