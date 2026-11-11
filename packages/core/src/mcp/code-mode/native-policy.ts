// Code Mode native-policy contract (plan T5a, design §5.1; live sources: T12a). The contract and the gate; no broker.
//
// A real launch has native-policy authority only for a provider in `PROVEN_PROVIDERS` (plan T12a, §6.2), which is empty: so
// `resolveLiveNativePolicy` answers `unavailable` (classic fallback) for every input today. It reads only `typeof` and the table, never
// the environment, configuration, accounts, manifests or a wrapper approval, and never a property of its argument. An available answer is
// a one-use proof object: the only way to mint a live source (`mintLiveSource`), which only the live detector calls (a static guard keeps
// every other reference out). Fixture sources are minted through a once-per-process capability that the fixture module claims
// (repository-root tests/fixtures/code-mode, outside every package); a static guard keeps every other non-test reference out. Fixture
// `allow` is fixture authority, never proof of a real client's policy.
//
// The gate owns its launch context. It derives the effective policy snapshot (an opaque hash of the source id, the
// source's policy revision and the canonical effective method set after manifest narrowing), computes the apiRevision
// from that snapshot, one catalogue and one launch id, and compiles the genuine T3b handle itself (no caller handle,
// revision, snapshot or hash is accepted). So the launch identity of the API surface and of the policy decisions is one
// value, and a change of source or effective methods changes the apiRevision. The raw policy revision stays the value
// the source is rechecked against. It binds every decision to that immutable
// launch (launch id, apiRevision, source id, policy revision) and to the exact call (method and the SHA-256 of the
// canonical validated arguments from the gate's handle). Decisions live in
// module-private state: a copy, a proxy, a decision of another gate or for another call is never consumed as allow. Each
// decision is consumed once, immediately before dispatch, and the source is asked again at that moment. Any change of
// the source's policy revision, and an explicit `revoked` or `stale` answer, end the gate for good (the apiRevision binds
// this policy snapshot, so a later `allow` under the same snapshot cannot renew authority; recovery is a new gate with a
// fresh snapshot): every queued or later call gets zero dispatch and the source is not asked again. This says nothing
// about calls already authorized and started; their settlement is the ledger's (scheduler.ts), not this.

import { type Catalog, canonicalSha256, sha256 } from './catalog.js';
import { type CallValidators, admitCall, compileCallValidators, computeApiRevision } from './contracts.js';
import { PROVEN_PROVIDERS } from './proven.js';
import { ARG_LIMITS, type JsonValue, canonicalStrict } from './validation.js';

/**
 * Per-call states. `allow` is the only one that dispatches. `ask`, `deny`, `unknown` and `stale` (the source's snapshot
 * is out of date) come from the source; any answer that is not exactly a state, or a throw, is `unknown`. `revoked` is
 * the source's own answer or the gate's after the policy revision changed. `revoked` and `stale` are terminal for the
 * gate; `ask`, `deny` and `unknown` refuse that one decision.
 */
export const POLICY_STATES = Object.freeze(['allow', 'ask', 'deny', 'unknown', 'stale', 'revoked'] as const);
export type PolicyState = (typeof POLICY_STATES)[number];

const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

export class NativePolicyError extends Error {
  constructor(readonly code: 'invalid-source' | 'invalid-launch' | 'source-unavailable' | 'mint-claimed') {
    super(`native policy: ${code}`);
    this.name = 'NativePolicyError';
  }
}

// ----- Live launches -----

export interface PolicyUnavailable {
  readonly available: false;
  readonly reason: 'native-policy-unproven';
  readonly fallback: 'classic';
}

export const LIVE_POLICY_UNAVAILABLE: PolicyUnavailable = Object.freeze({ available: false, reason: 'native-policy-unproven', fallback: 'classic' });

/** A proven provider's live authority: a frozen one-use proof, issued only here, consumed by `mintLiveSource`. */
export interface PolicyAvailable {
  readonly available: true;
  readonly provider: string;
}

const LIVE_PROOFS = new WeakSet<PolicyAvailable>();

/**
 * The native policy of a real launch: available only for a provider id (a string) in `PROVEN_PROVIDERS`, which is empty until a T12b. No
 * property of the argument is read (only `typeof`), so no account, environment flag, manifest, wrapper approval, fixture object or proxy can
 * change the answer or observe the call.
 */
