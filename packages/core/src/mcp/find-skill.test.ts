import { randomUUID } from 'node:crypto';
import { readNativeContext, stampNativeContext, writeNativeContext } from '../work/native-context.js';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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
    expect(empty.skills).toEqual([]); expect(empty.message).toBe('No skill matched: work without one, or try other words');
    expect(JSON.parse((await find(client, { query: 'review', limit: 99 })).text).skills.length).toBeLessThanOrEqual(10);
  });
  it('missing bound context stays unavailable without native startup or raw diagnostic excerpts', async () => {
    const client = await connect({ skillNavigator: true });
    const found = JSON.parse((await find(client)).text);
    expect(found.skills).toEqual([]); expect(found.reason).toContain('unverified');
    await updateMap(project, work, map => { map.sessions[0]!.provider = 'glm'; });
    expect(JSON.parse((await find(client)).text).reason).toContain('no verified');
    expect((await readMap(project, work)).sessions[0]!.provider).toBe('glm');
  });
});
