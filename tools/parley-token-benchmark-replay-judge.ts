// T9a harness, slice H1: the judge. Pure: it takes a goal that passed the check and what an arm (or a launch, or a rollback) produced, and returns
// one verdict per criterion plus the run-wide invariants the goal cannot omit. It never runs anything and numbers never decide a goal.

import type { Goal, Json, Obj } from './parley-token-benchmark-replay-schema.js';
import { parsePath } from './parley-token-benchmark-replay-schema.js';

export type Arm = 'classic' | 'replacement';
export type FaultKey = 'abort' | 'policy' | 'guest' | 'host' | 'holdReceipts' | 'concurrentRuns';
export type RecordState = 'none' | 'held-live' | 'unaccounted' | 'free';

/** One request as the host fixture finished reading it. `list` requests have no call id and are in no count of calls. */
export interface HostEntry { readonly seq: number; readonly op: 'call' | 'list'; readonly callId: string | null; readonly method: string | null; readonly handlerStarted: boolean }
export interface OperationRow { readonly ordinal: number; readonly method: string | null; readonly dispatched: boolean; readonly outcome: string; readonly incomplete: boolean }
export interface ExecuteLike {
  readonly status: string;
  readonly error: { readonly kind: string } | null;
  readonly runId: string | null;
  readonly incomplete: boolean;
  readonly operations: readonly OperationRow[];
  readonly diagnostics: readonly { readonly code: string; readonly params?: Readonly<Record<string, Json>> }[];
  /** The guest's final value; `null` unless the run completed. Absent from an observation that did not capture it: `noValue` then fails, it never passes on nothing. */
  readonly value?: unknown;
}
/** One answered script request: the text the agent was sent, whether it was an error to the client, and the parent's own ExecuteResult (null where the server had none). */
export interface ExecuteWire { readonly seq: number; readonly text: string; readonly isError: boolean; readonly full: Obj | null }
export interface ToolDescriptor { readonly name: string; readonly [key: string]: unknown }

/** What one arm of a `run` goal produced. */
export interface ArmObservation {
  readonly arm: Arm;
  /** The arm's final result, in the names the goal's `answer` declares. */
  readonly answer: Json;
  readonly result: ExecuteLike | null;
  /** The client log shows the script request was really sent. */
  readonly attemptedExecute: boolean;
  readonly hostLog: readonly HostEntry[];
  /** `seq` of the first host request after which the fault fired; absent when it never fired. */
  readonly faultFiredAtSeq: Readonly<Partial<Record<FaultKey, number>>>;
  /** The most calls the host held unanswered at one moment (`faults.holdReceipts`), counted by its own log; null when nothing was held. */
  readonly hostMaxPending?: number | null | undefined;
  /** The second script request of a `concurrentRuns` goal: sent, and what came back. */
  readonly second?: { readonly attempted: boolean; readonly result: ExecuteLike | null } | null | undefined;
  /** A further script request in the same process after the run ended: admitted, or refused with the record's busy reason. */
  readonly nextRun?: { readonly admitted: boolean; readonly busyReason: string | null } | null | undefined;
  /**
   * `result` is what the server computed after the client cancelled its request, read from the preload's tap. The MCP SDK never sends an answer to a
   * cancelled request (SDK 1.30.0, shared/protocol.js: the handler's result is dropped when its signal is aborted), so the agent was told nothing.
   */
  readonly resultFromTap?: boolean | undefined;
  /** Every script request that was answered, what the agent was sent beside the parent's own result (the agent-view check reads it); absent from an observation that kept none. */
  readonly executes?: readonly ExecuteWire[] | undefined;
  /** The client cancelled a script request and the server answered it anyway (a response to its JSON-RPC id reached the client). */
  readonly cancelledAnswered?: boolean | undefined;
  /** The order (`seq`) of the script request the client cancelled; the agent-view check leaves out that one and compares every other answer. */
  readonly cancelledSeq?: number | null | undefined;
  /** Every byte the client received in this arm. */
  readonly received: string;
  readonly record: RecordState;
  readonly leftoverHelper: boolean;
  /** The control of `$canary`: the canary read back from the local store. */
  readonly canaryReadable: boolean | null;
  readonly skipped: number;
}

/** What the conservation criteria compare: the same launch on both arms. */
export interface ConservationObservation {
  readonly classicTools: readonly ToolDescriptor[];
  readonly replacementTools: readonly ToolDescriptor[];
  readonly migrated: readonly string[];
  readonly wrapperNames: readonly string[];
  readonly catalogueNames: readonly string[];
  readonly originalNames: readonly string[];
  readonly catalogueRuns: readonly { readonly names: readonly string[]; readonly bytes: string }[];
  readonly sources: Readonly<Record<string, { readonly classic: string; readonly replacement: string }>>;
}

export interface Verdict { readonly goal: string; readonly arm: Arm | 'both'; readonly where: string; readonly pass: boolean; readonly detail: string }

export type Ids = { readonly sessions: Readonly<Record<string, string>>; readonly rooms: Readonly<Record<string, string>> };

// ---------- values ----------

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/** `{ "$session": key }` and `{ "$room": key }` replaced by the ids the store assigned. */
export function resolveRefs(v: unknown, ids: Ids): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, ids));
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o['$session'] === 'string' && Object.keys(o).length === 1) return ids.sessions[o['$session']] ?? { unresolved: o['$session'] };
    if (typeof o['$room'] === 'string' && Object.keys(o).length === 1) return ids.rooms[o['$room']] ?? { unresolved: o['$room'] };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x, ids)]));
  }
  return v;
}

