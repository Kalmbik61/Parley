// Tests of the get_map read adapter (plan T6-get_map). Positive cases run the REAL `get_map` handler (createToolRunner over a
// temporary work) and decode what it produced, so a drift in the producer fails here; negative cases corrupt those real
// outputs one property at a time. Nothing is mocked except the provider rows the host would supply.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBacklogItem, completeBacklogItem } from '../../work/backlog.js';
import { suggestBacklog } from '../../work/backlog-suggestions.js';
import { boardMove, boardTake } from '../../work/board.js';
import { READ_GUIDE_MAX_BYTES, contextBytes } from '../../work/context-budget.js';
import { GUIDE_TOPICS } from '../../work/guide.js';
import { addSession, transitionSession } from '../../work/map.js';
import { setBacklogRule } from '../../work/project-preferences.js';
import { addRoom } from '../../work/rooms.js';
import { createWork, updateMap, workPaths } from '../../work/store.js';
import { HUMAN, type RoomPlan } from '../../work/types.js';
import type { McpContext } from '../context.js';
import { writeLaunchDecision } from './launch-decision.js';
import { READ_OUTPUT_SCHEMAS } from './read-output-schemas.js';
import type { ProviderRow } from '../provider-rows.js';
import { BUILTIN_ROLES } from '../../roles/builtin.js';
import { buildRoleCatalog } from '../../roles/catalog.js';
import { discoverClaudeRoles } from '../../roles/claude.js';
import { discoverCodexRoles } from '../../roles/codex.js';
import type { RoleCatalog } from '../../roles/types.js';
import { boundedGuide, createParleyServer, createToolRunner } from '../tools.js';
import {
  GET_MAP_BRANCHES,
  GUIDE_TOPIC_VALUES,
  INVALID_OUTPUT_CODES,
  READ_GUIDE_MAX_CONTEXT_BYTES,
  decodeBacklogList,
  decodeGetMap,
  decodeListRoles,
  decodeReadGuide,
  decodeReadRoom,
  isListRolesRequest,
  joinAssessment,
  selectBacklogListRequest,
  selectGetMapBranch,
  selectReadGuideRequest,
  selectReadRoomRequest,
  unwrapMcpResult,
  type Assessment,
  type BacklogListValue,
  type Decoded,
  type GetMapBranch,
  type GetMapValue,
  type ListRolesValue,
  type ReadGuideValue,
  type ReadRoomValue,
} from './read-adapters.js';

let root: string;
let project: string;
let previousHome: string | undefined;
let base: Scenario;

interface Scenario {
  workId: string;
  /** Runs the real handler and returns the strict MCP result exactly as it would cross the wire. */
  call(args: Record<string, unknown>): Promise<unknown>;
  /** Real handler + decoder. */
  decode(args: Record<string, unknown>): Promise<Decoded<GetMapValue>>;
  /** Any tool of the real handler, optionally as another session of the work. */
  tool(name: string, args: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

// A parsed JSON document the tests corrupt one property at a time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]!).text;
const withText = (result: unknown, text: string): unknown => ({ ...(result as object), content: [{ type: 'text', text }] });
const mutateJson = (result: unknown, change: (json: Doc) => void): unknown => {
  const json = JSON.parse(textOf(result)) as Doc;
  change(json);
  return withText(result, JSON.stringify(json));
};

const rows: ProviderRow[] = [
  { id: 'claude', label: 'Claude', family: 'claude', available: true, needs: null, models: null, effort: true, limits: null },
  { id: 'codex', label: 'Codex', family: 'codex', available: false, needs: 'sign-in', models: null, effort: false, limits: null },
];

/** A temporary work in the shared project with the caller s-01; `seed` adds whatever the case needs. */
async function scenario(title: string, seed: (map: Parameters<Parameters<typeof updateMap>[2]>[0], letters: Parameters<Parameters<typeof updateMap>[2]>[1]) => void, goal = 'Short goal', providerRows?: McpContext['providerRows']): Promise<Scenario> {
  const workId = (await createWork(project, { title, goal })).work.id;
  await updateMap(project, workId, (map, letters) => {
    transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead the adapter fixtures' }).id, 'active');
    addSession(map, { provider: 'claude', label: 'worker', task: 'Do the work' });
    addRoom(map, { title: 'Fixtures room', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
    seed(map, letters);
  });
  const context: McpContext = {
    projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false,
    providerRows: providerRows ?? (async () => rows),
  };
  const runner = createToolRunner(context);
  const call = async (args: Record<string, unknown>): Promise<unknown> => wire(await runner.call('get_map', args, undefined));
  const tool = async (name: string, args: Record<string, unknown>, sessionId = 's-01'): Promise<unknown> =>
    wire(await createToolRunner({ ...context, sessionId }).call(name, args, undefined));
  return { workId, call, decode: async (args) => decodeGetMap(args, await call(args)), tool };
}

const ok = (d: Decoded<GetMapValue>): GetMapValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const branchOf = <B extends GetMapBranch>(d: Decoded<GetMapValue>, branch: B): Extract<GetMapValue, { branch: B }> => {
  const value = ok(d);
  expect(value.branch).toBe(branch);
  return value as Extract<GetMapValue, { branch: B }>;
};
const invalidCode = (d: Decoded<GetMapValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-read-adapters-'));
  project = path.join(root, 'project');
  await mkdir(project);
  previousHome = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  base = await scenario('Adapter fixtures', (map, letters) => {
    const lead = map.sessions.find((s) => s.id === 's-01')!;
    for (let i = 0; i < 25; i++) {
      lead.artifacts.push({ kind: 'file', path: `out/${'d'.repeat(70)}/file-${i}.txt` });
      lead.history.push({ event: 'active', at: new Date(Date.UTC(2026, 10, 8, 0, i)).toISOString() });
    }
    const worker = map.sessions.find((s) => s.id === 's-02')!;
    worker.summary = 'Worker summary';
    worker.summarySource = 'agent';
    worker.artifacts.push({ kind: 'file', path: 'only.txt' });
    for (let i = 0; i < 7; i++) letters.add({ roomId: 'r-01', from: 's-02', to: [], text: `room note ${i}`, kind: 'note' });
    letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'direct note', kind: 'note' });
  });
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe('request branch selection (the request decides, never the response)', () => {
  it.each<[string, unknown, GetMapBranch | null]>([
    ['no arguments', {}, 'map'],
    ['no arguments at all (the server wrapper passes {})', undefined, 'map'],
    ['goal', { field: 'goal' }, 'work-text'],
    ['title', { field: 'title' }, 'work-text'],
    ['providers', { field: 'providers' }, 'providers'],
    ['archive', { field: 'archive' }, 'archive'],
    ['summaries', { field: 'summaries' }, 'summaries'],
    ['messages without a room (direct)', { field: 'messages' }, 'messages'],
    ['messages of a room', { field: 'messages', room: 'r-01', kind: 'note', cursor: 'before:5', maxBytes: 4096 }, 'messages'],
    ['one message', { field: 'message', id: 'm-1' }, 'message'],
    ['task', { field: 'task', session: 's-01' }, 'session-text'],
    ['summary', { field: 'summary', session: 's-01' }, 'session-text'],
    ['contextFrom', { field: 'contextFrom', session: 's-01' }, 'context-from'],
    ['history', { field: 'history', session: 's-01' }, 'history'],
    ['artifacts', { field: 'artifacts', session: 's-01' }, 'artifacts'],
    ['session only', { session: 's-01' }, 'session'],
    ['room only', { room: 'r-01' }, 'room'],
    ['field wins over session and room', { field: 'goal', session: 's-01', room: 'r-01' }, 'work-text'],
    ['session wins over room', { session: 's-01', room: 'r-01' }, 'session'],
    ['field summaries ignores a session argument', { field: 'summaries', session: 's-01' }, 'summaries'],
    ['task needs a session', { field: 'task' }, null],
    ['history needs a session', { field: 'history' }, null],
    ['message needs an id', { field: 'message' }, null],
    ['sessions collection', { field: 'sessions' }, 'collection'],
    ['rooms collection with a topology cursor and a page size', { field: 'rooms', cursor: 'topology:abc', maxBytes: 4096 }, 'collection'],
    ['plans collection', { field: 'plans' }, 'collection'],
    ['deletedSessions collection', { field: 'deletedSessions' }, 'collection'],
    ['unreadRooms collection', { field: 'unreadRooms' }, 'collection'],
    ['a collection with a session is refused by the handler', { field: 'sessions', session: 's-01' }, null],
    ['a collection with a room is refused', { field: 'rooms', room: 'r-01' }, null],
    ['a collection with a kind is refused', { field: 'plans', kind: 'note' }, null],
    ['a collection with an id is refused', { field: 'plans', id: 'pl-01' }, null],
    ['a collection with a rev is refused', { field: 'plans', rev: 1 }, null],
    ['a collection with a non-string cursor is refused', { field: 'sessions', cursor: 7 }, null],
    ['plan', { field: 'plan', id: 'pl-01', rev: 1 }, 'plan'],
    ['plan with rev 0', { field: 'plan', id: 'pl-01', rev: 0 }, 'plan'],
    ['plan ignores session and room', { field: 'plan', id: 'pl-01', rev: 3, session: 's-01', room: 'r-01' }, 'plan'],
    ['plan needs an id', { field: 'plan', rev: 1 }, null],
    ['plan needs a rev', { field: 'plan', id: 'pl-01' }, null],
    ['plan rev must be an integer', { field: 'plan', id: 'pl-01', rev: 1.5 }, null],
    ['plan rev must not be negative', { field: 'plan', id: 'pl-01', rev: -1 }, null],
    ['plan rev must be a number', { field: 'plan', id: 'pl-01', rev: '1' }, null],
    ['plan id must be a string', { field: 'plan', id: 7, rev: 1 }, null],
    ['rev is ignored by the other fields', { field: 'goal', rev: 'x' }, 'work-text'],
    ['a rev alone is no request', { rev: 1 }, null],
    ['an unknown field never falls back to the session form', { field: 'nope', session: 's-01', room: 'r-01' }, null],
    ['an empty field is no field', { field: '' }, null],
    ['only paging arguments', { maxBytes: 4096 }, null],
    ['only a cursor', { cursor: 'before:3' }, null],
    ['a non-string field', { field: 7 }, null],
    ['a non-string session', { session: 7 }, null],
    ['a non-string room next to a valid session', { session: 's-01', room: 7 }, null],
    ['a non-number maxBytes', { field: 'goal', maxBytes: '4096' }, null],
  ])('%s', (_label, args, expected) => {
    expect(selectGetMapBranch(args)).toBe(expected);
  });

  it('refuses a request that is not a plain object', () => {
    for (const bad of [null, 'goal', 7, [], [{ field: 'goal' }]]) expect(selectGetMapBranch(bad)).toBeNull();
  });

  it('knows exactly fifteen branches and every one is reachable', () => {
    expect([...GET_MAP_BRANCHES].sort()).toEqual(['archive', 'artifacts', 'collection', 'context-from', 'history', 'map', 'message', 'messages', 'plan', 'providers', 'room', 'session', 'session-text', 'summaries', 'work-text']);
  });
});

const ROW_FIELDS = ['sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms'] as const;

describe('G0 overview (schemaVersion 3) from the real handler', () => {
  it('decodes the overview, keeps unmodeled fields as unknown; rows exist, so unmarked row caps make it unknown', async () => {
    const d = await base.decode({});
    const v = branchOf(d, 'map');
    expect(d.assessment).toBe('unknown');
    expect(v.sessionId).toBe('s-01');
    expect(v.map.schemaVersion).toBe(3);
    expect(v.map.sessions.map((s) => s.id)).toEqual(['s-01', 's-02']);
    expect(v.map.rooms.map((r) => r.id)).toEqual(['r-01']);
    expect(v.map.plans).toEqual([]);
    expect(typeof v.map.pages).toBe('string');
    expect(typeof v.map.note).toBe('string');
    expect(v.map.messages.total).toBe(8);
    expect(v.map.messages.direct.total).toBe(1);
    // every collection reports its own page; all complete here
    for (const field of ROW_FIELDS) expect(v.map.collections[field], field).toMatchObject({ complete: true, next: null, cut: 0 });
    expect(v.map.collections.sessions).toMatchObject({ total: 2, returned: 2 });
    expect(v.map.collections.rooms).toMatchObject({ total: 1, returned: 1 });
    expect(v.map.collections.plans).toMatchObject({ total: 0, returned: 0 });
    // fields the adapter does not model stay verbatim and untyped
    expect(v.map.sessions[0]!.unknownFields['provider']).toBe('claude');
    expect(v.map.sessions[0]!.unknownFields['label']).toBe('lead');
    expect(v.map.work.unknownFields['title']).toBe('Adapter fixtures');
    expect(v.map.work.unknownFields['goal']).toBe('Short goal');
    expect(v.unknownFields).toEqual({});
  });

  it('is never complete: even with all three row collections empty, every page complete and no cut, work.createdAt/updatedAt may be shortened without a mark', async () => {
    const real = await base.call({});
    const emptied = decodeGetMap({}, mutateJson(real, (j) => {
      const m = j['map'];
      m.sessions = []; m.rooms = []; m.plans = [];
      for (const f of ['sessions', 'rooms', 'plans']) { m.collections[f].total = 0; m.collections[f].returned = 0; }
    }));
    expect(branchOf(emptied, 'map').map.collections.sessions).toMatchObject({ complete: true, next: null, cut: 0 });
    expect(emptied.assessment).toBe('unknown');
    // the timestamps alone are the reason; rows add nothing to it, a missing page still makes it partial
    expect((await base.decode({})).assessment).toBe('unknown');
    const partial = decodeGetMap({}, mutateJson(real, (j) => { j['map'].collections.deletedSessions.complete = false; j['map'].collections.deletedSessions.next = 'topology:AAAA'; j['map'].collections.deletedSessions.total = 5; }));
    expect(partial.assessment).toBe('partial');
  });

  it('a long work.createdAt or work.updatedAt on an otherwise empty, complete overview is unknown, each on its own', async () => {
    const real = await base.call({});
    const emptied = (change: (m: Doc) => void): unknown => mutateJson(real, (j) => {
      const m = j['map'];
      m.sessions = []; m.rooms = []; m.plans = [];
      for (const f of ['sessions', 'rooms', 'plans']) { m.collections[f].total = 0; m.collections[f].returned = 0; }
      change(m);
    });
    for (const key of ['createdAt', 'updatedAt']) {
      const d = decodeGetMap({}, emptied((m) => { m.work[key] = `${'2'.repeat(94)}…`; }));
      expect(branchOf(d, 'map').map.work.unknownFields[key], key).toBe(`${'2'.repeat(94)}…`);
      expect(d.assessment, key).toBe('unknown');
    }
    // and a plain-looking timestamp changes nothing: the overview cannot be called complete from its content
    expect(decodeGetMap({}, emptied(() => undefined)).assessment).toBe('unknown');
  });

  it('what the overview caps: every other text field is either marked (work title and goal) or an id/number', async () => {
    const d = await base.decode({});
    const v = branchOf(d, 'map');
    // timestamps stay readable as unmodeled strings of work; nothing is claimed about them
    expect(typeof v.map.work.unknownFields['createdAt']).toBe('string');
    expect(typeof v.map.work.unknownFields['updatedAt']).toBe('string');
    const longGoal = await (await scenario('Marked cap', () => undefined, 'g'.repeat(3000))).decode({});
    expect(branchOf(longGoal, 'map').map.work.cut).toEqual({ goal: 3000 });
    expect(longGoal.assessment).toBe('partial');
  });

  it('a plan is a summary row now: it makes the map unknown for the row cap, not for any log cap, and finished plans are listed too', async () => {
    const mk = (status: RoomPlan['status']) => scenario(`Plan ${status}`, (map) => {
      map.plans = [{ id: 'pl-01', roomId: 'r-01', mode: 'verified', status, rev: 4, goal: 'Ship it', items: [{ id: 1, title: 'one', owner: 's-02', scope: 'x', after: [], criteria: ['it works'], verifier: null, status: 'ready', evidence: null, note: null, log: [] }], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null }];
    });
    for (const status of ['active', 'completed'] as const) {
      const d = await (await mk(status)).decode({});
      const v = branchOf(d, 'map');
      expect(v.map.plans.map((p) => p.id), status).toEqual(['pl-01']);
      expect(v.map.plans[0]!.rev, status).toBe(4);
      expect(v.map.plans[0]!.status, status).toBe(status);
      expect(v.map.plans[0]!.itemCount, status).toBe(1);
      expect(v.map.collections.plans, status).toMatchObject({ total: 1, returned: 1, complete: true });
      expect(d.assessment, status).toBe('unknown');
    }
  });

  it('the 302-session case: a first page of a few rows with complete:false and a topology cursor is PARTIAL, never complete', async () => {
    const many = await scenario('302 sessions', (map) => {
      for (let i = 0; i < 300; i++) addSession(map, { provider: 'claude', label: `worker ${i}`, task: 'Do part of the work' });
    });
    const real = await many.call({});
    const d = decodeGetMap({}, real);
    const v = branchOf(d, 'map');
    expect(v.map.collections.sessions.total).toBe(302);
    expect(v.map.sessions.length).toBe(v.map.collections.sessions.returned);
    expect(v.map.sessions.length).toBeLessThan(302);
    expect(v.map.collections.sessions.complete).toBe(false);
    expect(v.map.collections.sessions.next).toMatch(/^topology:[A-Za-z0-9_-]+$/);
    expect(d.assessment).toBe('partial');
    // what a decoder that only accepted version 3 and ignored `collections` would have said
    const withoutCollections = pairs(JSON.parse(textOf(real)), false);
    expect(withoutCollections.has('map.collections.sessions.complete=false')).toBe(true);
  });

  it('every collection can make the overview partial on its own', async () => {
    const real = await base.call({});
    for (const f of ROW_FIELDS) {
      const d = decodeGetMap({}, mutateJson(real, (j) => {
        const m = j['map'];
        m.collections[f].complete = false;
        m.collections[f].next = 'topology:AAAA';
        m.collections[f].total = m.collections[f].returned + 5;
      }));
      expect(d.assessment, f).toBe('partial');
    }
  });

  it('versions other than 3 are refused: 2, 4, a string, and a missing version', async () => {
    const real = await base.call({});
    for (const version of [2, 4, 1, '3', null]) expect(invalidCode(decodeGetMap({}, mutateJson(real, (j) => { j['map'].schemaVersion = version; }))), String(version)).toBe('shape-mismatch');
    expect(invalidCode(decodeGetMap({}, mutateJson(real, (j) => { delete j['map'].schemaVersion; })))).toBe('shape-mismatch');
  });

  it('a missing or malformed `collections` is refused, never read as complete', async () => {
    const real = await base.call({});
    const corrupt: [string, (j: Doc) => void][] = [
      ['missing', (j) => { delete j['map'].collections; }],
      ['one collection missing', (j) => { delete j['map'].collections.plans; }],
      ['not an object', (j) => { j['map'].collections = []; }],
      ['a page of a wrong type', (j) => { j['map'].collections.rooms = 'complete'; }],
    ];
    for (const [label, change] of corrupt) expect(invalidCode(decodeGetMap({}, mutateJson(real, change)), ), label).toBe('shape-mismatch');
  });

  it('collections must agree with the arrays they describe', async () => {
    const real = await base.call({});
    const cases: [string, (j: Doc) => void][] = [
      ['sessions returned differs', (j) => { j['map'].collections.sessions.returned = 1; j['map'].collections.sessions.total = 2; }],
      ['rooms returned differs', (j) => { j['map'].collections.rooms.returned = 0; }],
      ['deletedSessions differs from work.deletedSessions', (j) => { j['map'].work.deletedSessions = ['s-9']; }],
      ['unreadRooms differs from unreadForYou.rooms', (j) => { j['map'].messages.unreadForYou.rooms = { 'r-01': 2, 'r-02': 1 }; }],
      ['complete without a null next', (j) => { j['map'].collections.sessions.next = 'topology:AAAA'; }],
      ['incomplete without a next', (j) => { j['map'].collections.sessions.complete = false; }],
      ['a before/after cursor in a topology page', (j) => { j['map'].collections.sessions.complete = false; j['map'].collections.sessions.next = 'before:3'; j['map'].collections.sessions.total = 9; }],
    ];
    for (const [label, change] of cases) expect(invalidCode(decodeGetMap({}, mutateJson(real, change)), ), label).toBe('page-invariant');
  });

  it('a positive cut map on the work is partial; an empty one and page.cut 0 are not evidence', async () => {
    const longGoal = await scenario('Long goal', () => undefined, 'g'.repeat(3000));
    const goal = await longGoal.decode({});
    expect(branchOf(goal, 'map').map.work.cut).toEqual({ goal: 3000 });
    expect(goal.assessment).toBe('partial');
    const real = await base.call({});
    const emptyCut = decodeGetMap({}, mutateJson(real, (j) => { j['map'].work.cut = {}; }));
    expect(branchOf(emptyCut, 'map').map.work.cut).toEqual({});
    expect(emptyCut.assessment).toBe((await base.decode({})).assessment);
  });

  it('a positive page.cut in any collection page is partial even when the page is complete', async () => {
    const real = await base.call({});
    const d = decodeGetMap({}, mutateJson(real, (j) => { j['map'].collections.deletedSessions.cut = 2; }));
    expect(branchOf(d, 'map').map.collections.deletedSessions).toMatchObject({ complete: true, cut: 2 });
    expect(d.assessment).toBe('partial');
  });

  it('the constant `note` carries no meaning: its presence is required and its text is never read', async () => {
    const real = await base.call({});
    const other = decodeGetMap({}, mutateJson(real, (j) => { j['map'].note = 'Some other text'; }));
    expect(other.assessment).toBe((await base.decode({})).assessment);
    expect(branchOf(other, 'map').map.note).toBe('Some other text');
    expect(invalidCode(decodeGetMap({}, mutateJson(real, (j) => { delete j['map'].note; })))).toBe('shape-mismatch');
    expect(invalidCode(decodeGetMap({}, mutateJson(real, (j) => { j['map'].note = 7; })))).toBe('shape-mismatch');
  });

  it('work.closeFinished is optional and typed; the work cut stays a count map', async () => {
    const real = await base.call({});
    const on = decodeGetMap({}, mutateJson(real, (j) => { j['map'].work.closeFinished = true; }));
    expect(branchOf(on, 'map').map.work.closeFinished).toBe(true);
    expect(branchOf(await base.decode({}), 'map').map.work.closeFinished).toBeUndefined();
    expect(invalidCode(decodeGetMap({}, mutateJson(real, (j) => { j['map'].work.closeFinished = 'yes'; })))).toBe('shape-mismatch');
  });
});

describe('collection forms (sessions, rooms, plans, deletedSessions, unreadRooms) from the real handler', () => {
  it('codeMode (plan T12a-indicator) is an unknown field of the session row, the overview row (the mode word) and the detail ({mode, reason}): kept verbatim, decoder and schema untouched', async () => {
    const s = await scenario('Indicator pin', () => undefined);
    const dir = workPaths(project, s.workId).dir;
    expect(writeLaunchDecision(dir, 's-02', { v: 1, nonce: null, effective: 'classic', requested: true, reason: 'not-requested', provider: 'claude', at: '2026-11-09T00:00:00.000Z' })).toBe(true);
    const collection = branchOf(await s.decode({ field: 'sessions' }), 'collection');
    expect(collection.items.map((r) => r.unknownFields['codeMode'])).toEqual(['unknown', 'classic']);
    const overview = branchOf(await s.decode({}), 'map');
    expect(overview.map.sessions.map((r) => r.unknownFields['codeMode'])).toEqual(['unknown', 'classic']);
    // The one-session detail carries the reason too.
    expect(branchOf(await s.decode({ session: 's-02' }), 'session').session.unknownFields['codeMode']).toEqual({ mode: 'classic', reason: 'not-requested' });
    // The rows decode as before: id and nothing modeled beyond it.
    expect(collection.items.map((r) => Object.keys(r).sort())).toEqual([['id', 'unknownFields'], ['id', 'unknownFields']]);
    // The output schema and the adapter know nothing of the field, so no apiRevision moves.
    expect(JSON.stringify(READ_OUTPUT_SCHEMAS)).not.toContain('codeMode');
    expect(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'read-adapters.ts'), 'utf8')).not.toContain('codeMode');
  });

  it('each field decodes with its own rows, an echoed field and a checked page; extra row keys stay under unknownFields', async () => {
    const s = await scenario('Collections', (map, letters) => {
      map.work.deletedSessions = ['s-90', 's-91'];
      letters.add({ roomId: 'r-01', from: 's-02', to: ['s-01'], text: 'unread for s-01', kind: 'note' });
      map.plans = [{ id: 'pl-01', roomId: 'r-01', mode: 'verified', status: 'active', rev: 2, goal: 'Ship it', items: [{ id: 1, title: 'one', owner: 's-02', scope: 'x', after: [], criteria: ['it works'], verifier: null, status: 'ready', evidence: null, note: null, log: [] }], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null }];
    });
    const expected: Record<(typeof ROW_FIELDS)[number], { ids: string[]; assessment: Assessment }> = {
      sessions: { ids: ['s-01', 's-02'], assessment: 'unknown' },
      rooms: { ids: ['r-01'], assessment: 'unknown' },
      plans: { ids: ['pl-01'], assessment: 'unknown' },
      deletedSessions: { ids: ['s-90', 's-91'], assessment: 'complete' },
      unreadRooms: { ids: ['r-01'], assessment: 'complete' },
    };
    for (const field of ROW_FIELDS) {
      const d = await s.decode({ field });
      const v = branchOf(d, 'collection');
      expect(v.field, field).toBe(field);
      expect(v.items.map((r) => r.id), field).toEqual(expected[field].ids);
      expect(v.page, field).toMatchObject({ total: expected[field].ids.length, returned: expected[field].ids.length, complete: true, next: null, cut: 0 });
      expect(d.assessment, field).toBe(expected[field].assessment);
    }
    const plans = branchOf(await s.decode({ field: 'plans' }), 'collection');
    expect(plans.items[0]).toMatchObject({ id: 'pl-01', rev: 2, status: 'active', roomId: 'r-01', itemCount: 1 });
    expect(plans.items[0]!.unknownFields['goal']).toBe('Ship it');
    const unread = branchOf(await s.decode({ field: 'unreadRooms' }), 'collection');
    expect(unread.items[0]).toMatchObject({ id: 'r-01', count: 1 });
  });

  it('a first page of a long collection is partial and its topology cursor continues to a complete last page', async () => {
    const many = await scenario('Paged sessions', (map) => {
      for (let i = 0; i < 60; i++) addSession(map, { provider: 'claude', label: `worker ${i}`, task: 'Do part of the work' });
    });
    let args: Record<string, unknown> = { field: 'sessions', maxBytes: 4096 };
    const seen: string[] = [];
    let last: Decoded<GetMapValue> | undefined;
    for (let i = 0; i < 30; i++) {
      last = await many.decode(args);
      const v = branchOf(last, 'collection');
      seen.push(...v.items.map((r) => r.id));
      if (i === 0) {
        expect(v.page.complete).toBe(false);
        expect(v.page.next).toMatch(/^topology:/);
        expect(last.assessment).toBe('partial');
      }
      if (v.page.complete) break;
      args = { ...args, cursor: v.page.next };
    }
    expect(branchOf(last!, 'collection').page).toMatchObject({ complete: true, next: null });
    expect(seen).toHaveLength(62);
    expect(new Set(seen).size).toBe(62);
  });

  it('cursor families stay apart: a topology page never carries before/after or offset, and the other pages never carry topology', async () => {
    const many = await scenario('Cursor families', (map) => {
      for (let i = 0; i < 60; i++) addSession(map, { provider: 'claude', label: `worker ${i}`, task: 'x' });
    });
    const topo = await many.call({ field: 'sessions', maxBytes: 4096 });
    const forged = (next: string): unknown => mutateJson(topo, (j) => { j['page'].next = next; });
    for (const bad of ['before:3', 'after:3', 'offset:3:abcdef012345', 'topology:', 'topology:has space', `topology:${'a'.repeat(513)}`, 'TOPOLOGY:abc']) {
      expect(invalidCode(decodeGetMap({ field: 'sessions', maxBytes: 4096 }, forged(bad))), bad).toBe('page-invariant');
    }
    expect(branchOf(decodeGetMap({ field: 'sessions', maxBytes: 4096 }, forged('topology:AAAA')), 'collection').page.next).toBe('topology:AAAA');
    // and the reverse: a messages page with a topology cursor is refused
    const feed = await base.call({ field: 'messages', room: 'r-01', maxBytes: 2048 });
    const mutated = mutateJson(feed, (j) => { j['page'].complete = false; j['page'].next = 'topology:AAAA'; j['page'].total = j['page'].returned + 3; });
    expect(invalidCode(decodeGetMap({ field: 'messages', room: 'r-01', maxBytes: 2048 }, mutated))).toBe('page-invariant');
  });

  it('the answer must be the one asked for: field echo, items key, row shapes and page invariants', async () => {
    const real = await base.call({ field: 'plans' });
    const rooms = await base.call({ field: 'rooms' });
    expect(invalidCode(decodeGetMap({ field: 'plans' }, rooms))).toBe('echo-mismatch');
    expect(invalidCode(decodeGetMap({ field: 'sessions' }, rooms))).toBe('echo-mismatch');
    const sessions = await base.call({ field: 'sessions' });
    const cases: [string, string, (j: Doc) => void][] = [
      ['items is not an array', 'shape-mismatch', (j) => { j['items'] = {}; }],
      ['a row without an id', 'shape-mismatch', (j) => { delete j['items'][0].id; }],
      ['returned differs from the rows', 'page-invariant', (j) => { j['page'].returned += 1; }],
      ['total below returned', 'page-invariant', (j) => { j['page'].total = 1; }],
      ['complete although a cursor is named', 'page-invariant', (j) => { j['page'].next = 'topology:AAAA'; }],
      ['missing page', 'shape-mismatch', (j) => { delete j['page']; }],
    ];
    for (const [label, code, change] of cases) expect(invalidCode(decodeGetMap({ field: 'sessions' }, mutateJson(sessions, change))), label).toBe(code);
    void real;
  });

  it('stale and invalid topology cursors are tool errors from the real handler and stay untouched', async () => {
    const many = await scenario('Stale cursor', (map) => { for (let i = 0; i < 60; i++) addSession(map, { provider: 'claude', label: `w${i}`, task: 'x' }); });
    const first = JSON.parse(textOf(await many.call({ field: 'sessions', maxBytes: 4096 }))) as { page: { next: string } };
    for (const args of [{ field: 'sessions', maxBytes: 4096, cursor: 'topology:not-valid' }, { field: 'rooms', maxBytes: 4096, cursor: first.page.next }, { field: 'sessions', maxBytes: 8192, cursor: first.page.next }, { field: 'sessions', cursor: 'before:3' }]) {
      const result = await many.call(args);
      expect((result as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
      const d = decodeGetMap(args, result);
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result } });
      expect(d.assessment).toBe('unknown');
    }
    await updateMap(project, many.workId, (map) => { addSession(map, { provider: 'claude', label: 'late', task: 'x' }); });
    const stale = await many.call({ field: 'sessions', maxBytes: 4096, cursor: first.page.next });
    expect((stale as { isError?: boolean }).isError).toBe(true);
    expect(textOf(stale)).toContain('stale-cursor');
    expect(decodeGetMap({ field: 'sessions', maxBytes: 4096, cursor: first.page.next }, stale).result).toEqual({ ok: false, error: { kind: 'tool-error', result: stale } });
  });

  it('collection arguments the handler refuses have no branch for a success text', async () => {
    const real = await base.call({ field: 'sessions' });
    for (const args of [{ field: 'sessions', session: 's-01' }, { field: 'sessions', room: 'r-01' }, { field: 'sessions', kind: 'note' }, { field: 'sessions', id: 'x' }, { field: 'sessions', rev: 1 }]) {
      expect(invalidCode(decodeGetMap(args, real)), JSON.stringify(args)).toBe('unknown-request-branch');
    }
  });
});

