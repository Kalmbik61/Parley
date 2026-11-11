// T9a harness, slice H1: the entry of the pure core. Schema check and judge live in their own files; this one adds what the runner needs before and
// after a run: the refusals to run, the self-check that a judge which passes everything cannot hide in, and the accounting block of the report.
// Nothing here starts a process or reads a file.

import { createHash } from 'node:crypto';
import { exposureAccounting, type ExposureAccounting } from './parley-token-benchmark.js';
import { checkGoalFile, CLASSES, missingClasses, type Goal, type Obj } from './parley-token-benchmark-replay-schema.js';
import {
  judgeRunGoal,
  type ArmObservation, type ConservationObservation, type HostEntry, type Ids, type ExecuteLike, type ToolDescriptor, type Verdict,
} from './parley-token-benchmark-replay-judge.js';

export * from './parley-token-benchmark-replay-schema.js';
export * from './parley-token-benchmark-replay-judge.js';

export const MIN_GOALS = 20;
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---------- scripts file ----------

/** `read-workflow-scripts.json`: per run goal the classic call list and the replacement code, each with its extract (the shape is H2's; H1 checks coverage only). */
export interface ScriptEntry { readonly goal: string; readonly classic?: unknown; readonly replacement?: unknown }

/**
 * The refusals before the first goal runs (harness text §7): a wrong sha of the goals file, fewer than 20 goals, a class of the plan's list with no
 * goal, a scripts file that is not the frozen one, a goal with no criteria (the check refuses that), a script for no goal, a run goal with no script, a script that lacks an arm the goal runs.
 * Each is a named reason; an empty list means the run may start.
 */
export function runRefusals(input: { goalsText: string; expectedSha: string; scripts: readonly ScriptEntry[] | null; scriptsSha: string | null; expectedScriptsSha: string }): readonly string[] {
  const reasons: string[] = [];
  if (sha256(input.goalsText) !== input.expectedSha) reasons.push(`goals file sha256 ${sha256(input.goalsText)} is not the frozen ${input.expectedSha}`);
  if (input.scriptsSha === null || input.scriptsSha !== input.expectedScriptsSha) reasons.push(`scripts file sha256 ${input.scriptsSha ?? 'none'} is not the frozen ${input.expectedScriptsSha}`);
  let parsed: unknown;
  try { parsed = JSON.parse(input.goalsText); } catch { return [...reasons, 'goals file is not JSON']; }
  const checked = checkGoalFile(parsed);
  if (!checked.ok) return [...reasons, ...checked.issues.map((i) => `${i.path}: ${i.message}`)];
  const goals = checked.goals;
  if (goals.length < MIN_GOALS) reasons.push(`${goals.length} goals, at least ${MIN_GOALS} are required`);
  for (const c of missingClasses(goals)) reasons.push(`class ${c} has no goal`);
  if (input.scripts === null) { reasons.push('the scripts file is missing'); return reasons; }
  const ids = new Set(goals.map((g) => g.id));
  const seen = new Set<string>();
  for (const s of input.scripts) {
    if (!ids.has(s.goal)) reasons.push(`script for ${s.goal}: no such goal`);
    if (seen.has(s.goal)) reasons.push(`script for ${s.goal}: twice`);
    seen.add(s.goal);
  }
  for (const g of goals) {
    if (g.kind !== 'run') {
      if (seen.has(g.id)) reasons.push(`goal ${g.id} is a ${g.kind} goal and takes no script`);
      continue;
    }
    const s = input.scripts.find((x) => x.goal === g.id);
    if (s === undefined) reasons.push(`goal ${g.id} has no script`);
    else for (const arm of g.arms) if (s[arm] === undefined) reasons.push(`goal ${g.id} has no ${arm} script`);
  }
  return reasons;
}

// ---------- self-check ----------

interface SelfCase { readonly name: string; readonly goal: Goal; readonly obs: Partial<Record<'classic' | 'replacement', ArmObservation>>; readonly ids?: Ids }

