import { validateDecisionJournalStorage } from './decision-journal.js';
import { validatePlanStorage } from './plans.js';
import { validatePlanEffects } from './plan-effects.js';
import type { EffortLevel } from '../providers.js';
import type {
  HistoryEntry,
  Message,
  MessageKind,
  SessionLifecycle,
  SessionResult,
  WorkMap,
  WorkProvider,
  WorkSession,
  SessionRole,
  WorksIndex,
} from './types.js';

/**
 * Переходы оси процесса (спецификация 7.1). Итог в таблице не живёт: его ставит
 * `setResult`, и отчитаться агент может когда угодно, кроме как после `closed`.
 * Из `closed` выхода нет — закрытая сессия писем не получает и не поднимается.
 */
const TRANSITIONS: Readonly<Record<SessionLifecycle, readonly SessionLifecycle[]>> = {
  pending: ['active', 'closed'],
  active: ['sleeping', 'closed'],
  sleeping: ['active', 'closed'],
  closed: [],
};

/** Допустим ли переход сессии по оси процесса. */
export function canTransition(from: SessionLifecycle, to: SessionLifecycle): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Номер в id вида `s-03`; `0` — id не из этой нумерации. */
function numberOf(id: string, prefix: string): number {
  const digits = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
  return Number.isInteger(digits) && digits > 0 ? digits : 0;
}

/** Наибольший занятый номер в списке id. Нужен и `rooms.ts` — счётчик комнат той же формы. */
export const maxNumber = (existing: readonly string[], prefix: string): number =>
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
  role?: SessionRole | null;
  /** Модель и усилие запуска (`spawn_session`); без них — по умолчанию, поля в записи не будет. */
  model?: string | null;
  effort?: EffortLevel | null;
}

/** Заводит в карте сессию `pending` — так её создаёт и агент, и пользователь. */
export function addSession(
  map: WorkMap,
  init: NewSession,
  at = new Date().toISOString(),
): WorkSession {
  if (init.agent !== undefined && init.role !== undefined) throw new Error('agent-and-role-conflict');
  const session: WorkSession = {
    id: nextSessionId(map),
    provider: init.provider,
    label: init.label,
    task: init.task,
    parent: init.parent ?? null,
    contextFrom: init.contextFrom ?? [],
    lifecycle: 'pending',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [{ event: 'pending', at }],
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
    role: init.role ?? (init.agent == null ? null : { source: 'claude', name: init.agent }),
    worktree: null,
    ...(init.model === undefined ? {} : { model: init.model }),
    ...(init.effort === undefined ? {} : { effort: init.effort }),
  };
  map.sessions.push(session);
  return session;
}

/**
 * Убирает сессию из карты (план от 2026-09-06, раздел C). Дети
 * поднимаются к родителю удалённой, её id уходит из чужих `contextFrom`, а
 * письма остаются с пометкой `deleted` — переписку задним числом не переписывают.
 * След удаления — только id в `work.deletedSessions`: ни ярлыка, ни задачи, ни
 * резюме в карте не остаётся.
 */
export function removeSession(map: WorkMap, sessionId: string): WorkSession {
  const at = map.sessions.findIndex((candidate) => candidate.id === sessionId);
  if (at === -1) throw new Error(`session ${sessionId} is not in the map`);
  const [removed] = map.sessions.splice(at, 1) as [WorkSession];

  for (const session of map.sessions) {
    if (session.parent === sessionId) session.parent = removed.parent;
    if (session.contextFrom.includes(sessionId)) {
      session.contextFrom = session.contextFrom.filter((id) => id !== sessionId);
    }
  }
  for (const message of map.messages) {
    // `to` — массив: сравнение строки с ним было бы всегда ложным и молча
    // перестало бы помечать письма удалённой сессии.
    if (message.from === sessionId || message.to.includes(sessionId)) message.deleted = true;
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
  /** Адресаты; в комнате пустой список — рассылка всем участникам. */
  to: string[];
  text: string;
  kind?: MessageKind;
  /** Комната письма; без неё письмо прямое. */
  roomId?: string | null;
  /**
   * Ответ на сообщение этой комнаты (Parley 0.3.0): id того, над чем окно рисует цитату. Принадлежность
   * сообщения комнате проверяет вызывающий; без `replyTo` ключа в письме не будет.
   */
  replyTo?: string;
}

/** Кладёт сообщение в карту непрочитанным: доставка — pull через `check_inbox`. */
export function addMessage(map: WorkMap, init: NewMessage, at = new Date().toISOString()): Message {
  // Поля перечислены руками, а не `...init`: при разложении `kind: undefined`
  // попал бы в карту ключом без значения, и письмо на диске осталось бы без вида.
  // По той же причине `replyTo` дописывается только заданный.
  const message: Message = {
    id: nextMessageId(map),
    roomId: init.roomId ?? null,
    from: init.from,
    to: [...init.to],
    text: init.text,
    kind: init.kind ?? 'note',
    at,
    readBy: {},
    ...(init.replyTo === undefined ? {} : { replyTo: init.replyTo }),
  };
  map.messages.push(message);
  return message;
}

export interface TransitionOptions {
  at?: string;
  /**
   * Код выхода процесса: пишется в запись history ухода в `sleeping`. `null` —
   * процесс завершился без харнесса, и кода у нас нет (дизайн 5.4).
   */
  exitCode?: number | null;
  /** Сигнал, которым убит процесс, — там же, рядом с кодом выхода. */
  signal?: number;
}

const findSession = (map: WorkMap, sessionId: string): WorkSession => {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);
  return session;
};

