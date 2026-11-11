// Tests of the T11 R2 read adapters (`plan_tasks`, `attempt_status`). Positive cases run the REAL handlers (createToolRunner over a temporary
// work) and decode what they produced, so a drift in a producer fails here; negative cases corrupt those real outputs one property at a time.
// Nothing is mocked: the work, its plans, rooms and sessions are the store's own.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markedExcerpt } from '../../../work/context-budget.js';
import { addSession, transitionSession } from '../../../work/map.js';
import { addRoom } from '../../../work/rooms.js';
import { createWork, readMap, readStoredMap, updateMap, workPaths } from '../../../work/store.js';
import { ENGINE, HUMAN, type PlanItem, type RoomPlan } from '../../../work/types.js';
import type { McpContext } from '../../context.js';
import { STALE_AGENT, TOOLS, createToolRunner } from '../../tools.js';
import { createOutputContract } from '../broker.js';
import { buildCatalog } from '../catalog.js';
import { MIGRATABLE_READS } from '../migration-registry.js';
import { GUEST_LIMITS, type GuestBridge, runGuest } from '../guest.js';
import { INVALID_OUTPUT_CODES } from '../read-adapters.js';
import {
  ATTEMPT_STATUS_VALUES,
  decodeAttemptStatus,
  selectAttemptStatusRequest,
  type AttemptListValue,
  type AttemptStatusValue,
} from './attempt-status.js';
import {
  CUT_SUFFIX,
  DETAIL_LOG_CAP,
  EVIDENCE_ARTIFACTS_CAP,
  FINISHED_ITEMS_CAP,
  decodePlanTasks,
  selectPlanTasksRequest,
  type PlanTasksValue,
} from './plan-tasks.js';

let root: string;
let project: string;
let workId: string;
let previousHome: string | undefined;
let base: McpContext;

type Obj = Record<string, unknown>;
const NOW = '2026-11-10T10:00:00.000Z';

const item = (id: number, owner: string, status: PlanItem['status'], more: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `item ${id}`, owner, scope: `scope ${id}`, after: [], criteria: [`criterion ${id}`], verifier: null, status, evidence: null, note: null, log: [], ...more,
});
const plan = (id: string, roomId: string, mode: RoomPlan['mode'], items: PlanItem[], more: Partial<RoomPlan> = {}): RoomPlan => ({
  id, roomId, mode, status: 'active', rev: 3, goal: `goal of ${id}`, items, backlog: [], acceptedAt: NOW, completedAt: null, cancelledAt: null, completionSummary: null, ...more,
});
const log = (n: number): PlanItem['log'] => Array.from({ length: n }, (_, i) => ({ at: NOW, by: 's-02', status: 'in_progress' as const, note: `step ${i + 1}` }));
const checkpoint = (by: string, submission: number | null) => ({ by, at: NOW, submission, done: 'did the first half', next: 'do the second', artifacts: ['out.txt'], blocker: null });

