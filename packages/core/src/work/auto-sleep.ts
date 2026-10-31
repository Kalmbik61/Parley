/**
 * Сон агентов без процесса (спека 2026-10-30, 4.1): решение «усыплять сессию или нет» и проверка «письмо в последнюю
 * секунду». Функции чистые — часы, диск, PTY, лимиты и сама остановка процесса живут в `host/sleep/`, здесь только
 * решение по снимку состояния, как у `deliveryAction`.
 */

import type { SessionActivity } from './activity.js';
import type { LetterTx } from './letter-store.js';
import type { Message, WorkSession } from './types.js';

export interface AutoSleepInput {
  session: Pick<WorkSession, 'id' | 'lifecycle' | 'keepAwake' | 'autoSleepPending'>;
  /** Провайдер сессии на Claude Code (`isClaudeCode(session.provider)`); Codex не засыпает. */
  claudeCode: boolean;
  /** Свёртка журнала хуков (`activityOf`); `null` — ничего не известно. */
  activity: SessionActivity | null;
  /** С запуска процесса пришло хоть одно событие хуков (`hookedSince`). */
  hooked: boolean;
  /** В терминале агента есть недописанный ввод человека. */
  hasDraft: boolean;
  /** Указатель на письма уже набирается в терминал сессии. */
  pointerInFlight: boolean;
  /** Непрочитанные письма сессии. */
  unread: number;
  /** Идёт сжатие контекста. */
  compacting: boolean;
  /** Когда хост увидел начало текущего `wait_for` (мс); `null` — не видел (хост перезапускался). */
  waitStartedAt: number | null;
  /** Часы вызова (мс). */
  now: number;
  /** Сон включён (`sleepAfterMinutes > 0`). */
  enabled: boolean;
  /** Сколько сессия должна простоять, мс; 0 — без порога (королева завершённого роя). */
  thresholdMs: number;
  /** Ждущих в `wait_for` усыплять (итог спайка, задача 0 плана). */
  allowWaiters: boolean;
}

/**
 * Почему сессию сейчас не усыпляют. Порядок списка — порядок проверок: первая сработавшая и есть ответ.
 * - `off` — сон выключен;
 * - `not-claude` — провайдер не на Claude Code;
 * - `not-active` — сессия не `active`: усыплять нечего;
 * - `keep-awake` — человек запретил сон;
 * - `pending` — отметка «засыпает» уже стоит;
 * - `no-hooks` — с запуска не было хуков: хост не знает, что на экране;
 * - `need` — сессия ждёт человека, сброса лимита или входа;
 * - `background` — в последнем снимке `background_tasks` есть работающая задача любого вида;
 * - `draft` — в терминале черновик человека;
 * - `pointer` — указатель на письма в полёте;
 * - `unread` — есть непрочитанные письма;
 * - `compacting` — идёт сжатие контекста;
 * - `working` — агент работает или о конце его хода ничего не известно;
 * - `waiter-start-unknown` — агент ждёт в `wait_for`, а начала ожидания хост не видел;
 * - `waiters-off` — ждущих в `wait_for` не усыпляют;
 * - `too-soon` — простой короче порога.
 */
export type AutoSleepBlock =
  | 'off'
  | 'not-claude'
  | 'not-active'
  | 'keep-awake'
  | 'pending'
  | 'no-hooks'
  | 'need'
  | 'background'
  | 'draft'
  | 'pointer'
  | 'unread'
  | 'compacting'
  | 'working'
  | 'waiter-start-unknown'
  | 'waiters-off'
  | 'too-soon';

/**
 * Ответ: усыплять (`idleSince` — с какого момента, мс, сессия простаивает; `waitTarget` — цель `wait_for(<id>)`, для
 * `inbox` и конца хода `null`) или причина не усыплять.
 */
export type AutoSleepVerdict =
  | { sleep: true; idleSince: number; waitTarget: string | null }
  | { sleep: false; block: AutoSleepBlock };

