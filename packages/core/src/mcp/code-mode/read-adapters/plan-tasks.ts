// Code Mode read adapter for `plan_tasks` (plan T11 R2). Standalone decoder; the broker reaches it through read-adapter-table.ts.
// The handler (mcp/plan-tasks.ts over work/plan-tasks.ts) has one response form with an optional `detail`, chosen by the request:
// no `planId` is the caller's list, `planId` narrows it to one plan, `planId` and `item` add the one item in full. The rules of
// read-adapters.ts hold here too: `isError` stays `tool-error`, a malformed shape is `invalid-output` with assessment `unknown`,
// unmodeled fields stay in `unknownFields`, `partial` needs a structured mark of omission.
//
// The marks (all structured): the page cursor `next`; a first page whose `finished.items` is shorter than `finished.count`; a text
// shortened by `markedExcerpt`, which ends with its fixed suffix naming the full size (code-emitted, not prose; a test round-trips
// the real builder through `CUT_SUFFIX`); the lists the handler caps without a mark of their own, which count as partial at the cap
// (evidence artifacts at 10, the item log at 10). A text that merely ends with the suffix reads `partial` too: that errs toward
// incomplete and is named in the evidence.

import {
  Mismatch,
  TEXT_LIMITS,
  asArray,
  asCount,
  asCountOrNull,
  asObject,
  asString,
  asStringOrNull,
  asStrings,
  echo,
  rest,
  run,
  type Assessment,
  type Decoded,
  type Unmodeled,
} from '../read-adapters.js';
import { StrictJsonError, parseStrictJson, type JsonValue } from '../validation.js';

