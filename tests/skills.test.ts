import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import plugin, { type SkillsService } from '../src/plugins/skills.js';
import type { PluginContext, ToolContext, ToolDefinition } from '../src/core/types.js';

test('rules follow scope order and skill resources remain confined to their skill directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-skills-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await mkdir(path.join(root, '.agents/skills/design/resources'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'root rules');
  await writeFile(path.join(root, 'nested/CLAUDE.md'), 'nested rules');
  await writeFile(path.join(root, '.agents/skills/design/SKILL.md'), '---\nname: design\ndescription: Design a careful UI\n---\nSkill instructions');
  await writeFile(path.join(root, '.agents/skills/design/resources/guide.md'), 'supporting text');
  await symlink(path.join(root, 'AGENTS.md'), path.join(root, '.agents/skills/design/shortcut'));
  let service: SkillsService;
  await plugin.setup({ workspace: root, stateDir: path.join(root, '.capyra'), config: { paths: [] }, provide(_name, value) { service = value as SkillsService; }, service() { throw new Error('unused'); }, registerTool() { return () => {}; }, onDispose() {}, onEvent() {}, guard() {} } as PluginContext);
  const signal = new AbortController().signal;
  const found = await service!.discover(root, signal);
  assert.equal(found.skills[0]?.name, 'design');
  assert.equal(found.skills[0]?.description, 'Design a careful UI');
  assert.deepEqual((await service!.rules(root, 'nested/new.ts', signal)).map(rule => rule.content), ['root rules', 'nested rules']);
  assert.deepEqual((await service!.rules(root, 'new.ts', signal)).map(rule => rule.content), ['root rules']);
  const id = found.skills[0]!.id;
  assert.equal((await service!.read(root, id, signal, 'resources/guide.md')).content, 'supporting text');
  await assert.rejects(service!.read(root, id, signal, '../../../AGENTS.md'), /traversal/);
  await assert.rejects(service!.read(root, id, signal, 'shortcut'), /Symbolic/);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capyra-skill-policy-'));
  const globals = path.join(root, 'user-skills'); await mkdir(globals);
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map<string, ToolDefinition>(); let service: SkillsService;
  const context: PluginContext = { workspace: root, stateDir: path.join(root, '.capyra'), config: { paths: [globals] }, provide(_name, value) { service = value as SkillsService; }, service() { throw new Error('unused'); }, registerTool(tool) { tools.set(tool.name, tool); return () => {}; }, onDispose() {}, onEvent() {}, guard() {} };
  await plugin.setup(context);
  const ctx: ToolContext = { workspace: root, owner: 'remote-alice', taskId: 'test', signal: new AbortController().signal, progress() {} };
  async function skill(name: string, contents: string, base = path.join(root, '.agents/skills')) {
    const directory = path.join(base, name); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'SKILL.md'), contents); return directory;
  }
  return { root, globals, context, ctx, tools, service: () => service!, skill };
}
const manifest = (name: string, extra = '') => `---\nname: ${name}\ndescription: A useful ${name} workflow\n${extra}---\n${name} instructions`;

test('model-disabled skills remain available to trusted local use without a caller-supplied audience override', async t => {
  const f = await fixture(t); await f.skill('visible', manifest('visible'));
  const folder = await f.skill('manual', manifest('manual-secret', 'disable-model-invocation: true\n'));
  await writeFile(path.join(folder, 'guide.md'), 'MANUAL_SUPPORTING_CONTENT');
  const model = await f.service().discover(f.root, f.ctx.signal);
  assert.deepEqual(model.skills.map(skill => skill.name), ['visible']); assert.doesNotMatch(JSON.stringify(model), /manual|secret/);
  const local = await f.service().discover(f.root, f.ctx.signal, { audience: 'local' });
  const disabled = local.skills.find(skill => skill.name === 'manual-secret')!; assert.equal(disabled.disableModelInvocation, true);
  await assert.rejects(f.service().read(f.root, disabled.id, f.ctx.signal), /unavailable/);
  await assert.rejects(f.tools.get('read')!.execute({ id: disabled.id, resource: 'guide.md', audience: 'local' }, f.ctx), /unavailable/);
  const localResult = await f.tools.get('read')!.execute({ id: disabled.id, resource: 'guide.md' }, { ...f.ctx, owner: 'local-console' });
  assert.match((localResult.content[0] as any).text, /MANUAL_SUPPORTING_CONTENT/);
  const attemptedOverride = await f.tools.get('discover')!.execute({ audience: 'local' }, f.ctx); assert.doesNotMatch(JSON.stringify(attemptedOverride), /manual-secret/);
  const localCatalog = await f.tools.get('discover')!.execute({}, { ...f.ctx, owner: 'local-console' }); assert.match(JSON.stringify(localCatalog), /manual-secret/);
  assert.equal(f.tools.get('discover')!.inputSchema.additionalProperties, false);
});