const manifest = (text: string) => ({
  version: 1, criteriaVersion: 1, dependsOn: [], coverage: 'covered', scope: 'src/a.ts', facts: ['Implemented'], hypotheses: [], notFound: [], gaps: [], text,
  artifacts: [], hash: 'a'.repeat(64), submittedAt: NOW, sha: null,
});
const attempt = (n: number, status: string) => ({
  id: `at-${String(n).padStart(4, '0')}`, item: 1, n, planRev: 0, criteriaVersion: 1, worker: n % 3 === 0 ? null : 's-02', verifier: n % 2 === 0 ? 's-03' : null,
  branch: `attempt/at-${n}`, baseSha: 'a'.repeat(40), sha: n % 2 === 0 ? 'b'.repeat(40) : null, tree: null, submissionKey: null, status,
  manifest: n === 1 ? manifest('x'.repeat(4000)) : null,
  receipt: n % 4 === 0 ? { id: `rc-${n}`, attemptId: `at-${n}`, manifestHash: 'a'.repeat(64), sha: 'b'.repeat(40), criteriaVersion: 1, valid: n % 8 === 0, reason: null, at: NOW } : null,
  checks: n % 2 === 0 ? ['ck-1', 'ck-2'] : [], failureSignature: null, startedAt: NOW, endedAt: n % 5 === 0 ? NOW : null, log: [],
});
const autonomousPlan = (): RoomPlan => ({
  ...plan('pl-02', 'r-02', 'autonomous', [item(1, ENGINE, 'in_progress', { verifier: ENGINE })]),
  autonomous: {
    budget: { limits: { attemptsPerItem: 3, repairWaves: 2, minutesPerAttempt: 10, sessions: 6, concurrent: 2 }, spent: { attempts: 12, repairWaves: 0, sessions: 2, verifiers: 0, minutes: 0, launches: 1 }, reservations: [] },
    checks: [{ id: 'ck-spec-01', item: 1, argv: ['pnpm', 'test'], cwd: '.', env: {}, inputs: [{ path: 'test.ts', blob: 'b'.repeat(40) }], timeoutMs: 1000, frozenAt: NOW }],
    coverage: { 1: { 0: ['ck-spec-01', 'verifier'] } }, criteriaVersion: { 1: 1 },
    integration: { branch: 'parley/w-0001/integration/pl-02', baseSha: 'a'.repeat(40), verifiedHead: 'a'.repeat(40), candidateHead: null, queue: [], suspended: null },
    attempts: Array.from({ length: 12 }, (_, i) => attempt(i + 1, ATTEMPT_STATUS_VALUES[i % ATTEMPT_STATUS_VALUES.length]!)) as never,
    ops: [], halted: null, seq: { attempt: 12, receipt: 0, check: 0, op: 0 },
  },
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-r2-')));
  project = path.join(root, 'project');
  await mkdir(project);
  previousHome = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  workId = (await createWork(project, { title: 'R2 fixtures', goal: 'Adapters' })).work.id;
  await updateMap(project, workId, (map) => {
    for (let i = 1; i <= 12; i++) transitionSession(map, addSession(map, { provider: 'claude', label: `s${i}`, task: 'Fixture' }).id, 'active');
    const room = (title: string, members: string[], lead: string, mode: 'verified' | 'checklist' = 'checklist') => addRoom(map, { title, creator: HUMAN, members, lead, mode });
    room('main', ['s-01', 's-02', 's-03'], 's-01', 'verified'); // r-01
    room('autonomous', ['s-01', 's-02'], 's-01'); // r-02
    map.rooms[1]!.mode = 'autonomous';
    room('other', ['s-04'], 's-04'); // r-03
    room('paging', ['s-05'], 's-05'); // r-04
    room('cut', ['s-06'], 's-06'); // r-05
    room('accident', ['s-07'], 's-07'); // r-06
    room('evidence10', ['s-08', 's-09'], 's-08', 'verified'); // r-07
    room('evidence3', ['s-10', 's-11'], 's-10', 'verified'); // r-08
    room('paging2', ['s-05'], 's-05'); // r-09
    room('finished-a', ['s-12'], 's-12'); // r-10
    room('finished-b', ['s-12'], 's-12'); // r-11
    map.plans = [
      plan('pl-01', 'r-01', 'verified', [
        item(1, 's-02', 'ready', { verifier: 's-03' }),
        item(2, 's-02', 'in_progress', { verifier: 's-03', log: log(3), progress: { owner: checkpoint('s-02', null) } }),
        item(3, 's-02', 'returned', { verifier: 's-03', log: log(DETAIL_LOG_CAP) }),
        item(4, 's-02', 'blocked', { verifier: 's-03', note: 'waiting for the key' }),
        item(5, 's-02', 'waiting', { verifier: 's-03', after: [1] }),
        item(6, 's-03', 'done', { verifier: 's-02', evidence: { text: 'it works', artifacts: ['a.txt', 'b.txt'] }, progress: { verifier: checkpoint('s-02', 99) } }),
        item(7, 's-02', 'verified', { verifier: 's-03' }),
      ]),
      autonomousPlan(),
      plan('pl-03', 'r-03', 'checklist', [item(1, 's-04', 'ready')]),
      // a plan holds at most 30 items (PLAN_ITEM_MAX): two plans of one session make 31 finished items and 29 long ready ones
      plan('pl-04', 'r-04', 'checklist', [
        ...Array.from({ length: 10 }, (_, i) => item(i + 1, 's-05', 'done')),
        ...Array.from({ length: 20 }, (_, i) => item(11 + i, 's-05', 'ready', { scope: 'y'.repeat(900) })),
      ]),
      plan('pl-09', 'r-09', 'checklist', [
        ...Array.from({ length: 21 }, (_, i) => item(i + 1, 's-05', 'done')),
        ...Array.from({ length: 9 }, (_, i) => item(22 + i, 's-05', 'ready', { scope: 'z'.repeat(900) })),
      ]),
      // 31 finished items and one assignment: the first page has no `next`, and only the finished names are cut
      plan('pl-10', 'r-10', 'checklist', Array.from({ length: 30 }, (_, i) => item(i + 1, 's-12', 'done'))),
      plan('pl-11', 'r-11', 'checklist', [item(1, 's-12', 'done'), item(2, 's-12', 'ready')]),
      plan('pl-05', 'r-05', 'checklist', [item(1, 's-06', 'ready', { title: 'x'.repeat(300) })]),
      plan('pl-06', 'r-06', 'checklist', [item(1, 's-07', 'ready', { title: 'accidental … [cut: 9 bytes in full]' })]),
      plan('pl-07', 'r-07', 'verified', [item(1, 's-09', 'done', { verifier: 's-08', evidence: { text: 'ten', artifacts: Array.from({ length: EVIDENCE_ARTIFACTS_CAP }, (_, i) => `out-${i}.txt`) } })]),
      plan('pl-08', 'r-08', 'verified', [item(1, 's-11', 'done', { verifier: 's-10', evidence: { text: 'three', artifacts: ['a.txt', 'b.txt', 'c.txt'] } })]),
    ];
  });
  base = { projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-02', channel: false };
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** What the host settles for a call: the strict MCP result, JSON round-tripped as the broker sees it. */
const real = async (session: string, name: string, args: Obj | undefined, extra: Partial<McpContext> = {}): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> =>
  JSON.parse(JSON.stringify(await createToolRunner({ ...base, sessionId: session, ...extra }).call(name, (args ?? {}) as never, undefined)));
const textOf = (raw: { content: { text: string }[] }): string => raw.content[0]!.text;
const wrap = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** The decoded value minus its empty `unknownFields` maps, so it can be compared with the handler's own JSON. */
const stripped = (value: unknown, dropBranch = false): unknown => {
  if (Array.isArray(value)) return value.map(stripped);
  if (typeof value !== 'object' || value === null) return value;
  const out: Obj = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'unknownFields' && typeof v === 'object' && v !== null && Object.keys(v).length === 0) continue;
    if (dropBranch && key === 'branch') continue;
    out[key] = stripped(v);
  }
  return out;
};

const decodedPlan = async (session: string, args: Obj | undefined) => {
  const raw = await real(session, 'plan_tasks', args);
  expect(raw.isError, textOf(raw)).toBeUndefined();
  const decoded = decodePlanTasks(args, raw);
  expect(decoded.result.ok, JSON.stringify(decoded.result)).toBe(true);
  return { raw, text: textOf(raw), parsed: JSON.parse(textOf(raw)) as Obj, decoded, value: (decoded.result as { value: PlanTasksValue }).value };
};
const decodedAttempt = async (session: string, args: Obj | undefined) => {
  const raw = await real(session, 'attempt_status', args);
  expect(raw.isError, textOf(raw)).toBeUndefined();
  const decoded = decodeAttemptStatus(args, raw);
  expect(decoded.result.ok, JSON.stringify(decoded.result)).toBe(true);
  return { raw, text: textOf(raw), parsed: JSON.parse(textOf(raw)) as Obj, decoded, value: (decoded.result as { value: AttemptStatusValue }).value };
};
const invalidCode = (decoded: { result: { ok: boolean; error?: { kind: string; code?: string } } }): string | undefined =>
  decoded.result.ok ? undefined : decoded.result.error?.kind === 'invalid-output' ? decoded.result.error.code : decoded.result.error?.kind;

describe('plan_tasks: the request', () => {
  it('names the branches and refuses what the handler certainly refuses', () => {
    expect(selectPlanTasksRequest(undefined)).toEqual({ planId: null, item: null, hasCursor: false });
    expect(selectPlanTasksRequest({})).toEqual({ planId: null, item: null, hasCursor: false });
    expect(selectPlanTasksRequest({ planId: 'pl-01' })).toEqual({ planId: 'pl-01', item: null, hasCursor: false });
    expect(selectPlanTasksRequest({ planId: 'pl-01', item: 2 })).toEqual({ planId: 'pl-01', item: 2, hasCursor: false });
    expect(selectPlanTasksRequest({ cursor: 'abc' })).toEqual({ planId: null, item: null, hasCursor: true });
    // the handler's patterns stay with the handler: the selector is never stricter
    expect(selectPlanTasksRequest({ planId: 'not-a-plan' })).not.toBeNull();
    expect(selectPlanTasksRequest({ planId: 'pl-01', item: 0 })).not.toBeNull();
    for (const bad of [null, 7, 'x', [], { extra: 1 }, { planId: 5 }, { planId: 'pl-01', item: '1' }, { cursor: 5 }, { item: 1 }]) expect(selectPlanTasksRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('plan_tasks: the real handler', () => {
  it('lists the caller\'s assignments, every role and action, and decodes them to the handler\'s own JSON', async () => {
    const { parsed, decoded, value } = await decodedPlan('s-02', undefined);
    expect(stripped(value)).toEqual(parsed);
    expect(decoded.assessment).toBe('complete');
    const kinds = new Set(value.assignments.map((a) => `${a.role}:${a.action}`));
    for (const wanted of ['owner:start', 'owner:continue', 'owner:rework', 'owner:wait', 'verifier:verify']) expect(kinds, wanted).toContain(wanted);
    expect(value.assignments.map((a) => a.waitingFor?.kind).filter(Boolean).sort()).toEqual(['blocked', 'dependencies']);
    expect(value.finished.count).toBe(1);
    expect(value.assignments.every((a) => a.planId === 'pl-01')).toBe(true);
    expect(decoded.envelopeUnknown).toBeDefined();
  });

  it('a verifier row carries the evidence and a position that belongs to an earlier submission as stale', async () => {
    const { value, parsed } = await decodedPlan('s-02', undefined);
    const verify = value.assignments.find((a) => a.action === 'verify')!;
    expect(verify.evidence).toMatchObject({ text: 'it works', artifacts: ['a.txt', 'b.txt'] });
    expect(verify.checkpoint?.stale).toBe(true);
    expect(stripped(verify)).toEqual((parsed['assignments'] as Obj[]).find((a) => a['action'] === 'verify'));
  });

  it('the lead sees a blocked item as resolve-block, a session in no plan sees nothing, and another session\'s plan never appears', async () => {
    const lead = await decodedPlan('s-01', undefined);
    expect(lead.value.assignments.map((a) => `${a.role}:${a.action}`)).toEqual(['lead:resolve-block']);
    const other = await decodedPlan('s-04', undefined);
    expect(other.value.assignments.map((a) => a.planId)).toEqual(['pl-03']);
    const none = await decodedPlan('s-02', { planId: 'pl-01' });
    expect(none.value.assignments.every((a) => a.planId === 'pl-01')).toBe(true);
    // the autonomous plan is nobody's list, and a plan of another room is not available
    const raw = await real('s-02', 'plan_tasks', { planId: 'pl-03' });
    expect(raw.isError).toBe(true);
    const refused = decodePlanTasks({ planId: 'pl-03' }, raw);
    expect(refused).toMatchObject({ result: { ok: false, error: { kind: 'tool-error' } }, assessment: 'unknown' });
    const auto = await real('s-02', 'plan_tasks', { planId: 'pl-02' });
    expect(auto.isError).toBe(true);
  });

  it('branch plan narrows to one plan; branch item adds the full detail and echoes it', async () => {
    const plan = await decodedPlan('s-02', { planId: 'pl-01' });
    expect(plan.value.detail).toBeUndefined();
    const full = await decodedPlan('s-02', { planId: 'pl-01', item: 2 });
    expect(stripped(full.value)).toEqual(full.parsed);
    expect(full.value.detail).toMatchObject({ planId: 'pl-01', item: 2, owner: 's-02' });
    expect(full.value.assignments.every((a) => a.item === 2)).toBe(true);
    expect(full.value.detail!.log).toHaveLength(3);
    expect(full.value.detail!.progress.owner).toMatchObject({ by: 's-02', submission: null });
    expect(full.decoded.assessment).toBe('complete');
  });

  it('a detail log at its cap of 10 may have been cut: partial; below it: complete', async () => {
    const capped = await decodedPlan('s-02', { planId: 'pl-01', item: 3 });
    expect(capped.value.detail!.log).toHaveLength(DETAIL_LOG_CAP);
    expect(capped.decoded.assessment).toBe('partial');
  });

  it('pages by cursor, reads the first page\'s finished names once, and the last page is complete', async () => {
    const first = await decodedPlan('s-05', undefined);
    expect(first.value.next).not.toBeNull();
    expect(first.decoded.assessment).toBe('partial');
    expect(first.value.finished.count).toBe(FINISHED_ITEMS_CAP + 1);
    expect(first.value.finished.items).toHaveLength(FINISHED_ITEMS_CAP);
    expect(stripped(first.value)).toEqual(first.parsed);
    let cursor = first.value.next;
    let seen = first.value.assignments.length;
    let pages = 1;
    while (cursor !== null) {
      const page = await decodedPlan('s-05', { cursor });
      expect(page.value.finished.items).toEqual([]);
      expect(page.value.finished.count).toBe(FINISHED_ITEMS_CAP + 1);
      seen += page.value.assignments.length;
      pages += 1;
      cursor = page.value.next;
      expect(page.decoded.assessment).toBe(cursor === null ? 'complete' : 'partial');
    }
    expect(seen).toBe(29);
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  it('a list changed since its cursor was issued is the handler\'s own tool error, kept verbatim', async () => {
    const first = await decodedPlan('s-05', undefined);
    const flip = (status: 'ready' | 'in_progress') => updateMap(project, workId, (map) => {
      map.plans!.find((p) => p.id === 'pl-04')!.items.find((i) => i.id === 11)!.status = status;
    });
    await flip('in_progress');
    try {
      const raw = await real('s-05', 'plan_tasks', { cursor: first.value.next! });
      expect(raw.isError).toBe(true);
      expect(textOf(raw)).toContain('assignments changed');
      expect(decodePlanTasks({ cursor: first.value.next! }, raw)).toMatchObject({ result: { ok: false, error: { kind: 'tool-error', result: raw } }, assessment: 'unknown' });
    } finally {
      await flip('ready');
    }
  });

  it('a text the handler shortened ends with its cut suffix and makes the read partial; a text that merely ends so does too', async () => {
    const cut = await decodedPlan('s-06', undefined);
    expect(CUT_SUFFIX.test(cut.value.assignments[0]!.title)).toBe(true);
    expect(cut.decoded.assessment).toBe('partial');
    const accident = await decodedPlan('s-07', undefined);
    expect(accident.value.assignments[0]!.title).toBe('accidental … [cut: 9 bytes in full]');
    expect(accident.decoded.assessment).toBe('partial');
  });

  it('evidence artifacts at the cap of 10 may have been cut: partial; three: complete', async () => {
    const ten = await decodedPlan('s-08', undefined);
    expect(ten.value.assignments[0]!.evidence!.artifacts).toHaveLength(EVIDENCE_ARTIFACTS_CAP);
    expect(ten.decoded.assessment).toBe('partial');
    const three = await decodedPlan('s-10', undefined);
    expect(three.decoded.assessment).toBe('complete');
  });

  it('a first page that names 30 of 31 finished items is partial although it has no next', async () => {
    const { value, decoded } = await decodedPlan('s-12', undefined);
    expect(value.next).toBeNull();
    expect(value.assignments).toHaveLength(1);
    expect(value.finished).toMatchObject({ count: 31 });
    expect(value.finished.items).toHaveLength(FINISHED_ITEMS_CAP);
    expect(decoded.assessment).toBe('partial');
  });

  it('a stale agent gets the classic refusal, not data: plan_tasks is fenced', async () => {
    await updateMap(project, workId, (map) => {
      map.sessions.find((s) => s.id === 's-04')!.agentRevision = 'rev-new';
    });
    const raw = await real('s-04', 'plan_tasks', undefined, { agentRevision: 'rev-old' });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toBe(STALE_AGENT);
    expect(decodePlanTasks(undefined, raw)).toMatchObject({ result: { ok: false, error: { kind: 'tool-error' } }, assessment: 'unknown' });
  });

  it.each([
    ['an extra key', { bogus: 1 }],
    ['a bad planId', { planId: 'nope' }],
    ['an item without a plan', { item: 1 }],
    ['an item of zero', { planId: 'pl-01', item: 0 }],
    ['a plan that is not there', { planId: 'pl-99' }],
    ['an item that is not there', { planId: 'pl-01', item: 99 }],
    ['a bad cursor', { cursor: 'not-a-cursor' }],
  ])('%s is the handler\'s tool error, verbatim', async (_name, args) => {
    const raw = await real('s-02', 'plan_tasks', args);
    expect(raw.isError).toBe(true);
    expect(decodePlanTasks(args, raw)).toMatchObject({ result: { ok: false, error: { kind: 'tool-error', result: raw } }, assessment: 'unknown' });
  });

  it('a success the request could not have produced is an unknown request branch, never a success', async () => {
    const ok = await real('s-02', 'plan_tasks', undefined);
    expect(invalidCode(decodePlanTasks({ bogus: 1 }, ok))).toBe('unknown-request-branch');
    expect(invalidCode(decodePlanTasks({ item: 1 }, ok))).toBe('unknown-request-branch');
  });
});

describe('plan_tasks: corrupting a real response one property at a time', () => {
  const edit = async (args: Obj | undefined, session: string, change: (value: Obj) => void) => {
    const value = JSON.parse(textOf(await real(session, 'plan_tasks', args))) as Obj;
    change(value);
    return decodePlanTasks(args, wrap(value));
  };
  const first = (v: Obj) => (v['assignments'] as Obj[])[0]!;
  const cases: [string, Obj | undefined, string, (v: Obj) => void, string][] = [
    ['total below the page', undefined, 's-02', (v) => { v['total'] = 1; }, 'page-invariant'],
    ['a complete list that says it has more', undefined, 's-02', (v) => { v['next'] = 'abc'; }, 'page-invariant'],
    ['a list with a short page and no next', undefined, 's-02', (v) => { (v['assignments'] as unknown[]).pop(); }, 'page-invariant'],
    ['a next that is not a cursor', undefined, 's-05', (v) => { v['next'] = '!!'; }, 'page-invariant'],
    ['finished names beyond the count', undefined, 's-02', (v) => { (v['finished'] as Obj)['count'] = 0; }, 'page-invariant'],
    ['finished names missing on a first page', undefined, 's-05', (v) => { (v['finished'] as Obj)['items'] = []; }, 'page-invariant'],
    ['a detail that was not asked for', undefined, 's-02', (v) => { v['detail'] = {}; }, 'shape-mismatch'],
    ['a missing session', undefined, 's-02', (v) => { delete v['session']; }, 'shape-mismatch'],
    ['an unknown role', undefined, 's-02', (v) => { first(v)['role'] = 'boss'; }, 'shape-mismatch'],
    ['an unknown action', undefined, 's-02', (v) => { first(v)['action'] = 'dance'; }, 'shape-mismatch'],
    ['an unknown mode', undefined, 's-02', (v) => { first(v)['mode'] = 'free'; }, 'shape-mismatch'],
    ['an unknown status', undefined, 's-02', (v) => { first(v)['status'] = 'maybe'; }, 'shape-mismatch'],
    ['a plan id that is not one', undefined, 's-02', (v) => { first(v)['planId'] = 'p1'; }, 'shape-mismatch'],
    ['an item of zero', undefined, 's-02', (v) => { first(v)['item'] = 0; }, 'shape-mismatch'],
    ['criteria that are not strings', undefined, 's-02', (v) => { first(v)['criteria'] = [1]; }, 'shape-mismatch'],
    ['a waitingFor of an unknown kind', undefined, 's-02', (v) => { for (const a of v['assignments'] as Obj[]) if (a['waitingFor'] !== null) { (a['waitingFor'] as Obj)['kind'] = 'party'; return; } }, 'shape-mismatch'],
  ];
  it.each(cases)('%s', async (_name, args, session, change, code) => {
    const corrupted = await edit(args, session, change);
    expect(corrupted.assessment).toBe('unknown');
    expect(invalidCode(corrupted)).toBe(code);
  });

  it('an entry of another plan or item than the request names is an echo mismatch', async () => {
    const asked = await edit({ planId: 'pl-01' }, 's-02', (v) => { first(v)['planId'] = 'pl-03'; });
    expect(invalidCode(asked)).toBe('echo-mismatch');
    const item = await edit({ planId: 'pl-01', item: 2 }, 's-02', (v) => { first(v)['item'] = 5; });
    expect(invalidCode(item)).toBe('echo-mismatch');
    const detail = await edit({ planId: 'pl-01', item: 2 }, 's-02', (v) => { (v['detail'] as Obj)['item'] = 3; });
    expect(invalidCode(detail)).toBe('echo-mismatch');
    const missing = await edit({ planId: 'pl-01', item: 2 }, 's-02', (v) => { delete v['detail']; });
    expect(invalidCode(missing)).toBe('page-invariant');
  });

  it('fields the decoder does not model stay verbatim in unknownFields, at every depth', async () => {
    const decoded = await edit(undefined, 's-02', (v) => {
      v['extra'] = 1;
      first(v)['tag'] = { a: 1 };
      (v['finished'] as Obj)['note'] = 'x';
    });
    const value = (decoded.result as { value: PlanTasksValue }).value;
    expect(value.unknownFields).toEqual({ extra: 1 });
    expect(value.assignments[0]!.unknownFields).toEqual({ tag: { a: 1 } });
    expect(value.finished.unknownFields).toEqual({ note: 'x' });
  });
});

describe('plan_tasks: the cut suffix is the real one', () => {
  it('round-trips real markedExcerpt output, a zero-byte cut and a multi-byte cut included, and never matches an uncut text', () => {
    const samples = [
      markedExcerpt('x'.repeat(300), 256),
      markedExcerpt('x'.repeat(10), 0),
      markedExcerpt('é'.repeat(200), 255),
      markedExcerpt('日本語'.repeat(100), 100),
      markedExcerpt('a'.repeat(1025), 1024),
    ];
    for (const sample of samples) {
      expect(sample.cut).toBe(true);
      expect(CUT_SUFFIX.test(sample.text), sample.text.slice(-40)).toBe(true);
    }
    for (const text of ['short', '', 'é'.repeat(100), 'cut: 5 bytes in full', '… [cut: bytes in full]', 'x [cut: 5 bytes in full]', 'a … [cut: 5 bytes in full] and more']) {
      const out = markedExcerpt(text, 1024);
      expect(out.cut).toBe(false);
      expect(CUT_SUFFIX.test(out.text), text).toBe(false);
    }
  });
});

describe('attempt_status: the request', () => {
  it('names the two forms and the cursor direction, and is never stricter than the handler', () => {
    expect(selectAttemptStatusRequest(undefined)).toEqual({ attemptId: null, cursor: null });
    expect(selectAttemptStatusRequest({})).toEqual({ attemptId: null, cursor: null });
    expect(selectAttemptStatusRequest({ maxBytes: 2048 })).toEqual({ attemptId: null, cursor: null });
    expect(selectAttemptStatusRequest({ cursor: 'before:7' })).toEqual({ attemptId: null, cursor: { dir: 'before', seq: 7 } });
    expect(selectAttemptStatusRequest({ cursor: 'after:7' })).toEqual({ attemptId: null, cursor: { dir: 'after', seq: 7 } });
    expect(selectAttemptStatusRequest({ attemptId: 'at-0001', cursor: 'offset:5:abcdef012345' })).toEqual({ attemptId: 'at-0001', cursor: null });
    expect(selectAttemptStatusRequest({ attemptId: 'whatever' })).not.toBeNull();
    expect(selectAttemptStatusRequest({ maxBytes: 99 })).not.toBeNull();
    for (const bad of [null, 7, 'x', [], { extra: 1 }, { attemptId: 5 }, { cursor: 5 }, { maxBytes: '2048' }, { cursor: 'sideways:1' }, { maxBytes: Infinity }]) expect(selectAttemptStatusRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('attempt_status: the real handler', () => {
  it('lists the attempt cards of the one autonomous plan the caller belongs to, all eleven statuses, receipts and nulls', async () => {
    const { parsed, value, decoded } = await decodedAttempt('s-02', { maxBytes: 262144 });
    expect(stripped(value, true)).toEqual(parsed);
    const list = value as AttemptListValue;
    expect(list.branch).toBe('list');
    expect(list.planId).toBe('pl-02');
    expect(list.attempts).toHaveLength(12);
    expect(new Set(list.attempts.map((a) => a.status))).toEqual(new Set(ATTEMPT_STATUS_VALUES));
    expect(list.attempts.some((a) => a.receipt !== null && a.receipt.valid)).toBe(true);
    expect(list.attempts.some((a) => a.receipt !== null && !a.receipt.valid)).toBe(true);
    expect(list.attempts.some((a) => a.worker === null && a.sha === null && a.endedAt === null)).toBe(true);
    expect(decoded.assessment).toBe('complete');
  });

  it('pages backwards from the newest by `before:N` and reads forwards by `after:N`, every page checked against its cursor', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { value, decoded } = await decodedAttempt('s-02', { maxBytes: 2048, ...(cursor ? { cursor } : {}) });
      const page = value as AttemptListValue;
      ids.unshift(...page.attempts.map((a) => a.id));
      cursor = page.page.next ?? undefined;
      pages += 1;
      expect(decoded.assessment).toBe(cursor === undefined ? 'complete' : 'partial');
      expect(cursor === undefined || cursor.startsWith('before:')).toBe(true);
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    const forward: string[] = [];
    cursor = 'after:0';
    do {
      const { value } = await decodedAttempt('s-02', { maxBytes: 2048, cursor });
      const page = value as AttemptListValue;
      forward.push(...page.attempts.map((a) => a.id));
      cursor = page.page.next ?? undefined;
      expect(cursor === undefined || cursor.startsWith('after:')).toBe(true);
    } while (cursor !== undefined);
    expect(forward).toEqual(ids);
  });

  it('reads one attempt in full as paged JSON text, then keeps the middle chunks verbatim and the whole text parsed', async () => {
    const whole = await decodedAttempt('s-02', { attemptId: 'at-0002' });
    const single = whole.value;
    expect(single).toMatchObject({ branch: 'attempt', planId: 'pl-02', attemptId: 'at-0002', complete: true, offset: 0, next: null });
    expect(stripped(single, true)).toEqual(whole.parsed);
    expect(whole.decoded.assessment).toBe('complete');
    let full = '';
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { value, decoded } = await decodedAttempt('s-02', { attemptId: 'at-0001', maxBytes: 2048, ...(cursor ? { cursor } : {}) });
      const chunk = value as AttemptStatusValue & { text: string; next: string | null };
      full += chunk.text;
      cursor = chunk.next ?? undefined;
      pages += 1;
      expect(decoded.assessment).toBe(cursor === undefined ? 'complete' : 'partial');
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect((JSON.parse(full) as { id: string; manifest: { text: string } }).manifest.text).toBe('x'.repeat(4000));
  });

  it('stays readable for a stale agent: attempt_status is fence-free, plan_tasks is not', async () => {
    await updateMap(project, workId, (map) => {
      map.sessions.find((s) => s.id === 's-02')!.agentRevision = 'rev-new';
    });
    try {
      const raw = await real('s-02', 'attempt_status', undefined, { agentRevision: 'rev-old' });
      expect(raw.isError).toBeUndefined();
      expect(decodeAttemptStatus(undefined, raw).result.ok).toBe(true);
      const fenced = await real('s-02', 'plan_tasks', undefined, { agentRevision: 'rev-old' });
      expect(fenced.isError).toBe(true);
      expect(textOf(fenced)).toBe(STALE_AGENT);
    } finally {
      await updateMap(project, workId, (map) => {
        delete map.sessions.find((s) => s.id === 's-02')!.agentRevision;
      });
    }
  });

  it.each([
    ['a caller who is not a member of an autonomous room', 's-05', {}],
    ['an attempt that is not there', 's-02', { attemptId: 'at-9999' }],
    ['an invalid cursor', 's-02', { cursor: 'nope' }],
    ['a text cursor of another text', 's-02', { attemptId: 'at-0001', cursor: `offset:5:${'0'.repeat(12)}` }],
    ['an extra argument', 's-02', { extra: 1 }],
  ])('%s is the handler\'s tool error, verbatim', async (_name, session, args) => {
    const raw = await real(session, 'attempt_status', args as Obj);
    expect(raw.isError).toBe(true);
    expect(decodeAttemptStatus(args, raw)).toMatchObject({ result: { ok: false, error: { kind: 'tool-error', result: raw } }, assessment: 'unknown' });
  });

  it('reads without writing: the map and the stored map are the same after both forms of both methods, twice', async () => {
    const snapshot = async () => ({ map: JSON.stringify(await readMap(project, workId)), stored: JSON.stringify(readStoredMap(project, workId)) });
    const before = await snapshot();
    for (let i = 0; i < 2; i++) {
      await decodedAttempt('s-02', undefined);
      await decodedAttempt('s-02', { attemptId: 'at-0001', maxBytes: 2048 });
      await decodedPlan('s-02', undefined);
      await decodedPlan('s-02', { planId: 'pl-01', item: 2 });
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('attempt_status: corrupting a real response one property at a time', () => {
  const edit = async (args: Obj | undefined, change: (value: Obj) => void) => {
    const value = JSON.parse(textOf(await real('s-02', 'attempt_status', args))) as Obj;
    change(value);
    return decodeAttemptStatus(args, wrap(value));
  };
  const attempts = (v: Obj) => v['attempts'] as Obj[];
  const cases: [string, Obj | undefined, (v: Obj) => void, string][] = [
    ['returned above the card count', { maxBytes: 262144 }, (v) => { (v['page'] as Obj)['returned'] = 99; }, 'page-invariant'],
    ['complete with a next', { maxBytes: 262144 }, (v) => { (v['page'] as Obj)['next'] = 'before:3'; }, 'page-invariant'],
    ['next that is not a sequence cursor', { maxBytes: 2048 }, (v) => { (v['page'] as Obj)['next'] = 'offset:1:abc'; }, 'page-invariant'],
    ['next that does not continue from the far edge', { maxBytes: 2048 }, (v) => { (v['page'] as Obj)['next'] = 'before:999'; }, 'page-invariant'],
    ['ids that do not ascend', { maxBytes: 262144 }, (v) => { attempts(v).reverse(); }, 'page-invariant'],
    ['an id from another numbering', { maxBytes: 262144 }, (v) => { attempts(v)[0]!['id'] = 'x-1'; }, 'shape-mismatch'],
    ['an unknown status', { maxBytes: 262144 }, (v) => { attempts(v)[0]!['status'] = 'lost'; }, 'shape-mismatch'],
    ['a receipt without a verdict', { maxBytes: 262144 }, (v) => { for (const a of attempts(v)) if (a['receipt'] !== null) { delete (a['receipt'] as Obj)['valid']; return; } }, 'shape-mismatch'],
    ['a check count that is not a count', { maxBytes: 262144 }, (v) => { attempts(v)[0]!['checks'] = [1]; }, 'shape-mismatch'],
    ['a total unknown to the page', { maxBytes: 262144 }, (v) => { (v['page'] as Obj)['total'] = null; }, 'shape-mismatch'],
    ['a plan id that is not one', { maxBytes: 262144 }, (v) => { v['planId'] = 'p'; }, 'shape-mismatch'],
  ];
  it.each(cases)('%s', async (_name, args, change, code) => {
    const corrupted = await edit(args, change);
    expect(corrupted.assessment).toBe('unknown');
    expect(invalidCode(corrupted)).toBe(code);
  });

  it('a page that returns an attempt on the wrong side of its cursor is refused', async () => {
    const wrongSide = await edit({ cursor: 'after:5' }, (v) => { attempts(v)[0]!['id'] = 'at-0003'; });
    expect(invalidCode(wrongSide)).toBe('page-invariant');
    const wrongBefore = await edit({ cursor: 'before:3', maxBytes: 262144 }, (v) => { attempts(v).push({ ...attempts(v)[0]!, id: 'at-0009' }); });
    expect(invalidCode(wrongBefore)).toBe('page-invariant');
  });

  it('a detail echoes the attempt asked for, parses a whole text to that attempt, and checks the text page', async () => {
    const echoed = await edit({ attemptId: 'at-0002' }, (v) => { v['attemptId'] = 'at-0003'; });
    expect(invalidCode(echoed)).toBe('echo-mismatch');
    const other = await edit({ attemptId: 'at-0002' }, (v) => { v['text'] = JSON.stringify({ id: 'at-0007' }); v['bytes'] = Buffer.byteLength(v['text'] as string); v['totalBytes'] = v['bytes']; });
    expect(invalidCode(other)).toBe('echo-mismatch');
    const notObject = await edit({ attemptId: 'at-0002' }, (v) => { v['text'] = '[]'; v['bytes'] = 2; v['totalBytes'] = 2; });
    expect(invalidCode(notObject)).toBe('shape-mismatch');
    const notJson = await edit({ attemptId: 'at-0002' }, (v) => { v['text'] = 'no'; v['bytes'] = 2; v['totalBytes'] = 2; });
    expect(invalidCode(notJson)).toBe('text-not-strict-json');
    const pageBroken = await edit({ attemptId: 'at-0002' }, (v) => { v['bytes'] = 1; });
    expect(invalidCode(pageBroken)).toBe('page-invariant');
  });

  it('the attempt id of a partial chunk is echoed too, though the chunk is never parsed', async () => {
    const wrongChunk = await edit({ attemptId: 'at-0001', maxBytes: 2048 }, (v) => { v['attemptId'] = 'at-0002'; });
    expect(invalidCode(wrongChunk)).toBe('echo-mismatch');
  });

  it('a first-page chunk of a longer text is never parsed, and later chunks are not either', async () => {
    const first = await decodedAttempt('s-02', { attemptId: 'at-0001', maxBytes: 2048 });
    expect((first.value as { complete: boolean }).complete).toBe(false);
    expect(first.decoded.assessment).toBe('partial');
  });

  it('fields the decoder does not model stay verbatim in unknownFields', async () => {
    const decoded = await edit({ maxBytes: 262144 }, (v) => { v['extra'] = 1; attempts(v)[0]!['tag'] = 2; });
    const value = (decoded.result as { value: AttemptListValue }).value;
    expect(value.unknownFields).toEqual({ extra: 1 });
    expect(value.attempts[0]!.unknownFields).toEqual({ tag: 2 });
    const detail = await edit({ attemptId: 'at-0002' }, (v) => { v['extra'] = 1; });
    expect((detail.result as { value: { unknownFields: unknown } }).value.unknownFields).toEqual({ extra: 1 });
  });
});

describe('real handler values pass the runtime check of the delivered result', () => {
  const contract = createOutputContract(buildCatalog(TOOLS), [...MIGRATABLE_READS]);
  const settle = async (session: string, method: 'plan_tasks' | 'attempt_status', args: Obj) => {
    const raw = await real(session, method, args);
    const settled = contract.settle(method, args as never, raw.isError === true ? 'error' : 'ok', JSON.stringify(raw), 1);
    if (settled.kind !== 'ok' && settled.kind !== 'error') throw new Error('not a receipt');
    return { raw, settled, delivered: JSON.parse(settled.text!) as { ok: boolean; value?: Obj; error?: { kind: string; code?: string } } };
  };
  const forms: ['plan_tasks' | 'attempt_status', string, Obj, string | null][] = [
    ['plan_tasks', 's-02', {}, null],
    ['plan_tasks', 's-02', { planId: 'pl-01' }, null],
    ['plan_tasks', 's-02', { planId: 'pl-01', item: 2 }, null],
    ['plan_tasks', 's-02', { planId: 'pl-01', item: 6 }, null],
    ['plan_tasks', 's-05', {}, null],
    ['plan_tasks', 's-06', {}, null],
    ['plan_tasks', 's-08', {}, null],
    ['attempt_status', 's-02', {}, 'list'],
    ['attempt_status', 's-02', { maxBytes: 2048 }, 'list'],
    ['attempt_status', 's-02', { cursor: 'before:5' }, 'list'],
    ['attempt_status', 's-02', { cursor: 'after:5', maxBytes: 2048 }, 'list'],
    ['attempt_status', 's-02', { attemptId: 'at-0002' }, 'attempt'],
    ['attempt_status', 's-02', { attemptId: 'at-0001', maxBytes: 2048 }, 'attempt'],
  ];
  it.each(forms)('%s as %s %j', async (method, session, args, branch) => {
    const { settled, delivered } = await settle(session, method, args);
    expect(delivered.error).toBeUndefined();
    expect(delivered.ok).toBe(true);
    expect(settled.kind).toBe('ok');
    if (branch !== null) expect(delivered.value!['branch']).toBe(branch);
  });

  it('a tool error is delivered as the original result', async () => {
    const { raw, settled, delivered } = await settle('s-02', 'plan_tasks', { planId: 'pl-99' });
    expect(settled).toMatchObject({ kind: 'error', assessment: 'unknown' });
    expect(delivered).toEqual({ ok: false, error: { kind: 'tool-error', result: raw } });
  });

  it('m-5407: an argument that succeeds at the handler is never refused by a decoder', async () => {
    for (const [method, session, args] of [
      ['plan_tasks', 's-02', { planId: 'pl-01', item: 1 }],
      ['plan_tasks', 's-05', { cursor: (await decodedPlan('s-05', undefined)).value.next! }],
      ['attempt_status', 's-02', { maxBytes: 2048 }],
      ['attempt_status', 's-02', { maxBytes: 262144, cursor: 'before:12' }],
    ] as const) {
      const { delivered } = await settle(session, method, args as Obj);
      expect(delivered.ok, `${method} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe('the invalid-output codes these adapters can give are the shared ones', () => {
  it('uses only codes of INVALID_OUTPUT_CODES', () => {
    for (const code of ['page-invariant', 'shape-mismatch', 'echo-mismatch', 'unknown-request-branch', 'text-not-strict-json']) expect(INVALID_OUTPUT_CODES).toContain(code);
  });
});

describe('the 16 KiB final value cap, at the guest', () => {
  const answerWith = (bytes: number) => async (value: Obj): Promise<string> => {
    // pad one text so the serialized decoded value is exactly `bytes` long
    const sized = (pad: number) => JSON.stringify({ ...value, pad: 'x'.repeat(pad) });
    const fixed = Buffer.byteLength(sized(0), 'utf8');
    return sized(bytes - fixed);
  };
  const bridgeFor = (text: string): GuestBridge => {
    const ready: { rid: number; ok: boolean; value: string }[] = [];
    return {
      send: (call) => { ready.push({ rid: call.rid, ok: true, value: text }); },
      next: () => Promise.resolve(ready.shift() ?? null),
    };
  };
  const runWith = async (method: 'plan_tasks' | 'attempt_status', value: Obj, bytes: number) => {
    const text = await answerWith(bytes)(value);
    expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
    return runGuest(`return await parley.${method}({});`, [method], { ...GUEST_LIMITS }, bridgeFor(text));
  };

  it.each([
    ['plan_tasks', async () => (await decodedPlan('s-02', undefined)).value as unknown as Obj],
    ['attempt_status', async () => (await decodedAttempt('s-02', { maxBytes: 262144 })).value as unknown as Obj],
  ] as const)('%s: a decoded value of 16,383 and 16,384 bytes passes, 16,385 is a typed result-size error', async (method, make) => {
    const value = await make();
    for (const bytes of [GUEST_LIMITS.resultBytes - 1, GUEST_LIMITS.resultBytes]) {
      const outcome = await runWith(method, value, bytes);
      expect(outcome, `${method} ${bytes}`).toMatchObject({ ok: true });
    }
    expect(await runWith(method, value, GUEST_LIMITS.resultBytes + 1)).toMatchObject({ ok: false, error: { kind: 'result-size' } });
  });

  it('the handler\'s default plan_tasks page can fill the cap: a later page is still reachable by the cursor', async () => {
    const first = await decodedPlan('s-05', undefined);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeGreaterThan(GUEST_LIMITS.resultBytes - 2048);
    expect(first.value.next).not.toBeNull();
    const second = await decodedPlan('s-05', { cursor: first.value.next! });
    expect(second.value.assignments.length).toBeGreaterThan(0);
  });
});
