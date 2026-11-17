/**
 * След опыта с пакетом состояния (план опыта 2026-11-17, Э-1б): удаление сессии и комнаты стирает то, что нужно подсчёту
 * — плечо, идентификаторы транскриптов, время участия в комнате. Здесь это сохраняется закрытым полем `work.trialTrace`
 * той же записью карты, что и само удаление. Поле не видно через `get_map`. Без сессий с назначением поле не появляется.
 */

import { PREVIOUS_AGENTS_MAX } from './agent-switch.js';
import { joinedLine, isMember } from './rooms.js';
import { isTrialName, isTrialTag, SYSTEM, TRIAL_ARMS } from './types.js';
import type {
  DamagedTrace,
  Room,
  SessionTrial,
  DamagedTrial,
  TrialArm,
  TrialRoomRow,
  TrialSegment,
  TrialSessionTrace,
  TrialTrace,
  TrialUnknownParticipation,
  WorkMap,
  WorkSession,
} from './types.js';
import type { LetterReads } from './letter-store.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableTime = (value: unknown): value is string | null => value === null || isTime(value);
/** Отрезок не перевёрнут: выход не раньше входа (оба времени уже разобраны). */
const ordered = (from: string, to: string): boolean => Date.parse(to) >= Date.parse(from);
const DAMAGED: DamagedTrace = { damaged: true };

/**
 * Проверка назначения при чтении карты: ровно два значения плеча, имя по правилу настройки, корректное время и метка
 * (128 бит hex). Запись, не прошедшая проверку, — явное состояние «повреждено», а не «плеча нет». Само состояние
 * читается обратно как есть.
 */
export function normalizeTrial(trial: unknown): SessionTrial | DamagedTrial {
  if (isRecord(trial) && isTrialName(trial['name']) && TRIAL_ARMS.includes(trial['arm'] as TrialArm) &&
    typeof trial['at'] === 'string' && Number.isFinite(Date.parse(trial['at'])) && isTrialTag(trial['tag'])) {
    return { name: trial['name'], arm: trial['arm'] as TrialArm, at: trial['at'], tag: trial['tag'] };
  }
  return { damaged: true };
}

function normalizeSegment(value: unknown): TrialSegment | undefined {
  if (!isRecord(value) || typeof value['provider'] !== 'string' || !nullableString(value['providerSessionId']) ||
    !nullableTime(value['startedAt']) || !nullableTime(value['endedAt'])) return undefined;
  if (value['startedAt'] !== null && value['endedAt'] !== null && !ordered(value['startedAt'], value['endedAt'])) return undefined;
  return {
    provider: value['provider'],
    providerSessionId: value['providerSessionId'],
    startedAt: value['startedAt'],
    endedAt: value['endedAt'],
  };
}

function normalizeSessionTrace(value: unknown): TrialSessionTrace | DamagedTrace {
  if (!isRecord(value) || typeof value['session'] !== 'string' || typeof value['provider'] !== 'string' ||
    !nullableString(value['providerSessionId']) || !nullableTime(value['startedAt']) || !nullableTime(value['endedAt']) ||
    !nullableTime(value['closedAt']) || !isTime(value['deletedAt']) ||
    !isRecord(value['trial'])) return DAMAGED;
  // Текущий отрезок: активация сохраняет первое `startedAt` и очищает `endedAt` (`transitionSession`), поэтому конец раньше начала — повреждение.
  if (value['startedAt'] !== null && value['endedAt'] !== null && !ordered(value['startedAt'], value['endedAt'])) return DAMAGED;
  const previous = value['previousAgents'];
  let previousAgents: TrialSegment[] | undefined;
  if (previous !== undefined) {
    if (!Array.isArray(previous)) return DAMAGED;
    previousAgents = [];
    for (const item of previous) {
      const segment = normalizeSegment(item);
      if (segment === undefined) return DAMAGED;
      previousAgents.push(segment);
    }
  }
  const rooms = value['unjournaledRooms'];
  if (rooms !== undefined && !(Array.isArray(rooms) && rooms.every((room) => typeof room === 'string'))) return DAMAGED;
  return {
    session: value['session'],
    trial: normalizeTrial(value['trial']),
    provider: value['provider'],
    providerSessionId: value['providerSessionId'],
    startedAt: value['startedAt'],
    endedAt: value['endedAt'],
    closedAt: value['closedAt'],
    ...(previousAgents === undefined ? {} : { previousAgents }),
    ...(rooms === undefined ? {} : { unjournaledRooms: [...(rooms as string[])] }),
    deletedAt: value['deletedAt'],
  };
}

