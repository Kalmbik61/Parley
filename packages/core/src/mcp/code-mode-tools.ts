// Code Mode MCP wrappers (plan T7a-wrappers): `code_search`, `code_docs` and `code_execute` over the catalogue and the T5b3
// broker. A surface is a value built by a caller; nothing in this tree builds one for a real launch (T7b owns exposure and
// the live native policy stays unavailable), so the classic tool list is untouched until then.
//
// Only host-owned fixed texts cross to the client: every refusal is a ContractError code or a fixed template, and the
// helper's `reason`, a guest's error message and any tool text never enter a result. A run becomes an ExecuteResult by the
// contract (`makeExecuteResult`), with the broker's own `incomplete` claim ALWAYS passed in: operation evidence alone can say a
// run is complete while a swallowed refusal says otherwise.
//
// The backend (catalogue, launch id and the broker, if any) is resolved lazily, once, at the first call of any tool: the
// revision depends on the gate's policy snapshot, so even search needs it. Two first calls share one resolution. A backend that throws or
// rejects makes all three tools unavailable for good (a list failing its check, a broker refusing construction: integrity), except a
// `BackendRetry`: the list could not be read, so that call answers unavailable and a later call of any wrapper tries again, one at a time
// (T12a, §6.3). One broker and one launch id, once built. The memo never stands in for the per-dispatch authorization.
//
// This module and everything it pulls in load only on a replacement launch (`server.ts`): a classic start must not pay for them.

import { randomUUID } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Broker, BrokerRunResult } from './code-mode/broker.js';
import { type Catalog, type CatalogEntry, buildCatalog, canonicalSha256, declarationsFor } from './code-mode/catalog.js';
import {
  type BusyReason,
  CONTRACT_LIMITS,
  type CallValidators,
  ContractError,
  type ContractErrorCode,
  type DiagnosticInput,
  type DocsItem,
  type ExecuteErrorKind,
  type ExecuteResult,
  REQUEST_SCHEMAS,
  type SearchItem,
  admitExecute,
  buildPage,
  compileCallValidators,
  computeApiRevision,
  decodeCursor,
  makeExecuteResult,
  parseDocsRequest,
  parseSearchRequest,
  renderAgentView,
  requestKey,
  serializePage,
  usableDiagnostics,
} from './code-mode/contracts.js';
import { resolveLiveNativePolicy } from './code-mode/native-policy.js';
import { RESULT_LIMITS, parseStrictJson } from './code-mode/validation.js';
import { type LaunchDecision, readLaunchDecision } from './code-mode/launch-decision.js';
import { RECORD_BUSY_TEXT } from './code-mode/run-record.js';
import { writeExposureRecord } from './code-mode/exposure-record.js';
import { MIGRATION_REGISTRY, type MigrationRegistry, checkReplacement, registryRevision } from './code-mode/migration-registry.js';
import { CodeModeStartError, type McpContext } from './context.js';

/** What a surface needs, built by the caller: the session's catalogue, one launch id and the broker, or none. */
export interface CodeModeBackend {
  readonly catalog: Catalog;
  readonly launchId: string;
  /** `null`: execution is not available (no proven native policy). Search and docs still answer. */
  readonly broker: Broker | null;
}

/** The list of original tools could not be read: not final. The call answers unavailable and a later call tries again. */
export class BackendRetry extends Error {
  constructor() {
    super('code mode: the tool list could not be read');
    this.name = 'BackendRetry';
  }
}

/** This launch's own decision, only when it is a replacement carrying this process's nonce. */
function ownDecision(context: Pick<McpContext, 'workDir' | 'sessionId' | 'codeModeLaunch'>): LaunchDecision | null {
  if (context.sessionId === null || context.codeModeLaunch === undefined) return null;
  const read = readLaunchDecision(context.workDir, context.sessionId);
  return read.kind === 'decision' && read.decision.effective === 'replacement' && read.decision.nonce === context.codeModeLaunch ? read.decision : null;
}

/** This launch's provider, from its own decision file, only when the decision carries this process's nonce. */
export function launchProvider(context: Pick<McpContext, 'workDir' | 'sessionId' | 'codeModeLaunch'>): string | null {
  return ownDecision(context)?.provider ?? null;
}

