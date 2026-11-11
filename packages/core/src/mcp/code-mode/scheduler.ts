// Code Mode run scheduling and the parent-owned call ledger (plan T4b). Parent-only: the sandboxed helper never imports
// this module, and nothing the helper reports (counts, `done`, unsettled lists) replaces what the ledger recorded.
//
// One run per session: a session-MCP process holds one SessionScheduler, and a second run while the lease is held is
// refused at once (`busy`), never queued. The lease is released only when the run's lifecycle is terminal (helper and
// launch probe accounted for) AND every started call has a terminal receipt (succeeded, failed or cancelled). A call
// still dispatched or draining keeps the lease until a later authoritative receipt; an `unknown` outcome (a rejected or
// throwing host, a malformed or unrequested receipt, an explicit `unknown`) keeps it for good (decisions m-4131/m-4136,
// U2, for every effect class): naming the outcome unknown does not prove the underlying work stopped, and this minimal
// API has no later receipt channel for it. DELIBERATE LIMITATION: such a session stays busy for the process lifetime, and its
// next launch is classic (T8h, `selectExposure`). Nothing here replays, resets, ages out or releases unknown work.
// `unread` is not unknown (T5b-budget-wedge, m-5674): only a host whose answering attempt is done reports it, which says nothing about
// earlier attempts, so it is a terminal receipt whose content nobody read. Who may report it is the broker's decision, for read effects only.
//
// This lease is memory. What outlives the process is `run-record.ts` (T7a-sleep): when `acquire` is given a store, the record is the
// lease across processes, and a run held here is still held after the process ends.

import { types as utilTypes } from 'node:util';
import { type AdmittedCall, type CallValidators, type OperationEvidence, admitCall, operationEvidence } from './contracts.js';
import type { RunLimits } from './limits.js';
import type { PolicyRefusal } from './native-policy.js';
import { RECORD_BUSY_TEXT, type RunRecordStore } from './run-record.js';
import type { Assessment } from './read-adapters.js';
import { ARG_LIMITS, type JsonValue, parseStrictJson } from './validation.js';

// ----- typed fixture settlement contract (m-4126, accepted m-4131) -----

/**
 * What a trusted (synthetic, fixture) host returns for one call. `ok` and `error` are authoritative terminal receipts;
 * `cancelled` acknowledges that the underlying work was cancelled and is accepted only after the parent requested
 * cancellation of that call; `unknown` reports uncertainty. A promise rejection of any kind (an AbortError included), a
 * synchronous throw and any value that is not exactly one of these shapes are `unknown`. The guest cannot mint these.
 *
 * `observedBytes` (plan T5b2) is the parent-measured count of response bytes the transport actually read for the call,
 * over every attempt; when present it must be a safe non-negative integer, and it is what the raw budget is charged,
 * for every kind. It is absent only for the historical T4b fixtures, which are charged by their text length (0 without
 * text). `error` may carry the whole tool result `text` (a `CallToolResult` with `isError`), delivered as data.
 *
 * `assessment` (plan T6c) is the trusted host's view of how complete a settled read is. It belongs to `ok` and `error` only;
 * on any other kind, or with any other value, the settlement is malformed. Absent means no view was given, as for the
 * historical T4b fixtures: the ledger does not floor it, and the broker's result treats it as incomplete.
 */
export type HostSettlement =
  | { readonly kind: 'ok'; readonly text: string; readonly observedBytes?: number; readonly assessment?: Assessment }
  | { readonly kind: 'error'; readonly text?: string; readonly observedBytes?: number; readonly assessment?: Assessment }
  | { readonly kind: 'cancelled'; readonly observedBytes?: number }
  | { readonly kind: 'unread'; readonly observedBytes: number; readonly runBudgetCut?: true }
  /** The host proved the call reached no tool (its route is absent): the entry is refused, with zero dispatch. Its bytes are required. */
  | { readonly kind: 'not-dispatched'; readonly observedBytes: number }
  | { readonly kind: 'unknown'; readonly observedBytes?: number };

export interface HostCall { readonly runId: string; readonly ordinal: number; readonly method: string; readonly argsText: string }
/** The run's raw response budget as the parent ledger sees it now (settled bytes only). */
export interface HostBudget { remainingRaw(): number }
/** The fixture host. `cancel` is aborted when the parent requests cancellation of this call. */
export type FixtureHost = (call: HostCall, cancel: AbortSignal, budget: HostBudget) => Promise<HostSettlement>;