/**
 * Переводит сессию по оси процесса, проверяя таблицу переходов, и дописывает
 * `history`. Недопустимый переход — ошибка, карта не меняется.
 */
export function transitionSession(
  map: WorkMap,
  sessionId: string,
  to: SessionLifecycle,
  { at = new Date().toISOString(), exitCode, signal }: TransitionOptions = {},
): WorkSession {
  const session = findSession(map, sessionId);
  if (!canTransition(session.lifecycle, to)) {
    throw new Error(`invalid transition ${session.lifecycle} → ${to} (session ${sessionId})`);
  }

  session.lifecycle = to;
  const entry: HistoryEntry = { event: to, at };
  if (exitCode !== undefined) entry.exitCode = exitCode;
  if (signal !== undefined) entry.signal = signal;
  session.history.push(entry);
  if (to === 'active' && session.startedAt === null) session.startedAt = at;
  if (to === 'closed') session.closedAt = at;
  // Поднятая сессия снова жива; уснувшая или закрытая — фиксирует время выхода.
  // Закрытие спящей время выхода не сдвигает: процесс ушёл раньше.
  if (to === 'active') session.endedAt = null;
  else if (session.endedAt === null) session.endedAt = at;
  return session;
}

/**
 * Ставит итог из `report`. Процесс он не меняет (спецификация 7.1); после
 * `closed` итог не принимается — закрытая сессия уже ничего не сдаёт.
 */
export function setResult(
  map: WorkMap,
  sessionId: string,
  result: SessionResult,
  at = new Date().toISOString(),
): WorkSession {
  const session = findSession(map, sessionId);
  if (session.lifecycle === 'closed') {
    throw new Error(`session ${sessionId} is closed: result ${result} not accepted`);
  }
  session.result = result;
  session.resultAt = at;
  session.history.push({ event: result, at });
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

/** Единый статус карты v1 — вход миграции в две оси. */
const V1_STATUSES: readonly string[] = [
  'pending',
  'active',
  'exited',
  'done',
  'failed',
  LEGACY_IDLE,
];

/** Запись сессии проверяем по полям, от которых зависят мутации: id, статус, history. */
const isSessionShape =
  (version: 1 | 2) =>
  (value: unknown): boolean =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    (version === 1
      ? typeof value.status === 'string' && V1_STATUSES.includes(value.status)
      : typeof value.lifecycle === 'string' && Object.hasOwn(TRANSITIONS, value.lifecycle)) &&
    Array.isArray(value.history);

/** У письма v2 адресаты — массив: по нему идут `removeSession` и `recipientsOf`. */
const isMessageShape =
  (version: 1 | 2) =>
  (value: unknown): boolean =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    (version === 1 ? typeof value.to === 'string' : Array.isArray(value.to));

/**
 * Разбирает карту. Форма undocumented-логов тут ни при чём: файл пишем мы сами,
 * поэтому чужая форма — повод отказаться, а не догадываться (раздел 8). Карта
 * v1 поднимается до v2 в памяти; на диск v2 ляжет первой же мутацией.
 */
export function parseMap(raw: string, file: string): WorkMap {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`map ${file} cannot be parsed: ${(error as Error).message}`);
  }

  const work = isRecord(data) ? data.work : undefined;
  const version = isRecord(data) ? data.schemaVersion : undefined;
  if (
    !isRecord(data) ||
    (version !== 1 && version !== 2) ||
    !isRecord(work) ||
    typeof work.id !== 'string' ||
    !Array.isArray(data.sessions) ||
    !Array.isArray(data.messages) ||
    (version === 2 && !Array.isArray(data.rooms)) ||
    !data.sessions.every(isSessionShape(version)) ||
    !data.messages.every(isMessageShape(version))
  ) {
    throw new Error(`map ${file} cannot be parsed: unexpected shape`);
  }

  if (version === 1) {
    for (const session of data.sessions as Record<string, unknown>[]) migrateSessionV1(session);
    for (const message of data.messages as Record<string, unknown>[]) migrateMessageV1(message);
    data.rooms = [];
    data.schemaVersion = 2;
  }

  const map = data as unknown as WorkMap;
  for (const session of map.sessions) {
    migrateSession(session as unknown as Record<string, unknown>);
  }
  for (const message of map.messages) {
    migrateMessage(message as unknown as Record<string, unknown>);
  }
  for (const room of map.rooms) {
    migrateRoom(room as unknown);
  }
  map.plans ??= [];
  validatePlanStorage(map);
  validatePlanEffects(map);
  validateDecisionJournalStorage(map);
  return map;
}

