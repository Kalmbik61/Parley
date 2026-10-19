/**
 * Личный список заданий комнаты: «что мне делать по принятым планам и чего я жду». Чистое чтение карты.
 *
 * Свой расчёт «кто должен действовать» здесь не заводится: таблица действий живёт в `planItemDuties`
 * (`plan-state.ts`), а этот модуль добавляет к ней охват (членство, открытая комната, живой лид), тексты
 * с границами и страницы. Карту функция не меняет и своих статусов не хранит.
 */
import { createHash } from 'node:crypto';
import { markedExcerpt } from './context-budget.js';
import { PAGE_MAX_BYTES, viewBytes } from './context-pages.js';
import {
  planItemDuties,
  planItemSatisfied,
  planSubmission,
} from './plan-state.js';
import type {
  PlanDuty,
  PlanDutyAction,
  PlanDutyRole,
  PlanWaitingFor,
} from './plan-state.js';
import { isMember, isRoomArchived, isRoomClosed, liveLead } from './rooms.js';
import type {
  PlanCheckpoint,
  PlanEvidence,
  PlanItem,
  PlanItemStatus,
  PlanMode,
  PlanStatus,
  Room,
  RoomPlan,
  WorkMap,
} from './types.js';

/** Размер страницы по умолчанию: один вызов покрывает обычный список, длинный идёт страницами. */
export const PLAN_TASKS_MAX_BYTES = 16 * 1024;
/** Меньше страницу не просят: рамка ответа и одна запись иначе не поместились бы. */
const PAGE_MIN_BYTES = 1024;
/** Сколько записей возвращает краткая форма после мутации (C4). */
const NEXT_ASSIGNMENTS = 5;
/** Сколько сделанных пунктов называет первая страница. */
const FINISHED_ITEMS = 30;
/** Сколько последних записей журнала пункта отдаёт чтение одного пункта. */
const DETAIL_LOG = 10;

/** Границы текстов в списке: длиннее обрывается с пометкой полного размера, целиком — чтением пункта. */
const ROOM_TITLE_MAX = 128;
const TITLE_MAX = 256;
const SCOPE_MAX = 1024;
const CRITERION_MAX = 256;
const EVIDENCE_TEXT_MAX = 1024;
const EVIDENCE_ARTIFACT_MAX = 256;
const EVIDENCE_ARTIFACTS = 10;
const NOTE_MAX = 512;
const LOG_NOTE_MAX = 256;
const FINISHED_TITLE_MAX = 80;
const NEXT_TITLE_MAX = 80;

export type PlanTaskAction = PlanDutyAction | 'propose-completion';

/** Позиция участника; у проверяющего `stale: true`, если она относится к более ранней сдаче. */
export interface PlanTaskCheckpoint extends PlanCheckpoint {
  stale?: true;
}
export interface PlanTaskLog {
  at: string;
  by: string;
  status: PlanItemStatus;
  note: string | null;
}
export interface PlanTaskEntry {
  planId: string;
  rev: number;
  room: string;
  roomTitle: string;
  mode: PlanMode;
  /** `null` — задание на весь план (`propose-completion`). */
  item: number | null;
  title: string;
  role: PlanDutyRole;
  status: PlanItemStatus | PlanStatus;
  action: PlanTaskAction;
  waitingFor: PlanWaitingFor | null;
  scope: string | null;
  criteria: string[];
  evidence: PlanEvidence | null;
  note: string | null;
  checkpoint: PlanTaskCheckpoint | null;
  submission: number | null;
  lastLog: PlanTaskLog | null;
}
export interface PlanFinishedItem {
  planId: string;
  item: number;
  title: string;
  role: 'owner' | 'verifier';
}
/** Чтение одного пункта целиком: полные тексты, последние записи журнала и обе позиции. */
export interface PlanItemDetail {
  planId: string;
  rev: number;
  room: string;
  mode: PlanMode;
  item: number;
  title: string;
  owner: string;
  verifier: string | null;
  status: PlanItemStatus;
  after: number[];
  scope: string;
  criteria: string[];
  evidence: PlanEvidence | null;
  note: string | null;
  submission: number | null;
  log: PlanTaskLog[];
  progress: {
    owner: PlanTaskCheckpoint | null;
    verifier: PlanTaskCheckpoint | null;
  };
}
export interface PlanTasksView {
  session: string;
  total: number;
  assignments: PlanTaskEntry[];
  /** Сделанные пункты вызывающего: имена — только на первой странице, число — всегда. */
  finished: { count: number; items: PlanFinishedItem[] };
  /** Курсор следующей страницы; `null` — список закончился. */
  next: string | null;
  /** Только при чтении одного пункта (`planId` и `item`). */
  detail?: PlanItemDetail;
}
export interface PlanTasksQuery {
  planId?: string;
  item?: number;
  cursor?: string;
  maxBytes?: number;
}
export interface PlanNextAssignment {
  planId: string;
  rev: number;
  item: number | null;
  role: PlanDutyRole;
  action: PlanTaskAction;
  title: string;
}
export interface PlanTasksNext {
  total: number;
  assignments: PlanNextAssignment[];
}

