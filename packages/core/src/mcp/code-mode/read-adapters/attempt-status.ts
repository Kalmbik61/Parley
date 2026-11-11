// Code Mode read adapter for `attempt_status` (plan T11 R2). Standalone decoder; the broker reaches it through read-adapter-table.ts.
// The two response forms of the handler (mcp/attempt-tools.ts) are chosen from the REQUEST: no `attemptId` is the list of attempt cards
// (a sequence page), an `attemptId` is the full attempt as JSON text in a text page. The rules of read-adapters.ts hold here too:
// `isError` stays `tool-error`, a malformed shape is `invalid-output` with assessment `unknown`, unmodeled fields stay in `unknownFields`.

import {
  Mismatch,
  TEXT_LIMITS,
  asArray,
  asBool,
  asCount,
  asObject,
  asString,
  asStringOrNull,
  echo,
  readPage,
  readTextPage,
  rest,
  run,
  type Assessment,
  type Decoded,
  type PageInfoDto,
  type TextPageDto,
  type Unmodeled,
} from '../read-adapters.js';
import { StrictJsonError, parseStrictJson, type JsonValue } from '../validation.js';

/** `PlanAttempt['status']` of work/types.ts; the output schema keeps its own copy and a test keeps the three equal. */
export const ATTEMPT_STATUS_VALUES = Object.freeze([
  'starting', 'running', 'submitted', 'checking', 'accepted', 'queued', 'integrated', 'returned', 'blocked', 'aborted', 'superseded',
] as const);
export type AttemptStatus = (typeof ATTEMPT_STATUS_VALUES)[number];

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);
const PLAN_ID = /^pl-\d+$/;
const ATTEMPT_ID = /^at-\d+$/;
const PAGE_CURSOR = /^(before|after):(\d{1,12})$/;

export interface AttemptReceiptView extends Unmodeled {
  readonly id: string;
  readonly valid: boolean;
}

export interface AttemptView extends Unmodeled {
  readonly id: string;
  readonly item: number;
  readonly n: number;
  readonly planRev: number;
  readonly criteriaVersion: number;
  readonly status: AttemptStatus;
  readonly worker: string | null;
  readonly verifier: string | null;
  readonly sha: string | null;
  readonly receipt: AttemptReceiptView | null;
  /** How many checks the attempt has (the handler sends the count, not the checks). */
  readonly checks: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface AttemptListValue extends Unmodeled {
  readonly branch: 'list';
  readonly planId: string;
  readonly attempts: readonly AttemptView[];
  readonly page: PageInfoDto;
}

export interface AttemptDetailValue extends TextPageDto {
  readonly branch: 'attempt';
  readonly planId: string;
  readonly attemptId: string;
}

export type AttemptStatusValue = AttemptListValue | AttemptDetailValue;

export interface AttemptStatusRequest {
  /** `null`: the list of attempt cards. */
  readonly attemptId: string | null;
  /** The list cursor (`before:N` / `after:N`); `null` for no cursor and always `null` in the detail form (there it is a text cursor). */
  readonly cursor: { readonly dir: 'before' | 'after'; readonly seq: number } | null;
}

/**
 * What the `attempt_status` handler would do with the request: only `attemptId`, `cursor` and `maxBytes` are allowed (anything
 * else is `unexpected attempt argument`); `attemptId` absent or a string, `cursor` absent or a string, `maxBytes` absent or a
 * finite number (the handler clamps it, so a stricter selector could refuse a valid call). In the list form a cursor is empty or
 * `before:N` / `after:N`; in the detail form it is the handler's text cursor, which the page itself proves. Never looks at a response.
 */
export function selectAttemptStatusRequest(args: unknown): AttemptStatusRequest | null {
  if (args === undefined) return { attemptId: null, cursor: null };
  if (!isRecord(args)) return null;
  for (const key of Object.keys(args)) if (key !== 'attemptId' && key !== 'cursor' && key !== 'maxBytes') return null;
  const attemptId = args['attemptId'];
  if (attemptId !== undefined && typeof attemptId !== 'string') return null;
  const raw = args['cursor'];
  if (raw !== undefined && typeof raw !== 'string') return null;
  const maxBytes = args['maxBytes'];
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes))) return null;
  if (attemptId !== undefined) return { attemptId, cursor: null };
  if (raw === undefined || raw === '') return { attemptId: null, cursor: null };
  const match = PAGE_CURSOR.exec(raw);
  if (match === null) return null;
  return { attemptId: null, cursor: { dir: match[1] === 'after' ? 'after' : 'before', seq: Number(match[2]) } };
}

/** `value` when it is one of `values`, else a shape mismatch; the result is narrowed to the member. */
function oneOf<T extends string>(value: string, values: readonly T[]): T {
  return (values as readonly string[]).includes(value) ? (value as T) : shapeError();
}
function shapeError(): never {
  throw new Mismatch('shape-mismatch');
}

