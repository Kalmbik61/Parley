// Code Mode read adapter for `memory_read` (T11 R1). A standalone decoder in the style of read-adapters.ts, which exports the shared
// helpers (run, rest, echo, the shape readers and Mismatch) for it; the broker reaches it through read-adapter-table.ts. It edits no
// handler. The handler is `memoryTool` in mcp/tools.ts.
//
// The request decides the form (never the response): no `ids` lists every entry, `ids` lists only those (an unknown id is absent, not an
// error). Anything the handler refuses (an extra key, more than 100 ids, an id that is not m-NNN) has no success form.
//
// Completeness: the handler cuts its answer at 64 KiB and says so with `truncated: true`, the one structured mark of omission. That is
// `partial`. Without it the list is whole: no field of an entry is shortened, and an unknown id is a fact about the request, not an
// omission. A tool error keeps its whole original result and is `unknown` (decided by `run`).

import { StrictJsonError, parseStrictJson, type JsonValue } from '../validation.js';
import {
  Mismatch, TEXT_LIMITS, asArray, asCount, asObject, asString, asStringOrNull, rest, run,
  type Decoded, type JsonObject, type Unmodeled,
} from '../read-adapters.js';

export const MEMORY_KIND_VALUES: readonly string[] = Object.freeze(['fact', 'lesson', 'agreement']);
export const MEMORY_STATE_VALUES: readonly string[] = Object.freeze(['current', 'superseded']);
/** `MEMORY_ID` of mcp/tools.ts and the `maxItems` of the declaration; a test keeps the copies equal. */
export const MEMORY_ID_PATTERN = /^m-\d{3,}$/;
export const MEMORY_READ_MAX_IDS = 100;

export interface MemoryReadEntry extends Unmodeled {
  readonly id: string | null;
  readonly kind: 'fact' | 'lesson' | 'agreement';
  readonly fact: string;
  readonly details: string;
  readonly state: 'current' | 'superseded';
  readonly by: string;
  readonly onRequest?: true;
}

export interface MemoryReadValue extends Unmodeled {
  readonly items: readonly MemoryReadEntry[];
  /** How many entries matched; more than `items.length` only when `truncated`. */
  readonly total: number;
  readonly truncated?: true;
}

export interface MemoryReadRequest {
  /** The requested ids, or `null` for every entry. */
  readonly ids: readonly string[] | null;
}

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What the `memory_read` handler would do with the request: no arguments is the empty call; `ids` is the only key; it is absent or an
 * array of at most 100 strings that each match `m-NNN`. Any other shape (`null` included) has no success form (`null`). Never looks at a
 * response. It may be weaker than the handler, never stricter.
 */
export function selectMemoryReadRequest(args: unknown): MemoryReadRequest | null {
  const given = args === undefined ? {} : args;
  if (!isRecord(given)) return null;
  if (Object.keys(given).some((key) => key !== 'ids')) return null;
  const ids = given['ids'];
  if (ids === undefined) return { ids: null };
  if (!Array.isArray(ids) || ids.length > MEMORY_READ_MAX_IDS) return null;
  if (ids.some((id) => typeof id !== 'string' || !MEMORY_ID_PATTERN.test(id))) return null;
  return { ids: ids as readonly string[] };
}

function oneOf<T extends string>(v: unknown, values: readonly string[]): T {
  if (typeof v !== 'string' || !values.includes(v)) throw new Mismatch('shape-mismatch');
  return v as T;
}

function readTrue(v: unknown): true {
  if (v !== true) throw new Mismatch('shape-mismatch');
  return true;
}

function readEntry(v: unknown): MemoryReadEntry {
  const o = asObject(v);
  return {
    id: asStringOrNull(o['id']),
    kind: oneOf<MemoryReadEntry['kind']>(o['kind'], MEMORY_KIND_VALUES),
    fact: asString(o['fact']),
    details: asString(o['details']),
    state: oneOf<MemoryReadEntry['state']>(o['state'], MEMORY_STATE_VALUES),
    by: asString(o['by']),
    ...(Object.hasOwn(o, 'onRequest') ? { onRequest: readTrue(o['onRequest']) } : {}),
    unknownFields: rest(o, ['id', 'kind', 'fact', 'details', 'state', 'by', 'onRequest']),
  };
}

/**
 * Decodes the result of one `memory_read` call. `args` are the ORIGINAL request arguments; `mcpResult` is the strict MCP result the
 * broker settled. Pure.
 *
 * Checks beyond the shape, from the handler's own code: `total` is not below the entries shown; `truncated` is present exactly when
 * fewer entries are shown than matched; with `ids`, every entry has one of the requested ids, no id repeats and `total` is at most the
 * number of distinct requested ids; without `ids`, no id repeats.
 */
export function decodeMemoryRead(args: unknown, mcpResult: unknown): Decoded<MemoryReadValue> {
  return run<MemoryReadValue>(mcpResult, (text) => {
    const request = selectMemoryReadRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    const top = asObject(parsed);
    const items = asArray(top['items']).map(readEntry);
    const total = asCount(top['total']);
    const truncated = Object.hasOwn(top, 'truncated') ? readTrue(top['truncated']) : undefined;
    if (total < items.length) throw new Mismatch('page-invariant');
    if ((truncated === true) !== (items.length < total)) throw new Mismatch('page-invariant');
    const ids = items.map((item) => item.id);
    const named = ids.filter((id): id is string => id !== null);
    if (new Set(named).size !== named.length) throw new Mismatch('page-invariant');
    if (request.ids !== null) {
      const wanted = new Set(request.ids);
      if (named.length !== ids.length || named.some((id) => !wanted.has(id))) throw new Mismatch('echo-mismatch');
      if (total > wanted.size) throw new Mismatch('page-invariant');
    }
    const value: MemoryReadValue = {
      items,
      total,
      ...(truncated === true ? { truncated } : {}),
      unknownFields: rest(top, ['items', 'total', 'truncated']) as JsonObject,
    };
    return { value, assessment: truncated === true ? 'partial' : 'complete' };
  });
}
