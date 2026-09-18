import type {
  HistoryEntry,
  Message,
  MessageKind,
  SessionStatus,
  WorkMap,
  WorkProvider,
  WorkSession,
  WorksIndex,
} from './types.js';

/**
 * Таблица переходов из спецификации, раздел 6. `done` и `failed` разрешены из
 * любого статуса — они приходят только из `report`, и отчитаться агент может
 * когда угодно; поэтому в таблице их нет, они проверяются отдельно.
 */
const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  pending: ['active'],
  active: ['exited'],
  exited: ['active'],
  done: ['active'],
  failed: ['active'],
};

/** Допустим ли переход статуса сессии. */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return to === 'done' || to === 'failed' || TRANSITIONS[from].includes(to);
}

/** Номер в id вида `s-03`; `0` — id не из этой нумерации. */
function numberOf(id: string, prefix: string): number {
  const digits = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
  return Number.isInteger(digits) && digits > 0 ? digits : 0;
}

/** Наибольший занятый номер в списке id. */
const maxNumber = (existing: readonly string[], prefix: string): number =>
  existing.reduce((max, id) => Math.max(max, numberOf(id, prefix)), 0);

/** Следующий свободный номер: id уже удалённых записей не переиспользуем. */
function nextId(existing: readonly string[], prefix: string, width: number): string {
  return `${prefix}${String(maxNumber(existing, prefix) + 1).padStart(width, '0')}`;
}

/**
 * Следующий id сессии внутри работы: `s-01`, `s-02`, … Номер берётся по
 * счётчику работы, а не по одному списку сессий: удалённая запись из списка
 * ушла, но её id занят навсегда — иначе `s-03` в чужом брифе или в `contextFrom`
 * стал бы указывать на другую сессию (план от 2026-09-06, раздел C). Счётчик
 * пишется сразу же: карта всё равно сохраняется той же мутацией.
 */
export function nextSessionId(map: WorkMap): string {
  const next =
    Math.max(
      map.work.sessionSeq ?? 0,
      maxNumber(
        map.sessions.map((session) => session.id),
        's-',
      ),
    ) + 1;
  map.work.sessionSeq = next;
  return `s-${String(next).padStart(2, '0')}`;
}

/** Следующий id сообщения внутри работы: `m-01`, `m-02`, … */
export function nextMessageId(map: WorkMap): string {
  return nextId(
    map.messages.map((message) => message.id),
    'm-',
    2,
  );
}

/** Следующий id работы: `w-0001`, `w-0002`, … — сквозной по глобальному индексу. */
export function nextWorkId(index: WorksIndex): string {
  return nextId(
    index.works.map((work) => work.id),
    'w-',
    4,
  );
}

/** Номер следом за данным: `w-0001` → `w-0002`. Нужен, чтобы пропускать занятые id. */
export function bumpWorkId(id: string): string {
  return nextId([id], 'w-', 4);
}

export interface NewSession {
  provider: WorkProvider;
  label: string;
  task: string;
  parent?: string | null;
  contextFrom?: string[];
  /** Роль Claude Code, которой запустится сессия; без неё — обычная сессия. */
  agent?: string | null;
}

/** Заводит в карте сессию `pending` — так её создаёт и агент, и пользователь. */
export function addSession(
  map: WorkMap,
  init: NewSession,
  at = new Date().toISOString(),
): WorkSession {
  const session: WorkSession = {
    id: nextSessionId(map),
    provider: init.provider,
    label: init.label,
    task: init.task,
    parent: init.parent ?? null,
    contextFrom: init.contextFrom ?? [],
    status: 'pending',
    history: [{ status: 'pending', at }],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: init.agent ?? null,
  };
  map.sessions.push(session);
  return session;
}

/**
 * Убирает сессию из карты (`prefix d`, план от 2026-09-06, раздел C). Дети
 * поднимаются к родителю удалённой, её id уходит из чужих `contextFrom`, а
 * письма остаются с пометкой `deleted` — переписку задним числом не переписывают.
 * След удаления — только id в `work.deletedSessions`: ни ярлыка, ни задачи, ни
 * резюме в карте не остаётся.
 */
export function removeSession(map: WorkMap, sessionId: string): WorkSession {
  const at = map.sessions.findIndex((candidate) => candidate.id === sessionId);
  if (at === -1) throw new Error(`сессии ${sessionId} нет в карте`);
  const [removed] = map.sessions.splice(at, 1) as [WorkSession];

  for (const session of map.sessions) {
    if (session.parent === sessionId) session.parent = removed.parent;
    if (session.contextFrom.includes(sessionId)) {
      session.contextFrom = session.contextFrom.filter((id) => id !== sessionId);
    }
  }
  for (const message of map.messages) {
    if (message.from === sessionId || message.to === sessionId) message.deleted = true;
  }

  const deleted = map.work.deletedSessions ?? [];
  if (!deleted.includes(sessionId)) deleted.push(sessionId);
  map.work.deletedSessions = deleted;
  // Счётчик помнит номер и после того, как запись исчезла: в картах без него
  // максимум по списку после удаления самой свежей сессии уехал бы назад.
  map.work.sessionSeq = Math.max(map.work.sessionSeq ?? 0, numberOf(sessionId, 's-'));
  return removed;
}

