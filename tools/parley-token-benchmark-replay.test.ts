// T9a harness, slice H1: the pure core. The goal-file check, the judge, the self-check, the refusals to run and the report. No process, no file of
// the repository besides the three modules under test. The frozen goals file is NOT read here: it is copied by sha at the freeze (harness text §3).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRun } from './parley-token-benchmark.js';
import { agentViewOf } from './parley-token-benchmark-replay-judge.js';
import {
  CLASSES, MIN_GOALS, REPORT_HEADER, armAccounting, buildReport, checkGoalFile, classicLayerWithExamplesRewrite, deepEqual, invariants, judgeLaunchGoal, judgeRollbackGoal, judgeRunGoal, missingClasses,
  parsePath, pathCriterion, runRefusals, runSelfChecks, selfCheckCases, selfCheckControl, sha256, valueAt,
  type ArmObservation, type ConservationObservation, type Goal, type HostEntry, type Ids, type LaunchView, type Verdict,
} from './parley-token-benchmark-replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SS = sha256('scripts');
const IDS = { sessions: { peer: 's-02', self: 's-01' }, rooms: { room: 'r-01' } };

// ---------- builders ----------

const DATA = { self: 'self', sessions: [{ key: 'self', label: 'Self', provider: 'claude', lifecycle: 'active' }, { key: 'peer', label: 'Peer', provider: 'codex', lifecycle: 'active' }] };
const runGoal = (id: string, cls: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, class: cls, kind: 'run', goal: 'a sentence', arms: ['classic', 'replacement'], data: DATA, answer: { value: 'the value' }, criteria: [{ answer: { path: 'value', present: true } }], ...over,
});
const launchGoal = (id: string, cls: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, class: cls, kind: 'launch', goal: 'a sentence',
  launch: { provider: 'claude', mode: 'new', role: null, recipe: null, navigator: false, channel: false, agent: true, routing: 'shipped' },
  criteria: [{ layer: { startsWith: 'Parley' } }], ...over,
});
const rollbackGoal = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, class: 'rollback', kind: 'rollback', goal: 'a sentence', rollback: { record: 'held-live', requested: true, refused: null, writesExist: false },
  criteria: [{ selection: { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' } }], ...over,
});
const REPLACEMENT_ONLY = { arms: ['replacement'], armsReason: 'replacement-only: classic has no such surface' };
/** One goal per class: the smallest file the check accepts (before the minimum of 20). */
function fullGoals(): Record<string, unknown>[] {
  return CLASSES.map((cls, i) => {
    const id = `g-${cls}`;
    if (cls.startsWith('routing-')) return launchGoal(id, cls);
    if (cls === 'rollback') return rollbackGoal(id);
    if (cls.startsWith('conservation-')) return runGoal(id, cls, { answer: {}, criteria: [{ toolList: { partition: true } }] });
    if (['policy-zero-call', 'resource', 'ipc', 'abort', 'draining'].includes(cls)) {
      return runGoal(id, cls, { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ run: { attemptedExecute: true, status: 'error', errorKind: 'unavailable', runId: null, operations: [] } }, { host: { calls: 0 } }], faults: { policy: { state: 'unknown' } } });
    }
    void i;
    return runGoal(id, cls);
  });
}
const file = (goals: unknown[]): unknown => ({ version: 1, goals });
const issuesOf = (raw: unknown): string[] => {
  const r = checkGoalFile(raw);
  return r.ok ? [] : r.issues.map((x) => `${x.path}: ${x.message}`);
};
const refused = (goal: Record<string, unknown>, expected: RegExp): void => {
  const issues = issuesOf(file([goal]));
  expect(issues.length, JSON.stringify(goal).slice(0, 80)).toBeGreaterThan(0);
  expect(issues.join('\n')).toMatch(expected);
};
const accepted = (goal: Record<string, unknown>): void => { expect(issuesOf(file([goal]))).toEqual([]); };

// ---------- the goal-file check ----------

describe('the goal-file check: what it accepts', () => {
  it('accepts one goal of every class, and reports a class with no goal', () => {
    const ok = checkGoalFile(file(fullGoals()));
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.goals).toHaveLength(CLASSES.length); expect(missingClasses(ok.goals)).toEqual([]); expect(missingClasses(ok.goals.slice(1))).toEqual([CLASSES[0]]); }
  });

  it('accepts the forms the frozen goals use: the answer wrapper, name[*].field paths, answer {} for a run with no value, conservation inputs at the top level', () => {
    accepted(runGoal('a', 'paging', { answer: { messages: 'the letters' }, criteria: [{ answer: { path: 'messages[*].text', contains: 'X' } }, { answer: { path: 'messages[*].from', contains: { $session: 'peer' } } }, { equalAcrossArms: 'messages' }] }));
    accepted(runGoal('b', 'conservation-list', { answer: {}, profile: 'full', navigator: false, agent: true, criteria: [{ toolList: { partition: true } }, { catalogue: { namesEqualOriginal: true } }] }));
    accepted(runGoal('c', 'policy-zero-call', { ...REPLACEMENT_ONLY, answer: {}, faults: { policy: { state: 'unknown' } }, criteria: [{ run: { attemptedExecute: true, status: 'error', errorKind: 'unavailable', runId: null, operations: [] } }, { host: { calls: 0 } }] }));
    expect(parsePath('messages[*].text')).toEqual(['messages', '*', 'text']);
    expect(parsePath('rooms.0.title')).toEqual(['rooms', 0, 'title']);
    expect(parsePath('a..b')).toBeNull();
  });

  it('expands repeat in place and in order, with ${i} in every string including the key, before any reference is checked', () => {
    const r = checkGoalFile(file([runGoal('a', 'paging', { data: { self: 's1', sessions: [{ repeat: 3, of: { key: 's${i}', label: 'Peer ${i}', provider: 'claude', lifecycle: 'active' } }], rooms: [{ key: 'r1', title: 'R', lead: 's1', members: ['s1', 's2'] }] } })]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goals[0]!.data!.sessions.map((s) => `${String(s['key'])}/${String(s['label'])}`)).toEqual(['s1/Peer 1', 's2/Peer 2', 's3/Peer 3']);
  });
});

