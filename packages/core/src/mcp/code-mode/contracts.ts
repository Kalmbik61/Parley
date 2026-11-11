// Code Mode wrapper contracts (plan T3b): apiRevision, code_search/code_docs/code_execute requests, paged responses,
// the execute result with its per-operation evidence, and the per-call admission check. Contracts and validators only:
// no broker, no helper, no native policy, no registration. Every refusal here happens before anything is dispatched.
//
// Every protocol object is closed (unknown fields are refused) and is checked by the same strict path as tool arguments
// (validation.ts). Serializing or parsing never drops, defaults or repairs a status, error or completeness marker: a value
// that does not satisfy the invariants is refused instead.

import { type Catalog, canonicalSha256, sha256 } from './catalog.js';
import {
  type InputValidator,
  type JsonLimits,
  type JsonValue,
  ARG_LIMITS,
  RESULT_LIMITS,
  RUNTIME_DIALECT_VERSION,
  StrictJsonError,
  VALIDATOR_PIN,
  type ValidationIssue,
  canonicalStrict,
  compileInputValidator,
  freezeJson,
  serializeStrict,
} from './validation.js';

/**
 * Version 3 (T7a): a docs item says whether its output is `decoded`; a new `unsettled` error kind says a call has no outcome; `runId` is null for a refusal before any run started
 * (`invalid-request`, `stale-revision`, `unavailable`, `busy`); a new `busy` error kind names why an earlier run still holds
 * the session. Each is a published shape change, and the version is part of every apiRevision.
 *
 * Version 4: the MCP text of `code_execute` is the agent view (`renderAgentView`); the full `ExecuteResult` is the parent's record and is
 * unchanged. A published text shape change, so the version moves.
 */
export const CONTRACT_VERSION = 4;

export const CONTRACT_LIMITS = Object.freeze({
  codeBytes: 32 * 1024,
  queryChars: 256,
  searchLimitMax: 20,
  cursorChars: 512,
  docsNamesMax: 5,
  searchPageBytes: 8 * 1024,
  docsPageBytes: 16 * 1024,
  resultBytes: RESULT_LIMITS.maxBytes,
  diagnosticsBytes: 4 * 1024,
  diagnosticsMax: 16,
  diagnosticChars: 512,
  operationsMax: 32,
});

export type ContractErrorCode = 'invalid-request' | 'stale-revision' | 'invalid-cursor' | 'unknown-method' | 'invalid-arguments' | 'over-budget' | 'invalid-output';

/** A refusal. `issues` carry schema paths and keywords only; no message here ever contains a request value. */
export class ContractError extends Error {
  constructor(readonly code: ContractErrorCode, readonly issues: readonly ValidationIssue[] = [], readonly at = '') {
    super(`code mode contract: ${code}${at === '' ? '' : ` (${at})`}`);
    this.name = 'ContractError';
  }
}

// ----- apiRevision -----