const MISSING = Symbol('missing');
/**
 * The value at a path; `[*]` maps over an array and yields the array of what is found under each element. `MISSING` when a key is absent.
 * `strict`: a wildcard over an empty array, or over elements some of which lack the rest of the path, is `MISSING` too, so a `present` or an equality
 * cannot be satisfied by nothing.
 */
export function valueAt(root: unknown, path: string, strict = false): unknown {
  const segs = parsePath(path);
  if (segs === null) return MISSING;
  const walk = (v: unknown, at: number): unknown => {
    if (at === segs.length) return v;
    const seg = segs[at]!;
    if (seg === '*') {
      if (!Array.isArray(v)) return MISSING;
      const mapped = v.map((x) => walk(x, at + 1));
      if (strict && (mapped.length === 0 || mapped.some((x) => x === MISSING))) return MISSING;
      return mapped.filter((x) => x !== MISSING);
    }
    if (typeof seg === 'number') return Array.isArray(v) && seg < v.length ? walk(v[seg], at + 1) : MISSING;
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg) ? walk((v as Record<string, unknown>)[seg], at + 1) : MISSING;
  };
  return walk(root, 0);
}

/** One path criterion on one answer; a type mismatch is a failed criterion, not an error. */
export function pathCriterion(answer: unknown, c: Obj, ids: Ids): { pass: boolean; detail: string } {
  const path = String(c['path']);
  const wildcard = path.includes('[*]');
  const found = valueAt(answer, path);
  const present = found !== MISSING;
  if ('absent' in c) return present ? { pass: false, detail: `${path} is present` } : { pass: true, detail: 'missing' };
  if (!present) return { pass: false, detail: `${path} is missing` };
  if ('present' in c) return valueAt(answer, path, true) !== MISSING ? { pass: true, detail: 'present' } : { pass: false, detail: `${path}: a wildcard needs at least one element and every element holding the key` };
  if ('equals' in c) {
    const want = resolveRefs(c['equals'], ids);
    return deepEqual(found, want) ? { pass: true, detail: 'equal' } : { pass: false, detail: `${path}: ${JSON.stringify(found)} is not ${JSON.stringify(want)}` };
  }
  if ('oneOf' in c) {
    const options = (c['oneOf'] as unknown[]).map((o) => resolveRefs(o, ids));
    return options.some((o) => deepEqual(found, o)) ? { pass: true, detail: 'one of' } : { pass: false, detail: `${path}: ${JSON.stringify(found)} is none of the options` };
  }
  if ('contains' in c) {
    const needle = resolveRefs(c['contains'], ids);
    if (typeof found === 'string') return typeof needle === 'string' && found.includes(needle) ? { pass: true, detail: 'contained' } : { pass: false, detail: `${path} does not contain ${JSON.stringify(needle)}` };
    if (Array.isArray(found)) {
      // under [*] each mapped element is judged on its own: a string element that holds the needle counts, anything else must be deep-equal
      const hit = found.some((e) => deepEqual(e, needle) || (wildcard && typeof e === 'string' && typeof needle === 'string' && e.includes(needle)));
      return hit ? { pass: true, detail: 'contained' } : { pass: false, detail: `${path} has no element holding ${JSON.stringify(needle)}` };
    }
    return { pass: false, detail: `${path} is neither a string nor an array` };
  }
  if ('count' in c || 'countAtLeast' in c) {
    if (!Array.isArray(found)) return { pass: false, detail: `${path} is not an array` };
    if ('count' in c) return found.length === c['count'] ? { pass: true, detail: 'count' } : { pass: false, detail: `${path} has ${found.length}, wanted ${String(c['count'])}` };
    return found.length >= (c['countAtLeast'] as number) ? { pass: true, detail: 'count' } : { pass: false, detail: `${path} has ${found.length}, wanted at least ${String(c['countAtLeast'])}` };
  }
  return { pass: false, detail: 'no operator' };
}

// ---------- the run judge ----------

const v = (goal: string, arm: Arm | 'both', where: string, r: { pass: boolean; detail: string }): Verdict => ({ goal, arm, where, pass: r.pass, detail: r.detail });
const ok = (pass: boolean, detail: string): { pass: boolean; detail: string } => ({ pass, detail });

function opShape(o: OperationRow, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) out[k] = (o as unknown as Obj)[k];
  return out;
}
function opMatches(want: Obj, o: OperationRow): boolean {
  return deepEqual(opShape(o, Object.keys(want)), want);
}