test('frontmatter parses quoted and block strings, diagnoses malformed input, and never defaults malformed invocation flags to enabled', async t => {
  const f = await fixture(t);
  await f.skill('folded', '---\r\nname: folded\r\ndescription: >-\r\n  A careful workflow\r\n  across lines.\r\nmetadata:\r\n  short-description: Extra metadata\r\ndisable-model-invocation: FALSE # explicit\r\n---\r\nBody');
  await f.skill('quoted', "---\nname: quoted\ndescription: 'It''s useful # literally.'\n---\nBody");
  await f.skill('fallback', '---\ndescription: Fallback folder name\n---\nBody');
  await f.skill('unusual', manifest('UpperCase'));
  const invalid = [
    '---\nname: bad',
    '---\nname: bad\n---\nNo description',
    '---\nname: bad\ndescription: true\n---\nBody',
    manifest('bad', 'disable-model-invocation: "true"\n'),
    manifest('bad', 'disable-model-invocation:\n'),
    manifest('bad', 'disable-model-invocation: false\ndisable-model-invocation: true\n'),
    manifest('bad', 'disableModelInvocation: true\n'),
    '---\nname: bad\ndescription: Text\n  disable-model-invocation: true\n---\nBody',
    '---\nname: bad\ndescription: "unterminated\n---\nBody',
    '---\nname: bad\ndescription: *alias\n---\nBody',
  ];
  for (const [index, text] of invalid.entries()) await f.skill(`invalid-${index}`, text);
  const found = await f.service().discover(f.root, f.ctx.signal);
  assert.deepEqual(found.skills.map(skill => skill.name).sort(), ['UpperCase', 'fallback', 'folded', 'quoted'].sort());
  assert.equal(found.skills.find(skill => skill.name === 'folded')?.description, 'A careful workflow across lines.');
  assert.equal(found.skills.find(skill => skill.name === 'quoted')?.description, "It's useful # literally.");
  assert.ok(found.diagnostics.some(message => message.includes('lowercase')));
  const local = await f.service().discover(f.root, f.ctx.signal, { audience: 'local' });
  assert.equal(local.diagnostics.filter(message => message.includes('invalid-')).length, invalid.length);
  assert.ok(local.diagnostics.some(message => message.includes('Duplicate frontmatter field')));
  assert.ok(local.diagnostics.some(message => message.includes('without quotes')));
  const fallback = found.skills.find(skill => skill.name === 'fallback')!; assert.match((await f.service().read(f.root, fallback.id, f.ctx.signal)).content, /Fallback folder/);
});

