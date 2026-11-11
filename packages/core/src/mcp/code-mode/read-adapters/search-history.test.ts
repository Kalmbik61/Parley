// Tests of the search_history read adapter (plan T11 R1). Cases with a hand-built result check each rule of the decoder one property at a
// time; cases over the REAL `search_history` handler (createToolRunner over a temporary work and project) decode what the producer made.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBacklogItem } from '../../../work/backlog.js';
import { DEFAULT_SEARCH_LIMIT, HISTORY_SCOPES, MAX_SEARCH_LIMIT } from '../../../work/history-search.js';
import { addSession, transitionSession } from '../../../work/map.js';
import { addProjectMemory } from '../../../work/project-memory.js';
import { stateDir } from '../../../work/state-dir.js';
import { createWork, updateMap, workPaths } from '../../../work/store.js';
import { createToolRunner } from '../../tools.js';
import { INVALID_OUTPUT_CODES, type Decoded } from '../read-adapters.js';
import { READ_OUTPUT_SCHEMAS } from '../read-output-schemas.js';
import {
  DEFAULT_HISTORY_LIMIT, HISTORY_SCOPE_VALUES, HISTORY_SOURCE_VALUES, decodeSearchHistory, selectSearchHistoryRequest, type SearchHistoryValue,
} from './search-history.js';

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const result = (body: unknown): unknown => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const hit = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'memory', title: 'A title', excerpt: 'an excerpt', date: null, complete: true, length: 10, hash: '0123456789abcdef', ...extra,
});
const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  query: 'needle', scope: 'all', limit: 10, total: 1, hits: [hit()], unavailable: [], ...extra,
});
const ok = (d: Decoded<SearchHistoryValue>): SearchHistoryValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const invalidCode = (d: Decoded<SearchHistoryValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};
const ARGS = { query: 'needle' };

describe('the copies of the handler constants', () => {
  it('are equal to work/history-search.ts', () => {
    expect([...HISTORY_SCOPE_VALUES]).toEqual([...HISTORY_SCOPES]);
    expect([...HISTORY_SOURCE_VALUES]).toEqual(HISTORY_SCOPES.filter((s) => s !== 'all'));
    expect(DEFAULT_HISTORY_LIMIT).toBe(DEFAULT_SEARCH_LIMIT);
    expect(MAX_SEARCH_LIMIT).toBe(30);
  });
  it('the output schema names the same scopes and sources as the decoder', () => {
    const value = (((READ_OUTPUT_SCHEMAS['search_history']!['oneOf'] as Record<string, Record<string, unknown>>[])[0]!['properties'] as Record<string, Record<string, unknown>>)['value']!['properties']) as Record<string, Record<string, unknown>>;
    expect(value['scope']!['enum']).toEqual([...HISTORY_SCOPE_VALUES]);
    const hitProps = (value['hits']!['items'] as Record<string, Record<string, Record<string, unknown>>>)['properties']!;
    expect(hitProps['source']!['enum']).toEqual([...HISTORY_SOURCE_VALUES]);
  });
});

describe('selectSearchHistoryRequest', () => {
  it('takes the query, with the defaults of the handler for scope and limit', () => {
    expect(selectSearchHistoryRequest(ARGS)).toEqual({ query: 'needle', scope: 'all', limit: 10 });
    expect(selectSearchHistoryRequest({ query: 'a b', scope: 'memory', limit: 3 })).toEqual({ query: 'a b', scope: 'memory', limit: 3 });
    expect(selectSearchHistoryRequest({ query: 'x', scope: undefined, limit: undefined })).toEqual({ query: 'x', scope: 'all', limit: 10 });
  });
  it('is weaker than the handler on purpose: word count, length and the limit range stay with the handler', () => {
    expect(selectSearchHistoryRequest({ query: '', limit: 0 })).toEqual({ query: '', scope: 'all', limit: 0 });
    expect(selectSearchHistoryRequest({ query: 'x'.repeat(2000), limit: 99 })).not.toBeNull();
  });
  it.each<[string, unknown]>([
    ['no arguments', undefined], ['null', null], ['an array', []], ['no query', {}], ['a number query', { query: 1 }], ['an extra key', { query: 'x', offset: 1 }],
    ['an unknown scope', { query: 'x', scope: 'files' }], ['a number scope', { query: 'x', scope: 1 }], ['a string limit', { query: 'x', limit: '3' }],
  ])('has no success form for %s', (_name, args) => {
    expect(selectSearchHistoryRequest(args)).toBeNull();
  });
});

