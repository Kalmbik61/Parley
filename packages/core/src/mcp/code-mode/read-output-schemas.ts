// The output contract of every decoded read method (plan T6c, T11 B0): what the guest receives, as JSON Schema. One frozen
// schema per method is the single source of three things: the generated declaration (`declarationsFor`), the runtime check
// of every delivered ReadResult (`createOutputContract` in broker.ts) and the output term of the catalogue revision.
//
// This module imports nothing at runtime, on purpose. catalog.ts loads it and validation.ts loads catalog.ts, so importing
// read-adapters.ts here would close a cycle. It also stays out of the sandboxed helper's graph (a test keeps it so).
//
// Shapes follow the DTOs of read-adapters.ts; `read-output-schemas.test.ts` proves they agree: the decoders' types are
// assignable to the generated declarations, the keys match the other way, and real handler values validate.
//
// Rules of the dialect here, all enforced by the guard or by a test:
// - Every object is closed, and modeled unknowns live in an explicit `unknownFields`, the only open node besides the
//   original result of a tool error. So the guest's type says exactly where `unknown` may appear.
// - `oneOf` members carry a `const` discriminator, or are a null next to one object (`nullable`), so members cannot overlap.
// - `history` and `artifacts` items are objects: the handler's HistoryEntry and Artifact are. The decoder types them as any
//   JSON and does not check this; a non-object fails the runtime check and becomes `invalid-output`, never a wrong type.

import type { InvalidOutputCode } from './read-adapters.js';

type Schema = Readonly<Record<string, unknown>>;

/**
 * sha256 of each adapter source file (T11 B0). A test compares each with its file, so editing a decoder is red until its file's pin
 * moves, and that moves `adapterRevision` of exactly the methods whose decoding runs that file, the catalogue revision and `apiRevision`.
 * Enforced by that test only: a deployed package has no sources to hash at run time. Per file, so a new adapter file (one per T11
 * read) never moves the revision of a method decoded elsewhere; one edit of read-adapters.ts, whose `run` and shape readers every
 * decoder uses, moves them all.
 */
export const ADAPTER_FILE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'read-adapters/memory-read.ts': '4da491ea6c5cfdc70fb92f2af5501174d42405cc553634b0c64c6a64897d9e27',
  'read-adapters/search-history.ts': 'e5836f88375d6e79d1a132d59939cb37e47e87d5d415b6d92185aff9dd31a8db',
  'read-adapters.ts': 'da6b22b222ee6dcfa47fb1873081aea98b213c4842a40d8eb74cdb12c2d70405',
  'read-adapters/attempt-status.ts': '6d6a65f83e0b3df531620b1d50bb7b892eb9cf67795f6eb4b74e2b275afb265d',
  'read-adapters/plan-tasks.ts': '72ee39d4f2f4890d1092a1cf3067032788590895cbb7b6255bc1c0122b24ac1d',
});

/**
 * The adapter source files each decoded method's decoding runs, relative to this directory (T11 B0.2): its own file first, then
 * 'read-adapters.ts'; the five are decoded in read-adapters.ts itself. A key here is a decoded method, nothing else.
 */
export const READ_ADAPTER_FILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  attempt_status: Object.freeze(['read-adapters/attempt-status.ts', 'read-adapters.ts']),
  backlog_list: Object.freeze(['read-adapters.ts']),
  get_map: Object.freeze(['read-adapters.ts']),
  list_roles: Object.freeze(['read-adapters.ts']),
  memory_read: Object.freeze(['read-adapters/memory-read.ts', 'read-adapters.ts']),
  plan_tasks: Object.freeze(['read-adapters/plan-tasks.ts', 'read-adapters.ts']),
  read_guide: Object.freeze(['read-adapters.ts']),
  read_room: Object.freeze(['read-adapters.ts']),
  search_history: Object.freeze(['read-adapters/search-history.ts', 'read-adapters.ts']),
});