export function resolveLiveNativePolicy(provider?: unknown): PolicyUnavailable | PolicyAvailable {
  if (typeof provider !== 'string' || !PROVEN_PROVIDERS.includes(provider)) return LIVE_POLICY_UNAVAILABLE;
  const proof: PolicyAvailable = Object.freeze({ available: true, provider });
  LIVE_PROOFS.add(proof);
  return proof;
}

// ----- Sources (fixture authority only) -----

/** What the gate asks a source about one exact call. */
export interface PolicyQuery {
  readonly launchId: string;
  readonly policyRevision: string;
  readonly method: string;
  /** Deeply frozen value parsed from the validated arguments text. */
  readonly args: JsonValue;
  readonly argsSha256: string;
}

/** A source implementation. Answers that are not exactly a policy state, and any throw, count as `unknown`. */
export interface PolicySourceImpl {
  revision(): unknown;
  decide(query: PolicyQuery): unknown;
}

export type PolicyAuthority = 'fixture' | 'live';

/** An opaque source handle; a look-alike object is not a source. */
export interface PolicySource {
  readonly sourceId: string;
  readonly authority: PolicyAuthority;
}

interface SourceRecord { readonly sourceId: string; readonly authority: PolicyAuthority; readonly revision: () => unknown; readonly decide: (q: PolicyQuery) => unknown }

const SOURCES = new WeakMap<PolicySource, SourceRecord>();
let mintClaimed = false;

export type FixtureSourceMint = (sourceId: string, impl: PolicySourceImpl) => PolicySource;

/**
 * The one way to make a source the gate accepts. It is claimed once per process, by the fixture module at load; a second
 * claim throws. Every source it mints has fixture authority; a live source comes only from `mintLiveSource`.
 */
export function claimFixtureSourceMint(): FixtureSourceMint {
  if (mintClaimed) throw new NativePolicyError('mint-claimed');
  mintClaimed = true;
  return (sourceId, impl) => {
    if (typeof sourceId !== 'string' || !IDENTITY.test(sourceId)) throw new NativePolicyError('invalid-source');
    const revision = impl?.revision;
    const decide = impl?.decide;
    if (typeof revision !== 'function' || typeof decide !== 'function') throw new NativePolicyError('invalid-source');
    const handle: PolicySource = Object.freeze({ sourceId, authority: 'fixture' });
    SOURCES.set(handle, Object.freeze({ sourceId, authority: 'fixture', revision: () => Reflect.apply(revision, impl, []), decide: (q: PolicyQuery) => Reflect.apply(decide, impl, [q]) }));
    return handle;
  };
}

/**
 * The one way to make a live source (plan T12a, §4.2): it consumes a proof that `resolveLiveNativePolicy` issued for a proven provider, once.
 * A look-alike proof, a reused one or a proof object built by hand is refused. Only the live detector calls this (a static guard holds it).
 */
export function mintLiveSource(proof: unknown, sourceId: string, impl: PolicySourceImpl): PolicySource {
  if (typeof proof !== 'object' || proof === null || !LIVE_PROOFS.has(proof as PolicyAvailable)) throw new NativePolicyError('invalid-source');
  LIVE_PROOFS.delete(proof as PolicyAvailable);
  if (typeof sourceId !== 'string' || !IDENTITY.test(sourceId)) throw new NativePolicyError('invalid-source');
  const revision = impl?.revision;
  const decide = impl?.decide;
  if (typeof revision !== 'function' || typeof decide !== 'function') throw new NativePolicyError('invalid-source');
  const handle: PolicySource = Object.freeze({ sourceId, authority: 'live' });
  SOURCES.set(handle, Object.freeze({ sourceId, authority: 'live', revision: () => Reflect.apply(revision, impl, []), decide: (q: PolicyQuery) => Reflect.apply(decide, impl, [q]) }));
  return handle;
}

// ----- Launch, decisions and the gate -----

/** The immutable launch/policy revision a gate was opened at. */
export interface LaunchPolicy {
  readonly launchId: string;
  readonly apiRevision: string;
  readonly sourceId: string;
  readonly authority: PolicyAuthority;
  /** The source's own revision at launch; every later check compares the source against it. */
  readonly policyRevision: string;
  /** Opaque effective snapshot: `np1.` + SHA-256 of {sourceId, policyRevision, methods}. It is the apiRevision's policySnapshot. */
  readonly policySnapshot: string;
  /** Methods the gate may ever allow, sorted: the catalogue's documented methods, narrowed by the manifest if one was given. */
  readonly methods: readonly string[];
}