/**
 * The parent's verdict at the dispatch edge, asked last, synchronously, immediately before a call would be dispatched.
 * Anything that is not exactly one of these (or a throw) refuses the call as `run-ended`: the edge fails closed.
 */
export type EdgeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'run-ended' }
  | { readonly ok: false; readonly reason: 'transport-too-large' }
  | { readonly ok: false; readonly reason: 'run-record' }
  | { readonly ok: false; readonly reason: 'policy'; readonly policy: PolicyRefusal; readonly terminal: boolean };
export type DispatchEdge = (call: AdmittedCall, ordinal: number) => EdgeVerdict;
const POLICY_REFUSALS: ReadonlySet<string> = new Set(['ask', 'deny', 'unknown', 'stale', 'revoked', 'forged', 'mismatch', 'consumed']);

/**
 * The verdict if `v` is exactly one of the EdgeVerdict shapes, otherwise a fail-closed `run-ended`. It runs no
 * caller-controlled code: a proxy is refused before any reflection; then only the prototype, `Reflect.ownKeys` (symbols
 * and non-enumerable keys count, so hidden extras fail exactness) and own DATA descriptors are read, so an accessor is
 * never invoked (it refuses). Arrays, class instances and other non-plain objects refuse. The result is a fresh frozen
 * object of primitives, so nothing the callback holds can change it later.
 */
function readVerdict(v: unknown): EdgeVerdict {
  const runEnded: EdgeVerdict = Object.freeze({ ok: false, reason: 'run-ended' });
  try {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || utilTypes.isProxy(v)) return runEnded;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return runEnded;
    /** The own data value of `key`, or ABSENT (an accessor throws, which refuses). */
    const data = (key: string): unknown => ownData(v, key);
    const ok = data('ok');
    if (ok === true) return exactKeys(v, ['ok']) ? Object.freeze({ ok: true }) : runEnded;
    if (ok !== false) return runEnded;
    const reason = data('reason');
    if ((reason === 'run-ended' || reason === 'transport-too-large' || reason === 'run-record') && exactKeys(v, ['ok', 'reason'])) return Object.freeze({ ok: false, reason });
    if (reason !== 'policy' || !exactKeys(v, ['ok', 'reason', 'policy', 'terminal'])) return runEnded;
    const policy = data('policy');
    const terminal = data('terminal');
    if (typeof policy !== 'string' || !POLICY_REFUSALS.has(policy) || typeof terminal !== 'boolean') return runEnded;
    return Object.freeze({ ok: false, reason: 'policy', policy: policy as PolicyRefusal, terminal });
  } catch {
    return runEnded;
  }
}

/** Own keys including symbols and non-enumerable ones, so a hidden extra key fails exactness. */
const exactKeys = (o: object, keys: readonly string[]): boolean => {
  const own = Reflect.ownKeys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/**
 * The settlement if `value` is exactly one of the four shapes (own data properties only), otherwise null. A Proxy is
 * refused before any reflection, and any throw while reading (a hostile getter or trap) also yields null (unknown).
 */
export function readSettlement(value: unknown): HostSettlement | null {
  try { return readSettlementUnsafe(value); } catch { return null; }
}

/** An own data property's value, or `absent`. */
const ABSENT = Symbol('absent');
function ownData(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined) return ABSENT;
  if (!Object.hasOwn(d, 'value')) throw new Error('accessor');
  return d.value;
}