/**
 * The backend of a real launch (T12a, §6.1). A broker exists only when the live native policy is available for this launch's provider,
 * which needs it in `PROVEN_PROVIDERS` (empty: so `broker: null` and zero dispatch today). Then the broker gets the live detector's source,
 * this session's hold, its agent channel and launch snapshot. The gate classifies at open: a dirty state throws here, which is final. The
 * broker, the detector and their imports load only then, so an unproven launch loads none of them.
 */
export async function liveBackend(catalog: Catalog, launchId: string, context?: McpContext): Promise<CodeModeBackend> {
  const decision = context === undefined ? null : ownDecision(context);
  const provider = decision?.provider ?? null;
  const live = resolveLiveNativePolicy(provider);
  if (!live.available || context === undefined) return Object.freeze({ catalog, launchId, broker: null });
  if (context.sessionId === null || context.agent === undefined) throw new Error('code mode: a live broker needs this session and its agent channel');
  const [{ createBroker }, { createDetector, createLiveSource }, { providerSourceClasses }, { launchOf }, { configPath }] = await Promise.all([
    import('./code-mode/broker.js'), import('./code-mode/detector.js'), import('./code-mode/provider-rows.js'), import('./remote-tools.js'), import('../config.js'),
  ]);
  // The row's identities are this launch's own, from the decision that carries this process's nonce.
  const detector = createDetector({ classes: providerSourceClasses(live.provider, { cwd: process.cwd(), ...(decision === null ? {} : { identities: decision }) }), configFile: configPath() });
  const broker = createBroker({
    source: createLiveSource(live, detector), catalog, launchId, agent: context.agent, launch: launchOf(context),
    hold: { workDir: context.workDir, sessionId: context.sessionId },
  });
  return Object.freeze({ catalog, launchId, broker });
}

export interface CodeModeSurface {
  readonly tools: readonly Tool[];
  readonly names: ReadonlySet<string>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  /** Replacement only: what stays direct of this launch's original list. Throws a fixed `CodeModeStartError` rather than hide a tool. */
  directOf?(original: readonly Tool[]): readonly Tool[];
  /** Replacement only: a proven method, no longer callable by its direct name. */
  isMigrated?(name: string): boolean;
}

/** Gets the session's original list, without the wrappers, and builds the surface once per server, at construction. */
export type CodeModeSurfaceFactory = (listOriginal: () => Promise<Tool[]>) => CodeModeSurface;

export interface CodeModeSurfaceOptions {
  /** Called at most once, at the first call of any of the three tools (never at construction or listing). */
  readonly backend: () => CodeModeBackend | Promise<CodeModeBackend>;
}

// ----- Descriptors -----

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const tool = (name: string, description: string, schema: unknown, readOnly: boolean): Tool =>
  deepFreeze({
    name,
    description,
    inputSchema: structuredClone(schema) as Tool['inputSchema'],
    // Honest and conservative: the only reachable methods are in-process reads of the allowlist (`MIGRATABLE_READS`; the registry,
    // the catalogue and the broker each refuse anything else), so nothing is destructive or open-world. A test ties these hints to
    // the allowlist's effects (m-5887); a later write family revisits them first.
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  });

const TOOL_LIST: readonly Tool[] = deepFreeze([
  tool('code_search', 'Search the Code Mode API by words. Returns method names with a one-line summary, effect and availability, in pages.', REQUEST_SCHEMAS.search, true),
  tool('code_docs', 'Read the TypeScript declarations of up to five Code Mode methods by name, from the same apiRevision.', REQUEST_SCHEMAS.docs, true),
  tool('code_execute', 'Run a short JavaScript program that calls the documented methods as parley.<name>(args). Pass the apiRevision from code_search or code_docs. Only read methods can run, and only when Code Mode is available for this session.', REQUEST_SCHEMAS.execute, false),
]);
const NAMES: ReadonlySet<string> = new Set(TOOL_LIST.map((t) => t.name));

// ----- Fixed texts -----

const REFUSAL_TEXT: Readonly<Record<ContractErrorCode, string>> = Object.freeze({
  'invalid-request': 'The request is not valid for this tool.',
  'stale-revision': 'The apiRevision or the cursor is not the current one; call code_search again.',
  'invalid-cursor': 'The cursor is not valid for this request.',
  'unknown-method': 'The request names a method that does not exist.',
  'invalid-arguments': 'The arguments are not valid.',
  'over-budget': 'The request or the answer is over its budget.',
  'invalid-output': 'The tool could not build a valid answer.',
});
const UNAVAILABLE_TEXT = 'Code Mode is not available for this session.';
const FAILED_TEXT = 'The Code Mode tool failed.';
const UNKNOWN_TOOL_TEXT = 'This is not a Code Mode tool.';

