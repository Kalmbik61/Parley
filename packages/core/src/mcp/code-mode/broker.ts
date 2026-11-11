// Code Mode fixture broker (plan T5b3, accepted design r3). It joins the T5a native-policy gate, the T5b1 remote-only
// caller and the T5b2 helper/ledger seams for one launch. Fixture scope only: nothing registers it for a real session
// (no server.ts/tools.ts wiring), and the live native-policy resolver stays unavailable, so no live gate exists.
//
// The broker builds everything it trusts itself: the gate (from a minted policy source, the catalogue and one launch
// id), the validators (the gate's own handle) and the remote-only caller (from a copied, checked agent channel and
// launch snapshot). There is no parameter through which a gate, validators, caller or fallback could be injected.
// Every run method must be a read effect, so an `isError` tool result is a terminal receipt only for these reads. A run method is
// on the catalogue's allowlist, documented and enabled (proven, T11 B0): a documented method that is not enabled has docs and no
// callable guest stub, whatever the policy says.
//
// Output (plan T6c): a settled call is decoded here, in the parent, from the admitted arguments and the strict MCP result. The
// guest gets the serialized `ReadResult` alone, after it passes the method's output schema, the same schema object its
// declaration is generated from. The host-only assessment goes to the ledger with the receipt, as the run's monotonic
// `incomplete` floor; the guest cannot read or lower it, and no later read clears it, so paging to the end stays incomplete.
// `envelopeUnknown` stops here: not delivered, not recorded. The ledger state stays the operation's outcome, so a malformed
// DTO is `succeeded` with a guest `invalid-output`. A decoder fault is never a rejection: that would read as an unknown
// outcome, and hold the lease for good, for a call that settled. A transport `unread` (T5b-budget-wedge) is a terminal receipt for
// these reads: the answering attempt is done, which says nothing about earlier attempts, and a read has nothing to double, so a script that reaches its budget ends
// incomplete, not wedged. Abort, wall, socket and non-200 routes stay unknown and hold the lease (U2).
//
// Per call, at the T5b2 dispatch edge (synchronously): the gate decides and authorizes the exact admitted call, the
// request body is prepared, and a single-use stash binds (runId, ordinal, method, argsText) to it; the host callback
// consumes that stash and sends attempt 1 synchronously. Retries re-ask the gate without consuming (`gate.decide`);
// a refusal then is `unknown` with the dispatched evidence kept (U2). The retry window is the run's remaining total
// wall, measured from the start of `run`. Host `meta` is a bounded frozen snapshot taken at construction and forwarded
// unchanged; the guest can never supply it. The transport `callId` stays inside the caller; the broker's audit identity
// is (launchId, runId, ordinal, method, argsSha256).

import type { AgentChannel } from '../../work/mcp-config.js';
import { type PreparedCall, type RemoteOutcome, type ToolLaunch, createRemoteOnlyCaller } from '../remote-tools.js';
import { type Catalog, canonicalSha256 } from './catalog.js';
import { type AuthorizeCall, type HelperResult, type PreflightReport, runHelper } from './helper.js';
import { RUN_LIMITS, type RunLimits, resolveRunLimits } from './limits.js';
import { type LaunchPolicy, type PolicyGate, type PolicySource, openPolicyGate } from './native-policy.js';
import { READ_DECODERS } from './read-adapter-table.js';
import { READ_OUTPUT_SCHEMAS, adapterRevisionOf } from './read-output-schemas.js';
import { type RunRecordStore, createRunRecordStore } from './run-record.js';
import { type Assessment, ENVELOPE_LIMITS } from './read-adapters.js';
import type { EdgeVerdict, HostBudget, HostCall, HostSettlement } from './scheduler.js';
import { type InputValidator, type JsonLimits, type JsonValue, StrictJsonError, compileInputValidator, freezeJson, parseStrictJson } from './validation.js';