describe('plan form (field plan, id and rev) from the real handler', () => {
  const planFixture = (rev: number): RoomPlan => ({ id: 'pl-01', roomId: 'r-01', mode: 'verified', status: 'active', rev, goal: 'Ship it', items: [{ id: 1, title: 'one', owner: 's-02', scope: 'x', after: [], criteria: ['it works'], verifier: null, status: 'ready', evidence: null, note: null, log: [] }], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null });

  it('decodes id, rev and status echoed from the request, a json format and a text page of the plan', async () => {
    const s = await scenario('Plan detail', (map) => { map.plans = [planFixture(3)]; });
    const args = { field: 'plan', id: 'pl-01', rev: 3 };
    const d = await s.decode(args);
    const v = branchOf(d, 'plan');
    expect(v).toMatchObject({ field: 'plan', id: 'pl-01', rev: 3, status: 'active', format: 'json', offset: 0, complete: true, next: null });
    expect(JSON.parse(v.text)).toMatchObject({ id: 'pl-01', rev: 3, goal: 'Ship it' });
    expect(d.assessment).toBe('complete');
  });

  it('rev 0 is a valid request and is preserved as 0', async () => {
    const s = await scenario('Plan rev 0', (map) => { map.plans = [planFixture(0)]; });
    const v = branchOf(await s.decode({ field: 'plan', id: 'pl-01', rev: 0 }), 'plan');
    expect(v.rev).toBe(0);
  });

  it('a long plan pages like any text: partial first page, an offset cursor, a complete last page', async () => {
    const s = await scenario('Long plan', (map) => {
      const plan = planFixture(1);
      plan.items = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `item ${i} ${'t'.repeat(60)}`, owner: 's-02', scope: 'x'.repeat(60), after: [], criteria: ['it works'], verifier: null, status: 'ready' as const, evidence: null, note: null, log: [] }));
      map.plans = [plan];
    });
    let args: Record<string, unknown> = { field: 'plan', id: 'pl-01', rev: 1, maxBytes: 2048 };
    const first = await s.decode(args);
    const f = branchOf(first, 'plan');
    expect(f.complete).toBe(false);
    expect(f.next).toMatch(/^offset:\d+:[0-9a-f]{12}$/);
    expect(first.assessment).toBe('partial');
    let text = f.text;
    let last = f;
    for (let i = 0; i < 50 && !last.complete; i++) {
      args = { ...args, cursor: last.next };
      last = branchOf(await s.decode(args), 'plan');
      text += last.text;
    }
    expect(last.complete).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ id: 'pl-01', rev: 1 });
  });

  it('errors of the real handler stay tool errors: an unknown plan, an old rev, a missing rev', async () => {
    const s = await scenario('Plan errors', (map) => { map.plans = [planFixture(3)]; });
    for (const args of [{ field: 'plan', id: 'pl-99', rev: 3 }, { field: 'plan', id: 'pl-01', rev: 2 }, { field: 'plan', id: 'pl-01' }, { field: 'plan', id: 'pl-01', rev: -1 }, { field: 'plan', rev: 3 }]) {
      const result = await s.call(args);
      expect((result as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
      const d = decodeGetMap(args, result);
      expect(d.assessment).toBe('unknown');
      if (selectGetMapBranch(args) === 'plan') expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result } });
    }
  });

  it('echo and shape are checked: another id, another rev, another format, a wrong status type, missing keys', async () => {
    const s = await scenario('Plan echo', (map) => { map.plans = [planFixture(3)]; });
    const args = { field: 'plan', id: 'pl-01', rev: 3 };
    const real = await s.call(args);
    expect(invalidCode(decodeGetMap({ field: 'plan', id: 'pl-02', rev: 3 }, real))).toBe('echo-mismatch');
    expect(invalidCode(decodeGetMap({ field: 'plan', id: 'pl-01', rev: 4 }, real))).toBe('echo-mismatch');
    const cases: [string, string, (j: Doc) => void][] = [
      ['format is not json', 'echo-mismatch', (j) => { j['format'] = 'text'; }],
      ['field differs', 'echo-mismatch', (j) => { j['field'] = 'plans'; }],
      ['rev is a string', 'echo-mismatch', (j) => { j['rev'] = '3'; }],
      ['status of a wrong type', 'shape-mismatch', (j) => { j['status'] = 7; }],
      ['status missing', 'shape-mismatch', (j) => { delete j['status']; }],
      ['text byte length wrong', 'page-invariant', (j) => { j['bytes'] += 1; }],
    ];
    for (const [label, code, change] of cases) expect(invalidCode(decodeGetMap(args, mutateJson(real, change))), label).toBe(code);
    expect(invalidCode(decodeGetMap({ field: 'plan', rev: 3 }, real))).toBe('unknown-request-branch');
  });

  it('the plan text is never parsed by the decoder: a chunk that is not JSON is still decoded as text', async () => {
    const s = await scenario('Plan chunk', (map) => { map.plans = [planFixture(3)]; });
    const real = await s.call({ field: 'plan', id: 'pl-01', rev: 3, maxBytes: 2048 });
    const d = decodeGetMap({ field: 'plan', id: 'pl-01', rev: 3, maxBytes: 2048 }, mutateJson(real, (j) => { j['text'] = 'not json'; j['bytes'] = 8; j['totalBytes'] = 8; j['sha256'] = '0123456789ab'; j['offset'] = 0; j['complete'] = true; j['next'] = null; }));
    expect(branchOf(d, 'plan').text).toBe('not json');
  });
});