function runCriterion(r: Obj, obs: ArmObservation): { pass: boolean; detail: string }[] {
  // `result: second` reads the second script request of a concurrentRuns goal; everything else reads the first
  const second = r['result'] === 'second';
  const res = second ? (obs.second?.result ?? null) : obs.result;
  const attempted = second ? obs.second?.attempted === true : obs.attemptedExecute;
  const out: { pass: boolean; detail: string }[] = [];
  const need = (what: string, got: unknown, want: unknown): void => { out.push(ok(deepEqual(got, want), `${what}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)); };
  for (const [key, want] of Object.entries(r)) {
    if (key === 'result') continue;
    if (key === 'attemptedExecute') { need('attemptedExecute', attempted, true); continue; }
    if (key === 'nextRun') {
      const got = obs.nextRun ?? null;
      const w = want as { admitted: boolean; busyReason?: string };
      out.push(ok(got !== null && got.admitted === w.admitted && (w.admitted || got.busyReason === (w.busyReason ?? null)), `nextRun ${JSON.stringify(got)} vs ${JSON.stringify(want)}`));
      continue;
    }
    if (res === null) { out.push(ok(false, `${key}: the replacement arm returned no ${second ? 'second ' : ''}ExecuteResult`)); continue; }
    if (key === 'noValue') { out.push(ok(res.value === null, res.value === undefined ? 'no value was captured, so noValue proves nothing' : res.value === null ? 'no final value' : 'the run delivered a final value')); continue; }
    if (key === 'status') need('status', res.status, want);
    else if (key === 'incomplete') need('incomplete', res.incomplete, want);
    else if (key === 'errorKind') need('errorKind', res.error?.kind ?? null, want);
    else if (key === 'runId') need('runId', res.runId, null);
    else if (key === 'busyReason') need('busyReason', res.diagnostics.find((d) => d.code === 'busy')?.params?.['reason'] ?? null, want);
    else if (key === 'diagnostic') out.push(ok(res.diagnostics.some((d) => d.code === want), `diagnostic ${String(want)}`));
    else if (key === 'limitReached') out.push(ok(res.diagnostics.some((d) => d.code === 'limit-reached' && d.params?.['limit'] === want), `limit-reached ${String(want)}`));
    else if (key === 'operations') {
      const rows = [...res.operations].sort((a, b) => a.ordinal - b.ordinal);
      const wantList = want as Obj[];
      out.push(ok(rows.length === wantList.length && wantList.every((w, i) => opMatches(w, rows[i]!)), `operations ${JSON.stringify(rows.map((o) => opShape(o, ['method', 'outcome', 'dispatched'])))} vs ${JSON.stringify(wantList)}`));
    } else if (key === 'operationsInclude') {
      const rows = [...res.operations].sort((a, b) => a.ordinal - b.ordinal);
      let cursor = 0;
      const all = (want as Obj[]).every((w) => { while (cursor < rows.length && !opMatches(w, rows[cursor]!)) cursor++; if (cursor >= rows.length) return false; cursor++; return true; });
      out.push(ok(all, `operationsInclude ${JSON.stringify(want)} is not an ordered subsequence of ${JSON.stringify(rows.map((o) => opShape(o, ['method', 'outcome', 'dispatched'])))}`));
    }
  }
  return out;
}

function hostCriterion(h: Obj, obs: ArmObservation): { pass: boolean; detail: string }[] {
  const calls = obs.hostLog.filter((e) => e.op === 'call');
  const out: { pass: boolean; detail: string }[] = [];
  const need = (what: string, got: unknown, want: unknown): void => { out.push(ok(deepEqual(got, want), `host ${what}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)); };
  const perId = new Map<string, number>();
  for (const e of calls) if (e.callId !== null) perId.set(e.callId, (perId.get(e.callId) ?? 0) + 1);
  for (const [key, want] of Object.entries(h)) {
    if (key === 'calls') need('calls', calls.length, want);
    else if (key === 'distinctCalls') need('distinctCalls', perId.size, want);
    else if (key === 'lists') need('lists', obs.hostLog.filter((e) => e.op === 'list').length, want);
    else if (key === 'maxAttemptsPerCall') out.push(ok(Math.max(0, ...perId.values()) <= (want as number), `host maxAttemptsPerCall ${Math.max(0, ...perId.values())} vs ${String(want)}`));
    else if (key === 'maxPending') need('maxPending', obs.hostMaxPending ?? null, want);
    else if (key === 'attemptsOf') need(`attemptsOf ${String((want as Obj)['method'])}`, calls.filter((e) => e.method === (want as Obj)['method']).length, (want as Obj)['n']);
    else if (key === 'handlerStarts') {
      const method = (want as Obj)['method'];
      need('handlerStarts', calls.filter((e) => e.handlerStarted && (method === undefined || e.method === method)).length, (want as Obj)['n']);
    } else if (key === 'callsAfter') {
      const fault = (want as Obj)['fault'] as 'abort' | 'policy' | 'guest';
      const at = obs.faultFiredAtSeq[fault];
      if (at === undefined) out.push(ok(false, `host callsAfter: the ${fault} fault never fired, so the goal did not reach it`));
      else need(`callsAfter ${fault}`, calls.filter((e) => e.seq > at).length, (want as Obj)['n']);
    }
  }
  return out;
}

// ---------- the agent view (contract v4) ----------

/**
 * The read methods of the initial cohort, written here by hand and not imported from the product: the judge's own list is what makes the agent-view
 * check independent of the code it checks (the same rule as CODEX_ROWS). A clean read is the one operation a completed agent view leaves out.
 */
const READ_METHODS: readonly string[] = ['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room'];

const asList = (x: unknown): Obj[] => (Array.isArray(x) ? (x as Obj[]) : []);

/**
 * What the agent must have been sent for the parent's own result, written out from the contract's rule (spec §4, the agent view): the status and the
 * completeness always; the value only when completed, else the error and the run id; the rows of every operation except a clean read on a completed run
 * (every row when a completed run is incomplete and nothing else says why); the diagnostics, whenever there are any, and their truncation. Nothing else.
 */