const NO_IDS: Ids = { sessions: { peer: 's-02' }, rooms: { room: 'r-01' } };
const CLEAN_RESULT: ExecuteLike = { status: 'completed', error: null, runId: 'run-1-1', incomplete: false, operations: [{ ordinal: 1, method: 'get_map', dispatched: true, outcome: 'succeeded', incomplete: false }], diagnostics: [], value: null };
/** The parent's own result of a clean read, and the agent text that is exactly its projection (a clean read has no row and a completed run no run id). */
const FULL_CLEAN: Obj = { contract: 4, apiRevision: `cm1.${'0'.repeat(64)}`, runId: 'run-1-1', status: 'completed', error: null, value: null, incomplete: false, diagnostics: [], diagnosticsTruncated: false, operations: [{ ordinal: 1, method: 'get_map', argsSha256: 'a'.repeat(64), dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false }] };
const WIRE_CLEAN = '{"status":"completed","incomplete":false,"value":null}';
const BUSY_SECOND: ExecuteLike = { status: 'error', error: { kind: 'busy' }, runId: null, incomplete: true, operations: [], diagnostics: [{ code: 'busy', params: { reason: 'a-run-is-active' } }], value: null };
const CALL: HostEntry = { seq: 1, op: 'call', callId: 'c-1', method: 'get_map', handlerStarted: true };
function baseObs(arm: 'classic' | 'replacement', over: Partial<ArmObservation> = {}): ArmObservation {
  return {
    arm, answer: { items: ['a', 'b'], title: 'T', nothing: null }, result: arm === 'replacement' ? CLEAN_RESULT : null, attemptedExecute: arm === 'replacement',
    hostLog: [CALL], faultFiredAtSeq: {}, hostMaxPending: 1, second: null, nextRun: { admitted: true, busyReason: null }, received: 'something', record: 'free', leftoverHelper: false, canaryReadable: true, skipped: 0,
    executes: arm === 'replacement' ? [{ seq: 1, text: WIRE_CLEAN, isError: false, full: FULL_CLEAN }] : [], ...over,
  };
}
function selfGoal(criteria: readonly Obj[], over: Partial<Goal> = {}): Goal {
  return {
    id: 'self-check', class: 'error', kind: 'run', goal: 'self-check', arms: ['replacement'], armsReason: null, claimsComplete: false,
    answer: { items: 'x', title: 'x', nothing: 'x' }, data: null, faults: { localCanary: 'CANARY' }, launch: null, rollback: null, criteria, ...over,
  };
}

/**
 * One case per operator of the run grammar and per run-wide invariant, each built to be WRONG for the judge: a judge that passes any of them is
 * broken. `runSelfChecks` returns the names it wrongly passed; an empty list is the only acceptable result.
 */