describe('session, room and text forms from the real handler', () => {
  it('G1: counts against the 20-entry slices decide partial or complete', async () => {
    const big = await base.decode({ session: 's-01' });
    const v = branchOf(big, 'session');
    expect(v.session.artifactCount).toBe(25);
    expect(v.session.historyCount).toBe(27); // pending + active + the 25 added
    expect(v.session.artifacts).toHaveLength(20);
    expect(v.session.history).toHaveLength(20);
    expect(big.assessment).toBe('partial');

    const small = await base.decode({ session: 's-02' });
    expect(branchOf(small, 'session').session.artifacts).toHaveLength(1);
    expect(small.assessment).toBe('complete');
  });

  it('G1: only one of the two slices being short is enough for partial', async () => {
    const real = await base.call({ session: 's-02' });
    const d = decodeGetMap({ session: 's-02' }, mutateJson(real, (j) => { j['session'].artifactCount = 2; }));
    expect(branchOf(d, 'session').session.artifactCount).toBe(2);
    expect(d.assessment).toBe('partial');
  });

  it('G2: a room carries counts only and is complete', async () => {
    const d = await base.decode({ room: 'r-01' });
    const v = branchOf(d, 'room');
    expect(v.room.id).toBe('r-01');
    expect(v.room.recipe).toBeNull();
    expect(v.messages.total).toBe(7);
    expect(v.room.unknownFields['title']).toBe('Fixtures room');
    expect(d.assessment).toBe('complete');
  });

  it('G3: a short goal is one complete page; a long one pages with a cursor that continues exactly', async () => {
    const short = await base.decode({ field: 'goal' });
    const sv = branchOf(short, 'work-text');
    expect(sv).toMatchObject({ field: 'goal', text: 'Short goal', offset: 0, complete: true, next: null });
    expect(short.assessment).toBe('complete');

    const long = await scenario('Paged goal', () => undefined, 'абв'.repeat(2500));
    const first = await long.decode({ field: 'goal', maxBytes: 2048 });
    const f = branchOf(first, 'work-text');
    expect(f.complete).toBe(false);
    expect(f.next).toBe(`offset:${f.offset + f.bytes}:${f.sha256}`);
    expect(first.assessment).toBe('partial');
    const second = await long.decode({ field: 'goal', maxBytes: 2048, cursor: f.next! });
    const s2 = branchOf(second, 'work-text');
    expect(s2.offset).toBe(f.bytes);
    expect(s2.sha256).toBe(f.sha256);
  });

  it('G3: the last page of a long text is complete', async () => {
    const long = await scenario('Paged title', () => undefined, 'я'.repeat(1200));
    let args: Record<string, unknown> = { field: 'goal', maxBytes: 2048 };
    let last: Decoded<GetMapValue> | undefined;
    for (let i = 0; i < 10; i++) {
      last = await long.decode(args);
      const v = branchOf(last, 'work-text');
      if (v.complete) break;
      args = { ...args, cursor: v.next };
    }
    expect(branchOf(last!, 'work-text').complete).toBe(true);
    expect(last!.assessment).toBe('complete');
  });

  it('G9 and G10: session texts and contextFrom', async () => {
    const task = await base.decode({ field: 'task', session: 's-01' });
    expect(branchOf(task, 'session-text')).toMatchObject({ session: 's-01', field: 'task', text: 'Lead the adapter fixtures', complete: true });
    const summary = await base.decode({ field: 'summary', session: 's-02' });
    expect(branchOf(summary, 'session-text')).toMatchObject({ session: 's-02', field: 'summary', text: 'Worker summary' });
    const ctx = await base.decode({ field: 'contextFrom', session: 's-01' });
    expect(branchOf(ctx, 'context-from')).toMatchObject({ session: 's-01', contextFrom: [] });
    expect(ctx.assessment).toBe('complete');
  });

  it('G11 and G12: history and artifacts page with a PageInfo that is checked, not trusted', async () => {
    const first = await base.decode({ field: 'artifacts', session: 's-01', maxBytes: 2048 });
    const f = branchOf(first, 'artifacts');
    expect(f.page.total).toBe(25);
    expect(f.page.returned).toBe(f.artifacts.length);
    expect(f.page.complete).toBe(false);
    expect(f.page.next).toMatch(/^(before|after):\d+$/);
    expect(first.assessment).toBe('partial');

    const whole = await base.decode({ field: 'history', session: 's-02' });
    expect(branchOf(whole, 'history').page).toMatchObject({ total: 1, complete: true, next: null, cut: 0 });
    expect(whole.assessment).toBe('complete');
  });
});

describe('listing forms from the real handler', () => {
  it('G4: host rows are complete; the local fallback carries a note and is partial', async () => {
    const hostRows = await base.decode({ field: 'providers' });
    const v = branchOf(hostRows, 'providers');
    expect(v.providers.map((p) => [p.id, p.available])).toEqual([['claude', true], ['codex', false]]);
    expect(v.providers[1]!.unknownFields['needs']).toBe('sign-in');
    expect(v.note).toBeUndefined();
    expect(hostRows.assessment).toBe('complete');

    const fallback = await scenario('No host rows', () => undefined, 'Short goal', async () => null);
    const local = await fallback.decode({ field: 'providers' });
    const lv = branchOf(local, 'providers');
    expect(typeof lv.note).toBe('string');
    expect(lv.providers.length).toBeGreaterThan(0);
    expect(local.assessment).toBe('partial');
  });

  it('G5: other workspaces of the project', async () => {
    const d = await base.decode({ field: 'archive' });
    const v = branchOf(d, 'archive');
    expect(v.workspaces.length).toBeGreaterThan(0);
    expect(v.workspaces.map((w) => w.id)).not.toContain(base.workId);
    expect(v.page.complete).toBe(true);
    expect(d.assessment).toBe('complete');
  });

  it('G6: 236 summaries make a first page of nine rows that is partial', async () => {
    const many = await scenario('Many summaries', (map) => {
      for (let i = 0; i < 234; i++) addSession(map, { provider: 'claude', label: `w${i}`, task: 't' });
      for (const s of map.sessions) { s.summary = `${s.id} `.padEnd(7000, 'x'); s.summarySource = 'agent'; }
    });
    const d = await many.decode({ field: 'summaries' });
    const v = branchOf(d, 'summaries');
    expect(v.page.total).toBe(236);
    expect(v.summaries).toHaveLength(9);
    expect(v.page.returned).toBe(9);
    expect(v.page.complete).toBe(false);
    expect(v.page.next).not.toBeNull();
    expect(d.assessment).toBe('partial');
  });

  it('G6: a shortened summary is marked by textBytes and makes even a complete page partial', async () => {
    const one = await scenario('One long summary', (map) => { map.sessions[1]!.summary = 'z'.repeat(400_000); map.sessions[1]!.summarySource = 'agent'; });
    const d = await one.decode({ field: 'summaries', maxBytes: 8192 });
    const v = branchOf(d, 'summaries');
    expect(v.summaries[0]!.textBytes).toBe(400_000);
    expect(d.assessment).toBe('partial');
  });

  it('G7 and G8: room feed, direct feed and one message', async () => {
    const feed = await base.decode({ field: 'messages', room: 'r-01' });
    const fv = branchOf(feed, 'messages');
    expect(fv.messages).toHaveLength(7);
    expect(fv.messages[0]).toMatchObject({ kind: 'note', room: { id: 'r-01', title: 'Fixtures room' }, toEveryone: true });
    expect(feed.assessment).toBe('complete');

    const direct = await base.decode({ field: 'messages' });
    const dv = branchOf(direct, 'messages');
    expect(dv.messages).toHaveLength(1);
    expect(dv.messages[0]!.room).toBeNull();
    expect(dv.messages[0]!.toEveryone).toBeUndefined();

    const id = fv.messages[0]!.id;
    const one = await base.decode({ field: 'message', id });
    expect(branchOf(one, 'message')).toMatchObject({ id, from: 's-02', roomId: 'r-01', text: 'room note 0', complete: true });
  });

  it('G7: a shortened message text counts in page.cut and is partial; paging backwards is partial too', async () => {
    const s = await scenario('Long message', (_map, letters) => {
      for (let i = 0; i < 3; i++) letters.add({ roomId: 'r-01', from: 's-02', to: [], text: `${i}:`.padEnd(5000, 'я'), kind: 'note' });
    });
    const cutPage = await s.decode({ field: 'messages', room: 'r-01', maxBytes: 2048 });
    const v = branchOf(cutPage, 'messages');
    expect(v.page.cut).toBeGreaterThan(0);
    expect(cutPage.assessment).toBe('partial');
  });
});

describe('each completeness signal counts on its own', () => {
  it('textBytes on an otherwise complete summaries page is partial', async () => {
    const real = await base.call({ field: 'summaries' });
    const whole = decodeGetMap({ field: 'summaries' }, real);
    const w = branchOf(whole, 'summaries');
    expect(w.page).toMatchObject({ complete: true, cut: 0, next: null });
    expect(w.summaries).toHaveLength(1);
    expect(whole.assessment).toBe('complete');
    const marked = decodeGetMap({ field: 'summaries' }, mutateJson(real, (j) => { j['summaries'][0].textBytes = 9000; }));
    expect(branchOf(marked, 'summaries').page).toMatchObject({ complete: true, cut: 0 });
    expect(marked.assessment).toBe('partial');
  });

  it('a positive page.cut on an otherwise complete page is partial', async () => {
    const args = { field: 'history', session: 's-02' };
    const real = await base.call(args);
    expect(decodeGetMap(args, real).assessment).toBe('complete');
    const cut = decodeGetMap(args, mutateJson(real, (j) => { j['page'].cut = 1; }));
    expect(branchOf(cut, 'history').page).toMatchObject({ complete: true, cut: 1 });
    expect(cut.assessment).toBe('partial');
  });

  it('an incomplete page with cut 0 is partial; a page with cut 0 and complete is complete', async () => {
    const args = { field: 'artifacts', session: 's-01', maxBytes: 2048 };
    const d = await base.decode(args);
    expect(branchOf(d, 'artifacts').page).toMatchObject({ complete: false, cut: 0 });
    expect(d.assessment).toBe('partial');
  });

  it('the byte length of a text page is checked on its own, apart from offset and cursor', async () => {
    const real = await base.call({ field: 'goal' });
    const d = decodeGetMap({ field: 'goal' }, mutateJson(real, (j) => { j['text'] = 'Short'; }));
    expect(invalidCode(d)).toBe('page-invariant');
  });
});

describe('errors are data, malformed output is a fixed code', () => {
  it('a real handler error is preserved as the original strict result, never decoded, assessment unknown', async () => {
    for (const args of [{ field: 'goal', cursor: 'not-a-cursor' }, { room: 'r-99' }, { session: 's-99' }, { cursor: 'before:1' }, { field: 'task' }]) {
      const result = await base.call(args);
      expect((result as { isError?: boolean }).isError).toBe(true);
      const d = decodeGetMap(args, result);
      expect(d.assessment).toBe('unknown');
      if (d.result.ok || d.result.error.kind !== 'tool-error') throw new Error('expected tool-error');
      expect(d.result.error.result).toEqual(result);
      expect(d.result.error.result).not.toBe(result);
      expect(Object.isFrozen(d.result.error.result)).toBe(true);
    }
  });

  it('a cursor error and a missing room keep their own original payloads (they are different errors)', async () => {
    const cursor = await base.call({ field: 'goal', cursor: 'bad' });
    const room = await base.call({ room: 'r-99' });
    expect(textOf(cursor)).not.toBe(textOf(room));
    const a = decodeGetMap({ field: 'goal', cursor: 'bad' }, cursor);
    const b = decodeGetMap({ room: 'r-99' }, room);
    expect(a.result).toEqual({ ok: false, error: { kind: 'tool-error', result: cursor } });
    expect(b.result).toEqual({ ok: false, error: { kind: 'tool-error', result: room } });
  });

  it('isError wins before any success decoding: an error whose text is a valid map is still an error', async () => {
    const valid = await base.call({});
    const poisoned = { ...(valid as object), isError: true };
    const d = decodeGetMap({}, poisoned);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: poisoned } });
  });

  it('an error result is preserved even when its envelope is odd (extra keys, other content types)', () => {
    const odd = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'x' }], isError: true, _meta: { a: 1 } };
    const d = decodeGetMap({}, odd);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: odd } });
  });

  it('a non-boolean isError, an extra envelope key, several content items or a non-text item are unexpected-envelope', async () => {
    const real = (await base.call({})) as { content: unknown[] };
    for (const bad of [
      { ...real, isError: 'yes' },
      { content: [...real.content, ...real.content] },
      { content: [] },
      { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
      { content: [{ type: 'resource_link', text: textOf(real) }] },
      { content: 'text' },
      'plain string',
      7,
      null,
      [],
    ]) {
      const d = decodeGetMap({}, bad);
      expect(invalidCode(d)).toBe('unexpected-envelope');
      expect(d.assessment).toBe('unknown');
    }
  });

  it('an envelope that is not strict JSON is refused before anything else', async () => {
    const real = (await base.call({})) as { content: unknown[] };
    const cyc: Record<string, unknown> = { content: real.content };
    cyc['self'] = cyc;
    for (const bad of [cyc, { content: real.content, n: Number.NaN }, { content: real.content, f: () => 1 }, { content: real.content, u: undefined }, { content: real.content, big: 10n }]) {
      expect(invalidCode(decodeGetMap({}, bad))).toBe('result-not-strict-json');
    }
  });

  it('text that is not strict JSON is refused: prose, duplicate keys, __proto__, lone surrogate, trailing data, huge integers', async () => {
    const real = await base.call({});
    const texts = ['not json at all', '', '{"sessionId":"s-01","sessionId":"s-02","map":{}}', '{"__proto__":{}}', '{"a":"\\ud800"}', '{"a":1} x', '{"n":12345678901234567890}', '{'];
    for (const text of texts) expect(invalidCode(decodeGetMap({}, withText(real, text)))).toBe('text-not-strict-json');
  });

  it('a guide-like prose text is never parsed or classified', async () => {
    const real = await base.call({});
    expect(invalidCode(decodeGetMap({}, withText(real, 'The whole guide is 70000 bytes, over the limit.')))).toBe('text-not-strict-json');
  });

  it('a success for a request the handler would refuse has no branch', async () => {
    const real = await base.call({});
    for (const args of [{ maxBytes: 4096 }, { field: 'nope' }, { field: 'task' }, { field: 'plan' }, { field: 'plan', id: 'pl-01', rev: 1.5 }, { field: 'rooms', session: 's-01' }, null, 'x']) {
      expect(invalidCode(decodeGetMap(args, real))).toBe('unknown-request-branch');
    }
  });

  it('the decoded text must have the shape of the REQUEST: a map answer to a session request is refused', async () => {
    const mapAnswer = await base.call({});
    expect(invalidCode(decodeGetMap({ session: 's-01' }, mapAnswer))).toBe('shape-mismatch');
    const sessionAnswer = await base.call({ session: 's-01' });
    expect(invalidCode(decodeGetMap({}, sessionAnswer))).toBe('shape-mismatch');
    expect(invalidCode(decodeGetMap({ field: 'goal' }, sessionAnswer))).toBe('echo-mismatch');
  });

  it('malformed known shapes are invalid-output and never an empty success', async () => {
    const real = await base.call({});
    const corruptions: [string, (j: Doc) => void][] = [
      ['top-level array', () => undefined],
      ['the old schema version', (j) => { j['map'].schemaVersion = 2; }],
      ['string schema version', (j) => { j['map'].schemaVersion = '3'; }],
      ['sessions not an array', (j) => { j['map'].sessions = {}; }],
      ['a session without an id', (j) => { delete j['map'].sessions[0].id; }],
      ['a numeric room id', (j) => { j['map'].rooms[0].id = 1; }],
      ['pages not a string', (j) => { j['map'].pages = ['a']; }],
      ['missing messages', (j) => { delete j['map'].messages; }],
      ['negative message total', (j) => { j['map'].messages.total = -1; }],
      ['fractional unread count', (j) => { j['map'].messages.unreadForYou.total = 1.5; }],
      ['non-numeric unread room', (j) => { j['map'].messages.unreadForYou.rooms = { 'r-01': 'x' }; }],
      ['sessionId of a wrong type', (j) => { j['sessionId'] = 1; }],
      ['cut with a non-number', (j) => { j['map'].work.cut = { goal: 'big' }; }],
      ['work cut not an object', (j) => { j['map'].work.cut = [1]; }],
      ['deletedSessions of a wrong type', (j) => { j['map'].work.deletedSessions = 'none'; }],
      ['a plan row without a rev', (j) => { j['map'].plans = [{ id: 'pl-9' }]; j['map'].collections.plans.returned = 1; j['map'].collections.plans.total = 1; }],
      ['collections missing', (j) => { delete j['map'].collections; }],
    ];
    for (const [label, change] of corruptions) {
      const mutated = label === 'top-level array' ? withText(real, '[]') : mutateJson(real, change);
      const d = decodeGetMap({}, mutated);
      expect(invalidCode(d), label).toBe('shape-mismatch');
      expect(d.assessment, label).toBe('unknown');
      expect(d.result.ok, label).toBe(false);
    }
  });

  it('echo mismatches: the answer must belong to the request', async () => {
    const session = await base.call({ session: 's-01' });
    expect(invalidCode(decodeGetMap({ session: 's-02' }, session))).toBe('echo-mismatch');
    const room = await base.call({ room: 'r-01' });
    expect(invalidCode(decodeGetMap({ room: 'r-02' }, room))).toBe('echo-mismatch');
    const goal = await base.call({ field: 'goal' });
    expect(invalidCode(decodeGetMap({ field: 'title' }, goal))).toBe('echo-mismatch');
    const task = await base.call({ field: 'task', session: 's-01' });
    expect(invalidCode(decodeGetMap({ field: 'task', session: 's-02' }, task))).toBe('echo-mismatch');
    expect(invalidCode(decodeGetMap({ field: 'summary', session: 's-01' }, task))).toBe('echo-mismatch');
    const history = await base.call({ field: 'history', session: 's-01' });
    expect(invalidCode(decodeGetMap({ field: 'artifacts', session: 's-01' }, history))).toBe('echo-mismatch');
    const ctx = await base.call({ field: 'contextFrom', session: 's-01' });
    expect(invalidCode(decodeGetMap({ field: 'contextFrom', session: 's-02' }, ctx))).toBe('echo-mismatch');
    const feed = await base.call({ field: 'messages', room: 'r-01' });
    const id = (JSON.parse(textOf(feed)) as { messages: { id: string }[] }).messages[0]!.id;
    const one = await base.call({ field: 'message', id });
    expect(invalidCode(decodeGetMap({ field: 'message', id: 'm-9999' }, one))).toBe('echo-mismatch');
  });

  it('page invariants are checked: counts, completeness and cursor format', async () => {
    const real = await base.call({ field: 'artifacts', session: 's-01', maxBytes: 2048 });
    const cases: [string, string, (j: Doc) => void][] = [
      ['returned differs from the items', 'page-invariant', (j) => { j['page'].returned += 1; }],
      ['a complete page that still names a next', 'page-invariant', (j) => { j['page'].complete = true; }],
      ['an incomplete page with a null next', 'page-invariant', (j) => { j['page'].next = null; }],
      ['a malformed cursor', 'page-invariant', (j) => { j['page'].next = 'offset:3'; }],
      ['total below returned', 'page-invariant', (j) => { j['page'].total = 1; }],
      ['negative cut', 'shape-mismatch', (j) => { j['page'].cut = -1; }],
      ['missing bytes', 'shape-mismatch', (j) => { delete j['page'].bytes; }],
      ['page not an object', 'shape-mismatch', (j) => { j['page'] = 'p'; }],
    ];
    const args = { field: 'artifacts', session: 's-01', maxBytes: 2048 };
    for (const [label, code, change] of cases) {
      const d = decodeGetMap(args, mutateJson(real, change));
      expect(invalidCode(d), label).toBe(code);
      expect(d.assessment, label).toBe('unknown');
    }
  });

  it('text page invariants are checked: bytes, hash, end, completeness and the exact next cursor', async () => {
    const long = await scenario('Invariants', () => undefined, 'я'.repeat(3000));
    const args = { field: 'goal', maxBytes: 2048 };
    const real = await long.call(args);
    const cases: [string, (j: Doc) => void][] = [
      ['bytes differ from the text', (j) => { j['bytes'] -= 1; }],
      ['hash is not 12 hex', (j) => { j['sha256'] = 'XYZ'; }],
      ['complete although bytes remain', (j) => { j['complete'] = true; j['next'] = null; }],
      ['next points elsewhere', (j) => { j['next'] = `offset:${j['offset'] + j['bytes'] + 1}:${j['sha256']}`; }],
      ['next carries another hash', (j) => { j['next'] = `offset:${j['offset'] + j['bytes']}:000000000000`; }],
      ['end beyond the total', (j) => { j['totalBytes'] = 5; }],
    ];
    for (const [label, change] of cases) {
      expect(invalidCode(decodeGetMap(args, mutateJson(real, change))), label).toBe('page-invariant');
    }
  });
});

