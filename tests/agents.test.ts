import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { ProcessSessions } from '../src/execution/sessions.js';
import { AgentManager } from '../src/execution/agent-manager.js';
import type { ToolContext } from '../src/core/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, source: string, provider = 'command') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-agents-')), state = path.join(root, 'state');
  const executable = path.join(root, 'provider.mjs'); await writeFile(executable, source);
  const sessions = new ProcessSessions(state);
  const config = { profileDirs: [], workflow: { enabled: false }, providers: { [provider]: { provider, executable: process.execPath, args: [executable, '{prompt}', '{sessionId}'], resumeArgs: [executable, '{prompt}', '{sessionId}'] } }, roles: { reviewer: { provider, description: 'Review only', prompt: 'Role context.' } } };
  const manager = new AgentManager(sessions, state, config);
  t.after(async () => { await manager.close(); await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const ctx: ToolContext = { owner: 'alice', workspace: root, taskId: 'task-1', signal: new AbortController().signal, progress() {} };
  const done = async (id: string) => (await manager.wait([id], 'alice', root, 12000))[0];
  return { root, state, sessions, manager, ctx, done, config };
}
const command = 'process.stdout.write(JSON.stringify({prompt:process.argv[2],session:process.argv[3]}))';
test('agent command dispatch, role application, continuation and ownership isolation', async t => {
  const f = await fixture(t, command);
  const start = await f.manager.run({ target: 'reviewer', prompt: 'Inspect it $(literal).' }, f.ctx);
  assert.equal(start.status, 'starting');
  assert.throws(() => f.manager.get(start.id, 'bob', f.root), /Unknown/);
  assert.equal(f.manager.list('bob', f.root).length, 0);
  const first = await f.done(start.id); assert.equal(first.status, 'completed');
  assert.deepEqual(JSON.parse(first.response!), { prompt: 'Role context.\n\nInspect it $(literal).', session: start.id });
  await f.manager.continue(start.id, { prompt: 'Continue' }, { ...f.ctx, taskId: 'task-2' });
  const second = await f.done(start.id); assert.equal(second.status, 'completed');
  assert.equal(second.turns.length, 2); assert.equal(second.providerSessionId, start.id);
  assert.equal(JSON.parse(second.response!).prompt, 'Role context.\n\nContinue');
  assert.equal(f.sessions.list('alice', f.root).filter(record => record.status === 'running').length, 0);
});
test('agent restart preserves native session and never repeats the original turn', async t => {
  const f = await fixture(t, command);
  const record = await f.manager.run({ target: 'command', prompt: 'first' }, f.ctx); await f.done(record.id); await f.manager.close();
  const filename = path.join(f.state, 'agent-sessions', `${record.id}.json`);
  const persisted = JSON.parse(await readFile(filename, 'utf8')); persisted.status = 'running'; persisted.turns[0].status = 'running'; await writeFile(filename, JSON.stringify(persisted));
  const restored = new AgentManager(f.sessions, f.state, f.config); t.after(() => restored.close());
  assert.equal(restored.status().active, 0);
  assert.equal(restored.get(record.id, 'alice', f.root).status, 'interrupted');
  await restored.continue(record.id, { prompt: 'second' }, f.ctx);
  const [done] = await restored.wait([record.id], 'alice', f.root, 12000);
  assert.equal(done.status, 'completed'); assert.equal(done.turns.length, 2);
  assert.equal(JSON.parse(done.response!).session, record.id);
});
test('one active turn per agent; cancellation releases process resources', async t => {
  const f = await fixture(t, 'process.stdout.write("started");setInterval(()=>{},1000)');
  const record = await f.manager.run({ target: 'command', prompt: 'long' }, f.ctx);
  await assert.rejects(f.manager.continue(record.id, { prompt: 'conflict' }, f.ctx), /active turn/);
  for (let i = 0; i < 100 && !f.manager.get(record.id, 'alice', f.root).turns[0].processSessionIds.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const cancelled = await f.manager.cancel(record.id, 'alice', f.root);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.manager.status().active, 0);
  assert.equal(f.sessions.list('alice', f.root).filter(record => record.status === 'running').length, 0);
});
const rpcBase = `import readline from 'node:readline';const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const reply=result=>send({jsonrpc:'2.0',id:m.id,result});`;
test('native Codex app-server adapter initializes, runs and resumes exact thread', async t => {
  const f = await fixture(t, rpcBase + `if(m.method==='initialize')reply({});else if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:m.params.threadId??'native-codex-session'}});else if(m.method==='turn/start'){reply({turn:{id:'turn-1'}});send({method:'item/agentMessage/delta',params:{delta:'answer'}});send({method:'turn/completed',params:{turn:{status:'completed',items:[{type:'agentMessage',text:m.params.input[0].text}]}}});}});`, 'codex');
  const record = await f.manager.run({ target: 'codex', prompt: 'first prompt' }, f.ctx);
  const first = await f.done(record.id); assert.equal(first.status, 'completed'); assert.equal(first.response, 'first prompt'); assert.equal(first.providerSessionId, 'native-codex-session');
  await f.manager.continue(record.id, { prompt: 'continued prompt' }, f.ctx);
  const second = await f.done(record.id); assert.equal(second.status, 'completed'); assert.equal(second.response, 'continued prompt'); assert.equal(second.providerSessionId, first.providerSessionId);
});
test('Codex disconnection during a turn fails immediately and preserves native identity', async t => {
  const f = await fixture(t, rpcBase + `if(m.method==='initialize')reply({});else if(m.method==='thread/start')reply({thread:{id:'durable'}});else if(m.method==='turn/start'){reply({turn:{id:'one'}});setTimeout(()=>process.exit(1),10)}});`, 'codex');
  const record = await f.manager.run({ target: 'codex', prompt: 'disconnect' }, f.ctx);
  const ended = await f.done(record.id); assert.equal(ended.status, 'failed'); assert.equal(ended.providerSessionId, 'durable'); assert.match(ended.error!, /disconnected/);
});
test('ACP provider initialization, model configuration, streaming result and resume', async t => {
  const f = await fixture(t, rpcBase + `if(m.method==='initialize')reply({agentCapabilities:{sessionCapabilities:{resume:true}}});else if(m.method==='session/new'||m.method==='session/resume')reply({sessionId:m.params.sessionId??'acp-native',configOptions:[{type:'select',id:'model',category:'model',options:[{value:'test-model'}]}]});else if(m.method==='session/set_config_option')reply({});else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.params.prompt[0].text}}}});reply({stopReason:'end_turn'});}});`, 'cursor');
  const record = await f.manager.run({ target: 'cursor', prompt: 'acp works', model: 'test-model' }, f.ctx);
  const first = await f.done(record.id); assert.equal(first.status, 'completed'); assert.equal(first.response, 'acp works'); assert.equal(first.providerSessionId, 'acp-native');
  await f.manager.continue(record.id, { prompt: 'resumed' }, f.ctx); assert.equal((await f.done(record.id)).response, 'resumed');
});
test('native SDK providers are lazy and Claude SDK path can be supplied locally', async t => {
  const f = await fixture(t, command);
  const sdk = path.join(f.root, 'claude.mjs');
  await writeFile(sdk, `export function query({prompt,options}){return {async *[Symbol.asyncIterator](){yield {type:'system',session_id:options.resume??'claude-native'};yield {type:'result',subtype:'success',result:prompt};},close(){}}}`);
  const manager = new AgentManager(f.sessions, f.state, { profileDirs: [], workflow: { enabled: false }, providers: { claude: { module: sdk } } }); t.after(() => manager.close());
  const target = manager.catalog(f.root).targets.find(item => item.id === 'claude'); assert.equal(target?.available, true);
  const record = await manager.run({ target: 'claude', prompt: 'SDK response' }, f.ctx);
  const [ended] = await manager.wait([record.id], 'alice', f.root, 12000); assert.equal(ended.status, 'completed'); assert.equal(ended.response, 'SDK response'); assert.equal(ended.providerSessionId, 'claude-native');
});
test('flat YAML role profiles are discovered with explicit diagnostics for malformed files', async t => {
  const f = await fixture(t, command), directory = path.join(f.root, 'profiles'); await mkdir(directory);
  await writeFile(path.join(directory, 'explorer.md'), '---\nschema: capyra-agent/v1\nname: explorer\nprovider: command\ndescription: "Find relevant code"\n---\nExplain the data flow.');
  await writeFile(path.join(directory, 'broken.md'), '---\nprovider: missing\n---\nbody');
  const manager = new AgentManager(f.sessions, f.state, { ...f.config, profileDirs: [directory] }); t.after(() => manager.close());
  const catalog = manager.catalog(f.root); assert.equal(catalog.warnings.length, 1); assert.ok(catalog.targets.some(target => target.id === 'explorer'));
  const record = await manager.run({ target: 'explorer', prompt: 'target' }, f.ctx);
  const [ended] = await manager.wait([record.id], 'alice', f.root, 12000); assert.equal(ended.status, 'completed'); assert.equal(JSON.parse(ended.response!).prompt, 'Explain the data flow.\n\ntarget');
});

test('Pi native SDK session IDs survive explicit continuation', async t => {
  const f = await fixture(t, command), sdk = path.join(f.root, 'pi.mjs');
  await writeFile(sdk, `const saved=new Map();export const getAgentDir=()=>${JSON.stringify(f.root)};export const AuthStorage={create:()=>({})};export const ModelRegistry={create:()=>({getAll:()=>[{id:'model'}],find:()=>({id:'model'})})};export const SessionManager={create:cwd=>({id:'pi-native',path:cwd}),list:async cwd=>[{id:'pi-native',path:cwd}],open:path=>({id:'pi-native',path})};export async function createAgentSession({sessionManager}){const messages=saved.get(sessionManager.id)??[];saved.set(sessionManager.id,messages);return {session:{sessionId:sessionManager.id,messages,subscribe:()=>()=>{},abort:async()=>{},dispose(){},async prompt(text){messages.push({role:'assistant',content:[{type:'text',text}]})}}}}`);
  const manager = new AgentManager(f.sessions, f.state, { profileDirs: [], workflow: { enabled: false }, providers: { pi: { module: sdk, writeMode: 'full_access' } } }); t.after(() => manager.close());
  const record = await manager.run({ target: 'pi', prompt: 'first', model: 'model' }, f.ctx);
  assert.equal((await manager.wait([record.id], 'alice', f.root, 12000))[0].status, 'completed');
  await manager.continue(record.id, { prompt: 'continued' }, f.ctx);
  const [ended] = await manager.wait([record.id], 'alice', f.root, 12000); assert.equal(ended.response, 'continued'); assert.equal(ended.providerSessionId, 'pi-native');
});
test('pausing remote agent owners keeps locally dispatched work running', async t => {
  const f = await fixture(t, 'process.stdout.write("started");setInterval(()=>{},1000)');
  const remote = await f.manager.run({ target: 'command', prompt: 'remote' }, f.ctx);
  const local = await f.manager.run({ target: 'command', prompt: 'local' }, { ...f.ctx, owner: 'local-console' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.manager.cancelOwner();
  assert.equal(f.manager.get(remote.id, 'alice', f.root).status, 'cancelled');
  assert.equal(f.manager.get(local.id, 'local-console', f.root).status, 'running');
  assert.equal(f.manager.listLocal().length, 2);
});
test('read-only manager inspection never reconciles or starts saved running work', async t => {
  const f = await fixture(t, command);
  const record = await f.manager.run({ target: 'command', prompt: 'done' }, f.ctx); await f.done(record.id);
  const filename = path.join(f.state, 'agent-sessions', `${record.id}.json`), saved = JSON.parse(await readFile(filename, 'utf8'));
  saved.status = 'running'; await writeFile(filename, JSON.stringify(saved)); const before = await readFile(filename, 'utf8');
  const readOnly = new AgentManager(undefined, f.state, f.config, { readOnly: true });
  assert.equal(readOnly.get(record.id, 'alice', f.root).status, 'running');
  await assert.rejects(readOnly.run({ target: 'command', prompt: 'bad' }, f.ctx), /read-only/);
  await readOnly.close(); assert.equal(await readFile(filename, 'utf8'), before);
});

test('Grok custom completion is bound to the active prompt and ignores background completions', async t => {
  const f = await fixture(t, rpcBase + `if(m.method==='initialize')reply({agentCapabilities:{}});else if(m.method==='session/new')reply({sessionId:'grok-native'});else if(m.method==='session/prompt'){send({method:'x.ai/session/prompt_complete',params:{sessionId:'grok-native',promptId:'background-wrong'}});setTimeout(()=>{send({method:'session/update',params:{sessionId:'grok-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'grok finished'}}}});send({method:'_x.ai/session/prompt_complete',params:{sessionId:'grok-native',promptId:m.params._meta.promptId}})},30)}});`, 'grok');
  const record = await f.manager.run({ target: 'grok', prompt: 'test' }, f.ctx);
  const ended = await f.done(record.id); assert.equal(ended.status, 'completed'); assert.equal(ended.response, 'grok finished');
});

test('large escaped history stays within disk recovery budget and reports response truncation', async t => {
  const f = await fixture(t, command);
  f.manager.drivers.set('command', { async run(input) { input.onSession('budget-native'); return { providerSessionId: 'budget-native', response: '\x00'.repeat(180000) }; } });
  const record = await f.manager.run({ target: 'command', prompt: 'budget' }, f.ctx); await f.done(record.id);
  for (let i = 0; i < 8; i++) { await f.manager.continue(record.id, { prompt: '\x00'.repeat(120000) }, f.ctx); await f.done(record.id); }
  const ended = f.manager.get(record.id, 'alice', f.root); assert.equal(ended.status, 'completed'); assert.equal(ended.responseTruncated, true);
  const bytes = await readFile(path.join(f.state, 'agent-sessions', `${record.id}.json`)); assert.ok(bytes.length <= 4 * 1024 * 1024);
  const readOnly = new AgentManager(undefined, f.state, f.config, { readOnly: true }); assert.equal(readOnly.get(record.id, 'alice', f.root).status, 'completed');
});

test('OpenCode SDK adapter starts a scoped server, passes model and effort, and releases it', async t => {
  const f = await fixture(t, 'process.stdout.write("opencode server listening on http://127.0.0.1:45678\\n");setInterval(()=>{},1000)', 'opencode');
  const sdk = path.join(f.root, 'opencode.mjs');
  await writeFile(sdk, `export function createOpencodeClient({baseUrl}){if(baseUrl!=='http://127.0.0.1:45678')throw Error('wrong server');return {session:{create:async()=>({data:{id:'opencode-native'}}),prompt:async(args,options)=>{if(!options.signal||!options.throwOnError)throw Error('missing cancellation');return {data:{parts:[{type:'text',text:JSON.stringify(args)}]}}},abort:async()=>{}}}}`);
  const config = { ...f.config, providers: { opencode: { ...f.config.providers.opencode, module: sdk } } };
  const manager = new AgentManager(f.sessions, f.state, config); t.after(() => manager.close());
  const record = await manager.run({ target: 'opencode', prompt: 'inspect', model: 'vendor/model', effort: 'high' }, f.ctx);
  const [done] = await manager.wait([record.id], 'alice', f.root, 12000); assert.equal(done.status, 'completed'); assert.equal(done.providerSessionId, 'opencode-native');
  const request = JSON.parse(done.response!); assert.deepEqual(request.model, { providerID: 'vendor', modelID: 'model' }); assert.equal(request.variant, 'high'); assert.equal(request.directory, done.cwd);
  assert.equal(f.sessions.list('alice', f.root).filter(session => session.status === 'running').length, 0);
});