export function agentViewOf(full: Obj): Obj {
  const completed = full['status'] === 'completed';
  const ops = asList(full['operations']);
  const diagnostics = asList(full['diagnostics']);
  const clean = (o: Obj): boolean => READ_METHODS.includes(String(o['method'])) && o['outcome'] === 'succeeded' && o['incomplete'] === false;
  let shown = completed ? ops.filter((o) => !clean(o)) : ops;
  if (completed && full['incomplete'] === true && diagnostics.length === 0 && !shown.some((o) => o['outcome'] !== 'succeeded' || o['incomplete'] === true)) shown = ops;
  const view: Obj = { status: full['status'] as Json, incomplete: full['incomplete'] as Json };
  if (completed) view['value'] = full['value'] as Json;
  else {
    view['error'] = full['error'] as Json;
    if (full['runId'] !== null && full['runId'] !== undefined) view['runId'] = full['runId'] as Json;
  }
  if (shown.length > 0) view['operations'] = shown.map((o) => ({ ordinal: o['ordinal'], method: o['method'], dispatched: o['dispatched'], outcome: o['outcome'], incomplete: o['incomplete'] })) as Json;
  if (diagnostics.length > 0) view['diagnostics'] = diagnostics as Json;
  if (full['diagnosticsTruncated'] === true) view['diagnosticsTruncated'] = true;
  return view;
}

/** The first way an answered script request differs from the judge's own projection of the parent's result, or null. */
function agentViewDifference(e: ExecuteWire): string | null {
  if (e.full === null) return null;
  let wire: unknown;
  try { wire = JSON.parse(e.text); } catch { return `request ${e.seq}: the agent text is not JSON`; }
  const want = agentViewOf(e.full);
  if (!deepEqual(wire, want)) return `request ${e.seq}: the agent text ${e.text.slice(0, 200)} is not the projection ${JSON.stringify(want).slice(0, 200)}`;
  if (e.isError !== (e.full['status'] !== 'completed')) return `request ${e.seq}: isError is ${String(e.isError)} for a ${String(e.full['status'])} run`;
  return null;
}

/**
 * The run-wide invariants: they apply to every goal whatever it says, so an omission in a goal cannot open a hole (harness text R3). One call id
 * per dispatched operation, no leftover helper, the contract's incompleteness floor, `claimsComplete`, no skip on the replacement arm.
 */
export function invariants(goal: Goal, obs: ArmObservation): Verdict[] {
  const out: Verdict[] = [];
  const add = (where: string, pass: boolean, detail: string): void => { out.push(v(goal.id, obs.arm, `invariant:${where}`, ok(pass, detail))); };
  add('no-leftover-helper', !obs.leftoverHelper, obs.leftoverHelper ? 'a helper process outlived the arm' : 'none left');
  add('no-skip', obs.skipped === 0, `${obs.skipped} skipped`);
  if (obs.arm === 'replacement') {
    // a request the client sent must have produced a result, or the server died and every answer criterion would be reading nothing
    if (obs.attemptedExecute) add('attempt-has-result', obs.result !== null, obs.result === null ? 'the script request was sent and no result came back' : 'a result came back');
    // a host call without an id would be dropped from the call-id count below
    add('every-call-has-an-id', obs.hostLog.every((e) => e.op !== 'call' || e.callId !== null), 'every host call carries a call id');
    // the agent view (v4): what the agent was sent is the judge's own projection of what the parent computed, so every fact the criteria read from the parent
    // reached the agent or is one of the named dropped fields. With no parent result to compare, the invariant fails rather than pass on nothing.
    // Per request: only the one the client cancelled is left out (it was never answered); a second or a next run in an abort goal is compared like any other.
    if (obs.attemptedExecute) {
      const answered = (obs.executes ?? []).filter((e) => e.seq !== obs.cancelledSeq);
      const missing = answered.filter((e) => e.full === null);
      const differences = answered.map(agentViewDifference).filter((d): d is string => d !== null);
      const nothing = answered.length === 0 && (obs.cancelledSeq === undefined || obs.cancelledSeq === null);
      const pass = !nothing && missing.length === 0 && differences.length === 0;
      add('agent-view-faithful', pass, nothing ? 'no answered script request to compare with' : missing.length > 0 ? `request ${missing[0]!.seq} has no parent result to compare with` : differences.length > 0 ? differences[0]! : `${answered.length} answered script request(s) match the projection of the parent's result`);
    }
  }
  // a declared fault that never fired proves nothing about how the run met it (harness text R3). The fixture host serves both arms and classic has its
  // own route on a host fault (the 404 fallback), so a host fault must have fired on every arm the goal runs; abort, guest and mid-run policy act on
  // the replacement arm only.
  const f = goal.faults as Obj;
  const isRec = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
  const declared: FaultKey[] = [];
  if (isRec(f['host'])) declared.push('host');
  if (obs.arm === 'replacement') {
    if (isRec(f['holdReceipts'])) declared.push('holdReceipts');
    if (isRec(f['resource']) && f['resource']['bound'] === 'concurrentRuns') declared.push('concurrentRuns');
    for (const k of ['abort', 'guest'] as const) if (isRec(f[k])) declared.push(k);
    if (isRec(f['policy']) && 'afterCalls' in f['policy']) declared.push('policy');
    // a cancelled request is never answered: the result the criteria read is the server's own, and the agent must have received none of it
    if (isRec(f['abort']) && obs.faultFiredAtSeq.abort !== undefined) {
      const runId = obs.result?.runId ?? null;
      const answered = obs.result === null || obs.resultFromTap !== true || (runId !== null && obs.received.includes(runId)) || !(isRec(obs.answer) && Object.keys(obs.answer).length === 0);
      const delivered = answered || obs.cancelledAnswered === true;
      add('abort-no-answer-delivered', !delivered, delivered ? 'the agent got an answer to a cancelled request, or the result did not come from the server tap' : 'the request was cancelled, the agent received no answer, and the result is the server\'s own');
    }
  }
  for (const k of declared) add(`fault-fired:${k}`, obs.faultFiredAtSeq[k] !== undefined, obs.faultFiredAtSeq[k] === undefined ? `the declared ${k} fault never fired` : `the ${k} fault fired at ${obs.faultFiredAtSeq[k]}`);
  if (obs.arm === 'replacement' && obs.result !== null) {
    const dispatched = obs.result.operations.filter((o) => o.dispatched).length;
    // a call the fixture answered 404 never reached the handler, and the product reads a first-attempt 404 as not dispatched (1e662ba8): under a declared host `call: '404'` only the calls whose handler started are operations
    const refused404 = isRec(f['host']) && f['host']['call'] === '404';
    const ids = new Set(obs.hostLog.filter((e) => e.op === 'call' && e.callId !== null && (!refused404 || e.handlerStarted)).map((e) => e.callId));
    add('one-call-id-per-operation', ids.size === dispatched, `${ids.size} call ids for ${dispatched} dispatched operations`);
    const floor = obs.result.status !== 'completed' || obs.result.operations.some((o) => o.incomplete);
    add('incomplete-floor', !floor || obs.result.incomplete, floor ? `the run is not clean, so incomplete must be true (it is ${String(obs.result.incomplete)})` : 'no floor');
    // U2: an outcome nobody could read back, or one still draining, means the durable record cannot say the run is over
    if (obs.result.operations.some((o) => o.outcome === 'unknown' || o.outcome === 'draining')) add('unknown-keeps-record', obs.record !== 'free' && obs.record !== 'none', `an operation is unknown or draining and the record is ${obs.record}`);
    if (goal.claimsComplete) add('claims-complete', !obs.result.incomplete, `the goal claims a complete answer and the run ended incomplete: ${String(obs.result.incomplete)}`);
  }
  return out;
}