function normalizeRoomRow(value: unknown): TrialRoomRow | DamagedTrace {
  if (!isRecord(value) || typeof value['room'] !== 'string' || typeof value['session'] !== 'string' ||
    !isTime(value['from']) || !isTime(value['to']) || !ordered(value['from'], value['to'])) return DAMAGED;
  return { room: value['room'], session: value['session'], from: value['from'], to: value['to'] };
}

function normalizeUnknown(value: unknown): TrialUnknownParticipation | DamagedTrace {
  if (!isRecord(value) || typeof value['room'] !== 'string' || typeof value['session'] !== 'string') return DAMAGED;
  return { room: value['room'], session: value['session'] };
}

/** Одна из трёх таблиц следа: нет — пусто, не список — явное «повреждено», каждая кривая запись — тоже. */
function normalizeList<T>(value: unknown, entry: (item: unknown) => T | DamagedTrace): Array<T | DamagedTrace> {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(entry) : [DAMAGED];
}

/**
 * Проверка поля `work.trialTrace` при чтении карты; нет поля — нет и после чтения. Кривая запись заменяется явным
 * состоянием «повреждено» и переживает запись карты.
 */
export function normalizeTrialTrace(work: Record<string, unknown>): void {
  const trace = work['trialTrace'];
  if (trace === undefined) return;
  if (!isRecord(trace)) {
    work['trialTrace'] = { sessions: [DAMAGED], rooms: [], unknownParticipation: [] } satisfies TrialTrace;
    return;
  }
  work['trialTrace'] = {
    sessions: normalizeList(trace['sessions'], normalizeSessionTrace),
    rooms: normalizeList(trace['rooms'], normalizeRoomRow),
    unknownParticipation: normalizeList(trace['unknownParticipation'], normalizeUnknown),
  } satisfies TrialTrace;
}

export const isDamagedTrace = (entry: object): entry is DamagedTrace => 'damaged' in entry;

function ensureTrace(map: WorkMap): TrialTrace {
  map.work.trialTrace ??= { sessions: [], rooms: [], unknownParticipation: [] };
  return map.work.trialTrace;
}

/** Тексты системных строк комнаты: по ним видно, кто входил в комнату без журнала (`legacyEntries`). */
function systemTexts(letters: LetterReads, roomId: string): Set<string> {
  const system = { roomId, from: SYSTEM };
  return new Set(letters.query({ ...system, limit: letters.count(system) }).map((message) => message.text));
}

/** Комната без журнала участия, где у сессии есть строка входа в ленте или членство. */
function enteredUnjournaledRooms(map: WorkMap, letters: LetterReads, sessionId: string): string[] {
  return map.rooms
    .filter((room) => room.memberLog === undefined && (isMember(room, sessionId) || systemTexts(letters, room.id).has(joinedLine(sessionId))))
    .map((room) => room.id);
}

/**
 * Удаление сессии: след сессии с назначением (в том числе повреждённым) ложится в ту же запись карты. Сессия без
 * назначения следа не оставляет. Зовёт `removeSession` до того, как карта лишится комнат и писем.
 */
export function traceDeletedSession(map: WorkMap, letters: LetterReads, removed: WorkSession, deletedAt: string): void {
  if (removed.trial === undefined) return;
  const unjournaled = enteredUnjournaledRooms(map, letters, removed.id);
  ensureTrace(map).sessions.push({
    session: removed.id,
    trial: { ...removed.trial },
    provider: removed.provider,
    providerSessionId: removed.providerSessionId,
    startedAt: removed.startedAt,
    endedAt: removed.endedAt,
    closedAt: removed.closedAt,
    ...(removed.previousAgents === undefined ? {} : {
      previousAgents: removed.previousAgents.map(({ provider, providerSessionId, startedAt, endedAt }) => ({ provider, providerSessionId, startedAt, endedAt })),
    }),
    ...(unjournaled.length === 0 ? {} : { unjournaledRooms: unjournaled }),
    deletedAt,
  });
}