const isRecord = (v: unknown): v is { readonly [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = Object.hasOwn;

/** What `markedExcerpt` (work/context-budget.ts) appends to a shortened text. A test round-trips its real output through this. */
export const CUT_SUFFIX = /… \[cut: \d+ bytes in full\]$/;
/** The caps of work/plan-tasks.ts that leave no mark of their own: a list at its cap may have been cut. */
export const EVIDENCE_ARTIFACTS_CAP = 10;
export const DETAIL_LOG_CAP = 10;
/** `FINISHED_ITEMS` of work/plan-tasks.ts: how many finished items the first page names. */
export const FINISHED_ITEMS_CAP = 30;

export const PLAN_TASK_ROLES = Object.freeze(['owner', 'verifier', 'lead'] as const);
export type PlanTaskRole = (typeof PLAN_TASK_ROLES)[number];
export const PLAN_TASK_ACTIONS = Object.freeze(['start', 'continue', 'rework', 'verify', 'resolve-block', 'wait', 'propose-completion'] as const);
export type PlanTaskAction = (typeof PLAN_TASK_ACTIONS)[number];
export const PLAN_MODES = Object.freeze(['checklist', 'verified', 'autonomous'] as const);
export type PlanModeValue = (typeof PLAN_MODES)[number];
export const PLAN_ITEM_STATUSES = Object.freeze(['waiting', 'ready', 'in_progress', 'done', 'blocked', 'verified', 'returned'] as const);
export type PlanItemStatusValue = (typeof PLAN_ITEM_STATUSES)[number];
export const PLAN_STATUSES = Object.freeze(['proposed', 'active', 'completing', 'completed', 'cancelled'] as const);
export type PlanStatusValue = (typeof PLAN_STATUSES)[number];
export const WAITING_FOR_KINDS = Object.freeze(['blocked', 'dependencies', 'verification', 'submission'] as const);
export type WaitingForKind = (typeof WAITING_FOR_KINDS)[number];

const PLAN_ID = /^pl-\d+$/;
const NEXT_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export interface PlanTaskCheckpointView extends Unmodeled {
  readonly by: string;
  readonly at: string;
  readonly submission: number | null;
  readonly done: string;
  readonly next: string;
  readonly artifacts: readonly string[];
  readonly blocker: string | null;
  /** Only on a verifier's position that belongs to an earlier submission. */
  readonly stale?: true;
}
export interface PlanEvidenceView extends Unmodeled {
  readonly text: string;
  readonly artifacts: readonly string[];
}
export interface PlanLogView extends Unmodeled {
  readonly at: string;
  readonly by: string;
  readonly status: PlanItemStatusValue;
  readonly note: string | null;
}
export interface PlanWaitingForView extends Unmodeled {
  readonly kind: WaitingForKind;
  readonly note?: string | null;
  readonly items?: readonly number[];
  readonly by?: string | null;
}
export interface PlanTaskEntryView extends Unmodeled {
  readonly planId: string;
  readonly rev: number;
  readonly room: string;
  readonly roomTitle: string;
  readonly mode: PlanModeValue;
  /** `null`: the task is for the whole plan (`propose-completion`). */
  readonly item: number | null;
  readonly title: string;
  readonly role: PlanTaskRole;
  readonly status: PlanItemStatusValue | PlanStatusValue;
  readonly action: PlanTaskAction;
  readonly waitingFor: PlanWaitingForView | null;
  readonly scope: string | null;
  readonly criteria: readonly string[];
  readonly evidence: PlanEvidenceView | null;
  readonly note: string | null;
  readonly checkpoint: PlanTaskCheckpointView | null;
  readonly submission: number | null;
  readonly lastLog: PlanLogView | null;
}
export interface PlanFinishedView extends Unmodeled {
  readonly planId: string;
  readonly item: number;
  readonly title: string;
  readonly role: 'owner' | 'verifier';
}
export interface PlanItemDetailView extends Unmodeled {
  readonly planId: string;
  readonly rev: number;
  readonly room: string;
  readonly mode: PlanModeValue;
  readonly item: number;
  readonly title: string;
  readonly owner: string;
  readonly verifier: string | null;
  readonly status: PlanItemStatusValue;
  readonly after: readonly number[];
  readonly scope: string;
  readonly criteria: readonly string[];
  readonly evidence: PlanEvidenceView | null;
  readonly note: string | null;
  readonly submission: number | null;
  readonly log: readonly PlanLogView[];
  readonly progress: PlanProgressView;
}
export interface PlanProgressView extends Unmodeled {
  readonly owner: PlanTaskCheckpointView | null;
  readonly verifier: PlanTaskCheckpointView | null;
}
export interface PlanTasksValue extends Unmodeled {
  readonly session: string;
  readonly total: number;
  readonly assignments: readonly PlanTaskEntryView[];
  readonly finished: PlanFinishedBlock;
  readonly next: string | null;
  readonly detail?: PlanItemDetailView;
}
export interface PlanFinishedBlock extends Unmodeled {
  readonly count: number;
  readonly items: readonly PlanFinishedView[];
}

export interface PlanTasksRequest {
  readonly planId: string | null;
  readonly item: number | null;
  /** Whether a cursor was sent: the handler's cursor is opaque, so the decoder only knows there was one. */
  readonly hasCursor: boolean;
}

/**
 * What the `plan_tasks` handler would do with the request: only `planId`, `item` and `cursor` are allowed (anything else is
 * refused); `planId` absent or a string, `item` absent or a number, `cursor` absent or a string; `item` needs `planId`. The
 * handler's patterns (`pl-N`, a positive integer, a cursor of at most 256 characters) stay with the handler, so a valid call is
 * never refused here. Never looks at a response.
 */
export function selectPlanTasksRequest(args: unknown): PlanTasksRequest | null {
  if (args === undefined) return { planId: null, item: null, hasCursor: false };
  if (!isRecord(args)) return null;
  for (const key of Object.keys(args)) if (key !== 'planId' && key !== 'item' && key !== 'cursor') return null;
  const planId = args['planId'];
  if (planId !== undefined && typeof planId !== 'string') return null;
  const item = args['item'];
  if (item !== undefined && typeof item !== 'number') return null;
  const cursor = args['cursor'];
  if (cursor !== undefined && typeof cursor !== 'string') return null;
  if (item !== undefined && planId === undefined) return null;
  return { planId: planId ?? null, item: item ?? null, hasCursor: cursor !== undefined };
}

const oneOf = <T extends string>(value: string, values: readonly T[]): T => ((values as readonly string[]).includes(value) ? (value as T) : shapeError());
const shapeError = (): never => {
  throw new Mismatch('shape-mismatch');
};

/** Every decoded text goes through here, so one pass tells whether any text carries the cut suffix. */
class Marks {
  cut = false;
  text(value: string): string {
    if (CUT_SUFFIX.test(value)) this.cut = true;
    return value;
  }
  textOrNull(value: unknown): string | null {
    return value === null ? null : this.text(asString(value));
  }
}

function readCheckpoint(v: unknown): PlanTaskCheckpointView | null {
  if (v === null) return null;
  const o = asObject(v);
  return {
    by: asString(o['by']),
    at: asString(o['at']),
    submission: asCountOrNull(o['submission']),
    done: asString(o['done']),
    next: asString(o['next']),
    artifacts: asStrings(o['artifacts']),
    blocker: asStringOrNull(o['blocker']),
    ...(hasOwn(o, 'stale') ? { stale: o['stale'] === true ? (true as const) : shapeError() } : {}),
    unknownFields: rest(o, ['by', 'at', 'submission', 'done', 'next', 'artifacts', 'blocker', 'stale']),
  };
}

function readEvidence(v: unknown, marks: Marks | null): PlanEvidenceView | null {
  if (v === null) return null;
  const o = asObject(v);
  const text = marks === null ? asString(o['text']) : marks.text(asString(o['text']));
  const artifacts = asArray(o['artifacts']).map((path) => (marks === null ? asString(path) : marks.text(asString(path))));
  return { text, artifacts, unknownFields: rest(o, ['text', 'artifacts']) };
}

function readLog(v: unknown, marks: Marks | null): PlanLogView {
  const o = asObject(v);
  return {
    at: asString(o['at']),
    by: asString(o['by']),
    status: oneOf(asString(o['status']), PLAN_ITEM_STATUSES),
    note: marks === null ? asStringOrNull(o['note']) : marks.textOrNull(o['note']),
    unknownFields: rest(o, ['at', 'by', 'status', 'note']),
  };
}

function readWaitingFor(v: unknown): PlanWaitingForView | null {
  if (v === null) return null;
  const o = asObject(v);
  const kind = oneOf(asString(o['kind']), WAITING_FOR_KINDS);
  // `note` and `by` are the handler's own fields of the duty table (plan-state.ts): their text is never read as an omission.
  const known = ['kind'];
  const out: { kind: WaitingForKind; note?: string | null; items?: readonly number[]; by?: string | null } = { kind };
  if (kind === 'blocked') {
    known.push('note');
    out.note = asStringOrNull(o['note']);
  } else if (kind === 'dependencies') {
    known.push('items');
    out.items = asArray(o['items']).map(asCount);
  } else if (kind === 'verification') {
    known.push('by');
    out.by = asStringOrNull(o['by']);
  } else {
    known.push('by');
    out.by = asString(o['by']);
  }
  return { ...out, unknownFields: rest(o, known) };
}

function readEntry(v: unknown, marks: Marks): PlanTaskEntryView {
  const o = asObject(v);
  const planId = asString(o['planId']);
  if (!PLAN_ID.test(planId)) shapeError();
  const item = o['item'] === null ? null : asCount(o['item']);
  if (item !== null && item < 1) shapeError();
  const role = oneOf(asString(o['role']), PLAN_TASK_ROLES);
  const statusText = asString(o['status']);
  const status: PlanItemStatusValue | PlanStatusValue = (PLAN_ITEM_STATUSES as readonly string[]).includes(statusText) ? (statusText as PlanItemStatusValue) : oneOf(statusText, PLAN_STATUSES);
  return {
    planId,
    rev: asCount(o['rev']),
    room: asString(o['room']),
    roomTitle: marks.text(asString(o['roomTitle'])),
    mode: oneOf(asString(o['mode']), PLAN_MODES),
    item,
    title: marks.text(asString(o['title'])),
    role,
    status,
    action: oneOf(asString(o['action']), PLAN_TASK_ACTIONS),
    waitingFor: readWaitingFor(o['waitingFor']),
    scope: marks.textOrNull(o['scope']),
    criteria: asArray(o['criteria']).map((c) => marks.text(asString(c))),
    evidence: readEvidence(o['evidence'], marks),
    note: marks.textOrNull(o['note']),
    checkpoint: readCheckpoint(o['checkpoint']),
    submission: asCountOrNull(o['submission']),
    lastLog: o['lastLog'] === null ? null : readLog(o['lastLog'], marks),
    unknownFields: rest(o, ['planId', 'rev', 'room', 'roomTitle', 'mode', 'item', 'title', 'role', 'status', 'action', 'waitingFor', 'scope', 'criteria', 'evidence', 'note', 'checkpoint', 'submission', 'lastLog']),
  };
}

function readFinishedItem(v: unknown, marks: Marks): PlanFinishedView {
  const o = asObject(v);
  const planId = asString(o['planId']);
  if (!PLAN_ID.test(planId)) shapeError();
  const item = asCount(o['item']);
  if (item < 1) shapeError();
  const roleText = asString(o['role']);
  const role = roleText === 'owner' || roleText === 'verifier' ? roleText : shapeError();
  return { planId, item, title: marks.text(asString(o['title'])), role, unknownFields: rest(o, ['planId', 'item', 'title', 'role']) };
}

function readDetail(v: unknown): PlanItemDetailView {
  const o = asObject(v);
  const planId = asString(o['planId']);
  if (!PLAN_ID.test(planId)) shapeError();
  const progress = asObject(o['progress']);
  const item = asCount(o['item']);
  if (item < 1) shapeError();
  return {
    planId,
    rev: asCount(o['rev']),
    room: asString(o['room']),
    mode: oneOf(asString(o['mode']), PLAN_MODES),
    item,
    title: asString(o['title']),
    owner: asString(o['owner']),
    verifier: asStringOrNull(o['verifier']),
    status: oneOf(asString(o['status']), PLAN_ITEM_STATUSES),
    after: asArray(o['after']).map(asCount),
    scope: asString(o['scope']),
    criteria: asStrings(o['criteria']),
    evidence: readEvidence(o['evidence'], null),
    note: asStringOrNull(o['note']),
    submission: asCountOrNull(o['submission']),
    log: asArray(o['log']).map((entry) => readLog(entry, null)),
    progress: { owner: readCheckpoint(progress['owner']), verifier: readCheckpoint(progress['verifier']), unknownFields: rest(progress, ['owner', 'verifier']) },
    unknownFields: rest(o, ['planId', 'rev', 'room', 'mode', 'item', 'title', 'owner', 'verifier', 'status', 'after', 'scope', 'criteria', 'evidence', 'note', 'submission', 'log', 'progress']),
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

/**
 * Decodes the result of one `plan_tasks` call. `args` are the ORIGINAL request arguments (they decide whether a `detail` is
 * expected, which plan and item the list is for, and whether the first-page rules hold); `mcpResult` is the strict MCP result the
 * broker settled. Pure.
 *
 * Checked against the request and against itself: `total` is at least the page; without a cursor `next` is null exactly when the
 * page holds all `total` entries (with a cursor the offset is the handler's opaque cursor, so only the page size is bounded);
 * `next`, when present, is a base64url cursor on a non-empty page; the finished names are the first `FINISHED_ITEMS_CAP` on a first
 * page and absent otherwise; `detail` is present exactly for the `planId` + `item` request and echoes it; every entry belongs to
 * the requested plan and item. Assessment: `partial` on any mark listed at the top of this file, otherwise `complete`.
 */
export function decodePlanTasks(args: unknown, mcpResult: unknown): Decoded<PlanTasksValue> {
  return run<PlanTasksValue>(mcpResult, (text) => {
    const request = selectPlanTasksRequest(args);
    if (request === null) throw new Mismatch('unknown-request-branch');
    const top = asObject(parseText(text));
    const marks = new Marks();
    const session = asString(top['session']);
    if (session === '') shapeError();
    const total = asCount(top['total']);
    const assignments = asArray(top['assignments']).map((entry) => readEntry(entry, marks));
    const finishedTop = asObject(top['finished']);
    const finished: PlanFinishedBlock = {
      count: asCount(finishedTop['count']),
      items: asArray(finishedTop['items']).map((entry) => readFinishedItem(entry, marks)),
      unknownFields: rest(finishedTop, ['count', 'items']),
    };
    const next = asStringOrNull(top['next']);
    const detail = hasOwn(top, 'detail') ? readDetail(top['detail']) : undefined;

    if (assignments.length > total) throw new Mismatch('page-invariant');
    if (next !== null && !NEXT_CURSOR.test(next)) throw new Mismatch('page-invariant');
    if (next !== null && (assignments.length === 0 || assignments.length >= total)) throw new Mismatch('page-invariant');
    if (!request.hasCursor && next === null && assignments.length !== total) throw new Mismatch('page-invariant');
    const firstPageNames = Math.min(finished.count, FINISHED_ITEMS_CAP);
    if (request.hasCursor ? finished.items.length !== 0 && finished.items.length !== firstPageNames : finished.items.length !== firstPageNames) throw new Mismatch('page-invariant');

    if ((detail !== undefined) !== (request.item !== null)) throw new Mismatch('page-invariant');
    if (request.planId !== null) for (const entry of assignments) echo(entry.planId, request.planId);
    if (request.item !== null) for (const entry of assignments) echo(entry.item, request.item);
    if (detail !== undefined) {
      echo(detail.planId, request.planId);
      echo(detail.item, request.item);
    }

    const capped =
      assignments.some((entry) => entry.evidence !== null && entry.evidence.artifacts.length >= EVIDENCE_ARTIFACTS_CAP) ||
      (detail !== undefined && detail.log.length >= DETAIL_LOG_CAP);
    const firstPageCut = finished.items.length > 0 && finished.count > finished.items.length;
    const assessment: Assessment = next !== null || firstPageCut || marks.cut || capped ? 'partial' : 'complete';
    const value: PlanTasksValue = {
      session,
      total,
      assignments,
      finished,
      next,
      ...(detail === undefined ? {} : { detail }),
      unknownFields: rest(top, ['session', 'total', 'assignments', 'finished', 'next', 'detail']),
    };
    return { value, assessment };
  });
}