const REVISION = /^cm1\.[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ApiRevisionInput {
  readonly catalog: Catalog;
  /** Opaque identity of the launch and its tool profile, supplied by the caller. */
  readonly launch: string;
  /** Opaque identity of the effective native-policy snapshot, or `unavailable`. */
  readonly policySnapshot: string;
}

/**
 * The identity of the API surface a script was written against: contract version, catalogue revision (schemas,
 * signatures, migration and fixture policy metadata), runtime validator and dialect, each method's output contract (schema
 * hash and adapter revision, or `unknown`), limits, launch identity and policy-snapshot identity. Equal revisions are NECESSARY for admission and never
 * SUFFICIENT: the revision grants no launch or native authority, and every call is still checked by the broker.
 */
export function computeApiRevision(input: ApiRevisionInput): string {
  for (const [field, v] of [['launch', input.launch], ['policySnapshot', input.policySnapshot]] as const) {
    if (typeof v !== 'string' || !IDENTITY.test(v)) throw new ContractError('invalid-request', [], field);
  }
  return `cm1.${canonicalSha256({
    contract: CONTRACT_VERSION,
    catalog: input.catalog.revision,
    validator: VALIDATOR_PIN,
    dialect: RUNTIME_DIALECT_VERSION,
    outputs: canonicalSha256(input.catalog.entries.map((e) => [e.name, e.output])),
    limits: CONTRACT_LIMITS,
    launch: input.launch,
    policySnapshot: input.policySnapshot,
  })}`;
}

/** Refuses a missing, malformed or different revision. Callers run it before anything is dispatched. */
export function assertFreshRevision(expected: unknown, current: string): void {
  if (typeof expected !== 'string' || !REVISION.test(expected)) throw new ContractError('invalid-request', [], 'apiRevision');
  if (expected !== current) throw new ContractError('stale-revision', [], 'apiRevision');
}

// ----- Protocol schemas (runtime dialect, all closed) -----

const S = (s: number) => ({ type: 'string', minLength: 1, maxLength: s });
const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const METHOD_NAME = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' };
const SHA = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const REVISION_S = { type: 'string', pattern: REVISION.source };
const ANY_JSON = { type: ['null', 'boolean', 'number', 'string', 'array', 'object'] };
const EFFECT = { type: 'string', enum: ['read', 'write', 'destructive', 'unknown'] };
const AVAILABILITY = { type: 'string', enum: ['executable', 'documented', 'unavailable'] };
const CURSOR_OR_NULL = { oneOf: [{ type: 'null' }, S(CONTRACT_LIMITS.cursorChars)] };

const PROTOCOL_LIMITS: JsonLimits = Object.freeze({ maxBytes: 64 * 1024, maxDepth: 8, maxNodes: 2_000 });
const RESULT_TEXT_LIMITS: JsonLimits = Object.freeze({ maxBytes: 64 * 1024, maxDepth: 40, maxNodes: 20_000 });

const OPERATION = closed({
  ordinal: { type: 'integer', minimum: 1, maximum: CONTRACT_LIMITS.operationsMax },
  method: { oneOf: [{ type: 'null' }, METHOD_NAME] },
  argsSha256: { oneOf: [{ type: 'null' }, SHA] },
  dispatched: { type: 'boolean' },
  outcome: { type: 'string', enum: ['refused', 'succeeded', 'failed', 'cancelled', 'unread', 'draining', 'unknown'] },
  responseBytes: { type: ['integer', 'null'], minimum: 0 },
  incomplete: { type: 'boolean' },
}, ['ordinal', 'method', 'argsSha256', 'dispatched', 'outcome', 'responseBytes', 'incomplete']);
const OPERATIONS = { type: 'array', maxItems: CONTRACT_LIMITS.operationsMax, items: OPERATION };
// Kept in sync with ERROR_MESSAGES / DIAGNOSTICS below (asserted in tests).
const ERROR_KINDS = ['invalid-request', 'stale-revision', 'unavailable', 'busy', 'unsettled', 'syntax', 'runtime', 'timeout', 'cancelled', 'quota', 'tool-error', 'invalid-output', 'helper-failure'];
const DIAGNOSTIC_CODES = ['invalid-arguments', 'non-json-arguments', 'unknown-method', 'call-failed', 'call-unsettled', 'calls-not-made', 'limit-reached', 'busy'];

/**
 * Why a session is still held by an earlier run. The first six are the lease's own (`SessionScheduler.acquire`), the next
 * three belong to the sleep and wake recovery (T7a-sleep), and `other` is any holder reason this version does not name. No run
 * id, process id or free text is part of a reason.
 */
export const BUSY_REASONS = ['a-run-is-active', 'previous-run-cleanup-unknown', 'previous-run-has-calls-with-unknown-outcome', 'previous-run-preflight-pending', 'previous-run-cleanup-pending', 'previous-run-draining', 'previous-process-unaccounted', 'held-by-other-process', 'run-record-unavailable', 'other'] as const;
export type BusyReason = (typeof BUSY_REASONS)[number];
const BUSY_TEXTS: Readonly<Record<BusyReason, string>> = Object.freeze({
  'a-run-is-active': 'A run is active in this session.',
  'previous-run-cleanup-unknown': 'The previous run\'s cleanup is unknown.',
  'previous-run-has-calls-with-unknown-outcome': 'The previous run has calls with an unknown outcome.',
  'previous-run-preflight-pending': 'The previous run\'s preflight is still pending.',
  'previous-run-cleanup-pending': 'The previous run\'s cleanup is pending.',
  'previous-run-draining': 'The previous run is still draining.',
  // The three record reasons end the session's use of code_execute for now: they say what remains, so the model stops retrying.
  'previous-process-unaccounted': 'A previous run in this session was not accounted for. code_execute stays unavailable here. Use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts.',
  'held-by-other-process': 'Another process holds this session; its run may still be finishing. code_execute stays unavailable here. Use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts.',
  'run-record-unavailable': 'The record of the earlier run is unavailable. code_execute stays unavailable here. Use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts.',
  other: 'The session is held for a reason this version does not name.',
});
/** Refusals that happen before any run exists; only these may have a null run id. */
const PRE_RUN_KINDS: readonly string[] = ['invalid-request', 'stale-revision', 'unavailable', 'busy'];
/** Refusals that always happen before the run: they never carry a run id. */
const NEVER_STARTED_KINDS: readonly string[] = ['invalid-request', 'stale-revision', 'busy'];

const SCHEMAS = {
  operation: OPERATION,
  operations: OPERATIONS,
  search: closed({ query: S(CONTRACT_LIMITS.queryChars), cursor: S(CONTRACT_LIMITS.cursorChars), limit: { type: 'integer', minimum: 1, maximum: CONTRACT_LIMITS.searchLimitMax } }, ['query']),
  docs: closed({ names: { type: 'array', items: METHOD_NAME, minItems: 1, maxItems: CONTRACT_LIMITS.docsNamesMax }, cursor: S(CONTRACT_LIMITS.cursorChars) }, ['names']),
  execute: closed({ code: { type: 'string', minLength: 1 }, apiRevision: REVISION_S }, ['code', 'apiRevision']),
  cursor: closed({ v: { type: 'integer', const: 1 }, r: REVISION_S, k: { type: 'string', enum: ['search', 'docs'] }, q: SHA, o: { type: 'integer', minimum: 0, maximum: 100_000 } }, ['v', 'r', 'k', 'q', 'o']),
  searchPage: closed({
    apiRevision: REVISION_S, kind: { type: 'string', const: 'search' },
    items: { type: 'array', items: closed({ name: METHOD_NAME, summary: { type: 'string', maxLength: 200 }, effect: EFFECT, availability: AVAILABILITY }, ['name', 'summary', 'effect', 'availability']) },
    complete: { type: 'boolean' }, nextCursor: CURSOR_OR_NULL,
  }, ['apiRevision', 'kind', 'items', 'complete', 'nextCursor']),
  docsPage: closed({
    apiRevision: REVISION_S, kind: { type: 'string', const: 'docs' },
    items: { type: 'array', items: closed({ name: METHOD_NAME, declaration: { type: 'string' }, effect: EFFECT, availability: AVAILABILITY, inputSchemaSha256: SHA, output: { type: 'string', enum: ['unknown', 'decoded'] } }, ['name', 'declaration', 'effect', 'availability', 'inputSchemaSha256', 'output']) },
    missing: { type: 'array', items: METHOD_NAME, maxItems: CONTRACT_LIMITS.docsNamesMax },
    complete: { type: 'boolean' }, nextCursor: CURSOR_OR_NULL,
  }, ['apiRevision', 'kind', 'items', 'missing', 'complete', 'nextCursor']),
  executeResult: closed({
    contract: { type: 'integer', const: CONTRACT_VERSION },
    apiRevision: REVISION_S,
    runId: { oneOf: [{ type: 'null' }, { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' }] },
    status: { type: 'string', enum: ['completed', 'error', 'partial-or-unknown'] },
    error: { oneOf: [{ type: 'null' }, closed({ kind: { type: 'string', enum: ERROR_KINDS }, message: { type: 'string', maxLength: CONTRACT_LIMITS.diagnosticChars } }, ['kind', 'message'])] },
    value: ANY_JSON,
    incomplete: { type: 'boolean' },
    diagnostics: { type: 'array', maxItems: CONTRACT_LIMITS.diagnosticsMax, items: closed({ code: { type: 'string', enum: DIAGNOSTIC_CODES }, params: { type: 'object' }, message: { type: 'string', maxLength: CONTRACT_LIMITS.diagnosticChars } }, ['code', 'params', 'message']) },
    diagnosticsTruncated: { type: 'boolean' },
    operations: OPERATIONS,
  }, ['contract', 'apiRevision', 'runId', 'status', 'error', 'value', 'incomplete', 'diagnostics', 'diagnosticsTruncated', 'operations']),
  // The agent's text (v4). Which optional field is present for which status is a cross-field rule (`agentViewProblem`), not a schema one.
  agentView: closed({
    status: { type: 'string', enum: ['completed', 'error', 'partial-or-unknown'] },
    incomplete: { type: 'boolean' },
    value: ANY_JSON,
    error: closed({ kind: { type: 'string', enum: ERROR_KINDS }, message: { type: 'string', maxLength: CONTRACT_LIMITS.diagnosticChars } }, ['kind', 'message']),
    runId: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
    operations: { type: 'array', minItems: 1, maxItems: CONTRACT_LIMITS.operationsMax, items: closed({
      ordinal: OPERATION.properties.ordinal, method: OPERATION.properties.method, dispatched: OPERATION.properties.dispatched,
      outcome: OPERATION.properties.outcome, incomplete: OPERATION.properties.incomplete,
    }, ['ordinal', 'method', 'dispatched', 'outcome', 'incomplete']) },
    diagnostics: { type: 'array', minItems: 1, maxItems: CONTRACT_LIMITS.diagnosticsMax, items: closed({ code: { type: 'string', enum: DIAGNOSTIC_CODES }, params: { type: 'object' }, message: { type: 'string', maxLength: CONTRACT_LIMITS.diagnosticChars } }, ['code', 'params', 'message']) },
    diagnosticsTruncated: { type: 'boolean', const: true },
  }, ['status', 'incomplete']),
} as const;

/** The closed schemas of the three requests: the MCP descriptors of the wrappers are made from these, so there is one source. */
export const REQUEST_SCHEMAS = Object.freeze({ search: SCHEMAS.search, docs: SCHEMAS.docs, execute: SCHEMAS.execute });

const strictSha256 = (value: unknown, limits: JsonLimits): string => sha256(canonicalStrict(value, limits));

const V = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, compileInputValidator(s, k === 'executeResult' || k === 'agentView' ? RESULT_TEXT_LIMITS : PROTOCOL_LIMITS)])) as Record<keyof typeof SCHEMAS, InputValidator>;

function checked<T>(validator: InputValidator, value: unknown, code: ContractErrorCode): T {
  const r = validator.validateValue(value);
  if (r.ok) return r.value as T;
  if (r.failure.kind === 'json') throw new ContractError(code, [], `${r.failure.code} at ${r.failure.at}`);
  throw new ContractError(code, r.failure.issues);
}

function checkedText<T>(validator: InputValidator, value: unknown, code: ContractErrorCode): { text: string; value: T } {
  const r = validator.validateValue(value);
  if (r.ok) return { text: r.text, value: r.value as T };
  if (r.failure.kind === 'json') throw new ContractError(code, [], `${r.failure.code} at ${r.failure.at}`);
  throw new ContractError(code, r.failure.issues);
}

function parsed<T>(validator: InputValidator, text: string, code: ContractErrorCode): T {
  const r = validator.validateText(text);
  if (r.ok) return r.value as T;
  if (r.failure.kind === 'json') throw new ContractError(code, [], `${r.failure.code} at ${r.failure.at}`);
  throw new ContractError(code, r.failure.issues);
}

// ----- Requests -----

export interface SearchRequest { readonly query: string; readonly cursor?: string; readonly limit?: number }
export interface DocsRequest { readonly names: readonly string[]; readonly cursor?: string }
export interface ExecuteRequest { readonly code: string; readonly apiRevision: string }

export const parseSearchRequest = (raw: unknown): SearchRequest => checked<SearchRequest>(V.search, raw, 'invalid-request');

export function parseDocsRequest(raw: unknown): DocsRequest {
  const r = checked<DocsRequest>(V.docs, raw, 'invalid-request');
  if (new Set(r.names).size !== r.names.length) throw new ContractError('invalid-request', [{ schemaPath: '#/properties/names', keyword: 'uniqueItems' }]);
  return r;
}

/** Structure, then the UTF-8 size of the code, then freshness: a stale or invalid request is refused before any dispatch. */
export function admitExecute(raw: unknown, currentRevision: string): ExecuteRequest {
  const r = checked<ExecuteRequest>(V.execute, raw, 'invalid-request');
  if (Buffer.byteLength(r.code, 'utf8') > CONTRACT_LIMITS.codeBytes) throw new ContractError('over-budget', [{ schemaPath: '#/properties/code', keyword: 'maxBytes' }]);
  assertFreshRevision(r.apiRevision, currentRevision);
  return r;
}

// ----- Cursors -----

export type PageKind = 'search' | 'docs';

/** Hash of what a cursor continues: the page kind and the request without its cursor. */
export function requestKey(kind: 'search', request: SearchRequest): string;
export function requestKey(kind: 'docs', request: DocsRequest): string;
export function requestKey(kind: PageKind, request: SearchRequest | DocsRequest): string {
  const rest: Record<string, unknown> = { ...request };
  delete rest.cursor;
  return strictSha256({ kind, request: rest }, PROTOCOL_LIMITS);
}

/**
 * Opaque base64url cursor bound to the revision, the page kind and the request key. It is NOT signed: it indexes the
 * session's own public catalogue, so a forged offset can only select another page of data the caller may already see.
 */
export function encodeCursor(apiRevision: string, kind: PageKind, key: string, offset: number): string {
  const body = checked<JsonValue>(V.cursor, { v: 1, r: apiRevision, k: kind, q: key, o: offset }, 'invalid-cursor');
  return Buffer.from(serializeStrict(body, PROTOCOL_LIMITS), 'utf8').toString('base64url');
}

/** The offset a cursor continues from. Malformed, foreign-kind or foreign-request cursors are invalid; another revision is stale. */
export function decodeCursor(cursor: string, apiRevision: string, kind: PageKind, key: string): number {
  if (typeof cursor !== 'string' || cursor.length > CONTRACT_LIMITS.cursorChars || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ContractError('invalid-cursor');
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) throw new ContractError('invalid-cursor');
  const c = parsed<{ r: string; k: PageKind; q: string; o: number }>(V.cursor, text, 'invalid-cursor');
  if (c.r !== apiRevision) throw new ContractError('stale-revision', [], 'cursor');
  if (c.k !== kind || c.q !== key) throw new ContractError('invalid-cursor');
  return c.o;
}

// ----- Pages -----

export type Availability = 'executable' | 'documented' | 'unavailable';
export interface SearchItem { readonly name: string; readonly summary: string; readonly effect: string; readonly availability: Availability }
export interface DocsItem { readonly name: string; readonly declaration: string; readonly effect: string; readonly availability: Availability; readonly inputSchemaSha256: string; readonly output: 'unknown' | 'decoded' }
export interface SearchPage { readonly apiRevision: string; readonly kind: 'search'; readonly items: readonly SearchItem[]; readonly complete: boolean; readonly nextCursor: string | null }
export interface DocsPage { readonly apiRevision: string; readonly kind: 'docs'; readonly items: readonly DocsItem[]; readonly missing: readonly string[]; readonly complete: boolean; readonly nextCursor: string | null }
export type Page = SearchPage | DocsPage;

const pageBudget = (kind: PageKind): number => (kind === 'search' ? CONTRACT_LIMITS.searchPageBytes : CONTRACT_LIMITS.docsPageBytes);

/** Closed shape, `complete` iff `nextCursor === null`, and the kind's byte budget. Returns the serialized text. */
export function serializePage(page: Page): string {
  const kind = (page as { kind?: unknown }).kind;
  if (kind !== 'search' && kind !== 'docs') throw new ContractError('invalid-output', [], 'kind');
  const { text, value } = checkedText<Page>(kind === 'search' ? V.searchPage : V.docsPage, page, 'invalid-output');
  if (value.complete !== (value.nextCursor === null)) throw new ContractError('invalid-output', [], 'complete/nextCursor');
  if (Buffer.byteLength(text, 'utf8') > pageBudget(kind)) throw new ContractError('over-budget', [], `${kind} page`);
  return text;
}

/** The same checks on text received over IPC. */
export function parsePage(text: string, kind: PageKind): Page {
  if (Buffer.byteLength(text, 'utf8') > pageBudget(kind)) throw new ContractError('over-budget', [], `${kind} page`);
  const page = parsed<Page>(kind === 'search' ? V.searchPage : V.docsPage, text, 'invalid-output');
  if (page.complete !== (page.nextCursor === null)) throw new ContractError('invalid-output', [], 'complete/nextCursor');
  return page;
}

/**
 * The largest page of `items` from `offset` that fits the kind's budget, with an explicit continuation. An item that
 * cannot fit even alone is refused rather than dropped, so no page can silently lose an item.
 */
export function buildPage(kind: 'search', apiRevision: string, key: string, items: readonly SearchItem[], offset: number, limit?: number): SearchPage;
export function buildPage(kind: 'docs', apiRevision: string, key: string, items: readonly DocsItem[], offset: number, limit?: number, missing?: readonly string[]): DocsPage;
export function buildPage(kind: PageKind, apiRevision: string, key: string, items: readonly (SearchItem | DocsItem)[], offset: number, limit = Number.MAX_SAFE_INTEGER, missing: readonly string[] = []): Page {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new ContractError('invalid-cursor', [], 'offset');
  const make = (n: number): Page => {
    const end = offset + n;
    const complete = end >= items.length;
    const base = { apiRevision, items: items.slice(offset, end), complete, nextCursor: complete ? null : encodeCursor(apiRevision, kind, key, end) };
    return (kind === 'search' ? { ...base, kind } : { ...base, kind, missing: [...missing] }) as Page;
  };
  const fits = (p: Page): boolean => {
    try { serializePage(p); return true; } catch (e) { if (e instanceof ContractError && e.code === 'over-budget') return false; throw e; }
  };
  let n = Math.min(limit, items.length - offset);
  while (n > 0 && !fits(make(n))) n--;
  if (n === 0 && offset < items.length) throw new ContractError('over-budget', [], `${kind} item ${offset}`);
  // The returned page is parsed from its own checked text: frozen, and sharing nothing with the caller's items.
  return parsePage(serializePage(make(n)), kind);
}

// ----- Execute result and per-operation evidence -----

/**
 * `completed`: the script returned and every started call settled. It does NOT mean every call succeeded: a call the
 * script caught keeps its own `failed`/`cancelled`/`refused` outcome in `operations`, and integrations must read those.
 */
export type ExecuteStatus = 'completed' | 'error' | 'partial-or-unknown';
export type OperationOutcome = 'refused' | 'succeeded' | 'failed' | 'cancelled' | 'unread' | 'draining' | 'unknown';

/**
 * Host-owned error texts. A result's error carries a kind and exactly this text: no free text from a guest, a tool, a
 * provider or the host's own exceptions can enter it, so it cannot carry credentials or argument values.
 */
export const ERROR_MESSAGES = Object.freeze({
  'invalid-request': 'The execute request was refused before the run started.',
  'stale-revision': 'The apiRevision is not the current one; read code_search/code_docs again.',
  unavailable: 'Code execution is not available for this session.',
  busy: 'Code execution is busy: an earlier run still holds this session.',
  unsettled: 'A call\'s outcome is unknown.',
  syntax: 'The script could not be compiled.',
  runtime: 'The script threw an error.',
  timeout: 'The run reached its time limit.',
  cancelled: 'The run was cancelled.',
  quota: 'The run reached a resource limit.',
  'tool-error': 'A called method returned an error.',
  'invalid-output': 'The final value is not bounded strict JSON.',
  'helper-failure': 'The sandbox helper failed.',
} as const);
export type ExecuteErrorKind = keyof typeof ERROR_MESSAGES;

/** Limits a `limit-reached` diagnostic may name. */
export const LIMIT_NAMES = ['code-bytes', 'argument-bytes', 'response-bytes', 'result-bytes', 'operations', 'in-flight', 'active-time', 'wall-time', 'memory'] as const;
const KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'maxBytes'];
const JSON_CODES = ['not-json', 'cycle', 'depth', 'nodes', 'bytes', 'number', 'string', 'key', 'syntax', 'duplicate-key'];

