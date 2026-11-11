// Code Mode read adapter for `search_history` (T11 R1). A standalone decoder in the style of read-adapters.ts, which exports the shared
// helpers for it; the broker reaches it through read-adapter-table.ts. It edits no handler. The handler is `memoryTool` in mcp/tools.ts
// over `searchHistory` in work/history-search.ts.
//
// There is one response form, in two shapes by `total`: no hit has a `message` (prose, only its presence is checked, never its text) and
// `total: 0` has one. The request is decoded only for what the response must echo (`query`, `scope`, `limit`); its word count, length and
// range checks stay with the handler, so the selector can never refuse a call the handler accepts.
//
// Completeness has two structured marks, and only they make a result `partial`: `unavailable` (a source that could not be read in full)
// and `total` above the hits returned (the limit cut). A hit's own `complete: false` says its excerpt is shortened; that is the shape of
// a search hit, it reaches the guest verbatim as typed data and is not an omission of the run (s-292, m-7572). A tool error keeps its
// whole original result and is `unknown` (decided by `run`).

import { StrictJsonError, parseStrictJson, type JsonValue } from '../validation.js';
import {
  Mismatch, TEXT_LIMITS, asArray, asBool, asCount, asObject, asString, asStringOrNull, echo, rest, run,
  type Decoded, type JsonObject, type Unmodeled,
} from '../read-adapters.js';

/** `SOURCES` and `HISTORY_SCOPES` of work/history-search.ts, in the handler's order; a test keeps the copies equal. */
export const HISTORY_SOURCE_VALUES: readonly string[] = Object.freeze(['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions']);
export const HISTORY_SCOPE_VALUES: readonly string[] = Object.freeze([...HISTORY_SOURCE_VALUES, 'all']);
/** `DEFAULT_SEARCH_LIMIT` of work/history-search.ts; a test keeps the copy equal. */
export const DEFAULT_HISTORY_LIMIT = 10;
const HIT_HASH = /^[0-9a-f]{16}$/;

type HistorySource = 'decisions' | 'memory' | 'plans' | 'backlog' | 'history' | 'sessions';
type HistoryScope = HistorySource | 'all';

export interface HistoryHitDto extends Unmodeled {
  readonly source: HistorySource;
  readonly title: string;
  readonly excerpt: string;
  readonly date: string | null;
  readonly file?: string;
  readonly line?: number;
  readonly id?: string;
  readonly workId?: string;
  readonly roomId?: string;
  readonly sessionId?: string;
  readonly state?: string;
  readonly shared?: true;
  readonly alsoShared?: true;
  /** The excerpt covers the whole entry. A per-hit fact, passed on verbatim; it never makes the result `partial`. */
  readonly complete: boolean;
  readonly length: number;
  readonly hash: string;
}

export interface SearchHistoryValue extends Unmodeled {
  readonly query: string;
  readonly scope: HistoryScope;
  readonly limit: number;
  /** How many entries matched; above `hits.length` the limit cut the list. */
  readonly total: number;
  readonly hits: readonly HistoryHitDto[];
  /** Names of sources that could not be read in full. Plain strings in the type: the output dialect has no union-valued array items; the decoder checks every name against the sources. */
  readonly unavailable: readonly string[];
  /** Present exactly when `total` is 0. */
  readonly message?: string;
}

export interface SearchHistoryRequest {
  readonly query: string;
  readonly scope: string;
  readonly limit: number;
}

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What the response must echo: `query` a string, `scope` absent or one of the seven scopes (default `all`), `limit` absent or a number
 * (default 10); no other key. Anything else has no success form (`null`). Never looks at a response.
 */
export function selectSearchHistoryRequest(args: unknown): SearchHistoryRequest | null {
  const given = args === undefined ? {} : args;
  if (!isRecord(given)) return null;
  if (Object.keys(given).some((key) => key !== 'query' && key !== 'scope' && key !== 'limit')) return null;
  const { query, scope = 'all', limit = DEFAULT_HISTORY_LIMIT } = given;
  if (typeof query !== 'string') return null;
  if (typeof scope !== 'string' || !HISTORY_SCOPE_VALUES.includes(scope)) return null;
  if (typeof limit !== 'number') return null;
  return { query, scope, limit };
}