/** Where two texts first differ, with a little context from each. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `${i}: ${JSON.stringify(a.slice(Math.max(0, i - 30), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 30), i + 60))}`;
}

function conservation(c: Obj, cons: ConservationObservation | undefined, goalId: string): Verdict[] {
  if (cons === undefined) return [v(goalId, 'both', 'conservation', ok(false, 'no conservation observation was produced'))];
  const out: Verdict[] = [];
  const add = (where: string, r: { pass: boolean; detail: string }): void => { out.push(v(goalId, 'both', where, r)); };
  const names = (list: readonly ToolDescriptor[]): string[] => list.map((t) => t.name);
  if ('toolList' in c) {
    const g = c['toolList'] as Obj;
    const residual = names(cons.replacementTools).filter((n) => !cons.wrapperNames.includes(n));
    if (g['partition']) {
      const original = [...cons.originalNames].sort();
      const union = [...cons.migrated, ...residual].sort();
      const disjoint = cons.migrated.every((m) => !residual.includes(m));
      const wrappers = names(cons.replacementTools).filter((n) => cons.wrapperNames.includes(n));
      add('toolList.partition', ok(disjoint && deepEqual(original, union) && deepEqual([...wrappers].sort(), [...cons.wrapperNames].sort()), `original ${original.length}, migrated ${cons.migrated.length}, residual ${residual.length}, wrappers ${wrappers.length}`));
    }
    if (g['residualSchemasEqualClassic']) {
      const classic = new Map(cons.classicTools.map((t) => [t.name, JSON.stringify(t)]));
      const drift = cons.replacementTools.filter((t) => !cons.wrapperNames.includes(t.name) && classic.get(t.name) !== JSON.stringify(t)).map((t) => t.name);
      add('toolList.residualSchemasEqualClassic', ok(drift.length === 0, `descriptors that differ from classic: ${drift.join(', ') || 'none'}`));
    }
    if (g['residualOrderEqualClassic']) {
      const classicOrder = names(cons.classicTools).filter((n) => residual.includes(n));
      add('toolList.residualOrderEqualClassic', ok(deepEqual(classicOrder, residual), 'residual tools in classic\'s relative order'));
    }
  }
  if ('catalogue' in c) {
    const g = c['catalogue'] as Obj;
    if (g['namesEqualOriginal']) add('catalogue.namesEqualOriginal', ok(deepEqual([...cons.catalogueNames].sort(), [...cons.originalNames].sort()), `catalogue ${cons.catalogueNames.length} names vs original ${cons.originalNames.length}`));
    if (g['orderEqualBetweenRuns']) add('catalogue.orderEqualBetweenRuns', ok(cons.catalogueRuns.length >= 2 && cons.catalogueRuns.every((r) => deepEqual(r.names, cons.catalogueRuns[0]!.names)), `${cons.catalogueRuns.length} runs`));
    if (g['bytesEqualBetweenRuns']) add('catalogue.bytesEqualBetweenRuns', ok(cons.catalogueRuns.length >= 2 && cons.catalogueRuns.every((r) => r.bytes === cons.catalogueRuns[0]!.bytes), `${cons.catalogueRuns.length} runs`));
  }
  if ('sources' in c) {
    for (const name of (c['sources'] as Obj)['unchanged'] as string[]) {
      const s = cons.sources[name];
      add(`sources.unchanged.${name}`, ok(s !== undefined && s.classic === s.replacement && s.classic !== '', s === undefined ? 'not observed' : s.classic === '' ? 'empty source' : s.classic === s.replacement ? 'same bytes' : `the arms differ (${Buffer.byteLength(s.classic, 'utf8')} bytes against ${Buffer.byteLength(s.replacement, 'utf8')}, first difference at ${firstDifference(s.classic, s.replacement)})`));
    }
  }
  return out;
}

/**
 * The verdicts of a `run` goal: every criterion on the arms it applies to, plus the invariants of each arm that ran. An arm the goal asks for
 * and the runner did not produce is a failure of its own, never a skip.
 */