export function selfCheckCases(): readonly SelfCase[] {
  const A = (c: object) => selfGoal([{ answer: c }]);
  const R = (r: object) => selfGoal([{ run: r }]);
  const H = (h: object) => selfGoal([{ host: h }]);
  const rep = (over: Partial<ArmObservation> = {}) => ({ replacement: baseObs('replacement', over) });
  return [
    { name: 'answer.equals a different value', goal: A({ path: 'title', equals: 'Other' }), obs: rep() },
    { name: 'answer.equals null on a present non-null', goal: A({ path: 'title', equals: null }), obs: rep() },
    { name: 'answer.equals null on a missing key', goal: A({ path: 'gone', equals: null }), obs: rep() },
    { name: 'answer.absent on a present null', goal: A({ path: 'nothing', absent: true }), obs: rep() },
    { name: 'answer.present on a missing key', goal: A({ path: 'gone', present: true }), obs: rep() },
    { name: 'answer.contains a missing substring', goal: A({ path: 'title', contains: 'zzz' }), obs: rep() },
    { name: 'answer.contains over [*] with no element holding it', goal: A({ path: 'items[*]', contains: 'zzz' }), obs: rep() },
    { name: 'answer.count wrong', goal: A({ path: 'items', count: 3 }), obs: rep() },
    { name: 'answer.countAtLeast too high', goal: A({ path: 'items', countAtLeast: 3 }), obs: rep() },
    { name: 'answer.count on a string', goal: A({ path: 'title', count: 1 }), obs: rep() },
    { name: 'answer.oneOf none', goal: A({ path: 'title', oneOf: ['x', 'y'] }), obs: rep() },
    { name: 'answer.equals a $session that resolves elsewhere', goal: A({ path: 'title', equals: { $session: 'peer' } }), obs: rep() },
    { name: 'run.status wrong', goal: R({ status: 'error' }), obs: rep() },
    { name: 'run.incomplete wrong', goal: R({ incomplete: true }), obs: rep() },
    { name: 'run.errorKind wrong', goal: R({ errorKind: 'busy' }), obs: rep() },
    { name: 'run.busyReason wrong', goal: R({ busyReason: 'previous-run-draining' }), obs: rep() },
    { name: 'run.runId null on a started run', goal: R({ runId: null }), obs: rep() },
    { name: 'run.operations wrong outcome', goal: R({ operations: [{ method: 'get_map', outcome: 'failed', dispatched: true }] }), obs: rep() },
    { name: 'run.operations extra row missing', goal: R({ operations: [] }), obs: rep() },
    { name: 'run.operationsInclude not a subsequence', goal: R({ operationsInclude: [{ method: 'read_room', outcome: 'succeeded', dispatched: true }] }), obs: rep() },
    { name: 'run.attemptedExecute without an attempt', goal: R({ attemptedExecute: true }), obs: rep({ attemptedExecute: false }) },
    { name: 'run.diagnostic absent', goal: R({ diagnostic: 'call-failed' }), obs: rep() },
    { name: 'run.limitReached absent', goal: R({ limitReached: 'result-bytes' }), obs: rep() },
    { name: 'host.calls wrong', goal: H({ calls: 0 }), obs: rep() },
    { name: 'host.distinctCalls wrong', goal: H({ distinctCalls: 2 }), obs: rep() },
    { name: 'host.attemptsOf wrong', goal: H({ attemptsOf: { method: 'get_map', n: 2 } }), obs: rep() },
    { name: 'host.lists wrong', goal: H({ lists: 3 }), obs: rep() },
    { name: 'host.maxAttemptsPerCall exceeded', goal: H({ maxAttemptsPerCall: 1 }), obs: rep({ hostLog: [CALL, { ...CALL, seq: 2 }] }) },
    { name: 'host.handlerStarts more than the calls', goal: H({ handlerStarts: { n: 1 } }), obs: rep({ hostLog: [CALL, { ...CALL, seq: 2 }] }) },
    { name: 'host.callsAfter a fault that never fired', goal: H({ callsAfter: { fault: 'abort', n: 0 } }), obs: rep() },
    { name: 'host.callsAfter dispatch after the fault', goal: H({ callsAfter: { fault: 'abort', n: 0 } }), obs: rep({ faultFiredAtSeq: { abort: 0 } }) },
    { name: 'text.neverContains something that was received', goal: selfGoal([{ text: { neverContains: 'something' } }]), obs: rep() },
    { name: 'text.neverContains with nothing received', goal: selfGoal([{ text: { neverContains: 'zzz' } }]), obs: rep({ received: '' }) },
    { name: 'text.$canary that reached the client', goal: selfGoal([{ text: { neverContains: { $canary: true } } }]), obs: rep({ received: 'a CANARY b' }) },
    { name: 'text.$canary the control cannot read back', goal: selfGoal([{ text: { neverContains: { $canary: true } } }]), obs: rep({ canaryReadable: false }) },
    { name: 'equalAcrossArms that differ', goal: selfGoal([{ equalAcrossArms: 'title' }], { arms: ['classic', 'replacement'] }), obs: { classic: baseObs('classic', { answer: { title: 'A' } }), replacement: baseObs('replacement', { answer: { title: 'B' } }) } },
    { name: 'equalAcrossArms on a missing path on both arms', goal: selfGoal([{ equalAcrossArms: 'gone' }], { arms: ['classic', 'replacement'] }), obs: { classic: baseObs('classic'), replacement: baseObs('replacement') } },
    { name: 'record state wrong', goal: selfGoal([{ record: { state: 'held-live' } }]), obs: rep() },
    { name: 'an arm the goal asks for did not run', goal: A({ path: 'title', present: true }), obs: {} },
    { name: 'invariant: a leftover helper', goal: A({ path: 'title', present: true }), obs: rep({ leftoverHelper: true }) },
    { name: 'invariant: a skip on the arm', goal: A({ path: 'title', present: true }), obs: rep({ skipped: 1 }) },
    { name: 'invariant: two call ids for one dispatched operation', goal: A({ path: 'title', present: true }), obs: rep({ hostLog: [CALL, { ...CALL, seq: 2, callId: 'c-2' }] }) },
    { name: 'invariant: the incompleteness floor (a non-clean run that says incomplete: false)', goal: A({ path: 'title', present: true }), obs: rep({ result: { ...CLEAN_RESULT, status: 'partial-or-unknown', incomplete: false } }) },
    { name: 'invariant: a declared abort fault that never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { abort: { afterCalls: 1 } } }), obs: rep() },
    { name: 'invariant: a declared guest fault that never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { guest: { event: 'kill-helper', afterCalls: 1 } } }), obs: rep() },
    { name: 'invariant: a declared host fault that never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { host: { call: '404' } } }), obs: rep() },
    { name: 'invariant: a declared host fault that never fired on the classic arm', goal: selfGoal([{ answer: { path: 'title', present: true } }], { arms: ['classic', 'replacement'], faults: { host: { call: '404' } } }), obs: { classic: baseObs('classic'), replacement: baseObs('replacement', { faultFiredAtSeq: { host: 1 } }) } },
    { name: 'invariant: a declared mid-run policy fault that never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { policy: { state: 'revoked', afterCalls: 1 } } }), obs: rep() },
    { name: 'invariant: an unknown outcome with a free record', goal: A({ path: 'title', present: true }), obs: rep({ record: 'free', result: { ...CLEAN_RESULT, status: 'partial-or-unknown', incomplete: true, operations: [{ ...CLEAN_RESULT.operations[0]!, outcome: 'unknown', incomplete: true }] } }) },
    { name: 'invariant: a draining outcome with no record', goal: A({ path: 'title', present: true }), obs: rep({ record: 'none', result: { ...CLEAN_RESULT, status: 'partial-or-unknown', incomplete: true, operations: [{ ...CLEAN_RESULT.operations[0]!, outcome: 'draining', incomplete: true }] } }) },
    { name: 'invariant: a script request sent and no result', goal: A({ path: 'title', present: true }), obs: rep({ result: null }) },
    { name: 'invariant: a host call with no call id beside a counted one', goal: A({ path: 'title', present: true }), obs: rep({ hostLog: [CALL, { ...CALL, seq: 2, callId: null }] }) },
    { name: 'answer.present over [*] where no element holds the key', goal: A({ path: 'items[*].id', present: true }), obs: rep() },
    { name: 'answer.present over [*] where only some elements hold the key', goal: A({ path: 'items[*].id', present: true }), obs: rep({ answer: { items: [{ id: 1 }, {}] } }) },
    { name: 'answer.present over [*] on an empty array', goal: A({ path: 'items[*].id', present: true }), obs: rep({ answer: { items: [] } }) },
    { name: 'equalAcrossArms over [*] with nothing on both arms', goal: selfGoal([{ equalAcrossArms: 'items[*].id' }], { arms: ['classic', 'replacement'] }), obs: { classic: baseObs('classic'), replacement: baseObs('replacement') } },
    { name: 'run.noValue on a run that delivered a value', goal: R({ noValue: true }), obs: rep({ result: { ...CLEAN_RESULT, value: 'a final value' } }) },
    { name: 'run.noValue with no value captured at all', goal: R({ noValue: true }), obs: rep({ result: { ...CLEAN_RESULT, value: undefined } }) },
    { name: 'run.nextRun admitted, but the next run was refused', goal: R({ nextRun: { admitted: true } }), obs: rep({ nextRun: { admitted: false, busyReason: 'previous-run-draining' } }) },
    { name: 'run.nextRun refused for another reason', goal: R({ nextRun: { admitted: false, busyReason: 'a-run-is-active' } }), obs: rep({ nextRun: { admitted: false, busyReason: 'previous-run-draining' } }) },
    { name: 'run.nextRun refused, but the next run was admitted', goal: R({ nextRun: { admitted: false, busyReason: 'a-run-is-active' } }), obs: rep({ nextRun: { admitted: true, busyReason: null } }) },
    { name: 'run.nextRun never observed', goal: R({ nextRun: { admitted: true } }), obs: rep({ nextRun: null }) },
    { name: 'run.result second with no second request observed', goal: R({ result: 'second', status: 'error' }), obs: rep() },
    { name: 'run.result second reads the second result, not the first', goal: R({ result: 'second', status: 'completed' }), obs: rep({ second: { attempted: true, result: BUSY_SECOND } }) },
    { name: 'run.result second attemptedExecute when the second request was never sent', goal: R({ result: 'second', attemptedExecute: true }), obs: rep({ second: { attempted: false, result: null } }) },
    { name: 'host.maxPending wrong', goal: H({ maxPending: 2 }), obs: rep() },
    { name: 'host.maxPending when nothing was held', goal: H({ maxPending: 1 }), obs: rep({ hostMaxPending: null }) },
    { name: 'invariant: a declared holdReceipts fault that never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { holdReceipts: { untilPending: 2 } } }), obs: rep() },
    { name: 'invariant: a declared concurrentRuns bound whose second run never fired', goal: selfGoal([{ answer: { path: 'title', present: true } }], { faults: { resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } } }), obs: rep() },
    { name: 'invariant: the agent text says incomplete:false against a parent result that says true', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: WIRE_CLEAN, isError: false, full: { ...FULL_CLEAN, incomplete: true } }] }) },
    { name: 'invariant: the agent text lacks a limit-reached the parent has', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: WIRE_CLEAN, isError: false, full: { ...FULL_CLEAN, diagnostics: [{ code: 'limit-reached', params: { limit: 'result-bytes' }, message: 'limit reached: result-bytes' }] } }] }) },
    { name: 'invariant: the agent text says completed against a parent error', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: WIRE_CLEAN, isError: false, full: { ...FULL_CLEAN, status: 'error', value: null, error: { kind: 'runtime', message: 'The script threw an error.' }, incomplete: true } }] }) },
    { name: 'invariant: the agent text lacks the row of a failed call', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: WIRE_CLEAN, isError: false, full: { ...FULL_CLEAN, incomplete: true, operations: [{ ...(FULL_CLEAN['operations'] as Obj[])[0]!, outcome: 'failed' }] } }] }) },
    { name: 'invariant: isError is false for a run that did not complete', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: '{"status":"error","incomplete":true,"error":{"kind":"runtime","message":"The script threw an error."},"runId":"run-1-1"}', isError: false, full: { ...FULL_CLEAN, status: 'error', value: null, error: { kind: 'runtime', message: 'The script threw an error.' }, incomplete: true, operations: [] } }] }) },
    { name: 'invariant: the parent result is missing, so there is nothing to compare', goal: A({ path: 'title', present: true }), obs: rep({ executes: [{ seq: 1, text: WIRE_CLEAN, isError: false, full: null }] }) },
    { name: 'invariant: a cancelled request that the server answered', goal: selfGoal([{ host: { calls: 1 } }], { faults: { abort: { afterCalls: 1 } } }), obs: rep({ faultFiredAtSeq: { abort: 1 }, resultFromTap: true, cancelledAnswered: true, answer: {} }) },
    { name: 'invariant: in an abort goal the second answer is not the projection of its parent result', goal: selfGoal([{ host: { calls: 1 } }], { faults: { abort: { afterCalls: 1 } } }), obs: rep({ faultFiredAtSeq: { abort: 1 }, resultFromTap: true, cancelledSeq: 1, cancelledAnswered: false, answer: {}, executes: [{ seq: 2, text: WIRE_CLEAN, isError: false, full: { ...FULL_CLEAN, incomplete: true } }] }) },
    { name: 'invariant: claimsComplete on an incomplete run', goal: selfGoal([{ answer: { path: 'title', present: true } }], { claimsComplete: true }), obs: rep({ result: { ...CLEAN_RESULT, incomplete: true, operations: [{ ...CLEAN_RESULT.operations[0]!, incomplete: true }] } }) },
  ];
}

