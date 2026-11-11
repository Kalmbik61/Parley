// Code Mode read adapters (plan T6). Standalone decoders for the five initial read methods; this file holds the common types
// and helpers plus the `get_map` (T6-get_map), `read_room` (T6-read_room), `read_guide` (T6-read_guide), `list_roles`
// (T6-list_roles) and `backlog_list` (T6-backlog_list) decoders. Nothing here is wired into the broker, the scheduler, the
// catalogue or the declarations: runtime metadata, operation receipts and the monotonic incomplete floor belong to T6c.
// The shared helpers (`run`, `rest`, `readCut`, `readPage`, `readTextPage`, `echo`) are exported unchanged for the T11 decoders,
// which live in their own files (T11 B0); the broker reaches every decoder through read-adapter-table.ts.
//
// A decoder takes the ORIGINAL request arguments and the strict MCP result of the call and returns two separate things:
//   result     - what the guest sees: ReadResult<T> = ok value | tool-error (the original strict MCP result, as inert data)
//                | invalid-output (a fixed code, never host text). It never carries completeness.
//   assessment - the trusted host-side view: complete | partial | unknown. The guest cannot read or lower it.
// Rules kept by every decoder:
//   - the response form is chosen from the REQUEST (never guessed from the response), with the handler's own precedence;
//   - `isError` data is preserved as `tool-error` before any success decoding; the text of an error is never inspected;
//   - JSON is decoded only for a known method and only strictly (duplicate keys, lone surrogates and the like are refused);
//   - a malformed known shape is `invalid-output` with assessment `unknown`, never an empty success;
//   - fields this decoder does not model are kept verbatim in `unknownFields`, never stripped and never given a type, at
//     every depth (a nested object that is rebuilt carries its own `unknownFields`);
//   - extra keys of a successful MCP envelope (`_meta`, `structuredContent`, item `annotations`, ...) are kept verbatim in the
//     host-only `envelopeUnknown`, never in the guest value, never parsed, never read as authority or completeness;
//   - `partial` needs explicit evidence of omission (a page that says it is not complete, a positive `cut`, a shortened
//     text marked by a structured field); `unknown` is for omissions that leave no structured mark. Prose is never parsed.

import {
  StrictJsonError,
  freezeJson,
  parseStrictJson,
  type JsonLimits,
  type JsonValue,
} from './validation.js';

// ----- Common types -----

export type Assessment = 'complete' | 'partial' | 'unknown';

/** Fixed diagnostic codes of `invalid-output`. No host text ever enters one. */
export type InvalidOutputCode =
  | 'result-not-strict-json'
  | 'unexpected-envelope'
  | 'text-not-strict-json'
  | 'unknown-request-branch'
  | 'shape-mismatch'
  | 'echo-mismatch'
  | 'page-invariant'
  | 'decoder-fault';

export const INVALID_OUTPUT_CODES: readonly InvalidOutputCode[] = Object.freeze([
  'result-not-strict-json', 'unexpected-envelope', 'text-not-strict-json', 'unknown-request-branch',
  'shape-mismatch', 'echo-mismatch', 'page-invariant', 'decoder-fault',
]);

export interface ToolErrorInfo {
  readonly kind: 'tool-error';
  /** The original strict MCP result (`isError: true`), unchanged. Inert data, charged as delivered bytes by the broker. */
  readonly result: JsonValue;
}

export interface InvalidOutputInfo {
  readonly kind: 'invalid-output';
  readonly code: InvalidOutputCode;
}

export type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ToolErrorInfo | InvalidOutputInfo };

/** The pair a decoder returns. `assessment` is host-only and is not part of the guest union. */
export interface Decoded<T> {
  readonly result: ReadResult<T>;
  readonly assessment: Assessment;
  /** Host-only. T6c serializes `result` alone to the guest and does not log or forward this. */
  readonly envelopeUnknown: EnvelopeUnknown;
}

/**
 * Keys of a successful call's envelope that the known-output contract does not use: on the result (other than `content` and
 * `isError`) and on its single text item (other than `type` and `text`). Strict frozen JSON, kept verbatim. Not a DTO, not
 * authority and not completeness. A tool error keeps its whole original result in `error.result` instead, so this is empty.
 */
export interface EnvelopeUnknown {
  readonly resultFields: JsonObject;
  readonly itemFields: JsonObject;
}

export type JsonObject = { readonly [key: string]: JsonValue };

/** `cut` of the map topology: field name -> full size in bytes of a shortened field. */
export type CutMap = Readonly<Record<string, number>>;

/** Keys a decoder does not model, kept verbatim. */
export interface Unmodeled {
  readonly unknownFields: JsonObject;
}

/**
 * Worst of two assessments for one response. Explicit evidence of omission (`partial`) outranks `unknown`; both outrank
 * `complete`. Neither can ever be lowered by a later step.
 */
export function joinAssessment(a: Assessment, b: Assessment): Assessment {
  if (a === 'partial' || b === 'partial') return 'partial';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'complete';
}

const NO_EXTRAS: EnvelopeUnknown = Object.freeze({ resultFields: Object.freeze({}), itemFields: Object.freeze({}) });

const invalid = (code: InvalidOutputCode, envelopeUnknown: EnvelopeUnknown = NO_EXTRAS): Decoded<never> =>
  Object.freeze({ result: Object.freeze({ ok: false as const, error: Object.freeze({ kind: 'invalid-output' as const, code }) }), assessment: 'unknown' as const, envelopeUnknown });

// ----- MCP envelope -----

/** The envelope of one call as the broker hands it over (T5b1 settles `{content:[{type:'text',text}]}` plus optional isError). */
export const ENVELOPE_LIMITS: JsonLimits = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxNodes: 50_000 });
/** The JSON text inside a successful call: bounded by the 1 MiB wire cap of the remote-only caller. */
export const TEXT_LIMITS: JsonLimits = Object.freeze({ maxBytes: 1024 * 1024, maxDepth: 32, maxNodes: 200_000 });

export type Unwrapped =
  | { readonly kind: 'tool-error'; readonly result: JsonValue }
  | { readonly kind: 'text'; readonly text: string; readonly extras: EnvelopeUnknown }
  | { readonly kind: 'invalid'; readonly code: InvalidOutputCode };

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = Object.hasOwn;

/**
 * Strict copy of the MCP result, then: `isError: true` -> tool-error with the whole original result (nothing about its
 * content is inspected); otherwise exactly one text content item. Other keys of the envelope and of that item are strict
 * JSON by the copy above and are returned verbatim as `extras`; a non-boolean `isError`, a content list that is not exactly
 * one item, a non-text item and a non-string text are refused.
 */