export function judgeRunGoal(goal: Goal, observations: Readonly<Partial<Record<Arm, ArmObservation>>>, ids: Ids, cons?: ConservationObservation): Verdict[] {
  const out: Verdict[] = [];
  for (const arm of goal.arms) if (observations[arm] === undefined) out.push(v(goal.id, arm, 'arm', ok(false, `the ${arm} arm did not run`)));
  for (const arm of goal.arms) { const o = observations[arm]; if (o !== undefined) out.push(...invariants(goal, o)); }
  goal.criteria.forEach((c, i) => {
    const where = `criteria[${i}]`;
    const restrict = typeof c['arm'] === 'string' ? (c['arm'] as Arm) : null;
    const arms: Arm[] = restrict !== null ? [restrict] : 'run' in c || 'record' in c ? ['replacement'] : [...goal.arms];
    if ('toolList' in c || 'catalogue' in c || 'sources' in c) { out.push(...conservation(c, cons, goal.id).map((x) => ({ ...x, where: `${where}.${x.where}` }))); return; }
    if ('equalAcrossArms' in c) {
      const a = observations.classic;
      const b = observations.replacement;
      const path = String(c['equalAcrossArms']);
      if (a === undefined || b === undefined) { out.push(v(goal.id, 'both', where, ok(false, 'equalAcrossArms needs both arms'))); return; }
      const x = valueAt(a.answer, path, true);
      const y = valueAt(b.answer, path, true);
      out.push(v(goal.id, 'both', where, ok(x !== MISSING && y !== MISSING && deepEqual(x, y), x === MISSING || y === MISSING ? `${path} is missing on ${x === MISSING ? 'classic' : 'replacement'}` : `${path} ${deepEqual(x, y) ? 'is equal' : 'differs between the arms'}`)));
      return;
    }
    for (const arm of arms) {
      const obs = observations[arm];
      if (obs === undefined) continue; // already reported as an arm that did not run
      if ('answer' in c) out.push(v(goal.id, arm, where, pathCriterion(obs.answer, c['answer'] as Obj, ids)));
      else if ('run' in c) for (const r of runCriterion(c['run'] as Obj, obs)) out.push(v(goal.id, arm, where, r));
      else if ('host' in c) for (const r of hostCriterion(c['host'] as Obj, obs)) out.push(v(goal.id, arm, where, r));
      else if ('record' in c) out.push(v(goal.id, arm, where, ok(obs.record === (c['record'] as Obj)['state'], `record ${obs.record} vs ${String((c['record'] as Obj)['state'])}`)));
      else if ('text' in c) {
        const n = (c['text'] as Obj)['neverContains'];
        if (obs.received === '') { out.push(v(goal.id, arm, where, ok(false, 'nothing at all was received, so a negative text criterion proves nothing'))); continue; }
        if (typeof n === 'string') out.push(v(goal.id, arm, where, ok(!obs.received.includes(n), obs.received.includes(n) ? `the client received ${JSON.stringify(n)}` : 'not received')));
        else {
          const canary = String(goal.faults['localCanary']);
          if (obs.canaryReadable !== true) out.push(v(goal.id, arm, where, ok(false, 'the canary control could not read the canary back from the local store')));
          else out.push(v(goal.id, arm, where, ok(!obs.received.includes(canary), obs.received.includes(canary) ? 'the canary reached the client' : 'canary not received')));
        }
      }
    }
  });
  return out;
}

// ---------- launch and rollback ----------

export interface LaunchView {
  readonly layer: string;
  readonly argvWithoutLayer: string;
  readonly env: Readonly<Record<string, string>>;
  readonly verdict: Readonly<Record<string, { readonly status: string } | undefined>>;
  readonly selectsClassic: { readonly classic: boolean; readonly source: string | null };
  readonly tools: readonly string[];
  readonly brief: string;
  readonly skillCatalogue: readonly string[];
  readonly threw: string | null;
}
// The note a replacement launch appends to a shipped role's or playbook's text, in the two sentence shapes the product writes (a migrated operation, and
// operations not available here). The layer comparison strips a note only when it has exactly this shape, so a changed byte inside a note is a difference.
const NOTE_MIGRATED = '[a-z_]+ is called as parley\\.[a-z_]+\\(args\\) inside code_execute \\(read code_docs first\\)\\.';
const NOTE_MISSING = '[a-z_]+(?:, [a-z_]+)* (?:is|are) not available here; say so instead of calling (?:it|them)\\.';
const ROUTING_NOTE = new RegExp(`\\n\\nRouting for this launch: (?:${NOTE_MIGRATED}|${NOTE_MISSING})(?: (?:${NOTE_MIGRATED}|${NOTE_MISSING}))*(?=\\n|$)`, 'g');