describe('unknown fields are retained, never stripped or typed', () => {
  it('extra keys survive at the top, in entries, in pages and in nested objects', async () => {
    const map = decodeGetMap({}, mutateJson(await base.call({}), (j) => {
      j['extraTop'] = { deep: [1, { x: null }] };
      j['map'].extraMap = 'm';
      j['map'].sessions[0].extraSession = 7;
      j['map'].messages.direct.extraDirect = true;
    }));
    const v = branchOf(map, 'map');
    expect(v.unknownFields).toEqual({ extraTop: { deep: [1, { x: null }] } });
    expect(v.map.unknownFields['extraMap']).toBe('m');
    expect(v.map.sessions[0]!.unknownFields['extraSession']).toBe(7);
    expect(v.map.messages.direct.unknownFields).toEqual({ extraDirect: true });
    expect(map.assessment).toBe((await base.decode({})).assessment);

    const page = decodeGetMap({ field: 'history', session: 's-02' }, mutateJson(await base.call({ field: 'history', session: 's-02' }), (j) => { j['page'].extraPage = 'p'; j['extraTop'] = 1; }));
    const pv = branchOf(page, 'history');
    expect(pv.page.unknownFields).toEqual({ extraPage: 'p' });
    expect(pv.unknownFields).toEqual({ extraTop: 1 });
  });

  it('modeled keys never leak into unknownFields', async () => {
    const v = branchOf(await base.decode({ field: 'goal' }), 'work-text');
    expect(v.unknownFields).toEqual({});
    const s = branchOf(await base.decode({ session: 's-02' }), 'session');
    expect(Object.keys(s.session.unknownFields)).not.toContain('id');
    expect(Object.keys(s.session.unknownFields)).not.toContain('history');
  });
});

describe('the guest union and the host assessment stay apart', () => {
  it('the result has no assessment, no completeness and no lifecycle in it', async () => {
    const d = await base.decode({ session: 's-01' });
    expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
    expect(Object.keys(d.result).sort()).toEqual(['ok', 'value']);
    expect(JSON.stringify(d.result)).not.toContain('assessment');
  });

  it('every failure carries only a kind and a fixed code or the original result, assessment never complete', async () => {
    const real = await base.call({});
    for (const bad of [withText(real, 'x'), { content: [] }, mutateJson(real, (j) => { j['map'].pages = 1; })]) {
      const d = decodeGetMap({}, bad);
      if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
      expect(Object.keys(d.result.error).sort()).toEqual(['code', 'kind']);
      expect(INVALID_OUTPUT_CODES).toContain(d.result.error.code);
      expect(d.assessment).not.toBe('complete');
    }
  });

  it('results are deeply frozen, independent of the caller object, and the decoder is pure', async () => {
    const input = (await base.call({ session: 's-02' })) as { content: { text: string }[] };
    const before = JSON.stringify(input);
    const a = decodeGetMap({ session: 's-02' }, input);
    expect(JSON.stringify(input)).toBe(before);
    input.content[0]!.text = 'changed afterwards';
    const v = branchOf(a, 'session');
    expect(v.session.id).toBe('s-02');
    expect(() => { (v.session as { id: string }).id = 'x'; }).toThrow(TypeError);
    expect(() => { (v.session.artifacts as unknown[]).push(1); }).toThrow(TypeError);
    expect(Object.isFrozen(a)).toBe(true);
    expect(decodeGetMap({ session: 's-02' }, JSON.parse(before))).toEqual(a);
  });

  it('a hostile envelope with an accessor or a proxy is refused without running caller code', () => {
    let reads = 0;
    const accessor = { get content() { reads++; return [{ type: 'text', text: '{}' }]; } };
    expect(invalidCode(decodeGetMap({}, accessor))).toBe('result-not-strict-json');
    const proxy = new Proxy({ content: [] }, { get() { reads++; throw new Error('trap'); }, ownKeys() { reads++; throw new Error('trap'); } });
    expect(invalidCode(decodeGetMap({}, proxy))).toBe('result-not-strict-json');
    expect(reads).toBe(0);
  });
});

describe('assessment join and unwrap helpers', () => {
  it('partial outranks unknown, both outrank complete, and nothing lowers', () => {
    const all: Assessment[] = ['complete', 'unknown', 'partial'];
    for (const a of all) for (const b of all) {
      const j = joinAssessment(a, b);
      expect(joinAssessment(b, a)).toBe(j);
      if (a === 'partial' || b === 'partial') expect(j).toBe('partial');
      else if (a === 'unknown' || b === 'unknown') expect(j).toBe('unknown');
      else expect(j).toBe('complete');
    }
  });

  it('unwrapMcpResult returns the text of exactly one text item, or the original error, or a fixed code', () => {
    const none = { resultFields: {}, itemFields: {} };
    expect(unwrapMcpResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ kind: 'text', text: 'hi', extras: none });
    const err = { content: [{ type: 'text', text: 'bad' }], isError: true };
    expect(unwrapMcpResult(err)).toEqual({ kind: 'tool-error', result: err });
    expect(unwrapMcpResult({ content: [{ type: 'text', text: 'hi' }], isError: false })).toEqual({ kind: 'text', text: 'hi', extras: none });
    expect(unwrapMcpResult({ content: [{ type: 'text', text: 'hi', _meta: { a: 1 } }], _meta: { b: 2 } })).toEqual({ kind: 'text', text: 'hi', extras: { resultFields: { _meta: { b: 2 } }, itemFields: { _meta: { a: 1 } } } });
    expect(unwrapMcpResult({})).toEqual({ kind: 'invalid', code: 'unexpected-envelope' });
  });
});


// ----- r2: lossless shape (F1, F2) and host-side envelope extras (F3) -----

/** Every primitive and every empty container of a JSON value as `path=json`; `lift` removes the `unknownFields` wrappers. */
function pairs(value: unknown, lift: boolean, path = '', out = new Map<string, number>()): Map<string, number> {
  const add = (key: string): void => { out.set(key, (out.get(key) ?? 0) + 1); };
  if (Array.isArray(value)) {
    if (value.length === 0) add(`${path}=[]`);
    value.forEach((item, i) => pairs(item, lift, `${path}[${i}]`, out));
  } else if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 0) add(`${path}={}`);
    for (const key of keys) {
      const child = (value as Record<string, unknown>)[key];
      if (lift && key === 'unknownFields') pairs(child, lift, path, out);
      else pairs(child, lift, path === '' ? key : `${path}.${key}`, out);
    }
  } else {
    add(`${path}=${JSON.stringify(value)}`);
  }
  return out;
}

/** The two kinds of object whose values must all be counts: every `cut` map, and exactly `map.messages.unreadForYou.rooms`. */
const COUNT_MAP_PATH = 'map.messages.unreadForYou.rooms';

/**
 * Adds `zz: 'extra'` to every object except the count maps (every `cut`, and exactly COUNT_MAP_PATH). The exclusion is by
 * exact path, so rows of `map.rooms[]` and everything else named `rooms` are injected like any other object.
 */
function augment(value: unknown, path = '', key = ''): unknown {
  if (Array.isArray(value)) return value.map((item, i) => augment(item, `${path}[${i}]`, key));
  if (typeof value !== 'object' || value === null) return value;
  const out: Doc = {};
  for (const [childKey, child] of Object.entries(value)) out[childKey] = augment(child, path === '' ? childKey : `${path}.${childKey}`, childKey);
  if (key !== 'cut' && path !== COUNT_MAP_PATH) out['zz'] = 'extra';
  return out;
}

describe('lossless shape: nothing the source says is dropped (F1, F2)', () => {
  let rich: Scenario;
  let messageId: string;
  beforeAll(async () => {
    await scenario('Archive sibling', () => undefined);
    rich = await scenario('Rich map', (map, letters) => {
      map.work.deletedSessions = ['s-90'];
      letters.add({ roomId: 'r-01', from: 's-02', to: ['s-01'], text: 'unread for s-01', kind: 'note' });
      map.rooms[0]!.proposal = { id: 'p-01', from: 's-01', text: 'short proposal', rev: 0, at: new Date().toISOString() };
      map.plans = [{ id: 'pl-01', roomId: 'r-01', mode: 'verified', status: 'active', rev: 1, goal: 'Ship it', items: [{ id: 1, title: 'one', owner: 's-02', scope: 'x', after: [], criteria: ['it works'], verifier: null, status: 'ready', evidence: null, note: null, log: [] }], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null }];
      map.sessions[1]!.summary = 'Worker summary';
      map.sessions[1]!.summarySource = 'agent';
      map.sessions[1]!.artifacts.push({ kind: 'file', path: 'only.txt' });
    });
    const feed = JSON.parse(textOf(await base.call({ field: 'messages', room: 'r-01' }))) as { messages: { id: string }[] };
    messageId = feed.messages[0]!.id;
  });

  const forms = (): [string, () => Scenario, Record<string, unknown>][] => [
    ['map', () => rich, {}],
    ['session', () => base, { session: 's-02' }],
    ['room', () => base, { room: 'r-01' }],
    ['work-text', () => base, { field: 'goal' }],
    ['providers', () => base, { field: 'providers' }],
    ['archive', () => base, { field: 'archive' }],
    ['summaries', () => rich, { field: 'summaries' }],
    ['messages', () => base, { field: 'messages', room: 'r-01' }],
    ['message', () => base, { field: 'message', id: messageId }],
    ['session-text', () => base, { field: 'task', session: 's-01' }],
    ['context-from', () => base, { field: 'contextFrom', session: 's-01' }],
    ['history', () => base, { field: 'history', session: 's-02' }],
    ['artifacts', () => base, { field: 'artifacts', session: 's-02' }],
    ['collection:sessions', () => rich, { field: 'sessions' }],
    ['collection:rooms', () => rich, { field: 'rooms' }],
    ['collection:plans', () => rich, { field: 'plans' }],
    ['collection:deletedSessions', () => rich, { field: 'deletedSessions' }],
    ['collection:unreadRooms', () => rich, { field: 'unreadRooms' }],
    ['plan', () => rich, { field: 'plan', id: 'pl-01', rev: 1 }],
  ];
  const formNames = (): string[] => forms().map(([label]) => label);
  const formOf = (label: string): { which: Scenario; args: Record<string, unknown>; branch: GetMapBranch } => {
    const [, which, args] = forms().find(([l]) => l === label)!;
    return { which: which(), args, branch: selectGetMapBranch(args)! };
  };

  it('covers all fifteen branches and all five collection fields', () => {
    expect(forms().map(([, , args]) => selectGetMapBranch(args))).toHaveLength(19);
    expect([...new Set(forms().map(([, , args]) => selectGetMapBranch(args)))].sort()).toEqual([...GET_MAP_BRANCHES].sort());
    expect(formNames().filter((n) => n.startsWith('collection:')).map((n) => n.slice(11)).sort()).toEqual([...ROW_FIELDS].sort());
  });

  it.each(formNames())('%s: every source property is in the value at the same path (unknownFields unwrapped)', async (label) => {
    const { which, args, branch } = formOf(label);
    const source = await which.call(args);
    const sourceJson = JSON.parse(textOf(source)) as unknown;
    const d = decodeGetMap(args, source);
    const value = branchOf(d, branch);
    const got = pairs(JSON.parse(JSON.stringify(value)), true);
    for (const [pair, count] of pairs(sourceJson, false)) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
  });

  it.each(formNames())('%s: an extra key injected into every object survives at its own path', async (label) => {
    const { which, args, branch } = formOf(label);
    const source = await which.call(args);
    const injected = augment(JSON.parse(textOf(source))) as Doc;
    if (branch === 'room') injected['room'].recipe = augment({ id: 'rc', name: 'Recipe' });
    const d = decodeGetMap(args, withText(source, JSON.stringify(injected)));
    const value = branchOf(d, branch);
    const got = pairs(JSON.parse(JSON.stringify(value)), true);
    const want = pairs(injected, false);
    for (const [pair, count] of want) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
    expect([...want.keys()].some((k) => k.endsWith('.zz="extra"') || k === 'zz="extra"')).toBe(true);
    if (branch === 'map') {
      // rows of every collection, the collections object and each of its pages are injected; only the count maps are not
      for (const key of ['map.rooms[0].zz="extra"', 'map.rooms[0].proposal.zz="extra"', 'map.sessions[1].zz="extra"', 'map.plans[0].zz="extra"', 'map.messages.direct.zz="extra"', 'map.collections.zz="extra"', 'map.collections.sessions.zz="extra"', 'map.collections.unreadRooms.zz="extra"', 'map.work.zz="extra"']) expect(want.has(key), key).toBe(true);
      expect(want.has('map.messages.unreadForYou.rooms.zz="extra"')).toBe(false);
      expect(want.has('map.messages.unreadForYou.zz="extra"')).toBe(true);
    }
    if (branch === 'room') expect(want.has('room.recipe.zz="extra"')).toBe(true);
    if (branch === 'collection') for (const key of ['items[0].zz="extra"', 'page.zz="extra"', 'zz="extra"']) expect(want.has(key), key).toBe(true);
  });

  it('map: an extra key on map.rooms[0] and inside its proposal summary is kept under the row unknownFields at exactly those places', async () => {
    const source = await rich.call({});
    const d = decodeGetMap({}, mutateJson(source, (j) => { j['map'].rooms[0].zz = 'row'; j['map'].rooms[0].proposal.zz = 'proposal'; j['map'].rooms[0].proposal.keep = { n: [1] }; }));
    const row = branchOf(d, 'map').map.rooms[0]!;
    expect(row.unknownFields['zz']).toBe('row');
    // a v3 room row summarizes its proposal ({id, rev, kind, ...}); the whole summary is an unmodeled field and keeps every key
    expect(row.unknownFields['proposal']).toMatchObject({ id: 'p-01', rev: 0, kind: 'decision', zz: 'proposal', keep: { n: [1] } });
    // the modeled key stays out of unknownFields
    expect(Object.keys(row.unknownFields)).not.toContain('id');
    expect(row.unknownFields['title']).toBe('Fixtures room');
  });

  it('map: the count maps stay counts: a non-count value in unreadForYou.rooms or a cut map is a shape mismatch', async () => {
    const source = await rich.call({});
    expect(invalidCode(decodeGetMap({}, mutateJson(source, (j) => { j['map'].messages.unreadForYou.rooms.zz = 'extra'; })))).toBe('shape-mismatch');
    expect(invalidCode(decodeGetMap({}, mutateJson(source, (j) => { j['map'].work.cut = { zz: 'extra' }; })))).toBe('shape-mismatch');
  });

  it('F1: unknown keys inside message.room and room.recipe are kept at exactly those places', async () => {
    const feed = await base.call({ field: 'messages', room: 'r-01' });
    const m = decodeGetMap({ field: 'messages', room: 'r-01' }, mutateJson(feed, (j) => { j['messages'][0].room.extraRoom = { a: 1 }; j['messages'][1].room.other = 'o'; }));
    const mv = branchOf(m, 'messages');
    expect(mv.messages[0]!.room).toEqual({ id: 'r-01', title: 'Fixtures room', unknownFields: { extraRoom: { a: 1 } } });
    expect(mv.messages[1]!.room!.unknownFields).toEqual({ other: 'o' });
    expect(mv.messages[2]!.room!.unknownFields).toEqual({});

    const room = await base.call({ room: 'r-01' });
    const r = decodeGetMap({ room: 'r-01' }, mutateJson(room, (j) => { j['room'].recipe = { id: 'rc', name: 'Recipe', playbook: 'kept' }; }));
    expect(branchOf(r, 'room').room.recipe).toEqual({ id: 'rc', name: 'Recipe', unknownFields: { playbook: 'kept' } });
  });

  it('F1: a null room of a direct message and a null recipe stay null', async () => {
    const direct = branchOf(await base.decode({ field: 'messages' }), 'messages');
    expect(direct.messages[0]!.room).toBeNull();
    expect(branchOf(await base.decode({ room: 'r-01' }), 'room').room.recipe).toBeNull();
  });

  it('F2: contextFrom, history and artifacts return the source `field`', async () => {
    expect(branchOf(await base.decode({ field: 'contextFrom', session: 's-01' }), 'context-from').field).toBe('contextFrom');
    expect(branchOf(await base.decode({ field: 'history', session: 's-02' }), 'history').field).toBe('history');
    expect(branchOf(await base.decode({ field: 'artifacts', session: 's-02' }), 'artifacts').field).toBe('artifacts');
  });
});