/** Порядок действий: сначала то, что ждут от вызывающего другие, потом чужое ожидание. */
const ACTION_RANK: Record<PlanTaskAction, number> = {
  verify: 0,
  rework: 1,
  continue: 2,
  start: 3,
  'resolve-block': 4,
  'propose-completion': 5,
  wait: 6,
};

interface Task {
  plan: RoomPlan;
  room: Room;
  /** `null` — задание на весь план. */
  item: PlanItem | null;
  role: PlanDutyRole;
  action: PlanTaskAction;
  waitingFor: PlanWaitingFor | null;
  key: string;
}
interface Finished {
  plan: RoomPlan;
  item: PlanItem;
  role: 'owner' | 'verifier';
}

const cut = (text: string, limit: number): string =>
  markedExcerpt(text, limit).text;

/** `pl-03` < `pl-10`: сравнение по числу, а не по строке. */
function planOrder(a: string, b: string): number {
  const number = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? NaN);
  const left = number(a);
  const right = number(b);
  return Number.isNaN(left) || Number.isNaN(right) || left === right
    ? a.localeCompare(b)
    : left - right;
}

/** Планы, видимые вызывающему: `active|completing` в открытой комнате, где он участник. */
function visiblePlans(
  map: WorkMap,
  sessionId: string,
): { plan: RoomPlan; room: Room }[] {
  const found: { plan: RoomPlan; room: Room }[] = [];
  for (const plan of map.plans ?? []) {
    if (plan.status !== 'active' && plan.status !== 'completing') continue;
    const room = map.rooms.find((row) => row.id === plan.roomId);
    if (
      !room ||
      isRoomArchived(room) ||
      isRoomClosed(map, room) ||
      !isMember(room, sessionId)
    )
      continue;
    found.push({ plan, room });
  }
  return found.sort((a, b) => planOrder(a.plan.id, b.plan.id));
}

function collect(
  map: WorkMap,
  sessionId: string,
  planId?: string,
): { tasks: Task[]; finished: Finished[] } {
  const tasks: Task[] = [];
  const finished: Finished[] = [];
  for (const { plan, room } of visiblePlans(map, sessionId)) {
    if (planId !== undefined && plan.id !== planId) continue;
    const lead = liveLead(map, room);
    for (const item of plan.items) {
      if (planItemSatisfied(plan, item)) {
        if (item.owner === sessionId)
          finished.push({ plan, item, role: 'owner' });
        else if (
          plan.mode === 'verified' &&
          item.verifier === sessionId &&
          item.verifier !== item.owner
        )
          finished.push({ plan, item, role: 'verifier' });
        continue;
      }
      for (const duty of planItemDuties(plan, item, lead))
        if (duty.sessionId === sessionId)
          tasks.push(task(plan, room, item, duty));
    }
    if (plan.status === 'completing' && lead === sessionId)
      tasks.push({
        plan,
        room,
        item: null,
        role: 'lead',
        action: 'propose-completion',
        waitingFor: null,
        key: `${plan.id}:${plan.rev}:-:lead:propose-completion`,
      });
  }
  tasks.sort(
    (a, b) =>
      ACTION_RANK[a.action] - ACTION_RANK[b.action] ||
      planOrder(a.plan.id, b.plan.id) ||
      (a.item?.id ?? 0) - (b.item?.id ?? 0) ||
      a.role.localeCompare(b.role),
  );
  return { tasks, finished };
}

