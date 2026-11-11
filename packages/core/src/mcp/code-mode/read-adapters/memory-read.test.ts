// Tests of the memory_read read adapter (plan T11 R1). Cases with a hand-built result check each rule of the decoder one property at a
// time; cases over the REAL `memory_read` handler (createToolRunner over a temporary work and project memory) decode what the producer
// made, so a drift in the handler fails here.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSession, transitionSession } from '../../../work/map.js';
import { addProjectMemory } from '../../../work/project-memory.js';
import { createWork, updateMap, workPaths } from '../../../work/store.js';
import { createToolRunner } from '../../tools.js';
import { INVALID_OUTPUT_CODES, type Decoded } from '../read-adapters.js';
import { READ_OUTPUT_SCHEMAS } from '../read-output-schemas.js';
import { MEMORY_ID_PATTERN, MEMORY_KIND_VALUES, MEMORY_READ_MAX_IDS, MEMORY_STATE_VALUES, decodeMemoryRead, selectMemoryReadRequest, type MemoryReadValue } from './memory-read.js';

const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const result = (body: unknown): unknown => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const entry = (id: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: 'fact', fact: `fact ${id}`, details: '', state: 'current', by: 'human', ...extra });
const ok = (d: Decoded<MemoryReadValue>): MemoryReadValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const invalidCode = (d: Decoded<MemoryReadValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};

describe('selectMemoryReadRequest', () => {
  it('is the empty call without arguments, and with ids when it is given', () => {
    expect(selectMemoryReadRequest(undefined)).toEqual({ ids: null });
    expect(selectMemoryReadRequest({})).toEqual({ ids: null });
    expect(selectMemoryReadRequest({ ids: undefined })).toEqual({ ids: null });
    expect(selectMemoryReadRequest({ ids: [] })).toEqual({ ids: [] });
    expect(selectMemoryReadRequest({ ids: ['m-001', 'm-1000'] })).toEqual({ ids: ['m-001', 'm-1000'] });
    expect(selectMemoryReadRequest({ ids: Array.from({ length: MEMORY_READ_MAX_IDS }, () => 'm-001') })).not.toBeNull();
  });
  it.each<[string, unknown]>([
    ['null', null], ['an array', []], ['a string', 'm-001'], ['an extra key', { ids: ['m-001'], limit: 1 }], ['ids null', { ids: null }],
    ['ids a string', { ids: 'm-001' }], ['101 ids', { ids: Array.from({ length: MEMORY_READ_MAX_IDS + 1 }, () => 'm-001') }],
    ['a short id', { ids: ['m-01'] }], ['an upper-case id', { ids: ['M-001'] }], ['a number id', { ids: [1] }], ['a trailing char', { ids: ['m-001x'] }],
  ])('has no success form for %s', (_name, args) => {
    expect(selectMemoryReadRequest(args)).toBeNull();
  });
  it('keeps the id pattern of the handler, and the schema the kinds and states of the decoder', () => {
    expect(MEMORY_ID_PATTERN.source).toBe('^m-\\d{3,}$');
    const value = (((READ_OUTPUT_SCHEMAS['memory_read']!['oneOf'] as Record<string, Record<string, unknown>>[])[0]!['properties'] as Record<string, Record<string, unknown>>)['value']!['properties']) as Record<string, Record<string, unknown>>;
    const entryProps = (value['items']!['items'] as Record<string, Record<string, Record<string, unknown>>>)['properties']!;
    expect(entryProps['kind']!['enum']).toEqual([...MEMORY_KIND_VALUES]);
    expect(entryProps['state']!['enum']).toEqual([...MEMORY_STATE_VALUES]);
  });
});