const ORDINAL = { type: 'integer', minimum: 1, maximum: CONTRACT_LIMITS.operationsMax };

/**
 * Host-owned diagnostic templates. A diagnostic is a code plus validated metadata; its message is rendered here and
 * re-rendered on parse, so no caller-supplied text exists in this channel. A `method`/`ordinal` pair must match the run's
 * own operation evidence. Raw guest output and raw tool/provider errors are NOT part of this contract: they belong to a
 * separate, opt-in, default-off data/log channel (T4b), never to these diagnostics.
 */
export const CALLS_NOT_MADE_CAUSES = ['refused-in-script', 'not-started'] as const;
const DIAGNOSTICS = {
  'invalid-arguments': {
    // No schema path: property names in a path cannot be tied to evidence here, so only the keyword is reported.
    params: closed({ ordinal: ORDINAL, method: METHOD_NAME, keyword: { type: 'string', enum: KEYWORDS } }, ['ordinal', 'method', 'keyword']),
    render: (p: Record<string, JsonValue>) => `call ${p.ordinal} (${p.method}): arguments fail "${p.keyword}"`,
  },
  'non-json-arguments': {
    params: closed({ ordinal: ORDINAL, method: METHOD_NAME, jsonCode: { type: 'string', enum: JSON_CODES } }, ['ordinal', 'method', 'jsonCode']),
    render: (p: Record<string, JsonValue>) => `call ${p.ordinal} (${p.method}): arguments are not strict JSON (${p.jsonCode})`,
  },
  'unknown-method': {
    params: closed({ ordinal: ORDINAL }, ['ordinal']),
    render: (p: Record<string, JsonValue>) => `call ${p.ordinal}: no such method in this API revision`,
  },
  'call-failed': {
    params: closed({ ordinal: ORDINAL, method: METHOD_NAME }, ['ordinal', 'method']),
    render: (p: Record<string, JsonValue>) => `call ${p.ordinal} (${p.method}) returned an error`,
  },
  'call-unsettled': {
    params: closed({ ordinal: ORDINAL, method: METHOD_NAME }, ['ordinal', 'method']),
    render: (p: Record<string, JsonValue>) => `call ${p.ordinal} (${p.method}) has no settled outcome`,
  },
  // Calls the script made that never became an operation, so no operation row can say so (v4): the guest refused them itself, or they were still queued in it.
  'calls-not-made': {
    params: closed({ cause: { type: 'string', enum: [...CALLS_NOT_MADE_CAUSES] }, count: { type: 'integer', minimum: 1, maximum: CONTRACT_LIMITS.operationsMax } }, ['cause', 'count']),
    render: (p: Record<string, JsonValue>) => (p.cause === 'refused-in-script'
      ? `${p.count} call(s) refused inside the script: unknown method or arguments not JSON`
      : `${p.count} call(s) started by the script never left it`),
  },
  'limit-reached': {
    params: closed({ limit: { type: 'string', enum: [...LIMIT_NAMES] } }, ['limit']),
    render: (p: Record<string, JsonValue>) => `limit reached: ${p.limit}`,
  },
  busy: {
    params: closed({ reason: { type: 'string', enum: [...BUSY_REASONS] } }, ['reason']),
    render: (p: Record<string, JsonValue>) => BUSY_TEXTS[p.reason as BusyReason],
  },
} as const;
export type DiagnosticCode = keyof typeof DIAGNOSTICS;
const DIAGNOSTIC_PARAMS = Object.fromEntries(Object.entries(DIAGNOSTICS).map(([k, d]) => [k, compileInputValidator(d.params, PROTOCOL_LIMITS)])) as Record<DiagnosticCode, InputValidator>;
if (Object.keys(ERROR_MESSAGES).sort().join() !== [...ERROR_KINDS].sort().join() || Object.keys(DIAGNOSTICS).sort().join() !== [...DIAGNOSTIC_CODES].sort().join()) {
  throw new Error('code mode contract: error kinds or diagnostic codes out of sync with the result schema');
}
const isDiagnosticCode = (c: unknown): c is DiagnosticCode => typeof c === 'string' && Object.hasOwn(DIAGNOSTICS, c);