const fixed = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const refusal = (e: unknown): CallToolResult => fixed(e instanceof ContractError ? REFUSAL_TEXT[e.code] : FAILED_TEXT);

// ----- The resolved backend -----

const NO_POLICY = 'unavailable';
const REVISION = /^cm1\.[0-9a-f]{64}$/;
/** The revision of the "no surface" answer: well formed, and it names no catalogue. */
const NO_API = `cm1.${'0'.repeat(64)}`;
const EMPTY_CATALOG = Object.freeze({ revision: 'none', namespace: 'parley', allowlist: Object.freeze([]), entries: Object.freeze([]), absent: Object.freeze([]) }) as unknown as Catalog;

interface Resolved {
  readonly catalog: Catalog;
  readonly broker: Broker | null;
  readonly revision: string;
  readonly validators: CallValidators;
  /** Is this method a read of THIS catalogue, the one the run's revision and handle come from? Anything it does not name is not a read. */
  readonly isRead: (method: string) => boolean;
}

/** Documented means documented AND a read: a catalogue that offers anything else gets no declaration and no execution. */
const documentedRead = (e: CatalogEntry): boolean => e.documented && e.effect === 'read';

/** The broker is used only if every method it can run is an allowlisted read of this catalogue and its revision is well formed. */
function usable(broker: Broker, catalog: Catalog): boolean {
  if (!REVISION.test(broker.launch.apiRevision)) return false;
  const byName = new Map(catalog.entries.map((e) => [e.name, e] as const));
  const allowlist = new Set(catalog.allowlist);
  return broker.launch.methods.every((m) => allowlist.has(m) && byName.get(m)?.effect === 'read');
}

function resolveBackend(backend: CodeModeBackend): Resolved {
  const { catalog, launchId } = backend;
  const broker = backend.broker !== null && usable(backend.broker, catalog) ? backend.broker : null;
  const revision = broker !== null ? broker.launch.apiRevision : computeApiRevision({ catalog, launch: launchId, policySnapshot: NO_POLICY });
  const reads = new Set(catalog.entries.filter(documentedRead).map((e) => e.name));
  return { catalog, broker, revision, validators: compileCallValidators(catalog, revision), isRead: (method) => reads.has(method) };
}

// ----- Search and docs -----

const summaryOf = (description: string): string => {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 199);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
};

const availabilityOf = (e: CatalogEntry, broker: Broker | null): SearchItem['availability'] =>
  !documentedRead(e) ? 'unavailable' : broker !== null && broker.launch.methods.includes(e.name) ? 'executable' : 'documented';

/** 3 exact name, 2 name starts with the first word, 1 name has every word, 0 name or description has every word; -1 no match. */
function score(e: CatalogEntry, words: readonly string[], whole: string): number {
  const name = e.name.toLowerCase();
  const all = `${name} ${e.description.toLowerCase()}`;
  if (!words.every((w) => all.includes(w))) return -1;
  if (words.length === 0) return 0;
  if (name === whole) return 3;
  if (name.startsWith(words[0]!)) return 2;
  return words.every((w) => name.includes(w)) ? 1 : 0;
}

function search(state: Resolved, args: Record<string, unknown>): CallToolResult {
  const request = parseSearchRequest(args);
  const key = requestKey('search', request);
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, state.revision, 'search', key);
  const whole = request.query.trim().toLowerCase();
  const words = whole.split(/\s+/).filter((w) => w !== '');
  const items: SearchItem[] = state.catalog.entries
    .map((e) => ({ e, s: score(e, words, whole) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0))
    .map(({ e }) => ({ name: e.name, summary: summaryOf(e.description), effect: e.effect, availability: availabilityOf(e, state.broker) }));
  const page = buildPage('search', state.revision, key, items, offset, request.limit);
  return { content: [{ type: 'text', text: serializePage(page) }] };
}