describe('envelope extras are kept host-side and never reach the guest value (F3)', () => {
  it('result-level and item-level extras are retained verbatim, frozen, outside the ReadResult', async () => {
    const real = (await base.call({ field: 'goal' })) as { content: { type: string; text: string }[] };
    const extra = {
      content: [{ ...real.content[0]!, annotations: { audience: ['user'] }, _meta: { n: 1 } }],
      _meta: { trace: 'abc' },
      structuredContent: { goal: 'ignored by the decoder' },
    };
    const d = decodeGetMap({ field: 'goal' }, extra);
    expect(branchOf(d, 'work-text')).toMatchObject({ text: 'Short goal', complete: true });
    expect(d.assessment).toBe('complete');
    expect(d.envelopeUnknown).toEqual({
      resultFields: { _meta: { trace: 'abc' }, structuredContent: { goal: 'ignored by the decoder' } },
      itemFields: { annotations: { audience: ['user'] }, _meta: { n: 1 } },
    });
    expect(Object.isFrozen(d.envelopeUnknown)).toBe(true);
    expect(Object.isFrozen(d.envelopeUnknown.resultFields)).toBe(true);
    expect(Object.isFrozen(d.envelopeUnknown.itemFields['annotations'])).toBe(true);
    // the guest-facing union has none of it
    const guest = JSON.stringify(d.result);
    for (const leaked of ['trace', 'abc', 'audience', 'ignored by the decoder', 'envelopeUnknown']) expect(guest).not.toContain(leaked);
    expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
  });

  it('structuredContent is never parsed: it cannot change the decoded value or the assessment', async () => {
    const real = (await base.call({ session: 's-01' })) as object;
    const plain = decodeGetMap({ session: 's-01' }, real);
    const withStructured = decodeGetMap({ session: 's-01' }, { ...real, structuredContent: { session: { id: 'someone-else', history: [], artifacts: [] } } });
    expect(withStructured.result).toEqual(plain.result);
    expect(withStructured.assessment).toBe(plain.assessment);
  });

  it('a plain success has empty extras; so do tool errors and invalid outputs whose envelope was never accepted', async () => {
    const empty = { resultFields: {}, itemFields: {} };
    expect((await base.decode({})).envelopeUnknown).toEqual(empty);
    const err = decodeGetMap({}, { content: [{ type: 'text', text: 'boom' }], isError: true, _meta: { a: 1 } });
    expect(err.envelopeUnknown).toEqual(empty);
    expect(err.result).toEqual({ ok: false, error: { kind: 'tool-error', result: { content: [{ type: 'text', text: 'boom' }], isError: true, _meta: { a: 1 } } } });
    expect(decodeGetMap({}, { content: [] }).envelopeUnknown).toEqual(empty);
  });

  it('extras are kept even when the text then fails to decode (host evidence), and still refused shapes stay refused', async () => {
    const bad = decodeGetMap({}, { content: [{ type: 'text', text: 'not json', _meta: { k: 1 } }], _meta: { r: 1 } });
    expect(invalidCode(bad)).toBe('text-not-strict-json');
    expect(bad.envelopeUnknown).toEqual({ resultFields: { _meta: { r: 1 } }, itemFields: { _meta: { k: 1 } } });
    const real = (await base.call({})) as { content: unknown[] };
    for (const refused of [
      { ...real, isError: 'no' },
      { content: [...real.content, ...real.content], _meta: {} },
      { content: [], _meta: {} },
      { content: [{ type: 'image', text: textOf(real), _meta: {} }] },
      { content: [{ type: 'text', text: 7 }] },
      { content: [{ text: textOf(real) }] },
    ]) expect(invalidCode(decodeGetMap({}, refused))).toBe('unexpected-envelope');
  });

  it('extras must themselves be strict JSON; the error payload of a failing call is unchanged', async () => {
    const real = (await base.call({})) as { content: unknown[] };
    expect(invalidCode(decodeGetMap({}, { ...real, _meta: { n: Number.NaN } }))).toBe('result-not-strict-json');
    const failing = await base.call({ room: 'r-99' });
    const d = decodeGetMap({ room: 'r-99' }, failing);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
    expect(d.assessment).toBe('unknown');
  });
});

// ----- T6-read_room -----

const seqOf = (id: string): number => Number(id.slice(2)); // ids are zero padded: m-01, m-130
const roomOk = (d: Decoded<ReadRoomValue>): ReadRoomValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const roomCode = (d: Decoded<ReadRoomValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};

describe('read_room: request selection (the request decides what a success must look like)', () => {
  it.each<[string, unknown, { room: string; maxItems: number; cursor: { dir: 'before' | 'after'; seq: number } | null } | null]>([
    ['room only', { room: 'r-01' }, { room: 'r-01', maxItems: 50, cursor: null }],
    ['limit 3', { room: 'r-01', limit: 3 }, { room: 'r-01', maxItems: 3, cursor: null }],
    ['limit 0 is raised to 1', { room: 'r-01', limit: 0 }, { room: 'r-01', maxItems: 1, cursor: null }],
    ['a negative limit is raised to 1', { room: 'r-01', limit: -4 }, { room: 'r-01', maxItems: 1, cursor: null }],
    ['a fractional limit is floored', { room: 'r-01', limit: 2.9 }, { room: 'r-01', maxItems: 2, cursor: null }],
    ['a huge limit stops at 100', { room: 'r-01', limit: 1e9 }, { room: 'r-01', maxItems: 100, cursor: null }],
    ['an explicit undefined is the default', { room: 'r-01', limit: undefined, cursor: undefined, maxBytes: undefined }, { room: 'r-01', maxItems: 50, cursor: null }],
    ['before cursor', { room: 'r-01', cursor: 'before:12' }, { room: 'r-01', maxItems: 50, cursor: { dir: 'before', seq: 12 } }],
    ['after cursor with 0', { room: 'r-01', cursor: 'after:0' }, { room: 'r-01', maxItems: 50, cursor: { dir: 'after', seq: 0 } }],
    ['twelve digit cursor', { room: 'r-01', cursor: 'before:123456789012' }, { room: 'r-01', maxItems: 50, cursor: { dir: 'before', seq: 123456789012 } }],
    ['an empty cursor is no cursor', { room: 'r-01', cursor: '' }, { room: 'r-01', maxItems: 50, cursor: null }],
    ['maxBytes of any finite size is accepted (the handler clamps it)', { room: 'r-01', maxBytes: 100 }, { room: 'r-01', maxItems: 50, cursor: null }],
    ['unknown keys are ignored by the handler', { room: 'r-01', foo: 1, kind: 'note' }, { room: 'r-01', maxItems: 50, cursor: null }],
    ['no room', {}, null],
    ['an empty room', { room: '' }, null],
    ['a non-string room', { room: 7 }, null],
    ['a string limit', { room: 'r-01', limit: '5' }, null],
    ['a null limit', { room: 'r-01', limit: null }, null],
    ['a NaN limit', { room: 'r-01', limit: Number.NaN }, null],
    ['an infinite limit', { room: 'r-01', limit: Number.POSITIVE_INFINITY }, null],
    ['a non-string cursor', { room: 'r-01', cursor: 7 }, null],
    ['a null cursor', { room: 'r-01', cursor: null }, null],
    ['a bad cursor', { room: 'r-01', cursor: 'bogus' }, null],
    ['a cursor without a number', { room: 'r-01', cursor: 'before:' }, null],
    ['a thirteen digit cursor', { room: 'r-01', cursor: 'before:1234567890123' }, null],
    ['a topology cursor', { room: 'r-01', cursor: 'topology:abc' }, null],
    ['an offset cursor', { room: 'r-01', cursor: 'offset:1:abcdefabcdef' }, null],
    ['an upper-case cursor', { room: 'r-01', cursor: 'BEFORE:3' }, null],
    ['a padded cursor', { room: 'r-01', cursor: ' before:3' }, null],
    ['a string maxBytes', { room: 'r-01', maxBytes: '4096' }, null],
    ['a null maxBytes', { room: 'r-01', maxBytes: null }, null],
    ['a NaN maxBytes', { room: 'r-01', maxBytes: Number.NaN }, null],
  ])('%s', (_label, args, expected) => {
    expect(selectReadRoomRequest(args)).toEqual(expected);
  });

  it('refuses a request that is not a plain object', () => {
    for (const bad of [null, undefined, 'r-01', 7, [], [{ room: 'r-01' }]]) expect(selectReadRoomRequest(bad)).toBeNull();
  });
});

describe('read_room from the real handler', () => {
  let rr: Scenario;
  const call = (args: Record<string, unknown>, sessionId?: string): Promise<unknown> => rr.tool('read_room', args, sessionId);
  const decode = async (args: Record<string, unknown>, sessionId?: string): Promise<Decoded<ReadRoomValue>> => decodeReadRoom(args, await call(args, sessionId));
  let newest: unknown;
  let forward: unknown;
  let cutPage: unknown;
  const NEWEST = { room: 'r-01', limit: 5 };
  const FORWARD = { room: 'r-01', cursor: 'after:0', limit: 5 };
  const CUT = { room: 'r-05', maxBytes: 2048 };

  beforeAll(async () => {
    rr = await scenario('Room feed fixtures', (map, letters) => {
      addSession(map, { provider: 'claude', label: 'outsider', task: 'Not in any room' });
      for (const title of ['Second room', 'Kinds room', 'Empty room', 'Long room']) addRoom(map, { title, creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
      for (let i = 0; i < 130; i++) {
        letters.add({ roomId: 'r-01', from: 's-02', to: [], text: `bulk ${i}`, kind: 'note' });
        if (i % 10 === 0) letters.add({ roomId: 'r-02', from: 's-02', to: [], text: `other ${i}`, kind: 'note' });
      }
      const first = letters.add({ roomId: 'r-03', from: 's-02', to: [], text: 'to everyone', kind: 'note' });
      letters.add({ roomId: 'r-03', from: 's-01', to: [], text: 'a decision', kind: 'decision', replyTo: first.id });
      letters.add({ roomId: 'r-03', from: 's-01', to: ['s-02'], text: 'only for the worker', kind: 'note' });
      letters.add({ roomId: 'r-03', from: HUMAN, to: [], text: 'sent through the assistant', kind: 'question', via: 'assistant' });
      letters.add({ roomId: 'r-05', from: 's-02', to: [], text: 'Z'.repeat(9000), kind: 'note' });
    });
    newest = await call(NEWEST);
    forward = await call(FORWARD);
    cutPage = await call(CUT);
  });

  describe('pages', () => {
    it('the newest page: ascending, all of the room, a backward cursor, partial because older messages exist', async () => {
      const d = await decode({ room: 'r-01' });
      const v = roomOk(d);
      expect(v.messages).toHaveLength(50);
      expect(v.page).toMatchObject({ total: 130, returned: 50, complete: false, cut: 0 });
      expect(v.page.next).toBe(`before:${seqOf(v.messages[0]!.id)}`);
      expect(v.messages.at(-1)!.text).toBe('bulk 129');
      expect(v.messages.every((m) => m.room?.id === 'r-01' && m.room.title === 'Fixtures room')).toBe(true);
      const seqs = v.messages.map((m) => seqOf(m.id));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(d.assessment).toBe('partial');
    });

    it('reading backwards with the real cursors returns every message once, partial until the last page, which is complete', async () => {
      const seen: string[] = [];
      let args: Record<string, unknown> = { room: 'r-01', limit: 40 };
      let finalAssessment: Assessment | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const d = await decode(args);
        const v = roomOk(d);
        seen.unshift(...v.messages.map((m) => m.id));
        if (v.page.next === null) { finalAssessment = d.assessment; break; }
        expect(d.assessment).toBe('partial');
        args = { ...args, cursor: v.page.next };
      }
      expect(seen).toHaveLength(130);
      expect(new Set(seen).size).toBe(130);
      expect(seen.map(seqOf)).toEqual([...seen.map(seqOf)].sort((a, b) => a - b));
      expect(finalAssessment).toBe('complete');
    });

    it('reading forwards from after:0 returns every message once, with after: cursors, and ends complete', async () => {
      const seen: string[] = [];
      let args: Record<string, unknown> = { room: 'r-01', limit: 60, cursor: 'after:0' };
      let finalAssessment: Assessment | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const d = await decode(args);
        const v = roomOk(d);
        seen.push(...v.messages.map((m) => m.id));
        if (v.page.next === null) { finalAssessment = d.assessment; break; }
        expect(v.page.next).toBe(`after:${seqOf(v.messages.at(-1)!.id)}`);
        args = { ...args, cursor: v.page.next };
      }
      expect(seen).toHaveLength(130);
      expect(new Set(seen).size).toBe(130);
      expect(seen.map(seqOf)).toEqual([...seen.map(seqOf)].sort((a, b) => a - b));
      expect(finalAssessment).toBe('complete');
    });

    it.each([[3, 3], [0, 1], [-5, 1], [2.9, 2], [500, 100]])('limit %s returns %s messages', async (limit, count) => {
      const d = await decode({ room: 'r-01', limit });
      expect(roomOk(d).messages).toHaveLength(count);
      expect(d.assessment).toBe('partial');
    });

    it('a small maxBytes ends the page early with a cursor; the page still decodes', async () => {
      const d = await decode({ room: 'r-01', maxBytes: 2048 });
      const v = roomOk(d);
      expect(v.messages.length).toBeLessThan(50);
      expect(v.page.complete).toBe(false);
      expect(d.assessment).toBe('partial');
    });

    it('a short room is read whole: complete, with the typed message fields (replyTo, toEveryone, kind) and via kept as unmodeled', async () => {
      const d = await decode({ room: 'r-03' });
      const v = roomOk(d);
      expect(d.assessment).toBe('complete');
      expect(v.page).toMatchObject({ total: 4, returned: 4, complete: true, next: null, cut: 0 });
      const [everyone, decision, directed, assistant] = v.messages;
      expect(everyone).toMatchObject({ from: 's-02', fromLabel: 'worker', kind: 'note', toEveryone: true, text: 'to everyone' });
      expect(everyone!.replyTo).toBeUndefined();
      expect(decision).toMatchObject({ kind: 'decision', replyTo: everyone!.id, toEveryone: true });
      expect(directed!.toEveryone).toBeUndefined();
      expect(directed).toMatchObject({ from: 's-01', fromLabel: 'lead' });
      expect(assistant).toMatchObject({ from: 'human', kind: 'question', unknownFields: { via: 'assistant' } });
    });

    it('an empty room is a complete empty page', async () => {
      const d = await decode({ room: 'r-04' });
      expect(roomOk(d).messages).toEqual([]);
      expect(roomOk(d).page).toMatchObject({ total: 0, returned: 0, complete: true, next: null });
      expect(d.assessment).toBe('complete');
    });

    it('a shortened message: textBytes names the full size, page.cut counts it, and that alone makes the page partial', async () => {
      const d = decodeReadRoom(CUT, cutPage);
      const v = roomOk(d);
      expect(v.page).toMatchObject({ total: 1, returned: 1, complete: true, next: null, cut: 1 });
      expect(v.messages[0]!.textBytes).toBe(9000);
      expect(Buffer.byteLength(v.messages[0]!.text, 'utf8')).toBeLessThan(9000);
      expect(v.messages[0]!.unknownFields).not.toHaveProperty('textBytes');
      expect(d.assessment).toBe('partial');
    });

    it('a call as the lead and as the worker sees the same room', async () => {
      const lead = roomOk(await decode(NEWEST, 's-01')).messages.map((m) => m.id);
      const worker = roomOk(await decode(NEWEST, 's-02')).messages.map((m) => m.id);
      expect(worker).toEqual(lead);
    });
  });

  describe('errors are data', () => {
    it.each<[string, Record<string, unknown>, string | undefined]>([
      ['a session outside the room', { room: 'r-01' }, 's-03'],
      ['an unknown room', { room: 'r-99' }, undefined],
      ['an invalid cursor', { room: 'r-01', cursor: 'sideways:3' }, undefined],
      ['a non-numeric limit', { room: 'r-01', limit: 'many' }, undefined],
      ['an empty room id', { room: '' }, undefined],
      ['no room', {}, undefined],
      ['a null cursor (optionalString, tools.ts:743, throws on null)', { room: 'r-01', cursor: null }, undefined],
      ['a null limit', { room: 'r-01', limit: null }, undefined],
      ['a null maxBytes', { room: 'r-01', maxBytes: null }, undefined],
      ['a numeric cursor', { room: 'r-01', cursor: 7 }, undefined],
    ])('%s: the handler error comes back whole, the assessment is unknown', async (_label, args, sessionId) => {
      const failing = await call(args, sessionId);
      expect((failing as { isError?: boolean }).isError).toBe(true);
      const d = decodeReadRoom(args, failing);
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
      expect(d.assessment).toBe('unknown');
    });

    it('a tool error is returned before the request is looked at', async () => {
      const failing = await call({ room: 'r-99' });
      expect(decodeReadRoom({ room: 7 }, failing).result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
    });

    it('a success for a request the handler would refuse has no branch', async () => {
      for (const bad of [{}, { room: '' }, { room: 7 }, { room: 'r-01', limit: '5' }, { room: 'r-01', cursor: 'bogus' }, { room: 'r-01', maxBytes: '1' }, null, 'r-01'])
        expect(roomCode(decodeReadRoom(bad, newest))).toBe('unknown-request-branch');
    });

    it('malformed envelopes and texts have fixed codes', async () => {
      expect(roomCode(decodeReadRoom(NEWEST, { content: [] }))).toBe('unexpected-envelope');
      expect(roomCode(decodeReadRoom(NEWEST, withText(newest, 'not json')))).toBe('text-not-strict-json');
      expect(roomCode(decodeReadRoom(NEWEST, withText(newest, '{"messages":[],"messages":[],"page":{}}')))).toBe('text-not-strict-json');
      expect(roomCode(decodeReadRoom(NEWEST, { ...(newest as object), _meta: { n: Number.NaN } }))).toBe('result-not-strict-json');
      const bad = decodeReadRoom(NEWEST, withText(newest, '[]'));
      expect(roomCode(bad)).toBe('shape-mismatch');
      expect(bad.assessment).toBe('unknown');
    });
  });

  describe('a response that contradicts the request or itself is invalid output, never an empty success', () => {
    const fromNewest = (change: (j: Doc) => void): Decoded<ReadRoomValue> => decodeReadRoom(NEWEST, mutateJson(newest, change));
    const fromForward = (change: (j: Doc) => void): Decoded<ReadRoomValue> => decodeReadRoom(FORWARD, mutateJson(forward, change));
    const fromCut = (change: (j: Doc) => void): Decoded<ReadRoomValue> => decodeReadRoom(CUT, mutateJson(cutPage, change));

    it.each<[string, (j: Doc) => void, string]>([
      ['a message of another room', (j) => { j['messages'][2].room.id = 'r-02'; }, 'echo-mismatch'],
      ['a message without a room', (j) => { j['messages'][2].room = null; }, 'echo-mismatch'],
      ['returned larger than the messages', (j) => { j['page'].returned += 1; }, 'page-invariant'],
      ['returned smaller than the messages', (j) => { j['page'].returned -= 1; }, 'page-invariant'],
      ['the first two messages swapped', (j) => { j['messages'].splice(0, 2, j['messages'][1], j['messages'][0]); }, 'page-invariant'],
      ['a repeated message', (j) => { j['messages'][1] = j['messages'][0]; }, 'page-invariant'],
      ['a message id that is not m-N', (j) => { j['messages'][1].id = 'x-5'; }, 'shape-mismatch'],
      ['a message id m-0', (j) => { j['messages'][1].id = 'm-0'; }, 'shape-mismatch'],
      ['a message id m-00', (j) => { j['messages'][1].id = 'm-00'; }, 'shape-mismatch'],
      ['a message id without a number', (j) => { j['messages'][1].id = 'm-'; }, 'shape-mismatch'],
      ['a message id with a sign', (j) => { j['messages'][1].id = 'm--5'; }, 'shape-mismatch'],
      ['a next that is not the oldest message of the page', (j) => { j['page'].next = 'before:1'; }, 'page-invariant'],
      ['a forward next on a backward page', (j) => { j['page'].next = `after:${seqOf(j['messages'].at(-1).id)}`; }, 'page-invariant'],
      ['a topology cursor as next', (j) => { j['page'].next = 'topology:abc'; }, 'page-invariant'],
      ['an offset cursor as next', (j) => { j['page'].next = 'offset:5:abcdefabcdef'; }, 'page-invariant'],
      ['complete with a next', (j) => { j['page'].complete = true; }, 'page-invariant'],
      ['not complete without a next', (j) => { j['page'].next = null; }, 'page-invariant'],
      ['total below returned', (j) => { j['page'].total = 4; }, 'page-invariant'],
      ['a null total', (j) => { j['page'].total = null; }, 'shape-mismatch'],
      ['a string total', (j) => { j['page'].total = '130'; }, 'shape-mismatch'],
      ['cut without a shortened message', (j) => { j['page'].cut = 1; }, 'page-invariant'],
      ['textBytes on a page whose cut is 0', (j) => { j['messages'][0].textBytes = 9999; }, 'page-invariant'],
      ['a negative textBytes', (j) => { j['messages'][0].textBytes = -1; j['page'].cut = 1; }, 'shape-mismatch'],
      ['a string textBytes', (j) => { j['messages'][0].textBytes = '9'; j['page'].cut = 1; }, 'shape-mismatch'],
      ['messages that is an object', (j) => { j['messages'] = {}; }, 'shape-mismatch'],
      ['a missing page', (j) => { delete j['page']; }, 'shape-mismatch'],
      ['a page that is an array', (j) => { j['page'] = []; }, 'shape-mismatch'],
      ['a message without text', (j) => { delete j['messages'][0].text; }, 'shape-mismatch'],
      ['a numeric from', (j) => { j['messages'][0].from = 7; }, 'shape-mismatch'],
      ['a non-boolean toEveryone', (j) => { j['messages'][0].toEveryone = 'yes'; }, 'shape-mismatch'],
      ['an empty page that still has a next', (j) => { j['messages'] = []; j['page'].returned = 0; }, 'page-invariant'],
    ])('newest page: %s', (_label, change, code) => {
      expect(roomCode(fromNewest(change))).toBe(code);
    });

    it.each<[string, (j: Doc) => void, string]>([
      ['a backward next on a forward page', (j) => { j['page'].next = `before:${seqOf(j['messages'][0].id)}`; }, 'page-invariant'],
      ['a forward next that skips the last message', (j) => { j['page'].next = `after:${seqOf(j['messages'][0].id)}`; }, 'page-invariant'],
    ])('forward page: %s', (_label, change, code) => {
      expect(roomCode(fromForward(change))).toBe(code);
    });

    it.each<[string, (j: Doc) => void]>([
      ['textBytes removed from the shortened message', (j) => { delete j['messages'][0].textBytes; }],
      ['cut set to 0 beside a shortened message', (j) => { j['page'].cut = 0; }],
      ['cut set to 2 for one shortened message', (j) => { j['page'].cut = 2; }],
    ])('shortened page: %s', (_label, change) => {
      expect(roomCode(fromCut(change))).toBe('page-invariant');
    });

    it('the request bounds the response: limit, direction, cursor bound and room', () => {
      const seqs = (raw: unknown): number[] => (JSON.parse(textOf(raw)) as { messages: { id: string }[] }).messages.map((m) => seqOf(m.id));
      const back = seqs(newest);
      const fwd = seqs(forward);
      expect(roomOk(decodeReadRoom(NEWEST, newest)).messages).toHaveLength(5);
      // limit: five messages cannot answer limit 2, nor limit 0 (raised to 1)
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 2 }, newest))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 0 }, newest))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 4 }, newest))).toBe('page-invariant');
      // room
      expect(roomCode(decodeReadRoom({ room: 'r-02', limit: 5 }, newest))).toBe('echo-mismatch');
      // before:N is a strict bound: the oldest message of the page equals N here
      expect(roomCode(decodeReadRoom({ ...NEWEST, cursor: `before:${back[0]}` }, newest))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ ...NEWEST, cursor: `before:${back.at(-1)}` }, newest))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ ...NEWEST, cursor: 'before:3' }, newest))).toBe('page-invariant');
      expect(roomOk(decodeReadRoom({ ...NEWEST, cursor: `before:${back.at(-1)! + 1}` }, newest)).messages).toHaveLength(5);
      // after:N is a strict bound too
      expect(roomCode(decodeReadRoom({ ...FORWARD, cursor: `after:${fwd[0]}` }, forward))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ ...FORWARD, cursor: 'after:99999' }, forward))).toBe('page-invariant');
      expect(roomOk(decodeReadRoom({ ...FORWARD, cursor: `after:${fwd[0]! - 1}` }, forward)).messages).toHaveLength(5);
      // direction: the cursor family of `next` follows the request, and no cursor reads backwards
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 5, cursor: 'after:0' }, newest))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 5 }, forward))).toBe('page-invariant');
      expect(roomCode(decodeReadRoom({ room: 'r-01', limit: 5, cursor: 'before:99999' }, forward))).toBe('page-invariant');
    });

    it('total above returned on a complete page is accepted: a letter may arrive between the count and the read', async () => {
      const source = await call({ room: 'r-03' });
      const d = decodeReadRoom({ room: 'r-03' }, mutateJson(source, (j) => { j['page'].total += 3; }));
      expect(roomOk(d).page.total).toBe(7);
      expect(d.assessment).toBe('complete');
    });

    it('an empty page names no room, so it cannot prove the room asked for (limitation kept visible)', async () => {
      const source = await call({ room: 'r-04' });
      expect(roomOk(decodeReadRoom({ room: 'r-05' }, source)).messages).toEqual([]);
    });
  });

  describe('each completeness signal counts on its own', () => {
    it('only an incomplete page: partial', async () => {
      const d = decodeReadRoom(NEWEST, newest);
      expect(roomOk(d).page).toMatchObject({ complete: false, cut: 0 });
      expect(d.assessment).toBe('partial');
    });
    it('only a shortened message: partial', () => {
      const d = decodeReadRoom(CUT, cutPage);
      expect(roomOk(d).page).toMatchObject({ complete: true, cut: 1 });
      expect(d.assessment).toBe('partial');
    });
    it('neither: complete', async () => {
      const d = await decode({ room: 'r-03' });
      expect(roomOk(d).page).toMatchObject({ complete: true, cut: 0 });
      expect(d.assessment).toBe('complete');
    });
    it('both: partial', async () => {
      const d = await decode({ room: 'r-05', maxBytes: 2048, limit: 1 });
      expect(d.assessment).toBe('partial');
    });
    it('text that looks cut or incomplete changes nothing without the structured mark', async () => {
      const source = await call({ room: 'r-03' });
      const d = decodeReadRoom({ room: 'r-03' }, mutateJson(source, (j) => { j['messages'][0].text = 'truncated … [cut] more follows'; }));
      expect(d.assessment).toBe('complete');
    });
  });

  describe('unknown fields are kept at every depth, and the guest value stays apart from the host assessment', () => {
    it('top level, page, message and message.room keep their unknown keys; typed keys are not repeated there', async () => {
      const source = await call({ room: 'r-03' });
      const d = decodeReadRoom({ room: 'r-03' }, mutateJson(source, (j) => {
        j['zz'] = { a: [1] }; j['page'].zz = 'p'; j['messages'][1].zz = 'm'; j['messages'][1].room.zz = 'r';
      }));
      const v = roomOk(d);
      expect(v.unknownFields).toEqual({ zz: { a: [1] } });
      expect(v.page.unknownFields).toEqual({ zz: 'p' });
      expect(v.messages[1]!.unknownFields).toEqual({ zz: 'm' });
      expect(v.messages[1]!.room!.unknownFields).toEqual({ zz: 'r' });
      expect(Object.keys(v.unknownFields)).not.toContain('messages');
      expect(Object.keys(v.messages[1]!.unknownFields)).not.toContain('text');
    });

    it('the guest value has no assessment and no host fields; the result is frozen all the way down', async () => {
      const d = await decode({ room: 'r-03' });
      expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
      expect(JSON.stringify(d.result)).not.toContain('assessment');
      const v = roomOk(d);
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.isFrozen(v.messages)).toBe(true);
      expect(Object.isFrozen(v.messages[0]!.room)).toBe(true);
      expect(Object.isFrozen(v.page)).toBe(true);
    });

    it('envelope extras stay host-side; structuredContent is never read', async () => {
      const real = (await call({ room: 'r-03' })) as { content: { type: string; text: string }[] };
      const extra = { content: [{ ...real.content[0]!, _meta: { n: 1 } }], _meta: { trace: 'abc' }, structuredContent: { messages: [], page: { total: 0, returned: 0, complete: true, next: null, bytes: 0, cut: 0 } } };
      const d = decodeReadRoom({ room: 'r-03' }, extra);
      expect(roomOk(d).messages).toHaveLength(4);
      expect(d.envelopeUnknown).toEqual({ resultFields: { _meta: { trace: 'abc' }, structuredContent: extra.structuredContent }, itemFields: { _meta: { n: 1 } } });
      for (const leaked of ['trace', 'structuredContent']) expect(JSON.stringify(d.result)).not.toContain(leaked);
    });
  });

  describe('lossless shape: nothing the source says is dropped', () => {
    const forms = (): [string, Record<string, unknown>][] => [
      ['newest page', NEWEST], ['forward page', FORWARD], ['kinds room', { room: 'r-03' }], ['empty room', { room: 'r-04' }], ['shortened page', CUT],
    ];
    it.each([0, 1, 2, 3, 4])('form %s: every source property is in the value at the same path (unknownFields unwrapped)', async (index) => {
      const [, args] = forms()[index]!;
      const source = await call(args);
      const got = pairs(JSON.parse(JSON.stringify(roomOk(decodeReadRoom(args, source)))), true);
      for (const [pair, count] of pairs(JSON.parse(textOf(source)), false)) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
    });
    it.each([0, 1, 2, 3, 4])('form %s: an extra key injected into every object survives at its own path', async (index) => {
      const [, args] = forms()[index]!;
      const source = await call(args);
      const injected = augment(JSON.parse(textOf(source))) as Doc;
      const d = decodeReadRoom(args, withText(source, JSON.stringify(injected)));
      const got = pairs(JSON.parse(JSON.stringify(roomOk(d))), true);
      const want = pairs(injected, false);
      for (const [pair, count] of want) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
      for (const key of ['zz="extra"', 'page.zz="extra"']) expect(want.has(key), key).toBe(true);
      if (index !== 3) for (const key of ['messages[0].zz="extra"', 'messages[0].room.zz="extra"']) expect(want.has(key), key).toBe(true);
    });
  });
});