/** Broker-owned record of one guest call; never derived from what the guest returns. */
export interface OperationEvidence {
  readonly ordinal: number;
  /**
   * A method of the run's own CallValidators handle (catalogue- and revision-bound), or null when the name was not one:
   * a guest-chosen name is never recorded. Checked against the handle when minted, made, serialized and parsed.
   */
  readonly method: string | null;
  /** Hash of the canonical strict JSON of the arguments; null when they were not strict JSON (nothing else recorded). */
  readonly argsSha256: string | null;
  readonly dispatched: boolean;
  readonly outcome: OperationOutcome;
  /** Response size once settled; null when nothing settled. */
  readonly responseBytes: number | null;
  /** The adapter observed or could not rule out incompleteness (page.next, complete:false, cut, unknown). */
  readonly incomplete: boolean;
}

export interface DiagnosticInput { readonly code: DiagnosticCode; readonly params: Readonly<Record<string, JsonValue>> }
export interface Diagnostic extends DiagnosticInput { readonly message: string }

export interface ExecuteResult {
  readonly contract: typeof CONTRACT_VERSION;
  readonly apiRevision: string;
  /** Null only for a refusal before any run started (`invalid-request`, `stale-revision`, `unavailable`, `busy`): no run, no operations. */
  readonly runId: string | null;
  readonly status: ExecuteStatus;
  readonly error: { readonly kind: ExecuteErrorKind; readonly message: string } | null;
  /** The guest's final value; null unless completed. */
  readonly value: JsonValue;
  readonly incomplete: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** True when any diagnostic was dropped for the entry or byte budget. Diagnostics are never shortened. */
  readonly diagnosticsTruncated: boolean;
  readonly operations: readonly OperationEvidence[];
}