function docs(state: Resolved, args: Record<string, unknown>): CallToolResult {
  const request = parseDocsRequest(args);
  const key = requestKey('docs', request);
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, state.revision, 'docs', key);
  const byName = new Map(state.catalog.entries.map((e) => [e.name, e] as const));
  const items: DocsItem[] = [];
  const missing: string[] = [];
  for (const name of request.names) {
    const entry = byName.get(name);
    if (entry === undefined || !documentedRead(entry)) { missing.push(name); continue; }
    items.push({
      name, declaration: declarationsFor(state.catalog, [name]), effect: entry.effect, availability: availabilityOf(entry, state.broker),
      inputSchemaSha256: entry.schemaSha256, output: entry.output.guarantee === 'decoded' ? 'decoded' : 'unknown',
    });
  }
  const page = buildPage('docs', state.revision, key, items, offset, undefined, missing);
  return { content: [{ type: 'text', text: serializePage(page) }] };
}

// ----- Execute -----

const NO_VALIDATORS = (() => { let v: CallValidators | undefined; return (): CallValidators => (v ??= compileCallValidators(EMPTY_CATALOG, NO_API)); })();

/** What the agent view is made against: the run's own handle and the run's own catalogue. */
type Viewer = Pick<Resolved, 'validators' | 'isRead'>;
const NO_VIEWER = (): Viewer => ({ validators: NO_VALIDATORS(), isRead: () => false });

/** The agent's answer, and the full result it was made from (null where the answer is a fixed text with no result behind it). */
interface Answered { readonly call: CallToolResult; readonly full: ExecuteResult | null }

/** The scheduler's own busy strings (scheduler.ts `acquire`) by exact match; anything else is `other`. */
const BUSY_BY_WHY: Readonly<Record<string, BusyReason>> = Object.freeze({
  'a run is active': 'a-run-is-active',
  'previous run cleanup unknown': 'previous-run-cleanup-unknown',
  'previous run has calls with unknown outcome': 'previous-run-has-calls-with-unknown-outcome',
  'previous run preflight pending': 'previous-run-preflight-pending',
  'previous run cleanup pending': 'previous-run-cleanup-pending',
  'previous run draining': 'previous-run-draining',
  [RECORD_BUSY_TEXT['previous-process-unaccounted']]: 'previous-process-unaccounted',
  [RECORD_BUSY_TEXT['held-by-other-process']]: 'held-by-other-process',
  [RECORD_BUSY_TEXT['run-record-unavailable']]: 'run-record-unavailable',
});
const busyReasonOf = (reason: string | null): BusyReason => {
  const why = reason === null ? null : /^busy: (.+) \([^()]*\)$/.exec(reason)?.[1];
  return why !== undefined && why !== null && Object.hasOwn(BUSY_BY_WHY, why) ? BUSY_BY_WHY[why]! : 'other';
};

/** A refusal before any run: no run id, no operations, always incomplete. */
function preRun(viewer: Viewer, kind: 'invalid-request' | 'stale-revision' | 'unavailable' | 'busy', diagnostics: readonly DiagnosticInput[] = []): Answered {
  const result = makeExecuteResult(viewer.validators, { runId: null, status: 'error', error: { kind }, operations: [], diagnostics });
  return answer(viewer, result);
}

/** The agent view of a checked result (contract v4). `isError` is the full result's status, as before. */
function answer(viewer: Viewer, result: ExecuteResult): Answered {
  const text = renderAgentView(viewer.validators, result, viewer.isRead);
  return { call: { content: [{ type: 'text', text }], ...(result.status === 'completed' ? {} : { isError: true }) }, full: result };
}

const failed = (): Answered => ({ call: fixed(FAILED_TEXT), full: null });

const GUEST_ERROR: Readonly<Record<string, ExecuteErrorKind>> = Object.freeze({
  syntax: 'syntax', runtime: 'runtime', deadlock: 'runtime', interrupted: 'timeout', 'wall-time': 'timeout', result: 'invalid-output', 'result-size': 'invalid-output', memory: 'quota', protocol: 'helper-failure',
});