describe('decodeMemoryRead on a hand-built result', () => {
  it('lists every entry: complete, every field typed, unknown fields kept at both levels', () => {
    const d = decodeMemoryRead({}, result({ items: [entry('m-001', { onRequest: true, extra: { a: 1 } }), entry(null, { kind: 'lesson', state: 'superseded' })], total: 2, future: [1] }));
    const v = ok(d);
    expect(v.items).toHaveLength(2);
    expect(v.items[0]).toMatchObject({ id: 'm-001', kind: 'fact', by: 'human', onRequest: true, unknownFields: { extra: { a: 1 } } });
    expect(v.items[1]).toMatchObject({ id: null, kind: 'lesson', state: 'superseded', unknownFields: {} });
    expect(v.items[1]).not.toHaveProperty('onRequest');
    expect(v).not.toHaveProperty('truncated');
    expect(v.unknownFields).toEqual({ future: [1] });
    expect(d.assessment).toBe('complete');
  });
  it('truncated: true is the one mark of omission: partial', () => {
    const d = decodeMemoryRead({}, result({ items: [entry('m-001')], total: 3, truncated: true }));
    expect(ok(d)).toMatchObject({ total: 3, truncated: true });
    expect(d.assessment).toBe('partial');
  });
  it('zero entries are complete', () => {
    const d = decodeMemoryRead({}, result({ items: [], total: 0 }));
    expect(ok(d).items).toEqual([]);
    expect(d.assessment).toBe('complete');
  });
  it('ids: an unknown id is absent, not an error; the answer is complete', () => {
    const d = decodeMemoryRead({ ids: ['m-001', 'm-999', 'm-001'] }, result({ items: [entry('m-001')], total: 1 }));
    expect(ok(d).total).toBe(1);
    expect(d.assessment).toBe('complete');
  });
  it('a tool error keeps its whole original result, assessed unknown, and nothing of its text is read', () => {
    const error = { content: [{ type: 'text', text: 'Memory operation failed (memory-invalid).' }], isError: true };
    const d = decodeMemoryRead({ ids: ['m-1'] }, error);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: error } });
    expect(d.assessment).toBe('unknown');
  });

  it.each<[string, unknown, Record<string, unknown>, string]>([
    ['total below the entries shown', {}, { items: [entry('m-001'), entry('m-002')], total: 1 }, 'page-invariant'],
    ['fewer shown than matched without truncated', {}, { items: [entry('m-001')], total: 2 }, 'page-invariant'],
    ['truncated with every entry shown', {}, { items: [entry('m-001')], total: 1, truncated: true }, 'page-invariant'],
    ['a repeated id', {}, { items: [entry('m-001'), entry('m-001')], total: 2 }, 'page-invariant'],
    ['an id outside the request', { ids: ['m-001'] }, { items: [entry('m-002')], total: 1 }, 'echo-mismatch'],
    ['an entry without an id under ids', { ids: ['m-001'] }, { items: [entry(null)], total: 1 }, 'echo-mismatch'],
    ['more matches than distinct requested ids', { ids: ['m-001'] }, { items: [entry('m-001')], total: 2, truncated: true }, 'page-invariant'],
    ['truncated: false', {}, { items: [entry('m-001')], total: 1, truncated: false }, 'shape-mismatch'],
    ['an unknown kind', {}, { items: [entry('m-001', { kind: 'rule' })], total: 1 }, 'shape-mismatch'],
    ['an unknown state', {}, { items: [entry('m-001', { state: 'gone' })], total: 1 }, 'shape-mismatch'],
    ['onRequest: false', {}, { items: [entry('m-001', { onRequest: false })], total: 1 }, 'shape-mismatch'],
    ['a missing by', {}, { items: [{ id: 'm-001', kind: 'fact', fact: 'f', details: '', state: 'current' }], total: 1 }, 'shape-mismatch'],
    ['a negative total', {}, { items: [], total: -1 }, 'shape-mismatch'],
    ['items not an array', {}, { items: {}, total: 0 }, 'shape-mismatch'],
  ])('%s is invalid output, never an empty success', (_name, args, body, code) => {
    const d = decodeMemoryRead(args, result(body));
    expect(invalidCode(d)).toBe(code);
    expect(d.assessment).toBe('unknown');
    expect(INVALID_OUTPUT_CODES).toContain(code);
  });

  it('a request the handler refuses has no success form: unknown-request-branch', () => {
    expect(invalidCode(decodeMemoryRead({ ids: ['x'] }, result({ items: [], total: 0 })))).toBe('unknown-request-branch');
    expect(invalidCode(decodeMemoryRead({ limit: 1 }, result({ items: [], total: 0 })))).toBe('unknown-request-branch');
  });
  it('text that is not strict JSON and an envelope that is not one text item are fixed codes', () => {
    expect(invalidCode(decodeMemoryRead({}, { content: [{ type: 'text', text: '{"items":[],"items":[],"total":0}' }] }))).toBe('text-not-strict-json');
    expect(invalidCode(decodeMemoryRead({}, { content: [] }))).toBe('unexpected-envelope');
  });
});