/**
 * Удаление комнаты: строки журнала участия тех сессий, у которых есть назначение или след удалённой сессии (открытый
 * выход закрывается временем удаления); у комнаты без журнала — отметка «участие неизвестно» для каждой живой сессии
 * опыта, чья лента или состав её называют. Комната без таких сессий следа не оставляет. Зовёт `deleteRoom` до того, как
 * из карты уходят комната и её письма.
 */
export function traceDeletedRoom(map: WorkMap, letters: LetterReads, room: Room, deletedAt: string): void {
  const traced = new Set((map.work.trialTrace?.sessions ?? []).flatMap((entry) => (isDamagedTrace(entry) ? [] : [entry.session])));
  const live = new Set(map.sessions.filter((session) => session.trial !== undefined).map((session) => session.id));
  if (room.memberLog !== undefined) {
    const rows = room.memberLog.filter((entry) => live.has(entry.session) || traced.has(entry.session));
    if (rows.length === 0) return;
    ensureTrace(map).rooms.push(...rows.map((entry) => ({ room: room.id, session: entry.session, from: entry.from, to: entry.to ?? deletedAt })));
    return;
  }
  const texts = systemTexts(letters, room.id);
  const unknown = [...live].filter((id) => isMember(room, id) || texts.has(joinedLine(id)));
  if (unknown.length === 0) return;
  ensureTrace(map).unknownParticipation.push(...unknown.map((session) => ({ room: room.id, session })));
}

/**
 * Пары «комната/сессия», участие которых неизвестно: отметки удалённых комнат и номера комнат без журнала в следах
 * удалённых сессий. При любом порядке удалений сессии и комнаты набор один и тот же.
 */
export function trialUnknownParticipation(trace: TrialTrace | undefined): string[] {
  const pairs = new Set<string>();
  for (const mark of trace?.unknownParticipation ?? []) if (!isDamagedTrace(mark)) pairs.add(`${mark.room}/${mark.session}`);
  for (const entry of trace?.sessions ?? []) {
    if (isDamagedTrace(entry)) continue;
    for (const room of entry.unjournaledRooms ?? []) pairs.add(`${room}/${entry.session}`);
  }
  return [...pairs].sort();
}

/** Что нужно о сессии, чтобы разобрать её отрезки: у живой записи и у следа поля называются одинаково. */
export interface TrialSegmentSource {
  provider: string;
  providerSessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  closedAt: string | null;
  previousAgents?: readonly TrialSegment[] | undefined;
}

export interface TrialSegments {
  /** Прежние отрезки по порядку, затем текущий. */
  segments: TrialSegment[];
  /** Прежних отрезков 20 и больше: ровно 20 от слияния не отличить, история считается неполной. */
  truncated: boolean;
  /** У отрезка `claude` есть время начала, но нет идентификатора: транскрипт этого отрезка не найти, история неполна. */
  missingId: boolean;
}

/** Один разбор отрезков для живой записи и для следа удалённой сессии (план опыта, Э-1б, критерий 9). */
export function trialSegments(source: TrialSegmentSource): TrialSegments {
  const previous = (source.previousAgents ?? []).map(({ provider, providerSessionId, startedAt, endedAt }) => ({ provider, providerSessionId, startedAt, endedAt }));
  const segments = [...previous, { provider: source.provider, providerSessionId: source.providerSessionId, startedAt: source.startedAt, endedAt: source.endedAt }];
  return {
    segments,
    truncated: previous.length >= PREVIOUS_AGENTS_MAX,
    missingId: segments.some((segment) => segment.provider === 'claude' && segment.startedAt !== null && segment.providerSessionId === null),
  };
}

/**
 * В работе есть повреждение, которое могло скрыть метку назначения: живая сессия с повреждённым назначением, повреждённая
 * запись следа (любой из трёх списков) или след с повреждённым назначением внутри. Пока оно есть, отсутствие записи о
 * назначении доказать нельзя.
 */
export function workHasTrialDamage(map: WorkMap): boolean {
  if (map.sessions.some((session) => session.trial !== undefined && 'damaged' in session.trial)) return true;
  const trace = map.work.trialTrace;
  if (trace === undefined) return false;
  return [...trace.rooms, ...trace.unknownParticipation].some(isDamagedTrace) ||
    trace.sessions.some((entry) => isDamagedTrace(entry) || 'damaged' in entry.trial);
}