/** Why a run did not complete, in contract terms. Only the helper's typed status and the guest's typed error kind are read, never text. */
function errorKindOf(r: BrokerRunResult): ExecuteErrorKind {
  switch (r.status) {
    case 'cancelled': return 'cancelled';
    case 'wall-time': return 'timeout';
    case 'quota': return 'quota';
    case 'violation': case 'crashed': return 'helper-failure';
    case 'policy': case 'unavailable': case 'busy': return 'unavailable';
    case 'finished': {
      // A call with no outcome comes first: the script may have thrown or finished, but that call may have run, so no kind may
      // imply that what happened is known. (A top-level abort, wall or quota keeps its own kind above.)
      if (r.evidence.some((op) => op.outcome === 'draining' || op.outcome === 'unknown')) return 'unsettled';
      // A call the host could not route (404 on the only attempt, spec §5.2): the host path is unavailable, nothing was dispatched. It comes
      // before the script's own error, which is only the guest seeing that refusal.
      if ((r.ledger?.entries ?? []).some((e) => e.refusal === 'host-unavailable')) return 'unavailable';
      if (r.outcome !== null && !r.outcome.ok) return GUEST_ERROR[r.outcome.error?.kind ?? ''] ?? 'helper-failure';
      if (r.outcome !== null && r.outcome.ok && r.runStatus === 'error') return 'invalid-output';
      // An unconfirmed cleanup, and any finished run no rule maps, fail closed: never read as a cancellation.
      return 'helper-failure';
    }
  }
}

const REFUSAL_LIMIT: Readonly<Record<string, string>> = Object.freeze({
  'response-budget-exhausted': 'response-bytes', 'unsettled-capacity': 'in-flight', 'call-budget': 'operations', 'arguments-too-large': 'argument-bytes', 'in-flight': 'in-flight',
});

/** Diagnostics only from typed evidence. The ledger keeps no keyword or JSON code for refused arguments, so none is emitted. */
function diagnosticsOf(r: BrokerRunResult): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const limits = new Set<string>();
  const limit = (name: string): void => { if (!limits.has(name)) { limits.add(name); out.push({ code: 'limit-reached', params: { limit: name } }); } };
  for (const entry of r.ledger?.entries ?? []) {
    const op = r.evidence.find((o) => o.ordinal === entry.ordinal);
    if (op?.method != null && entry.state === 'failed') out.push({ code: 'call-failed', params: { ordinal: op.ordinal, method: op.method } });
    else if (op?.method != null && (entry.state === 'dispatched' || entry.state === 'draining' || entry.state === 'unknown')) out.push({ code: 'call-unsettled', params: { ordinal: op.ordinal, method: op.method } });
    const named = entry.refusal === null ? undefined : REFUSAL_LIMIT[entry.refusal];
    if (named !== undefined) limit(named);
    // A read dropped because the run's response budget cut it: only the transport's typed evidence says so. An `unread` for any other
    // cause (the per-call ceiling, an unreadable body) names nothing.
    if (entry.state === 'unread' && entry.runBudgetCut) limit('response-bytes');
  }
  // Calls that never became an operation have no row to say so: the guest refused them (an unknown method, arguments that are not JSON), or they
  // were still queued in it when the run ended. Counted from typed evidence only.
  const made = new Set((r.ledger?.entries ?? []).map((e) => e.rid));
  const notStarted = (r.outcome?.unsettled ?? []).filter((rid) => !made.has(rid)).length;
  if ((r.outcome?.refused.notSerializable ?? 0) > 0) out.push({ code: 'calls-not-made', params: { cause: 'refused-in-script', count: r.outcome!.refused.notSerializable } });
  if (notStarted > 0) out.push({ code: 'calls-not-made', params: { cause: 'not-started', count: notStarted } });
  // What the guest refused on its own has no operation: the limit is all that can be said about it (T7a-guest-floor).
  const refused = r.outcome?.refused;
  if (refused !== undefined) {
    if (refused.operations > 0) limit('operations');
    if (refused.argumentBytes > 0) limit('argument-bytes');
    if (refused.responseBytes > 0) limit('response-bytes');
    if (refused.notParsed > 0) limit('memory');
  }
  if (r.status === 'wall-time') limit('wall-time');
  // A final value over the result budget: the guest names it with its own typed kind (it never sends the value), and a value that
  // reached the parent is named only when it is strict JSON, so an invalid value says nothing about size.
  if (r.outcome !== null && !r.outcome.ok && r.outcome.error?.kind === 'result-size') limit('result-bytes');
  if (overBudgetJson(r)) limit('result-bytes');
  // The guest's own CPU limit ends the script as `interrupted`: it is a time limit, and it names which.
  if (r.outcome !== null && !r.outcome.ok && r.outcome.error?.kind === 'interrupted') limit('active-time');
  return out;
}