/**
 * Решение «усыплять сессию сейчас или нет» (спека 4.1). Проверки идут в порядке `AutoSleepBlock`, первая сработавшая —
 * ответ. Простой считается по ветке: агент ждёт в `wait_for` (`waitingFor`) — часы от начала ожидания, которое помнит
 * хост; ход окончен (`idle`, `unseen`) — часы от `turnEndedAt`. Остальное — `working`.
 */
export function autoSleepVerdict(input: AutoSleepInput): AutoSleepVerdict {
  const { session, activity, now } = input;
  const no = (block: AutoSleepBlock): AutoSleepVerdict => ({ sleep: false, block });
  // Порог 0 — без порога: метка конца хода чуть впереди часов хоста «рано» не даёт.
  const tooSoon = (idleSince: number): boolean => input.thresholdMs > 0 && now - idleSince < input.thresholdMs;

  if (!input.enabled) return no('off');
  if (!input.claudeCode) return no('not-claude');
  if (session.lifecycle !== 'active') return no('not-active');
  if (session.keepAwake === true) return no('keep-awake');
  if (session.autoSleepPending != null) return no('pending');
  if (!input.hooked) return no('no-hooks');
  if (activity?.need != null) return no('need');
  // Любой вид, без срока давности: фоновая команда сессию `working` не делает, но уснуть ей не даёт.
  if (activity !== null && activity.runningBackground.length > 0) return no('background');
  if (input.hasDraft) return no('draft');
  if (input.pointerInFlight) return no('pointer');
  if (input.unread > 0) return no('unread');
  if (input.compacting) return no('compacting');

  // Ветка ожидания: внутри `wait_for` сессия `working`, поэтому её признак — `waitingFor`, а не `activity`.
  if (activity !== null && activity.waitingFor !== null) {
    if (input.waitStartedAt === null) return no('waiter-start-unknown');
    if (!input.allowWaiters) return no('waiters-off');
    if (tooSoon(input.waitStartedAt)) return no('too-soon');
    return {
      sleep: true,
      idleSince: input.waitStartedAt,
      waitTarget: activity.waitingFor === 'inbox' ? null : activity.waitingFor,
    };
  }

  // Ветка конца хода.
  if (activity !== null && (activity.activity === 'idle' || activity.activity === 'unseen')) {
    // Времени конца хода нет (ничего не известно) или оно нечитаемо: часов нет, а усыплять по ним нельзя.
    const endedAt = activity.turnEndedAt === null ? Number.NaN : Date.parse(activity.turnEndedAt);
    if (Number.isNaN(endedAt)) return no('working');
    if (tooSoon(endedAt)) return no('too-soon');
    return { sleep: true, idleSince: endedAt, waitTarget: null };
  }

  return no('working');
}

/**
 * Письмо выдано сессии (метка `readBy`) позже `sinceIso`: модель его ещё не видела. Прямые письма ищет `involving`, но
 * рассылка комнаты (`to` пуст) под него не попадает, хотя выдаётся сессии так же, — её ищет вторая выборка, по новейшим
 * письмам работы. Лишнее совпадение только отменяет сон, а пропущенное потеряло бы письмо.
 */
export function deliveredSince(letters: Pick<LetterTx, 'query'>, sessionId: string, sinceIso: string): boolean {
  const delivered = (message: Message): boolean => (message.readBy[sessionId] ?? '') > sinceIso;
  return (
    letters.query({ involving: [sessionId], limit: 50, newestFirst: true }).some(delivered) ||
    letters.query({ limit: 50, newestFirst: true }).some(delivered)
  );
}

/**
 * Сессии не выдают письма (`check_inbox`, `wait_for`): хост усыпляет её — стоит отметка «засыпает»
 * (`autoSleepPending`) — или уже усыпил, а процесс, не успевший остановиться, ещё зовёт инструменты (`sleeping` с
 * `autoSleep`). Письма остаются непрочитанными и поднимут сессию после сна: отданное письмо модель получила бы за миг до
 * остановки и не прочла бы. Остановленная человеком (`sleeping` без `autoSleep`) не огорожена, её правила прежние.
 */
export function inboxFenced(session: WorkSession): boolean {
  return session.autoSleepPending != null || (session.lifecycle === 'sleeping' && session.autoSleep != null);
}