export interface NewMessage {
  from: string;
  to: string;
  text: string;
  kind?: MessageKind;
}

/** Кладёт сообщение в карту непрочитанным: доставка — pull через `check_inbox`. */
export function addMessage(map: WorkMap, init: NewMessage, at = new Date().toISOString()): Message {
  // Поля перечислены руками, а не `...init`: при разложении `kind: undefined`
  // попал бы в карту ключом без значения, и письмо на диске осталось бы без вида.
  const message: Message = {
    id: nextMessageId(map),
    from: init.from,
    to: init.to,
    text: init.text,
    kind: init.kind ?? 'note',
    at,
    readAt: null,
  };
  map.messages.push(message);
  return message;
}

export interface TransitionOptions {
  at?: string;
  /**
   * Код выхода процесса: пишется в запись history перехода в `exited`. `null` —
   * процесс завершился без харнесса, и кода у нас нет (дизайн 5.4).
   */
  exitCode?: number | null;
  /** Сигнал, которым убит процесс, — там же, рядом с кодом выхода. */
  signal?: number;
}

/**
 * Переводит сессию в новый статус, проверяя таблицу переходов, и дописывает
 * `history`. Недопустимый переход — ошибка, карта не меняется.
 */
export function transitionSession(
  map: WorkMap,
  sessionId: string,
  to: SessionStatus,
  { at = new Date().toISOString(), exitCode, signal }: TransitionOptions = {},
): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);
  if (!canTransition(session.status, to)) {
    throw new Error(`недопустимый переход ${session.status} → ${to} (сессия ${sessionId})`);
  }

  session.status = to;
  const entry: HistoryEntry = { status: to, at };
  if (exitCode !== undefined) entry.exitCode = exitCode;
  if (signal !== undefined) entry.signal = signal;
  session.history.push(entry);
  if (to === 'active' && session.startedAt === null) session.startedAt = at;
  // Возобновлённая сессия снова жива, завершённая — фиксирует время выхода.
  session.endedAt = to === 'active' ? null : at;
  return session;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Статус `idle` удалён из жизненного цикла 2026-09-05 (дизайн TUI v2, раздел 9):
 * карты, написанные до этого, читаются как `active`. Миграция при чтении, а не
 * отдельной командой: карту всё равно перепишет первая же мутация.
 */
const LEGACY_IDLE = 'idle';

/** Запись сессии проверяем по полям, от которых зависят мутации: id, статус, history. */
const isSessionShape = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.status === 'string' &&
  (Object.hasOwn(TRANSITIONS, value.status) || value.status === LEGACY_IDLE) &&
  Array.isArray(value.history);

const isMessageShape = (value: unknown): boolean => isRecord(value) && typeof value.id === 'string';

/**
 * Разбирает карту. Форма undocumented-логов тут ни при чём: файл пишем мы сами,
 * поэтому чужая форма — повод отказаться, а не догадываться (раздел 8).
 */
export function parseMap(raw: string, file: string): WorkMap {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`карта ${file} не парсится: ${(error as Error).message}`);
  }

  const work = isRecord(data) ? data.work : undefined;
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    !isRecord(work) ||
    typeof work.id !== 'string' ||
    !Array.isArray(data.sessions) ||
    !Array.isArray(data.messages) ||
    !data.sessions.every(isSessionShape) ||
    !data.messages.every(isMessageShape)
  ) {
    throw new Error(`карта ${file} не парсится: неожиданная форма`);
  }

  const map = data as unknown as WorkMap;
  for (const session of map.sessions) {
    migrateSession(session as unknown as Record<string, unknown>);
  }
  for (const message of map.messages) {
    migrateMessage(message as unknown as Record<string, unknown>);
  }
  return map;
}

/**
 * Письма до 2026-09-08 вида не знали: заметка (спецификация 2026-09-08, 3.1).
 * Миграция при чтении, как у `idle`: читатели карты дефолта не знают, а файл
 * получит поле при первой же мутации.
 */
function migrateMessage(message: Record<string, unknown>): void {
  message['kind'] ??= 'note';
}

/**
 * Приводит запись сессии к текущей форме: `idle` становится `active` (и в
 * `history` тоже — иначе в архиве остался бы статус, которого больше нет), а
 * полей процесса в старых картах просто не было.
 */
function migrateSession(session: Record<string, unknown>): void {
  if (session['status'] === LEGACY_IDLE) session['status'] = 'active';
  const history = session['history'];
  if (Array.isArray(history)) {
    for (const entry of history) {
      if (isRecord(entry) && entry['status'] === LEGACY_IDLE) entry['status'] = 'active';
    }
  }
  session['pid'] ??= null;
  session['startedAtProcess'] ??= null;
  session['launchedBy'] ??= null;
  // Роли появились 2026-09-08: до них сессия запускалась только сама собой.
  session['agent'] ??= null;
}