export class BrokerError extends Error {
  constructor(readonly code: 'invalid-agent' | 'invalid-launch' | 'invalid-meta' | 'invalid-hold' | 'non-read-method' | 'no-output-contract') {
    super(`code mode broker: ${code}`);
    this.name = 'BrokerError';
  }
}

/** One delivered `ReadResult`: the ledger's own bound on what it delivers (`RunLedger.settle`), plus room for the wrapper. */
export const OUTPUT_LIMITS: JsonLimits = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 1_000_000 });

const invalidOutputText = (code: 'decoder-fault' | 'result-not-strict-json'): string => JSON.stringify({ ok: false, error: { kind: 'invalid-output', code } });

export interface OutputContract {
  /**
   * The settlement for one call the transport settled: the only place a broker settlement of `ok` or `error` is made, so each
   * carries an assessment. `kind` stays the transport's receipt whatever the decoder says. Never throws.
   */
  settle(method: string, args: JsonValue, kind: 'ok' | 'error', transportText: string, observedBytes: number): HostSettlement;
  /**
   * The settlement for a call the transport reports `unread`: a terminal receipt for a read effect, because the answering attempt is
   * done and a read has nothing to double. Anything else stays `unknown`: a method with an effect must prove its own case,
   * since a 200 does not prove the handler ran and an evicted replay record can leave an earlier attempt running.
   */
  unread(method: string, observedBytes: number, runBudgetCut?: true): HostSettlement;
}

/**
 * Compiles the output contract of `methods`, each bound to what `catalog` promises for it: the same schema hash and adapter
 * revision, so a catalogue that promises something else cannot be run. Refuses a method with no decoder or no contract.
 */
export function createOutputContract(catalog: Catalog, methods: readonly string[]): OutputContract {
  const byName = new Map(catalog.entries.map((e) => [e.name, e] as const));
  const validators = new Map<string, InputValidator>();
  for (const method of methods) {
    const output = byName.get(method)?.output;
    const schema = Object.hasOwn(READ_OUTPUT_SCHEMAS, method) ? READ_OUTPUT_SCHEMAS[method] : undefined;
    const revision = adapterRevisionOf(method);
    if (schema === undefined || !Object.hasOwn(READ_DECODERS, method) || revision === undefined || output?.guarantee !== 'decoded' || output.adapterRevision !== revision || output.schemaSha256 !== canonicalSha256(schema)) throw new BrokerError('no-output-contract');
    validators.set(method, compileInputValidator(schema, OUTPUT_LIMITS));
  }
  return Object.freeze({
    settle(method: string, args: JsonValue, kind: 'ok' | 'error', transportText: string, observedBytes: number): HostSettlement {
      let text = invalidOutputText('decoder-fault');
      let assessment: Assessment = 'unknown';
      try {
        let mcpResult: JsonValue | undefined;
        try { mcpResult = parseStrictJson(transportText, ENVELOPE_LIMITS); } catch (e) {
          if (!(e instanceof StrictJsonError)) throw e;
          text = invalidOutputText('result-not-strict-json');
        }
        if (mcpResult !== undefined) {
          const decoded = READ_DECODERS[method]!(args, mcpResult);
          const checked = validators.get(method)!.validateValue(decoded.result);
          if (checked.ok) {
            text = checked.text;
            assessment = decoded.assessment;
          }
        }
      } catch { /* the fixed decoder-fault text and `unknown` stand */ }
      return Object.freeze({ kind, text, observedBytes, assessment });
    },
    unread(method: string, observedBytes: number, runBudgetCut?: true): HostSettlement {
      const read = validators.has(method) && byName.get(method)?.effect === 'read';
      // The cut's typed evidence travels only with a terminal `unread`; an `unknown` says nothing about what was read.
      return Object.freeze(read ? { kind: 'unread' as const, observedBytes, ...(runBudgetCut === true ? { runBudgetCut: true as const } : {}) } : { kind: 'unknown' as const, observedBytes });
    },
  });
}

