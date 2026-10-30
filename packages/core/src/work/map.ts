import { isPublishedAgentPlan } from '../agent-plan.js';
import { validateDecisionJournalStorage } from './decision-journal.js';
import { validatePlanStorage } from './plans.js';
import { validatePlanEffects } from './plan-effects.js';
import { compactStoredTexts } from './stored-texts.js';
import { validateResources } from './resource-policy.js';
import { SWARM_ROLES, SWARM_STATUSES, isSwarmTag, isSwarmTerminal } from './swarms.js';
import { EFFORT_TOKEN, type EffortLevel } from '../providers.js';
import type { LetterTx } from './letter-store.js';
import { defaultSessionName, NEW_LABEL } from './names.js';
import type {
  CodexThreadBinding,
  HistoryEntry,
  Message,
  MessageKind,
  MessageVia,
  SessionLifecycle,
  SessionResult,
  WindowWorkMap,
  WorkMap,
  WorkProvider,
  WorkSession,
  SessionRole,
  WorksIndex,
} from './types.js';
import type { WorkSwarm } from './swarms.js';

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

/**
 * Следующий id сообщения внутри работы: `m-01`, `m-02`, … Номер — по списку, но не ниже `work.messageSeq`:
 * удалённая комната уносит свои письма, и их id не переиспользуются.
 */
export function nextMessageId(map: WindowWorkMap): string {
  const next = Math.max(map.work.messageSeq ?? 0, maxNumber(map.messages.map((message) => message.id), 'm-')) + 1;
  return `m-${String(next).padStart(2, '0')}`;
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
  /** Сессия-создатель (`create_session` агента); без поля — записи как до этого куска. */
  createdBy?: string;
  contextFrom?: string[];
  /** Роль Claude Code, которой запустится сессия; без неё — обычная сессия. */
  agent?: string | null;
  role?: SessionRole | null;
  /** Модель и усилие запуска (`spawn_session`); без них — по умолчанию, поля в записи не будет. */
  model?: string | null;
  effort?: EffortLevel | null;
  /** Облегчённый запуск (C2.2): решение при создании; без поля — запись как до этого куска. */
  lean?: boolean;
  workspace?: WorkSession['workspace'];
}

/**
 * Заводит в карте сессию `pending` — так её создаёт и агент, и пользователь. Пустой (после обрезки) ярлык и
 * `NEW_LABEL` имени не дают: сессия получает `defaultSessionName` по своему номеру, как бы её ни завели.
 */
export function addSession(
  map: WorkMap,
  init: NewSession,
  at = new Date().toISOString(),
): WorkSession {
  if (init.parent != null) throw new Error('Parley sessions cannot have a parent');
  if (init.agent !== undefined && init.role !== undefined) throw new Error('agent-and-role-conflict');
  const id = nextSessionId(map);
  const session: WorkSession = {
    id,
    provider: init.provider,
    label: init.label.trim() === '' || init.label === NEW_LABEL ? defaultSessionName(id) : init.label,
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
    ...(init.workspace === undefined ? {} : { workspace: init.workspace }),
    ...(init.createdBy === undefined ? {} : { createdBy: init.createdBy }),
    ...(init.model === undefined ? {} : { model: init.model }),
    ...(init.effort === undefined ? {} : { effort: init.effort }),
    ...(init.lean === undefined ? {} : { lean: init.lean }),
  };
  map.sessions.push(session);
  return session;
}

/**
 * Убирает сессию из карты (план от 2026-09-06, раздел C). Дети
 * поднимаются к родителю удалённой, её id уходит из чужих `contextFrom`, а
 * письма остаются с пометкой `deleted` (`letters.flagDeleted`, спека хранилища 6.2) — переписку задним числом не
 * переписывают. След удаления — только id в `work.deletedSessions`: ни ярлыка, ни задачи, ни
 * резюме в карте не остаётся.
 */