const UNSETTLED: ReadonlySet<OperationOutcome> = new Set(['draining', 'unknown']);

/** Cross-field rules that the closed schema cannot express. Returns the first broken rule, or null. */
function resultProblem(r: ExecuteResult): string | null {
  for (let i = 0; i < r.operations.length; i++) {
    const op = r.operations[i]!;
    if (op.ordinal !== i + 1) return `operations[${i}].ordinal`;
    if (op.dispatched !== (op.outcome !== 'refused')) return `operations[${i}].dispatched`;
    if (op.dispatched && op.method === null) return `operations[${i}].method`;
    if ((op.responseBytes !== null) !== (op.outcome === 'succeeded' || op.outcome === 'failed' || op.outcome === 'unread')) return `operations[${i}].responseBytes`;
    if ((UNSETTLED.has(op.outcome) || op.outcome === 'unread') && !op.incomplete) return `operations[${i}].incomplete`;
  }
  const unsettled = r.operations.some((op) => UNSETTLED.has(op.outcome));
  if (r.status === 'completed' && (r.error !== null || unsettled)) return 'status';
  if (r.status === 'error' && (r.error === null || unsettled)) return 'status';
  if (r.status === 'partial-or-unknown' && r.error === null) return 'error';
  if (r.error !== null && r.error.message !== ERROR_MESSAGES[r.error.kind]) return 'error.message';
  // `unsettled` names a call that has no outcome: it needs one, and nothing else may be called that.
  if (r.error?.kind === 'unsettled' && !unsettled) return 'error.unsettled';
  if (r.status !== 'completed' && r.value !== null) return 'value';
  const floor = r.status !== 'completed' || r.operations.some((op) => op.incomplete);
  if (floor && !r.incomplete) return 'incomplete';
  // A null run id is the refusal before any run; the refusals that never start one cannot carry an id.
  if (r.runId === null) {
    if (r.status !== 'error' || r.error === null || !PRE_RUN_KINDS.includes(r.error.kind) || r.operations.length > 0) return 'runId';
  } else if (r.error !== null && NEVER_STARTED_KINDS.includes(r.error.kind)) return 'runId';
  // The busy kind and its one diagnostic go together; no other result carries a busy diagnostic.
  const busy = r.diagnostics.filter((d) => d.code === 'busy').length;
  if (busy !== (r.error?.kind === 'busy' ? 1 : 0)) return 'diagnostics.busy';
  for (let i = 0; i < r.diagnostics.length; i++) {
    const why = diagnosticProblem(r.diagnostics[i]!, r.operations);
    if (why !== null) return `diagnostics[${i}].${why}`;
  }
  if (Buffer.byteLength(serializeStrict(r.diagnostics, PROTOCOL_LIMITS), 'utf8') > CONTRACT_LIMITS.diagnosticsBytes) return 'diagnostics';
  return null;
}