function readSettlementUnsafe(value: unknown): HostSettlement | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const kind = ownData(value, 'kind');
  const text = ownData(value, 'text');
  const observed = ownData(value, 'observedBytes');
  if (observed !== ABSENT && !(typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0)) return null;
  const assessment = ownData(value, 'assessment');
  if (assessment !== ABSENT && assessment !== 'complete' && assessment !== 'partial' && assessment !== 'unknown') return null;
  // Typed evidence of an `unread` only: the cap that cut the response was the run's budget. Anything but `true`, or on another kind, is malformed.
  const cut = ownData(value, 'runBudgetCut');
  if (cut !== ABSENT && (cut !== true || kind !== 'unread')) return null;
  const keys = ['kind', ...(text === ABSENT ? [] : ['text']), ...(observed === ABSENT ? [] : ['observedBytes']), ...(assessment === ABSENT ? [] : ['assessment']), ...(cut === ABSENT ? [] : ['runBudgetCut'])];
  if (!exactKeys(value, keys)) return null;
  if (text !== ABSENT && typeof text !== 'string') return null;
  const withBytes = observed === ABSENT ? {} : { observedBytes: observed as number };
  const withView = assessment === ABSENT ? {} : { assessment: assessment as Assessment };
  if (kind === 'ok') return text === ABSENT ? null : Object.freeze({ kind: 'ok', text: text as string, ...withBytes, ...withView });
  if (kind === 'error') return Object.freeze({ kind: 'error', ...(text === ABSENT ? {} : { text: text as string }), ...withBytes, ...withView });
  if ((kind === 'cancelled' || kind === 'unknown') && text === ABSENT && assessment === ABSENT) return Object.freeze({ kind, ...withBytes });
  // Its bytes are the point of it: an `unread` that does not say what it read is malformed.
  if (kind === 'unread' && text === ABSENT && assessment === ABSENT && observed !== ABSENT) return Object.freeze({ kind, observedBytes: observed as number, ...(cut === true ? { runBudgetCut: true as const } : {}) });
  if (kind === 'not-dispatched' && text === ABSENT && assessment === ABSENT && observed !== ABSENT) return Object.freeze({ kind, observedBytes: observed as number });
  return null;
}

// ----- the ledger -----

/** Where one call is. Transitions only move forward. */
export type CallState = 'refused' | 'dispatched' | 'draining' | 'succeeded' | 'failed' | 'cancelled' | 'unread' | 'unknown';