/**
 * Единый статус v1 → две оси (план этапа 3, 3.1). Выход процесса стал сном:
 * такую сессию письмо поднимает. Отчитавшаяся тоже спит, но с итогом — если её
 * процесс на деле жив, сверка живости вернёт её в `active`.
 */
function migrateSessionV1(session: Record<string, unknown>): void {
  const status = session['status'] === LEGACY_IDLE ? 'active' : session['status'];
  const history = session['history'] as unknown[];
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const event = entry['status'];
    entry['event'] = event === 'exited' ? 'sleeping' : event === LEGACY_IDLE ? 'active' : event;
    delete entry['status'];
  }

  if (status === 'done' || status === 'failed') {
    session['lifecycle'] = 'sleeping';
    session['result'] = status;
    const last = [...history]
      .reverse()
      .find((entry) => isRecord(entry) && entry['event'] === status);
    session['resultAt'] = isRecord(last) && typeof last['at'] === 'string' ? last['at'] : null;
  } else {
    session['lifecycle'] = status === 'exited' ? 'sleeping' : status;
    session['result'] = null;
    session['resultAt'] = null;
  }
  session['closedAt'] = null;
  delete session['status'];
}

/** Один адресат v1 → список; отметка прочтения v1 была его, она и переезжает. */
function migrateMessageV1(message: Record<string, unknown>): void {
  const to = message['to'] as string;
  const readAt = message['readAt'];
  message['roomId'] = null;
  message['to'] = [to];
  message['readBy'] = typeof readAt === 'string' ? { [to]: readAt } : {};
  delete message['readAt'];
}

/**
 * Письма до 2026-09-08 вида не знали: заметка (спецификация 2026-09-08, 3.1).
 * Миграция при чтении, как у `idle`: читатели карты дефолта не знают, а файл
 * получит поле при первой же мутации.
 */
function migrateMessage(message: Record<string, unknown>): void {
  message['kind'] ??= 'note';
}

/** Снимок рецепта в карте: ровно три строки, без лишних полей; границы — как у файла рецепта (1 MiB). */
function isRecipeSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['id', 'name', 'playbook'].every((key) => keys.includes(key))) return false;
  const { id, name, playbook } = value;
  return typeof id === 'string' && id !== '' && id.length <= 300 && typeof name === 'string' && name !== '' &&
    name.length <= 300 && typeof playbook === 'string' && Buffer.byteLength(playbook, 'utf8') <= 1024 * 1024;
}

/**
 * Ведущего и решения в комнатах до 2026-09-29 не было: подставляется `null`, а ведущим
 * такой комнаты считается первый из `members` (`roomLead`). Запись, которая не объект,
 * не трогаем — как и прежде, её форму проверять некому.
 */
function migrateRoom(room: unknown): void {
  if (!isRecord(room)) return;
  room['lead'] ??= null;
  room['proposal'] ??= null;
  room['mode'] ??= 'free';
  if (!['free', 'checklist', 'verified'].includes(String(room['mode']))) throw new Error('invalid room mode');
  room['recipe'] ??= null;
  if (room['recipe'] !== null && !isRecipeSnapshot(room['recipe'])) throw new Error('invalid room recipe');
  if (room['recipeLeadNotified'] !== undefined && typeof room['recipeLeadNotified'] !== 'string') throw new Error('invalid room recipe');
  if (isRecord(room['proposal'])) room['proposal']['kind'] ??= 'decision';
}

/** Полей процесса в старых картах просто не было. */
function migrateSession(session: Record<string, unknown>): void {
  session['pid'] ??= null;
  session['startedAtProcess'] ??= null;
  session['launchedBy'] ??= null;
  // Роли появились 2026-09-08: до них сессия запускалась только сама собой.
  if (!Object.hasOwn(session, 'role')) {
    session['role'] = typeof session['agent'] === 'string' && session['agent'] !== ''
      ? { source: 'claude', name: session['agent'] } : null;
  }
  const role = session['role'];
  if (role !== null && (!isRecord(role) || !['builtin', 'claude', 'codex'].includes(String(role['source'])) ||
    typeof role['name'] !== 'string' || role['name'] === '')) throw new Error('invalid session role');
  delete session['agent'];
  // Worktree появился в куске 4.1: до него все сессии работали прямо в проекте.
  session['worktree'] ??= null;
}