/** The cases a judge wrongly passed: a case passes only when EVERY verdict for it passed. Must be empty. */
export function runSelfChecks(judge: typeof judgeRunGoal = judgeRunGoal): readonly string[] {
  return selfCheckCases().filter((c) => !judge(c.goal, c.obs, c.ids ?? NO_IDS).some((x) => !x.pass)).map((c) => c.name);
}

/** The control for the self-check: a clean arm and criteria it satisfies must pass, so a judge that fails everything is caught too. */
export function selfCheckControl(judge: typeof judgeRunGoal = judgeRunGoal): readonly Verdict[] {
  const goal = selfGoal([
    { answer: { path: 'title', equals: 'T' } }, { answer: { path: 'nothing', equals: null } }, { answer: { path: 'gone', absent: true } }, { answer: { path: 'items', count: 2 } },
    { answer: { path: 'items[*]', contains: 'a' } }, { run: { status: 'completed', incomplete: false, operations: [{ method: 'get_map', outcome: 'succeeded', dispatched: true }] } },
    { host: { calls: 1, distinctCalls: 1, attemptsOf: { method: 'get_map', n: 1 }, lists: 0, maxPending: 1 } }, { text: { neverContains: 'zzz' } }, { record: { state: 'free' } },
    { run: { noValue: true, nextRun: { admitted: true } } },
    { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } },
  ]);
  return judge(goal, { replacement: baseObs('replacement', { second: { attempted: true, result: BUSY_SECOND } }) }, NO_IDS);
}