describe('the goal-file check: what it refuses, each naming the field', () => {
  it('a file that is not the container, a wrong version, an unknown top-level field', () => {
    expect(issuesOf(null).join()).toMatch(/JSON object/);
    expect(issuesOf({ version: 2, goals: [] }).join()).toMatch(/version/);
    expect(issuesOf({ version: 1, goals: [], extra: 1 }).join()).toMatch(/extra: unknown field/);
    expect(issuesOf({ version: 1, goals: 'x' }).join()).toMatch(/goals: an array/);
  });

  it('an unknown field at the goal, data and criterion levels; an unknown class or kind; a duplicate or bad id', () => {
    refused(runGoal('a', 'paging', { surprise: 1 }), /surprise: unknown field/);
    refused(runGoal('a', 'paging', { data: { ...DATA, extra: 1 } }), /data.extra: unknown field/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', present: true }, wat: 1 }] }), /not a criterion|takes no sibling/);
    refused(runGoal('a', 'nonsense'), /class: one of/);
    refused(runGoal('a', 'paging', { kind: 'other' }), /kind: run, launch or rollback/);
    refused(runGoal('Bad_Id', 'paging'), /kebab-case/);
    expect(issuesOf(file([runGoal('a', 'paging'), runGoal('a', 'error')])).join()).toMatch(/duplicate id a/);
  });

  it('kind and class go together: routing-* is a launch goal, rollback a rollback goal, the rest run goals', () => {
    refused(runGoal('a', 'routing-role'), /launch goal/);
    refused(launchGoal('a', 'paging'), /is a run goal/);
    refused(launchGoal('a', 'rollback'), /rollback goal/);
    refused(rollbackGoal('a', { class: 'paging' }), /is a run goal/);
  });

  it('arms: replacement-only only for the five classes, with armsReason, which is forbidden with two arms; classic-only does not exist', () => {
    refused(runGoal('a', 'paging', REPLACEMENT_ONLY), /runs both arms/);
    refused(runGoal('a', 'abort', { arms: ['replacement'] }), /armsReason: required/);
    refused(runGoal('a', 'abort', { arms: ['classic', 'replacement'], armsReason: 'why' }), /armsReason: forbidden/);
    refused(runGoal('a', 'paging', { armsReason: 'why' }), /armsReason: forbidden/);
    refused(runGoal('a', 'abort', { arms: ['classic'], armsReason: 'x' }), /arms: \["classic"/);
    for (const cls of ['policy-zero-call', 'resource', 'ipc', 'abort', 'draining']) accepted(runGoal('a', cls, { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ run: { status: 'completed' } }] }));
  });

  it('answer: a run goal needs it; a criterion path must start at a declared name; {} forbids a criterion that reads an answer value', () => {
    const noAnswer = runGoal('a', 'paging'); delete noAnswer['answer'];
    refused(noAnswer, /answer: an object/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'other', present: true } }] }), /does not declare/);
    refused(runGoal('a', 'paging', { answer: {} }), /answer: is \{\}, yet a criterion reads/);
    refused(runGoal('a', 'paging', { answer: { value: '' } }), /what it means/);
    refused(launchGoal('a', 'routing-role', { answer: { x: 'y' } }), /answer: unknown field/);
  });

  it('data: duplicate keys, references that do not resolve, a self that is not a session, a room without its lead, a message from a non-member', () => {
    refused(runGoal('a', 'paging', { data: { self: 'x', sessions: DATA.sessions } }), /self: x is not a session key/);
    refused(runGoal('a', 'paging', { data: { ...DATA, sessions: [...DATA.sessions, DATA.sessions[0]] } }), /duplicate key self/);
    refused(runGoal('a', 'paging', { data: { ...DATA, rooms: [{ key: 'r', title: 'R', lead: 'ghost', members: ['self'] }] } }), /lead: a session key/);
    refused(runGoal('a', 'paging', { data: { ...DATA, rooms: [{ key: 'r', title: 'R', lead: 'self', members: ['peer'] }] } }), /must include the lead/);
    const room = { key: 'r', title: 'R', lead: 'self', members: ['self'] };
    refused(runGoal('a', 'paging', { data: { ...DATA, rooms: [room, room] } }), /duplicate key r/);
    refused(runGoal('a', 'paging', { data: { ...DATA, rooms: [{ key: 'r', title: 'R', lead: 'self', members: ['self'], messages: [{ from: 'peer', text: 't', kind: 'note' }] }] } }), /from: human, or a session that is a member/);
    refused(runGoal('a', 'paging', { data: { ...DATA, sessions: [{ key: 'self', label: 'L', provider: 'gpt', lifecycle: 'active' }] } }), /provider: one of/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', equals: { $session: 'ghost' } } }] }), /\$session: does not resolve/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', equals: { $room: 'ghost' } } }] }), /\$room: does not resolve/);
  });

  it('repeat: nesting is refused, n at least 1, a key collision after expansion is refused; $pad needs a size and a string', () => {
    refused(runGoal('a', 'paging', { data: { self: 's1', sessions: [{ repeat: 2, of: { repeat: 2, of: { key: 's${i}', label: 'L', provider: 'claude', lifecycle: 'active' } } }] } }), /may not be nested/);
    refused(runGoal('a', 'paging', { data: { self: 's1', sessions: [{ repeat: 0, of: { key: 's1', label: 'L', provider: 'claude', lifecycle: 'active' } }] } }), /repeat: an integer of at least 1/);
    refused(runGoal('a', 'paging', { data: { self: 's1', sessions: [{ repeat: 2, of: { key: 'same', label: 'L', provider: 'claude', lifecycle: 'active' } }] } }), /duplicate key same/);
    refused(runGoal('a', 'paging', { data: { ...DATA, sessions: [{ key: 'self', label: { $pad: 0, with: 'x' }, provider: 'claude', lifecycle: 'active' }] } }), /\$pad: a positive integer/);
    refused(runGoal('a', 'paging', { data: { ...DATA, sessions: [{ key: { $pad: 3, with: 'x' }, label: 'L', provider: 'claude', lifecycle: 'active' }] } }), /key: a string/);
    accepted(runGoal('a', 'paging', { data: { ...DATA, sessions: [{ key: 'self', label: { $pad: 3000, with: 'x' }, provider: 'claude', lifecycle: 'active' }, DATA.sessions[1]] } }));
  });

  it('plans: a room key, members as owners, earlier ids in after, unique ids', () => {
    const room = { key: 'r', title: 'R', lead: 'self', members: ['self', 'peer'] };
    const plan = (items: unknown[], over: Record<string, unknown> = {}) => runGoal('a', 'read-dto', { data: { ...DATA, rooms: [room], plans: [{ key: 'p', room: 'r', mode: 'checklist', goal: 'g', status: 'active', items, ...over }] } });
    accepted(plan([{ id: 1, title: 't', owner: 'peer', scope: 's' }, { id: 2, title: 't', owner: 'self', scope: 's', after: [1], verifier: 'peer' }]));
    refused(plan([{ id: 1, title: 't', owner: 'peer', scope: 's', after: [2] }]), /not an earlier id/);
    refused(plan([{ id: 1, title: 't', owner: 'peer', scope: 's' }, { id: 1, title: 't', owner: 'peer', scope: 's' }]), /duplicate id 1/);
    refused(plan([{ id: 1, title: 't', owner: 'ghost', scope: 's' }]), /owner: a session key/);
    refused(plan([{ id: 1, title: 't', owner: 'peer', scope: 's' }], { room: 'ghost' }), /room: a room key/);
    refused(plan([]), /items: a non-empty array/);
  });

  it('faults are closed: policy states, host replies, afterCalls, limits that may only be lowered, guest events, resource sides', () => {
    const f = (faults: Record<string, unknown>) => runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ run: { status: 'completed' } }], faults });
    accepted(f({ policy: { state: 'revoked', afterCalls: 2 }, host: { call: '404', list: 'ok', callMethod: 'get_map', afterCalls: 1 }, abort: { afterCalls: 1 }, limits: { responseBytes: 1000 }, guest: { event: 'kill-helper', afterCalls: 1 }, localCanary: 'C' }));
    refused(f({ policy: { state: 'maybe' } }), /policy.state/);
    refused(f({ host: { call: 'boom' } }), /host.call/);
    refused(f({ abort: {} }), /abort.afterCalls/);
    refused(f({ abort: { afterCalls: 0 } }), /abort.afterCalls/);
    refused(f({ limits: { wallMs: 0 } }), /limits.wallMs/);
    refused(f({ limits: { speed: 1 } }), /limits.speed: unknown field/);
    refused(f({ guest: { event: 'kill-helper' } }), /guest.afterCalls/);
    refused(f({ guest: { event: 'explode' } }), /guest.event/);
    refused(f({ resource: { bound: 'wallMs', input: 'at-limit' } }), /cannot be reached exactly: far-over only/);
    accepted(f({ resource: { bound: 'wallMs', input: 'far-over' } }));
    accepted(f({ resource: { bound: 'responseBytes', input: 'one-over' } }));
    refused(f({ resource: { bound: 'bytes', input: 'one-over' } }), /resource.bound/);
    refused(f({ unknownFault: 1 }), /unknownFault: unknown field/);
  });

  it('non-vacuity: absent needs a positive partner on its path or parent; host.calls 0 needs a witness of the attempt; callsAfter pairs with calls', () => {
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', absent: true } }] }), /absent: needs a positive criterion/);
    accepted(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value.inner', absent: true } }, { answer: { path: 'value', present: true } }] }));
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ host: { calls: 0 } }] }), /needs a witness of the attempt/);
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ host: { calls: 0 } }, { run: { attemptedExecute: true } }] }), /needs a witness/);
    accepted(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ host: { calls: 0 } }, { run: { operations: [{ method: 'get_map', outcome: 'refused', dispatched: false }] } }] }));
    accepted(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ host: { calls: 0 } }, { run: { attemptedExecute: true, errorKind: 'unavailable' } }] }));
    const after = (extra: object[]) => runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, faults: { abort: { afterCalls: 2 } }, criteria: [{ run: { status: 'partial-or-unknown' } }, ...extra] });
    refused(after([{ host: { callsAfter: { fault: 'abort', n: 0 } } }]), /pairs with a host.calls/);
    refused(after([{ host: { callsAfter: { fault: 'abort', n: 0 } } }, { host: { calls: 1 } }]), /must be at least 2/);
    accepted(after([{ host: { callsAfter: { fault: 'abort', n: 0 } } }, { host: { calls: 2 } }]));
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ run: { status: 'completed' } }, { host: { calls: 2 } }, { host: { callsAfter: { fault: 'abort', n: 0 } } }] }), /has no abort fault with afterCalls/);
  });

  it('$canary needs faults.localCanary; neverContains needs a non-empty string', () => {
    refused(runGoal('a', 'hostile-data', { criteria: [{ text: { neverContains: { $canary: true } } }, { answer: { path: 'value', present: true } }] }), /\$canary needs faults.localCanary/);
    accepted(runGoal('a', 'hostile-data', { faults: { localCanary: 'C' }, criteria: [{ text: { neverContains: { $canary: true } } }, { answer: { path: 'value', present: true } }] }));
    refused(runGoal('a', 'hostile-data', { criteria: [{ text: { neverContains: '' } }] }), /non-empty string/);
  });

  it('equalAcrossArms: both arms, no fault, not on no-local-fallback or host-404; a run criterion is the replacement arm\'s; the record too', () => {
    refused(runGoal('a', 'paging', { faults: { localCanary: 'C' }, criteria: [{ equalAcrossArms: 'value' }] }), /not allowed on a goal with a fault/);
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, criteria: [{ equalAcrossArms: 'value' }] }), /needs both arms/);
    refused(runGoal('a', 'no-local-fallback', { criteria: [{ equalAcrossArms: 'value' }] }), /not allowed on no-local-fallback/);
    refused(runGoal('a', 'host-404', { criteria: [{ equalAcrossArms: 'value' }] }), /not allowed on host-404/);
    refused(runGoal('a', 'paging', { criteria: [{ arm: 'classic', run: { status: 'completed' } }] }), /replacement arm's only/);
    refused(runGoal('a', 'paging', { criteria: [{ arm: 'classic', record: { state: 'free' } }] }), /belongs to the replacement arm/);
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: {}, criteria: [{ arm: 'classic', host: { calls: 0 } }] }), /is not an arm of this goal/);
  });

  it('answer criteria: one operator, [*] only with count, countAtLeast and contains, counts are integers', () => {
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', present: true, equals: 1 } }] }), /exactly one of/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value[*]', equals: 1 } }] }), /\[\*\] is allowed only with/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', count: -1 } }] }), /non-negative integer/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', oneOf: [] } }] }), /non-empty array/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', present: false } }] }), /present: true/);
    refused(runGoal('a', 'paging', { criteria: [{ answer: { path: 'value', wat: 1 } }] }), /unknown field/);
  });

  it('run criteria: closed keys and enums, operations exclusive of operationsInclude, runId only null', () => {
    const run = (r: object) => runGoal('a', 'error', { criteria: [{ run: r }] });
    refused(run({ status: 'maybe' }), /run.status/);
    refused(run({ errorKind: 'nope' }), /run.errorKind/);
    refused(run({ busyReason: 'nope' }), /run.busyReason/);
    refused(run({ runId: 'run-1' }), /runId: null/);
    refused(run({ operations: [{ method: 'a', outcome: 'ok', dispatched: true }] }), /outcome/);
    refused(run({ operations: [], operationsInclude: [] }), /exclusive/);
    refused(run({ limitReached: 'speed' }), /limitReached/);
    refused(run({ diagnostic: 'speed' }), /diagnostic/);
    refused(run({ speed: 1 }), /speed: unknown field/);
  });

  it('conservation criteria belong to the conservation classes only, and their inputs to those goals', () => {
    refused(runGoal('a', 'paging', { answer: {}, criteria: [{ toolList: { partition: true } }] }), /only the conservation-\* classes/);
    refused(runGoal('a', 'conservation-list', { answer: {}, criteria: [{ toolList: { partition: false } }] }), /exactly one of the three/);
    refused(runGoal('a', 'conservation-source', { answer: {}, criteria: [{ sources: { unchanged: ['nothing'] } }] }), /subset of/);
    refused(runGoal('a', 'paging', { profile: 'full' }), /profile: unknown field/);
    refused(runGoal('a', 'conservation-profile', { answer: {}, profile: 'huge', criteria: [{ toolList: { partition: true } }] }), /full or short/);
    accepted(runGoal('a', 'conservation-source', { answer: {}, criteria: [{ sources: { unchanged: ['guide', 'roles'] } }] }));
  });

  it('launch goals: closed inputs, one criterion per entry, the bootstrap comparison refused on a classic launch', () => {
    const launch = (over: object) => launchGoal('a', 'routing-role', { launch: { provider: 'claude', mode: 'new', role: null, recipe: null, navigator: false, channel: false, agent: true, routing: 'shipped', ...over } });
    accepted(launch({ role: { customPrompt: 'p' }, routing: { fixture: ['get_map'] }, profile: 'short', skills: { catalogue: 'verified', entries: [{ name: 'n', description: 'd', source: 'user' }] } }));
    refused(launch({ provider: 'gpt' }), /provider/);
    refused(launch({ routing: 'maybe' }), /routing/);
    refused(launch({ role: { nope: 1 } }), /role: null, a builtin role id/);
    refused(launch({ skills: { catalogue: 'none', entries: [{ name: 'n', description: 'd', source: 'user' }] } }), /none holds no entries/);
    refused(launch({ skills: { catalogue: 'verified', entries: [{ name: 'n', description: 'd', source: 'elsewhere' }] } }), /source/);
    refused(launch({ surprise: 1 }), /surprise: unknown field/);
    refused(launchGoal('a', 'routing-role', { criteria: [{ layer: { startsWith: 'a', contains: 'b' } }] }), /exactly one of startsWith/);
    refused(launchGoal('a', 'routing-role', { criteria: [{ nothing: true }] }), /not a criterion of a launch goal/);
    refused(launchGoal('a', 'routing-role', { launch: { provider: 'claude', mode: 'new', role: null, recipe: null, navigator: false, channel: false, agent: true, routing: 'classic' }, criteria: [{ layerEqualsClassicWithBootstrap: true }] }), /a classic launch has no bootstrap/);
    expect(issuesOf(file([launchGoal('a', 'routing-role', { criteria: [{ layer: { startsWith: 'x' } }, { tools: { includes: ['get_map'], count: 49 } }, { throws: 'role-delivery-unavailable' }, { brief: { contains: 'b' } }, { selectsClassic: { value: false } }, { verdict: { source: 'role', status: 'compatible' } }, { skillCatalogue: { excludes: ['x'] } }, { env: { lacks: 'X' } }, { argv: { equalsClassicOutsideLayer: true } }] })]))).toEqual([]);
    const known = checkGoalFile(file([launchGoal('a', 'routing-role', { launch: { provider: 'claude', mode: 'new', role: 'builtin:ghost', recipe: null, navigator: false, channel: false, agent: true, routing: 'shipped' } })]), { knownBuiltinRoles: ['builtin:planner'] });
    expect(known.ok).toBe(false);
  });

  it('rollback goals: the record set, the selection fields that go together, nothing launches after a blocked selection, calls 0 needs the busy witness', () => {
    accepted(rollbackGoal('a'));
    refused(rollbackGoal('a', { rollback: { record: 'weird', requested: true, refused: null, writesExist: false } }), /record/);
    refused(rollbackGoal('a', { criteria: [{ selection: { effective: 'replacement', reason: 'held-run' } }] }), /null for replacement/);
    refused(rollbackGoal('a', { criteria: [{ selection: { effective: 'classic', reason: 'whatever' } }] }), /held-run, not-requested or the given refused/);
    refused(rollbackGoal('a', { criteria: [{ selection: { effective: 'blocked', reason: 'held-run' } }] }), /non-read-record or unreadable-record/);
    refused(rollbackGoal('a', { criteria: [{ selection: { effective: 'classic', reason: 'not-requested', held: 'unaccounted' } }] }), /only with a classic held-run/);
    refused(rollbackGoal('a', { criteria: [{ selection: { effective: 'blocked', reason: 'non-read-record' } }, { nextLaunch: { tools: 1, wrappers: false } }] }), /launches nothing/);
    refused(rollbackGoal('a', { criteria: [{ calls: 0 }] }), /needs the busy criterion/);
    accepted(rollbackGoal('a', { criteria: [{ calls: 0 }, { busy: { reason: 'previous-process-unaccounted' } }] }));
    refused(rollbackGoal('a', { criteria: [{ repeatSelection: 1 }] }), /at least 2/);
    accepted(rollbackGoal('a', { rollback: { record: 'none', requested: false, refused: 'detector', writesExist: true }, criteria: [{ selection: { effective: 'classic', reason: 'detector' } }, { recordUnchanged: true }, { nextLaunch: { tools: 49, wrappers: false, bootstrapContains: 'x' } }] }));
  });
});

