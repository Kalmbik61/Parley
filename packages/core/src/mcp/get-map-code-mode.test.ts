// `get_map` through the real MCP server carries the Code Mode label of each session row (plan T12a-indicator): overview, collection
// pages and the one-session detail, all read from the work directory's own files. Display only; a missing file is `unknown`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeExposureRecord } from './code-mode/exposure-record.js';
import { launchDecisionPath, writeLaunchDecision } from './code-mode/launch-decision.js';
import { addSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { createParleyServer } from './tools.js';

let home = '';
let project = '';
let workId = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];
const NONCE = 'b'.repeat(32);

async function connect(sessionId: string): Promise<Client> {
  const server = createParleyServer({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId, pollMs: 40, channel: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
async function getMap(client: Client, args: Record<string, unknown> = {}): Promise<Doc> {
  const result = await client.callTool({ name: 'get_map', arguments: args });
  const content = result.content as { text?: string }[];
  expect(result.isError, content[0]?.text).not.toBe(true);
  return JSON.parse(content[0]?.text ?? '{}') as Doc;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'W', goal: 'g' })).work.id;
  await updateMap(project, workId, (map) => { for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' }); });
  const dir = workPaths(project, workId).dir;
  writeLaunchDecision(dir, 's-02', { v: 1, nonce: null, effective: 'classic', requested: true, reason: 'not-requested', provider: 'claude', at: '2026-11-09T00:00:00.000Z' });
  writeLaunchDecision(dir, 's-03', { v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z' });
  writeExposureRecord(dir, 's-03', { v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: 'l', nonce: NONCE } as never);
});
afterEach(async () => {
  for (const { client, server } of opened.splice(0)) { await client.close(); await server.close(); }
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const UNKNOWN = { mode: 'unknown', reason: null };
const labels = (rows: { id: string; codeMode?: unknown }[]) => Object.fromEntries(rows.map((row) => [row.id, row.codeMode]));

describe('get_map carries codeMode on session rows', () => {
  it('overview, collection page and one-session detail show the same three states', async () => {
    const client = await connect('s-01');
    // Rows (overview and pages) carry the bare mode word; the one-session detail carries the reason as well.
    const rowsWant = { 's-01': 'unknown', 's-02': 'classic', 's-03': 'code-mode' };
    const detailWant = { 's-01': UNKNOWN, 's-02': { mode: 'classic', reason: 'not-requested' }, 's-03': { mode: 'code-mode', reason: null } };
    expect(labels((await getMap(client)).map.sessions)).toEqual(rowsWant);
    expect(labels((await getMap(client, { field: 'sessions' })).items)).toEqual(rowsWant);
    for (const [id, state] of Object.entries(detailWant)) expect((await getMap(client, { session: id })).session.codeMode).toEqual(state);
    expect(JSON.stringify((await getMap(client, { field: 'sessions' })).items)).not.toContain('not-requested');
  });

  it('other collections and other session fields are unchanged', async () => {
    const client = await connect('s-01');
    expect(JSON.stringify((await getMap(client, { field: 'rooms' })).items)).not.toContain('codeMode');
    const task = await getMap(client, { session: 's-02', field: 'task' });
    expect(JSON.stringify(task)).not.toContain('codeMode');
  });

  it('a decision that cannot be read leaves the page whole and the row unknown', async () => {
    const client = await connect('s-01');
    await rm(path.join(workPaths(project, workId).dir, 'code-mode'), { recursive: true, force: true });
    const page = await getMap(client, { field: 'sessions' });
    expect(page.items).toHaveLength(3);
    expect(labels(page.items)).toEqual({ 's-01': 'unknown', 's-02': 'unknown', 's-03': 'unknown' });
  });
});

describe('the reader stays a reader (s-296 R1 conditions)', () => {
  it('a FIFO at one session\'s decision path: the page still returns, that row reads unknown, nothing hangs', async () => {
    const dir = workPaths(project, workId).dir;
    await rm(launchDecisionPath(dir, 's-02'), { force: true });
    execFileSync('mkfifo', [launchDecisionPath(dir, 's-02')]);
    const client = await connect('s-01');
    const page = await getMap(client, { field: 'sessions' });
    expect(labels(page.items)).toEqual({ 's-01': 'unknown', 's-02': 'unknown', 's-03': 'code-mode' });
    expect((await getMap(client, { session: 's-02' })).session.codeMode).toEqual(UNKNOWN);
  }, 15_000);

  const here = path.dirname(fileURLToPath(import.meta.url));
  /** The static import graph of a source file, as the R1 test walks it (dynamic `import()` is not an edge). */
  const staticGraph = (start: string): string[] => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\b[^'"\n;]*(?:\n[^'"\n;]*)*?from\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(file), (m[1] ?? m[2]!).replace(/\.js$/, '.ts'));
        walk(target);
      }
    };
    walk(start);
    return [...seen].map((f) => path.relative(here, f));
  };

  it('mode-state reaches only the readers: never the helper, broker, guest, scheduler or native policy', () => {
    const graph = staticGraph(path.join(here, 'code-mode/mode-state.ts'));
    expect(graph).toEqual(expect.arrayContaining(['code-mode/mode-state.ts', 'code-mode/launch-decision.ts', 'code-mode/exposure-record.ts']));
    for (const banned of ['helper', 'broker', 'guest', 'scheduler', 'native-policy']) {
      expect(graph.filter((f) => path.basename(f).startsWith(banned)), banned).toEqual([]);
    }
  });

  it('tools.ts reaches mode-state by a dynamic import only: a classic start loads nothing of Code Mode through it', () => {
    const text = readFileSync(path.join(here, 'tools.ts'), 'utf8');
    expect(text).toMatch(/await import\('\.\/code-mode\/mode-state\.js'\)/);
    expect(text).not.toMatch(/^(?:import|export)\b[^'"\n;]*from\s+['"]\.\/code-mode\/mode-state\.js['"]/m);
    expect(staticGraph(path.join(here, 'tools.ts')).filter((f) => f.endsWith('code-mode/mode-state.ts'))).toEqual([]);
  });
});