describe('decodeSearchHistory on a hand-built result', () => {
  it('a whole answer is complete; every field typed, unknown fields kept at all three levels', () => {
    const d = decodeSearchHistory(ARGS, result(body({ extra: 1, hits: [hit({ id: 'm-001', line: 4, file: '/p/memory.md', state: 'current', shared: true, alsoShared: true, more: [1] })] })));
    const v = ok(d);
    expect(v).toMatchObject({ query: 'needle', scope: 'all', limit: 10, total: 1, unavailable: [], unknownFields: { extra: 1 } });
    expect(v).not.toHaveProperty('message');
    expect(v.hits[0]).toMatchObject({ source: 'memory', id: 'm-001', line: 4, file: '/p/memory.md', state: 'current', shared: true, alsoShared: true, date: null, complete: true, length: 10, unknownFields: { more: [1] } });
    expect(d.assessment).toBe('complete');
  });
  it('zero hits carry the message, which is passed on and never read: complete', () => {
    const d = decodeSearchHistory(ARGS, result(body({ total: 0, hits: [], message: 'Nothing found: try fewer or other words.' })));
    expect(ok(d)).toMatchObject({ total: 0, hits: [], message: 'Nothing found: try fewer or other words.' });
    expect(d.assessment).toBe('complete');
    expect(ok(decodeSearchHistory(ARGS, result(body({ total: 0, hits: [], message: 'anything at all' })))).message).toBe('anything at all');
  });
  it('a hit whose excerpt is cut (complete: false) reaches the guest as it is, and does not make the run partial', () => {
    const d = decodeSearchHistory(ARGS, result(body({ hits: [hit({ complete: false, length: 5000 })] })));
    expect(ok(d).hits[0]).toMatchObject({ complete: false, length: 5000 });
    expect(d.assessment).toBe('complete');
  });
  it('the limit cut (total above the hits) is partial', () => {
    const d = decodeSearchHistory({ ...ARGS, limit: 2 }, result(body({ limit: 2, total: 5, hits: [hit(), hit({ title: 'B' })] })));
    expect(ok(d)).toMatchObject({ total: 5, limit: 2 });
    expect(d.assessment).toBe('partial');
  });
  it('a source that could not be read is partial, in any form, zero hits included', () => {
    expect(decodeSearchHistory(ARGS, result(body({ unavailable: ['memory'] }))).assessment).toBe('partial');
    const empty = decodeSearchHistory(ARGS, result(body({ total: 0, hits: [], message: 'm', unavailable: ['backlog', 'sessions'] })));
    expect(ok(empty).unavailable).toEqual(['backlog', 'sessions']);
    expect(empty.assessment).toBe('partial');
  });
  it('a single scope: its hits and its unavailable source are that scope', () => {
    const d = decodeSearchHistory({ ...ARGS, scope: 'memory' }, result(body({ scope: 'memory', unavailable: ['memory'] })));
    expect(d.assessment).toBe('partial');
  });
  it('a tool error keeps its whole original result, assessed unknown, and nothing of its text is read', () => {
    const error = { content: [{ type: 'text', text: 'Search request is invalid: give a non-empty query.' }], isError: true };
    const d = decodeSearchHistory({ query: '' }, error);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: error } });
    expect(d.assessment).toBe('unknown');
  });

  it.each<[string, unknown, Record<string, unknown>, string]>([
    ['a different query', ARGS, body({ query: 'other' }), 'echo-mismatch'],
    ['a different scope', ARGS, body({ scope: 'memory' }), 'echo-mismatch'],
    ['a different limit', ARGS, body({ limit: 5 }), 'echo-mismatch'],
    ['the default limit not echoed', ARGS, body({ limit: 11 }), 'echo-mismatch'],
    ['a hit of another source under a single scope', { ...ARGS, scope: 'memory' }, body({ scope: 'memory', hits: [hit({ source: 'plans' })] }), 'echo-mismatch'],
    ['an unavailable source outside the single scope', { ...ARGS, scope: 'memory' }, body({ scope: 'memory', unavailable: ['plans'] }), 'echo-mismatch'],
    ['more hits than the total', ARGS, body({ total: 0, hits: [hit()], message: 'm' }), 'page-invariant'],
    ['fewer hits than min(total, limit)', { ...ARGS, limit: 3 }, body({ total: 5, limit: 3, hits: [hit()] }), 'page-invariant'],
    ['more hits than the limit', { ...ARGS, limit: 1 }, body({ total: 3, limit: 1, hits: [hit(), hit(), hit()] }), 'page-invariant'],
    ['unavailable out of source order', ARGS, body({ unavailable: ['sessions', 'memory'] }), 'page-invariant'],
    ['unavailable with a repeat', ARGS, body({ unavailable: ['memory', 'memory'] }), 'page-invariant'],
    ['a message with hits', ARGS, body({ message: 'm' }), 'shape-mismatch'],
    ['no message with zero hits', ARGS, body({ total: 0, hits: [] }), 'shape-mismatch'],
    ['an unknown source in a hit', ARGS, body({ hits: [hit({ source: 'files' })] }), 'shape-mismatch'],
    ['an unknown source in unavailable', ARGS, body({ unavailable: ['files'] }), 'shape-mismatch'],
    ['a hash that is not 16 hex', ARGS, body({ hits: [hit({ hash: 'ABCDEF0123456789' })] }), 'shape-mismatch'],
    ['shared: false', ARGS, body({ hits: [hit({ shared: false })] }), 'shape-mismatch'],
    ['a string date that is a number', ARGS, body({ hits: [hit({ date: 5 })] }), 'shape-mismatch'],
    ['a negative length', ARGS, body({ hits: [hit({ length: -1 })] }), 'shape-mismatch'],
    ['hits not an array', ARGS, body({ hits: {} }), 'shape-mismatch'],
  ])('%s is invalid output, never an empty success', (_name, args, response, code) => {
    const d = decodeSearchHistory(args, result(response));
    expect(invalidCode(d)).toBe(code);
    expect(d.assessment).toBe('unknown');
    expect(INVALID_OUTPUT_CODES).toContain(code);
  });

  it('a request the handler refuses has no success form: unknown-request-branch', () => {
    expect(invalidCode(decodeSearchHistory({}, result(body())))).toBe('unknown-request-branch');
    expect(invalidCode(decodeSearchHistory({ query: 'x', scope: 'files' }, result(body())))).toBe('unknown-request-branch');
  });
  it('text that is not strict JSON and an envelope that is not one text item are fixed codes', () => {
    expect(invalidCode(decodeSearchHistory(ARGS, { content: [{ type: 'text', text: '{"query":"needle","query":"needle"}' }] }))).toBe('text-not-strict-json');
    expect(invalidCode(decodeSearchHistory(ARGS, { content: [] }))).toBe('unexpected-envelope');
  });
});