export function removeSession(
  map: WorkMap,
  letters: LetterTx,
  sessionId: string,
  now = new Date().toISOString(),
): WorkSession {
  const at = map.sessions.findIndex((candidate) => candidate.id === sessionId);
  if (at === -1) throw new Error(`session ${sessionId} is not in the map`);
  const [removed] = map.sessions.splice(at, 1) as [WorkSession];

  for (const session of map.sessions) {
    if (session.parent === sessionId) session.parent = removed.parent;
    // Как комната без владельца: сессия удалённого создателя встаёт в сайдбаре на верхний уровень.
    if (session.createdBy === sessionId) session.createdBy = null;
    if (session.contextFrom.includes(sessionId)) {
      session.contextFrom = session.contextFrom.filter((id) => id !== sessionId);
    }
  }
  for (const room of map.rooms) if (room.ownerId === sessionId) room.ownerId = null;
  // Рои (спека роя, 2.2): создатель-сессия уходит к человеку; запись удалённого участника остаётся (счётчик не прыгает,
  // его состояние выводит `memberState`); удалённая королева отменяет рой, если он ещё идёт.
  for (const swarm of map.swarms ?? []) {
    if (swarm.creator.kind === 'session' && swarm.creator.sessionId === sessionId) swarm.creator = { kind: 'human' };
    if (swarm.queen === sessionId && !isSwarmTerminal(swarm.status)) {
      swarm.status = 'cancelled';
      swarm.failure = 'queen deleted';
      swarm.endedAt = now;
    }
  }
  letters.flagDeleted(sessionId);

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
  via?: MessageVia;
}

/**
 * Кладёт сообщение в карту с письмами непрочитанным: доставка — pull через `check_inbox` или `wait_for("inbox")`. Карта с письмами — это
 * `WindowWorkMap` (тесты, окно и сверка переезда); в базе письма кладёт `LetterTx.add` (спека хранилища 6.2).
 */
export function addMessage(map: WindowWorkMap, init: NewMessage, at = new Date().toISOString()): Message {
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
    ...(init.via === undefined ? {} : { via: init.via }),
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

const BINDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Строгая форма private evidence; malformed optional field не ломает чтение самой сессии. */
export function isCodexThreadBinding(value: unknown): value is CodexThreadBinding {
  return isRecord(value) && Object.keys(value).length === 4 &&
    Object.keys(value).every((key) => ['launchRevision', 'pid', 'startedAtProcess', 'threadId'].includes(key)) &&
    typeof value.launchRevision === 'string' && BINDING_UUID.test(value.launchRevision) &&
    typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.startedAtProcess === 'string' && value.startedAtProcess.length >= 1 && value.startedAtProcess.length <= 64 &&
    !Array.from(value.startedAtProcess).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    }) &&
    (value.threadId === null || (typeof value.threadId === 'string' && BINDING_UUID.test(value.threadId)));
}

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
    Array.isArray(value.history) &&
    (value.agentPlan === undefined || isPublishedAgentPlan(value.agentPlan)) &&
    (value.workspace === undefined || value.workspace === null ||
      (isRecord(value.workspace) && isNonemptyString(value.workspace.path) &&
        (value.workspace.kind === 'artifacts' || value.workspace.kind === 'clone' &&
          [value.workspace.branch, value.workspace.sha].every(isNonemptyString))));

/** Поле письма — строка: так оно ляжет в колонку таблицы `messages` (спека хранилища 6.2). */
const isText = (value: unknown): value is string => typeof value === 'string';

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonemptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const isNullableString = (value: unknown): boolean => value === null || isString(value);
const isNullableNonemptyString = (value: unknown): boolean => value === null || isNonemptyString(value);
const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every(isString);
const isSafeCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const ATTEMPT_STATUSES = [
  'starting', 'running', 'submitted', 'checking', 'accepted', 'queued', 'integrated',
  'returned', 'blocked', 'aborted', 'superseded',
];
const OP_KINDS = [
  'create-session', 'launch', 'close-session', 'stop-session', 'clone', 'capture', 'merge',
  'noop-integration', 'merge-abort', 'check', 'copy-artifacts', 'cleanup', 'resume',
];

function isHandoffManifest(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && isNullableNonemptyString(value.sha) &&
    isSafeCount(value.criteriaVersion) && isStringArray(value.dependsOn) &&
    isString(value.coverage) && ['covered', 'partial', 'failed', 'unstarted'].includes(value.coverage) &&
    isString(value.scope) && isStringArray(value.facts) && isStringArray(value.hypotheses) &&
    isStringArray(value.notFound) && isStringArray(value.gaps) && isString(value.text) && value.text.length <= 4096 &&
    Array.isArray(value.artifacts) && value.artifacts.every((artifact) =>
      isRecord(artifact) && isString(artifact.path) && isNonemptyString(artifact.sha256) && isString(artifact.storedAs)) &&
    isString(value.hash) && isString(value.submittedAt);
}