/** The guest's final value arrived as JSON text over the contract's result budget and is otherwise strict JSON. */
function overBudgetJson(r: BrokerRunResult): boolean {
  const value = r.outcome !== null && r.outcome.ok ? r.outcome.value : undefined;
  if (typeof value !== 'string') return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= CONTRACT_LIMITS.resultBytes) return false;
  try { parseStrictJson(value, { ...RESULT_LIMITS, maxBytes: bytes }); return true; } catch { return false; }
}

function valueOf(r: BrokerRunResult): { ok: true; value: unknown } | { ok: false } {
  if (r.outcome === null || !r.outcome.ok || r.outcome.value === undefined) return { ok: false };
  try { return { ok: true, value: JSON.parse(r.outcome.value) as unknown }; } catch { return { ok: false }; }
}

/**
 * The diagnostics of a run that the contract can hold, for the attempt that has to leave out the ones it cannot (a count over the call ceiling): every
 * other one stays, and `diagnosticsOmitted` tells the agent something was withheld.
 */
function heldDiagnostics(r: BrokerRunResult, operations: BrokerRunResult['evidence']): { diagnostics: DiagnosticInput[]; diagnosticsOmitted: boolean } {
  const all = diagnosticsOf(r);
  const held = usableDiagnostics(all, operations);
  return { diagnostics: held, diagnosticsOmitted: held.length < all.length };
}

function toResult(viewer: Viewer, r: BrokerRunResult): Answered {
  const { validators } = viewer;
  if (r.status === 'busy') return preRun(viewer, 'busy', [{ code: 'busy', params: { reason: busyReasonOf(r.reason) } }]);
  // Nothing ran and there is no run to name (aborted or refused before the lease): the same shape as any refusal before a run.
  if (r.runId === null) return preRun(viewer, 'unavailable');
  const base = { runId: r.runId, incomplete: r.incomplete, operations: r.evidence };
  const completed = r.runStatus === 'completed' ? valueOf(r) : { ok: false as const };
  const attempts: Parameters<typeof makeExecuteResult>[1][] = [];
  if (r.runStatus === 'completed' && completed.ok) {
    attempts.push({ ...base, status: 'completed', value: completed.value, diagnostics: diagnosticsOf(r) });
    // a value over the result budget is not returned
    attempts.push({ ...base, status: 'error', error: { kind: 'invalid-output' }, diagnostics: diagnosticsOf(r) });
    // a diagnostic the contract cannot hold (a count over the call ceiling) must not turn the answer into a different failure, nor take the others with it:
    // the same error with every diagnostic that is valid on its own (a limit, a busy text)
    attempts.push({ ...base, status: 'error', error: { kind: 'invalid-output' }, ...heldDiagnostics(r, base.operations) });
  } else {
    const status = r.runStatus === 'partial-or-unknown' ? 'partial-or-unknown' : 'error';
    const kind = r.runStatus === 'completed' ? 'helper-failure' : errorKindOf(r);
    attempts.push({ ...base, status, error: { kind }, diagnostics: diagnosticsOf(r) });
    attempts.push({ ...base, status, error: { kind }, ...heldDiagnostics(r, base.operations) });
  }
  attempts.push({ ...base, status: 'error', error: { kind: 'helper-failure' } });
  for (const attempt of attempts) {
    // Every attempt keeps the run's own id and operations: only the last resort below has no receipt.
    try { return answer(viewer, makeExecuteResult(validators, attempt)); } catch (e) { if (!(e instanceof ContractError)) throw e; }
  }
  return failed();
}