// ---------- accounting ----------

export interface Tokenizer { readonly name: string; readonly count: (text: string) => number }
export interface ArmAccounting {
  readonly list: ExposureAccounting;
  /** Every retained residual tool, by name, sorted. */
  readonly residualNames: readonly string[];
  readonly calls: { readonly direct: number; readonly wrapper: number; readonly nested: number };
  readonly context: { readonly bytes: number; readonly tokens: number };
  /** Every message the client received, in order: what it answered and its bytes. The sum of `bytes` is `context.bytes`. */
  readonly perMessage: readonly { readonly id: number | string | null; readonly kind: string; readonly bytes: number }[];
}

/**
 * Per goal and arm: what the list costs (the stand's `exposureAccounting`, in the report only), every residual counted by name, the calls by kind and
 * what the client received. A number about a replay row: it never enters the usage ledger and never decides a goal.
 */
export function armAccounting(input: {
  original: readonly ToolDescriptor[]; residual: readonly ToolDescriptor[]; wrappers: readonly ToolDescriptor[]; registryRevision: string | null;
  tokenizer: Tokenizer; clientCalls: readonly string[]; hostLog: readonly HostEntry[]; received: string;
  /** What each message the client received answered, with its bytes; carried into the report as the per-call result bytes. */
  messages?: readonly { readonly id: number | string | null; readonly kind: string; readonly bytes: number }[];
}): ArmAccounting {
  const wrapperNames = new Set(input.wrappers.map((t) => t.name));
  return {
    list: exposureAccounting({ original: input.original, residual: input.residual, wrappers: input.wrappers, registryRevision: input.registryRevision, tokenizer: input.tokenizer }),
    residualNames: input.residual.map((t) => t.name).sort(),
    calls: {
      direct: input.clientCalls.filter((n) => !wrapperNames.has(n)).length,
      wrapper: input.clientCalls.filter((n) => wrapperNames.has(n)).length,
      nested: input.hostLog.filter((e) => e.op === 'call').length,
    },
    context: { bytes: Buffer.byteLength(input.received, 'utf8'), tokens: input.tokenizer.count(input.received) },
    perMessage: (input.messages ?? []).map((m) => ({ id: m.id, kind: m.kind, bytes: m.bytes })),
  };
}