// ---------- the judge: values ----------

/** An answered script request whose agent text is exactly the projection of the parent's own result (a clean read has no row and a completed run no run id). */
const CLEAN_EXECUTE = { seq: 1, text: '{"status":"completed","incomplete":false,"value":null}', isError: false, full: { contract: 4, runId: 'run-1-1', status: 'completed', error: null, value: null, incomplete: false, diagnostics: [], diagnosticsTruncated: false, operations: [{ ordinal: 1, method: 'get_map', argsSha256: 'a'.repeat(64), dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false }] } } as const;
const obs = (arm: 'classic' | 'replacement', over: Partial<ArmObservation> = {}): ArmObservation => ({
  arm, answer: { items: ['a', 'b'], title: 'T', nothing: null, messages: [{ from: 's-02', kind: 'note', text: 'AMBER-FIRST here' }, { from: 's-01', kind: 'question', text: 'q' }] },
  result: arm === 'replacement' ? { status: 'completed', error: null, runId: 'run-1-1', incomplete: false, operations: [{ ordinal: 1, method: 'get_map', dispatched: true, outcome: 'succeeded', incomplete: false }], diagnostics: [] } : null,
  attemptedExecute: arm === 'replacement', hostLog: [{ seq: 1, op: 'call', callId: 'c-1', method: 'get_map', handlerStarted: true }], faultFiredAtSeq: {}, received: 'something', record: 'free', leftoverHelper: false, canaryReadable: true, skipped: 0, executes: arm === 'replacement' ? [CLEAN_EXECUTE] : [], ...over,
});
const goalOf = (criteria: object[], over: Record<string, unknown> = {}): Goal => {
  const r = checkGoalFile(file([runGoal('j', 'paging', { answer: { items: 'i', title: 't', nothing: 'n', messages: 'm' }, criteria, ...over })]));
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.path} ${i.message}`).join('; '));
  return r.goals[0]!;
};
const pass = (v: { pass: boolean }[]): boolean => v.every((x) => x.pass);

describe('the judge: path semantics', () => {
  const answer = obs('classic').answer;
  const p = (c: object) => pathCriterion(answer, c as never, IDS).pass;
  it('null means present and null; absent means the key is missing; present means the key exists', () => {
    expect(p({ path: 'nothing', equals: null })).toBe(true);
    expect(p({ path: 'gone', equals: null })).toBe(false);
    expect(p({ path: 'nothing', absent: true })).toBe(false);
    expect(p({ path: 'gone', absent: true })).toBe(true);
    expect(p({ path: 'nothing', present: true })).toBe(true);
  });
  it('arrays compare in order, objects by key with order ignored, a type mismatch is a failed criterion not an error', () => {
    expect(p({ path: 'items', equals: ['a', 'b'] })).toBe(true);
    expect(p({ path: 'items', equals: ['b', 'a'] })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(p({ path: 'title', count: 1 })).toBe(false);
    expect(p({ path: 'items', contains: 'a' })).toBe(true);
    expect(p({ path: 'title', contains: 'T' })).toBe(true);
    expect(p({ path: 'title', contains: 5 })).toBe(false);
  });
  it('[*] maps over an array: contains on strings is per element, count counts the mapped elements, a $session is resolved to its id', () => {
    expect(p({ path: 'messages[*].text', contains: 'AMBER-FIRST' })).toBe(true);
    expect(p({ path: 'messages[*].text', contains: 'ZZZ' })).toBe(false);
    expect(p({ path: 'messages[*].kind', count: 2 })).toBe(true);
    expect(p({ path: 'messages[*].kind', countAtLeast: 2 })).toBe(true);
    expect(p({ path: 'messages[*].kind', countAtLeast: 3 })).toBe(false);
    expect(p({ path: 'messages[*].from', contains: { $session: 'peer' } })).toBe(true);
    expect(p({ path: 'messages[*].from', contains: { $session: 'ghost' } })).toBe(false);
    expect(p({ path: 'messages[*].nope', count: 0 })).toBe(true);
    expect(valueAt(answer, 'items.1')).toBe('b');
    expect(typeof valueAt(answer, 'items.9')).toBe('symbol');
  });
});

describe('the judge: a run goal', () => {
  const run = (criteria: object[], o: Partial<ArmObservation> = {}, over: Record<string, unknown> = {}) =>
    judgeRunGoal(goalOf(criteria, { arms: ['replacement'], armsReason: 'replacement-only: x', class: 'abort', ...over }), { replacement: obs('replacement', o) }, IDS);

  it('run criteria read the ExecuteResult: status, incomplete, error kind, busy reason, run id, operations exact and as an ordered subsequence', () => {
    expect(pass(run([{ run: { status: 'completed', incomplete: false, operations: [{ method: 'get_map', outcome: 'succeeded', dispatched: true }] } }]))).toBe(true);
    expect(pass(run([{ run: { operationsInclude: [{ method: 'get_map', outcome: 'succeeded', dispatched: true }] } }]))).toBe(true);
    const two = { ...obs('replacement').result!, operations: [{ ordinal: 1, method: 'a', dispatched: true, outcome: 'succeeded', incomplete: false }, { ordinal: 2, method: 'b', dispatched: true, outcome: 'failed', incomplete: false }] };
    const hostTwo: HostEntry[] = [{ seq: 1, op: 'call', callId: 'x1', method: 'a', handlerStarted: true }, { seq: 2, op: 'call', callId: 'x2', method: 'b', handlerStarted: true }];
    const sub = (want: object[]) => pass(run([{ run: { operationsInclude: want } }], { result: { ...two, status: 'completed' }, hostLog: hostTwo }));
    const A = { method: 'a', outcome: 'succeeded', dispatched: true };
    const B = { method: 'b', outcome: 'failed', dispatched: true };
    expect(sub([A, B])).toBe(true);
    expect(sub([B, A])).toBe(false);
    expect(sub([B])).toBe(true);
    const busy = { ...two, status: 'error', error: { kind: 'busy' }, runId: null, operations: [], incomplete: true, diagnostics: [{ code: 'busy', params: { reason: 'previous-run-draining' } }] };
    expect(pass(run([{ run: { errorKind: 'busy', busyReason: 'previous-run-draining', runId: null, operations: [], status: 'error', incomplete: true } }], { result: busy, hostLog: [] }))).toBe(true);
    expect(pass(run([{ run: { diagnostic: 'busy' } }], { result: busy, hostLog: [] }))).toBe(true);
  });

  it('host criteria are counted on the raw log: lists are in no count, a repeated call id counts per attempt and once as distinct, callsAfter counts after the fault', () => {
    const log: HostEntry[] = [
      { seq: 1, op: 'list', callId: null, method: null, handlerStarted: false }, { seq: 2, op: 'call', callId: 'c1', method: 'get_map', handlerStarted: true },
      { seq: 3, op: 'call', callId: 'c1', method: 'get_map', handlerStarted: false }, { seq: 4, op: 'call', callId: 'c2', method: 'read_room', handlerStarted: true },
    ];
    const crit = (v: { where: string; pass: boolean }[]) => v.filter((x) => x.where.startsWith('criteria'));
    const h = (host: object, o: Partial<ArmObservation> = {}) => pass(crit(run([{ host }], { hostLog: log, ...o })));
    expect(h({ calls: 3, distinctCalls: 2, lists: 1, attemptsOf: { method: 'get_map', n: 2 }, maxAttemptsPerCall: 2, handlerStarts: { n: 2 } })).toBe(true);
    expect(h({ maxAttemptsPerCall: 1 })).toBe(false);
    expect(h({ handlerStarts: { method: 'get_map', n: 1 } })).toBe(true);
    const abortGoal = goalOf([{ host: { callsAfter: { fault: 'abort', n: 1 } } }, { host: { calls: 3 } }], { arms: ['replacement'], armsReason: 'x', class: 'abort', faults: { abort: { afterCalls: 2 } } });
    expect(pass(crit(judgeRunGoal(abortGoal, { replacement: obs('replacement', { hostLog: log, faultFiredAtSeq: { abort: 3 } }) }, IDS)))).toBe(true);
    expect(pass(crit(judgeRunGoal(abortGoal, { replacement: obs('replacement', { hostLog: log, faultFiredAtSeq: { abort: 2 } }) }, IDS)))).toBe(false);
  });

  it('text criteria: nothing received proves nothing, the canary needs its control, equalAcrossArms needs the value on both arms', () => {
    expect(pass(run([{ text: { neverContains: 'zzz' } }]))).toBe(true);
    expect(pass(run([{ text: { neverContains: 'zzz' } }], { received: '' }))).toBe(false);
    const canary = (o: Partial<ArmObservation>) => judgeRunGoal(goalOf([{ text: { neverContains: { $canary: true } } }, { answer: { path: 'title', present: true } }], { faults: { localCanary: 'CANARY' } }), { classic: obs('classic', o), replacement: obs('replacement', o) }, IDS);
    expect(pass(canary({}))).toBe(true);
    expect(pass(canary({ canaryReadable: false }))).toBe(false);
    expect(pass(canary({ received: 'has CANARY' }))).toBe(false);
    const across = (a: object, b: object) => judgeRunGoal(goalOf([{ equalAcrossArms: 'title' }]), { classic: obs('classic', { answer: a as never }), replacement: obs('replacement', { answer: b as never }) }, IDS);
    expect(pass(across({ title: 'x' }, { title: 'x' }))).toBe(true);
    expect(pass(across({ title: 'x' }, { title: 'y' }))).toBe(false);
    expect(pass(across({}, {}))).toBe(false);
  });

  it('the invariants apply whatever the goal says: a helper left behind, a skip, two call ids for one operation, the incompleteness floor, claimsComplete', () => {
    const g = goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'abort' });
    const bad = (o: Partial<ArmObservation>) => invariants(g, obs('replacement', o)).filter((x) => !x.pass).map((x) => x.where);
    expect(bad({})).toEqual([]);
    expect(bad({ leftoverHelper: true })).toEqual(['invariant:no-leftover-helper']);
    expect(bad({ skipped: 2 })).toEqual(['invariant:no-skip']);
    expect(bad({ hostLog: [{ seq: 1, op: 'call', callId: 'a', method: 'm', handlerStarted: true }, { seq: 2, op: 'call', callId: 'b', method: 'm', handlerStarted: true }] })).toEqual(['invariant:one-call-id-per-operation']);
    // a host that answers 404 never starts a handler: the one call id it saw is no operation, and only under that declared fault
    const refusedLog = { hostLog: [{ seq: 1, op: 'call' as const, callId: 'a', method: 'get_map', handlerStarted: false }], result: { ...obs('replacement').result!, operations: [] } };
    const fault404 = goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'abort', faults: { host: { call: '404' } } });
    expect(bad(refusedLog)).toEqual(['invariant:one-call-id-per-operation']);
    expect(invariants(fault404, obs('replacement', { ...refusedLog, faultFiredAtSeq: { host: 1 } })).filter((x) => !x.pass).map((x) => x.where)).toEqual([]);
    expect(invariants(fault404, obs('replacement', { ...refusedLog, faultFiredAtSeq: { host: 1 }, hostLog: [{ ...refusedLog.hostLog[0]!, handlerStarted: true }] })).filter((x) => !x.pass).map((x) => x.where)).toEqual(['invariant:one-call-id-per-operation']);
    // only a 404 is read as not dispatched: the same log under another host reply still breaks the invariant
    const fault401 = goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'abort', faults: { host: { call: '401' } } });
    expect(invariants(fault401, obs('replacement', { ...refusedLog, faultFiredAtSeq: { host: 1 } })).filter((x) => !x.pass).map((x) => x.where)).toEqual(['invariant:one-call-id-per-operation']);
    expect(bad({ result: { ...obs('replacement').result!, status: 'partial-or-unknown', incomplete: false } })).toEqual(['invariant:incomplete-floor']);
    const claims = goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'abort', claimsComplete: true });
    const incompleteRun = { ...obs('replacement').result!, incomplete: true, operations: [{ ordinal: 1, method: 'get_map', dispatched: true, outcome: 'unread', incomplete: true }] };
    expect(invariants(claims, obs('replacement', { result: incompleteRun })).filter((x) => !x.pass).map((x) => x.where)).toEqual(['invariant:claims-complete']);
    expect(invariants(g, obs('replacement', { result: incompleteRun })).every((x) => x.pass)).toBe(true);
  });

  it('an arm the goal asks for that did not run is a failure of its own, and an arm a criterion is restricted to is the only one judged', () => {
    const both = goalOf([{ answer: { path: 'title', present: true } }], { arms: ['classic', 'replacement'] });
    const only = judgeRunGoal(both, { classic: obs('classic') }, IDS);
    expect(only.filter((x) => !x.pass).map((x) => `${x.arm}:${x.where}`)).toEqual(['replacement:arm']);
    const restricted = goalOf([{ arm: 'classic', answer: { path: 'title', equals: 'T' } }], { arms: ['classic', 'replacement'] });
    expect(judgeRunGoal(restricted, { classic: obs('classic'), replacement: obs('replacement', { answer: { title: 'other' } }) }, IDS).filter((x) => x.where === 'criteria[0]').map((x) => x.arm)).toEqual(['classic']);
  });

  it('the record criterion reads the durable record state', () => {
    expect(pass(run([{ record: { state: 'free' } }]))).toBe(true);
    expect(pass(run([{ record: { state: 'held-live' } }]))).toBe(false);
  });
});

describe('the judge: conservation, launch and rollback', () => {
  const tool = (name: string, extra = '') => ({ name, description: `${name}${extra}` });
  const cons = (over: Partial<ConservationObservation> = {}): ConservationObservation => ({
    classicTools: [tool('a'), tool('b'), tool('c')], replacementTools: [tool('a'), tool('c'), tool('code_search')], migrated: ['b'], wrapperNames: ['code_search'],
    catalogueNames: ['a', 'b', 'c'], originalNames: ['a', 'b', 'c'], catalogueRuns: [{ names: ['a', 'b'], bytes: 'xy' }, { names: ['a', 'b'], bytes: 'xy' }],
    sources: { guide: { classic: 'G', replacement: 'G' } }, ...over,
  });
  const conservation = (criteria: object[], c: ConservationObservation | undefined) => judgeRunGoal(goalOf(criteria, { class: 'conservation-list', answer: {}, arms: ['classic', 'replacement'] }), { classic: obs('classic'), replacement: obs('replacement') }, IDS, c);
  it('toolList: an exact disjoint partition, residual descriptors byte for byte and in classic\'s order', () => {
    const all = [{ toolList: { partition: true } }, { toolList: { residualSchemasEqualClassic: true } }, { toolList: { residualOrderEqualClassic: true } }];
    const verdicts = conservation(all, cons()).filter((x) => x.where.startsWith('criteria'));
    expect(verdicts.every((x) => x.pass)).toBe(true);
    expect(verdicts).toHaveLength(3);
    expect(pass(conservation([all[0]!], cons({ migrated: [] })))).toBe(false);
    expect(pass(conservation([all[0]!], cons({ migrated: ['a'] })))).toBe(false);
    expect(pass(conservation([all[0]!], cons({ replacementTools: [tool('a'), tool('c')] })))).toBe(false);
    expect(pass(conservation([all[1]!], cons({ replacementTools: [tool('a', ' changed'), tool('c'), tool('code_search')] })))).toBe(false);
    expect(pass(conservation([all[2]!], cons({ replacementTools: [tool('c'), tool('a'), tool('code_search')] })))).toBe(false);
    expect(conservation(all, undefined).some((x) => !x.pass)).toBe(true);
  });
  it('catalogue and sources', () => {
    expect(pass(conservation([{ catalogue: { namesEqualOriginal: true, orderEqualBetweenRuns: true, bytesEqualBetweenRuns: true } }, { sources: { unchanged: ['guide'] } }], cons()))).toBe(true);
    expect(pass(conservation([{ catalogue: { namesEqualOriginal: true } }], cons({ catalogueNames: ['a', 'b'] })))).toBe(false);
    expect(pass(conservation([{ catalogue: { bytesEqualBetweenRuns: true } }], cons({ catalogueRuns: [{ names: ['a'], bytes: 'x' }, { names: ['a'], bytes: 'y' }] })))).toBe(false);
    expect(pass(conservation([{ catalogue: { orderEqualBetweenRuns: true } }], cons({ catalogueRuns: [{ names: ['a', 'b'], bytes: 'x' }, { names: ['b', 'a'], bytes: 'x' }] })))).toBe(false);
    expect(pass(conservation([{ sources: { unchanged: ['guide'] } }], cons({ sources: { guide: { classic: 'G', replacement: 'G2' } } })))).toBe(false);
    expect(pass(conservation([{ sources: { unchanged: ['roles'] } }], cons()))).toBe(false);
  });

  const view = (over: Partial<LaunchView> = {}): LaunchView => ({ layer: 'BOOT\nclassic layer', argvWithoutLayer: '["a"]', env: { A: '1' }, verdict: { role: { status: 'compatible' } }, selectsClassic: { classic: false, source: null }, tools: ['get_map'], brief: 'brief text', skillCatalogue: ['s'], threw: null, ...over });
  const launch = (criteria: object[], plan: LaunchView, classic = view({ layer: 'classic layer' }), migrated: readonly string[] = []) => {
    const r = checkGoalFile(file([launchGoal('l', 'routing-role', { criteria })]));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return judgeLaunchGoal(r.goals[0]!, { plan, classic, bootstrap: 'BOOT', migrated });
  };
  it('launch criteria over the plan, compared with the classic launch', () => {
    expect(pass(launch([{ layer: { startsWith: 'BOOT' } }, { layerEqualsClassicWithBootstrap: true }, { argv: { equalsClassicOutsideLayer: true } }, { env: { has: 'A' } }, { verdict: { source: 'role', status: 'compatible' } }, { selectsClassic: { value: false } }, { tools: { includes: ['get_map'], count: 1 } }, { skillCatalogue: { includes: ['s'] } }, { brief: { contains: 'brief' } }], view()))).toBe(true);
    expect(pass(launch([{ layerEqualsClassicWithBootstrap: true }], view({ layer: 'BOOT\nclassic layer\n\nRouting for this launch: create_session is not available here; say so instead of calling it.' })))).toBe(true);
    expect(pass(launch([{ layerEqualsClassicWithBootstrap: true }], view({ layer: 'classic layer' })))).toBe(false);
    expect(pass(launch([{ layerEqualsClassicWithBootstrap: true }], view({ layer: 'BOOT\nclassic layer plus' })))).toBe(false);
    expect(pass(launch([{ argv: { equalsClassicOutsideLayer: true } }], view({ argvWithoutLayer: '["b"]' })))).toBe(false);
    expect(pass(launch([{ verdict: { source: 'role', status: 'incompatible' } }], view()))).toBe(false);
    expect(pass(launch([{ selectsClassic: { value: true } }], view()))).toBe(false);
    expect(pass(launch([{ tools: { excludes: ['get_map'] } }], view()))).toBe(false);
    expect(pass(launch([{ env: { lacks: 'A' } }], view()))).toBe(false);
    expect(pass(launch([{ layer: { notContains: 'x' } }], view({ layer: '' })))).toBe(false);
    expect(pass(launch([{ throws: 'code-mode-bootstrap-unavailable' }], view({ threw: 'code-mode-bootstrap-unavailable' })))).toBe(true);
    expect(pass(launch([{ throws: 'code-mode-bootstrap-unavailable' }], view()))).toBe(false);
  });

  it('a routing note is stripped only in the shapes the product writes: a changed byte inside a note is a difference', () => {
    const missing = '\n\nRouting for this launch: create_session is not available here; say so instead of calling it.';
    const migrated = '\n\nRouting for this launch: get_map is called as parley.get_map(args) inside code_execute (read code_docs first).';
    const both = `${migrated} create_session, report are not available here; say so instead of calling them.`;
    const okLayer = (tail: string) => pass(launch([{ layerEqualsClassicWithBootstrap: true }], view({ layer: `BOOT\nclassic layer${tail}` })));
    expect(okLayer(missing)).toBe(true);
    expect(okLayer(migrated)).toBe(true);
    expect(okLayer(both)).toBe(true);
    expect(okLayer(missing.replace('create_session', 'create_sessions!'))).toBe(false);
    expect(okLayer(missing.replace('instead of calling it', 'instead of calling that'))).toBe(false);
    expect(okLayer(migrated.replace('(args)', '(arg)'))).toBe(false);
    expect(okLayer(`${missing} extra words`)).toBe(false);
    expect(okLayer('\n\nRouting for this launch: anything at all')).toBe(false);
    expect(okLayer(`${missing}${missing}${missing}`)).toBe(false); // three notes: the product writes at most two (a role and a playbook)
  });

  describe('armAccounting carries the per-message list', () => {
  it('each message keeps its id, what it answered and its bytes, in order; none given gives an empty list', () => {
    const base = { original: [], residual: [], wrappers: [], registryRevision: null, tokenizer: { name: 't', count: (x: string) => x.length }, clientCalls: [], hostLog: [], received: 'abcd' };
    expect(armAccounting(base).perMessage).toEqual([]);
    const a = armAccounting({ ...base, messages: [{ id: 0, kind: 'handshake', bytes: 3 }, { id: 2, kind: 'tools/call get_map', bytes: 1 }] });
    expect(a.perMessage).toEqual([{ id: 0, kind: 'handshake', bytes: 3 }, { id: 2, kind: 'tools/call get_map', bytes: 1 }]);
    expect(a.context.bytes).toBe(4);
  });
});

describe('the Codex examples rewrite: the one change besides the bootstrap that the classic layer may carry, written out as literals', () => {
    const HEADER = 'Parley tools in Codex code mode are called as tools.mcp__parley__<name>(args). Examples:';
    const REV = '  // apiRevision comes from code_docs; call it once before the first code_execute.';
    const MAP_CLASSIC = '  const map = await tools.mcp__parley__get_map({});';
    const MAP_REPLACED = "  const map = await tools.mcp__parley__code_execute({ code: 'return await parley.get_map({})', apiRevision });";
    const TAIL = 'Call report exactly once at the end.';
    const classicLayer = ['head', HEADER, MAP_CLASSIC, '  await tools.mcp__parley__report({ status: "done", summary: "What was done, what was found, what is left." });', TAIL].join('\n');
    const rewritten = ['head', HEADER, REV, MAP_REPLACED, '  await tools.mcp__parley__report({ status: "done", summary: "What was done, what was found, what is left." });', TAIL].join('\n');
    const eq = (layer: string, migrated: string[], classic = classicLayer) => pass(launch([{ layerEqualsClassicWithBootstrap: true }], view({ layer: `BOOT\n${layer}` }), view({ layer: classic }), migrated));
    it('a migrated get_map shows its row inside the script surface and the revision line follows the header; that exact layer passes', () => {
      expect(eq(rewritten, ['get_map'])).toBe(true);
      expect(eq(rewritten, ['get_map', 'read_room', 'read_guide'])).toBe(true); // names with no example row change nothing more
    });
    it('the classic layer is not accepted when the rewrite was due, nor the rewrite when none was', () => {
      expect(eq(classicLayer, ['get_map'])).toBe(false);
      expect(eq(rewritten, [])).toBe(false);
      expect(eq(rewritten, ['read_room'])).toBe(false);
      expect(eq(classicLayer, ['read_room'])).toBe(true);
    });
    it('any other byte of the layer stays a difference: a changed tail, a changed row, a missing or doubled revision line, a second changed row', () => {
      expect(eq(rewritten.replace(TAIL, `${TAIL}!`), ['get_map'])).toBe(false);
      expect(eq(rewritten.replace("get_map({})'", "get_map({ })'"), ['get_map'])).toBe(false);
      expect(eq(rewritten.replace(`${REV}\n`, ''), ['get_map'])).toBe(false);
      expect(eq(rewritten.replace(`${REV}\n`, `${REV}\n${REV}\n`), ['get_map'])).toBe(false);
      expect(eq(rewritten.replace('"done"', '"failed"'), ['get_map'])).toBe(false);
      expect(eq(rewritten.replace('head', 'heads'), ['get_map'])).toBe(false);
    });
    it('a layer with no examples block (Claude, GLM) is compared as it is, whatever is migrated', () => {
      expect(eq('plain layer', ['get_map'], 'plain layer')).toBe(true);
      expect(eq('plain layer!', ['get_map'], 'plain layer')).toBe(false);
      // a row line without the header is not an examples block: nothing is rewritten
      expect(classicLayerWithExamplesRewrite(`x\n${MAP_CLASSIC}\ny`, ['get_map'])).toBe(`x\n${MAP_CLASSIC}\ny`);
    });
    it('every row of the table rewrites its own line and no other', () => {
      const rows: [string, string][] = [
        ['send_message', '  await tools.mcp__parley__send_message({ to: "s-02", kind: "question", text: "Which branch do I build on?" });'],
        ['check_inbox', '  const inbox = await tools.mcp__parley__check_inbox({});                 // once per "New messages (N)" pointer'],
        ['wait_for', '  await tools.mcp__parley__wait_for({ target: "inbox", timeoutSec: 1500 }); // returns and marks messages read; on running repeat once'],
        ['report', '  await tools.mcp__parley__report({ status: "done", summary: "What was done, what was found, what is left." });'],
      ];
      for (const [name, line] of rows) {
        const layer = [HEADER, line, TAIL].join('\n');
        const out = classicLayerWithExamplesRewrite(layer, [name]).split('\n');
        expect(out[0]).toBe(HEADER);
        expect(out[1]).toBe(REV);
        expect(out[2]).toContain(`tools.mcp__parley__code_execute({ code: 'return await parley.${name}(`);
        expect(out[2]).not.toBe(line);
        expect(out[3]).toBe(TAIL);
        expect(classicLayerWithExamplesRewrite(layer, ['get_map'])).toBe(layer);
      }
    });
    it('a row that is not exactly once in the layer is not rewritten, so the comparison cannot pass on a layer that lost or doubled it', () => {
      expect(classicLayerWithExamplesRewrite([HEADER, TAIL].join('\n'), ['get_map'])).toBe([HEADER, TAIL].join('\n'));
      expect(classicLayerWithExamplesRewrite([HEADER, MAP_CLASSIC, MAP_CLASSIC].join('\n'), ['get_map'])).toBe([HEADER, MAP_CLASSIC, MAP_CLASSIC].join('\n'));
    });
  });

  const rb = (criteria: object[], o: Partial<Parameters<typeof judgeRollbackGoal>[1]> = {}) => {
    const r = checkGoalFile(file([rollbackGoal('r', { criteria })]));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const sel = { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' };
    return judgeRollbackGoal(r.goals[0]!, { selection: sel, repeats: [sel, sel, sel], before: { sha256: 'a', inode: 1, mtimeMs: 2 }, after: { sha256: 'a', inode: 1, mtimeMs: 2 }, nextLaunch: { tools: 49, bootstrap: 'x', wrappers: false }, busyReason: 'previous-process-unaccounted', hostCalls: 0, ...o });
  };
  it('rollback criteria: the whole selection, the record untouched, the next launch, busy, host-wide zero, nothing ages', () => {
    expect(pass(rb([{ selection: { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' } }, { recordUnchanged: true }, { nextLaunch: { tools: 49, wrappers: false, bootstrapContains: 'x' } }, { busy: { reason: 'previous-process-unaccounted' } }, { calls: 0 }, { repeatSelection: 3 }]))).toBe(true);
    expect(pass(rb([{ selection: { effective: 'replacement' } }]))).toBe(false);
    expect(pass(rb([{ selection: { effective: 'classic', reason: 'held-run' } }]))).toBe(false);
    expect(pass(rb([{ recordUnchanged: true }], { after: { sha256: 'b', inode: 1, mtimeMs: 2 } }))).toBe(false);
    expect(pass(rb([{ recordUnchanged: true }], { before: null }))).toBe(false);
    expect(pass(rb([{ nextLaunch: { tools: 52, wrappers: true } }]))).toBe(false);
    expect(pass(rb([{ calls: 0 }, { busy: { reason: 'previous-process-unaccounted' } }], { hostCalls: 1 }))).toBe(false);
    expect(pass(rb([{ repeatSelection: 3 }], { repeats: [{ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' }, { effective: 'replacement', reason: null }, { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' }] }))).toBe(false);
  });
});

// ---------- the schema additions after H1 (T9a-goal-schema.md, lead m-7083) ----------

describe('the goal-file check: holdReceipts, maxPending, concurrentRuns, noValue, nextRun', () => {
  const resource = (faults: Record<string, unknown>, criteria: object[], over: Record<string, unknown> = {}) =>
    runGoal('a', 'resource', { ...REPLACEMENT_ONLY, answer: { summaries: 'what was read' }, faults, criteria, ...over });
  const HELD = [{ answer: { path: 'summaries', countAtLeast: 1 } }, { host: { calls: 2, maxPending: 2 } }];

  it('a hold is observed: holdReceipts and host.maxPending go together, and untilPending is a positive integer', () => {
    accepted(resource({ resource: { bound: 'maxInFlight', input: 'at-limit' }, holdReceipts: { untilPending: 2 } }, HELD));
    refused(resource({ holdReceipts: { untilPending: 2 } }, [{ answer: { path: 'summaries', countAtLeast: 1 } }]), /needs a host.maxPending criterion/);
    refused(resource({}, HELD), /host.maxPending needs a holdReceipts fault/);
    refused(resource({ holdReceipts: { untilPending: 0 } }, HELD), /holdReceipts.untilPending/);
    refused(resource({ holdReceipts: { untilPending: 2, afterMs: 5 } }, HELD), /holdReceipts.afterMs: unknown field/);
    refused(resource({ holdReceipts: 2 }, HELD), /holdReceipts: an object/);
    refused(resource({ holdReceipts: { untilPending: 2 } }, [{ host: { calls: 2, maxPending: 0 } }]), /maxPending: a positive integer/);
  });

  const CONCURRENT = { resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } };
  const SECOND = { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } };
  it('a second run while the first is active: one input, a resource goal of one arm, and the second run\'s refusal stated', () => {
    accepted(resource(CONCURRENT, [{ answer: { path: 'summaries', countAtLeast: 1 } }, { run: { result: 'first', status: 'completed' } }, SECOND]));
    refused(resource({ resource: { bound: 'concurrentRuns', input: 'at-limit' } }, [SECOND]), /second-while-first-active/);
    refused(resource({ resource: { bound: 'maxRpcs', input: 'second-while-first-active' } }, [SECOND]), /at-limit, one-over or far-over/);
    refused(resource(CONCURRENT, [{ answer: { path: 'summaries', countAtLeast: 1 } }, { run: { status: 'completed' } }]), /needs a run criterion with result: second/);
    refused(runGoal('a', 'abort', { ...REPLACEMENT_ONLY, answer: { summaries: 'x' }, faults: CONCURRENT, criteria: [SECOND] }), /replacement-only goal of class resource/);
    refused(runGoal('a', 'resource', { answer: { summaries: 'x' }, faults: CONCURRENT, criteria: [SECOND] }), /replacement-only goal of class resource/);
  });

  it('the result selector exists only with that bound, and is first or second', () => {
    refused(resource({ resource: { bound: 'maxRpcs', input: 'one-over' } }, [{ run: { result: 'second', status: 'error' } }]), /allowed only with the concurrentRuns bound/);
    refused(resource(CONCURRENT, [SECOND, { run: { result: 'third' } }]), /first or second/);
  });

  it('noValue is true, nextRun is admitted or refused with a busy reason of the contract', () => {
    const far = (r: object) => resource({ resource: { bound: 'memoryBytes', input: 'far-over' } }, [{ run: r }, { host: { calls: 1 } }]);
    accepted(far({ attemptedExecute: true, status: 'error', incomplete: true, noValue: true, nextRun: { admitted: true } }));
    accepted(far({ noValue: true, nextRun: { admitted: false, busyReason: 'previous-run-has-calls-with-unknown-outcome' } }));
    refused(far({ noValue: false }), /noValue: true/);
    refused(far({ nextRun: { admitted: 'yes' } }), /nextRun.admitted: a boolean/);
    refused(far({ nextRun: { admitted: false } }), /nextRun.busyReason: one of/);
    refused(far({ nextRun: { admitted: false, busyReason: 'whatever' } }), /nextRun.busyReason: one of/);
    refused(far({ nextRun: { admitted: true, busyReason: 'a-run-is-active' } }), /nextRun.busyReason: unknown field/);
    refused(far({ nextRun: true }), /nextRun: an object/);
  });
});

describe('the judge: the post-H1 operators, and what a correct run of them looks like', () => {
  const second = (result: object | null, attempted = true) => ({ attempted, result: result as never });
  const BUSY = { status: 'error', error: { kind: 'busy' }, runId: null, incomplete: true, operations: [], diagnostics: [{ code: 'busy', params: { reason: 'a-run-is-active' } }], value: null };
  // the judge is pure: these goals are written straight, not through the check (the check refuses a lone maxPending or result selector)
  const rawGoal = (criteria: object[], faults: Record<string, unknown> = {}): Goal => ({ ...goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'resource' }), criteria: criteria as never, faults: faults as never });
  const run = (criteria: object[], o: Partial<ArmObservation> = {}) =>
    judgeRunGoal(rawGoal(criteria), { replacement: obs('replacement', o) }, IDS).filter((x) => x.where.startsWith('criteria'));

  it('noValue passes on a null value and only on that', () => {
    const withValue = (value: unknown) => ({ ...obs('replacement').result!, value });
    expect(pass(run([{ run: { noValue: true } }], { result: withValue(null) }))).toBe(true);
    expect(pass(run([{ run: { noValue: true } }], { result: withValue('x') }))).toBe(false);
    expect(pass(run([{ run: { noValue: true } }], { result: withValue(0) }))).toBe(false);
    expect(pass(run([{ run: { noValue: true } }], { result: withValue(undefined) }))).toBe(false);
  });

  it('nextRun compares admitted, and the busy reason only when refused', () => {
    const next = (want: object, got: ArmObservation['nextRun']) => pass(run([{ run: { nextRun: want } }], { nextRun: got }));
    expect(next({ admitted: true }, { admitted: true, busyReason: null })).toBe(true);
    expect(next({ admitted: false, busyReason: 'previous-run-draining' }, { admitted: false, busyReason: 'previous-run-draining' })).toBe(true);
    expect(next({ admitted: true }, { admitted: false, busyReason: 'previous-run-draining' })).toBe(false);
    expect(next({ admitted: false, busyReason: 'previous-run-draining' }, { admitted: false, busyReason: null })).toBe(false);
    expect(next({ admitted: true }, null)).toBe(false);
  });

  it('result: second reads the second request\'s result and its attempt; the first criteria still read the first', () => {
    const goal = [{ run: { result: 'first', status: 'completed' } }, { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } }];
    expect(pass(run(goal, { second: second(BUSY) }))).toBe(true);
    expect(pass(run(goal, { second: second(BUSY, false) }))).toBe(false);
    expect(pass(run(goal, { second: second({ ...BUSY, status: 'completed' }) }))).toBe(false);
    expect(pass(run(goal, { second: null }))).toBe(false);
    expect(pass(run(goal, { second: undefined }))).toBe(false);
  });

  it('host.maxPending is what the host held at once; nothing held fails', () => {
    expect(pass(run([{ host: { maxPending: 2 } }], { hostMaxPending: 2 }))).toBe(true);
    expect(pass(run([{ host: { maxPending: 2 } }], { hostMaxPending: 3 }))).toBe(false);
    expect(pass(run([{ host: { maxPending: 2 } }], { hostMaxPending: null }))).toBe(false);
    expect(pass(run([{ host: { maxPending: 2 } }], { hostMaxPending: undefined }))).toBe(false);
  });

  it('the declared holdReceipts and concurrentRuns faults must have fired, on the replacement arm', () => {
    const g = (faults: Record<string, unknown>) => rawGoal([{ answer: { path: 'title', present: true } }], faults);
    const bad = (goal: Goal, fired: ArmObservation['faultFiredAtSeq']) => invariants(goal, obs('replacement', { faultFiredAtSeq: fired })).filter((x) => !x.pass).map((x) => x.where);
    const faults = { holdReceipts: { untilPending: 2 }, resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } };
    expect(bad(g(faults), {}).sort()).toEqual(['invariant:fault-fired:concurrentRuns', 'invariant:fault-fired:holdReceipts']);
    expect(bad(g(faults), { holdReceipts: 2, concurrentRuns: 1 })).toEqual([]);
    expect(bad(g(faults), { holdReceipts: 2 })).toEqual(['invariant:fault-fired:concurrentRuns']);
    expect(bad(g({ resource: { bound: 'maxRpcs', input: 'one-over' } }), {})).toEqual([]);
  });
});