describe('decodeMemoryRead on the real handler over a real temporary project memory', () => {
  let root: string;
  let project: string;
  let previousHome: string | undefined;
  let workId: string;
  let ids: string[];

  const runner = (work: string) => createToolRunner({ projectPath: project, workId: work, workDir: workPaths(project, work).dir, sessionId: 's-01', channel: false, providerRows: async () => [] });
  const raw = async (args: Record<string, unknown>, work = workId): Promise<unknown> => wire(await runner(work).call('memory_read', args, undefined));
  const decode = async (args: Record<string, unknown>, work = workId): Promise<Decoded<MemoryReadValue>> => decodeMemoryRead(args, await raw(args, work));
  const seedWork = async (title: string): Promise<string> => {
    const id = (await createWork(project, { title, goal: 'Memory fixtures' })).work.id;
    await updateMap(project, id, (map) => {
      transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead the fixtures' }).id, 'active');
    });
    return id;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-memory-read-'));
    project = path.join(root, 'project');
    await mkdir(project);
    previousHome = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = path.join(root, 'home');
    workId = await seedWork('Memory fixtures');
    ids = [];
    for (const [kind, fact, details] of [['fact', 'The build uses pnpm', 'Offline installs only'], ['lesson', 'Rebuild core before protocol', ''], ['agreement', 'Commits are in English', 'Per AGENTS.md']] as const) {
      ids.push((await addProjectMemory(project, { kind, fact, details })).id);
    }
    // An agent entry whose request flag is recorded: the handler reports `onRequest` and an agent author.
    const remembered = wire(await runner(workId).call('remember', { kind: 'fact', fact: 'The human asked to keep the lock FIFO', why: 'Said in the room', onHumanRequest: true }, undefined)) as { content: { text: string }[] };
    ids.push(/m-\d{3,}/.exec(remembered.content[0]!.text)![0]);
  });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it('every entry: complete, typed, human and agent authors, onRequest only where the request was claimed', async () => {
    const d = await decode({});
    const v = ok(d);
    // The memory file keeps its sections in order: facts, lessons, agreements.
    expect(v.items.map((i) => i.id)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
    expect(v.total).toBe(4);
    expect(v.items[0]).toMatchObject({ kind: 'fact', fact: 'The build uses pnpm', details: 'Offline installs only', state: 'current', by: 'human' });
    expect(v.items[1]).toMatchObject({ kind: 'fact', onRequest: true });
    expect(v.items[2]).toMatchObject({ kind: 'lesson', fact: 'Rebuild core before protocol' });
    expect(v.items[3]).toMatchObject({ kind: 'agreement' });
    expect(v.items[0]).not.toHaveProperty('onRequest');
    for (const item of v.items) expect(item.unknownFields).toEqual({});
    expect(v).not.toHaveProperty('truncated');
    expect(d.assessment).toBe('complete');
  });

  it('ids: only those, in memory order; an unknown id and a repeated id change nothing but the selection', async () => {
    const d = await decode({ ids: [ids[2]!, 'm-999', ids[0]!, ids[2]!] });
    expect(ok(d).items.map((i) => i.id)).toEqual([ids[0], ids[2]]);
    expect(ok(d).total).toBe(2);
    expect(d.assessment).toBe('complete');
    expect(ok(await decode({ ids: ['m-999'] })).items).toEqual([]);
    expect(ok(await decode({ ids: [] })).items).toEqual([]);
  });

  it('what the handler refuses is delivered as its original tool error, and no selector saw it', async () => {
    const cases: Record<string, unknown>[] = [{ ids: ['m-1'] }, { ids: Array.from({ length: 101 }, () => 'm-001') }, { limit: 3 }, { ids: 'm-001' }];
    for (const args of cases) {
      const r = await raw(args);
      expect((r as { isError?: boolean }).isError, JSON.stringify(args).slice(0, 40)).toBe(true);
      const d = decodeMemoryRead(args, r);
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: r } });
      expect(d.assessment).toBe('unknown');
    }
  });

  it('a project without memory answers zero entries, complete', async () => {
    const other = path.join(root, 'empty-project');
    await mkdir(other);
    const id = (await createWork(other, { title: 'Empty', goal: 'No memory' })).work.id;
    await updateMap(other, id, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead' }).id, 'active'); });
    const r = wire(await createToolRunner({ projectPath: other, workId: id, workDir: workPaths(other, id).dir, sessionId: 's-01', channel: false, providerRows: async () => [] }).call('memory_read', {}, undefined));
    const d = decodeMemoryRead({}, r);
    expect(ok(d)).toMatchObject({ items: [], total: 0 });
    expect(d.assessment).toBe('complete');
  });

  it('over 64 KiB the handler stops with truncated: true, and that alone is partial; the rest is reachable by ids', async () => {
    const big = path.join(root, 'big-project');
    await mkdir(big);
    const id = (await createWork(big, { title: 'Big', goal: 'Cut' })).work.id;
    await updateMap(big, id, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead' }).id, 'active'); });
    const added: string[] = [];
    for (let i = 0; i < 3; i++) added.push((await addProjectMemory(big, { kind: 'fact', fact: `Large entry ${i}`, details: `${i}`.repeat(30000) })).id);
    const call = async (args: Record<string, unknown>): Promise<unknown> =>
      wire(await createToolRunner({ projectPath: big, workId: id, workDir: workPaths(big, id).dir, sessionId: 's-01', channel: false, providerRows: async () => [] }).call('memory_read', args, undefined));
    const all = decodeMemoryRead({}, await call({}));
    expect(ok(all)).toMatchObject({ total: 3, truncated: true });
    expect(ok(all).items.length).toBeLessThan(3);
    expect(all.assessment).toBe('partial');
    const slice = decodeMemoryRead({ ids: [added[2]!] }, await call({ ids: [added[2]!] }));
    expect(ok(slice).items.map((i) => i.id)).toEqual([added[2]]);
    expect(slice.assessment).toBe('complete');
  });
});