function task(
  plan: RoomPlan,
  room: Room,
  item: PlanItem,
  duty: PlanDuty,
): Task {
  return {
    plan,
    room,
    item,
    role: duty.role,
    action: duty.action,
    waitingFor: duty.waitingFor,
    key: `${plan.id}:${plan.rev}:${item.id}:${duty.role}:${duty.action}`,
  };
}

/** Позиция проверяющего устарела, если относится не к текущей сдаче пункта; позиция владельца сдачи не знает. */
function checkpointOf(
  item: PlanItem,
  role: 'owner' | 'verifier',
): PlanTaskCheckpoint | null {
  const saved = item.progress?.[role];
  if (!saved) return null;
  const copy: PlanTaskCheckpoint = {
    ...saved,
    artifacts: [...saved.artifacts],
  };
  if (role === 'verifier' && saved.submission !== planSubmission(item))
    copy.stale = true;
  return copy;
}

function logOf(entry: PlanItem['log'][number], limit: number): PlanTaskLog {
  return {
    at: entry.at,
    by: entry.by,
    status: entry.status,
    note: entry.note === null ? null : cut(entry.note, limit),
  };
}

/** Доказательство видят проверяющий перед проверкой и владелец сданного или возвращённого пункта. */
function evidenceOf(entry: Task): PlanEvidence | null {
  const item = entry.item;
  if (!item?.evidence) return null;
  const shown =
    (entry.role === 'verifier' && entry.action === 'verify') ||
    (entry.role === 'owner' &&
      (item.status === 'returned' || item.status === 'done'));
  if (!shown) return null;
  return {
    text: cut(item.evidence.text, EVIDENCE_TEXT_MAX),
    artifacts: item.evidence.artifacts
      .slice(0, EVIDENCE_ARTIFACTS)
      .map((path) => cut(path, EVIDENCE_ARTIFACT_MAX)),
  };
}

function render(entry: Task): PlanTaskEntry {
  const { plan, room, item } = entry;
  const base = {
    planId: plan.id,
    rev: plan.rev,
    room: room.id,
    roomTitle: cut(room.title, ROOM_TITLE_MAX),
    mode: plan.mode,
    role: entry.role,
    action: entry.action,
    waitingFor: entry.waitingFor,
  };
  if (item === null)
    return {
      ...base,
      item: null,
      title: cut(plan.goal, TITLE_MAX),
      status: plan.status,
      scope: null,
      criteria: [],
      evidence: null,
      note: null,
      checkpoint: null,
      submission: null,
      lastLog: null,
    };
  const last = item.log.at(-1);
  return {
    ...base,
    item: item.id,
    title: cut(item.title, TITLE_MAX),
    status: item.status,
    scope: cut(item.scope, SCOPE_MAX),
    criteria: item.criteria.map((criterion) => cut(criterion, CRITERION_MAX)),
    evidence: evidenceOf(entry),
    note: item.note === null ? null : cut(item.note, NOTE_MAX),
    checkpoint:
      entry.role === 'lead' ? null : checkpointOf(item, entry.role),
    submission: planSubmission(item),
    lastLog: last === undefined ? null : logOf(last, LOG_NOTE_MAX),
  };
}

function detailOf(plan: RoomPlan, item: PlanItem): PlanItemDetail {
  return {
    planId: plan.id,
    rev: plan.rev,
    room: plan.roomId,
    mode: plan.mode,
    item: item.id,
    title: item.title,
    owner: item.owner,
    verifier: item.verifier,
    status: item.status,
    after: [...item.after],
    scope: item.scope,
    criteria: [...item.criteria],
    evidence: item.evidence === null ? null : structuredClone(item.evidence),
    note: item.note,
    submission: planSubmission(item),
    log: item.log.slice(-DETAIL_LOG).map((entry) => ({ ...entry })),
    progress: {
      owner: checkpointOf(item, 'owner'),
      verifier: checkpointOf(item, 'verifier'),
    },
  };
}

/** Курсор: смещение и хеш упорядоченного списка ключей. Изменился список — курсор больше не годится. */
const listHash = (tasks: Task[]): string =>
  createHash('sha256')
    .update(tasks.map((entry) => entry.key).join('\n'))
    .digest('hex')
    .slice(0, 16);