/**
 * The run's final `incomplete`, by the same floor as `makeExecuteResult`, passed to it as the raising claim. On this path a
 * settled read with no assessment also counts: nothing about it was proved, and a later branch must not fail open by forgetting
 * one. (Only the historical helper fixtures settle without one, and they do not come through the broker.) So does a refused call,
 * for every reason including the guest's own invalid arguments: `evidence()` keeps it `incomplete: false` and `dispatched: false`,
 * which says what happened to that operation, and this says what it means for the run. The same for what the guest refused on its
 * own, or a call whose result the script no longer waited for (T7a-guest-floor): no operation exists for the first, none is made here.
 */
export function finalIncomplete(result: Pick<HelperResult, 'runStatus' | 'evidence' | 'ledger' | 'outcome'>): boolean {
  if (result.runStatus !== 'completed' || result.ledger === null || result.outcome === null) return true;
  const { refused, unsettled } = result.outcome;
  if (unsettled.length > 0 || refused.operations > 0 || refused.argumentBytes > 0 || refused.responseBytes > 0 || refused.notSerializable > 0 || refused.notParsed > 0) return true;
  if (result.evidence.some((op) => op.incomplete)) return true;
  // A refused read is absent, whatever the reason and whether or not the script recovered: nothing says the rest is enough.
  return result.ledger.entries.some((e) => e.state === 'refused' || ((e.state === 'succeeded' || e.state === 'failed') && e.assessment === null));
}

/** Host `meta` bounds: a strict JSON object of at most 16 KiB, depth 8 and 256 nodes. */
export const BROKER_META_LIMITS = Object.freeze({ maxBytes: 16 * 1024, maxDepth: 8, maxNodes: 256 });

export interface BrokerOptions {
  /** A minted policy source: fixture, or live for a proven provider (T12a). */
  readonly source: PolicySource;
  readonly catalog: Catalog;
  readonly launchId: string;
  /** A human capability manifest; it can only narrow. */
  readonly manifest?: readonly string[];
  /** The session's agent channel (host URL and token), captured from the trusted launch context. */
  readonly agent: AgentChannel;
  /** The session's launch snapshot (`launchOf(context)`). */
  readonly launch: ToolLaunch;
  /** Optional host-supplied `_meta`, forwarded unchanged with every call. Never taken from the guest. */
  readonly meta?: unknown;
  /** Where this session's durable run record lives (`run-record.ts`), from the trusted launch context. Required: no run without it. */
  readonly hold: { readonly workDir: string; readonly sessionId: string };
}

/** One dispatched call whose transport outcome the broker observed. The transport `callId` is deliberately absent. */
export interface BrokerAudit {
  readonly launchId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly method: string;
  readonly argsSha256: string;
  readonly outcome: RemoteOutcome['kind'];
  readonly why: string | null;
  readonly attempts: number;
  readonly observedBytes: number;
}

/**
 * A run's result plus the broker's audit of that run: a frozen diagnostic snapshot, sorted by ordinal, of the transport
 * outcomes observed **by the time the run returned** (at most the run's call budget). A call that settles later is not
 * in it; the ledger (`ledger`, `drained`, `evidence`) is authoritative for every outcome, late ones included. The broker
 * keeps no audit history beyond the returned result.
 */
export type BrokerRunResult = HelperResult & {
  readonly audit: readonly BrokerAudit[];
  /** The run's final completeness floor (`finalIncomplete`). `completed` means all calls settled, not that all data is here. */
  readonly incomplete: boolean;
};

export interface Broker {
  /** The gate's immutable launch: id, apiRevision, policy snapshot, methods. */
  readonly launch: LaunchPolicy;
  /** Prepared calls not yet consumed (0 between runs: a run's stash is cleared when it ends). */
  stashSize(): number;
  run(code: string, apiRevision: string, signal?: AbortSignal, limits?: Partial<RunLimits>): Promise<BrokerRunResult>;
}