/** One decision, bound to the launch and to one exact call. Opaque: only the gate that issued it can consume it. */
export interface PolicyDecision {
  readonly launchId: string;
  readonly apiRevision: string;
  readonly sourceId: string;
  readonly authority: PolicyAuthority;
  readonly policyRevision: string;
  readonly method: string;
  readonly argsSha256: string;
  readonly state: PolicyState;
}

export type PolicyRefusal = Exclude<PolicyState, 'allow'> | 'forged' | 'mismatch' | 'consumed';

/** May this exact call be dispatched now? `argsText` is what to dispatch: the validated text, never the caller's object. */
export type DispatchAuthorization =
  | { readonly ok: true; readonly method: string; readonly argsText: string; readonly argsSha256: string; readonly decision: PolicyDecision }
  | { readonly ok: false; readonly reason: PolicyRefusal; readonly fallback: 'classic' };

export interface GateStatus {
  readonly launch: LaunchPolicy;
  /**
   * Null while the gate is open. `revoked`: the source's policy changed (or could not be read) after the launch, or the
   * source answered `revoked`. `stale`: the source declared the launch's snapshot stale. Either way nothing more is ever
   * authorized and the source is not asked again.
   */
  readonly terminal: 'revoked' | 'stale' | null;
  readonly decisions: number;
  readonly authorized: number;
  readonly refused: number;
}

export interface PolicyGate {
  readonly launch: LaunchPolicy;
  /** The gate's own genuine T3b handle, at `launch.apiRevision`: the only handle a ledger or broker of this launch uses. */
  readonly validators: CallValidators;
  /**
   * The policy decision for one call. The call is admitted through the genuine handle first, so an unknown method or
   * invalid arguments throw the T3b `ContractError` and no decision exists.
   */
  decide(method: unknown, args: unknown): PolicyDecision;
  /**
   * Consume a decision immediately before dispatch (once). The call is admitted again and must be the decision's exact
   * call; the decision must be `allow`, and the source is asked again now, at the launch's policy revision.
   */
  authorize(decision: unknown, method: unknown, args: unknown): DispatchAuthorization;
  status(): GateStatus;
  /**
   * Ask the source for its revision now, with no call (plan T12a, B2: before a run takes its lease). A change, or a revision that cannot be
   * read, ends the gate for good, exactly as at a call. Returns the terminal state, or null while the gate is open.
   */
  recheck(): 'revoked' | 'stale' | null;
}

interface DecisionRecord { readonly gate: PolicyGate; consumed: boolean }
const DECISIONS = new WeakMap<object, DecisionRecord>();

const isState = (v: unknown): v is PolicyState => typeof v === 'string' && (POLICY_STATES as readonly string[]).includes(v);

export interface GateOptions {
  /** Opaque launch identity. */
  readonly launchId: string;
  /** A human capability manifest: method names. It can only narrow; a name the handle does not document is ignored. */
  readonly manifest?: readonly string[];
}

/**
 * Open a gate for one launch. `source` must be a minted source, fixture or live. The launch's policy revision is read now and
 * fixed for the gate's life. The effective snapshot is derived from the source id, that revision and the effective
 * method set; the apiRevision is computed from `catalog`, `launchId` and that snapshot, and the gate compiles its own
 * handle at it (`gate.validators`).
 */