export interface LaunchObservation {
  readonly plan: LaunchView;
  readonly classic: LaunchView;
  readonly bootstrap: string;
  /** The operations the plan's routing runs through the script surface; none for classic and for a routing that proves nothing. */
  readonly migrated: readonly string[];
}

// The one thing a Codex layer changes besides the bootstrap, written out here as literals and NOT taken from the product (the product's own rebuild would make
// the comparison circular): the call examples block shows a migrated operation inside the script surface, and gains one line about the api revision.
const CODEX_EXAMPLES_HEADER = 'Parley tools in Codex code mode are called as tools.mcp__parley__<name>(args). Examples:';
const CODEX_REVISION_LINE = '  // apiRevision comes from code_docs; call it once before the first code_execute.';
const CODEX_ROWS: Readonly<Record<string, { readonly classic: string; readonly replaced: string }>> = {
  get_map: { classic: '  const map = await tools.mcp__parley__get_map({});', replaced: "  const map = await tools.mcp__parley__code_execute({ code: 'return await parley.get_map({})', apiRevision });" },
  send_message: { classic: '  await tools.mcp__parley__send_message({ to: "s-02", kind: "question", text: "Which branch do I build on?" });', replaced: `  await tools.mcp__parley__code_execute({ code: 'return await parley.send_message({ to: "s-02", kind: "question", text: "Which branch do I build on?" })', apiRevision });` },
  check_inbox: { classic: '  const inbox = await tools.mcp__parley__check_inbox({});                 // once per "New messages (N)" pointer', replaced: `  const inbox = await tools.mcp__parley__code_execute({ code: 'return await parley.check_inbox({})', apiRevision }); // once per "New messages (N)" pointer` },
  wait_for: { classic: '  await tools.mcp__parley__wait_for({ target: "inbox", timeoutSec: 1500 }); // returns and marks messages read; on running repeat once', replaced: `  await tools.mcp__parley__code_execute({ code: 'return await parley.wait_for({ target: "inbox", timeoutSec: 1500 })', apiRevision }); // returns and marks messages read; on running repeat once` },
  report: { classic: '  await tools.mcp__parley__report({ status: "done", summary: "What was done, what was found, what is left." });', replaced: `  await tools.mcp__parley__code_execute({ code: 'return await parley.report({ status: "done", summary: "What was done, what was found, what is left." })', apiRevision });` },
};

/**
 * The launch layer without routing, with the Codex examples rewrite applied for `migrated`: exactly the rows of the migrated operations that have one, and the
 * revision line once after the header, only when some row was rewritten. Any other layer (no examples block) comes back as it is.
 */
export function classicLayerWithExamplesRewrite(classic: string, migrated: readonly string[]): string {
  const rows = migrated.filter((name) => name in CODEX_ROWS);
  if (rows.length === 0 || !classic.includes(`${CODEX_EXAMPLES_HEADER}\n`)) return classic;
  let out = classic;
  for (const name of rows) {
    const row = CODEX_ROWS[name]!;
    if (out.split(row.classic).length !== 2) return classic; // the row is not there exactly once: nothing is rewritten, and the comparison then fails on the product's own rewrite
    out = out.replace(row.classic, () => row.replaced);
  }
  return out.replace(`${CODEX_EXAMPLES_HEADER}\n`, () => `${CODEX_EXAMPLES_HEADER}\n${CODEX_REVISION_LINE}\n`);
}