const NEXT: Readonly<Record<CallState, readonly CallState[]>> = Object.freeze({
  refused: [],
  dispatched: ['draining', 'succeeded', 'failed', 'cancelled', 'unread', 'unknown'],
  draining: ['succeeded', 'failed', 'cancelled', 'unread', 'unknown'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unread: [],
  unknown: [],
});
/** Terminal receipts: these, and only these, let the lease go. */
const RECEIPTS: ReadonlySet<CallState> = new Set(['succeeded', 'failed', 'cancelled', 'unread']);

/** Refusals that end the run as a protocol violation (the helper is killed) vs. ones the guest just sees rejected. */
export const VIOLATIONS = ['duplicate-rid', 'method-not-in-run', 'call-budget', 'in-flight', 'arguments-too-large'] as const;
export type Violation = (typeof VIOLATIONS)[number];
export type Refusal = 'run-ended' | 'unsettled-capacity' | 'response-budget-exhausted' | 'not-json' | 'invalid-arguments' | 'policy' | 'transport-too-large' | 'run-record' | 'host-unavailable';

export interface LedgerEntry {
  readonly ordinal: number;
  readonly rid: number;
  /** A method of the run allowlist, or null (a guest-chosen name is never recorded). */
  readonly method: string | null;
  /** The exact validated arguments text the host received; null when refused. */
  readonly argsText: string | null;
  readonly args: JsonValue | null;
  readonly state: CallState;
  readonly refusal: Refusal | Violation | null;
  /** The native-policy refusal behind a `policy` refusal (zero dispatch); null otherwise. */
  readonly policy: PolicyRefusal | null;
  readonly cancelRequested: boolean;
  /**
   * Raw response bytes charged for this call: the host's `observedBytes` when given (any kind), else the UTF-8 bytes of
   * its text (historical fixtures); null when nothing was observed. Delivered or not.
   */
  readonly responseBytes: number | null;
  /** Bytes charged to the response budget for what this call delivered to the guest (serialized IPC lines). */
  readonly deliveredBytes: number;
  /**
   * An authoritative `ok` whose response the parent could not deliver: the host effect happened (the call is
   * `succeeded`, a terminal receipt), but the guest got a failure and the data is missing (evidence incomplete).
   */
  readonly deliveryFailure: 'response-budget' | 'response-not-json' | null;
  /** Why the outcome is unknown. */
  readonly unknownWhy: 'host-rejected' | 'host-threw' | 'malformed-settlement' | 'unrequested-cancel' | 'host-unknown' | 'settle-threw' | null;
  /** The guest received an outcome message for this call. */
  readonly delivered: boolean;
  /** An `unread` whose cut was the run's response budget (typed evidence from the transport); false otherwise. Parent only. */
  readonly runBudgetCut: boolean;
  /** The host's view of how complete this settled read is, set once with the receipt; null when none was given. Parent only. */
  readonly assessment: Assessment | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface LedgerSnapshot {
  readonly entries: readonly LedgerEntry[];
  readonly admitted: number;
  readonly refused: number;
  readonly dispatched: number;
  readonly inFlight: number;
  readonly draining: number;
  readonly unknown: number;
  readonly receipts: number;
  /**
   * Raw response bytes charged at settlement, for every kind (ok, error, unknown, cancelled): the host's parent-measured
   * `observedBytes` (wire bytes over all attempts), or the text length of a historical fixture receipt that has none.
   * Delivered or not.
   */
  readonly hostBytes: number;
  /** Sum of bytes charged to the response budget: every serialized message line delivered to the guest. */
  readonly deliveredBytes: number;
  /** No more admissions (deadline, abort, kill or a closed lifecycle). */
  readonly ended: boolean;
  /** The helper's close was observed, or nothing was spawned. */
  readonly lifecycleClosed: boolean;
  readonly cleanupUnknown: boolean;
  readonly quiescent: boolean;
}

export type Admission =
  | { readonly kind: 'dispatch'; readonly entry: LedgerEntry; readonly call: AdmittedCall }
  | { readonly kind: 'refuse'; readonly entry: LedgerEntry; readonly reason: Refusal }
  | { readonly kind: 'violation'; readonly entry: LedgerEntry; readonly reason: Violation };

/** What the guest is told about a settled call: the response text, or a fixed message (never host-supplied text). */
export type GuestDelivery = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

export const GUEST_MESSAGES = Object.freeze({
  failed: 'parley: call failed',
  undeliverable: 'parley: call response not delivered',
  cancelled: 'parley: call cancelled',
  unknown: 'parley: call outcome unknown',
  refused: 'parley: call refused',
  capacity: 'parley: capacity held by unresolved calls',
  policy: 'parley: not permitted by native policy',
  unavailable: 'parley: host unavailable, call not dispatched',
});

/**
 * The parent's record of every call of one run. Counts, in-flight state and outcomes come from here only.
 * Admission order: protocol checks (duplicate rid, run allowlist, call budget, in-flight bound, argument bytes: any of
 * these is a violation and the caller kills the helper), then run state and the response budget, then strict JSON and
 * the T3b admission (genuine handle, exact revision, authoritative schema) — those refusals only reject the guest's call.
 * A refused or violating call never reaches the host and is never in flight; every attempt counts against the budget.
 */
export class RunLedger {
  readonly runId: string;
  readonly #validators: CallValidators;
  readonly #revision: string;
  readonly #methods: ReadonlySet<string>;
  readonly #limits: RunLimits;
  readonly #entries: Mutable<LedgerEntry>[] = [];
  readonly #rids = new Set<number>();
  #hostBytes = 0;
  #deliveredBytes = 0;
  #admissionClosed = false;
  #lifecycleClosed = false;
  #cleanupUnknown = false;
  #preflightPending = false;
  #listeners: (() => void)[] = [];

  constructor(runId: string, validators: CallValidators, revision: string, methods: readonly string[], limits: RunLimits) {
    this.runId = runId;
    this.#validators = validators;
    this.#revision = revision;
    this.#methods = new Set(methods);
    this.#limits = limits;
  }

  /** Dispatched calls the helper has had no answer for: the protocol bound the helper itself sees. */
  get inFlight(): number { return this.#entries.filter((e) => e.state === 'dispatched').length; }
  /**
   * All unresolved underlying work: dispatched, draining or unknown. An unknown call may still be running remotely, so
   * it keeps occupying its concurrency slot for the rest of the run (s-292 B1/R1).
   */
  get outstanding(): number { return this.#entries.filter((e) => e.state === 'dispatched' || e.state === 'draining' || e.state === 'unknown').length; }
  get ended(): boolean { return this.#admissionClosed; }
  /**
   * Two independent admission thresholds of `responseBytes` (s-292 X3): the raw bytes charged at settlement (all
   * kinds, see `hostBytes`) and the bytes delivered to the guest. Either one exhausted stops further admission. This is
   * a settled-bytes threshold, not a hard aggregate raw cap: calls already started are not reserved and may overshoot
   * it (accepted m-4295); their receipts are still recorded with their actual bytes.
   */
  get responseBudgetExhausted(): boolean { return this.#hostBytes >= this.#limits.responseBytes || this.#deliveredBytes >= this.#limits.responseBytes; }
  /** Bytes still deliverable to the guest. */
  get deliveryRemaining(): number { return Math.max(0, this.#limits.responseBytes - this.#deliveredBytes); }
  /** Raw response bytes still allowed (settled bytes only; calls in flight are not reserved). */
  get rawRemaining(): number { return Math.max(0, this.#limits.responseBytes - this.#hostBytes); }
  /** Started calls without a receipt yet: dispatched or draining. */
  get awaitingReceipt(): number { return this.#entries.filter((e) => e.state === 'dispatched' || e.state === 'draining').length; }
  /** A preflight is still running and owns the lifecycle (the run returned before it settled). */
  get preflightPending(): boolean { return this.#preflightPending && !this.#lifecycleClosed; }

  /**
   * `edge` is asked last, immediately before the call would be dispatched (the caller dispatches synchronously right
   * after), with the admitted call and its ordinal. Anything but `{ ok: true }` refuses the call with zero dispatch
   * evidence: `run-ended` (for example, the deadline passed during validation or authorization), `transport-too-large`,
   * or `policy` (the native-policy refusal is recorded on the entry). A malformed verdict or a throw is `run-ended`.
   */
  admit(rid: number, method: unknown, argsText: unknown, edge: DispatchEdge = () => ({ ok: true })): Admission {
    const known = typeof method === 'string' && this.#methods.has(method) ? method : null;
    const entry: Mutable<LedgerEntry> = { ordinal: this.#entries.length + 1, rid, method: known, argsText: null, args: null, state: 'refused', refusal: null, policy: null, cancelRequested: false, responseBytes: null, deliveredBytes: 0, deliveryFailure: null, unknownWhy: null, delivered: false, runBudgetCut: false, assessment: null };
    const duplicate = this.#rids.has(rid);
    this.#rids.add(rid);
    this.#entries.push(entry);
    const violation = (reason: Violation): Admission => { entry.refusal = reason; this.#notify(); return { kind: 'violation', entry, reason }; };
    const refuse = (reason: Refusal): Admission => { entry.refusal = reason; this.#notify(); return { kind: 'refuse', entry, reason }; };
    if (duplicate) return violation('duplicate-rid');
    if (known === null) return violation('method-not-in-run');
    if (this.#entries.length > this.#limits.maxRpcs) return violation('call-budget');
    if (this.inFlight >= this.#limits.maxInFlight) return violation('in-flight');
    if (typeof argsText !== 'string' || Buffer.byteLength(argsText, 'utf8') > this.#limits.argBytes) return violation('arguments-too-large');
    if (this.#admissionClosed) return refuse('run-ended');
    // A well-behaved guest cannot see that a rejected call is still unknown, so this is a refusal, not a kill.
    if (this.outstanding >= this.#limits.maxInFlight) return refuse('unsettled-capacity');
    if (this.responseBudgetExhausted) return refuse('response-budget-exhausted');
    let call: AdmittedCall;
    try {
      call = admitCall(this.#validators, this.#revision, known, parseStrictJson(argsText, { ...ARG_LIMITS, maxBytes: this.#limits.argBytes }));
    } catch (e) {
      return refuse(e instanceof Error && e.name === 'StrictJsonError' ? 'not-json' : 'invalid-arguments');
    }
    let verdict: EdgeVerdict;
    try { verdict = readVerdict(edge(call, entry.ordinal)); } catch { verdict = { ok: false, reason: 'run-ended' }; }
    if (!verdict.ok) {
      if (verdict.reason === 'policy') entry.policy = verdict.policy;
      return refuse(verdict.reason);
    }
    entry.argsText = call.argsText;
    entry.args = call.args;
    entry.state = 'dispatched';
    this.#notify();
    return { kind: 'dispatch', entry, call };
  }

  #entry(e: LedgerEntry): Mutable<LedgerEntry> {
    const own = this.#entries[e.ordinal - 1];
    if (own === undefined || own !== e) throw new Error('not an entry of this ledger');
    return own;
  }

  #move(e: Mutable<LedgerEntry>, to: CallState): boolean {
    if (!NEXT[e.state].includes(to)) return false;
    e.state = to;
    this.#notify();
    return true;
  }

  /** The parent asked the host to cancel this call (only then can a `cancelled` receipt be accepted). */
  requestCancel(entry: LedgerEntry): void {
    const e = this.#entry(entry);
    if (e.state === 'dispatched' || e.state === 'draining') e.cancelRequested = true;
  }

  /**
   * Record what the host returned and say what the guest should be told (null when the run no longer admits, or the
   * entry was already terminal: a second settlement never changes a recorded outcome). Nothing is charged or marked
   * delivered here: the caller charges the serialized line it actually sends (`tryCharge`).
   */
  settle(entry: LedgerEntry, raw: unknown): GuestDelivery | null {
    const e = this.#entry(entry);
    if (e.state !== 'dispatched' && e.state !== 'draining') return null;
    const live = e.state === 'dispatched' && !this.#admissionClosed;
    const s = readSettlement(raw);
    // Raw bytes are charged for every settlement: the transport's own count when given (wire bytes over all attempts,
    // whatever the outcome), else the text length of a historical fixture receipt, else nothing.
    if (s !== null) {
      const text = 'text' in s ? s.text : undefined;
      const bytes = s.observedBytes ?? (text === undefined ? null : Buffer.byteLength(text, 'utf8'));
      if (bytes !== null) { e.responseBytes = bytes; this.#hostBytes += bytes; }
    }
    /**
     * Data the guest may get: strict JSON text no larger than the whole budget (a larger text is never parsed; the
     * delivery step records the budget failure). Otherwise the fixed `fallback` message, with `response-not-json`.
     */
    const data = (text: string, fallback: string): GuestDelivery => {
      if (Buffer.byteLength(text, 'utf8') <= this.#limits.responseBytes) {
        try { parseStrictJson(text, { maxBytes: this.#limits.responseBytes, maxDepth: 64, maxNodes: 1_000_000 }); } catch { e.deliveryFailure = 'response-not-json'; return { ok: false, message: fallback }; }
      }
      return { ok: true, text };
    };
    let delivery: GuestDelivery;
    if (s === null) { e.unknownWhy = 'malformed-settlement'; this.#move(e, 'unknown'); delivery = { ok: false, message: GUEST_MESSAGES.unknown }; }
    else if (s.kind === 'unknown') { e.unknownWhy = 'host-unknown'; this.#move(e, 'unknown'); delivery = { ok: false, message: GUEST_MESSAGES.unknown }; }
    else if (s.kind === 'not-dispatched') {
      // The one move back to `refused`: the host proved nothing was dispatched (no route), so the entry is what a refusal at the edge is, zero
      // dispatch, a terminal accounting line in the run record, and the lease goes. Only the host's typed settlement can make it; the guest cannot.
      e.state = 'refused';
      e.refusal = 'host-unavailable';
      this.#notify();
      delivery = { ok: false, message: GUEST_MESSAGES.unavailable };
    }
    else if (s.kind === 'cancelled') {
      if (e.cancelRequested) { this.#move(e, 'cancelled'); delivery = { ok: false, message: GUEST_MESSAGES.cancelled }; }
      else { e.unknownWhy = 'unrequested-cancel'; this.#move(e, 'unknown'); delivery = { ok: false, message: GUEST_MESSAGES.unknown }; }
    } else if (s.kind === 'unread') {
      // Terminal, and nobody read it: the guest gets the fixed refusal, never a guess at what it said.
      e.runBudgetCut = s.runBudgetCut === true;
      this.#move(e, 'unread');
      delivery = { ok: false, message: GUEST_MESSAGES.undeliverable };
    } else if (s.kind === 'error') {
      // A terminal tool-error receipt. With text (the whole result, `isError` included) the guest gets it as data; the
      // entry stays failed even if that delivery fails.
      e.assessment = s.assessment ?? null;
      this.#move(e, 'failed');
      delivery = s.text === undefined ? { ok: false, message: GUEST_MESSAGES.failed } : data(s.text, GUEST_MESSAGES.failed);
    } else {
      // An authoritative `ok` settles the underlying operation even when its response cannot be delivered.
      e.assessment = s.assessment ?? null;
      this.#move(e, 'succeeded');
      delivery = data(s.text, GUEST_MESSAGES.undeliverable);
    }
    return live ? delivery : null;
  }

  /** The host promise rejected, the host threw, or recording a settlement threw: the outcome is unknown, never inferred. */
  settleUncertain(entry: LedgerEntry, why: 'host-rejected' | 'host-threw' | 'settle-threw'): GuestDelivery | null {
    const e = this.#entry(entry);
    if (e.state !== 'dispatched' && e.state !== 'draining') return null;
    const live = e.state === 'dispatched' && !this.#admissionClosed;
    e.unknownWhy = why;
    this.#move(e, 'unknown');
    return live ? { ok: false, message: GUEST_MESSAGES.unknown } : null;
  }

  /**
   * Charge `bytes` (one serialized message line about to be sent to the guest) to the response budget. Returns false,
   * charging nothing, when it does not fit: the caller must not send it.
   */
  tryCharge(entry: LedgerEntry | null, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#deliveredBytes + bytes > this.#limits.responseBytes) return false;
    this.#deliveredBytes += bytes;
    if (entry !== null) { const e = this.#entry(entry); e.deliveredBytes += bytes; e.delivered = true; }
    this.#notify();
    return true;
  }

  /**
   * An authoritative receipt (`ok`, or `error` with its result) whose text did not fit the remaining budget: the receipt
   * stands (succeeded or failed), but its data never reached the guest.
   */
  markUndeliverable(entry: LedgerEntry): void {
    const e = this.#entry(entry);
    if ((e.state === 'succeeded' || e.state === 'failed') && e.deliveryFailure === null) { e.deliveryFailure = 'response-budget'; this.#notify(); }
  }

  /**
   * No further call is admitted (deadline, abort, kill, or the run ending): calls still dispatched become draining and
   * keep the lease until a terminal receipt arrives. The helper may still be running; see `lifecycleClosed`.
   */
  stopAdmission(): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    for (const e of this.#entries) if (e.state === 'dispatched') this.#move(e, 'draining');
    this.#notify();
  }

  /** A preflight owns the lifecycle and has not settled: the lease reads "preflight pending" until `lifecycleClosed`. */
  markPreflightPending(): void { this.#preflightPending = true; this.#notify(); }

  /** The helper's close was observed, or nothing was spawned: the lifecycle is terminal (a trusted acknowledgement). */
  lifecycleClosed(): void {
    if (this.#lifecycleClosed) return;
    this.#lifecycleClosed = true;
    this.#notify();
  }

  /** A launch-probe group or helper exit that could not be confirmed: the run never looks free. */
  markCleanupUnknown(): void { this.#cleanupUnknown = true; this.#notify(); }

  /** Both facts at once, for a run whose lifecycle is known to be over (no spawn, or after the observed close). */
  end(): void {
    this.stopAdmission();
    this.lifecycleClosed();
  }

  /** Released only when ended, cleanup is known, and every started call has a terminal receipt. */
  get quiescent(): boolean {
    return this.#admissionClosed && this.#lifecycleClosed && !this.#cleanupUnknown && this.#entries.every((e) => e.state === 'refused' || RECEIPTS.has(e.state));
  }

  /** True when every started call has a terminal receipt (the run may report completed). */
  get allSettled(): boolean { return this.#entries.every((e) => e.state === 'refused' || RECEIPTS.has(e.state)); }

  onChange(listener: () => void): () => void {
    this.#listeners.push(listener);
    return () => { this.#listeners = this.#listeners.filter((l) => l !== listener); };
  }

  #notify(): void { for (const l of [...this.#listeners]) l(); }

  /** Resolves once the lease can go; never resolves while anything is in flight, draining, unknown or uncleaned. */
  whenQuiescent(): Promise<LedgerSnapshot> {
    if (this.quiescent) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const off = this.onChange(() => { if (this.quiescent) { off(); resolve(this.snapshot()); } });
    });
  }

  /** True once no started call is waiting for its receipt (dispatched or draining); false when `ms` passes first. */
  waitForReceipts(ms: number): Promise<boolean> {
    if (this.awaitingReceipt === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { off(); resolve(false); }, Math.max(0, ms));
      const off = this.onChange(() => { if (this.awaitingReceipt === 0) { clearTimeout(t); off(); resolve(true); } });
    });
  }

  /** True once nothing is in flight; false when `ms` passes first. */
  waitForInFlight(ms: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { off(); resolve(false); }, Math.max(0, ms));
      const off = this.onChange(() => { if (this.inFlight === 0) { clearTimeout(t); off(); resolve(true); } });
    });
  }

  snapshot(): LedgerSnapshot {
    const entries = Object.freeze(this.#entries.map((e) => Object.freeze({ ...e })));
    const count = (s: CallState): number => entries.filter((e) => e.state === s).length;
    return Object.freeze({
      entries,
      admitted: entries.length,
      refused: count('refused'),
      dispatched: entries.filter((e) => e.state !== 'refused').length,
      inFlight: count('dispatched'),
      draining: count('draining'),
      unknown: count('unknown'),
      receipts: entries.filter((e) => RECEIPTS.has(e.state)).length,
      hostBytes: this.#hostBytes,
      deliveredBytes: this.#deliveredBytes,
      ended: this.#admissionClosed,
      lifecycleClosed: this.#lifecycleClosed,
      cleanupUnknown: this.#cleanupUnknown,
      quiescent: this.quiescent,
    });
  }

  /**
   * T3b operation evidence, minted against the run handle (unknown names stay null). A protocol violation is not an
   * operation: it ends the run, so it is always the last entry, and it stays in the ledger snapshot but not here.
   */
  evidence(): OperationEvidence[] {
    const violation = (r: LedgerEntry['refusal']): boolean => r !== null && (VIOLATIONS as readonly string[]).includes(r);
    return this.#entries.filter((e) => !violation(e.refusal)).map((e) => operationEvidence(this.#validators, {
      ordinal: e.ordinal,
      method: e.method,
      args: e.args ?? null,
      dispatched: e.state !== 'refused',
      outcome: e.state === 'dispatched' ? 'draining' : e.state,
      responseBytes: e.state === 'succeeded' || e.state === 'failed' || e.state === 'unread' ? (e.responseBytes ?? 0) : null,
      // The floor: only a read the host assessed `complete` stays open to `incomplete: false`. Nothing lowers this later.
      incomplete: e.state === 'dispatched' || e.state === 'draining' || e.state === 'unread' || e.state === 'unknown' || e.deliveryFailure !== null || (e.assessment !== null && e.assessment !== 'complete'),
    }));
  }
}

// ----- the session lease -----

export interface Lease {
  readonly runId: string;
  readonly ledger: RunLedger;
}

export type LeaseResult = { readonly ok: true; readonly lease: Lease } | { readonly ok: false; readonly reason: string; readonly holder: string };

/**
 * One run per session. `acquire` is synchronous, so two concurrent callers cannot both get the lease, and a busy
 * caller is refused at once with the holder's run id and why it is still held. Only the holder's own ledger releases it.
 */
export class SessionScheduler {
  #current: Lease | null = null;
  #counter = 0;

  acquire(make: (runId: string) => RunLedger, record?: RunRecordStore): LeaseResult {
    const cur = this.#current;
    if (cur !== null) {
      const s = cur.ledger.snapshot();
      const why = !s.ended ? 'a run is active' : s.cleanupUnknown ? 'previous run cleanup unknown' : s.unknown > 0 ? 'previous run has calls with unknown outcome' : cur.ledger.preflightPending ? 'previous run preflight pending' : !s.lifecycleClosed ? 'previous run cleanup pending' : 'previous run draining';
      return { ok: false, reason: `busy: ${why}`, holder: cur.runId };
    }
    const runId = `run-${process.pid}-${++this.#counter}`;
    const opened = record?.open(runId);
    // The holder of a record is not named: it is another process's, or none's by now.
    if (opened !== undefined && !opened.ok) return { ok: false, reason: `busy: ${RECORD_BUSY_TEXT[opened.busy]}`, holder: 'run record' };
    const lease: Lease = Object.freeze({ runId, ledger: make(runId) });
    this.#current = lease;
    const handle = opened?.ok === true ? opened.handle : null;
    if (handle !== null) lease.ledger.onChange(() => { handle.sync(lease.ledger.snapshot()); });
    void lease.ledger.whenQuiescent().then(() => {
      handle?.release();
      if (this.#current === lease) this.#current = null;
    });
    return { ok: true, lease };
  }

  get holder(): string | null { return this.#current?.runId ?? null; }

  /**
   * The client is gone (T8h): nothing further may start, and nothing is asked to cancel. Resolves once no started call waits for its
   * receipt, at once when there is no run. Whatever is `unknown` is terminal in the ledger and already in the record, so it does not wait.
   * There is no timer: a count that never reaches 0 never resolves.
   */
  whenClientGone(): Promise<void> {
    const ledger = this.#current?.ledger;
    if (ledger === undefined) return Promise.resolve();
    ledger.stopAdmission();
    if (ledger.awaitingReceipt === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const off = ledger.onChange(() => { if (ledger.awaitingReceipt === 0) { off(); resolve(); } });
    });
  }
}

/** The session-MCP process's scheduler: one session per process, so one lease per process. */
export const SESSION_SCHEDULER = new SessionScheduler();