/** `<file>@<sha256>` of each file joined with `+`, in order; undefined when a file has no pin. One file gives the single form. */
export function adapterRevisionFrom(files: readonly string[], pins: Readonly<Record<string, string>>): string | undefined {
  const parts = files.map((file) => (Object.hasOwn(pins, file) ? `${file}@${pins[file]!}` : undefined));
  return parts.length === 0 || parts.some((part) => part === undefined) ? undefined : parts.join('+');
}

/** The revision of the method's adapter source, or undefined for a method with no adapter. It moves when any file the decoder uses moves. */
export function adapterRevisionOf(method: string): string | undefined {
  return Object.hasOwn(READ_ADAPTER_FILES, method) ? adapterRevisionFrom(READ_ADAPTER_FILES[method]!, ADAPTER_FILE_SHA256) : undefined;
}

/** Equal to INVALID_OUTPUT_CODES of read-adapters.ts, which this module must not import at run time (a test compares them). */
const INVALID_CODES: readonly InvalidOutputCode[] = [
  'result-not-strict-json', 'unexpected-envelope', 'text-not-strict-json', 'unknown-request-branch',
  'shape-mismatch', 'echo-mismatch', 'page-invariant', 'decoder-fault',
];

const STRING: Schema = { type: 'string' };
const STRING_OR_NULL: Schema = { type: ['string', 'null'] };
const COUNT: Schema = { type: 'integer' };
const BOOL: Schema = { type: 'boolean' };
const STRINGS: Schema = { type: 'array', items: STRING };
/** Keys a decoder does not model, kept verbatim. Renders as `{ [key: string]: unknown }`. */
const UNKNOWN_FIELDS: Schema = { type: 'object', additionalProperties: true };
const CUT: Schema = { type: 'object', additionalProperties: COUNT };
const LITERAL = (value: string | number): Schema => ({ const: value });
const ONE_OF = (...values: readonly string[]): Schema => ({ enum: values });
const LIST = (items: Schema): Schema => ({ type: 'array', items });