function isReceipt(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isString(value.attemptId) && isNonemptyString(value.manifestHash) &&
    isNonemptyString(value.sha) && isSafeCount(value.criteriaVersion) && typeof value.valid === 'boolean' &&
    isNullableString(value.reason) && isString(value.at);
}

function isPlanAttempt(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isSafeCount(value.item) && isSafeCount(value.n) &&
    isSafeCount(value.planRev) && isSafeCount(value.criteriaVersion) && isNullableString(value.worker) &&
    isNullableString(value.verifier) && isNonemptyString(value.branch) && isNonemptyString(value.baseSha) &&
    isNullableNonemptyString(value.sha) && isNullableNonemptyString(value.tree) && isNullableString(value.submissionKey) &&
    isString(value.status) && ATTEMPT_STATUSES.includes(value.status) &&
    (value.manifest === null || isHandoffManifest(value.manifest)) &&
    (value.receipt === null || isReceipt(value.receipt)) && isStringArray(value.checks) &&
    isNullableString(value.failureSignature) && isString(value.startedAt) && isNullableString(value.endedAt) &&
    Array.isArray(value.log) && value.log.every((entry) =>
      isRecord(entry) && isString(entry.at) && isString(entry.by) && isString(entry.status) &&
      ATTEMPT_STATUSES.includes(entry.status) && isNullableString(entry.note) && isNullableString(entry.op));
}

function isCheckSpec(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isSafeCount(value.item) && isStringArray(value.argv) &&
    isString(value.cwd) && isRecord(value.env) && Object.values(value.env).every(isString) &&
    Array.isArray(value.inputs) && value.inputs.every((input) =>
      isRecord(input) && isString(input.path) && isString(input.blob)) &&
    isSafeCount(value.timeoutMs) && isString(value.frozenAt);
}

function isIntegration(value: unknown): boolean {
  return isRecord(value) && isNonemptyString(value.branch) && isNonemptyString(value.baseSha) && isNonemptyString(value.verifiedHead) &&
    isNullableNonemptyString(value.candidateHead) && isStringArray(value.queue) &&
    (value.suspended === null || (isRecord(value.suspended) && isString(value.suspended.reason) &&
      isString(value.suspended.attemptId) && isString(value.suspended.at)));
}

function isAutonomousBudget(value: unknown): boolean {
  return isRecord(value) && isRecord(value.limits) &&
    ['attemptsPerItem', 'repairWaves', 'minutesPerAttempt', 'sessions', 'concurrent']
      .every((key) => isSafeCount((value.limits as Record<string, unknown>)[key])) &&
    isRecord(value.spent) && ['attempts', 'repairWaves', 'sessions', 'verifiers', 'minutes', 'launches']
      .every((key) => isSafeCount((value.spent as Record<string, unknown>)[key])) &&
    Array.isArray(value.reservations) && value.reservations.every((reservation) =>
      isRecord(reservation) && isString(reservation.key) &&
      (reservation.kind === 'session' || reservation.kind === 'launch') &&
      isString(reservation.attemptId) && isString(reservation.at));
}

function isAutonomousOp(value: unknown): boolean {
  return isRecord(value) && isString(value.key) && isString(value.kind) && OP_KINDS.includes(value.kind) &&
    isNullableString(value.attemptId) && isRecord(value.payload) &&
    isString(value.state) && ['intended', 'done', 'failed'].includes(value.state) &&
    isString(value.at) && isNullableString(value.settledAt) && (value.result === null || isRecord(value.result));
}

