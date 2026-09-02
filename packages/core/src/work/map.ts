import type {
  HistoryEntry,
  Message,
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
  active: ['idle', 'exited'],
  idle: ['active', 'exited'],
  exited: ['active'],
  done: ['active'],
  failed: ['active'],
};

/** Допустим ли переход статуса сессии. */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return to === 'done' || to === 'failed' || TRANSITIONS[from].includes(to);
}

/** Следующий свободный номер: id уже удалённых записей не переиспользуем. */
function nextId(existing: readonly string[], prefix: string, width: number): string {
  let max = 0;
  for (const id of existing) {
    const digits = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
    if (Number.isInteger(digits) && digits > max) max = digits;
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

/** Следующий id сессии внутри работы: `s-01`, `s-02`, … */
export function nextSessionId(map: WorkMap): string {
  return nextId(
    map.sessions.map((session) => session.id),
    's-',
    2,
  );
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
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
  };
  map.sessions.push(session);
  return session;
}

export interface NewMessage {
  from: string;
  to: string;
  text: string;
}

/** Кладёт сообщение в карту непрочитанным: доставка — pull через `check_inbox`. */
export function addMessage(map: WorkMap, init: NewMessage, at = new Date().toISOString()): Message {
  const message: Message = { id: nextMessageId(map), ...init, at, readAt: null };
  map.messages.push(message);
  return message;
}

export interface TransitionOptions {
  at?: string;
  /** Код выхода процесса: пишется в запись history перехода в `exited`. */
  exitCode?: number;
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
  session.endedAt = to === 'active' || to === 'idle' ? null : at;
  return session;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Запись сессии проверяем по полям, от которых зависят мутации: id, статус, history. */
const isSessionShape = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.status === 'string' &&
  Object.hasOwn(TRANSITIONS, value.status) &&
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
  return data as unknown as WorkMap;
}