// ----- T6-read_guide -----

const guideOk = (d: Decoded<ReadGuideValue>): ReadGuideValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const guideCode = (d: Decoded<ReadGuideValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};
const asMcp = (text: string): unknown => ({ content: [{ type: 'text', text }] });

describe('read_guide: request selection (the handler trims and lowercases the topic)', () => {
  it.each<[string, unknown, { topic: string | null } | null]>([
    ['no arguments: the whole guide', {}, { topic: null }],
    ['no arguments at all (the server wrapper passes {})', undefined, { topic: null }],
    ['an empty topic: the whole guide', { topic: '' }, { topic: null }],
    ['an undefined topic: the whole guide', { topic: undefined }, { topic: null }],
    ['other keys are ignored by the handler', { foo: 1, topic: 'rules' }, { topic: 'rules' }],
    ['upper case', { topic: 'LEAD' }, { topic: 'lead' }],
    ['padded and mixed case', { topic: ' Rooms ' }, { topic: 'rooms' }],
    ['tabs and newlines are trimmed', { topic: '\tletters\n' }, { topic: 'letters' }],
    ['an unknown topic', { topic: 'nope' }, null],
    ['a prefix of a topic', { topic: 'room' }, null],
    ['a whitespace-only topic is not the whole guide', { topic: '   ' }, null],
    ['a null topic', { topic: null }, null],
    ['a numeric topic', { topic: 7 }, null],
    ['an object topic', { topic: {} }, null],
    ['an array topic', { topic: ['rooms'] }, null],
  ])('%s', (_label, args, expected) => {
    expect(selectReadGuideRequest(args)).toEqual(expected);
  });

  it.each(GUIDE_TOPICS.map((item) => item.topic))('the topic %s is accepted', (topic) => {
    expect(selectReadGuideRequest({ topic })).toEqual({ topic });
  });

  it('refuses a request that is not a plain object', () => {
    for (const bad of [null, 'rules', 7, [], [{ topic: 'rules' }]]) expect(selectReadGuideRequest(bad)).toBeNull();
  });

  it('keeps its copies of the source constants equal to the source', () => {
    expect([...GUIDE_TOPIC_VALUES]).toEqual(GUIDE_TOPICS.map((item) => item.topic));
    expect(READ_GUIDE_MAX_CONTEXT_BYTES).toBe(READ_GUIDE_MAX_BYTES);
  });
});

describe('read_guide from the real handler', () => {
  const call = (args: Record<string, unknown>): Promise<unknown> => base.tool('read_guide', args);

  it('the whole guide is plain text, kept verbatim, and its completeness is unknown', async () => {
    const source = await call({});
    const d = decodeReadGuide({}, source);
    expect(guideOk(d).text).toBe(textOf(source));
    expect(guideOk(d).text.length).toBeGreaterThan(10_000);
    expect(d.assessment).toBe('unknown');
    expect(Object.keys(guideOk(d))).toEqual(['text']);
  });

  it.each(GUIDE_TOPICS.map((item) => item.topic))('the topic %s: its text, verbatim, unknown', async (topic) => {
    const source = await call({ topic });
    const d = decodeReadGuide({ topic }, source);
    expect(guideOk(d).text).toBe(textOf(source));
    expect(d.assessment).toBe('unknown');
  });

  it('works for a caller without a session, as the handler does', async () => {
    const runner = createToolRunner({ projectPath: project, workId: base.workId, workDir: workPaths(project, base.workId).dir, sessionId: null, channel: false, providerRows: async () => rows });
    const source = wire(await runner.call('read_guide', { topic: 'rules' }, undefined));
    expect(guideOk(decodeReadGuide({ topic: 'rules' }, source)).text).toBe(textOf(source));
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['no arguments', {}, true],
    ['an empty topic', { topic: '' }, true],
    ['an undefined topic', { topic: undefined }, true],
    ['an unrelated key', { foo: 1 }, true],
    ['a padded upper-case topic', { topic: ' ROOMS ' }, true],
    ['an unknown topic', { topic: 'nope' }, false],
    ['a whitespace-only topic', { topic: '   ' }, false],
    ['a null topic', { topic: null }, false],
    ['a numeric topic', { topic: 7 }, false],
    ['an object topic', { topic: {} }, false],
  ])('the selector agrees with the handler: %s', async (_label, args, accepted) => {
    const source = await call(args);
    expect((source as { isError?: boolean }).isError === true).toBe(!accepted);
    expect(selectReadGuideRequest(args) !== null).toBe(accepted);
    const d = decodeReadGuide(args, source);
    if (accepted) expect(guideOk(d).text).toBe(textOf(source));
    else {
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: source } });
      expect(d.assessment).toBe('unknown');
    }
  });

  it('a tool error is returned before the request is looked at', async () => {
    const failing = await call({ topic: 'nope' });
    expect(decodeReadGuide({ topic: 7 }, failing).result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
  });

  it('a success for a request the handler would refuse has no branch', async () => {
    const source = await call({});
    for (const bad of [{ topic: 'nope' }, { topic: '   ' }, { topic: null }, { topic: 7 }, null, 'rules']) expect(guideCode(decodeReadGuide(bad, source))).toBe('unknown-request-branch');
  });

  it('the text is never parsed as JSON: JSON-looking text, even with duplicate keys, is just text', () => {
    for (const text of ['{"a":1,"a":2}', '[]', 'null', '7', '"quoted"', '{ not json']) {
      const d = decodeReadGuide({}, asMcp(text));
      expect(guideOk(d).text).toBe(text);
      expect(d.assessment).toBe('unknown');
    }
  });

  it('the unmarked oversize fallback decodes exactly like a real guide: text with an unknown assessment', () => {
    const fallback = boundedGuide('x'.repeat(READ_GUIDE_MAX_BYTES + 1), 'The whole guide');
    expect(contextBytes(fallback)).toBeLessThan(1000);
    const d = decodeReadGuide({}, asMcp(fallback));
    expect(guideOk(d).text).toBe(fallback);
    expect(d.assessment).toBe('unknown');
  });

  it('the size rule counts JSON-escaped bytes, like the handler: the limit itself passes, one more is refused', () => {
    expect(guideOk(decodeReadGuide({}, asMcp('a'.repeat(READ_GUIDE_MAX_BYTES)))).text).toHaveLength(READ_GUIDE_MAX_BYTES);
    expect(guideCode(decodeReadGuide({}, asMcp('a'.repeat(READ_GUIDE_MAX_BYTES + 1))))).toBe('shape-mismatch');
    // a newline weighs two bytes after escaping: 32768 of them are exactly the limit, one more is over it
    expect(guideOk(decodeReadGuide({}, asMcp('\n'.repeat(READ_GUIDE_MAX_BYTES / 2)))).text).toHaveLength(READ_GUIDE_MAX_BYTES / 2);
    expect(guideCode(decodeReadGuide({}, asMcp('\n'.repeat(READ_GUIDE_MAX_BYTES / 2 + 1))))).toBe('shape-mismatch');
    // multi-byte text counts bytes, not characters
    expect(guideCode(decodeReadGuide({}, asMcp('я'.repeat(READ_GUIDE_MAX_BYTES / 2 + 1))))).toBe('shape-mismatch');
  });

  it('an empty text is no answer', () => {
    expect(guideCode(decodeReadGuide({}, asMcp('')))).toBe('shape-mismatch');
  });

  it('malformed envelopes have fixed codes; extras stay host-side; the guest value has only the text', async () => {
    expect(guideCode(decodeReadGuide({}, { content: [] }))).toBe('unexpected-envelope');
    expect(guideCode(decodeReadGuide({}, { content: [{ type: 'image', text: 'x' }] }))).toBe('unexpected-envelope');
    expect(guideCode(decodeReadGuide({}, { ...(asMcp('x') as object), _meta: { n: Number.NaN } }))).toBe('result-not-strict-json');
    const d = decodeReadGuide({ topic: 'rules' }, { content: [{ type: 'text', text: 'guide', _meta: { n: 1 } }], _meta: { trace: 'abc' } });
    expect(d.envelopeUnknown).toEqual({ resultFields: { _meta: { trace: 'abc' } }, itemFields: { _meta: { n: 1 } } });
    expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
    expect(JSON.stringify(d.result)).not.toContain('trace');
    expect(Object.isFrozen(guideOk(d))).toBe(true);
  });
});

// ----- T6-list_roles -----

const rolesOk = (d: Decoded<ListRolesValue>): ListRolesValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const rolesCode = (d: Decoded<ListRolesValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};