const attemptSeq = (id: string): number => {
  const seq = ATTEMPT_ID.test(id) ? Number(id.slice(3)) : 0;
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Mismatch('shape-mismatch');
  return seq;
};

function readReceipt(v: unknown): AttemptReceiptView | null {
  if (v === null) return null;
  const o = asObject(v);
  return { id: asString(o['id']), valid: asBool(o['valid']), unknownFields: rest(o, ['id', 'valid']) };
}

function readAttemptView(v: unknown): AttemptView {
  const o = asObject(v);
  const status = oneOf(asString(o['status']), ATTEMPT_STATUS_VALUES);
  const id = asString(o['id']);
  attemptSeq(id);
  return {
    id,
    item: asCount(o['item']),
    n: asCount(o['n']),
    planRev: asCount(o['planRev']),
    criteriaVersion: asCount(o['criteriaVersion']),
    status,
    worker: asStringOrNull(o['worker']),
    verifier: asStringOrNull(o['verifier']),
    sha: asStringOrNull(o['sha']),
    receipt: readReceipt(o['receipt']),
    checks: asCount(o['checks']),
    startedAt: asString(o['startedAt']),
    endedAt: asStringOrNull(o['endedAt']),
    unknownFields: rest(o, ['id', 'item', 'n', 'planRev', 'criteriaVersion', 'status', 'worker', 'verifier', 'sha', 'receipt', 'checks', 'startedAt', 'endedAt']),
  };
}

function parseText(text: string): JsonValue {
  try {
    return parseStrictJson(text, TEXT_LIMITS);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new Mismatch('text-not-strict-json');
    throw error;
  }
}

function decodeList(top: { readonly [key: string]: JsonValue }, request: AttemptStatusRequest, planId: string): { value: AttemptListValue; assessment: Assessment } {
  const attempts = asArray(top['attempts']).map(readAttemptView);
  const { page, assessment } = readPage(top['page'], attempts.length);
  if (page.total === null) throw new Mismatch('shape-mismatch');
  // Like every sequence page: ids ascend strictly; `before:N` returns only older, `after:N` only newer attempts; `next` continues
  // from the far edge in the request's direction (no cursor reads backwards from the newest).
  const seqs = attempts.map((attempt) => attemptSeq(attempt.id));
  for (let i = 1; i < seqs.length; i++) if (seqs[i]! <= seqs[i - 1]!) throw new Mismatch('page-invariant');
  const { cursor } = request;
  if (cursor !== null && seqs.some((seq) => (cursor.dir === 'after' ? seq <= cursor.seq : seq >= cursor.seq))) throw new Mismatch('page-invariant');
  if (page.next !== null) {
    if (seqs.length === 0) throw new Mismatch('page-invariant');
    const expected = cursor?.dir === 'after' ? `after:${seqs[seqs.length - 1]}` : `before:${seqs[0]}`;
    if (page.next !== expected) throw new Mismatch('page-invariant');
  }
  return { value: { branch: 'list', planId, attempts, page, unknownFields: rest(top, ['planId', 'attempts', 'page']) }, assessment };
}

function decodeDetail(top: { readonly [key: string]: JsonValue }, request: AttemptStatusRequest, planId: string): { value: AttemptDetailValue; assessment: Assessment } {
  const attemptId = asString(top['attemptId']);
  echo(attemptId, request.attemptId);
  const { page, assessment } = readTextPage(top, ['planId', 'attemptId']);
  // The text of an attempt is its JSON. A whole text (first page, complete) has to be that object; a chunk of a longer one is
  // kept verbatim and never parsed.
  if (page.complete && page.offset === 0) {
    const attempt = asObject(parseText(page.text));
    echo(attempt['id'], attemptId);
  }
  return { value: { branch: 'attempt', planId, attemptId, ...page }, assessment };
}

/**
 * Decodes the result of one `attempt_status` call. `args` are the ORIGINAL request arguments (they decide the response form, the
 * echo and the cursor direction); `mcpResult` is the strict MCP result the broker settled. Pure. A list is `partial` when its page
 * says it is not complete or shortened a card; a detail page is `partial` when more text follows; otherwise `complete`.
 */
export function decodeAttemptStatus(args: unknown, mcpResult: unknown): Decoded<AttemptStatusValue> {
  return run<AttemptStatusValue>(mcpResult, (text) => {
    const request = selectAttemptStatusRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    const top = asObject(parseText(text));
    const planId = asString(top['planId']);
    if (!PLAN_ID.test(planId)) throw new Mismatch('shape-mismatch');
    return request.attemptId === null ? decodeList(top, request, planId) : decodeDetail(top, request, planId);
  });
}