function isAutonomousPlan(value: unknown): boolean {
  return isRecord(value) && isAutonomousBudget(value.budget) &&
    Array.isArray(value.checks) && value.checks.every(isCheckSpec) && isRecord(value.coverage) &&
    Object.entries(value.coverage).every(([item, criteria]) =>
      String(Number(item)) === item && isSafeCount(Number(item)) && Number(item) > 0 && isRecord(criteria) &&
      Object.entries(criteria).every(([index, checks]) =>
        String(Number(index)) === index && isSafeCount(Number(index)) && isStringArray(checks))) &&
    isRecord(value.criteriaVersion) && Object.entries(value.criteriaVersion).every(([item, version]) =>
      String(Number(item)) === item && isSafeCount(Number(item)) && Number(item) > 0 &&
      isSafeCount(version) && (version as number) >= 1) &&
    isIntegration(value.integration) && Array.isArray(value.attempts) && value.attempts.every(isPlanAttempt) &&
    Array.isArray(value.ops) && value.ops.every(isAutonomousOp) &&
    (value.halted === null || (isRecord(value.halted) && isString(value.halted.reason) &&
      ['budget', 'no_progress', 'stuck', 'restart', 'confinement', 'human'].includes(value.halted.reason) &&
      isString(value.halted.at) && isString(value.halted.detail))) &&
    isRecord(value.seq) && ['attempt', 'receipt', 'check', 'op']
      .every((key) => isSafeCount((value.seq as Record<string, unknown>)[key]));
}

/** Только безопасные пустые значения; конфигурацию Go не выдумываем (план автономной комнаты, §2). */
function validateAutonomousStorage(map: WorkMap): void {
  for (const plan of map.plans ?? []) {
    if (plan.mode !== 'autonomous') {
      if (plan.autonomous !== undefined) throw new Error('invalid autonomous plan');
      continue;
    }
    const value: unknown = plan.autonomous;
    if (!isRecord(value)) throw new Error('invalid autonomous plan');
    if (value.attempts === undefined) value.attempts = [];
    if (value.ops === undefined) value.ops = [];
    if (isRecord(value.budget) && value.budget.reservations === undefined) value.budget.reservations = [];
    if (value.halted === undefined) value.halted = null;
    if (value.seq === undefined) value.seq = {};
    if (isRecord(value.seq))
      for (const key of ['attempt', 'receipt', 'check', 'op'])
        if (value.seq[key] === undefined) value.seq[key] = 0;
    if (!isAutonomousPlan(value)) throw new Error('invalid autonomous plan');
  }
}

/**
 * Что не так с письмом прежней карты: первая найденная причина или `undefined`, если письмо годится. Письма уходят в
 * таблицы (спека хранилища 6.2, переезд — 6.6), и поле неверной формы не должно всплыть сырой ошибкой `TypeError` или
 * SQLite из вставки: отказ называет письмо и поле. У письма v2 адресаты — массив (по нему идут `removeSession` и
 * `recipientsOf`), комната — строка или `null`, отметки прочтения — объект «читатель → время», время письма читается как
 * дата (по нему идёт сравнение `sinceAt`). Письмо v1 `roomId` и `readBy` ещё не знает — их ставит `migrateMessageV1`.
 */
function letterProblem(version: 1 | 2, value: unknown): string | undefined {
  if (!isRecord(value)) return 'a letter is not an object';
  if (!isText(value.id)) return 'a letter has no string id';
  const bad = (field: string): string => `letter ${value.id as string} has an invalid ${field}`;
  if (version === 1 ? !isText(value.to) : !Array.isArray(value.to) || !value.to.every(isText)) return bad('to');
  if (!isText(value.from)) return bad('from');
  if (!isText(value.text)) return bad('text');
  if (!isText(value.at) || Number.isNaN(Date.parse(value.at))) return bad('at');
  if (value.kind !== undefined && value.kind !== null && !isText(value.kind)) return bad('kind');
  if (value.deleted !== undefined && typeof value.deleted !== 'boolean') return bad('deleted');
  if (version === 2) {
    if (value.roomId !== null && !isText(value.roomId)) return bad('roomId');
    if (!isRecord(value.readBy) || !Object.values(value.readBy).every(isText)) return bad('readBy');
  }
  return undefined;
}

/**
 * Разбирает прежнюю карту `map.json` вместе с письмами. Форма undocumented-логов тут ни при чём: файл пишем мы сами,
 * поэтому чужая форма — повод отказаться, а не догадываться (раздел 8). Карта v1 поднимается до v2 в памяти. Письма в
 * хранимой карте не живут (спека хранилища 6.2): этот разбор нужен переезду прежних файлов в базу и тестам.
 */