// ---------- the six points of the H1 review (s-296, m-7052) ----------

describe('run-wide invariants, second pass: a fault that never fired, an outcome nobody read back, a missing result, a call without an id', () => {
  const g = (faults: Record<string, unknown>, over: Record<string, unknown> = {}): Goal => goalOf([{ answer: { path: 'title', present: true } }], { arms: ['replacement'], armsReason: 'x', class: 'abort', faults, ...over });
  const bad = (goal: Goal, o: Partial<ArmObservation>): string[] => invariants(goal, obs('replacement', o)).filter((x) => !x.pass).map((x) => x.where);

  it('every declared abort, guest, host and mid-run policy fault must have fired; a policy fault with no afterCalls is there from the start and has nothing to fire', () => {
    const faults = { abort: { afterCalls: 1 }, guest: { event: 'kill-helper', afterCalls: 1 }, host: { call: '404' }, policy: { state: 'revoked', afterCalls: 1 } };
    expect(bad(g(faults), {}).sort()).toEqual(['invariant:fault-fired:abort', 'invariant:fault-fired:guest', 'invariant:fault-fired:host', 'invariant:fault-fired:policy']);
    const cancelled = { resultFromTap: true, answer: {} };
    expect(bad(g(faults), { ...cancelled, faultFiredAtSeq: { abort: 1, guest: 1, host: 1, policy: 1 } })).toEqual([]);
    expect(bad(g(faults), { ...cancelled, faultFiredAtSeq: { abort: 1, guest: 1, host: 1 } })).toEqual(['invariant:fault-fired:policy']);
    expect(bad(g({ policy: { state: 'unknown' } }), {})).toEqual([]);
    expect(bad(g({ localCanary: 'C' }), {})).toEqual([]);
  });

  it('a cancelled request is never answered: the result is the server\'s own, and the agent must hold no answer, no run id and no value', () => {
    const faults = { abort: { afterCalls: 1 } };
    const only = (o: Partial<ArmObservation>): string[] => bad(g(faults), { faultFiredAtSeq: { abort: 1 }, ...o });
    expect(only({ resultFromTap: true, answer: {}, received: 'nothing of the run' })).toEqual([]);
    expect(only({ resultFromTap: false, answer: {} })).toEqual(['invariant:abort-no-answer-delivered']);
    expect(only({ resultFromTap: undefined, answer: {} })).toEqual(['invariant:abort-no-answer-delivered']);
    expect(only({ resultFromTap: true, answer: { v: 1 } })).toEqual(['invariant:abort-no-answer-delivered']);
    expect(only({ resultFromTap: true, answer: {}, received: 'saw run-1-1 in the wire' })).toEqual(['invariant:abort-no-answer-delivered']);
    expect(only({ resultFromTap: true, answer: {}, result: null })).toEqual(['invariant:attempt-has-result', 'invariant:abort-no-answer-delivered']);
    // an abort that never fired is reported by its own invariant only
    expect(bad(g(faults), { resultFromTap: false, answer: {} })).toEqual(['invariant:fault-fired:abort']);
    // no abort declared: nothing asked
    expect(bad(g({}), {})).toEqual([]);
  });

  it('a host fault must have fired on every arm the goal runs; abort, guest and policy only on the replacement arm', () => {
    const two = (faults: Record<string, unknown>, cls: string): Goal => goalOf([{ answer: { path: 'title', present: true } }], { class: cls, faults });
    const both = two({ host: { call: '404' } }, 'host-404');
    const verdicts = (c: Partial<ArmObservation>, r: Partial<ArmObservation>) => judgeRunGoal(both, { classic: obs('classic', c), replacement: obs('replacement', r) }, IDS).filter((x) => x.where === 'invariant:fault-fired:host').map((x) => `${x.arm}:${x.pass}`);
    expect(verdicts({ faultFiredAtSeq: { host: 1 } }, { faultFiredAtSeq: { host: 1 } })).toEqual(['classic:true', 'replacement:true']);
    expect(verdicts({}, { faultFiredAtSeq: { host: 1 } })).toEqual(['classic:false', 'replacement:true']);
    expect(verdicts({ faultFiredAtSeq: { host: 1 } }, {})).toEqual(['classic:true', 'replacement:false']);
    const abortBoth = two({ abort: { afterCalls: 1 } }, 'paging');
    expect(judgeRunGoal(abortBoth, { classic: obs('classic'), replacement: obs('replacement', { faultFiredAtSeq: { abort: 1 } }) }, IDS).filter((x) => x.where.startsWith('invariant:fault-fired'))).toHaveLength(1);
  });
  it('an unknown or draining outcome means the record is held or unaccounted, never free or none; a clean run is not asked', () => {
    const run = (outcome: string) => ({ ...obs('replacement').result!, status: 'partial-or-unknown', incomplete: true, operations: [{ ordinal: 1, method: 'get_map', dispatched: true, outcome, incomplete: true }] });
    for (const outcome of ['unknown', 'draining']) {
      expect(bad(g({}), { result: run(outcome), record: 'free' })).toEqual(['invariant:unknown-keeps-record']);
      expect(bad(g({}), { result: run(outcome), record: 'none' })).toEqual(['invariant:unknown-keeps-record']);
      expect(bad(g({}), { result: run(outcome), record: 'unaccounted' })).toEqual([]);
      expect(bad(g({}), { result: run(outcome), record: 'held-live' })).toEqual([]);
    }
    expect(bad(g({}), { result: run('failed'), record: 'free' })).toEqual([]);
  });

  it('a replacement arm that sent the script request must have a result; one that never sent it need not', () => {
    expect(bad(g({}), { result: null })).toEqual(['invariant:attempt-has-result']);
    expect(bad(g({}), { result: null, attemptedExecute: false })).toEqual([]);
  });

  it('a host call with no call id fails, even when the counted ones add up to the dispatched operations', () => {
    const call: HostEntry = { seq: 1, op: 'call', callId: 'c-1', method: 'get_map', handlerStarted: true };
    expect(bad(g({}), { hostLog: [call, { ...call, seq: 2, callId: null }] }).sort()).toEqual(['invariant:every-call-has-an-id']);
    expect(bad(g({}), { hostLog: [call, { seq: 2, op: 'list', callId: null, method: null, handlerStarted: false }] })).toEqual([]);
  });
});