export function openPolicyGate(source: PolicySource, catalog: Catalog, options: GateOptions): PolicyGate {
  const src = typeof source === 'object' && source !== null ? SOURCES.get(source) : undefined;
  if (src === undefined) throw new NativePolicyError('invalid-source');
  const launchId = options?.launchId;
  const manifest = options?.manifest;
  if (typeof launchId !== 'string' || !IDENTITY.test(launchId)) throw new NativePolicyError('invalid-launch');
  if (manifest !== undefined && !Array.isArray(manifest)) throw new NativePolicyError('invalid-launch');
  const readRevision = (): string | null => {
    try { const r = src.revision(); return typeof r === 'string' && IDENTITY.test(r) ? r : null; } catch { return null; }
  };
  const policyRevision = readRevision();
  if (policyRevision === null) throw new NativePolicyError('source-unavailable');
  let validators: CallValidators;
  let methods: string[];
  let policySnapshot: string;
  try {
    // The documented methods, exactly the set compileCallValidators compiles; the manifest only narrows (order, duplicates
    // and unknown names do not matter).
    const documented = catalog.entries.filter((e) => e.documented).map((e) => e.name).sort();
    const allowed = manifest === undefined ? null : new Set<unknown>(manifest);
    methods = documented.filter((m) => allowed === null || allowed.has(m));
    policySnapshot = `np1.${canonicalSha256({ sourceId: src.sourceId, policyRevision, methods })}`;
    validators = compileCallValidators(catalog, computeApiRevision({ catalog, launch: launchId, policySnapshot }));
    if (validators.methods.join('\n') !== documented.join('\n')) throw new Error('handle methods differ');
  } catch {
    throw new NativePolicyError('invalid-launch');
  }
  const launch: LaunchPolicy = Object.freeze({
    launchId, apiRevision: validators.apiRevision, sourceId: src.sourceId, authority: src.authority, policyRevision, policySnapshot, methods: Object.freeze(methods),
  });
  const eligible = new Set(methods);
  let terminal: 'revoked' | 'stale' | null = null;
  let decisions = 0;
  let authorized = 0;
  let refused = 0;

  const admit = (method: unknown, args: unknown) => {
    const call = admitCall(validators, launch.apiRevision, method, args);
    return { call, argsSha256: sha256(canonicalStrict(call.args, ARG_LIMITS)) };
  };

  /** The current verdict for an admitted call. A revision change at any point, or a `revoked`/`stale` answer, ends the gate for good. */
  const evaluate = (method: string, args: JsonValue, argsSha256: string): PolicyState => {
    if (terminal !== null) return terminal;
    if (readRevision() !== policyRevision) return (terminal = 'revoked');
    if (!eligible.has(method)) return 'deny';
    let state: PolicyState;
    try {
      const v = src.decide(Object.freeze({ launchId, policyRevision, method, args, argsSha256 }));
      state = isState(v) ? v : 'unknown';
    } catch { state = 'unknown'; }
    // The source may have changed while it was deciding.
    if (readRevision() !== policyRevision) return (terminal = 'revoked');
    if (state === 'revoked' || state === 'stale') terminal = state;
    return state;
  };

  const refuse = (reason: PolicyRefusal): DispatchAuthorization => {
    refused++;
    return Object.freeze({ ok: false, reason, fallback: 'classic' });
  };

  const gate: PolicyGate = Object.freeze({
    launch,
    validators,
    decide(method: unknown, args: unknown): PolicyDecision {
      const { call, argsSha256 } = admit(method, args);
      const state = evaluate(call.method, call.args, argsSha256);
      const decision: PolicyDecision = Object.freeze({
        launchId, apiRevision: launch.apiRevision, sourceId: launch.sourceId, authority: launch.authority, policyRevision, method: call.method, argsSha256, state,
      });
      DECISIONS.set(decision, { gate, consumed: false });
      decisions++;
      return decision;
    },
    authorize(decision: unknown, method: unknown, args: unknown): DispatchAuthorization {
      const rec = typeof decision === 'object' && decision !== null ? DECISIONS.get(decision) : undefined;
      if (rec === undefined) return refuse('forged');
      if (rec.gate !== gate) return refuse('mismatch');
      if (rec.consumed) return refuse('consumed');
      rec.consumed = true;
      const d = decision as PolicyDecision;
      let admitted: ReturnType<typeof admit>;
      try { admitted = admit(method, args); } catch { return refuse('mismatch'); }
      if (admitted.call.method !== d.method || admitted.argsSha256 !== d.argsSha256) return refuse('mismatch');
      if (d.state !== 'allow') return refuse(d.state);
      const now = evaluate(admitted.call.method, admitted.call.args, admitted.argsSha256);
      if (now !== 'allow') return refuse(now);
      authorized++;
      return Object.freeze({ ok: true, method: admitted.call.method, argsText: admitted.call.argsText, argsSha256: admitted.argsSha256, decision: d });
    },
    status(): GateStatus {
      return Object.freeze({ launch, terminal, decisions, authorized, refused });
    },
    recheck(): 'revoked' | 'stale' | null {
      if (terminal === null && readRevision() !== policyRevision) terminal = 'revoked';
      return terminal;
    },
  });
  return gate;
}