test('same-name resolution is deterministic, duplicate files are deduplicated, and local users can inspect shadowed entries', async t => {
  const f = await fixture(t);
  await f.skill('first', manifest('same')); await f.skill('second', manifest('same'), f.globals);
  const model = await f.service().discover(f.root, f.ctx.signal);
  assert.equal(model.skills.length, 1); assert.equal(model.skills[0]?.source, '.agents/skills');
  assert.ok(model.diagnostics.some(message => message.includes('collision') && message.includes('global-0:second')));
  const local = await f.service().discover(f.root, f.ctx.signal, { audience: 'local' });
  const shadowed = local.skills.find(skill => skill.shadowedBy)!; assert.equal(shadowed.shadowedBy, model.skills[0]?.id);
  await assert.rejects(f.service().read(f.root, shadowed.id, f.ctx.signal), /unavailable/);
  assert.match((await f.service().read(f.root, shadowed.id, f.ctx.signal, undefined, { audience: 'local' })).content, /same instructions/);
  await writeFile(path.join(f.root, '.agents/skills/first/SKILL.md'), manifest('same', 'disable-model-invocation: true\n'));
  const hiddenWinner = await f.service().discover(f.root, f.ctx.signal); assert.equal(hiddenWinner.skills.length, 0); assert.doesNotMatch(JSON.stringify(hiddenWinner), /same|first|second/);
  await writeFile(path.join(f.root, '.agents/skills/first/SKILL.md'), manifest('same'));
  f.context.config.paths = [path.join(f.root, '.agents/skills')]; await plugin.setup(f.context);
  const deduplicated = await f.service().discover(f.root, f.ctx.signal); assert.equal(deduplicated.skills.length, 1); assert.equal(deduplicated.diagnostics.length, 0);
});

test('invocation policy changes are rechecked when reading a previously discovered ID', async t => {
  const f = await fixture(t); const directory = await f.skill('changeable', manifest('changeable'));
  const id = (await f.service().discover(f.root, f.ctx.signal)).skills[0]!.id;
  await writeFile(path.join(directory, 'SKILL.md'), manifest('changeable', 'disable-model-invocation: true\n'));
  await assert.rejects(f.service().read(f.root, id, f.ctx.signal), /unavailable/);
  assert.match((await f.service().read(f.root, id, f.ctx.signal, undefined, { audience: 'local' })).content, /changeable instructions/);
});

test('discovery stops inside a skill directory and skips archived roots before scanning their contents', async t => {
  const f = await fixture(t); const active = await f.skill('active', manifest('active'));
  await f.skill('resources/nested', manifest('should-not-be-another-skill'), active);
  const archived = await f.skill('archive/private', manifest('ARCHIVED_SECRET'));
  await chmod(path.dirname(archived), 0o000);
  try {
  await writeFile(path.join(f.globals, 'direct.md'), manifest('direct-file'));
  const found = await f.service().discover(f.root, f.ctx.signal);
  assert.deepEqual(found.skills.map(skill => skill.name), ['active', 'direct-file']); assert.doesNotMatch(JSON.stringify(found), /ARCHIVED|nested/);
  const direct = found.skills.find(skill => skill.name === 'direct-file')!; assert.match((await f.service().read(f.root, direct.id, f.ctx.signal)).content, /direct-file/);
  await assert.rejects(f.service().read(f.root, 'project-0:archive/private/SKILL.md', f.ctx.signal), /Archived|unavailable/);
  await assert.rejects(plugin.setup({ ...f.context, config: { paths: [path.join(f.root, 'archive-never-scan')] } }), /Archived/);
  } finally { await chmod(path.dirname(archived), 0o700); }
});

test('directory ignore files prune excluded skills and support explicit file re-inclusion without reading ignored directories', async t => {
  const f = await fixture(t);
  const base = path.join(f.root, '.agents/skills'); await f.skill('active', manifest('active'));
  const ignored = await f.skill('retired/private', manifest('IGNORED_PRIVATE'));
  await writeFile(path.join(base, '.gitignore'), 'retired/\n*.md\n!SKILL.md\n');
  await writeFile(path.join(base, 'ignored.md'), manifest('ignored-root-file'));
  await writeFile(path.join(base, 'keep.md'), manifest('keep'));
  await writeFile(path.join(base, '.ignore'), '!keep.md\n');
  await chmod(path.dirname(ignored), 0o000);
  try {
    const found = await f.service().discover(f.root, f.ctx.signal);
    assert.deepEqual(found.skills.map(skill => skill.name), ['active', 'keep']); assert.doesNotMatch(JSON.stringify(found), /IGNORED_PRIVATE|ignored-root-file/);
    await assert.rejects(f.service().read(f.root, 'project-0:retired/private/SKILL.md', f.ctx.signal), /unavailable/);
  } finally { await chmod(path.dirname(ignored), 0o700); }
});