async function execute(state: Resolved | null, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Answered> {
  if (state === null) return preRun(NO_VIEWER(), 'unavailable');
  const { broker } = state;
  // No broker, nothing is asked: the answer does not depend on the request.
  if (broker === null) return preRun(state, 'unavailable');
  let request: { code: string; apiRevision: string };
  try {
    request = admitExecute(args, state.revision);
  } catch (e) {
    return preRun(state, e instanceof ContractError && e.code === 'stale-revision' ? 'stale-revision' : 'invalid-request');
  }
  let ran: BrokerRunResult;
  try {
    ran = await broker.run(request.code, request.apiRevision, signal);
  } catch {
    return failed();
  }
  return toResult(state, ran);
}

// ----- The surface -----

export function createCodeModeSurface(options: CodeModeSurfaceOptions): CodeModeSurface {
  let memo: Promise<Resolved | null> | undefined;
  const resolved = (): Promise<Resolved | null> => {
    // The promise is the memo, set before anything awaits: two first calls at once share it. A `BackendRetry` clears it once settled, so
    // the next call tries again; every other failure stays.
    if (memo === undefined) {
      let transient = false;
      const attempt = (async () => {
        try { return resolveBackend(await options.backend()); } catch (e) { transient = e instanceof BackendRetry; return null; }
      })();
      memo = attempt;
      void attempt.then(() => { if (transient && memo === attempt) memo = undefined; });
    }
    return memo;
  };
  return Object.freeze({
    tools: TOOL_LIST,
    names: NAMES,
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
      if (!NAMES.has(name)) return fixed(UNKNOWN_TOOL_TEXT);
      try {
        const state = await resolved();
        if (name === 'code_execute') return (await execute(state, args, signal)).call;
        if (state === null) return fixed(UNAVAILABLE_TEXT);
        return name === 'code_search' ? search(state, args) : docs(state, args);
      } catch (e) {
        return refusal(e);
      }
    },
  });
}

// ----- The replacement launch -----

/** The same fixed line and exit code as a failed start (`server.ts`). The list request is still answered: this runs after the current turn. */
function exitAfterAnswer(error: CodeModeStartError): void {
  setTimeout(() => {
    process.stderr.write(`parley-mcp: ${error.message}\n`);
    process.exit(1);
  }, 50);
}

/**
 * A replacement session's surface (plan T7b, T12a): wrappers over the live backend. It has a broker only for a proven provider; PROVEN is
 * empty, so `code_execute` answers unavailable with zero dispatch. `registry` and `stop` are for fixtures; `server.ts` passes neither. The first partition
 * writes the exposure record; a write failure changes nothing about what is exposed.
 *
 * A list that fails the check ends the process once the client has its answer, exactly as at start: left alive, it would go on answering direct
 * calls by name on a surface nobody chose.
 */
export function replacementSurfaceFactory(context: McpContext, registry: MigrationRegistry = MIGRATION_REGISTRY, stop: (error: CodeModeStartError) => void = exitAfterAnswer): CodeModeSurfaceFactory {
  const launchId = randomUUID();
  const revision = registryRevision(registry);
  const { workDir, sessionId } = context;
  const record = (fields: Pick<Parameters<typeof writeExposureRecord>[2], 'effective' | 'reason' | 'migrated' | 'residual' | 'residualSchemaSha256'>): void => {
    if (sessionId !== null) writeExposureRecord(workDir, sessionId, { v: 1, ...fields, registryRevision: revision, launchId, nonce: context.codeModeLaunch ?? null });
  };
  return (listOriginal) => {
    const surface = createCodeModeSurface({
      backend: async () => {
        let original: Tool[];
        try { original = await listOriginal(); } catch { throw new BackendRetry(); }
        // The registry's proven methods are the enabled ones: only they get a guest stub (T11 B0). PROVEN is empty, so none does.
        return liveBackend(buildCatalog(original, { migrated: registry.proven }), launchId, context);
      },
    });
    let recorded = false;
    const proven = new Set(registry.proven);
    return Object.freeze({
      ...surface,
      isMigrated: (name: string): boolean => proven.has(name),
      directOf(original: readonly Tool[]): readonly Tool[] {
        const checked = checkReplacement(original.map((t) => t.name), registry);
        if (!checked.ok) {
          record({ effective: 'failed', reason: checked.problem, migrated: [], residual: [], residualSchemaSha256: null });
          const failure = new CodeModeStartError(checked.problem);
          stop(failure);
          throw failure;
        }
        const keep = new Set(checked.direct);
        const direct = original.filter((t) => keep.has(t.name));
        if (!recorded) {
          recorded = true;
          record({ effective: 'replacement', reason: null, migrated: checked.migrated, residual: checked.direct, residualSchemaSha256: canonicalSha256(direct) });
        }
        return direct;
      },
    });
  };
}