describe('decodeSearchHistory on the real handler over a real temporary project', () => {
  let root: string;
  let project: string;
  let previousHome: string | undefined;
  let workId: string;

  const runner = (projectPath: string, work: string) => createToolRunner({ projectPath, workId: work, workDir: workPaths(projectPath, work).dir, sessionId: 's-01', channel: false, providerRows: async () => [] });
  const raw = async (args: Record<string, unknown>, projectPath = project, work = workId): Promise<unknown> => wire(await runner(projectPath, work).call('search_history', args, undefined));
  const decode = async (args: Record<string, unknown>, projectPath = project, work = workId): Promise<Decoded<SearchHistoryValue>> => decodeSearchHistory(args, await raw(args, projectPath, work));
  const newWork = async (projectPath: string, summary?: string): Promise<string> => {
    const id = (await createWork(projectPath, { title: 'History fixtures', goal: 'Search fixtures' })).work.id;
    await updateMap(projectPath, id, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'lead', task: 'Lead the fixtures' });
      transitionSession(map, session.id, 'active');
      if (summary !== undefined) map.sessions.find((s) => s.id === session.id)!.summary = summary;
    });
    return id;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-search-history-'));
    project = path.join(root, 'project');
    await mkdir(project);
    previousHome = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = path.join(root, 'home');
    workId = await newWork(project, `Finished the zebra migration. ${'Long summary. '.repeat(60)}`);
    await addProjectMemory(project, { kind: 'fact', fact: 'The zebra index is rebuilt nightly', details: 'Owner is the platform team' });
    await addProjectMemory(project, { kind: 'lesson', fact: 'Never cache the quokka list', details: '' });
    for (let i = 0; i < 3; i++) await addBacklogItem(project, { title: `Backlog marmot ${i}`, details: 'Detail text' });
  });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it('hits across sources: typed, echoed, complete; a cut excerpt keeps its own complete: false', async () => {
    const d = await decode({ query: 'zebra' });
    const v = ok(d);
    expect(v).toMatchObject({ query: 'zebra', scope: 'all', limit: 10, unavailable: [] });
    expect(v.total).toBe(2);
    expect(v.hits.map((h) => h.source).sort()).toEqual(['memory', 'sessions']);
    const memory = v.hits.find((h) => h.source === 'memory')!;
    expect(memory).toMatchObject({ title: 'The zebra index is rebuilt nightly', state: 'current', complete: true, date: null });
    expect(memory.id).toMatch(/^m-\d{3,}$/);
    const session = v.hits.find((h) => h.source === 'sessions')!;
    expect(session.complete).toBe(false);
    for (const h of v.hits) expect(h.unknownFields).toEqual({});
    expect(d.assessment).toBe('complete');
  });

  it('scope and limit are echoed; a single scope keeps only its source', async () => {
    const d = await decode({ query: 'marmot', scope: 'backlog', limit: 5 });
    expect(ok(d)).toMatchObject({ scope: 'backlog', limit: 5, total: 3 });
    expect(ok(d).hits.every((h) => h.source === 'backlog')).toBe(true);
    expect(d.assessment).toBe('complete');
  });

  it('the limit cut: total above the hits is partial', async () => {
    const d = await decode({ query: 'marmot', limit: 2 });
    expect(ok(d)).toMatchObject({ total: 3, limit: 2 });
    expect(ok(d).hits).toHaveLength(2);
    expect(d.assessment).toBe('partial');
  });

  it('zero hits carry the handler message and are complete', async () => {
    const d = await decode({ query: 'nothing-matches-this-word' });
    expect(ok(d)).toMatchObject({ total: 0, hits: [], unavailable: [] });
    expect(typeof ok(d).message).toBe('string');
    expect(d.assessment).toBe('complete');
  });

  it('a source that cannot be read is named in unavailable and the result is partial', async () => {
    const broken = path.join(root, 'broken-project');
    await mkdir(broken);
    const id = await newWork(broken);
    await mkdir(stateDir(broken), { recursive: true });
    await writeFile(path.join(stateDir(broken), 'memory.md'), '<<<<<<< ours\n# Memory\n=======\n# Other\n>>>>>>> theirs\n');
    const d = await decode({ query: 'zebra', scope: 'memory' }, broken, id);
    expect(ok(d)).toMatchObject({ scope: 'memory', total: 0, unavailable: ['memory'] });
    expect(d.assessment).toBe('partial');
  });

  it('what the handler refuses is delivered as its original tool error, and no selector saw it', async () => {
    const cases: Record<string, unknown>[] = [{ query: '' }, { query: 'x', scope: 'files' }, { query: 'x', limit: 99 }, { query: 'x', limit: 1.5 }, { query: Array.from({ length: 17 }, (_, i) => `w${i}`).join(' ') }];
    for (const args of cases) {
      const r = await raw(args);
      expect((r as { isError?: boolean }).isError, JSON.stringify(args).slice(0, 50)).toBe(true);
      const d = decodeSearchHistory(args, r);
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: r } });
      expect(d.assessment).toBe('unknown');
    }
  });
});
