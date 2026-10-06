import { randomUUID } from 'node:crypto';
import { readNativeContext, stampNativeContext, writeNativeContext } from '../work/native-context.js';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalog } from '../skills/catalog.js';
import { addSession, transitionSession } from '../work/map.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import type { WorkSession } from '../work/types.js';
import type { McpContext } from './context.js';
import { createParleyServer } from './tools.js';
let project: string; let home: string; let work: string;
const open: Array<{ client: Client; server: ReturnType<typeof createParleyServer> }> = [];
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-search-home-'));
  project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-search-project-')));
  vi.stubEnv('PARLEY_HOME', home);
  work = (await createWork(project, { title: 'Search', goal: '' })).work.id;
  await updateMap(project, work, map => {
    addSession(map, { provider: 'codex', label: 'Own', task: 'Review' });
    addSession(map, { provider: 'claude', label: 'Other', task: 'Review' });
  });
});
afterEach(async () => {
  for (const pair of open.splice(0)) { await pair.client.close(); await pair.server.close(); }
  vi.unstubAllEnvs();
  await Promise.all([project, home].map(dir => rm(dir, { recursive: true, force: true })));
});
function catalog(provider: 'claude' | 'codex', cwd: string): SkillCatalog {
  return { provider, partial: false, diagnostics: [], skills: [
    { provider, documentKind: 'skill', name: 'review-code', description: 'Review code quality', source: 'project', path: path.join(cwd, 'SKILL.md'), modelAvailable: true, unavailableReason: null },
    { provider, documentKind: 'skill', name: 'hidden-review', description: 'Review review review', source: 'user', path: path.join(cwd, 'hidden.md'), modelAvailable: false, unavailableReason: 'human-disabled' },
  ] };
}
async function connect(overrides: Partial<McpContext> = {}) {
  const server = createParleyServer({ projectPath: project, workId: work, workDir: workPaths(project, work).dir,
    sessionId: 's-01', channel: false, ...overrides });
  const client = new Client({ name: 'isolated-search', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]); open.push({ client, server }); return client;
}
async function find(client: Client, args: Record<string, unknown> = { query: 'review' }) {
  const result = await client.callTool({ name: 'find_skill', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text };
}
describe('instance-local find_skill', () => {
  it('off is absent, direct call refuses and performs no native adapter work or binding mutation', async () => {
    const adapter = vi.fn(async () => catalog('codex', project));
    const client = await connect({ skillNavigator: false, skillCatalog: adapter });
    expect((await client.listTools()).tools.some(tool => tool.name === 'find_skill')).toBe(false);
    const before = await readFile(workPaths(project, work).map, 'utf8');
    const result = await client.callTool({ name: 'find_skill', arguments: { query: 'review' }, _meta: { threadId: 'SHOULD_NOT_BIND' } });
    expect(result.isError).toBe(true); expect(adapter).not.toHaveBeenCalled();
    expect(await readFile(workPaths(project, work).map, 'utf8')).toBe(before);
  });
  it('builds own Codex names once, shares a promise for concurrent calls and returns safe native load data', async () => {
    const adapter = vi.fn(async () => catalog('codex', project));
    const client = await connect({ skillNavigator: true, skillCatalog: adapter });
    const tool = (await client.listTools()).tools.find(item => item.name === 'find_skill')!;
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.description).toContain('review-code'); expect(tool.description).not.toContain('hidden-review');
    const results = await Promise.all([find(client), find(client)]);
    expect(adapter).toHaveBeenCalledTimes(1);
    const data = JSON.parse(results[0]!.text);
    expect(data.provider).toBe('codex'); expect(data.skills).toHaveLength(1);
    expect(data.skills[0]).toEqual({ name: 'review-code', description: 'Review code quality', source: 'project', load: `Read ${path.join(project, 'SKILL.md')}.` });
    expect(data.skills[0]).not.toHaveProperty('path');
  });
  it('keeps Claude lazy and caches per server instance and participant', async () => {
    const adapter = vi.fn(async (session: WorkSession) => catalog(session.provider as 'claude' | 'codex', project));
    const first = await connect({ sessionId: 's-02', skillNavigator: true, skillCatalog: adapter });
    await first.listTools(); expect(adapter).not.toHaveBeenCalled();
    expect(JSON.parse((await find(first)).text).skills[0].load).toContain('Skill tool');
    const second = await connect({ sessionId: 's-02', skillNavigator: true, skillCatalog: adapter });
    await find(second); expect(adapter).toHaveBeenCalledTimes(2);
  });
  it('permits closed target first-read current data and never substitutes a removed target cwd', async () => {
    const other = path.join(project, 'worktree'); await mkdir(other);
    await updateMap(project, work, map => {
      const session = map.sessions.find(item => item.id === 's-02')!;
      session.worktree = { path: other, branch: 'test', base: 'main', createdAt: 'now' };
      transitionSession(map, session.id, 'closed'); session.pid = null; session.startedAtProcess = 'last-launch';
    });
    const adapter = vi.fn(async (session: WorkSession) => ({ ...catalog(session.provider as 'claude' | 'codex', other), skills: [{ ...catalog(session.provider as 'claude' | 'codex', other).skills[0]!, description: 'CURRENT review metadata' }] }));
    const client = await connect({ skillNavigator: true, skillCatalog: adapter });
    const found = JSON.parse((await find(client, { query: 'review', for: 's-02' })).text);
    expect(found.provider).toBe('claude'); expect(found.skills[0].description).toBe('CURRENT review metadata');
    await rm(other, { recursive: true });
    const missing = JSON.parse((await find(client, { query: 'review', for: 's-02' })).text);
    expect(missing.skills).toEqual([]); expect(missing.reason).toContain('directory'); expect(adapter).toHaveBeenCalledTimes(1);
  });
  it('does not cache a pre-stamp unavailable result after the same actual launch becomes bound', async () => {
    const revision = randomUUID();
    await writeNativeContext(project, work, 's-02', { version: 1, revision, provider: 'claude', cwd: project,
      verified: false, configArgs: [], roots: { homeDir: home } });
    await updateMap(project, work, map => { map.sessions[1]!.pid = 42; map.sessions[1]!.startedAtProcess = 'actual'; });
    const adapter = vi.fn(async () => (await readNativeContext(project, work, 's-02'))?.process ? catalog('claude', project) : null);
    const client = await connect({ skillNavigator: true, skillCatalog: adapter });
    expect(JSON.parse((await find(client, { query: 'review', for: 's-02' })).text).skills).toEqual([]);
    await stampNativeContext(project, work, 's-02', { pid: 42, startedAtProcess: 'actual' }, revision);
    expect(JSON.parse((await find(client, { query: 'review', for: 's-02' })).text).skills).toHaveLength(1);
    expect(adapter).toHaveBeenCalledTimes(2);
  });
  it('rejects empty query and foreign membership, caps limit and returns the no-match message', async () => {
    const client = await connect({ skillNavigator: true, skillCatalog: async () => catalog('codex', project) });
    expect((await find(client, { query: '   ' })).result.isError).toBe(true);
    expect((await find(client, { query: 'review', for: 's-88' })).result.isError).toBe(true);
    expect((await find(client, { query: 'review', limit: 0 })).result.isError).toBe(true);
    const empty = JSON.parse((await find(client, { query: 'unrelated' })).text);
    expect(empty.skills).toEqual([]); expect(empty.message).toBe('No skill matched: work without one, or try other words once');
    expect(JSON.parse((await find(client, { query: 'review', limit: 99 })).text).skills.length).toBeLessThanOrEqual(10);
  });
  it('refuses an oversized query or target instead of cutting it', async () => {
    const client = await connect({ skillNavigator: true, skillCatalog: async () => catalog('codex', project) });
    const long = await find(client, { query: `review ${'x'.repeat(600)}` });
    expect(long.result.isError).toBe(true); expect(long.text).toContain('512');
    // Многобайтовые знаки считаются байтами: 300 кириллических букв — 600 байт.
    expect((await find(client, { query: 'я'.repeat(300) })).result.isError).toBe(true);
    expect((await find(client, { query: 'review', for: 's'.repeat(100) })).result.isError).toBe(true);
    expect((await find(client, { query: 'review' })).result.isError).not.toBe(true);
  });
  it('allows one correcting retry after no match, then refuses more until something is found', async () => {
    const client = await connect({ skillNavigator: true, skillCatalog: async () => catalog('codex', project) });
    const miss = async () => JSON.parse((await find(client, { query: 'unrelated' })).text).message;
    expect(await miss()).toContain('once');
    expect(await miss()).toContain('do not search for this task any more');
    expect(await miss()).toContain('do not search for this task any more');
    expect(JSON.parse((await find(client, { query: 'review' })).text).skills).toHaveLength(1);
    expect(await miss()).toContain('once');
  });
  it('marks a cut description and keeps the whole answer in budget, naming what was left out', async () => {
    const huge = Array.from({ length: 10 }, (_, index) => ({ provider: 'codex' as const, documentKind: 'skill' as const,
      name: `review-${index}-${'n'.repeat(900)}`, description: `review ${'long '.repeat(500)}`, source: 'project' as const,
      path: path.join(project, `${index}.md`), modelAvailable: true, unavailableReason: null }));
    const client = await connect({ skillNavigator: true, skillCatalog: async () => ({ provider: 'codex', partial: false, diagnostics: [], skills: huge }) });
    const found = JSON.parse((await find(client, { query: 'review', limit: 10 })).text);
    expect(found.skills.length).toBeGreaterThan(0);
    expect(found.skills[0].description).toMatch(/… \[cut: \d+ bytes in full\]$/);
    expect(found.omitted).toBe(10 - found.skills.length);
    expect(Buffer.byteLength(JSON.stringify(found.skills), 'utf8')).toBeLessThanOrEqual(8192);
  });
  it('missing bound context stays unavailable without native startup or raw diagnostic excerpts', async () => {
    const client = await connect({ skillNavigator: true });
    const found = JSON.parse((await find(client)).text);
    expect(found.skills).toEqual([]); expect(found.reason).toContain('unverified');
    // Провайдер вне семейств Claude Code и Codex маршрута не имеет.
    await updateMap(project, work, map => { map.sessions[0]!.provider = 'zcode'; });
    expect(JSON.parse((await find(client)).text).reason).toContain('no verified');
    expect((await readMap(project, work)).sessions[0]!.provider).toBe('zcode');
  });

  it('describes the reduced native list only in a confirmed mode, with names for Codex and the Claude names-only note', async () => {
    const descriptionOf = async (overrides: Partial<McpContext>) => (await (await connect(overrides)).listTools()).tools.find(tool => tool.name === 'find_skill')!.description!;
    const codex = (names = ['review-code']) => async () => ({ ...catalog('codex', project), skills: names.map(name => ({ ...catalog('codex', project).skills[0]!, name })) });
    // Full list: the description promises nothing about a reduction.
    expect(await descriptionOf({ skillNavigator: true, skillCatalog: codex() })).not.toContain('native skill list');
    const reduced = await descriptionOf({ skillNavigator: true, skillListReduced: true, skillCatalog: codex() });
    expect(reduced).toContain('native skill list is removed'); expect(reduced).toContain('"review-code"');
    // Names unreadable: the phrase stays, names are not invented.
    const noNames = await descriptionOf({ skillNavigator: true, skillListReduced: true, skillCatalog: async () => null });
    expect(noNames).toContain('names could not be read'); expect(noNames).not.toContain('Available native names');
    // Claude: names-only note in the confirmed mode, plain description otherwise.
    const claude = { sessionId: 's-02', skillNavigator: true, skillCatalog: async () => catalog('claude', project) };
    expect(await descriptionOf({ ...claude, skillListReduced: true })).toContain('shows names only');
    expect(await descriptionOf(claude)).not.toContain('names only');
  });

  it('caps the Codex name list with a truncation marker and the number of hidden names', async () => {
    const names = Array.from({ length: 400 }, (_, index) => `skill-${String(index).padStart(3, '0')}-with-a-rather-long-name`);
    const adapter = async () => ({ ...catalog('codex', project), skills: names.map(name => ({ ...catalog('codex', project).skills[0]!, name })) });
    const description = (await (await connect({ skillNavigator: true, skillListReduced: true, skillCatalog: adapter })).listTools()).tools.find(tool => tool.name === 'find_skill')!.description!;
    const list = description.slice(description.indexOf('Available native names:'));
    expect(list.length).toBeLessThan(3200);
    expect(list).toContain('"skill-000-with-a-rather-long-name"'); expect(list).not.toContain('skill-399');
    const hidden = Number(/and (\d+) more/.exec(list)?.[1]);
    expect(hidden).toBeGreaterThan(0); expect(list.split('", "').length + hidden).toBe(400);
    // A short list is shown whole, without a marker.
    const short = (await (await connect({ skillNavigator: true, skillCatalog: async () => catalog('codex', project) })).listTools()).tools.find(tool => tool.name === 'find_skill')!.description!;
    expect(short).not.toContain('more (');
  });

  describe('каталог Claude из транскрипта сессии', () => {
    const UUID = '0b8f1c52-3d0e-4f7a-9a61-2c5d7e8f9a10';
    const listing = (names: string[]) => JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: names.join('\n'), skillCount: names.length, isInitial: true, names } }) + '\n';
    let projects: string;
    beforeEach(async () => {
      projects = await mkdtemp(path.join(tmpdir(), 'parley-search-transcripts-'));
      await mkdir(path.join(projects, '-proj'));
      vi.stubEnv('PARLEY_CLAUDE_PROJECTS_DIR', projects);
      vi.stubEnv('HOME', home);
      vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      await updateMap(project, work, map => { map.sessions[1]!.providerSessionId = UUID; });
      const plugin = path.join(home, 'cache/superpowers');
      await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'superpowers' }));
      await mkdir(path.join(plugin, 'skills/writing-plans'), { recursive: true });
      await writeFile(path.join(plugin, 'skills/writing-plans/SKILL.md'), '---\ndescription: Use when you have a spec for a multi-step task\n---\n');
      await mkdir(path.join(home, '.claude/plugins'), { recursive: true });
      await writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'superpowers@market': [{ scope: 'user', installPath: plugin }] } }));
    });
    afterEach(() => rm(projects, { recursive: true, force: true }));
    const writeTranscript = (...names: string[]) => writeFile(path.join(projects, '-proj', `${UUID}.jsonl`), listing(names));

    it('own search returns descriptions from disk for names the engine listed, and explains a missing listing without caching it', async () => {
      const client = await connect({ sessionId: 's-02', skillNavigator: true, skillListReduced: true });
      const early = JSON.parse((await find(client, { query: 'implementation plan' })).text);
      expect(early.skills).toEqual([]); expect(early.reason).toContain('not readable');
      await writeTranscript('superpowers:writing-plans', 'simplify');
      const found = JSON.parse((await find(client, { query: 'write an implementation plan for a multi-step task' })).text);
      expect(found.provider).toBe('claude'); expect(found).not.toHaveProperty('reason');
      expect(found.skills[0]).toMatchObject({ name: 'superpowers:writing-plans', source: 'plugin', description: expect.stringContaining('multi-step task'), load: 'Use the Skill tool with "superpowers:writing-plans".' });
      // A listed name without a file on disk is returned without a description.
      const builtin = JSON.parse((await find(client, { query: 'simplify' })).text);
      expect(builtin.skills).toEqual([{ name: 'simplify', source: 'system', load: 'Use the Skill tool with "simplify".' }]);
    });

    it('GLM is the Claude Code family: its own search and a lead search with for read the Claude catalog from its transcript', async () => {
      await updateMap(project, work, map => { map.sessions[1]!.provider = 'glm'; });
      await writeTranscript('superpowers:writing-plans', 'simplify');
      const own = await connect({ sessionId: 's-02', skillNavigator: true, skillListReduced: true });
      const description = (await own.listTools()).tools.find(tool => tool.name === 'find_skill')!.description!;
      expect(description).toContain('shows names only');
      const found = JSON.parse((await find(own, { query: 'write an implementation plan for a multi-step task' })).text);
      expect(found).not.toHaveProperty('reason');
      expect(found.skills[0]).toMatchObject({ name: 'superpowers:writing-plans', source: 'plugin', description: expect.stringContaining('multi-step task'), load: 'Use the Skill tool with "superpowers:writing-plans".' });
      const lead = await connect({ sessionId: 's-01', skillNavigator: true });
      const viaFor = JSON.parse((await find(lead, { query: 'plan multi-step task', for: 's-02' })).text);
      expect(viaFor.skills.map((skill: { name: string }) => skill.name)).toEqual(['superpowers:writing-plans']);
      expect(viaFor).not.toHaveProperty('reason');
    });

    it('for: a lead searches the skills of a Claude participant by that participant transcript; a Codex participant keeps its own route', async () => {
      await writeTranscript('superpowers:writing-plans');
      const client = await connect({ sessionId: 's-01', skillNavigator: true });
      const found = JSON.parse((await find(client, { query: 'plan multi-step task', for: 's-02' })).text);
      expect(found.provider).toBe('claude'); expect(found.skills.map((skill: { name: string }) => skill.name)).toEqual(['superpowers:writing-plans']);
      // The lead is Codex without a verified native context: the old explanation stays.
      expect(JSON.parse((await find(client, { query: 'plan' })).text).reason).toContain('unverified');
    });
  });
});