export function parseMap(raw: string, file: string): WindowWorkMap {
  return normalizeLegacyMap(parseMapText(raw, file), file);
}

/**
 * Первая половина `parseMap`: текст в сырой объект, форму не проверяет (спека хранилища 6.2). Имя источника —
 * только для текста отказа: это файл `map.json` или работа, чьи строки собраны из базы.
 */
export function parseMapText(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`map ${source} cannot be parsed: ${(error as Error).message}`);
  }
}

/**
 * Вторая половина `parseMap` для карты с письмами: проверка формы писем и их миграции, затем `normalizeMap` остального
 * (спека хранилища 6.2). Правит `data` на месте; письма остаются в нём как `messages`.
 */
export function normalizeLegacyMap(data: unknown, source: string): WindowWorkMap {
  const version = isRecord(data) ? data.schemaVersion : undefined;
  if (!isRecord(data) || (version !== 1 && version !== 2) || !Array.isArray(data.messages)) {
    throw new Error(`map ${source} cannot be parsed: unexpected shape`);
  }
  for (const letter of data.messages) {
    const problem = letterProblem(version, letter);
    if (problem !== undefined) throw new Error(`map ${source} cannot be parsed: unexpected shape (${problem})`);
  }
  if (version === 1) for (const message of data.messages as Record<string, unknown>[]) migrateMessageV1(message);
  for (const message of data.messages as Record<string, unknown>[]) migrateMessage(message);
  return normalizeMap(data, source) as WindowWorkMap;
}

/**
 * Проверка формы, подъём v1 до v2, миграции записей и проверки хранимой карты целиком (спека хранилища 6.2). Нужна
 * отдельно потому, что карту из базы собирает `rowsToMap`, а не `JSON.parse`. Писем в хранимой карте нет: их форму
 * проверяет `LetterTx.add` при записи, а старые файлы — `normalizeLegacyMap`. Правит `data` на месте и идемпотентна:
 * уже разобранная карта проходит без изменений.
 */