/** A diagnostic is valid only with its code's exact metadata, the host rendering, and evidence that backs it. */
function diagnosticProblem(d: { code: unknown; params: unknown; message?: unknown }, operations: readonly OperationEvidence[]): string | null {
  if (!isDiagnosticCode(d.code)) return 'code';
  const r = DIAGNOSTIC_PARAMS[d.code].validateValue(d.params);
  if (!r.ok) return 'params';
  const p = r.value as Record<string, JsonValue>;
  if (d.message !== undefined && d.message !== DIAGNOSTICS[d.code].render(p)) return 'message';
  if (typeof p.ordinal === 'number') {
    const op = operations[p.ordinal - 1];
    if (op === undefined) return 'ordinal';
    if ((p.method ?? null) !== op.method) return 'method';
  }
  return null;
}

/**
 * The diagnostics the contract can hold for these operations: each one that is valid on its own, in order. A caller that has to build an answer
 * without the diagnostics that cannot be held (a count over the call ceiling) keeps every other one, so a limit or a busy text still reaches the agent.
 */
export function usableDiagnostics(diagnostics: readonly DiagnosticInput[], operations: readonly OperationEvidence[]): DiagnosticInput[] {
  return diagnostics.filter((d) => typeof d === 'object' && d !== null && Object.keys(d).sort().join() === 'code,params' && diagnosticProblem(d, operations) === null);
}

export interface ExecuteResultInput {
  readonly runId: string | null;
  readonly status: ExecuteStatus;
  readonly error?: { readonly kind: ExecuteErrorKind } | null;
  readonly value?: unknown;
  /** A claim that can only raise `incomplete`; the evidence and the status set its floor. */
  readonly incomplete?: boolean;
  readonly diagnostics?: readonly DiagnosticInput[];
  /** The caller left some diagnostics out because they could not be held (`usableDiagnostics`): the result says so with `diagnosticsTruncated`. */
  readonly diagnosticsOmitted?: boolean;
  readonly operations: readonly OperationEvidence[];
}

/**
 * Assembles a deeply frozen result from the strict text of its own fields. The error text and every diagnostic message
 * are rendered from host templates; an input carrying any other text, an unknown code, metadata outside its schema, or
 * a `method`/`ordinal` not backed by the evidence is refused. Diagnostics beyond 16 entries or 4 KiB are dropped with
 * `diagnosticsTruncated: true`; nothing is shortened. `incomplete` is never lower than the status and evidence imply.
 * A final value that is not bounded strict JSON is refused rather than replaced.
 */
export function makeExecuteResult(validators: CallValidators, input: ExecuteResultInput): ExecuteResult {
  const byName = handleMap(validators, 'invalid-output');
  const operations = checked<OperationEvidence[]>(V.operations, input.operations, 'invalid-output');
  if (input.error != null && (typeof input.error !== 'object' || Object.keys(input.error).join() !== 'kind' || !Object.hasOwn(ERROR_MESSAGES, input.error.kind))) {
    throw new ContractError('invalid-output', [], 'error');
  }
  const diagnostics: Diagnostic[] = [];
  let truncated = false;
  for (const raw of input.diagnostics ?? []) {
    if (typeof raw !== 'object' || raw === null || Object.keys(raw).sort().join() !== 'code,params') throw new ContractError('invalid-output', [], 'diagnostic fields');
    // Evidence provenance is checked on the whole result below; a diagnostic is only as good as the evidence it cites.
    const why = diagnosticProblem(raw, operations);
    if (why !== null) throw new ContractError('invalid-output', [], `diagnostic ${why}`);
    const params = DIAGNOSTIC_PARAMS[raw.code].validateValue(raw.params);
    const value = (params as { value: Record<string, JsonValue> }).value;
    const next = { code: raw.code, params: value, message: DIAGNOSTICS[raw.code].render(value) };
    if (diagnostics.length >= CONTRACT_LIMITS.diagnosticsMax || Buffer.byteLength(serializeStrict([...diagnostics, next], PROTOCOL_LIMITS), 'utf8') > CONTRACT_LIMITS.diagnosticsBytes) { truncated = true; break; }
    diagnostics.push(next);
  }
  let value: JsonValue;
  try { value = freezeJson(input.value === undefined ? null : input.value, RESULT_LIMITS).value; } catch (e) {
    if (e instanceof StrictJsonError) throw new ContractError(e.code === 'bytes' || e.code === 'nodes' || e.code === 'depth' ? 'over-budget' : 'invalid-output', [], `value: ${e.code}`);
    throw e;
  }
  const status = input.status;
  const floor = status !== 'completed' || operations.some((op) => op.incomplete);
  const draft = {
    contract: CONTRACT_VERSION,
    apiRevision: validators.apiRevision,
    runId: input.runId,
    status,
    error: input.error == null ? null : { kind: input.error.kind, message: ERROR_MESSAGES[input.error.kind] },
    value,
    incomplete: floor || input.incomplete === true,
    diagnostics,
    diagnosticsTruncated: truncated || input.diagnosticsOmitted === true,
    operations,
  };
  const result = checked<ExecuteResult>(V.executeResult, draft, 'invalid-output');
  const problem = resultProblem(result) ?? provenanceProblem(result, validators, byName);
  if (problem !== null) throw new ContractError('invalid-output', [], problem);
  return result;
}