interface Stashed { readonly method: string; readonly argsText: string; readonly argsSha256: string; readonly args: JsonValue; readonly prepared: PreparedCall }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A result for a run the broker refuses before the helper is asked (no lease taken, nothing spawned). */
/** The reason a run is refused once the native policy went terminal. Named so a test can scan the exact text the agent gets (plan T8e). */
export const nativePolicyReason = (terminal: string): string =>
  `native policy ${terminal}: use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts`;

function refusedRun(reason: string): BrokerRunResult {
  return Object.freeze({
    audit: Object.freeze([]),
    incomplete: true,
    status: 'unavailable', reason, cleanup: 'none', runStatus: null, runId: null, spawned: false, hostCalls: 0, ledger: null, evidence: [], drained: null,
    outcome: null, probes: null, listenerHits: null, launch: null, helperProfileSha256: null, timings: { preflightMs: 0, selfTestMs: null, totalMs: 0 },
    peakRssKb: 0, killedBy: null, maxPendingBytes: 0, preflight: null,
  });
}

export function createBroker(options: BrokerOptions): Broker {
  // Only enabled (proven) methods reach the gate: the manifest narrows to them, so a documented method that is not enabled is not in the
  // launch's methods, has no guest stub and no dispatch, and the policy snapshot and apiRevision say so.
  const enabled = options.catalog.entries.filter((e) => e.migration === 'enabled').map((e) => e.name);
  const asked = options.manifest === undefined ? null : new Set<unknown>(options.manifest);
  const manifest = enabled.filter((m) => asked === null || asked.has(m));
  const gate: PolicyGate = openPolicyGate(options.source, options.catalog, { launchId: options.launchId, manifest });
  // Read effects only: the run's methods are the gate's eligible ones within the catalogue's allowlist, each a catalogue read.
  const effects = new Map(options.catalog.entries.map((e) => [e.name, e.effect] as const));
  const allowlist = new Set(options.catalog.allowlist);
  const methods = Object.freeze(gate.launch.methods.filter((m) => allowlist.has(m)));
  if (methods.some((m) => effects.get(m) !== 'read')) throw new BrokerError('non-read-method');
  const outputs = createOutputContract(options.catalog, methods);
  let remote: ReturnType<typeof createRemoteOnlyCaller>;
  try {
    remote = createRemoteOnlyCaller(options.agent, options.launch);
  } catch (e) {
    throw new BrokerError(e instanceof Error && e.message.includes('agent') ? 'invalid-agent' : 'invalid-launch');
  }
  let meta: JsonValue | undefined;
  if (options.meta !== undefined) {
    try { meta = freezeJson(options.meta, BROKER_META_LIMITS).value; } catch { throw new BrokerError('invalid-meta'); }
    if (!isRecord(meta)) throw new BrokerError('invalid-meta');
  }
  const launchId = gate.launch.launchId;
  let record: RunRecordStore;
  try {
    record = createRunRecordStore({ workDir: options.hold.workDir, sessionId: options.hold.sessionId, launchId });
  } catch {
    throw new BrokerError('invalid-hold');
  }
  const stash = new Map<string, Stashed>();
  const key = (runId: string, ordinal: number): string => `${runId}\u0000${ordinal}`;

  /** The dispatch edge: native policy for the exact admitted call, then the exact request body, then the stash. */
  const authorize = (c: AuthorizeCall): EdgeVerdict => {
    const a = gate.authorize(gate.decide(c.method, c.args), c.method, c.args);
    if (!a.ok) return { ok: false, reason: 'policy', policy: a.reason, terminal: a.reason === 'stale' || a.reason === 'revoked' };
    if (a.argsText !== c.argsText) return { ok: false, reason: 'policy', policy: 'mismatch', terminal: false };
    const prepared = remote.prepare(c.method, c.args, meta);
    if (!('body' in prepared)) return { ok: false, reason: 'transport-too-large' };
    // The intent is on disk before attempt 1 leaves, or nothing leaves.
    if (!record.intent(c.runId, c.ordinal, c.method, a.argsSha256)) return { ok: false, reason: 'run-record' };
    stash.set(key(c.runId, c.ordinal), Object.freeze({ method: c.method, argsText: c.argsText, argsSha256: a.argsSha256, args: c.args, prepared }));
    return { ok: true };
  };

  return Object.freeze({
    launch: gate.launch,
    stashSize: () => stash.size,
    async run(code: string, apiRevision: string, signal?: AbortSignal, limits?: Partial<RunLimits>): Promise<BrokerRunResult> {
      // The source is asked now, with no call yet (T12a, B2): a trigger or the human's off since the last check refuses the run before its
      // lease, and nothing is spawned.
      const terminal = gate.recheck();
      if (terminal !== null) return refusedRun(nativePolicyReason(terminal));
      // The total run wall, measured from here (the helper's own clock starts a moment later, so this is never longer).
      const started = performance.now();
      const resolved = resolveRunLimits(limits);
      const wallMs = resolved.ok ? resolved.limits.wallMs : RUN_LIMITS.wallMs;
      const deadline = started + wallMs;
      const runIds = new Set<string>();
      // This run's audit only: records of outcomes observed while the run is open; nothing is kept after it returns.
      const audit: BrokerAudit[] = [];
      let open = true;
      const host = (call: HostCall, cancel: AbortSignal, budget: HostBudget): Promise<HostSettlement> => {
        runIds.add(call.runId);
        const k = key(call.runId, call.ordinal);
        const s = stash.get(k);
        stash.delete(k);
        // Unreachable by construction: no stash, or not the same call, sends nothing.
        if (s === undefined || s.method !== call.method || s.argsText !== call.argsText) return Promise.resolve({ kind: 'unknown', observedBytes: 0 });
        // Attempt 1 leaves synchronously inside send().
        const sent = remote.send(s.prepared, {
          signal: cancel,
          remainingRaw: () => budget.remainingRaw(),
          beforeRetry: () => { try { return gate.decide(s.method, s.args).state === 'allow'; } catch { return false; } },
          retryBudgetMs: Math.max(0, deadline - performance.now()),
        });
        return sent.then((out): HostSettlement => {
          if (open) audit.push(Object.freeze({ launchId, runId: call.runId, ordinal: call.ordinal, method: s.method, argsSha256: s.argsSha256, outcome: out.kind, why: out.kind === 'unknown' || out.kind === 'unread' || out.kind === 'not-dispatched' ? out.why : null, attempts: out.attempts, observedBytes: out.observedBytes }));
          if (out.kind === 'unknown') return { kind: 'unknown', observedBytes: out.observedBytes };
          // The host has no tools route and this was the only attempt: zero dispatch, the call is refused (spec §5.2), never read locally.
          if (out.kind === 'not-dispatched') return { kind: 'not-dispatched', observedBytes: out.observedBytes };
          if (out.kind === 'unread') return outputs.unread(s.method, out.observedBytes, out.runBudgetCut);
          return outputs.settle(s.method, s.args, out.kind === 'ok' ? 'ok' : 'error', out.text, out.observedBytes);
        });
      };
      const preflight = (s: AbortSignal): Promise<PreflightReport> => remote.list({ signal: s, cap: RUN_LIMITS.responseBytes }).then((o) => ({ ok: o.ok, bytes: o.observedBytes }));
      try {
        const result = await runHelper({
          code, validators: gate.validators, apiRevision, methods, record, host, authorize: (c) => { runIds.add(c.runId); return authorize(c); }, preflight,
          ...(signal === undefined ? {} : { signal }), ...(limits === undefined ? {} : { limits }),
        });
        open = false;
        return Object.freeze({ ...result, audit: Object.freeze([...audit].sort((a, b) => a.ordinal - b.ordinal)), incomplete: finalIncomplete(result) });
      } finally {
        open = false;
        // The run's stash never outlives it: anything prepared but not consumed (refused at the edge after authorization)
        // is dropped, so it can never authorize a later call.
        for (const runId of runIds) for (const k of [...stash.keys()]) if (k.startsWith(`${runId}\u0000`)) stash.delete(k);
      }
    },
  });
}