export function normalizeMap(data: unknown, source: string): WorkMap {
  const work = isRecord(data) ? data.work : undefined;
  const version = isRecord(data) ? data.schemaVersion : undefined;
  if (
    !isRecord(data) ||
    (version !== 1 && version !== 2) ||
    !isRecord(work) ||
    typeof work.id !== 'string' ||
    !Array.isArray(data.sessions) ||
    (version === 2 && !Array.isArray(data.rooms)) ||
    !data.sessions.every(isSessionShape(version))
  ) {
    throw new Error(`map ${source} cannot be parsed: unexpected shape`);
  }

  if (version === 1) {
    for (const session of data.sessions as Record<string, unknown>[]) migrateSessionV1(session);
    data.rooms = [];
    data.schemaVersion = 2;
  }

  const map = data as unknown as WorkMap;
  for (const session of map.sessions) {
    migrateSession(session as unknown as Record<string, unknown>);
  }
  for (const room of map.rooms) {
    migrateRoom(room as unknown, map.sessions);
  }
  map.plans ??= [];
  map.swarms = (Array.isArray(map.swarms) ? (map.swarms as unknown[]) : []).filter((swarm) => migrateSwarm(swarm, map)) as WorkSwarm[];
  // Старый вид (записанный экспорт с текстом, отправленный эффект с текстом) переводится при разборе (спека хранилища 6.2).
  compactStoredTexts(map);
  validatePlanStorage(map);
  validateAutonomousStorage(map);
  validatePlanEffects(map);
  validateDecisionJournalStorage(map);
  validateResources(map);
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
 *
 * Два приведения под таблицу писем (спека хранилища 6.2, 6.6): время письма становится каноническим ISO-моментом (тот же
 * момент, а запросы `sinceAt` сравнивают `at` как текст), а `deleted: false` убирается — у письма без признака тот же
 * смысл, и в таблице это колонка `deleted = 0`. Обе правки идемпотентны; форму поля уже проверил `letterProblem`.
 */
function migrateMessage(message: Record<string, unknown>): void {
  message['kind'] ??= 'note';
  message['at'] = new Date(message['at'] as string).toISOString();
  if (message['deleted'] === false) delete message['deleted'];
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

const isIsoTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Журнал участия комнаты: записи с id сессии, моментом входа и уходом (`null` — ещё в комнате). */
function isMemberLog(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry['session'] === 'string' && entry['session'] !== '' &&
    isIsoTime(entry['from']) && (entry['to'] === null || isIsoTime(entry['to'])));
}

/**
 * Ведущего и решения в комнатах до 2026-09-29 не было: подставляется `null`, а ведущим
 * такой комнаты считается первый из `members` (`roomLead`). Архива комнат (`archivedAt`) до 2026-10-08 тоже не было:
 * комната открыта. Запись, которая не объект, не трогаем — как и прежде, её форму проверять некому.
 */
function migrateRoom(room: unknown, sessions: WorkSession[]): void {
  if (!isRecord(room)) return;
  if (!Object.hasOwn(room, 'ownerId')) {
    const creator = room['creator'];
    const members = room['members'];
    if (typeof creator === 'string' && creator !== 'human' && Array.isArray(members) && !members.includes(creator)) members.push(creator);
    room['ownerId'] = sessions.some((session) => session.id === creator) ? creator : null;
  }
  if (room['ownerId'] !== null && (typeof room['ownerId'] !== 'string' || !sessions.some((session) => session.id === room['ownerId']))) throw new Error('invalid room owner');
  room['lead'] ??= null;
  room['proposal'] ??= null;
  room['archivedAt'] ??= null;
  room['mode'] ??= 'free';
  if (!['free', 'checklist', 'verified', 'autonomous'].includes(String(room['mode']))) throw new Error('invalid room mode');
  room['recipe'] ??= null;
  if (room['recipe'] !== null && !isRecipeSnapshot(room['recipe'])) throw new Error('invalid room recipe');
  if (room['recipeLeadNotified'] !== undefined && typeof room['recipeLeadNotified'] !== 'string') throw new Error('invalid room recipe');
  if (isRecord(room['proposal'])) room['proposal']['kind'] ??= 'decision';
  // Журнал участия (спека расхода токенов, 4.1): битый убирается — комната читается как созданная до журнала,
  // а карта из-за него не становится нечитаемой.
  if (room['memberLog'] !== undefined && !isMemberLog(room['memberLog'])) delete room['memberLog'];
}

/**
 * Запись роя неверной формы (нет `id`, статус вне списка, нет королевы среди участников) убирается: карта остаётся
 * читаемой, как у `memberLog`. Участник с неизвестной ролью отбрасывается; создатель, которого нет в карте, становится
 * человеком. Правит запись на месте и идемпотентна; `false` — запись надо убрать.
 */
function migrateSwarm(swarm: unknown, map: WorkMap): boolean {
  if (!isRecord(swarm)) return false;
  if (typeof swarm['id'] !== 'string' || swarm['id'] === '' || !isSwarmTag(swarm['tag']) ||
    typeof swarm['objective'] !== 'string' || typeof swarm['queen'] !== 'string' || typeof swarm['createdAt'] !== 'string' ||
    !(SWARM_STATUSES as readonly string[]).includes(String(swarm['status'])) || !Array.isArray(swarm['members'])) return false;
  const createdAt = swarm['createdAt'];
  const members = (swarm['members'] as unknown[]).filter(
    (member): member is Record<string, unknown> =>
      isRecord(member) && typeof member['sessionId'] === 'string' && (SWARM_ROLES as readonly string[]).includes(String(member['role'])),
  );
  for (const member of members) {
    if (!Number.isInteger(member['n'])) member['n'] = 1;
    if (typeof member['addedAt'] !== 'string') member['addedAt'] = createdAt;
    if (typeof member['handedAt'] !== 'string') member['handedAt'] = null;
  }
  swarm['members'] = members;
  if (!members.some((member) => member['sessionId'] === swarm['queen'] && member['role'] === 'queen')) return false;

  const creator = swarm['creator'];
  const known = isRecord(creator) && (
    (creator['kind'] === 'session' && map.sessions.some((session) => session.id === creator['sessionId'])) ||
    (creator['kind'] === 'room' && map.rooms.some((room) => room.id === creator['roomId'])) ||
    creator['kind'] === 'human');
  if (!known) swarm['creator'] = { kind: 'human' };

  const result = swarm['result'];
  swarm['result'] = isRecord(result) && typeof result['summary'] === 'string' && typeof result['at'] === 'string'
    ? { summary: result['summary'], at: result['at'], deliveredAt: typeof result['deliveredAt'] === 'string' ? result['deliveredAt'] : null }
    : null;
  for (const key of ['endedAt', 'failure', 'seenAt', 'expiredAt']) if (typeof swarm[key] !== 'string') swarm[key] = null;
  return true;
}

/** Полей процесса в старых картах просто не было; испорченный effort читается как «нет выбора». */
function migrateSession(session: Record<string, unknown>): void {
  session['pid'] ??= null;
  session['startedAtProcess'] ??= null;
  session['launchedBy'] ??= null;
  if (session['provider'] !== 'codex' || !isCodexThreadBinding(session['codexThreadBinding'])) delete session['codexThreadBinding'];
  // Роли появились 2026-09-08: до них сессия запускалась только сама собой.
  if (!Object.hasOwn(session, 'role')) {
    session['role'] = typeof session['agent'] === 'string' && session['agent'] !== ''
      ? { source: 'claude', name: session['agent'] } : null;
  }
  const role = session['role'];
  if (role !== null && (!isRecord(role) || !['builtin', 'claude', 'codex'].includes(String(role['source'])) ||
    typeof role['name'] !== 'string' || role['name'] === '')) throw new Error('invalid session role');
  delete session['agent'];
  // Создатель только для сайдбара: битое значение читается как «нет создателя», карта из-за него не ломается.
  if (session['createdBy'] !== undefined && session['createdBy'] !== null && typeof session['createdBy'] !== 'string') delete session['createdBy'];
  // Worktree появился в куске 4.1: до него все сессии работали прямо в проекте.
  session['worktree'] ??= null;
  normalizeAgentFields(session);
  // Effort уходит в команду, у Codex — в кавычки TOML: значение, не прошедшее токен, не уходит никуда.
  // Ключ убирается из прочитанной карты, и следующая её запись его уже не несёт. `null` — явный
  // «Default» (снимает умолчание роли) — остаётся.
  const effort = session['effort'];
  if (
    effort !== undefined &&
    effort !== null &&
    (typeof effort !== 'string' || !EFFORT_TOKEN.test(effort))
  ) {
    delete session['effort'];
  }
}

const AGENT_REASONS = ['limit', 'sign-in', 'provider-missing', 'manual', 'model'];
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** Запись `previousAgents` неверной формы убирается, битый `usage` снимается; запись остаётся читаемой. */
function normalizeBinding(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry) || typeof entry['provider'] !== 'string' || entry['provider'] === '' ||
    typeof entry['endedAt'] !== 'string' || typeof entry['requestedBy'] !== 'string' ||
    !AGENT_REASONS.includes(String(entry['reason'])) || !['handover', 'transcript'].includes(String(entry['carried']))) return null;
  for (const key of ['model', 'effort', 'providerSessionId', 'startedAt']) if (!nullableString(entry[key])) entry[key] = null;
  if (entry['usage'] !== undefined && !isRecord(entry['usage'])) delete entry['usage'];
  if (entry['costUsd'] !== undefined && entry['costUsd'] !== null && !(typeof entry['costUsd'] === 'number' && Number.isFinite(entry['costUsd']) && entry['costUsd'] >= 0)) delete entry['costUsd'];
  return entry;
}

/** Поля замены агента (спека 2026-10-30, 5.1): старые карты без них читаются как есть, кривые значения убираются. */
function normalizeAgentFields(session: Record<string, unknown>): void {
  const previous = session['previousAgents'];
  if (previous !== undefined) {
    const kept = Array.isArray(previous)
      ? previous.map(normalizeBinding).filter((entry): entry is Record<string, unknown> => entry !== null).slice(-20) : [];
    if (kept.length === 0) delete session['previousAgents'];
    else session['previousAgents'] = kept;
  }
  const switching = session['switching'];
  if (switching !== undefined && switching !== null &&
    !(isRecord(switching) && typeof switching['id'] === 'string' && typeof switching['to'] === 'string' && typeof switching['since'] === 'string')) {
    delete session['switching'];
  }
  if (session['agentRevision'] !== undefined && !nullableString(session['agentRevision'])) delete session['agentRevision'];
}