// ---------- the report ----------

export interface ReportInput {
  readonly treeHash: string;
  readonly goalsSha: string;
  readonly scriptsSha: string | null;
  readonly node: string;
  readonly load: readonly number[];
  readonly label: string;
  /** The frozen goal list: every goal must be judged on every arm it runs, and the verdicts may name no other goal. */
  readonly goals: readonly Goal[];
  readonly expectedGoalsSha: string;
  readonly expectedScriptsSha: string;
  readonly verdicts: readonly Verdict[];
  /** The judge the self-check runs against; the real one unless a test substitutes a broken one. */
  readonly judge?: typeof judgeRunGoal;
  readonly accounting: Readonly<Record<string, Readonly<Partial<Record<'classic' | 'replacement', ArmAccounting>>>>>;
  readonly skipsByArm: Readonly<Record<'classic' | 'replacement', number>>;
}

export const REPORT_HEADER =
  'T9a replay. Synthetic goals, real processes, a fixture broker and a fixture host policy. Native provider usage and model behaviour are NOT produced here: no live model, no paid call. ' +
  'Valid for the tree hash below only; after a product repair the whole replay reruns. A goal either passes or fails: numbers never decide it.';

/** The report as plain data. It has no percent and no savings field, by construction, and a test pins that. */
export function buildReport(input: ReportInput): Record<string, unknown> {
  const failed = failures2(input.verdicts);
  const judge = input.judge ?? judgeRunGoal;
  // a goal that yields no verdict, or none on one of its arms, is a failure of the run: nothing is silently dropped
  const ids = new Set(input.goals.map((g) => g.id));
  const uncovered: string[] = [];
  for (const g of input.goals) {
    const mine = input.verdicts.filter((x) => x.goal === g.id);
    if (mine.length === 0) { uncovered.push(`${g.id}: no verdict`); continue; }
    if (g.kind === 'run') for (const arm of g.arms) if (!mine.some((x) => x.arm === arm)) uncovered.push(`${g.id}: no verdict on the ${arm} arm`);
  }
  for (const x of input.verdicts) if (!ids.has(x.goal)) uncovered.push(`${x.goal}: a verdict for a goal that is not in the frozen list`);
  const wronglyPassed = runSelfChecks(judge);
  const controlFailed = selfCheckControl(judge).filter((x) => !x.pass).map((x) => `${x.where}: ${x.detail}`);
  const goalsShaOk = input.goalsSha === input.expectedGoalsSha;
  const scriptsShaOk = input.scriptsSha !== null && input.scriptsSha === input.expectedScriptsSha;
  return {
    header: REPORT_HEADER,
    treeHash: input.treeHash,
    goalsSha: input.goalsSha,
    scriptsSha: input.scriptsSha,
    goalsShaOk,
    scriptsShaOk,
    node: input.node,
    load: input.load,
    label: input.label,
    classes: CLASSES.length,
    goals: input.goals.length,
    verdicts: input.verdicts.length,
    failed: failed.length,
    failedAt: failed.map((x) => `${x.goal} ${x.arm} ${x.where}: ${x.detail}`),
    uncovered,
    selfCheck: { cases: selfCheckCases().length, wronglyPassed, controlFailed },
    skips: input.skipsByArm,
    passed: failed.length === 0 && uncovered.length === 0 && wronglyPassed.length === 0 && controlFailed.length === 0 && goalsShaOk && scriptsShaOk && input.skipsByArm.replacement === 0 && input.skipsByArm.classic === 0,
    accounting: input.accounting,
  };
}
function failures2(v: readonly Verdict[]): Verdict[] { return v.filter((x) => !x.pass); }

export { judgeLaunchGoal, judgeRollbackGoal, pathCriterion } from './parley-token-benchmark-replay-judge.js';
export type { ArmObservation, ConservationObservation, HostEntry, Ids };