describe('list_roles: request selection (the handler reads no argument)', () => {
  it.each<[string, unknown, boolean]>([
    ['an empty object', {}, true],
    ['no arguments', undefined, true],
    ['unrelated keys are ignored by the handler', { topic: 'x', n: 1 }, true],
    ['null', null, false],
    ['an array', [], false],
    ['a string', 'roles', false],
    ['a number', 7, false],
  ])('%s', (_label, args, expected) => {
    expect(isListRolesRequest(args)).toBe(expected);
  });
});

describe('list_roles from the real handler and the real role discovery', () => {
  let dir: string;
  let cwd: string;
  let homeDir: string;
  let catalogs: Record<'builtin' | 'claude' | 'both' | 'broken' | 'limit' | 'duplicate' | 'carried', RoleCatalog>;
  const REVIEWER = '---\nname: reviewer\ndescription: |\n  Reviews code.\n  Cites evidence.\nmodel: SECRET_MODEL\n---\nSECRET_PROMPT';
  const AUDITOR = 'name = "auditor"\ndescription = "Audits changes"\ndeveloper_instructions = "SECRET_PROMPT"\nmodel = "gpt-test"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\n';

  const raw = async (catalog: RoleCatalog | 'throw', args: Record<string, unknown> = {}): Promise<unknown> => {
    const runner = createToolRunner({
      projectPath: project, workId: base.workId, workDir: workPaths(project, base.workId).dir, sessionId: 's-01', channel: false, providerRows: async () => rows,
      roleCatalog: async () => { if (catalog === 'throw') throw new Error('catalogue unavailable'); return catalog; },
    });
    return wire(await runner.call('list_roles', args, undefined));
  };
  const decode = async (catalog: RoleCatalog | 'throw'): Promise<Decoded<ListRolesValue>> => decodeListRoles({}, await raw(catalog));

  beforeAll(async () => {
    dir = await mkdtemp(path.join(root, 'roles-'));
    cwd = path.join(dir, 'worktree');
    homeDir = path.join(dir, 'home');
    for (const sub of ['worktree/.claude/agents', 'worktree/.codex/agents', 'home', 'broken/.claude/agents']) await mkdir(path.join(dir, sub), { recursive: true });
    await writeFile(path.join(cwd, '.claude/agents/reviewer.md'), REVIEWER);
    await writeFile(path.join(cwd, '.codex/agents/auditor.toml'), AUDITOR);
    await writeFile(path.join(dir, 'broken/.claude/agents/good.md'), '---\nname: good\ndescription: A good role\n---\nbody');
    await writeFile(path.join(dir, 'broken/.claude/agents/bad.md'), '---\nname: [unclosed\n---\nbody');
    const claude = await discoverClaudeRoles({ cwd, homeDir });
    const codex = await discoverCodexRoles({ cwd, homeDir, configLayers: [{ configFolder: path.join(cwd, '.codex'), hasDeclaredRoles: false }] });
    catalogs = {
      builtin: buildRoleCatalog(),
      claude: buildRoleCatalog(claude),
      both: buildRoleCatalog(claude, codex),
      broken: buildRoleCatalog(await discoverClaudeRoles({ cwd: path.join(dir, 'broken'), homeDir })),
      limit: buildRoleCatalog(await discoverClaudeRoles({ cwd, homeDir, limits: { maxEntries: 0 } })),
      duplicate: buildRoleCatalog(claude, claude),
      carried: buildRoleCatalog({ roles: [], diagnostics: [], partial: true }),
    };
  });

  it('builtin roles only: complete; every builtin role carries `models`; nothing else is added', async () => {
    const d = await decode(catalogs.builtin);
    const v = rolesOk(d);
    expect(v.partial).toBe(false);
    expect(v.diagnostics).toEqual([]);
    expect(v.roles.map((r) => r.id)).toEqual(BUILTIN_ROLES.map((r) => r.id).sort());
    for (const role of v.roles) {
      expect(role.source).toBe('builtin');
      expect(role.models).toMatchObject({ claude: expect.any(String), codex: expect.any(String) });
      expect(typeof role.readOnly).toBe('boolean');
    }
    expect(d.assessment).toBe('complete');
  });

  it('a native Claude role: its whitelisted fields only, no `models`, no prompt, no path; still complete', async () => {
    const d = await decode(catalogs.claude);
    const reviewer = rolesOk(d).roles.find((r) => r.id === 'claude:reviewer')!;
    expect(reviewer).toMatchObject({ name: 'reviewer', description: 'Reviews code.\nCites evidence.\n', source: 'claude', provider: 'claude', model: null, effort: null, readOnly: false, unknownFields: {} });
    expect(reviewer.models).toBeUndefined();
    expect(JSON.stringify(d.result)).not.toContain('SECRET');
    expect(d.assessment).toBe('complete');
  });

  it('a native Codex role: model, effort and read-only come through; both sources sorted by id', async () => {
    const d = await decode(catalogs.both);
    const v = rolesOk(d);
    expect(v.roles.find((r) => r.id === 'codex:auditor')).toMatchObject({ source: 'codex', provider: 'codex', description: 'Audits changes', model: 'gpt-test', effort: 'high', readOnly: true });
    expect(v.roles.find((r) => r.id === 'codex:auditor')!.models).toBeUndefined();
    expect(v.roles.map((r) => r.id)).toEqual(catalogs.both.roles.map((r) => r.id));
    expect(d.assessment).toBe('complete');
  });

  it('a broken native file: partial flag and a diagnostic reduced to source and code (no path, no line); the good role stays', async () => {
    const d = await decode(catalogs.broken);
    const v = rolesOk(d);
    expect(v.partial).toBe(true);
    expect(v.diagnostics).toEqual([{ source: 'claude', code: 'invalid-yaml', unknownFields: {} }]);
    expect(v.roles.some((r) => r.id === 'claude:good')).toBe(true);
    expect(JSON.stringify(d.result)).not.toContain(dir);
    expect(d.assessment).toBe('partial');
  });

  it('a discovery limit is marked (partial + discovery-limit): partial', async () => {
    const d = await decode(catalogs.limit);
    expect(rolesOk(d).diagnostics.map((x) => x.code)).toContain('discovery-limit');
    expect(rolesOk(d).partial).toBe(true);
    expect(d.assessment).toBe('partial');
  });

  it('a duplicate native role is dropped with a duplicate-role diagnostic: partial', async () => {
    const d = await decode(catalogs.duplicate);
    expect(rolesOk(d).diagnostics.map((x) => x.code)).toContain('duplicate-role');
    expect(rolesOk(d).roles.some((r) => r.id === 'claude:reviewer')).toBe(false);
    expect(d.assessment).toBe('partial');
  });

  describe('each completeness signal counts on its own', () => {
    it('only the partial flag (no diagnostics): partial', async () => {
      const d = await decode(catalogs.carried);
      expect(rolesOk(d)).toMatchObject({ partial: true, diagnostics: [] });
      expect(d.assessment).toBe('partial');
    });
    it('only a diagnostic (flag false, as an injected catalogue could give): partial, not refused', async () => {
      const source = await raw(catalogs.builtin);
      const d = decodeListRoles({}, mutateJson(source, (j) => { j['diagnostics'] = [{ source: 'claude', code: 'unreadable' }]; }));
      expect(rolesOk(d)).toMatchObject({ partial: false });
      expect(d.assessment).toBe('partial');
    });
    it('neither: complete', async () => {
      expect((await decode(catalogs.builtin)).assessment).toBe('complete');
    });
    it('text that talks about omissions changes nothing without the structured marks', async () => {
      const source = await raw(catalogs.claude);
      const d = decodeListRoles({}, mutateJson(source, (j) => { j['roles'][0].description = 'partial: more roles were not listed (discovery-limit)'; }));
      expect(d.assessment).toBe('complete');
    });
  });

  describe('errors are data', () => {
    it('a failing catalogue comes back whole as a tool error with unknown assessment', async () => {
      const failing = await raw('throw');
      expect((failing as { isError?: boolean }).isError).toBe(true);
      const d = decodeListRoles({}, failing);
      expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
      expect(d.assessment).toBe('unknown');
    });
    it('a tool error is returned before the request is looked at', async () => {
      const failing = await raw('throw');
      expect(decodeListRoles(null, failing).result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
    });
    it('a success for a request that is not an object has no branch', async () => {
      const source = await raw(catalogs.builtin);
      for (const bad of [null, [], 'x', 7]) expect(rolesCode(decodeListRoles(bad, source))).toBe('unknown-request-branch');
      expect(rolesOk(decodeListRoles(undefined, source)).roles.length).toBeGreaterThan(0);
    });
    it('the handler takes extra arguments without a change of result', async () => {
      const plain = await raw(catalogs.claude);
      const withArgs = await raw(catalogs.claude, { topic: 'x', n: 1 });
      expect(textOf(withArgs)).toBe(textOf(plain));
      expect(rolesOk(decodeListRoles({ topic: 'x', n: 1 }, withArgs)).roles.length).toBe(rolesOk(decodeListRoles({}, plain)).roles.length);
    });
    it('malformed envelopes and texts have fixed codes', async () => {
      const source = await raw(catalogs.builtin);
      expect(rolesCode(decodeListRoles({}, { content: [] }))).toBe('unexpected-envelope');
      expect(rolesCode(decodeListRoles({}, withText(source, 'not json')))).toBe('text-not-strict-json');
      expect(rolesCode(decodeListRoles({}, withText(source, '{"roles":[],"roles":[],"partial":false,"diagnostics":[]}')))).toBe('text-not-strict-json');
      expect(rolesCode(decodeListRoles({}, withText(source, '[]')))).toBe('shape-mismatch');
      expect(rolesCode(decodeListRoles({}, { ...(source as object), _meta: { n: Number.NaN } }))).toBe('result-not-strict-json');
    });
  });

  describe('a response that does not match the handler output is invalid output, never an empty success', () => {
    it.each<[string, (j: Doc) => void]>([
      ['partial missing', (j) => { delete j['partial']; }],
      ['partial a string', (j) => { j['partial'] = 'false'; }],
      ['diagnostics missing', (j) => { delete j['diagnostics']; }],
      ['diagnostics an object', (j) => { j['diagnostics'] = {}; }],
      ['roles missing', (j) => { delete j['roles']; }],
      ['roles an object', (j) => { j['roles'] = {}; }],
      ['a role without an id', (j) => { delete j['roles'][0].id; }],
      ['a role with a numeric name', (j) => { j['roles'][0].name = 7; }],
      ['a role without a description', (j) => { delete j['roles'][0].description; }],
      ['a role with a numeric model', (j) => { j['roles'][0].model = 7; }],
      ['a role without model', (j) => { delete j['roles'][0].model; }],
      ['a role with a string effort of the wrong type', (j) => { j['roles'][0].effort = 3; }],
      ['a role with readOnly as a string', (j) => { j['roles'][0].readOnly = 'no'; }],
      ['a builtin role without models', (j) => { delete j['roles'][0].models; }],
      ['models as an array', (j) => { j['roles'][0].models = []; }],
      ['models.claude numeric', (j) => { j['roles'][0].models.claude = 7; }],
      ['models.codex missing', (j) => { delete j['roles'][0].models.codex; }],
      ['a non-builtin role with models', (j) => { j['roles'].push({ id: 'claude:x', name: 'x', description: 'd', source: 'claude', provider: 'claude', model: null, effort: null, readOnly: false, models: { claude: null, codex: null } }); }],
      ['a diagnostic without a code', (j) => { j['diagnostics'] = [{ source: 'claude' }]; }],
      ['a diagnostic with a numeric code', (j) => { j['diagnostics'] = [{ source: 'claude', code: 7 }]; }],
      ['a diagnostic that is a string', (j) => { j['diagnostics'] = ['unreadable']; }],
    ])('%s', async (_label, change) => {
      const source = await raw(catalogs.builtin);
      const d = decodeListRoles({}, mutateJson(source, change));
      expect(rolesCode(d)).toBe('shape-mismatch');
      expect(d.assessment).toBe('unknown');
    });
  });

  describe('unknown fields are kept at every depth, and the guest value stays apart from the host assessment', () => {
    it('top level, role, models and diagnostic keep their unknown keys; modeled keys are not repeated there', async () => {
      const source = await raw(catalogs.broken);
      const d = decodeListRoles({}, mutateJson(source, (j) => {
        j['zz'] = { a: [1] };
        j['roles'][0].zz = 'role';
        j['roles'][0].models.zz = 'models';
        j['diagnostics'][0].path = '/kept';
        j['diagnostics'][0].line = 3;
      }));
      const v = rolesOk(d);
      expect(v.unknownFields).toEqual({ zz: { a: [1] } });
      expect(v.roles[0]!.unknownFields).toEqual({ zz: 'role' });
      expect(v.roles[0]!.models!.unknownFields).toEqual({ zz: 'models' });
      expect(v.diagnostics[0]!.unknownFields).toEqual({ path: '/kept', line: 3 });
      expect(Object.keys(v.unknownFields)).not.toContain('roles');
    });

    it('the guest value has no assessment; the result is frozen all the way down; envelope extras stay host-side', async () => {
      const real = (await raw(catalogs.claude)) as { content: { type: string; text: string }[] };
      const d = decodeListRoles({}, { content: [{ ...real.content[0]!, _meta: { n: 1 } }], _meta: { host: 'zz-host-token' } });
      expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
      expect(d.envelopeUnknown).toEqual({ resultFields: { _meta: { host: 'zz-host-token' } }, itemFields: { _meta: { n: 1 } } });
      expect(JSON.stringify(d.result)).not.toContain('zz-host-token');
      const v = rolesOk(d);
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.isFrozen(v.roles)).toBe(true);
      expect(Object.isFrozen(v.roles[0]!.models)).toBe(true);
    });
  });

  describe('lossless shape: nothing the source says is dropped', () => {
    const forms = ['builtin', 'both', 'broken'] as const;
    it.each(forms)('%s: every source property is in the value at the same path (unknownFields unwrapped)', async (name) => {
      const source = await raw(catalogs[name]);
      const got = pairs(JSON.parse(JSON.stringify(rolesOk(decodeListRoles({}, source)))), true);
      for (const [pair, count] of pairs(JSON.parse(textOf(source)), false)) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
    });
    it.each(forms)('%s: an extra key injected into every object survives at its own path', async (name) => {
      const source = await raw(catalogs[name]);
      const injected = augment(JSON.parse(textOf(source))) as Doc;
      const d = decodeListRoles({}, withText(source, JSON.stringify(injected)));
      const got = pairs(JSON.parse(JSON.stringify(rolesOk(d))), true);
      const want = pairs(injected, false);
      for (const [pair, count] of want) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
      for (const key of ['zz="extra"', 'roles[0].zz="extra"']) expect(want.has(key), key).toBe(true);
      if (name === 'builtin') expect(want.has('roles[0].models.zz="extra"')).toBe(true);
      if (name === 'broken') expect(want.has('diagnostics[0].zz="extra"')).toBe(true);
    });
  });
});

// ----- T6-backlog_list -----

const backlogOk = (d: Decoded<BacklogListValue>): BacklogListValue => {
  if (!d.result.ok) throw new Error(`expected ok, got ${JSON.stringify(d.result.error)}`);
  return d.result.value;
};
const backlogCode = (d: Decoded<BacklogListValue>): string => {
  if (d.result.ok || d.result.error.kind !== 'invalid-output') throw new Error('expected invalid-output');
  return d.result.error.code;
};

describe('backlog_list: request selection (the handler defaults null, refuses unknown keys)', () => {
  it.each<[string, unknown, { filter: string; text: string } | null]>([
    ['no arguments: open, no text', {}, { filter: 'open', text: '' }],
    ['no arguments at all (the server wrapper passes {})', undefined, { filter: 'open', text: '' }],
    ['every filter', { filter: 'taken' }, { filter: 'taken', text: '' }],
    ['done', { filter: 'done' }, { filter: 'done', text: '' }],
    ['all with text', { filter: 'all', text: 'Needle' }, { filter: 'all', text: 'Needle' }],
    ['a null filter is the default', { filter: null }, { filter: 'open', text: '' }],
    ['a null text is the default', { text: null }, { filter: 'open', text: '' }],
    ['undefined values are the defaults', { filter: undefined, text: undefined }, { filter: 'open', text: '' }],
    ['text of exactly 4096 units', { text: 'x'.repeat(4096) }, { filter: 'open', text: 'x'.repeat(4096) }],
    ['text of 4097 units', { text: 'x'.repeat(4097) }, null],
    ['text with a NUL', { text: 'a\0b' }, null],
    ['an unknown filter', { filter: 'private' }, null],
    ['a numeric filter', { filter: 7 }, null],
    ['an upper-case filter', { filter: 'OPEN' }, null],
    ['a numeric text', { text: 7 }, null],
    ['an object text', { text: {} }, null],
    ['an unknown key', { taken: 'w-01/r-01' }, null],
    ['an unknown key with an undefined value still counts', { filter: 'open', extra: undefined }, null],
    ['a spoofed identity key', { projectPath: '/x', workId: 'w-99', sessionId: 's-99' }, null],
  ])('%s', (_label, args, expected) => {
    expect(selectBacklogListRequest(args)).toEqual(expected);
  });

  it('refuses a request that is not a plain object', () => {
    for (const bad of [null, 'open', 7, [], [{ filter: 'open' }]]) expect(selectBacklogListRequest(bad)).toBeNull();
  });
});