/** The result belongs to this handle's revision, and every recorded method is one of this handle's methods. */
function provenanceProblem(r: ExecuteResult, validators: CallValidators, byName: ReadonlyMap<string, InputValidator>): string | null {
  if (r.apiRevision !== validators.apiRevision) return 'apiRevision';
  const i = r.operations.findIndex((op) => op.method !== null && !byName.has(op.method));
  return i < 0 ? null : `operations[${i}].method`;
}

/** Text for IPC/MCP. Rechecks shape, invariants and provenance against the handle; the value keeps its 16 KiB budget. */
export function serializeExecuteResult(validators: CallValidators, result: ExecuteResult): string {
  const byName = handleMap(validators, 'invalid-output');
  const r = checkedText<ExecuteResult>(V.executeResult, result, 'invalid-output');
  const problem = resultProblem(r.value) ?? provenanceProblem(r.value, validators, byName);
  if (problem !== null) throw new ContractError('invalid-output', [], problem);
  try { serializeStrict(r.value.value, RESULT_LIMITS); } catch { throw new ContractError('over-budget', [], 'value'); }
  return r.text;
}

/**
 * Strict parse of a received result against the receiver's own handle: any missing, extra or contradictory
 * status/error/completeness field, another revision, or a method that is not one of the handle's is refused.
 */
export function parseExecuteResult(validators: CallValidators, text: string): ExecuteResult {
  const byName = handleMap(validators, 'invalid-output');
  const result = parsed<ExecuteResult>(V.executeResult, text, 'invalid-output');
  const problem = resultProblem(result) ?? provenanceProblem(result, validators, byName);
  if (problem !== null) throw new ContractError('invalid-output', [], problem);
  try { serializeStrict(result.value, RESULT_LIMITS); } catch { throw new ContractError('over-budget', [], 'value'); }
  return result;
}

// ----- The agent view (v4) -----

/** One operation as the agent sees it: the evidence without its hashes and sizes. */
export interface AgentViewOperation { readonly ordinal: number; readonly method: string | null; readonly dispatched: boolean; readonly outcome: OperationOutcome; readonly incomplete: boolean }

/** What `code_execute` sends to the agent. Present or absent, every field is decided by the result's status (`agentViewProblem`). */
export interface AgentView {
  readonly status: ExecuteStatus;
  readonly incomplete: boolean;
  readonly value?: JsonValue;
  readonly error?: { readonly kind: ExecuteErrorKind; readonly message: string };
  readonly runId?: string;
  readonly operations?: readonly AgentViewOperation[];
  readonly diagnostics?: readonly Diagnostic[];
  readonly diagnosticsTruncated?: true;
}

/** A clean read: nothing in it can change what the agent does, so a completed view leaves its row out. */
const cleanRead = (op: OperationEvidence, isRead: (method: string) => boolean): boolean =>
  op.method !== null && isRead(op.method) && op.outcome === 'succeeded' && !op.incomplete;

const rowOf = (op: OperationEvidence): AgentViewOperation => ({ ordinal: op.ordinal, method: op.method, dispatched: op.dispatched, outcome: op.outcome, incomplete: op.incomplete });

/**
 * A row explains an `incomplete` claim when it is not a clean success. Only a completed run needs it: any other status carries
 * its error and every row.
 */
const explainsIncomplete = (op: AgentViewOperation): boolean => op.outcome !== 'succeeded' || op.incomplete;

/** Which operations the view lists. Everything but a clean read on a completed run; every row when nothing else says why a completed run is incomplete. */
function viewRows(full: ExecuteResult, isRead: (method: string) => boolean): readonly OperationEvidence[] {
  if (full.status !== 'completed') return full.operations;
  const shown = full.operations.filter((op) => !cleanRead(op, isRead));
  const unexplained = full.incomplete && full.diagnostics.length === 0 && !shown.some((op) => explainsIncomplete(rowOf(op)));
  return unexplained ? full.operations : shown;
}

const same = (a: unknown, b: unknown): boolean => serializeStrict(a, RESULT_TEXT_LIMITS) === serializeStrict(b, RESULT_TEXT_LIMITS);

/**
 * The cross-field rules between an agent view and the full result it was made from. Returns the first broken rule, or null.
 * A view may say less than the result, never something else: status, completeness, error, run id, every diagnostic (so every limit),
 * and every operation that is not a clean read are all there and equal; a completed run's `incomplete` is never left without a reason.
 */