describe('[*] is not vacuous for present and equalAcrossArms', () => {
  const items = (arr: unknown[]) => ({ items: arr });
  const p = (answer: unknown, c: object) => pathCriterion(answer, c as never, IDS).pass;
  it('present needs a non-empty result and every element holding the key', () => {
    expect(p(items([{ id: 1 }, { id: 2 }]), { path: 'items[*].id', present: true })).toBe(true);
    expect(p(items([{ id: 1 }, {}]), { path: 'items[*].id', present: true })).toBe(false);
    expect(p(items([{}, {}]), { path: 'items[*].id', present: true })).toBe(false);
    expect(p(items([]), { path: 'items[*].id', present: true })).toBe(false);
    expect(p(items(['a']), { path: 'items[*]', present: true })).toBe(true);
    expect(p({ title: 'T' }, { path: 'title', present: true })).toBe(true);
  });
  it('count stays as it was: it counts the elements that hold the key', () => {
    expect(p(items([{ id: 1 }, {}]), { path: 'items[*].id', count: 1 })).toBe(true);
    expect(valueAt(items([{ id: 1 }, {}]), 'items[*].id')).toEqual([1]);
    expect(typeof valueAt(items([{ id: 1 }, {}]), 'items[*].id', true)).toBe('symbol');
    expect(valueAt(items([{ id: 1 }, { id: 2 }]), 'items[*].id', true)).toEqual([1, 2]);
  });
  it('equalAcrossArms over a wildcard needs a non-empty result on both arms', () => {
    const across = (a: unknown, b: unknown) => judgeRunGoal(goalOf([{ equalAcrossArms: 'items[*].id' }], { arms: ['classic', 'replacement'] }), { classic: obs('classic', { answer: a as never }), replacement: obs('replacement', { answer: b as never }) }, IDS).filter((x) => x.where === 'criteria[0]');
    expect(pass(across(items([{ id: 1 }]), items([{ id: 1 }])))).toBe(true);
    expect(pass(across(items([{}]), items([{}])))).toBe(false);
    expect(pass(across(items([]), items([])))).toBe(false);
    expect(pass(across(items([{ id: 1 }]), items([])))).toBe(false);
    // one arm holds the key in only some elements: read leniently both arms would match on [1], so each side must be strict on its own
    expect(pass(across(items([{ id: 1 }, {}]), items([{ id: 1 }])))).toBe(false);
    expect(pass(across(items([{ id: 1 }]), items([{ id: 1 }, {}])))).toBe(false);
  });
  it('a conservation source that differs says so, with the sizes and where, and one that is equal says same bytes', () => {
    const r = checkGoalFile(file([{ ...runGoal('s', 'conservation-source', { arms: ['classic', 'replacement'], answer: { title: 't' }, criteria: [{ toolList: { partition: true } }, { toolList: { residualSchemasEqualClassic: true } }, { toolList: { residualOrderEqualClassic: true } }, { catalogue: { namesEqualOriginal: true } }, { sources: { unchanged: ['guide'] } }, { catalogue: { orderEqualBetweenRuns: true, bytesEqualBetweenRuns: true } }] }) }]));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const cons = (guide: { classic: string; replacement: string }) => ({ classicTools: [], replacementTools: [], migrated: [], wrapperNames: [], catalogueNames: [], originalNames: [], catalogueRuns: [], sources: { guide } }) as never;
    const detail = (guide: { classic: string; replacement: string }) => judgeRunGoal(r.goals[0]!, { classic: obs('classic'), replacement: obs('replacement') }, IDS, cons(guide)).find((x) => x.where.endsWith('sources.unchanged.guide'))!;
    expect(detail({ classic: 'abc', replacement: 'abc' })).toMatchObject({ pass: true, detail: 'same bytes' });
    const bad = detail({ classic: 'abcdef', replacement: 'abXdef!' });
    expect(bad.pass).toBe(false);
    expect(bad.detail).toMatch(/the arms differ \(6 bytes against 7, first difference at 2:/);
  });
  it('skillCatalogue.excludes does not pass on an empty catalogue, as tools.excludes and the notContains criteria do not', () => {
    const r = checkGoalFile(file([launchGoal('l', 'routing-role', { criteria: [{ skillCatalogue: { excludes: ['x'] } }] })]));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const view = (skillCatalogue: string[]): LaunchView => ({ layer: 'L', argvWithoutLayer: '[]', env: {}, verdict: {}, selectsClassic: { classic: false, source: null }, tools: ['t'], brief: 'b', skillCatalogue, threw: null });
    expect(pass(judgeLaunchGoal(r.goals[0]!, { plan: view([]), classic: view([]), bootstrap: 'B', migrated: [] }))).toBe(false);
    expect(pass(judgeLaunchGoal(r.goals[0]!, { plan: view(['s']), classic: view([]), bootstrap: 'B', migrated: [] }))).toBe(true);
    expect(pass(judgeLaunchGoal(r.goals[0]!, { plan: view(['x']), classic: view([]), bootstrap: 'B', migrated: [] }))).toBe(false);
  });
});

// ---------- the self-check ----------

describe('the self-check: a judge that passes everything, or fails everything, is caught', () => {
  it('has a case for every operator and invariant, and a correct judge fails every one', () => {
    expect(selfCheckCases().length).toBeGreaterThanOrEqual(44);
    expect(runSelfChecks()).toEqual([]);
  });
  it('the control: a clean arm passes the criteria it satisfies', () => {
    expect(selfCheckControl().filter((x) => !x.pass)).toEqual([]);
    expect(selfCheckControl().length).toBeGreaterThan(8);
  });
  it('MUTANT judges: one that passes everything is caught by every case; one that fails everything is caught by the control', () => {
    expect(runSelfChecks(() => [])).toHaveLength(selfCheckCases().length);
    expect(selfCheckControl(() => [{ goal: 'x', arm: 'both', where: 'w', pass: false, detail: 'always' }]).some((x) => !x.pass)).toBe(true);
  });
  it('MUTANT judges: one that ignores a single operator is caught by that operator\'s case', () => {
    const blind = (word: string) => (goal: Goal, o: Partial<Record<'classic' | 'replacement', ArmObservation>>, ids: Ids) =>
      judgeRunGoal({ ...goal, criteria: goal.criteria.filter((c) => !JSON.stringify(c).includes(word)) }, o, ids);
    for (const word of ['"absent"', '"countAtLeast"', '"operationsInclude"', '"maxAttemptsPerCall"', '"callsAfter"', '"neverContains"', '"equalAcrossArms"', '"record"', '"limitReached"']) {
      expect(runSelfChecks(blind(word)).length, word).toBeGreaterThan(0);
    }
  });
});

// ---------- the refusals to run ----------

describe('the refusals to run', () => {
  const goalsText = (n: number, drop: string[] = []): string => {
    const base = fullGoals().filter((g) => !drop.includes(String(g['class'])));
    const extra = Array.from({ length: Math.max(0, n - base.length) }, (_, i) => runGoal(`extra-${i}`, 'error'));
    return JSON.stringify(file([...base, ...extra]));
  };
  const scriptsFor = (text: string, omit: string[] = [], onlyArm: string | null = null) => {
    const r = checkGoalFile(JSON.parse(text));
    if (!r.ok) throw new Error('fixture');
    return r.goals.filter((g) => g.kind === 'run' && !omit.includes(g.id)).map((g) => ({ goal: g.id, ...(g.arms.includes('classic') && onlyArm !== 'replacement' ? { classic: { calls: [] } } : {}), ...(g.arms.includes('replacement') && onlyArm !== 'classic' ? { replacement: { code: '' } } : {}) }));
  };
  it('runs when the sha is the frozen one, there are at least 20 goals, every class has one and every run goal has its script', () => {
    const text = goalsText(MIN_GOALS);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: scriptsFor(text) })).toEqual([]);
  });
  it('refuses another sha', () => {
    const text = goalsText(MIN_GOALS);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(`${text} `), scripts: scriptsFor(text) }).join()).toMatch(/is not the frozen/);
  });
  it('refuses a scripts file that is not the frozen one, or whose sha was not taken', () => {
    const text = goalsText(MIN_GOALS);
    expect(runRefusals({ goalsText: text, expectedSha: sha256(text), scripts: scriptsFor(text), scriptsSha: sha256('other'), expectedScriptsSha: SS }).join()).toMatch(/scripts file sha256 .* is not the frozen/);
    expect(runRefusals({ goalsText: text, expectedSha: sha256(text), scripts: scriptsFor(text), scriptsSha: null, expectedScriptsSha: SS }).join()).toMatch(/scripts file sha256 none is not the frozen/);
  });
  it('refuses fewer than 20 goals and a class with no goal', () => {
    const few = JSON.stringify(file(fullGoals().slice(0, 5)));
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: few, expectedSha: sha256(few), scripts: scriptsFor(few) }).join()).toMatch(/at least 20/);
    const short = goalsText(MIN_GOALS, ['paging']);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: short, expectedSha: sha256(short), scripts: scriptsFor(short) }).join()).toMatch(/class paging has no goal/);
  });
  it('refuses a goal with no criteria (the check names it) and a file that is not JSON', () => {
    const bad = JSON.stringify(file([{ ...runGoal('a', 'paging'), criteria: [] }]));
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: bad, expectedSha: sha256(bad), scripts: [] }).join()).toMatch(/criteria: a non-empty array/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: '{', expectedSha: sha256('{'), scripts: [] }).join()).toMatch(/not JSON/);
  });
  it('refuses a script for no goal, a run goal with no script, a missing arm, and a script on a launch goal', () => {
    const text = goalsText(MIN_GOALS);
    const ok = scriptsFor(text);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: [...ok, { goal: 'ghost' }] }).join()).toMatch(/script for ghost: no such goal/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: scriptsFor(text, ['g-paging']) }).join()).toMatch(/goal g-paging has no script/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: scriptsFor(text, [], 'classic') }).join()).toMatch(/has no replacement script/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: [...ok, { goal: 'g-routing-role', classic: {} }] }).join()).toMatch(/launch goal and takes no script/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: [...ok, ok[0]!] }).join()).toMatch(/twice/);
    expect(runRefusals({ scriptsSha: SS, expectedScriptsSha: SS, goalsText: text, expectedSha: sha256(text), scripts: null }).join()).toMatch(/scripts file is missing/);
  });
});