describe('backlog_list from the real handler over a real temporary project backlog', () => {
  let bproject: string;
  let bworkId: string;
  let ids: Record<'open' | 'taken' | 'review' | 'done' | 'sectioned', string>;
  const rowSummary = (v: BacklogListValue): [string | null, string][] => v.items.map((i) => [i.id, i.state]);

  const runnerFor = (sessionId: string | null) => createToolRunner({
    projectPath: bproject, workId: bworkId, workDir: workPaths(bproject, bworkId).dir, sessionId, channel: false, providerRows: async () => rows,
  });
  const raw = async (args: Record<string, unknown>, sessionId: string | null = 's-01'): Promise<unknown> => wire(await runnerFor(sessionId).call('backlog_list', args, undefined));
  const decode = async (args: Record<string, unknown>, sessionId: string | null = 's-01'): Promise<Decoded<BacklogListValue>> => decodeBacklogList(args, await raw(args, sessionId));

  beforeAll(async () => {
    bproject = path.join(root, 'backlog-project');
    await mkdir(bproject);
    bworkId = (await createWork(bproject, { title: 'Backlog fixtures', goal: 'Short goal' })).work.id;
    await updateMap(bproject, bworkId, (map) => {
      transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead the fixtures' }).id, 'active');
    });
    const open = await addBacklogItem(bproject, { title: 'Open item', details: 'Needle detail' });
    const taken = await addBacklogItem(bproject, { title: 'Taken item', by: 's-01' });
    const review = await addBacklogItem(bproject, { title: 'Reviewed item' });
    const done = await addBacklogItem(bproject, { title: 'Done item' });
    const sectioned = await addBacklogItem(bproject, { title: 'Sectioned item', section: 'Docs Section' });
    ids = { open: open.id, taken: taken.id, review: review.id, done: done.id, sectioned: sectioned.id };
    await boardTake(bproject, taken.id, `${bworkId}/s-01`);
    await boardTake(bproject, review.id, `${bworkId}/s-01`);
    await boardMove(bproject, review.id, 'review');
    await completeBacklogItem(bproject, done.id, '2026-11-08');
    await setBacklogRule(bproject, 'ask');
    await suggestBacklog(bproject, { kind: 'idea', title: 'Pending idea', details: 'More', why: 'Because', workId: bworkId, sessionId: 's-01' });
  });

  it('the default list: open cards with their states, the pending suggestion, the rule; every success is unknown', async () => {
    const d = await decode({});
    const v = backlogOk(d);
    expect(rowSummary(v)).toEqual([[ids.open, 'backlog'], [ids.taken, 'in-progress'], [ids.review, 'review'], [ids.sectioned, 'backlog']]);
    expect(v.items[0]).toMatchObject({ title: 'Open item', details: 'Needle detail', checked: false, section: 'Backlog' });
    expect(v.items[1]).toMatchObject({ by: 's-01', taken: `${bworkId}/s-01` });
    expect(v.items[2]!.review).toEqual(expect.any(String));
    expect(v.items[2]!.sent).toEqual(expect.any(String));
    expect(v.items[3]).toMatchObject({ section: 'Docs Section' });
    expect(v.suggestions).toHaveLength(1);
    expect(v.suggestions[0]).toMatchObject({ kind: 'idea', title: 'Pending idea', details: 'More', why: 'Because', workId: bworkId, sessionId: 's-01' });
    expect(v.rule).toBe('ask');
    expect(typeof v.version).toBe('string');
    expect(v.diagnostics).toEqual([]);
    expect(d.assessment).toBe('unknown');
  });

  it.each<[string, Record<string, unknown>, ('open' | 'taken' | 'review' | 'done' | 'sectioned')[]]>([
    ['all', { filter: 'all' }, ['open', 'taken', 'review', 'done', 'sectioned']],
    ['done', { filter: 'done' }, ['done']],
    ['taken (in progress and review, not done)', { filter: 'taken' }, ['taken', 'review']],
    ['open', { filter: 'open' }, ['open', 'taken', 'review', 'sectioned']],
    ['text in details, case-insensitive', { filter: 'all', text: 'NEEDLE' }, ['open']],
    ['text in the title', { filter: 'all', text: 'reviewed' }, ['review']],
    ['text in the section', { filter: 'all', text: 'docs section' }, ['sectioned']],
    ['text with no match', { text: 'zzz-no-match' }, []],
    ['null filter and null text', { filter: null, text: null }, ['open', 'taken', 'review', 'sectioned']],
  ])('%s', async (_label, args, expected) => {
    const d = await decode(args);
    expect(backlogOk(d).items.map((i) => i.id)).toEqual(expected.map((k) => ids[k]));
    // suggestions never follow the filter or the text
    expect(backlogOk(d).suggestions).toHaveLength(1);
    expect(d.assessment).toBe('unknown');
  });

  it('a done card shows state done and its done mark', async () => {
    const v = backlogOk(await decode({ filter: 'done' }));
    expect(v.items[0]).toMatchObject({ id: ids.done, checked: true, state: 'done' });
    expect(v.items[0]!.done).toEqual(expect.any(String));
  });

  it('a CLOSED session is not refused: the list is returned (rechecked against the source)', async () => {
    await updateMap(bproject, bworkId, (map) => { map.sessions.find((row) => row.id === 's-01')!.lifecycle = 'closed'; });
    try {
      const source = await raw({});
      expect((source as { isError?: boolean }).isError).not.toBe(true);
      expect(backlogOk(decodeBacklogList({}, source)).items.length).toBeGreaterThan(0);
    } finally {
      await updateMap(bproject, bworkId, (map) => { map.sessions.find((row) => row.id === 's-01')!.lifecycle = 'active'; });
    }
  });

  it.each<[string, Record<string, unknown>, string | null]>([
    ['no session', {}, null],
    ['an unknown session', {}, 's-99'],
    ['an unknown filter', { filter: 'private' }, 's-01'],
    ['text over 4096 units', { text: 'x'.repeat(4097) }, 's-01'],
    ['text with a NUL', { text: 'a\0b' }, 's-01'],
    ['an unknown key', { taken: 'w-01/r-01' }, 's-01'],
    ['a numeric filter', { filter: 7 }, 's-01'],
    ['a numeric text', { text: 7 }, 's-01'],
  ])('%s: the handler error comes back whole, the assessment is unknown', async (_label, args, sessionId) => {
    const failing = await raw(args, sessionId);
    expect((failing as { isError?: boolean }).isError).toBe(true);
    const d = decodeBacklogList(args, failing);
    expect(d.result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
    expect(d.assessment).toBe('unknown');
  });

  it('malformed preferences are a handler error; the request check is not reached', async () => {
    const file = path.join(bproject, '.parley', 'preferences.json');
    const good = await readFile(file, 'utf8');
    await writeFile(file, 'secret native parser input');
    try {
      const failing = await raw({});
      expect((failing as { isError?: boolean }).isError).toBe(true);
      expect(decodeBacklogList({ filter: 7 }, failing).result).toEqual({ ok: false, error: { kind: 'tool-error', result: failing } });
    } finally {
      await writeFile(file, good);
    }
    expect((await raw({}) as { isError?: boolean }).isError).not.toBe(true);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['no arguments', {}, true],
    ['null values', { filter: null, text: null }, true],
    ['undefined values', { filter: undefined, text: undefined }, true],
    ['text at the limit', { text: 'x'.repeat(4096) }, true],
    ['text over the limit', { text: 'x'.repeat(4097) }, false],
    ['a NUL', { text: '\0' }, false],
    ['an unknown filter', { filter: 'nope' }, false],
    ['a numeric filter', { filter: 7 }, false],
    ['an unknown key', { foo: 1 }, false],
    ['an undefined unknown key', { foo: undefined }, false],
  ])('the selector agrees with the handler: %s', async (_label, args, accepted) => {
    const source = await raw(args);
    expect((source as { isError?: boolean }).isError === true).toBe(!accepted);
    expect(selectBacklogListRequest(args) !== null).toBe(accepted);
    if (accepted) expect(backlogOk(decodeBacklogList(args, source)).version).toEqual(expect.any(String));
  });

  it('a success for an empty call decodes whether the arguments are {} or absent', async () => {
    const source = await raw({});
    expect(decodeBacklogList(undefined, source).result).toEqual(decodeBacklogList({}, source).result);
    expect(backlogOk(decodeBacklogList(undefined, source)).items.length).toBeGreaterThan(0);
  });

  it('a success for a request the handler would refuse has no branch', async () => {
    const source = await raw({});
    for (const bad of [{ filter: 'nope' }, { text: 'x'.repeat(4097) }, { foo: 1 }, null, 'open']) expect(backlogCode(decodeBacklogList(bad, source))).toBe('unknown-request-branch');
  });

  describe('a response that contradicts the request or itself is invalid output, never an empty success', () => {
    const ALL = { filter: 'all' };
    it.each<[string, Record<string, unknown>, (j: Doc) => void, string]>([
      ['a done card in the default (open) list', {}, (j) => { j['items'][0].checked = true; j['items'][0].state = 'done'; }, 'echo-mismatch'],
      ['an open card in the done list', { filter: 'done' }, (j) => { j['items'][0].checked = false; j['items'][0].state = 'backlog'; }, 'echo-mismatch'],
      ['a done card in the taken list', { filter: 'taken' }, (j) => { j['items'].push({ id: 'b-098', title: 'Finished', details: '', checked: true, section: null, taken: 'w-01/s-01', state: 'done' }); }, 'echo-mismatch'],
      ['an untaken card in the taken list', { filter: 'taken' }, (j) => { delete j['items'][0].taken; j['items'][0].state = 'backlog'; }, 'echo-mismatch'],
      ['a card that does not contain the text', { filter: 'all', text: 'needle' }, (j) => { j['items'].push({ id: 'b-099', title: 'Unrelated', details: '', checked: false, section: null, state: 'backlog' }); }, 'echo-mismatch'],
      ['state done on an unchecked card', ALL, (j) => { j['items'][0].state = 'done'; }, 'shape-mismatch'],
      ['state backlog on a taken card', ALL, (j) => { j['items'][1].state = 'backlog'; }, 'shape-mismatch'],
      ['state review without a review mark', ALL, (j) => { j['items'][1].state = 'review'; }, 'shape-mismatch'],
      ['state in-progress on a card in review', ALL, (j) => { j['items'][2].state = 'in-progress'; }, 'shape-mismatch'],
      ['an unknown state', ALL, (j) => { j['items'][0].state = 'limbo'; }, 'shape-mismatch'],
      ['a missing state', ALL, (j) => { delete j['items'][0].state; }, 'shape-mismatch'],
      ['two cards with the same id', ALL, (j) => { j['items'][1].id = j['items'][0].id; }, 'shape-mismatch'],
      ['two suggestions with the same id', ALL, (j) => { j['suggestions'].push({ ...j['suggestions'][0] }); }, 'shape-mismatch'],
      ['a card without a title', ALL, (j) => { delete j['items'][0].title; }, 'shape-mismatch'],
      ['a card with checked as a string', ALL, (j) => { j['items'][0].checked = 'no'; }, 'shape-mismatch'],
      ['a card with a numeric section', ALL, (j) => { j['items'][0].section = 7; }, 'shape-mismatch'],
      ['a card with a numeric taken', ALL, (j) => { j['items'][1].taken = 7; }, 'shape-mismatch'],
      ['a card with a numeric review', ALL, (j) => { j['items'][2].review = 7; }, 'shape-mismatch'],
      ['a missing version', ALL, (j) => { delete j['version']; }, 'shape-mismatch'],
      ['a numeric version', ALL, (j) => { j['version'] = 7; }, 'shape-mismatch'],
      ['items missing', ALL, (j) => { delete j['items']; }, 'shape-mismatch'],
      ['items an object', ALL, (j) => { j['items'] = {}; }, 'shape-mismatch'],
      ['suggestions missing', ALL, (j) => { delete j['suggestions']; }, 'shape-mismatch'],
      ['a suggestion without a why', ALL, (j) => { delete j['suggestions'][0].why; }, 'shape-mismatch'],
      ['a suggestion with a numeric kind', ALL, (j) => { j['suggestions'][0].kind = 7; }, 'shape-mismatch'],
      ['a missing rule', ALL, (j) => { delete j['rule']; }, 'shape-mismatch'],
      ['a numeric rule', ALL, (j) => { j['rule'] = 7; }, 'shape-mismatch'],
      ['diagnostics missing', ALL, (j) => { delete j['diagnostics']; }, 'shape-mismatch'],
      ['a diagnostic without a code', ALL, (j) => { j['diagnostics'] = [{}]; }, 'shape-mismatch'],
    ])('%s', async (_label, args, change, code) => {
      const source = await raw(args.filter === undefined && args.text === undefined ? ALL : args.text === 'needle' ? ALL : args);
      // the corrupted response is decoded against the request under test
      const d = decodeBacklogList(args, mutateJson(source, change));
      expect(backlogCode(d)).toBe(code);
      expect(d.assessment).toBe('unknown');
    });

    it('malformed envelopes and texts have fixed codes', async () => {
      const source = await raw({});
      expect(backlogCode(decodeBacklogList({}, { content: [] }))).toBe('unexpected-envelope');
      expect(backlogCode(decodeBacklogList({}, withText(source, 'not json')))).toBe('text-not-strict-json');
      expect(backlogCode(decodeBacklogList({}, withText(source, '[]')))).toBe('shape-mismatch');
      expect(backlogCode(decodeBacklogList({}, { ...(source as object), _meta: { n: Number.NaN } }))).toBe('result-not-strict-json');
    });
  });

  it('the list can be empty: a project without a backlog file is an empty unknown list', async () => {
    const empty = path.join(root, 'backlog-empty');
    await mkdir(empty);
    const workId = (await createWork(empty, { title: 'Empty', goal: 'g' })).work.id;
    await updateMap(empty, workId, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 't' }).id, 'active'); });
    const runner = createToolRunner({ projectPath: empty, workId, workDir: workPaths(empty, workId).dir, sessionId: 's-01', channel: false, providerRows: async () => rows });
    const d = decodeBacklogList({}, wire(await runner.call('backlog_list', {}, undefined)));
    expect(backlogOk(d)).toMatchObject({ items: [], suggestions: [], rule: 'problems', diagnostics: [] });
    expect(d.assessment).toBe('unknown');
  });

  it('cards written by hand: no heading means a null section, no id comment means a null id (two of them are not duplicates)', async () => {
    const hand = path.join(root, 'backlog-hand');
    await mkdir(path.join(hand, '.parley'), { recursive: true });
    await writeFile(path.join(hand, '.parley', 'backlog.md'), '- [ ] First plain card\n  with a detail\n- [x] Second plain card\n');
    const workId = (await createWork(hand, { title: 'Hand', goal: 'g' })).work.id;
    await updateMap(hand, workId, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 't' }).id, 'active'); });
    const runner = createToolRunner({ projectPath: hand, workId, workDir: workPaths(hand, workId).dir, sessionId: 's-01', channel: false, providerRows: async () => rows });
    const d = decodeBacklogList({ filter: 'all' }, wire(await runner.call('backlog_list', { filter: 'all' }, undefined)));
    const v = backlogOk(d);
    expect(v.items.map((i) => [i.id, i.section, i.title, i.state])).toEqual([[null, null, 'First plain card', 'backlog'], [null, null, 'Second plain card', 'done']]);
    expect(v.items[0]!.details).toBe('with a detail');
  });

  it('a custom .parley/.gitignore is a real diagnostic and does not change the assessment', async () => {
    const custom = path.join(root, 'backlog-ignore');
    await mkdir(path.join(custom, '.parley'), { recursive: true });
    await writeFile(path.join(custom, '.parley', '.gitignore'), 'something-else\n');
    const workId = (await createWork(custom, { title: 'Ignore', goal: 'g' })).work.id;
    await updateMap(custom, workId, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 't' }).id, 'active'); });
    const runner = createToolRunner({ projectPath: custom, workId, workDir: workPaths(custom, workId).dir, sessionId: 's-01', channel: false, providerRows: async () => rows });
    const d = decodeBacklogList({}, wire(await runner.call('backlog_list', {}, undefined)));
    expect(backlogOk(d).diagnostics).toEqual([{ code: 'parley-gitignore-custom', unknownFields: {} }]);
    expect(d.assessment).toBe('unknown');
  });

  it('unknown fields are kept at every depth; the guest value has no assessment; frozen; host extras stay host-side', async () => {
    const source = await raw({ filter: 'all' });
    const d = decodeBacklogList({ filter: 'all' }, mutateJson(source, (j) => {
      j['zz'] = { a: [1] }; j['items'][0].zz = 'item'; j['suggestions'][0].zz = 'sg'; j['diagnostics'] = [{ code: 'parley-dir-ignored', zz: 'dg' }];
    }));
    const v = backlogOk(d);
    expect(v.unknownFields).toEqual({ zz: { a: [1] } });
    expect(v.items[0]!.unknownFields).toEqual({ zz: 'item' });
    expect(v.suggestions[0]!.unknownFields).toEqual({ zz: 'sg' });
    expect(v.diagnostics).toEqual([{ code: 'parley-dir-ignored', unknownFields: { zz: 'dg' } }]);
    expect(Object.keys(d).sort()).toEqual(['assessment', 'envelopeUnknown', 'result']);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.items[0])).toBe(true);
    const real = source as { content: { type: string; text: string }[] };
    const extra = decodeBacklogList({ filter: 'all' }, { content: [{ ...real.content[0]!, _meta: { n: 1 } }], _meta: { host: 'zz-host-token' } });
    expect(extra.envelopeUnknown).toEqual({ resultFields: { _meta: { host: 'zz-host-token' } }, itemFields: { _meta: { n: 1 } } });
    expect(JSON.stringify(extra.result)).not.toContain('zz-host-token');
  });

  describe('lossless shape: nothing the source says is dropped', () => {
    const forms: Record<string, unknown>[] = [{}, { filter: 'all' }, { filter: 'done' }, { filter: 'all', text: 'needle' }];
    it.each([0, 1, 2, 3])('form %s: every source property is in the value at the same path (unknownFields unwrapped)', async (index) => {
      const args = forms[index] as Record<string, unknown>;
      const source = await raw(args);
      const got = pairs(JSON.parse(JSON.stringify(backlogOk(decodeBacklogList(args, source)))), true);
      for (const [pair, count] of pairs(JSON.parse(textOf(source)), false)) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
    });
    it.each([0, 1, 2, 3])('form %s: an extra key injected into every object survives at its own path', async (index) => {
      const args = forms[index] as Record<string, unknown>;
      const source = await raw(args);
      const injected = augment(JSON.parse(textOf(source))) as Doc;
      const d = decodeBacklogList(args, withText(source, JSON.stringify(injected)));
      const got = pairs(JSON.parse(JSON.stringify(backlogOk(d))), true);
      const want = pairs(injected, false);
      for (const [pair, count] of want) expect(got.get(pair) ?? 0, pair).toBeGreaterThanOrEqual(count);
      for (const key of ['zz="extra"', 'items[0].zz="extra"', 'suggestions[0].zz="extra"']) expect(want.has(key), key).toBe(true);
    });
  });
});

describe('absent arguments through the real MCP server wrapper (get_map, read_guide, backlog_list)', () => {
  async function viaServer(context: McpContext, name: string): Promise<unknown> {
    const server = createParleyServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      // `arguments` is left out of the request altogether
      return wire(await client.callTool({ name }));
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('a call without `arguments` reaches the handler as {} and its success decodes with args undefined, like with {}', async () => {
    const project2 = path.join(root, 'absent-project');
    await mkdir(project2);
    const workId = (await createWork(project2, { title: 'Absent', goal: 'Short goal' })).work.id;
    await updateMap(project2, workId, (map) => { transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 't' }).id, 'active'); });
    const context: McpContext = { projectPath: project2, workId, workDir: workPaths(project2, workId).dir, sessionId: 's-01', channel: false, providerRows: async () => rows };
    const runner = createToolRunner(context);
    const decoders = {
      get_map: (args: unknown, result: unknown) => decodeGetMap(args, result).result,
      read_guide: (args: unknown, result: unknown) => decodeReadGuide(args, result).result,
      backlog_list: (args: unknown, result: unknown) => decodeBacklogList(args, result).result,
    };
    for (const name of ['get_map', 'read_guide', 'backlog_list'] as const) {
      const absent = await viaServer(context, name);
      expect((absent as { isError?: boolean }).isError, name).not.toBe(true);
      const empty = wire(await runner.call(name, {}, undefined));
      expect(textOf(absent), name).toBe(textOf(empty));
      const viaUndefined = decoders[name](undefined, absent);
      expect(viaUndefined.ok, name).toBe(true);
      expect(viaUndefined, name).toEqual(decoders[name]({}, absent));
    }
  });
});