export function judgeLaunchGoal(goal: Goal, obs: LaunchObservation): Verdict[] {
  const out: Verdict[] = [];
  goal.criteria.forEach((c, i) => {
    const where = `criteria[${i}]`;
    const add = (r: { pass: boolean; detail: string }): void => { out.push(v(goal.id, 'replacement', where, r)); };
    if ('layer' in c) {
      const l = c['layer'] as Obj;
      if ('startsWith' in l) add(ok(obs.plan.layer.startsWith(String(l['startsWith'])), 'layer startsWith'));
      if ('contains' in l) add(ok(obs.plan.layer.includes(String(l['contains'])), 'layer contains'));
      if ('notContains' in l) add(ok(!obs.plan.layer.includes(String(l['notContains'])) && obs.plan.layer !== '', obs.plan.layer === '' ? 'there is no layer at all' : 'layer notContains'));
    } else if ('layerEqualsClassicWithBootstrap' in c) {
      const withBoot = obs.plan.layer.startsWith(`${obs.bootstrap}\n`);
      let rest = withBoot ? obs.plan.layer.slice(obs.bootstrap.length + 1) : obs.plan.layer;
      const notes = [...rest.matchAll(ROUTING_NOTE)].map((m) => m[0]);
      for (const n of notes) rest = rest.replace(n, '');
      const expected = classicLayerWithExamplesRewrite(obs.classic.layer, obs.migrated);
      add(ok(withBoot && notes.length <= 2 && rest === expected, withBoot ? (rest === expected ? 'classic plus the bootstrap' : 'differs from the classic layer outside the bootstrap') : 'the layer does not start with the bootstrap'));
    } else if ('argv' in c) {
      const a = c['argv'] as Obj;
      if ('equalsClassicOutsideLayer' in a) add(ok(obs.plan.argvWithoutLayer === obs.classic.argvWithoutLayer, 'argv outside the layer'));
      if ('contains' in a) add(ok(obs.plan.argvWithoutLayer.includes(String(a['contains'])), 'argv contains'));
      if ('notContains' in a) add(ok(!obs.plan.argvWithoutLayer.includes(String(a['notContains'])) && obs.plan.argvWithoutLayer !== '', 'argv notContains'));
    } else if ('env' in c) {
      const e = c['env'] as Obj;
      if ('has' in e) add(ok(String(e['has']) in obs.plan.env, `env has ${String(e['has'])}`));
      if ('lacks' in e) add(ok(!(String(e['lacks']) in obs.plan.env) && Object.keys(obs.plan.env).length > 0, `env lacks ${String(e['lacks'])}`));
    } else if ('verdict' in c) {
      const x = c['verdict'] as Obj;
      add(ok(obs.plan.verdict[String(x['source'])]?.status === x['status'], `verdict ${String(x['source'])} is ${obs.plan.verdict[String(x['source'])]?.status ?? 'absent'}, wanted ${String(x['status'])}`));
    } else if ('selectsClassic' in c) {
      const x = c['selectsClassic'] as Obj;
      add(ok(obs.plan.selectsClassic.classic === x['value'] && (!('source' in x) || obs.plan.selectsClassic.source === x['source']), `selectsClassic ${JSON.stringify(obs.plan.selectsClassic)}`));
    } else if ('tools' in c) {
      const t = c['tools'] as Obj;
      if ('includes' in t) add(ok((t['includes'] as string[]).every((n) => obs.plan.tools.includes(n)), 'tools include'));
      if ('excludes' in t) add(ok((t['excludes'] as string[]).every((n) => !obs.plan.tools.includes(n)) && obs.plan.tools.length > 0, 'tools exclude'));
      if ('count' in t) add(ok(obs.plan.tools.length === t['count'], `tools ${obs.plan.tools.length} vs ${String(t['count'])}`));
    } else if ('skillCatalogue' in c) {
      const t = c['skillCatalogue'] as Obj;
      if ('includes' in t) add(ok((t['includes'] as string[]).every((n) => obs.plan.skillCatalogue.includes(n)), 'catalogue includes'));
      if ('excludes' in t) add(ok((t['excludes'] as string[]).every((n) => !obs.plan.skillCatalogue.includes(n)) && obs.plan.skillCatalogue.length > 0, 'catalogue excludes'));
    } else if ('brief' in c) {
      const b = c['brief'] as Obj;
      if ('contains' in b) add(ok(obs.plan.brief.includes(String(b['contains'])), 'brief contains'));
      if ('notContains' in b) add(ok(!obs.plan.brief.includes(String(b['notContains'])) && obs.plan.brief !== '', 'brief notContains'));
    } else if ('throws' in c) add(ok(obs.plan.threw === c['throws'], `threw ${String(obs.plan.threw)} vs ${String(c['throws'])}`));
  });
  return out;
}

export interface Selection { readonly effective: string; readonly reason: string | null; readonly held?: string }
export interface RecordSnapshot { readonly sha256: string; readonly inode: number; readonly mtimeMs: number }
export interface RollbackObservation {
  readonly selection: Selection;
  readonly repeats: readonly Selection[];
  readonly before: RecordSnapshot | null;
  readonly after: RecordSnapshot | null;
  readonly nextLaunch: { readonly tools: number; readonly bootstrap: string; readonly wrappers: boolean } | null;
  readonly busyReason: string | null;
  readonly hostCalls: number;
}

export function judgeRollbackGoal(goal: Goal, obs: RollbackObservation): Verdict[] {
  const out: Verdict[] = [];
  goal.criteria.forEach((c, i) => {
    const where = `criteria[${i}]`;
    const add = (r: { pass: boolean; detail: string }): void => { out.push(v(goal.id, 'replacement', where, r)); };
    if ('selection' in c) {
      const want = c['selection'] as Obj;
      const got = obs.selection as unknown as Obj;
      const fields = ['effective', 'reason', 'held'].filter((k) => k in want);
      // the launcher's whole answer: the fields the goal names must match, and a `held` the goal does not name must not be there
      add(ok(fields.every((k) => (want[k] ?? null) === (got[k] ?? null)) && ('held' in want || got['held'] === undefined), `selection ${JSON.stringify(obs.selection)}`));
    } else if ('recordUnchanged' in c) add(ok(obs.before !== null && obs.after !== null && deepEqual(obs.before, obs.after), obs.before === null ? 'there was no record to compare' : 'record bytes, inode and mtime'));
    else if ('nextLaunch' in c) {
      const w = c['nextLaunch'] as Obj;
      const n = obs.nextLaunch;
      add(ok(n !== null && n.tools === w['tools'] && n.wrappers === w['wrappers'] && (!('bootstrapContains' in w) || n.bootstrap.includes(String(w['bootstrapContains']))), `nextLaunch ${JSON.stringify(n === null ? null : { tools: n.tools, wrappers: n.wrappers })}`));
    } else if ('busy' in c) add(ok(obs.busyReason === (c['busy'] as Obj)['reason'], `busy ${String(obs.busyReason)}`));
    else if ('calls' in c) add(ok(obs.hostCalls === c['calls'], `host calls ${obs.hostCalls}`));
    else if ('repeatSelection' in c) add(ok(obs.repeats.length === c['repeatSelection'] && obs.repeats.every((s) => deepEqual(s, obs.selection)), `${obs.repeats.length} repeats`));
  });
  return out;
}

export function failures(verdicts: readonly Verdict[]): readonly Verdict[] {
  return verdicts.filter((x) => !x.pass);
}