// ---------- accounting and the report ----------

describe('accounting and the report: the usage ledger is untouched, and there is no percent or savings field', () => {
  const tok = { name: 'chars', count: (t: string) => t.length };
  const t = (n: string) => ({ name: n });
  const acc = armAccounting({ original: [t('a'), t('b'), t('c')], residual: [t('c'), t('a')], wrappers: [t('code_search'), t('code_execute')], registryRevision: 'rev', tokenizer: tok, clientCalls: ['code_search', 'code_execute', 'report'], hostLog: [{ seq: 1, op: 'call', callId: 'x', method: 'm', handlerStarted: true }, { seq: 2, op: 'list', callId: null, method: null, handlerStarted: false }], received: 'héllo' });
  it('counts the list through the stand\'s exposureAccounting, every residual by name, the calls by kind and the context', () => {
    expect(acc.list).toMatchObject({ exposure: 'replacement', originalTools: 3, residualTools: 2, wrapperTools: 2, tokenizer: 'chars', registryRevision: 'rev' });
    expect(acc.residualNames).toEqual(['a', 'c']);
    expect(acc.calls).toEqual({ direct: 1, wrapper: 2, nested: 1 });
    expect(acc.context).toEqual({ bytes: 6, tokens: 5 });
  });
  const goalList = (() => { const r = checkGoalFile(file(fullGoals())); if (!r.ok) throw new Error('fixture'); return r.goals; })();
  /** One passing verdict per goal and per arm it runs (launch and rollback goals: one, on 'both'). */
  const coverage = (goals: readonly Goal[]): Verdict[] => goals.flatMap((g): Verdict[] => g.kind === 'run' ? g.arms.map((arm) => ({ goal: g.id, arm, where: 'criteria[0]', pass: true, detail: '' })) : [{ goal: g.id, arm: 'both', where: 'criteria[0]', pass: true, detail: '' }]);
  const base = { treeHash: 'abc', goalsSha: 'g', expectedGoalsSha: 'g', scriptsSha: 's', expectedScriptsSha: 's', node: 'v22.16.0', load: [1, 2, 3], label: 'fixture broker', goals: goalList, verdicts: coverage(goalList), accounting: { x: { replacement: acc } }, skipsByArm: { classic: 0, replacement: 0 } };
  const report = buildReport(base);
  it('says in its header that native provider usage and model behaviour are not produced, and is valid for one tree hash', () => {
    expect(report['header']).toBe(REPORT_HEADER);
    expect(String(report['header'])).toMatch(/Native provider usage and model behaviour are NOT produced/);
    expect(report['treeHash']).toBe('abc');
    expect(report['passed']).toBe(true);
    expect(report['goals']).toBe(goalList.length);
    expect(report['uncovered']).toEqual([]);
    expect(report['selfCheck']).toMatchObject({ wronglyPassed: [], controlFailed: [] });
  });
  it('a skip on either arm or one failed verdict makes the report not passed', () => {
    const v = base.verdicts[0]!;
    expect(buildReport({ ...base, skipsByArm: { classic: 0, replacement: 1 } })['passed']).toBe(false);
    expect(buildReport({ ...base, skipsByArm: { classic: 1, replacement: 0 } })['passed']).toBe(false);
    const bad = buildReport({ ...base, verdicts: [{ ...v, pass: false, detail: 'no' }, ...base.verdicts.slice(1)] });
    expect(bad['passed']).toBe(false);
    expect(bad['failedAt']).toEqual([`${v.goal} ${v.arm} ${v.where}: no`]);
  });
  it('a goal that yields no verdict, or none on one of its arms, or a verdict for a goal outside the frozen list, makes the report not passed', () => {
    const dropped = buildReport({ ...base, verdicts: base.verdicts.filter((x) => x.goal !== 'g-paging') });
    expect(dropped['passed']).toBe(false);
    expect(dropped['uncovered']).toEqual(['g-paging: no verdict']);
    const oneArm = buildReport({ ...base, verdicts: base.verdicts.filter((x) => !(x.goal === 'g-paging' && x.arm === 'replacement')) });
    expect(oneArm['passed']).toBe(false);
    expect(oneArm['uncovered']).toEqual(['g-paging: no verdict on the replacement arm']);
    const stray = buildReport({ ...base, verdicts: [...base.verdicts, { goal: 'ghost', arm: 'both', where: 'w', pass: true, detail: '' }] });
    expect(stray['passed']).toBe(false);
    expect(String(stray['uncovered'])).toMatch(/ghost: a verdict for a goal that is not in the frozen list/);
    expect(buildReport({ ...base, goals: [], verdicts: [] })['uncovered']).toEqual([]);
  });
  it('the goals file and the scripts file must be the frozen ones: another sha, or no scripts sha, is not passed', () => {
    expect(buildReport({ ...base, goalsSha: 'other' })['passed']).toBe(false);
    expect(buildReport({ ...base, scriptsSha: 'other' })['passed']).toBe(false);
    expect(buildReport({ ...base, scriptsSha: null })['passed']).toBe(false);
    expect(buildReport({ ...base, scriptsSha: null })['scriptsShaOk']).toBe(false);
  });
  it('the self-check decides the report: a judge that passes everything, or fails everything, is not passed', () => {
    const passAll = buildReport({ ...base, judge: () => [] });
    expect(passAll['passed']).toBe(false);
    expect((passAll['selfCheck'] as { wronglyPassed: string[] }).wronglyPassed.length).toBeGreaterThan(40);
    const failAll = buildReport({ ...base, judge: () => [{ goal: 'x', arm: 'both', where: 'w', pass: false, detail: 'always' }] });
    expect(failAll['passed']).toBe(false);
    expect((failAll['selfCheck'] as { controlFailed: string[] }).controlFailed).toEqual(['w: always']);
  });
  it('has no key anywhere that is a percent, a saving or an estimate, and no usage field', () => {
    const keys: string[] = [];
    const walk = (x: unknown): void => { if (typeof x === 'object' && x !== null) for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } };
    walk(report);
    expect(keys.filter((k) => /percent|saving|estimate|usage|reduction/i.test(k))).toEqual([]);
  });
  it('the ledger stands: parseRun still refuses an estimate field, and the replay modules import nothing of the ledger but the accounting function', () => {
    const run = { schema: 1, id: 'r', scenario: 's', origin: 'synthetic-fixture', repetition: 1, usage: [], tokenEstimate: 5, conditions: { arm: 'baseline', cache: 'cold', jev: 'off', skill: 'off', provider: 'p', model: 'm', effort: 'e', cli: 'c', hashes: {} } };
    expect('problems' in parseRun(run)).toBe(true);
    const sources = ['parley-token-benchmark-replay.ts', 'parley-token-benchmark-replay-schema.ts', 'parley-token-benchmark-replay-judge.ts'].map((f) => readFileSync(path.join(here, f), 'utf8'));
    const imports = sources.flatMap((s) => [...s.matchAll(/import[^;]*from '\.\/parley-token-benchmark\.js'/g)].map((m) => m[0]));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('exposureAccounting');
    for (const forbidden of ['sumUsage', 'pairSection', 'parseRun', 'RunRecord', 'Conditions']) for (const s of sources) expect(s, forbidden).not.toContain(forbidden);
  });
});