export function unwrapMcpResult(mcpResult: unknown): Unwrapped {
  let envelope: unknown;
  try {
    envelope = freezeJson(mcpResult, ENVELOPE_LIMITS).value;
  } catch (error) {
    if (error instanceof StrictJsonError) return { kind: 'invalid', code: 'result-not-strict-json' };
    throw error;
  }
  if (!isRecord(envelope)) return { kind: 'invalid', code: 'unexpected-envelope' };
  if (hasOwn(envelope, 'isError')) {
    if (typeof envelope['isError'] !== 'boolean') return { kind: 'invalid', code: 'unexpected-envelope' };
    if (envelope['isError']) return { kind: 'tool-error', result: envelope as JsonValue };
  }
  const content = envelope['content'];
  if (!Array.isArray(content) || content.length !== 1) return { kind: 'invalid', code: 'unexpected-envelope' };
  const item: unknown = content[0];
  if (!isRecord(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') return { kind: 'invalid', code: 'unexpected-envelope' };
  const pick = (o: { readonly [key: string]: unknown }, known: readonly string[]): JsonObject => {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(o)) if (!known.includes(key)) out[key] = o[key] as JsonValue;
    return Object.freeze(out);
  };
  const extras: EnvelopeUnknown = Object.freeze({ resultFields: pick(envelope, ['content', 'isError']), itemFields: pick(item, ['type', 'text']) });
  return { kind: 'text', text: item['text'], extras };
}

/** Raised by the shape readers here and in the decoders' own files; `run()` maps it to `invalid-output`. */
export class Mismatch extends Error {
  constructor(readonly code: InvalidOutputCode) {
    super(code);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Runs a text decoder over an unwrapped call. The decoder returns the value and its assessment or throws `Mismatch`. */
export function run<T>(mcpResult: unknown, decode: (text: string) => { value: T; assessment: Assessment }): Decoded<T> {
  let extras: EnvelopeUnknown = NO_EXTRAS;
  try {
    const unwrapped = unwrapMcpResult(mcpResult);
    if (unwrapped.kind === 'invalid') return invalid(unwrapped.code);
    // A tool error carries no data: nothing was read, so nothing can be called complete.
    if (unwrapped.kind === 'tool-error') {
      return Object.freeze({ result: Object.freeze({ ok: false as const, error: Object.freeze({ kind: 'tool-error' as const, result: unwrapped.result }) }), assessment: 'unknown' as const, envelopeUnknown: NO_EXTRAS });
    }
    extras = unwrapped.extras;
    const { value, assessment } = decode(unwrapped.text);
    return Object.freeze({ result: Object.freeze({ ok: true as const, value: deepFreeze(value) }), assessment, envelopeUnknown: extras });
  } catch (error) {
    if (error instanceof Mismatch) return invalid(error.code, extras);
    return invalid('decoder-fault', extras);
  }
}

// ----- Shape readers (throw Mismatch) -----

const shape = (): never => { throw new Mismatch('shape-mismatch'); };
export const asObject = (v: unknown): { readonly [key: string]: JsonValue } => (isRecord(v) ? (v as { readonly [key: string]: JsonValue }) : shape());
export const asArray = (v: unknown): readonly JsonValue[] => (Array.isArray(v) ? (v as readonly JsonValue[]) : shape());
export const asString = (v: unknown): string => (typeof v === 'string' ? v : shape());
export const asStringOrNull = (v: unknown): string | null => (v === null ? null : asString(v));
export const asBool = (v: unknown): boolean => (typeof v === 'boolean' ? v : shape());
export const asCount = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : shape());
export const asCountOrNull = (v: unknown): number | null => (v === null ? null : asCount(v));
export const asStrings = (v: unknown): readonly string[] => asArray(v).map(asString);

/** The keys of `o` that are not in `known`, verbatim. */
export function rest(o: { readonly [key: string]: JsonValue }, known: readonly string[]): JsonObject {
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(o)) if (!known.includes(key)) out[key] = o[key] as JsonValue;
  return out;
}

/** Optional `cut` map: absent or `{}` mean nothing was shortened; a non-empty map names shortened fields. */
export function readCut(o: { readonly [key: string]: JsonValue }): CutMap | undefined {
  if (!hasOwn(o, 'cut')) return undefined;
  const cut = asObject(o['cut']);
  const out: { [key: string]: number } = {};
  for (const key of Object.keys(cut)) out[key] = asCount(cut[key]);
  return out;
}

const cutEvidence = (cut: CutMap | undefined): Assessment => (cut !== undefined && Object.keys(cut).length > 0 ? 'partial' : 'complete');

// ----- Page shapes shared by get_map forms and the other readers -----

export interface PageInfoDto extends Unmodeled {
  readonly total: number | null;
  readonly returned: number;
  readonly complete: boolean;
  readonly next: string | null;
  readonly bytes: number;
  /** How many entries of the page were shortened. */
  readonly cut: number;
}

/** Three cursor families never mix: `before|after:N` (sequence pages), `topology:<base64url>` (collection pages), `offset:N:hash` (text pages). */
const PAGE_CURSOR = /^(before|after):\d{1,12}$/;
const TOPOLOGY_CURSOR = /^topology:[A-Za-z0-9_-]{1,512}$/;

export function readPage(v: unknown, itemCount: number, family: 'sequence' | 'topology' = 'sequence'): { page: PageInfoDto; assessment: Assessment } {
  const o = asObject(v);
  const page: PageInfoDto = {
    total: asCountOrNull(o['total']),
    returned: asCount(o['returned']),
    complete: asBool(o['complete']),
    next: asStringOrNull(o['next']),
    bytes: asCount(o['bytes']),
    cut: asCount(o['cut']),
    unknownFields: rest(o, ['total', 'returned', 'complete', 'next', 'bytes', 'cut']),
  };
  if (page.returned !== itemCount) throw new Mismatch('page-invariant');
  if (page.complete !== (page.next === null)) throw new Mismatch('page-invariant');
  if (page.next !== null && !(family === 'topology' ? TOPOLOGY_CURSOR : PAGE_CURSOR).test(page.next)) throw new Mismatch('page-invariant');
  if (page.total !== null && page.total < page.returned) throw new Mismatch('page-invariant');
  return { page, assessment: !page.complete || page.cut > 0 ? 'partial' : 'complete' };
}

export interface TextPageDto extends Unmodeled {
  readonly text: string;
  /** Byte offset of this chunk in the UTF-8 full text. */
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly complete: boolean;
  readonly next: string | null;
}

const TEXT_HASH = /^[0-9a-f]{12}$/;

/** Reads the TextPage keys out of `o`; `knownExtra` are the keys of the surrounding form, kept out of `unknownFields`. */
export function readTextPage(o: { readonly [key: string]: JsonValue }, knownExtra: readonly string[]): { page: TextPageDto; assessment: Assessment } {
  const page: TextPageDto = {
    text: asString(o['text']),
    offset: asCount(o['offset']),
    bytes: asCount(o['bytes']),
    totalBytes: asCount(o['totalBytes']),
    sha256: asString(o['sha256']),
    complete: asBool(o['complete']),
    next: asStringOrNull(o['next']),
    unknownFields: rest(o, ['text', 'offset', 'bytes', 'totalBytes', 'sha256', 'complete', 'next', ...knownExtra]),
  };
  const end = page.offset + page.bytes;
  if (!TEXT_HASH.test(page.sha256)) throw new Mismatch('page-invariant');
  if (page.bytes !== Buffer.byteLength(page.text, 'utf8')) throw new Mismatch('page-invariant');
  if (end > page.totalBytes) throw new Mismatch('page-invariant');
  if (page.complete !== (end === page.totalBytes)) throw new Mismatch('page-invariant');
  if (page.complete !== (page.next === null)) throw new Mismatch('page-invariant');
  if (page.next !== null && page.next !== `offset:${end}:${page.sha256}`) throw new Mismatch('page-invariant');
  return { page, assessment: page.complete ? 'complete' : 'partial' };
}

// ----- get_map -----

/** The response forms of `get_map`, chosen by the request (see `selectGetMapBranch`). */
export const GET_MAP_BRANCHES = Object.freeze([
  'map', 'session', 'room', 'work-text', 'providers', 'archive', 'summaries', 'messages', 'message',
  'session-text', 'context-from', 'history', 'artifacts', 'collection', 'plan',
] as const);
export type GetMapBranch = (typeof GET_MAP_BRANCHES)[number];

const STRING_ARGS = ['field', 'session', 'room', 'id', 'kind', 'cursor'] as const;

/**
 * The response form for a request, with the handler's own precedence (tools.ts `getMap`/`mapPage`): no arguments -> the
 * overview; otherwise the collection fields (sessions, rooms, plans, deletedSessions, unreadRooms; they refuse session, room,
 * kind, id and rev), then `plan` (id and an integer rev >= 0), then, with no field, `session` before `room`, then the
 * other fields. A request the handler would refuse (no field/session/
 * room, an unsupported field, a field missing its required session or id, a non-string where a string is read) has no
 * branch, so a success for it cannot be decoded. Never looks at a response.
 */
export function selectGetMapBranch(args: unknown): GetMapBranch | null {
  // Absent arguments are the empty call: the server wrapper (tools.ts) hands the handler `{}` for an absent `arguments`. Any other
  // non-record value is not valid protocol input and stays refused.
  if (args === undefined) return 'map';
  if (!isRecord(args)) return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return 'map';
  for (const key of STRING_ARGS) if (hasOwn(args, key) && typeof args[key] !== 'string') return null;
  if (hasOwn(args, 'maxBytes') && typeof args['maxBytes'] !== 'number') return null;
  const hasSession = typeof args['session'] === 'string';
  if (hasOwn(args, 'field')) {
    switch (args['field']) {
      case 'sessions': case 'rooms': case 'plans': case 'deletedSessions': case 'unreadRooms':
        return ['session', 'room', 'kind', 'id', 'rev'].some((key) => hasOwn(args, key)) ? null : 'collection';
      case 'plan': return typeof args['id'] === 'string' && typeof args['rev'] === 'number' && Number.isSafeInteger(args['rev']) && args['rev'] >= 0 ? 'plan' : null;
      case 'goal': case 'title': return 'work-text';
      case 'providers': return 'providers';
      case 'archive': return 'archive';
      case 'summaries': return 'summaries';
      case 'messages': return 'messages';
      case 'message': return typeof args['id'] === 'string' ? 'message' : null;
      case 'task': case 'summary': return hasSession ? 'session-text' : null;
      case 'contextFrom': return hasSession ? 'context-from' : null;
      case 'history': return hasSession ? 'history' : null;
      case 'artifacts': return hasSession ? 'artifacts' : null;
      default: return null;
    }
  }
  if (hasSession) return 'session';
  if (typeof args['room'] === 'string') return 'room';
  return null;
}

/** An entry of a list this decoder does not model beyond its id. */
export interface OpenEntry extends Unmodeled {
  readonly id: string;
  readonly cut?: CutMap;
}

function readOpenEntry(v: unknown): { entry: OpenEntry; assessment: Assessment } {
  const o = asObject(v);
  const cut = readCut(o);
  return {
    entry: { id: asString(o['id']), ...(cut === undefined ? {} : { cut }), unknownFields: rest(o, ['id', 'cut']) },
    assessment: cutEvidence(cut),
  };
}

export interface MapMessagesDto extends Unmodeled {
  readonly total: number;
  readonly latestId: string | null;
  readonly direct: { readonly total: number; readonly latestId: string | null; readonly unknownFields: JsonObject };
  readonly unreadForYou: { readonly total: number; readonly rooms: Readonly<Record<string, number>>; readonly direct: number; readonly unknownFields: JsonObject };
}

/** A summary row of the overview or of a collection page: only its id is modeled unless a field below says more. */
export interface RowEntry extends Unmodeled {
  readonly id: string;
}

/** A row of any collection page; the keys beyond `id` are present exactly for the fields that promise them. */
export interface CollectionRow extends RowEntry {
  /** plans */
  readonly rev?: number;
  readonly status?: string;
  readonly roomId?: string;
  readonly itemCount?: number;
  /** unreadRooms */
  readonly count?: number;
}

export interface WorkEntry extends OpenEntry {
  readonly deletedSessions: readonly string[];
  readonly closeFinished?: boolean;
}

export const COLLECTION_FIELDS = Object.freeze(['sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms'] as const);
export type CollectionField = (typeof COLLECTION_FIELDS)[number];

export interface MapTopologyDto extends Unmodeled {
  readonly schemaVersion: 3;
  readonly work: WorkEntry;
  readonly sessions: readonly RowEntry[];
  readonly rooms: readonly RowEntry[];
  readonly plans: readonly CollectionRow[];
  readonly messages: MapMessagesDto;
  /** The page of each of the five collections: `complete` and `next` say whether the arrays above show everything. */
  readonly collections: { readonly [F in CollectionField]: PageInfoDto } & Unmodeled;
  /** Text that says how to read the rest. Kept as is; never interpreted. */
  readonly pages: string;
  /** A constant sentence of the handler; its presence is required, its text is never read. */
  readonly note: string;
}

export interface SessionDetailDto extends Unmodeled {
  readonly id: string;
  readonly historyCount: number;
  readonly artifactCount: number;
  readonly history: readonly JsonValue[];
  readonly artifacts: readonly JsonValue[];
  readonly cut?: CutMap;
}

export interface ProviderEntry extends Unmodeled {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export type GetMapValue =
  | ({ readonly branch: 'map'; readonly sessionId: string | null; readonly map: MapTopologyDto } & Unmodeled)
  | ({ readonly branch: 'session'; readonly session: SessionDetailDto } & Unmodeled)
  | ({ readonly branch: 'room'; readonly room: { readonly id: string; readonly recipe: ({ readonly id: string; readonly name: string } & Unmodeled) | null; readonly unknownFields: JsonObject }; readonly messages: { readonly total: number; readonly latestId: string | null; readonly unreadForYou: number; readonly unknownFields: JsonObject } } & Unmodeled)
  | ({ readonly branch: 'work-text'; readonly field: 'goal' | 'title' } & TextPageDto)
  | ({ readonly branch: 'providers'; readonly providers: readonly ProviderEntry[]; readonly note?: string } & Unmodeled)
  | ({ readonly branch: 'archive'; readonly workspaces: readonly (Unmodeled & { readonly id: string; readonly title: string; readonly status: string; readonly updatedAt: string })[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'summaries'; readonly summaries: readonly (Unmodeled & { readonly id: string; readonly text: string; readonly textBytes?: number })[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'messages'; readonly messages: readonly MessageView[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'message'; readonly id: string; readonly from: string; readonly at: string; readonly roomId: string | null } & TextPageDto)
  | ({ readonly branch: 'session-text'; readonly session: string; readonly field: 'task' | 'summary' } & TextPageDto)
  | ({ readonly branch: 'context-from'; readonly session: string; readonly field: 'contextFrom'; readonly contextFrom: readonly string[] } & Unmodeled)
  | ({ readonly branch: 'history'; readonly session: string; readonly field: 'history'; readonly history: readonly JsonValue[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'artifacts'; readonly session: string; readonly field: 'artifacts'; readonly artifacts: readonly JsonValue[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'collection'; readonly field: CollectionField; readonly items: readonly CollectionRow[]; readonly page: PageInfoDto } & Unmodeled)
  | ({ readonly branch: 'plan'; readonly field: 'plan'; readonly id: string; readonly rev: number; readonly status: string; readonly format: 'json' } & TextPageDto);

export interface MessageView extends Unmodeled {
  readonly id: string;
  readonly from: string;
  readonly fromLabel: string;
  readonly at: string;
  readonly text: string;
  readonly kind: string;
  readonly room: ({ readonly id: string; readonly title: string } & Unmodeled) | null;
  readonly replyTo?: string;
  readonly toEveryone?: boolean;
}

type Out = { value: GetMapValue; assessment: Assessment };

function readMessageView(v: unknown): MessageView {
  const o = asObject(v);
  const room = o['room'] === null ? null : (() => { const r = asObject(o['room']); return { id: asString(r['id']), title: asString(r['title']), unknownFields: rest(r, ['id', 'title']) }; })();
  return {
    id: asString(o['id']),
    from: asString(o['from']),
    fromLabel: asString(o['fromLabel']),
    at: asString(o['at']),
    text: asString(o['text']),
    kind: asString(o['kind']),
    room,
    ...(hasOwn(o, 'replyTo') ? { replyTo: asString(o['replyTo']) } : {}),
    ...(hasOwn(o, 'toEveryone') ? { toEveryone: asBool(o['toEveryone']) } : {}),
    unknownFields: rest(o, ['id', 'from', 'fromLabel', 'at', 'text', 'kind', 'room', 'replyTo', 'toEveryone']),
  };
}

export function echo(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Mismatch('echo-mismatch');
}

function readRow(v: unknown): RowEntry {
  const o = asObject(v);
  return { id: asString(o['id']), unknownFields: rest(o, ['id']) };
}

/** Row readers of the collections and of the overview arrays; the keys modeled beyond `id` are the ones the handler promises. */
const ROW_READERS: { readonly [F in CollectionField]: (v: unknown) => CollectionRow } = {
  sessions: readRow,
  rooms: readRow,
  plans: (v) => {
    const o = asObject(v);
    return { id: asString(o['id']), rev: asCount(o['rev']), status: asString(o['status']), roomId: asString(o['roomId']), itemCount: asCount(o['itemCount']), unknownFields: rest(o, ['id', 'rev', 'status', 'roomId', 'itemCount']) };
  },
  deletedSessions: readRow,
  unreadRooms: (v) => {
    const o = asObject(v);
    return { id: asString(o['id']), count: asCount(o['count']), unknownFields: rest(o, ['id', 'count']) };
  },
};

/**
 * Rows of sessions, rooms and plans (and, in the overview, `work.createdAt` and `work.updatedAt`) carry texts shortened by
 * `summaryText` (96 bytes, a trailing ellipsis) WITHOUT any structured mark. A decoder cannot tell a shortened text from a natural one by looking at it, and content heuristics are
 * not used, so a page that holds at least one such row can never be called complete: it is `unknown` at best.
 */
const CAPPED_ROW_FIELDS: ReadonlySet<CollectionField> = new Set(['sessions', 'rooms', 'plans']);

function decodeMap(top: { readonly [key: string]: JsonValue }): Out {
  const m = asObject(top['map']);
  if (m['schemaVersion'] !== 3) shape();
  let assessment: Assessment = 'complete';
  const workRaw = asObject(m['work']);
  const workBase = readOpenEntry(workRaw);
  assessment = joinAssessment(assessment, workBase.assessment);
  const deletedSessions = asStrings(workRaw['deletedSessions']);
  const closeFinished = hasOwn(workRaw, 'closeFinished') ? asBool(workRaw['closeFinished']) : undefined;
  const work: WorkEntry = {
    ...workBase.entry,
    deletedSessions,
    ...(closeFinished === undefined ? {} : { closeFinished }),
    unknownFields: rest(workRaw, ['id', 'cut', 'deletedSessions', 'closeFinished']),
  };
  const sessions = asArray(m['sessions']).map(readRow);
  const rooms = asArray(m['rooms']).map(readRow);
  const plans = asArray(m['plans']).map(ROW_READERS.plans);

  const mm = asObject(m['messages']);
  const direct = asObject(mm['direct']);
  const unread = asObject(mm['unreadForYou']);
  const unreadRooms = asObject(unread['rooms']);
  const messages: MapMessagesDto = {
    total: asCount(mm['total']),
    latestId: asStringOrNull(mm['latestId']),
    direct: { total: asCount(direct['total']), latestId: asStringOrNull(direct['latestId']), unknownFields: rest(direct, ['total', 'latestId']) },
    unreadForYou: {
      total: asCount(unread['total']),
      rooms: Object.fromEntries(Object.keys(unreadRooms).map((key) => [key, asCount(unreadRooms[key])])),
      direct: asCount(unread['direct']),
      unknownFields: rest(unread, ['total', 'rooms', 'direct']),
    },
    unknownFields: rest(mm, ['total', 'latestId', 'direct', 'unreadForYou']),
  };

  // Every collection reports its own page; the arrays above must be exactly the rows that page returned.
  const collectionsRaw = asObject(m['collections']);
  const expectedRows: { readonly [F in CollectionField]: number } = {
    sessions: sessions.length, rooms: rooms.length, plans: plans.length, deletedSessions: deletedSessions.length, unreadRooms: Object.keys(unreadRooms).length,
  };
  const pages = {} as { [F in CollectionField]: PageInfoDto };
  for (const field of COLLECTION_FIELDS) {
    const read = readPage(collectionsRaw[field], expectedRows[field], 'topology');
    pages[field] = read.page;
    assessment = joinAssessment(assessment, read.assessment);
  }
  // The overview always contains texts that may have been shortened without a mark: `work.createdAt` and `work.updatedAt` go
  // through `summaryText` (96 bytes, no mark) and so do the texts of every sessions, rooms and plans row (see
  // CAPPED_ROW_FIELDS). It is therefore never complete, whatever the rows are.
  assessment = joinAssessment(assessment, 'unknown');

  const map: MapTopologyDto = {
    schemaVersion: 3,
    work,
    sessions,
    rooms,
    plans,
    messages,
    collections: { ...pages, unknownFields: rest(collectionsRaw, COLLECTION_FIELDS) },
    pages: asString(m['pages']),
    note: asString(m['note']),
    unknownFields: rest(m, ['schemaVersion', 'work', 'sessions', 'rooms', 'plans', 'messages', 'collections', 'pages', 'note']),
  };
  return { value: { branch: 'map', sessionId: asStringOrNull(top['sessionId']), map, unknownFields: rest(top, ['sessionId', 'map']) }, assessment };
}

function decodeCollection(top: { readonly [key: string]: JsonValue }, args: { readonly [key: string]: unknown }): Out {
  const field = args['field'] as CollectionField;
  echo(top['field'], field);
  const items = asArray(top['items']).map(ROW_READERS[field]);
  const { page, assessment } = readPage(top['page'], items.length, 'topology');
  const capped = CAPPED_ROW_FIELDS.has(field) && items.length > 0;
  return {
    value: { branch: 'collection', field, items, page, unknownFields: rest(top, ['field', 'items', 'page']) },
    assessment: capped ? joinAssessment(assessment, 'unknown') : assessment,
  };
}

function decodePlan(top: { readonly [key: string]: JsonValue }, args: { readonly [key: string]: unknown }): Out {
  echo(top['field'], 'plan');
  echo(top['id'], args['id']);
  echo(top['rev'], args['rev']);
  echo(top['format'], 'json');
  const status = asString(top['status']);
  const { page, assessment } = readTextPage(top, ['field', 'id', 'rev', 'status', 'format']);
  return { value: { branch: 'plan', field: 'plan', id: args['id'] as string, rev: args['rev'] as number, status, format: 'json', ...page }, assessment };
}

/** The slices `mapPage` takes: the first 20 artifacts and the last 20 history entries. */
const SESSION_SLICE = 20;

function decodeSession(top: { readonly [key: string]: JsonValue }, args: { readonly [key: string]: unknown }): Out {
  const s = asObject(top['session']);
  const cut = readCut(s);
  const history = asArray(s['history']);
  const artifacts = asArray(s['artifacts']);
  const historyCount = asCount(s['historyCount']);
  const artifactCount = asCount(s['artifactCount']);
  const id = asString(s['id']);
  echo(id, args['session']);
  if (history.length > Math.min(SESSION_SLICE, historyCount) || artifacts.length > Math.min(SESSION_SLICE, artifactCount)) throw new Mismatch('page-invariant');
  // The counts come from the same record, so a shorter array is an observable omission.
  let assessment = cutEvidence(cut);
  if (history.length < historyCount || artifacts.length < artifactCount) assessment = 'partial';
  const session: SessionDetailDto = {
    id, historyCount, artifactCount, history, artifacts,
    ...(cut === undefined ? {} : { cut }),
    unknownFields: rest(s, ['id', 'historyCount', 'artifactCount', 'history', 'artifacts', 'cut']),
  };
  return { value: { branch: 'session', session, unknownFields: rest(top, ['session']) }, assessment };
}

function decodeRoom(top: { readonly [key: string]: JsonValue }, args: { readonly [key: string]: unknown }): Out {
  const r = asObject(top['room']);
  const id = asString(r['id']);
  echo(id, args['room']);
  const recipeRaw = r['recipe'];
  if (recipeRaw === undefined) shape();
  const recipe = recipeRaw === null ? null : (() => { const x = asObject(recipeRaw); return { id: asString(x['id']), name: asString(x['name']), unknownFields: rest(x, ['id', 'name']) }; })();
  const mm = asObject(top['messages']);
  return {
    value: {
      branch: 'room',
      room: { id, recipe, unknownFields: rest(r, ['id', 'recipe']) },
      messages: { total: asCount(mm['total']), latestId: asStringOrNull(mm['latestId']), unreadForYou: asCount(mm['unreadForYou']), unknownFields: rest(mm, ['total', 'latestId', 'unreadForYou']) },
      unknownFields: rest(top, ['room', 'messages']),
    },
    assessment: 'complete',
  };
}

function decodeProviders(top: { readonly [key: string]: JsonValue }): Out {
  const providers = asArray(top['providers']).map((raw): ProviderEntry => {
    const o = asObject(raw);
    return { id: asString(o['id']), label: asString(o['label']), available: asBool(o['available']), unknownFields: rest(o, ['id', 'label', 'available']) };
  });
  const note = hasOwn(top, 'note') ? asString(top['note']) : undefined;
  return {
    value: { branch: 'providers', providers, ...(note === undefined ? {} : { note }), unknownFields: rest(top, ['providers', 'note']) },
    // The handler adds `note` exactly when it could not ask the host and fell back to the local registry, which lacks the
    // host's sign-in and limit data. Only its presence is read, never its text.
    assessment: note === undefined ? 'complete' : 'partial',
  };
}

function decodeBranch(branch: GetMapBranch, top: { readonly [key: string]: JsonValue }, args: { readonly [key: string]: unknown }): Out {
  switch (branch) {
    case 'map': return decodeMap(top);
    case 'collection': return decodeCollection(top, args);
    case 'plan': return decodePlan(top, args);
    case 'session': return decodeSession(top, args);
    case 'room': return decodeRoom(top, args);
    case 'providers': return decodeProviders(top);
    case 'work-text': {
      echo(top['field'], args['field']);
      const { page, assessment } = readTextPage(top, ['field']);
      return { value: { branch, field: args['field'] as 'goal' | 'title', ...page }, assessment };
    }
    case 'session-text': {
      echo(top['field'], args['field']);
      echo(top['session'], args['session']);
      const { page, assessment } = readTextPage(top, ['field', 'session']);
      return { value: { branch, session: args['session'] as string, field: args['field'] as 'task' | 'summary', ...page }, assessment };
    }
    case 'message': {
      echo(top['id'], args['id']);
      const { page, assessment } = readTextPage(top, ['id', 'from', 'at', 'roomId']);
      return { value: { branch, id: args['id'] as string, from: asString(top['from']), at: asString(top['at']), roomId: asStringOrNull(top['roomId']), ...page }, assessment };
    }
    case 'context-from': {
      echo(top['field'], 'contextFrom');
      echo(top['session'], args['session']);
      return { value: { branch, session: args['session'] as string, field: 'contextFrom', contextFrom: asStrings(top['contextFrom']), unknownFields: rest(top, ['session', 'field', 'contextFrom']) }, assessment: 'complete' };
    }
    case 'history': {
      echo(top['field'], 'history');
      echo(top['session'], args['session']);
      const history = asArray(top['history']);
      const { page, assessment } = readPage(top['page'], history.length);
      return { value: { branch, session: args['session'] as string, field: 'history', history, page, unknownFields: rest(top, ['session', 'field', 'history', 'page']) }, assessment };
    }
    case 'artifacts': {
      echo(top['field'], 'artifacts');
      echo(top['session'], args['session']);
      const artifacts = asArray(top['artifacts']);
      const { page, assessment } = readPage(top['page'], artifacts.length);
      return { value: { branch, session: args['session'] as string, field: 'artifacts', artifacts, page, unknownFields: rest(top, ['session', 'field', 'artifacts', 'page']) }, assessment };
    }
    case 'archive': {
      const items = asArray(top['workspaces']).map((raw) => {
        const o = asObject(raw);
        return { id: asString(o['id']), title: asString(o['title']), status: asString(o['status']), updatedAt: asString(o['updatedAt']), unknownFields: rest(o, ['id', 'title', 'status', 'updatedAt']) };
      });
      const { page, assessment } = readPage(top['page'], items.length);
      return { value: { branch, workspaces: items, page, unknownFields: rest(top, ['workspaces', 'page']) }, assessment };
    }
    case 'summaries': {
      let shortened = false;
      const items = asArray(top['summaries']).map((raw) => {
        const o = asObject(raw);
        const textBytes = hasOwn(o, 'textBytes') ? asCount(o['textBytes']) : undefined;
        // `textBytes` is the handler's structured mark of a shortened summary (it names the full size).
        if (textBytes !== undefined) shortened = true;
        return { id: asString(o['id']), text: asString(o['text']), ...(textBytes === undefined ? {} : { textBytes }), unknownFields: rest(o, ['id', 'text', 'textBytes']) };
      });
      const { page, assessment } = readPage(top['page'], items.length);
      return { value: { branch, summaries: items, page, unknownFields: rest(top, ['summaries', 'page']) }, assessment: shortened ? joinAssessment(assessment, 'partial') : assessment };
    }
    case 'messages': {
      const items = asArray(top['messages']).map(readMessageView);
      const { page, assessment } = readPage(top['page'], items.length);
      return { value: { branch, messages: items, page, unknownFields: rest(top, ['messages', 'page']) }, assessment };
    }
  }
}

/**
 * Decodes the result of one `get_map` call. `args` are the ORIGINAL request arguments (they choose the response form);
 * `mcpResult` is the strict MCP result the broker settled. Pure: no I/O, no clock, no host state.
 */
export function decodeGetMap(args: unknown, mcpResult: unknown): Decoded<GetMapValue> {
  return run<GetMapValue>(mcpResult, (text) => {
    const branch = selectGetMapBranch(args);
    if (branch === null) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    return decodeBranch(branch, asObject(parsed), isRecord(args) ? args : {});
  });
}

// ----- read_room -----

/** A message of a room page: the shared view plus `textBytes`, the structured mark of a text shortened to fit the page. */
export interface RoomMessage extends Omit<MessageView, 'unknownFields'>, Unmodeled {
  /** Full size in bytes of the original text; present only on a shortened message (`text` is then an excerpt). */
  readonly textBytes?: number;
}

export interface ReadRoomValue extends Unmodeled {
  readonly messages: readonly RoomMessage[];
  readonly page: PageInfoDto;
}

export interface ReadRoomRequest {
  readonly room: string;
  /** The handler's page size for this request: `limit` floored and kept within 1..100 (default 50). */
  readonly maxItems: number;
  /** `null`: no cursor, newest messages first read backwards. */
  readonly cursor: { readonly dir: 'before' | 'after'; readonly seq: number } | null;
}

/**
 * What the `read_room` handler would do with the request (tools.ts `readRoom`): `room` a non-empty string; `limit` and
 * `maxBytes` absent or a finite number; `cursor` absent, empty or `before:N`/`after:N`. Anything the handler refuses has
 * no success form, so it yields `null`. Other keys are ignored by the handler and here. Never looks at a response.
 */
export function selectReadRoomRequest(args: unknown): ReadRoomRequest | null {
  if (!isRecord(args)) return null;
  const room = args['room'];
  if (typeof room !== 'string' || room === '') return null;
  const limit = args['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) return null;
  const maxBytes = args['maxBytes'];
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes))) return null;
  const raw = args['cursor'];
  if (raw !== undefined && typeof raw !== 'string') return null;
  let cursor: ReadRoomRequest['cursor'] = null;
  if (raw !== undefined && raw !== '') {
    const match = PAGE_CURSOR.exec(raw);
    if (match === null) return null;
    cursor = { dir: raw.startsWith('after') ? 'after' : 'before', seq: Number(raw.slice(raw.indexOf(':') + 1)) };
  }
  return { room, maxItems: Math.min(Math.max(Math.floor(limit ?? 50), 1), 100), cursor };
}

/** `m-NN`: the number only grows and is zero padded to two digits (`m-01`, `m-130`); `0` is no message. */
const MESSAGE_ID = /^m-\d+$/;
const messageSeq = (id: string): number => {
  const seq = MESSAGE_ID.test(id) ? Number(id.slice(2)) : 0;
  return Number.isSafeInteger(seq) && seq > 0 ? seq : shape();
};

function readRoomMessage(v: unknown): RoomMessage {
  const view = readMessageView(v);
  const o = asObject(v);
  const { unknownFields, ...typed } = view;
  const textBytes = hasOwn(o, 'textBytes') ? asCount(o['textBytes']) : undefined;
  return { ...typed, ...(textBytes === undefined ? {} : { textBytes }), unknownFields: rest(unknownFields, ['textBytes']) };
}

/**
 * Decodes the result of one `read_room` call. `args` are the ORIGINAL request arguments (the room, the page size and the
 * cursor decide what a response may contain); `mcpResult` is the strict MCP result the broker settled. Pure.
 *
 * A page is checked against the request and against itself: every message belongs to the requested room; ids ascend
 * strictly; `before:N` returns only older and `after:N` only newer messages; `next` is exactly the cursor that continues
 * in the request's direction from the page's edge message; `returned` is the message count and within the page size;
 * `page.cut` equals the number of messages carrying `textBytes`. Assessment: a page with more behind it (`next`) or with a
 * shortened message is `partial`; otherwise `complete`. Message fields are passed through by the handler without caps.
 */
export function decodeReadRoom(args: unknown, mcpResult: unknown): Decoded<ReadRoomValue> {
  return run<ReadRoomValue>(mcpResult, (text) => {
    const request = selectReadRoomRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    const top = asObject(parsed);
    const messages = asArray(top['messages']).map(readRoomMessage);
    const { page, assessment } = readPage(top['page'], messages.length);
    if (page.total === null) shape();
    if (messages.length > request.maxItems) throw new Mismatch('page-invariant');
    for (const message of messages) echo(message.room?.id, request.room);

    const seqs = messages.map((message) => messageSeq(message.id));
    for (let i = 1; i < seqs.length; i++) if (seqs[i]! <= seqs[i - 1]!) throw new Mismatch('page-invariant');
    const { cursor } = request;
    if (cursor !== null) {
      const bound = cursor.seq;
      if (seqs.some((seq) => (cursor.dir === 'after' ? seq <= bound : seq >= bound))) throw new Mismatch('page-invariant');
    }
    // No cursor and `before:` read backwards; `after:` reads forwards. `next` continues from the page's far edge.
    if (page.next !== null) {
      if (seqs.length === 0) throw new Mismatch('page-invariant');
      const expected = cursor?.dir === 'after' ? `after:${seqs[seqs.length - 1]}` : `before:${seqs[0]}`;
      if (page.next !== expected) throw new Mismatch('page-invariant');
    }
    if (messages.filter((message) => message.textBytes !== undefined).length !== page.cut) throw new Mismatch('page-invariant');

    return { value: { messages, page, unknownFields: rest(top, ['messages', 'page']) }, assessment };
  });
}

// ----- read_guide -----

/** `GUIDE_TOPICS` of work/guide.ts (the declaration's enum); a test keeps the copy equal. */
export const GUIDE_TOPIC_VALUES: readonly string[] = Object.freeze([
  'plans', 'overview', 'lifecycle', 'tools', 'rooms', 'lead', 'member', 'stuck', 'brief', 'window', 'worktrees', 'letters', 'rules',
]);

/** `READ_GUIDE_MAX_BYTES` of work/context-budget.ts: a longer answer is replaced by a short fallback text; a test keeps the copy equal. */
export const READ_GUIDE_MAX_CONTEXT_BYTES = 65536;

/**
 * The guide text, verbatim. Nothing else: the result is plain text, not JSON, so there is nothing to type and nothing that
 * could carry a mark. Its completeness is always `unknown` (see `decodeReadGuide`).
 */
export interface ReadGuideValue {
  readonly text: string;
}

export interface ReadGuideRequest {
  /** The normalized topic (trimmed, lower case), or `null` for the whole guide. */
  readonly topic: string | null;
}

/**
 * What the `read_guide` handler would do with the request (tools.ts `readGuide`): no topic or `''` -> the whole guide; a
 * string is trimmed and lower-cased and must be one of the guide topics (a whitespace-only string is an unknown topic, not
 * the whole guide); any other type, `null` included, is refused. Other keys are ignored by the handler and here. Never looks
 * at a response.
 */
export function selectReadGuideRequest(args: unknown): ReadGuideRequest | null {
  // Absent arguments are the empty call (the server wrapper passes `{}`); any other non-record value stays refused.
  if (args === undefined) return { topic: null };
  if (!isRecord(args)) return null;
  const raw = args['topic'];
  if (raw === undefined || raw === '') return { topic: null };
  if (typeof raw !== 'string') return null;
  const topic = raw.trim().toLowerCase();
  return GUIDE_TOPIC_VALUES.includes(topic) ? { topic } : null;
}

/**
 * Decodes the result of one `read_guide` call. `args` are the ORIGINAL request arguments; `mcpResult` is the strict MCP
 * result the broker settled. Pure. The text is returned unparsed (it is never decoded as JSON).
 *
 * The assessment of every success is `unknown`, never `complete`: when the answer would exceed 65536 JSON-escaped bytes the
 * handler returns a short different text with no structured mark in its place, and the decoder, which does not see the full
 * guide and does not read prose, cannot tell the two apart. A text the handler can never produce (empty, or over the size
 * limit) is refused. A tool error keeps its whole original result and is `unknown` too.
 */
export function decodeReadGuide(args: unknown, mcpResult: unknown): Decoded<ReadGuideValue> {
  return run<ReadGuideValue>(mcpResult, (text) => {
    if (selectReadGuideRequest(args) === null) throw new Mismatch('unknown-request-branch');
    // `contextBytes` of work/context-budget.ts: UTF-8 bytes of the JSON-escaped text without the quotes.
    if (text === '' || Buffer.byteLength(JSON.stringify(text), 'utf8') - 2 > READ_GUIDE_MAX_CONTEXT_BYTES) throw new Mismatch('shape-mismatch');
    return { value: { text }, assessment: 'unknown' };
  });
}

// ----- list_roles -----

export interface RoleModelsDto extends Unmodeled {
  readonly claude: string | null;
  readonly codex: string | null;
}

/** A role as `roleSummaries` whitelists it: no prompt, no path. `models` exists for builtin roles and for no other source. */
export interface RoleSummaryDto extends Unmodeled {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly provider: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly readOnly: boolean;
  readonly models?: RoleModelsDto;
}

/** `roleSummaries` keeps only `source` and `code` of a catalogue diagnostic. */
export interface RoleDiagnosticDto extends Unmodeled {
  readonly source: string;
  readonly code: string;
}

export interface ListRolesValue extends Unmodeled {
  readonly roles: readonly RoleSummaryDto[];
  readonly partial: boolean;
  readonly diagnostics: readonly RoleDiagnosticDto[];
}

/**
 * The `list_roles` handler reads no argument (tools.ts dispatch): any object, or no arguments at all, has the one response
 * form. Anything else has none. Never looks at a response.
 */
export function isListRolesRequest(args: unknown): boolean {
  return args === undefined || isRecord(args);
}

function readRoleSummary(v: unknown): RoleSummaryDto {
  const o = asObject(v);
  const source = asString(o['source']);
  // The handler adds `models` for builtin roles and for no other source (agents.ts roleSummaries).
  if (hasOwn(o, 'models') !== (source === 'builtin')) shape();
  const models = hasOwn(o, 'models')
    ? (() => {
        const m = asObject(o['models']);
        return { claude: asStringOrNull(m['claude']), codex: asStringOrNull(m['codex']), unknownFields: rest(m, ['claude', 'codex']) };
      })()
    : undefined;
  return {
    id: asString(o['id']),
    name: asString(o['name']),
    description: asString(o['description']),
    source,
    provider: asString(o['provider']),
    model: asStringOrNull(o['model']),
    effort: asStringOrNull(o['effort']),
    readOnly: asBool(o['readOnly']),
    ...(models === undefined ? {} : { models }),
    unknownFields: rest(o, ['id', 'name', 'description', 'source', 'provider', 'model', 'effort', 'readOnly', 'models']),
  };
}

function readRoleDiagnostic(v: unknown): RoleDiagnosticDto {
  const o = asObject(v);
  return { source: asString(o['source']), code: asString(o['code']), unknownFields: rest(o, ['source', 'code']) };
}

/**
 * Decodes the result of one `list_roles` call. `args` are the ORIGINAL request arguments (the handler ignores them);
 * `mcpResult` is the strict MCP result the broker settled. Pure.
 *
 * Assessment: every omission in the native role inventory is reported by one function that pushes a diagnostic and sets the
 * `partial` flag together, and the merge of sources does the same for a duplicate role. So `partial: true` or any diagnostic
 * is explicit evidence of omission -> `partial`; neither -> `complete`. A diagnostic with `partial: false` (only an injected
 * catalogue could give it) is assessed `partial`, not refused. Catalogue-level properties (unique ids, id prefix equal to the
 * source, order) are not checked: an injected catalogue may break them.
 */
export function decodeListRoles(args: unknown, mcpResult: unknown): Decoded<ListRolesValue> {
  return run<ListRolesValue>(mcpResult, (text) => {
    if (!isListRolesRequest(args)) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    const top = asObject(parsed);
    const roles = asArray(top['roles']).map(readRoleSummary);
    const partial = asBool(top['partial']);
    const diagnostics = asArray(top['diagnostics']).map(readRoleDiagnostic);
    return {
      value: { roles, partial, diagnostics, unknownFields: rest(top, ['roles', 'partial', 'diagnostics']) },
      assessment: partial || diagnostics.length > 0 ? 'partial' : 'complete',
    };
  });
}

// ----- backlog_list -----

/** A backlog card as the handler lists it: the Markdown item, the optional board metadata and the computed `state`. */
export interface BacklogCardDto extends Unmodeled {
  readonly id: string | null;
  readonly title: string;
  readonly details: string;
  readonly checked: boolean;
  readonly section: string | null;
  readonly taken?: string;
  readonly done?: string;
  readonly by?: string;
  readonly created?: string;
  readonly sent?: string;
  readonly review?: string;
  readonly state: 'backlog' | 'in-progress' | 'review' | 'done';
}

/** A pending suggestion: only these keys leave the handler. */
export interface BacklogSuggestionDto extends Unmodeled {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly details: string;
  readonly why: string;
  readonly workId: string;
  readonly sessionId: string;
}

/** A shared-state diagnostic (ignore-file problems); not about completeness. */
export interface BacklogDiagnosticDto extends Unmodeled {
  readonly code: string;
}

export interface BacklogListValue extends Unmodeled {
  readonly version: string;
  readonly items: readonly BacklogCardDto[];
  readonly suggestions: readonly BacklogSuggestionDto[];
  readonly rule: string;
  readonly diagnostics: readonly BacklogDiagnosticDto[];
}

export interface BacklogListRequest {
  readonly filter: 'open' | 'taken' | 'done' | 'all';
  readonly text: string;
}

const BACKLOG_FILTERS: readonly string[] = ['open', 'taken', 'done', 'all'];

/**
 * What the `backlog_list` handler would do with the request (tools.ts `backlogTool`): no arguments at all is the empty call;
 * only `filter` and `text` are allowed keys (a key with an undefined value counts); `filter` and `text` default when null or
 * undefined; the filter must be one of four strings; the text a string of at most 4096 UTF-16 units without NUL. Anything else
 * has no success form (`null`). Never looks at a response.
 */
export function selectBacklogListRequest(args: unknown): BacklogListRequest | null {
  // No arguments at all is the empty call: the server wrapper hands the handler `{}` for an absent `arguments`. Any other
  // non-record value is not valid protocol input and stays refused.
  const given = args === undefined ? {} : args;
  if (!isRecord(given)) return null;
  if (Object.keys(given).some((key) => key !== 'filter' && key !== 'text')) return null;
  const filter = given['filter'] ?? 'open';
  const text = given['text'] ?? '';
  if (typeof filter !== 'string' || !BACKLOG_FILTERS.includes(filter)) return null;
  if (typeof text !== 'string' || text.length > 4096 || text.includes('\0')) return null;
  return { filter: filter as BacklogListRequest['filter'], text };
}

function readBacklogCard(v: unknown): BacklogCardDto {
  const o = asObject(v);
  const optional = (key: string): { [k: string]: string } => (hasOwn(o, key) ? { [key]: asString(o[key]) } : {});
  const checked = asBool(o['checked']);
  const taken = hasOwn(o, 'taken') ? asString(o['taken']) : undefined;
  const review = hasOwn(o, 'review') ? asString(o['review']) : undefined;
  // `backlogState` (work/board-card.ts): checked -> done; no taken mark -> backlog; taken without a review mark -> in-progress.
  const expected = checked ? 'done' : taken === undefined ? 'backlog' : review === undefined ? 'in-progress' : 'review';
  if (o['state'] !== expected) shape();
  return {
    id: asStringOrNull(o['id']),
    title: asString(o['title']),
    details: asString(o['details']),
    checked,
    section: asStringOrNull(o['section']),
    ...optional('taken'), ...optional('done'), ...optional('by'), ...optional('created'), ...optional('sent'), ...optional('review'),
    state: expected,
    unknownFields: rest(o, ['id', 'title', 'details', 'checked', 'section', 'taken', 'done', 'by', 'created', 'sent', 'review', 'state']),
  } as BacklogCardDto;
}

function readBacklogSuggestion(v: unknown): BacklogSuggestionDto {
  const o = asObject(v);
  return {
    id: asString(o['id']), kind: asString(o['kind']), title: asString(o['title']), details: asString(o['details']), why: asString(o['why']),
    workId: asString(o['workId']), sessionId: asString(o['sessionId']),
    unknownFields: rest(o, ['id', 'kind', 'title', 'details', 'why', 'workId', 'sessionId']),
  };
}

/**
 * Decodes the result of one `backlog_list` call. `args` are the ORIGINAL request arguments (they decide which cards a
 * response may contain); `mcpResult` is the strict MCP result the broker settled. Pure.
 *
 * Checks beyond the shape: every card passes the requested filter (`all`; `done` = checked; `taken` = unchecked with a taken
 * mark; `open` = unchecked) and the text (case-insensitive, over title, details and section) exactly as the handler selects
 * them; `state` is the one `backlogState` computes from the card; card ids and suggestion ids are unique (the parser and the
 * local state validator guarantee it). Suggestions are all pending ones, they do not follow the filter.
 *
 * The assessment of every success is `unknown`: board metadata (created, sent, review) comes from `board.json`, and a
 * malformed one is read as empty metadata without any mark, which also turns a card in review into `in-progress`. Nothing in
 * the response shows that the file was read. Cards, titles, details and suggestions are never shortened (an oversize backlog
 * is a thrown error). A tool error keeps its whole original result and is `unknown` too.
 */
export function decodeBacklogList(args: unknown, mcpResult: unknown): Decoded<BacklogListValue> {
  return run<BacklogListValue>(mcpResult, (text) => {
    const request = selectBacklogListRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    let parsed: JsonValue;
    try {
      parsed = parseStrictJson(text, TEXT_LIMITS);
    } catch (error) {
      if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
      throw error;
    }
    const top = asObject(parsed);
    const version = asString(top['version']);
    const items = asArray(top['items']).map(readBacklogCard);
    const suggestions = asArray(top['suggestions']).map(readBacklogSuggestion);
    const rule = asString(top['rule']);
    const diagnostics = asArray(top['diagnostics']).map((raw): BacklogDiagnosticDto => {
      const o = asObject(raw);
      return { code: asString(o['code']), unknownFields: rest(o, ['code']) };
    });
    const ids = items.map((item) => item.id).filter((id): id is string => id !== null);
    if (new Set(ids).size !== ids.length || new Set(suggestions.map((row) => row.id)).size !== suggestions.length) shape();
    const needle = request.text.toLowerCase();
    for (const item of items) {
      const selected = request.filter === 'all' || (request.filter === 'done' ? item.checked : request.filter === 'taken' ? !item.checked && item.taken !== undefined : !item.checked);
      if (!selected) throw new Mismatch('echo-mismatch');
      if (needle !== '' && !`${item.title}\n${item.details}\n${item.section ?? ''}`.toLowerCase().includes(needle)) throw new Mismatch('echo-mismatch');
    }
    return {
      value: { version, items, suggestions, rule, diagnostics, unknownFields: rest(top, ['version', 'items', 'suggestions', 'rule', 'diagnostics']) },
      assessment: 'unknown',
    };
  });
}