export function agentViewProblem(view: AgentView, full: ExecuteResult, isRead: (method: string) => boolean): string | null {
  if (view.status !== full.status) return 'status';
  if (view.incomplete !== full.incomplete) return 'incomplete';
  if (full.status === 'completed') {
    if (view.error !== undefined || view.runId !== undefined) return 'completed carries an error or run id';
    if (view.value === undefined || !same(view.value, full.value)) return 'value';
  } else {
    if (view.value !== undefined) return 'value on a non-completed view';
    if (view.error === undefined || !same(view.error, full.error)) return 'error';
    if (full.runId === null ? view.runId !== undefined : view.runId !== full.runId) return 'runId';
  }
  const expected = viewRows(full, isRead).map(rowOf);
  // A completed run that is incomplete must say why: a row, or a diagnostic. (A third, unnamed cause is refused here, not shown as a bare claim.)
  if (full.status === 'completed' && full.incomplete && expected.length === 0 && full.diagnostics.length === 0) return 'incomplete without a reason';
  if (expected.length === 0 ? view.operations !== undefined : view.operations === undefined || !same(view.operations, expected)) return 'operations';
  if (full.diagnostics.length === 0 ? view.diagnostics !== undefined : view.diagnostics === undefined || !same(view.diagnostics, full.diagnostics)) return 'diagnostics';
  const limits = (ds: readonly Diagnostic[] | undefined): string => (ds ?? []).filter((d) => d.code === 'limit-reached').map((d) => String(d.params.limit)).sort().join();
  if (limits(view.diagnostics) !== limits(full.diagnostics)) return 'limits';
  if (full.diagnosticsTruncated ? view.diagnosticsTruncated !== true : view.diagnosticsTruncated !== undefined) return 'diagnosticsTruncated';
  return null;
}

/**
 * The text `code_execute` sends. The full result is checked first by `serializeExecuteResult` (the closed schema, the invariants, provenance
 * against the handle, the value budget) and the view is made from that checked text; the view is then checked against its own schema and
 * against the full result. Any problem refuses, so a caller falls to its error answer and never to a success. `isRead` is the catalogue
 * of the run that produced `result`: a method it does not call a read is listed like a write.
 */
export function renderAgentView(validators: CallValidators, result: ExecuteResult, isRead: (method: string) => boolean): string {
  const full = parseExecuteResult(validators, serializeExecuteResult(validators, result));
  const rows = viewRows(full, isRead).map(rowOf);
  const draft: Record<string, unknown> = { status: full.status, incomplete: full.incomplete };
  if (full.status === 'completed') draft.value = full.value;
  else {
    draft.error = full.error;
    if (full.runId !== null) draft.runId = full.runId;
  }
  if (rows.length > 0) draft.operations = rows;
  if (full.diagnostics.length > 0) draft.diagnostics = full.diagnostics;
  if (full.diagnosticsTruncated) draft.diagnosticsTruncated = true;
  const out = checkedText<AgentView>(V.agentView, draft, 'invalid-output');
  const problem = agentViewProblem(out.value, full, isRead);
  if (problem !== null) throw new ContractError('invalid-output', [], `agent view: ${problem}`);
  return out.text;
}

export type OperationEvidenceInput = Omit<OperationEvidence, 'argsSha256' | 'method'> & { readonly method: unknown; readonly args: unknown };

/**
 * Evidence for one call, minted against the run's handle and frozen. `method` is recorded only if it is one of the
 * handle's methods, otherwise null, so an unknown or forged name never enters the evidence (or, through it, a
 * diagnostic). The argument hash is over canonical strict JSON; null if the arguments were not strict JSON.
 */
export function operationEvidence(validators: CallValidators, e: OperationEvidenceInput): OperationEvidence {
  const byName = handleMap(validators, 'invalid-output');
  const { args, method, ...rest } = e;
  let argsSha256: string | null = null;
  try { argsSha256 = strictSha256(args, ARG_LIMITS); } catch (err) { if (!(err instanceof StrictJsonError)) throw err; }
  const known = typeof method === 'string' && byName.has(method) ? method : null;
  return checked<OperationEvidence>(V.operation, { ...rest, method: known, argsSha256 }, 'invalid-output');
}

// ----- Per-call admission -----

/**
 * An opaque, frozen handle. Its validators and membership live in module-private state keyed by the handle, so no
 * caller can add, replace, delete or clear a method under an unchanged apiRevision; a look-alike object is not a handle.
 */
export interface CallValidators {
  readonly apiRevision: string;
  /** Sorted documented method names (frozen). */
  readonly methods: readonly string[];
  schemaSha256Of(method: string): string | undefined;
}

const HANDLES = new WeakMap<CallValidators, ReadonlyMap<string, InputValidator>>();

function handleMap(validators: CallValidators, code: ContractErrorCode): ReadonlyMap<string, InputValidator> {
  const byName = HANDLES.get(validators);
  if (byName === undefined) throw new ContractError(code, [], 'validators');
  return byName;
}

/**
 * Runtime validators for the documented methods of a catalogue, compiled from each entry's frozen authoritative schema.
 * The schema hash must match the catalogue's, so the validator and the published declaration describe the same schema.
 */
export function compileCallValidators(catalog: Catalog, apiRevision: string): CallValidators {
  const byName = new Map<string, InputValidator>();
  for (const entry of catalog.entries) {
    if (!entry.documented) continue;
    const v = compileInputValidator(entry.inputSchema);
    if (v.schemaSha256 !== entry.schemaSha256) throw new ContractError('invalid-output', [], `${entry.name}: schema hash`);
    byName.set(entry.name, v);
  }
  const methods = Object.freeze([...byName.keys()].sort());
  const handle: CallValidators = Object.freeze({
    apiRevision,
    methods,
    schemaSha256Of: (method: string) => (typeof method === 'string' ? byName.get(method)?.schemaSha256 : undefined),
  });
  HANDLES.set(handle, byName);
  return handle;
}

/** What may be dispatched: the method, the exact validated text, and a frozen value parsed from that text. */
export interface AdmittedCall { readonly method: string; readonly argsText: string; readonly args: JsonValue }

/**
 * The check that precedes a dispatch: a genuine handle, fresh revision, a documented method (module-private Map, so
 * `constructor` or `__proto__` never resolve), and arguments that pass the authoritative schema. Dispatch `argsText`,
 * never the caller's object. Native policy, migration state and the original per-tool authority are the broker's later,
 * separate checks; passing here grants nothing.
 */
export function admitCall(validators: CallValidators, revision: string, method: unknown, args: unknown): AdmittedCall {
  const byName = handleMap(validators, 'invalid-request');
  assertFreshRevision(revision, validators.apiRevision);
  if (typeof method !== 'string' || !byName.has(method)) throw new ContractError('unknown-method');
  const r = byName.get(method)!.validateValue(args);
  if (!r.ok) {
    if (r.failure.kind === 'json') throw new ContractError('invalid-arguments', [], `${r.failure.code} at ${r.failure.at}`);
    throw new ContractError('invalid-arguments', r.failure.issues);
  }
  return Object.freeze({ method, argsText: r.text, args: r.value });
}