// ---------- the agent view (contract v4) ----------

describe('the judge\'s own projection of the parent result, and the agent-view-faithful invariant', () => {
  const OP = { ordinal: 1, method: 'get_map', argsSha256: 'a'.repeat(64), dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false };
  const FULL = { contract: 4, runId: 'run-1-1', status: 'completed', error: null, value: { n: 1 }, incomplete: false, diagnostics: [], diagnosticsTruncated: false, operations: [OP] };

  it('a clean completed read is the status, the completeness and the value; nothing else', () => {
    expect(agentViewOf(FULL)).toEqual({ status: 'completed', incomplete: false, value: { n: 1 } });
  });
  it('a row that is not a clean read, a diagnostic and a truncation are kept; the hashes and sizes are not', () => {
    const failed = { ...OP, ordinal: 2, outcome: 'failed', incomplete: true };
    const view = agentViewOf({ ...FULL, incomplete: true, operations: [OP, failed], diagnostics: [{ code: 'call-failed', params: { ordinal: 2, method: 'get_map' }, message: 'x' }], diagnosticsTruncated: true });
    expect(view).toEqual({ status: 'completed', incomplete: true, value: { n: 1 }, operations: [{ ordinal: 2, method: 'get_map', dispatched: true, outcome: 'failed', incomplete: true }], diagnostics: [{ code: 'call-failed', params: { ordinal: 2, method: 'get_map' }, message: 'x' }], diagnosticsTruncated: true });
  });
  it('a method outside the judge\'s own list of reads is a receipt: listed on a completed run', () => {
    expect(agentViewOf({ ...FULL, operations: [{ ...OP, method: 'send_message' }] })).toMatchObject({ operations: [{ method: 'send_message' }] });
  });
  it('an incomplete completed run with only clean reads lists every row (E-1)', () => {
    expect(agentViewOf({ ...FULL, incomplete: true })).toMatchObject({ incomplete: true, operations: [{ ordinal: 1, outcome: 'succeeded' }] });
  });
  it('a run that did not complete carries the error, the run id and every row, and no value', () => {
    expect(agentViewOf({ ...FULL, status: 'error', value: null, incomplete: true, error: { kind: 'runtime', message: 'm' } })).toEqual({ status: 'error', incomplete: true, error: { kind: 'runtime', message: 'm' }, runId: 'run-1-1', operations: [{ ordinal: 1, method: 'get_map', dispatched: true, outcome: 'succeeded', incomplete: false }] });
    expect(agentViewOf({ ...FULL, runId: null, status: 'error', value: null, incomplete: true, error: { kind: 'unavailable', message: 'm' }, operations: [] })).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: 'm' } });
  });
  it('abort: a cancelled request is not answered; the same observation with an answer to it fails', () => {
    const g = goalOf([{ host: { calls: 1 } }], { faults: { abort: { afterCalls: 1 } } });
    const base = { faultFiredAtSeq: { abort: 1 }, resultFromTap: true, answer: {} } as const;
    const verdict = (cancelledAnswered: boolean) => invariants(g, obs('replacement', { ...base, cancelledAnswered })).find((x) => x.where === 'invariant:abort-no-answer-delivered')!;
    expect(verdict(false).pass).toBe(true);
    expect(verdict(true).pass).toBe(false);
  });
  it('abort goals: the cancelled request is left out; a second or a next answer is compared, and with nothing else answered the invariant holds', () => {
    const g = goalOf([{ host: { calls: 1 } }], { faults: { abort: { afterCalls: 1 } } });
    const base = { faultFiredAtSeq: { abort: 1 }, resultFromTap: true, cancelledSeq: 1, cancelledAnswered: false, answer: {} } as const;
    const faithful = (executes: ArmObservation['executes']) => invariants(g, obs('replacement', { ...base, executes })).find((x) => x.where === 'invariant:agent-view-faithful')!;
    const text = JSON.stringify(agentViewOf(FULL));
    expect(faithful([]).pass).toBe(true);
    expect(faithful([{ seq: 2, text, isError: false, full: FULL }]).pass).toBe(true);
    expect(faithful([{ seq: 2, text: text.replace('"incomplete":false', '"incomplete":true'), isError: false, full: FULL }]).pass).toBe(false);
    expect(faithful([{ seq: 2, text, isError: false, full: null }]).pass).toBe(false);
    // the cancelled request itself has no answer to compare
    expect(faithful([{ seq: 1, text: 'not the projection', isError: false, full: FULL }]).pass).toBe(true);
  });
  it('the invariant passes on the exact projection, and fails on text that differs, on isError that is wrong, and with nothing to compare', () => {
    const g = goalOf([{ answer: { path: 'title', present: true } }]);
    const run = (executes: ArmObservation['executes']) => invariants(g, obs('replacement', { executes })).find((x) => x.where === 'invariant:agent-view-faithful')!;
    const text = JSON.stringify(agentViewOf(FULL));
    expect(run([{ seq: 1, text, isError: false, full: FULL }]).pass).toBe(true);
    expect(run([{ seq: 1, text: text.replace('"incomplete":false', '"incomplete":true'), isError: false, full: FULL }]).pass).toBe(false);
    expect(run([{ seq: 1, text, isError: true, full: FULL }]).pass).toBe(false);
    expect(run([{ seq: 1, text, isError: false, full: null }]).pass).toBe(false);
    expect(run([]).pass).toBe(false);
  });
});