const encodeCursor = (offset: number, hash: string): string =>
  Buffer.from(JSON.stringify({ o: offset, h: hash })).toString('base64url');
function decodeCursor(cursor: string): { offset: number; hash: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      value !== null &&
      typeof value === 'object' &&
      Number.isSafeInteger(value.o) &&
      value.o >= 0 &&
      typeof value.h === 'string'
    )
      return { offset: value.o, hash: value.h };
  } catch {
    // Ниже единый отказ.
  }
  throw new Error('invalid cursor; call plan_tasks without cursor');
}

const clampBytes = (requested: number | undefined): number =>
  typeof requested !== 'number' || !Number.isFinite(requested)
    ? PLAN_TASKS_MAX_BYTES
    : Math.min(PAGE_MAX_BYTES, Math.max(PAGE_MIN_BYTES, Math.floor(requested)));

/**
 * Задания вызывающего по принятым планам комнат, где он участник: по обязанностям `planItemDuties`, в порядке
 * verify, rework, continue, start, resolve-block, propose-completion, wait. С `planId` и `item` читает один пункт
 * целиком. Карту не меняет.
 */
export function planTasksView(
  map: WorkMap,
  sessionId: string,
  query: PlanTasksQuery = {},
): PlanTasksView {
  if (query.item !== undefined && query.planId === undefined)
    throw new Error('item needs planId');
  let detail: PlanItemDetail | undefined;
  if (query.planId !== undefined) {
    const found = visiblePlans(map, sessionId).find(
      ({ plan }) => plan.id === query.planId,
    );
    if (!found)
      throw new Error(`plan ${query.planId} is not available to this session`);
    if (query.item !== undefined) {
      const item = found.plan.items.find((row) => row.id === query.item);
      if (!item)
        throw new Error(`plan ${query.planId} has no item ${query.item}`);
      detail = detailOf(found.plan, item);
    }
  }
  const { tasks: all, finished } = collect(map, sessionId, query.planId);
  const tasks =
    query.item === undefined
      ? all
      : all.filter((entry) => entry.item?.id === query.item);
  const hash = listHash(tasks);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    if (cursor.hash !== hash || cursor.offset > tasks.length)
      throw new Error('assignments changed; call plan_tasks without cursor');
    offset = cursor.offset;
  }
  const maxBytes = clampBytes(query.maxBytes);
  const frame: PlanTasksView = {
    session: sessionId,
    total: tasks.length,
    assignments: [],
    finished: {
      count: finished.length,
      items:
        offset > 0
          ? []
          : finished.slice(0, FINISHED_ITEMS).map((entry) => ({
              planId: entry.plan.id,
              item: entry.item.id,
              title: cut(entry.item.title, FINISHED_TITLE_MAX),
              role: entry.role,
            })),
    },
    next: encodeCursor(tasks.length, hash),
  };
  let used = viewBytes(frame);
  const assignments: PlanTaskEntry[] = [];
  let end = offset;
  for (; end < tasks.length; end++) {
    const entry = render(tasks[end]!);
    const size = viewBytes(entry) + 2;
    // Хотя бы одна запись на страницу: иначе слишком большое задание не прочиталось бы никогда.
    if (assignments.length > 0 && used + size > maxBytes) break;
    assignments.push(entry);
    used += size;
  }
  return {
    ...frame,
    assignments,
    next: end < tasks.length ? encodeCursor(end, hash) : null,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Краткая форма для ответов `plan_*` (C4): сколько всего заданий и первые пять без длинных текстов. Считается
 * из той же выборки, что и `planTasksView`, поэтому ответ мутации и `plan_tasks` расходиться не могут.
 */
export function planTasksNext(map: WorkMap, sessionId: string): PlanTasksNext {
  const { tasks } = collect(map, sessionId);
  return {
    total: tasks.length,
    assignments: tasks.slice(0, NEXT_ASSIGNMENTS).map((entry) => ({
      planId: entry.plan.id,
      rev: entry.plan.rev,
      item: entry.item?.id ?? null,
      role: entry.role,
      action: entry.action,
      title: cut(entry.item?.title ?? entry.plan.goal, NEXT_TITLE_MAX),
    })),
  };
}