/** A closed object: every property required except the `optional` ones. */
const closed = (properties: Readonly<Record<string, Schema>>, optional: readonly string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const nullable = (object: Schema): Schema => ({ oneOf: [{ type: 'null' }, object] });
/** A closed object with its `unknownFields`. */
const dto = (properties: Readonly<Record<string, Schema>>, optional: readonly string[] = []): Schema => closed({ ...properties, unknownFields: UNKNOWN_FIELDS }, optional);

const PAGE = dto({ total: { type: ['integer', 'null'] }, returned: COUNT, complete: BOOL, next: STRING_OR_NULL, bytes: COUNT, cut: COUNT });
const TEXT_PAGE: Readonly<Record<string, Schema>> = { text: STRING, offset: COUNT, bytes: COUNT, totalBytes: COUNT, sha256: STRING, complete: BOOL, next: STRING_OR_NULL };
/** Items of the two session lists: see the rule at the top of this file. */
const SESSION_ITEMS = LIST({ type: 'object', additionalProperties: true });
const ROW = dto({ id: STRING });
const COLLECTION_ROW = dto({ id: STRING, rev: COUNT, status: STRING, roomId: STRING, itemCount: COUNT, count: COUNT }, ['rev', 'status', 'roomId', 'itemCount', 'count']);
const MESSAGE_ROOM = nullable(dto({ id: STRING, title: STRING }));
const MESSAGE_FIELDS: Readonly<Record<string, Schema>> = { id: STRING, from: STRING, fromLabel: STRING, at: STRING, text: STRING, kind: STRING, room: MESSAGE_ROOM, replyTo: STRING, toEveryone: BOOL };

const GET_MAP_VALUE: Schema = {
  oneOf: [
    dto({
      branch: LITERAL('map'),
      sessionId: STRING_OR_NULL,
      map: dto({
        schemaVersion: LITERAL(3),
        work: dto({ id: STRING, cut: CUT, deletedSessions: STRINGS, closeFinished: BOOL }, ['cut', 'closeFinished']),
        sessions: LIST(ROW),
        rooms: LIST(ROW),
        plans: LIST(COLLECTION_ROW),
        messages: dto({
          total: COUNT,
          latestId: STRING_OR_NULL,
          direct: dto({ total: COUNT, latestId: STRING_OR_NULL }),
          unreadForYou: dto({ total: COUNT, rooms: { type: 'object', additionalProperties: COUNT }, direct: COUNT }),
        }),
        collections: dto({ sessions: PAGE, rooms: PAGE, plans: PAGE, deletedSessions: PAGE, unreadRooms: PAGE }),
        pages: STRING,
        note: STRING,
      }),
    }),
    dto({
      branch: LITERAL('session'),
      session: dto({ id: STRING, historyCount: COUNT, artifactCount: COUNT, history: SESSION_ITEMS, artifacts: SESSION_ITEMS, cut: CUT }, ['cut']),
    }),
    dto({
      branch: LITERAL('room'),
      room: dto({ id: STRING, recipe: nullable(dto({ id: STRING, name: STRING })) }),
      messages: dto({ total: COUNT, latestId: STRING_OR_NULL, unreadForYou: COUNT }),
    }),
    dto({ branch: LITERAL('work-text'), field: ONE_OF('goal', 'title'), ...TEXT_PAGE }),
    dto({ branch: LITERAL('providers'), providers: LIST(dto({ id: STRING, label: STRING, available: BOOL })), note: STRING }, ['note']),
    dto({ branch: LITERAL('archive'), workspaces: LIST(dto({ id: STRING, title: STRING, status: STRING, updatedAt: STRING })), page: PAGE }),
    dto({ branch: LITERAL('summaries'), summaries: LIST(dto({ id: STRING, text: STRING, textBytes: COUNT }, ['textBytes'])), page: PAGE }),
    dto({ branch: LITERAL('messages'), messages: LIST(dto(MESSAGE_FIELDS, ['replyTo', 'toEveryone'])), page: PAGE }),
    dto({ branch: LITERAL('message'), id: STRING, from: STRING, at: STRING, roomId: STRING_OR_NULL, ...TEXT_PAGE }),
    dto({ branch: LITERAL('session-text'), session: STRING, field: ONE_OF('task', 'summary'), ...TEXT_PAGE }),
    dto({ branch: LITERAL('context-from'), session: STRING, field: LITERAL('contextFrom'), contextFrom: STRINGS }),
    dto({ branch: LITERAL('history'), session: STRING, field: LITERAL('history'), history: SESSION_ITEMS, page: PAGE }),
    dto({ branch: LITERAL('artifacts'), session: STRING, field: LITERAL('artifacts'), artifacts: SESSION_ITEMS, page: PAGE }),
    dto({ branch: LITERAL('collection'), field: ONE_OF('sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms'), items: LIST(COLLECTION_ROW), page: PAGE }),
    dto({ branch: LITERAL('plan'), field: LITERAL('plan'), id: STRING, rev: COUNT, status: STRING, format: LITERAL('json'), ...TEXT_PAGE }),
  ],
};

const READ_ROOM_VALUE = dto({ messages: LIST(dto({ ...MESSAGE_FIELDS, textBytes: COUNT }, ['replyTo', 'toEveryone', 'textBytes'])), page: PAGE });

const READ_GUIDE_VALUE = closed({ text: STRING });

const LIST_ROLES_VALUE = dto({
  roles: LIST(dto({
    id: STRING, name: STRING, description: STRING, source: STRING, provider: STRING, model: STRING_OR_NULL, effort: STRING_OR_NULL, readOnly: BOOL,
    models: dto({ claude: STRING_OR_NULL, codex: STRING_OR_NULL }),
  }, ['models'])),
  partial: BOOL,
  diagnostics: LIST(dto({ source: STRING, code: STRING })),
});

const BACKLOG_LIST_VALUE = dto({
  version: STRING,
  items: LIST(dto({
    id: STRING_OR_NULL, title: STRING, details: STRING, checked: BOOL, section: STRING_OR_NULL,
    taken: STRING, done: STRING, by: STRING, created: STRING, sent: STRING, review: STRING,
    state: ONE_OF('backlog', 'in-progress', 'review', 'done'),
  }, ['taken', 'done', 'by', 'created', 'sent', 'review'])),
  suggestions: LIST(dto({ id: STRING, kind: STRING, title: STRING, details: STRING, why: STRING, workId: STRING, sessionId: STRING })),
  rule: STRING,
  diagnostics: LIST(dto({ code: STRING })),
});

/**
 * `ReadResult<T>`. The original result of a tool error is an open approximation: it declares only what the decoder
 * guarantees (`isError: true`), and the runtime carries the whole strict object unchanged.
 */
const readResult = (value: Schema): Schema => ({
  oneOf: [
    closed({ ok: LITERAL_TRUE, value }),
    closed({
      ok: LITERAL_FALSE,
      error: {
        oneOf: [
          closed({ kind: LITERAL('tool-error'), result: { type: 'object', properties: { isError: LITERAL_TRUE }, required: ['isError'], additionalProperties: true } }),
          closed({ kind: LITERAL('invalid-output'), code: ONE_OF(...INVALID_CODES) }),
        ],
      },
    }),
  ],
});
const LITERAL_TRUE: Schema = { const: true };
const LITERAL_FALSE: Schema = { const: false };

const NUMBER_OR_NULL: Schema = { type: ['integer', 'null'] };
/** Copies of the closed sets of read-adapters/plan-tasks.ts and attempt-status.ts; a test keeps each equal to its source. */
const ATTEMPT_STATUSES = ['starting', 'running', 'submitted', 'checking', 'accepted', 'queued', 'integrated', 'returned', 'blocked', 'aborted', 'superseded'] as const;
const PLAN_TASK_ROLES = ['owner', 'verifier', 'lead'] as const;
const PLAN_TASK_ACTIONS = ['start', 'continue', 'rework', 'verify', 'resolve-block', 'wait', 'propose-completion'] as const;
const PLAN_MODES = ['checklist', 'verified', 'autonomous'] as const;
const PLAN_ITEM_STATUSES = ['waiting', 'ready', 'in_progress', 'done', 'blocked', 'verified', 'returned'] as const;
const PLAN_STATUSES = ['proposed', 'active', 'completing', 'completed', 'cancelled'] as const;
const WAITING_FOR_KINDS = ['blocked', 'dependencies', 'verification', 'submission'] as const;

const ATTEMPT_VIEW = dto({
  id: STRING, item: COUNT, n: COUNT, planRev: COUNT, criteriaVersion: COUNT, status: ONE_OF(...ATTEMPT_STATUSES),
  worker: STRING_OR_NULL, verifier: STRING_OR_NULL, sha: STRING_OR_NULL, receipt: nullable(dto({ id: STRING, valid: BOOL })),
  checks: COUNT, startedAt: STRING, endedAt: STRING_OR_NULL,
});
const ATTEMPT_STATUS_VALUE: Schema = {
  oneOf: [
    dto({ branch: LITERAL('list'), planId: STRING, attempts: LIST(ATTEMPT_VIEW), page: PAGE }),
    dto({ branch: LITERAL('attempt'), planId: STRING, attemptId: STRING, ...TEXT_PAGE }),
  ],
};

const PLAN_CHECKPOINT = dto({ by: STRING, at: STRING, submission: NUMBER_OR_NULL, done: STRING, next: STRING, artifacts: STRINGS, blocker: STRING_OR_NULL, stale: LITERAL_TRUE }, ['stale']);
const PLAN_EVIDENCE = dto({ text: STRING, artifacts: STRINGS });
const PLAN_LOG = dto({ at: STRING, by: STRING, status: ONE_OF(...PLAN_ITEM_STATUSES), note: STRING_OR_NULL });
const PLAN_TASKS_VALUE = dto({
  session: STRING,
  total: COUNT,
  assignments: LIST(dto({
    planId: STRING, rev: COUNT, room: STRING, roomTitle: STRING, mode: ONE_OF(...PLAN_MODES), item: NUMBER_OR_NULL, title: STRING,
    role: ONE_OF(...PLAN_TASK_ROLES), status: ONE_OF(...PLAN_ITEM_STATUSES, ...PLAN_STATUSES), action: ONE_OF(...PLAN_TASK_ACTIONS),
    waitingFor: nullable(dto({ kind: ONE_OF(...WAITING_FOR_KINDS), note: STRING_OR_NULL, items: LIST(COUNT), by: STRING_OR_NULL }, ['note', 'items', 'by'])),
    scope: STRING_OR_NULL, criteria: STRINGS, evidence: nullable(PLAN_EVIDENCE), note: STRING_OR_NULL, checkpoint: nullable(PLAN_CHECKPOINT),
    submission: NUMBER_OR_NULL, lastLog: nullable(PLAN_LOG),
  })),
  finished: dto({ count: COUNT, items: LIST(dto({ planId: STRING, item: COUNT, title: STRING, role: ONE_OF('owner', 'verifier') })) }),
  next: STRING_OR_NULL,
  detail: dto({
    planId: STRING, rev: COUNT, room: STRING, mode: ONE_OF(...PLAN_MODES), item: COUNT, title: STRING, owner: STRING, verifier: STRING_OR_NULL,
    status: ONE_OF(...PLAN_ITEM_STATUSES), after: LIST(COUNT), scope: STRING, criteria: STRINGS, evidence: nullable(PLAN_EVIDENCE), note: STRING_OR_NULL,
    submission: NUMBER_OR_NULL, log: LIST(PLAN_LOG), progress: dto({ owner: nullable(PLAN_CHECKPOINT), verifier: nullable(PLAN_CHECKPOINT) }),
  }),
}, ['detail']);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const MEMORY_READ_VALUE = dto({
  items: LIST(dto({
    id: STRING_OR_NULL, kind: ONE_OF('fact', 'lesson', 'agreement'), fact: STRING, details: STRING, state: ONE_OF('current', 'superseded'), by: STRING,
    onRequest: LITERAL_TRUE,
  }, ['onRequest'])),
  total: COUNT,
  truncated: LITERAL_TRUE,
}, ['truncated']);

/** `SOURCES` of work/history-search.ts, and the scopes: the sources and `all` (a test compares them with read-adapters/search-history.ts). */
const HISTORY_SOURCES = ['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions'] as const;
const SEARCH_HISTORY_VALUE = dto({
  query: STRING, scope: ONE_OF(...HISTORY_SOURCES, 'all'), limit: COUNT, total: COUNT,
  hits: LIST(dto({
    source: ONE_OF(...HISTORY_SOURCES), title: STRING, excerpt: STRING, date: STRING_OR_NULL, file: STRING, line: COUNT, id: STRING, workId: STRING,
    roomId: STRING, sessionId: STRING, state: STRING, shared: LITERAL_TRUE, alsoShared: LITERAL_TRUE, complete: BOOL, length: COUNT, hash: STRING,
  }, ['file', 'line', 'id', 'workId', 'roomId', 'sessionId', 'state', 'shared', 'alsoShared'])),
  unavailable: STRINGS,
  message: STRING,
}, ['message']);

/** The output schema of each decoded method. A key here is a decoded method, nothing else. */
export const READ_OUTPUT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = deepFreeze({
  attempt_status: readResult(ATTEMPT_STATUS_VALUE),
  get_map: readResult(GET_MAP_VALUE),
  read_room: readResult(READ_ROOM_VALUE),
  read_guide: readResult(READ_GUIDE_VALUE),
  list_roles: readResult(LIST_ROLES_VALUE),
  backlog_list: readResult(BACKLOG_LIST_VALUE),
  memory_read: readResult(MEMORY_READ_VALUE),
  search_history: readResult(SEARCH_HISTORY_VALUE),
  plan_tasks: readResult(PLAN_TASKS_VALUE),
});