function oneOf<T extends string>(v: unknown, values: readonly string[]): T {
  if (typeof v !== 'string' || !values.includes(v)) throw new Mismatch('shape-mismatch');
  return v as T;
}

function readTrue(v: unknown): true {
  if (v !== true) throw new Mismatch('shape-mismatch');
  return true;
}

function readHit(v: unknown): HistoryHitDto {
  const o = asObject(v);
  const optionalString = (key: string): { [k: string]: string } => (Object.hasOwn(o, key) ? { [key]: asString(o[key]) } : {});
  const optionalTrue = (key: string): { [k: string]: true } => (Object.hasOwn(o, key) ? { [key]: readTrue(o[key]) } : {});
  const hash = asString(o['hash']);
  if (!HIT_HASH.test(hash)) throw new Mismatch('shape-mismatch');
  return {
    source: oneOf<HistorySource>(o['source'], HISTORY_SOURCE_VALUES),
    title: asString(o['title']),
    excerpt: asString(o['excerpt']),
    date: asStringOrNull(o['date']),
    ...optionalString('file'),
    ...(Object.hasOwn(o, 'line') ? { line: asCount(o['line']) } : {}),
    ...optionalString('id'), ...optionalString('workId'), ...optionalString('roomId'), ...optionalString('sessionId'), ...optionalString('state'),
    ...optionalTrue('shared'), ...optionalTrue('alsoShared'),
    complete: asBool(o['complete']),
    length: asCount(o['length']),
    hash,
    unknownFields: rest(o, ['source', 'title', 'excerpt', 'date', 'file', 'line', 'id', 'workId', 'roomId', 'sessionId', 'state', 'shared', 'alsoShared', 'complete', 'length', 'hash']),
  } as HistoryHitDto;
}

/**
 * Decodes the result of one `search_history` call. `args` are the ORIGINAL request arguments; `mcpResult` is the strict MCP result the
 * broker settled. Pure.
 *
 * Checks beyond the shape, from the handler's own code: `query`, `scope` and `limit` equal the request (with the defaults);
 * `hits.length` is `min(total, limit)`; `message` is present exactly when `total` is 0; with a single scope every hit and every
 * unavailable source is that scope; `unavailable` is in source order without repeats.
 */
export function decodeSearchHistory(args: unknown, mcpResult: unknown): Decoded<SearchHistoryValue> {
  return run<SearchHistoryValue>(mcpResult, (text) => {
    const request = selectSearchHistoryRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    const top = asObject(parsed);
    const query = asString(top['query']);
    echo(query, request.query);
    const scope = oneOf<HistoryScope>(top['scope'], HISTORY_SCOPE_VALUES);
    echo(scope, request.scope);
    const limit = asCount(top['limit']);
    echo(limit, request.limit);
    const total = asCount(top['total']);
    const hits = asArray(top['hits']).map(readHit);
    const unavailable = asArray(top['unavailable']).map((s) => oneOf<HistorySource>(s, HISTORY_SOURCE_VALUES));
    const message = Object.hasOwn(top, 'message') ? asString(top['message']) : undefined;
    if (hits.length !== Math.min(total, limit)) throw new Mismatch('page-invariant');
    if ((message !== undefined) !== (total === 0)) throw new Mismatch('shape-mismatch');
    if (scope !== 'all' && (hits.some((hit) => hit.source !== scope) || unavailable.some((source) => source !== scope))) throw new Mismatch('echo-mismatch');
    const order = unavailable.map((source) => HISTORY_SOURCE_VALUES.indexOf(source));
    if (order.some((at, i) => i > 0 && at <= order[i - 1]!)) throw new Mismatch('page-invariant');
    const value: SearchHistoryValue = {
      query, scope, limit, total, hits, unavailable,
      ...(message !== undefined ? { message } : {}),
      unknownFields: rest(top, ['query', 'scope', 'limit', 'total', 'hits', 'unavailable', 'message']) as JsonObject,
    };
    return { value, assessment: unavailable.length > 0 || total > hits.length ? 'partial' : 'complete' };
  });
}
