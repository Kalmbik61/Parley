/**
 * Будильник сессий без канала (план, куски 1.8 и 3.4): когда простаивающего
 * агента ждёт непрочитанное письмо, хост сам печатает в его терминал текст
 * указателя и, если человек за это время не начал печатать своё, нажимает
 * Enter. Спящую сессию письмо поднимает: `resume` с указателем первым ходом,
 * не чаще `resumeRate` в час (спека 7.2, 7.4); усыплённую хостом — без этого лимита (спека сна агентов 4.1).
 *
 * Правило «печатать, поднимать или нет» — чистая `deliveryAction` из core;
 * сервис здесь решает, КОГДА её позвать (по событиям `works`/`activity`/`draft`
 * и по `resume`, без опроса), и держит между вызовами состояние попытки: какие
 * письма уже указаны и не в полёте ли уже указатель.
 *
 * Тем же путём печати сессию, упёршуюся в лимит, возвращают после сброса (спека «Застрявшие сессии», 6.3):
 * срок, предохранители и тексты отказа — в `limit-return.ts`, таймер и счётчик возвратов — здесь.
 */

import { performance } from 'node:perf_hooks';
import {
  DEFAULT_CONFIG,
  deliveryAction,
  hookedSince,
  HUMAN,
  LIMIT_RETRY_MS,
  LIMIT_RETURN_GRACE_MS,
  limitReturnText,
  loadConfig,
  loadProviders,
  openEvents,
  sessionTag,
  SYSTEM,
  PARLEY,
  letterById,
  resumablePlanLetter,
  unreadCount,
  unreadLetters,
  viewMap,
  workPaths,
  writeLetters,
  type DeliveryAction,
  type DeliveryInput,
  type Message,
  type SessionActivity,
  type WorkEntry,
  type WorkSession,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { MailWait, NoticeKind, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WindowCounters } from '../health/window-counters.js';
import { HostError } from '../errors.js';
import { mailSessions } from '../mail-sessions.js';
import { CODEX_SUBMIT_DELAY_MS, codexPaste, codexSubmitKey } from '../pty/codex-input.js';
import { choiceInProgress } from '../pty/effort-switch.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import { deliverRecipeToNewLeads } from '../rooms/rooms-service.js';
import type { LimitsService } from '../limits/limits-service.js';
import type { Attempt } from '../pty/type-and-submit.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { MailNotice, WorksService } from '../works/works-service.js';
import { limitReturnDue, limitWindowFree, returnBlock, returnBlockReason } from './limit-return.js';
import { ResumeLimiter } from './resume-limiter.js';

export interface WakeServiceOptions {
  /** Счётчики окна строки состояния: каждый `recompute` сессии — одна запись. */
  windowCounters?: WindowCounters;
  /** Пауза перед Enter — если человек уже не печатает, указатель уходит как ход (спека 7.3). */
  enterDelayMs?: number;
  /** Ход не начался за это время после указателя — предупреждение, повторного набора нет. */
  pointerTimeoutMs?: number;
  /** Лимит подъёмов; по умолчанию — `resumeRate` из настроек. Тесты подставляют свой. */
  limiter?: ResumeLimiter;
  /** Поднятая сессия вышла раньше этого срока без единого хука — подъём не удался (спека 10). */
  resumeFailWindowMs?: number;
  /** Сжатие контекста ждёт или идёт (`CompactionService.holds`, спека 2026-10-15, 5.4): указатель не печатается. */
  compacting?: (ref: SessionRef) => boolean;
  /**
   * Лимиты провайдеров хоста: время сброса неизвестно, а данные новее удара показывают свободное окно — сессию возвращают
   * через тот же запас, что после известного сброса, не дожидаясь `retryMs` (спека застрявших 6.3). Без них — только срок.
   */
  limits?: Pick<LimitsService, 'get'>;
  /** Сроки возврата после сброса лимита; по умолчанию `LIMIT_RETURN_GRACE_MS` и `LIMIT_RETRY_MS`. Рычаги E2E. */
  limitReturn?: { graceMs?: number; retryMs?: number };
  /** Окно тишины для несрочных писем и его потолок (мс); не заданы — `SETTLE_MS` и `SETTLE_MAX_MS` из core. Рычаги тестов. */
  settleMs?: number;
  settleMaxMs?: number;
}

export interface WakeService {
  start(): void;
  paused(): boolean;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Текст указателя напечатан, а Enter ещё не ушёл (таймер Enter взведён). */
  inFlight(ref: SessionRef): boolean;
  /** Пауза перед Enter из WakeServiceOptions — одна на будильник и pty.send. */
  readonly enterDelayMs: number;
  /**
   * Согласие на папку пришло (спека 2026-10-21, 4.2) или в очереди машины освободился слот (спека сна агентов 4.2):
   * удержание подъёма снимается, пауза после отказа бюджета — тоже, и сессия пересчитывается: письма, оставшиеся
   * непрочитанными, поднимают её обычным путём. У спящей сессии без процесса письма заново считаются неуказанными —
   * и после перезапуска хоста тоже.
   */
  retry(ref: SessionRef): void;
  /**
   * Агента сессии заменили (спека замены агента, 5.3 шаг 8): прежний подъём забыт — недоступный resume, удержание
   * согласия, очередь машины, пауза бюджета, эпизод лимита и указанные письма; ждавшие письма доставляются новому
   * агенту заново.
   */
  switched(ref: SessionRef): void;
}

const DEFAULT_ENTER_DELAY_MS = 500;
/** Сколько будильник верит прочитанному реестру провайдеров. */
const REGISTRY_TTL_MS = 2000;
const DEFAULT_POINTER_TIMEOUT_MS = 10_000;
const DEFAULT_RESUME_FAIL_WINDOW_MS = 5_000;
/** Уведомление о лимите подъёмов — не чаще раза в час на сессию (план, кусок 3.4). */
const LIMIT_NOTICE_EVERY_MS = 60 * 60 * 1000;
/** Пауза между просьбами о слоте после отказа бюджета работы (P37). */
const BUDGET_RETRY_MS = 30_000;
/**
 * Codex получает указатель только вставкой, а режима вставки на экране хоста может ещё не быть: экран
 * разбирает поток чуть позже сигнала терминала, по которому будильник и проснулся. Пересчёт стоит
 * повторить: 15 раз через 200 мс, дальше — до следующего события сессии.
 */
const PASTE_MODE_RETRY_MS = 200;
const PASTE_MODE_RETRIES = 15;
/**
 * Идёт смена модели или effort, либо на экране ползунок `/effort`: указатель не печатается. Смена занимает секунды —
 * пересчёт каждые 200 мс, до 30 с; дальше — до следующего события сессии.
 */
const CHOICE_RETRIES = 150;
/**
 * Запас к сроку окна тишины: таймер Node может сработать на миллисекунду раньше часов, и пересчёт увидел бы тот же
 * `settling` с остатком в одну миллисекунду.
 */
const SETTLE_SLACK_MS = 50;

/**
 * Ступень таймера возврата. Срок бывает в часах и днях, а таймер Node на macOS не идёт, пока Mac спит: один длинный
 * `setTimeout` после сна срабатывал бы на часы позже срока. Поэтому ждём ступенями по минуте и на каждой смотрим на часы.
 */
const LIMIT_TIMER_STEP_MS = 60_000;

/**
 * Эпизод лимита сессии, пока Parley ждёт срока возврата (спека застрявших 6.3). Ведётся по сессии, а не по точному
 * `since`: индекс лога сдвигает `since` в том же эпизоде, и срок от этого уходить не должен.
 */
interface LimitEpisode {
  /** Время сброса, по которому взят срок: появилось или сменилось — срок переставляется; сдвиг `since` — нет. */
  resetsAt: string | null;
  /** Когда пора вернуть сессию (мс от начала эпохи). */
  due: number;
  timer: NodeJS.Timeout | undefined;
  /** Срок наступил: условия проверяются на каждом пересчёте, пока возврат не напечатан и не отказан. */
  reached: boolean;
  /**
   * Когда исход принят (мс): возврат напечатан либо отказан уведомлением; до конца эпизода второй раз не пробуем.
   * `need` с более поздним `since` — уже новый эпизод, а не тот же. `null` — исхода ещё нет.
   */
  settledAt: number | null;
  /** Когда впервые увидели, что окно провайдера снова свободно (мс): срок встал на это время плюс запас, один раз. */
  freeAt: number | null;
}

/** Состояние одной попытки доставки указателя, живёт между пересчётами сессии. */
/** Причины, при которых письма живой сессии лежат и ждут сами по себе: о них — строка в логе. */
const LOGGED_REASONS: ReadonlySet<MailWait> = new Set<MailWait>(['busy', 'draft', 'in-flight', 'no-hooks', 'stuck', 'folder-trust']);

interface AttemptState {
  /** Id писем, на которые указатель уже печатали, — второй раз не набираем. */
  pointed: Set<string>;
  /** Указатель напечатан, ход по нему ещё не начался и не признан пропавшим. */
  inFlight: boolean;
  /** Причина, по которой письма сессии сейчас не забраны, — уже отданная окну и записанная в лог; `null` — писем нет. */
  waiting: MailWait | null;
  /**
   * Печать указателя, чей Enter ещё не ушёл (`typeAndSubmit`). Наружу — `inFlight(ref)`:
   * `pty.send` в это время отвечает busy, а не печатает поверх.
   */
  typing: Attempt | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  /** Идёт подъём этой сессии: пока PTY не заведён, второй подъём не начинаем. */
  resuming: boolean;
  /**
   * Когда будильник поднял сессию, — для распознавания провалившегося подъёма
   * по раннему выходу. `null` — процесс поднимал не будильник или срок прошёл.
   */
  resumedAt: number | null;
  /** Сколько хуков было в журнале до подъёма: новых нет — процесс не ожил. */
  journalBase: number;
  /** Письма, которыми подняли: их отправителям уходит письмо о сбое. */
  resumeLetters: string[];
  /**
   * Процесс вышел, пока `launch` подъёма ещё не вернулся: проверка раннего выхода ждёт его исхода. Запуск
   * мог сам остановить процесс, чей старт не записался в карту, — тогда о сбое скажет его ошибка, своей причиной.
   */
  earlyExit: (() => Promise<void>) | undefined;
  /**
   * Подняли без промпта (в `resumeArgs` нет `{prompt}`): указатель печатается
   * обычным путём, но только после конца хода нового процесса — до первого хука
   * старый журнал выдал бы простой ещё не запущенного агента (спека 7.3).
   */
  pointerAfter: number | null;
  /**
   * Поднять письмом нечем: у провайдера нет `resumeArgs` или id его сессии не
   * известен. Письма ждут, пока сессию поднимет человек (спека 7.5), — новый
   * процесс по брифу начал бы задачу заново. Сессию Claude с id, но без разговора
   * (транскрипта нет: процесс умер до первого сообщения), письмо поднимает новым
   * процессом с тем же id (0.2.0, `core/work/launch.ts`): задачу она так и не
   * начала, и «заново» тут нечего.
   */
  resumeUnavailable: boolean;
  /**
   * Есть ли провайдер сессии в реестре (`loadProviders` асинхронен, пересчёт — нет): последний ответ проверки.
   * Нет провайдера — сессия не поднимается и ждёт человека (`provider-missing`), слот часа не берётся.
   */
  providerCheck: { provider: string; present: boolean } | null;
  /**
   * Когда бюджет работы отказал в подъёме (P37): письма ждут, а не считаются указанными. Новую попытку не начинаем
   * `BUDGET_RETRY_MS` — иначе каждое событие карты заново стучалось бы за слотом. Это пауза между просьбами, а не
   * снятие чьего-то резерва.
   */
  budgetDeniedAt: number | null;
  /**
   * Подъём Codex удержан до согласия человека на папку (`launch` → `held`): письма ждут, а не считаются указанными, и
   * новых попыток нет, пока `retry` не снимет удержание (иначе каждое событие карты заводило бы новую просьбу). Живой
   * процесс тоже снимает его: сессию подняли другим путём.
   */
  trustHeld: boolean;
  /**
   * Класс, которым подъём стоит в очереди машины (`launch` → `queued`, спека сна агентов 4.2); `null` — не стоит. Письма
   * ждут, а не считаются указанными, и новых попыток нет, пока очередь не позовёт `retry` (иначе каждое событие карты
   * заново ставило бы запись). Исключение — письмо человека поверх класса `mail`: класс выше, и подъём пробуется сразу
   * (`recompute`). Живой процесс тоже снимает очередь: сессию подняли другим путём.
   */
  queued: 'human' | 'mail' | null;
  /**
   * Под текущий подъём взят слот часа (`limiter.tryTake`) и ещё не возвращён: вернуть (`releaseSlot`) можно только
   * взятый. Сессия, которую усыпил хост, слот не берёт (спека сна агентов 4.1), и возвращать ей нечего: иначе возврат
   * списал бы чужой подъём из счёта часа.
   */
  slotTaken: boolean;
  /** Повтор пересчёта, пока у Codex нет режима вставки (`PASTE_MODE_RETRIES`). */
  pasteRetry: NodeJS.Timeout | undefined;
  /** Пересчёт по сроку окна тишины (`settling`): один на сессию, новый срок заменяет старый. */
  settleTimer: NodeJS.Timeout | undefined;
  /** Сколько повторов уже было; с режимом вставки на экране счёт начинается заново. */
  pasteRetries: number;
  /** Повторов пересчёта, пока идёт смена модели или effort (`CHOICE_RETRIES`); без смены счёт начинается заново. */
  choiceRetries: number;
  /** Идущий эпизод лимита, срока возврата которого Parley ждёт; `undefined` — сессия не в лимите. */
  limit: LimitEpisode | undefined;
  /**
   * Автовозвратов подряд (6.3): сбрасывается ходом без ошибки лимита и ходом не от будильника, то есть промптом
   * человека. Живёт у сессии, а не у эпизода: возврат начинает ход, и ход снова упирается в лимит уже новым эпизодом.
   */
  returns: number;
  /** Ход по нашему возврату: напечатан и не начался (`pending`), идёт (`running`); `null` — такого хода нет. */
  returnTurn: 'pending' | 'running' | null;
}


/** Отказ бюджета работы из `sessions.launch` (P37): код ошибки хоста несёт `data.code`. */
const isResourceDenial = (error: unknown): boolean =>
  error instanceof HostError && error.data?.['code'] === 'resource-budget';

const workKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/** Данные доставки для журнала задержек (`mail.deliver`): когда отправлено самое новое письмо и в какой оно комнате. */
interface DeliveryTrace {
  newestAt: string | null;
  roomId: string | null;
}

/** Самое новое из писем `letterIds` среди `letters` (`at` — ISO, сравнивается строкой); таких писем нет — пусто. */
function traceOf(letters: readonly Message[], letterIds: readonly string[]): DeliveryTrace {
  let newest: Message | undefined;
  for (const message of letters) {
    if (!letterIds.includes(message.id)) continue;
    if (newest === undefined || message.at >= newest.at) newest = message;
  }
  return { newestAt: newest?.at ?? null, roomId: newest?.roomId ?? null };
}

/** Мс от отправки письма до сейчас; метки нет или она не разбирается — `null`; часы разошлись — 0. */
function sinceSentMs(newestAt: string | null): number | null {
  if (newestAt === null) return null;
  const sentAt = Date.parse(newestAt);
  return Number.isNaN(sentAt) ? null : Math.max(0, Date.now() - sentAt);
}

/** Число хуков в журнале сессии; журнала нет — ноль. */
async function journalLength(ref: SessionRef): Promise<number> {
  const events = await openEvents(workPaths(ref.projectPath, ref.workId).events)
    .read(ref.sessionId)
    .catch(() => null);
  return events?.length ?? 0;
}

export function createWakeService(
  host: HostContext,
  works: WorksService,
  activity: ActivityService,
  pty: PtyManager,
  // `exclusive` — замок смены модели и effort: пока он взят, указатель не печатается.
  sessions: Pick<SessionsService, 'launch'> & Partial<Pick<SessionsService, 'exclusive'>>,
  options: WakeServiceOptions = {},
): WakeService {
  const enterDelayMs = options.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;
  const pointerTimeoutMs = options.pointerTimeoutMs ?? DEFAULT_POINTER_TIMEOUT_MS;
  const resumeFailWindowMs = options.resumeFailWindowMs ?? DEFAULT_RESUME_FAIL_WINDOW_MS;
  const limitGraceMs = options.limitReturn?.graceMs ?? LIMIT_RETURN_GRACE_MS;
  const limitRetryMs = options.limitReturn?.retryMs ?? LIMIT_RETRY_MS;
  const settle = {
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    ...(options.settleMaxMs !== undefined ? { settleMaxMs: options.settleMaxMs } : {}),
  };

  // Как `silenceThresholdMs` в активности: настройка читается на старте.
  let resumeRate = DEFAULT_CONFIG.resumeRate;
  const limiter = options.limiter ?? new ResumeLimiter(() => resumeRate);
  const limitNoticedAt = new Map<string, number>();
  // Работы, которые будильник уже видел: письма, лежавшие непрочитанными до
  // этого, спящих не поднимают — иначе старт хоста поднял бы всех, кому
  // когда-то писали, без согласия человека (спека 10).
  const knownWorks = new Set<string>();

  const attempts = new Map<string, AttemptState>();
  let isPaused = false;
  let started = false;
  let unsubscribeWorks: (() => void) | undefined;
  let unsubscribeMail: (() => void) | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  let unsubscribeDraft: (() => void) | undefined;
  let unsubscribeHostDraft: (() => void) | undefined;
  let unsubscribeExit: (() => void) | undefined;

  function stateFor(key: string): AttemptState {
    let state = attempts.get(key);
    if (state === undefined) {
      state = {
        pointed: new Set(),
        inFlight: false,
        waiting: null,
        typing: undefined,
        timeoutTimer: undefined,
        resuming: false,
        resumedAt: null,
        journalBase: 0,
        resumeLetters: [],
        earlyExit: undefined,
        pointerAfter: null,
        resumeUnavailable: false,
        providerCheck: null,
        budgetDeniedAt: null,
        trustHeld: false,
        queued: null,
        slotTaken: false,
        pasteRetry: undefined,
        settleTimer: undefined,
        pasteRetries: 0,
        choiceRetries: 0,
        limit: undefined,
        returns: 0,
        returnTurn: null,
      };
      attempts.set(key, state);
    }
    return state;
  }

  function clearTimers(state: AttemptState): void {
    if (state.typing !== undefined) {
      const typing = state.typing;
      state.typing = undefined;
      typing.cancel();
    }
    if (state.timeoutTimer !== undefined) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }
    if (state.pasteRetry !== undefined) {
      clearTimeout(state.pasteRetry);
      state.pasteRetry = undefined;
    }
    if (state.settleTimer !== undefined) {
      clearTimeout(state.settleTimer);
      state.settleTimer = undefined;
    }
  }

  /**
   * Несрочные письма ждут тишины в комнате (`settling`): событий, которые разбудили бы сессию к сроку, может не быть —
   * пересчёт взводится на срок. Таймер один на сессию, новый срок заменяет старый; он не держит процесс хоста.
   */
  function settleLater(ref: SessionRef, state: AttemptState, retryInMs: number): void {
    if (state.settleTimer !== undefined) clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(() => {
      state.settleTimer = undefined;
      recompute(ref);
    }, retryInMs + SETTLE_SLACK_MS);
    state.settleTimer.unref();
  }

  /** Пересчёт через короткий срок, но не бесконечно: у Codex ещё нет режима вставки либо идёт смена модели. */
  function retryLater(ref: SessionRef, state: AttemptState, kind: 'paste' | 'choice'): void {
    if (state.pasteRetry !== undefined) return;
    if (kind === 'paste') {
      if (state.pasteRetries >= PASTE_MODE_RETRIES) return;
      state.pasteRetries += 1;
    } else {
      if (state.choiceRetries >= CHOICE_RETRIES) return;
      state.choiceRetries += 1;
    }
    state.pasteRetry = setTimeout(() => {
      state.pasteRetry = undefined;
      recompute(ref);
    }, PASTE_MODE_RETRY_MS);
  }

  /** Идёт смена модели или effort, открыт ползунок `/effort` (общая проверка с `pty.send`) или сжатие держит сессию. */
  const choiceNow = (ref: SessionRef): boolean =>
    options.compacting?.(ref) === true ||
    choiceInProgress(ref, { pty, switching: (target) => sessions.exclusive?.held(target) === true });

  /**
   * Журнал задержек доставки письма (спека диагностики хоста, A4): сколько прошло с отправки самого нового письма
   * и сколько заняла сама доставка. Только длины и идентификаторы — текста письма в записи нет.
   */
  function logDelivery(
    ref: SessionRef,
    action: { letterIds: readonly string[] } & DeliveryTrace,
    mode: 'pointer' | 'resume',
    startedAt: number,
    outcome: string,
  ): void {
    try {
      host.log.info('письмо доставлено', {
        op: 'mail.deliver',
        ref,
        roomId: action.roomId,
        letters: action.letterIds.length,
        sinceSentMs: sinceSentMs(action.newestAt),
        mode,
        ms: Math.round(performance.now() - startedAt),
        outcome,
      });
    } catch {
      // Журнал синхронный и при ENOSPC/EACCES бросает: диагностика не должна ломать доставку письма.
    }
  }

  function notice(kind: NoticeKind, ref: SessionRef, text: string): void {
    // И в лог: уведомление видит только открытое окно, а разбирать «сессия не ответила» приходится позже.
    host.log.info('будильник: уведомление', { kind, ref });
    host.broadcast('host.notice', { kind, ref, text, at: new Date().toISOString() });
  }

  /**
   * Причина, по которой письма сессии ещё не забраны, — окну (`LiveMetrics.mailWaiting`: комната пишет её
   * рядом с «not picked up yet») и в лог хоста, раз на причину: черновик и попытка живут только в памяти
   * хоста, и без следа «сессия не отвечает в комнате» по файлам работы не разобрать. Зовётся последним
   * делом пересчёта: рассылка активности возвращается сюда же вложенным пересчётом.
   */
  function publishWaiting(ref: SessionRef, state: AttemptState, reason: MailWait | null): void {
    if (reason === state.waiting) return;
    state.waiting = reason;
    if (reason !== null && LOGGED_REASONS.has(reason)) {
      host.log.info('будильник: письма ждут', { ref, reason });
    }
    activity.mailWaiting(ref, reason);
  }

  /**
   * Непрочитанное сессии. Пересчёт зовётся на каждое изменение работ для каждой сессии каждой работы, поэтому карту
   * берём ту, что хост уже держит (`entry.map`): из базы при числе работ больше кэша карт каждый проход грузил бы их заново
   * (спека хранилища 6.2). Живые правила идут по этой карте, письма из базы нужны только в таблицах (задача 7).
   */
  const unreadOf = (entry: WorkEntry, sessionId: string): Message[] =>
    unreadLetters(entry.projectPath, entry.map.work.id, sessionId, { map: entry.map });

  /** Есть ли непрочитанное: счёт без копий писем, карта снимка — по тем же причинам, что у `unreadOf` (спека хранилища 6.2). */
  const hasUnread = (entry: WorkEntry, sessionId: string): boolean =>
    unreadCount(entry.projectPath, entry.map.work.id, sessionId, { map: entry.map }).total > 0;

  /** Письма, непрочитанные сейчас, считаются уже указанными: будить ими некого. */
  function markUnreadPointed(ref: SessionRef, state: AttemptState, allowPlanRestart = false): void {
    const entry = works.entry(ref.projectPath, ref.workId);
    if (entry === undefined) return;
    for (const message of unreadOf(entry, ref.sessionId)) {
      if (!allowPlanRestart || !resumablePlanLetter(entry.map, message, ref.sessionId, (id) => letterById(entry.projectPath, entry.map.work.id, id))) {
        state.pointed.add(message.id);
      }
    }
  }

  /**
   * Хост усыпляет сессию (отметка `autoSleepPending`) или уже усыпил (`autoSleep`): спека сна агентов 4.1. Смотрим карту в базе,
   * а не снимок службы работ: снимок отстаёт от записи на окно сбора, а процесс останавливают сразу за отметкой. Карта не
   * прочиталась (работу сняли) — не усыпляет: остальное решит прежнее правило.
   */
  function hostSleeps(ref: SessionRef): boolean {
    try {
      return viewMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        return session !== undefined && (session.autoSleepPending != null || session.autoSleep != null);
      });
    } catch {
      return false;
    }
  }

  /**
   * Первая встреча с работой: её непрочитанные у неживых считаются указанными.
   * Зовётся из самого пересчёта, а не только из подписки на работы: активность
   * узнаёт о новой работе раньше будильника и зовёт пересчёт первой. Кроме усыплённых хостом (`autoSleep`):
   * их письма ждали подъёма, а не остановил их человек, — после перезапуска хоста они поднимают сессию (спека сна агентов 4.1).
   */
  function ensureKnown(entry: WorkEntry): void {
    const wk = workKeyOf(entry.projectPath, entry.map.work.id);
    if (knownWorks.has(wk)) return;
    knownWorks.add(wk);
    for (const session of entry.map.sessions) {
      const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
      if (pty.get(ref) === undefined && session.autoSleep == null) markUnreadPointed(ref, stateFor(refKey(ref)), true);
    }
  }

  /** Лимит подъёмов исчерпан — письма ждут, человеку уведомление раз в час. */
  function limitNotice(ref: SessionRef, reason = 'the hourly resume limit is reached'): void {
    const key = refKey(ref);
    const at = Date.now();
    const last = limitNoticedAt.get(key);
    if (last !== undefined && at - last < LIMIT_NOTICE_EVERY_MS) return;
    limitNoticedAt.set(key, at);
    notice('resume-limit', ref, `${sessionTag(ref.sessionId)} was not resumed: ${reason}, messages are waiting`);
  }

  /**
   * Подъём не удался: каждому отправителю ожидавших писем — системное письмо,
   * человеку — уведомление (спека 10). Письма считаются указанными: иначе тот
   * же сбой повторялся бы на каждом изменении карты до конца лимита.
   */
  async function resumeFailed(
    ref: SessionRef,
    state: AttemptState,
    letterIds: readonly string[],
    reason: string,
  ): Promise<void> {
    for (const id of letterIds) state.pointed.add(id);
    const text = `${sessionTag(ref.sessionId)} did not resume: ${reason}`;
    const ids = new Set(letterIds);
    try {
      // Только письма: отправители ожидавших писем читаются запросом, карта целиком не разбирается (спека хранилища 6.2).
      writeLetters(ref.projectPath, ref.workId, (letters, map) => {
        const senders = new Set(letters.query({ ids: [...ids], limit: ids.size }).map((message) => message.from));
        // Человек узнаёт из уведомления, системе писать незачем, себе — тоже.
        senders.delete(HUMAN);
        senders.delete(SYSTEM);
        senders.delete(PARLEY);
        senders.delete(ref.sessionId);
        for (const sender of senders) {
          if (!map.sessions.some((session) => session.id === sender)) continue;
          letters.add({ roomId: null, from: SYSTEM, to: [sender], text, kind: 'note' });
        }
      });
    } catch (error) {
      host.log.error('письмо о сбое подъёма не записалось', { ref, error: String(error) });
    }
    notice('resume-failed', ref, text);
  }

  /** Возвращает слот часа, если под этот подъём он был взят: подъёма не было, и час не должен платить за него. */
  function releaseSlot(ref: SessionRef, state: AttemptState): void {
    if (!state.slotTaken) return;
    state.slotTaken = false;
    limiter.release(ref);
  }

  /**
   * Поднимает спящую: указатель последним аргументом, если провайдер его
   * принимает (`{prompt}` в `resumeArgs`), иначе — без промпта и с печатью
   * указателя после первого простоя нового процесса.
   */
  async function resumeSession(
    ref: SessionRef,
    session: WorkSession,
    state: AttemptState,
    action: { text: string; letterIds: string[]; launchClass: 'human' | 'mail' } & DeliveryTrace,
  ): Promise<void> {
    state.resuming = true;
    try {
      const registry = await loadProviders();
      const template = registry[session.provider]?.runner.resumeArgs;
      // Новый агент после замены ещё не стартовал (спека замены агента, 5.3 шаг 9): письмо поднимает его — `launch`
      // сессий сам переведёт подъём в запуск с пакетом передачи, указатель уйдёт после первого простоя.
      const awaiting = (session.previousAgents?.length ?? 0) > 0 && session.providerSessionId === null;
      // Без id у провайдера core запустил бы новый процесс по брифу, а не `resume`.
      if (template === undefined || (session.providerSessionId === null && !awaiting)) {
        state.resumeUnavailable = true;
        // Подъёма не будет — слот часа, взятый под него, не потрачен.
        releaseSlot(ref, state);
        // Окно уже видит «resuming»: пересчёт покажет, что письма ждут (`sleeping`). `resuming` снимается до него, иначе
        // пересчёт снова записал бы «resuming».
        state.resuming = false;
        recompute(ref);
        return;
      }
      const withPrompt = template.includes('{prompt}') && !awaiting;

      state.journalBase = await journalLength(ref);
      state.resumeLetters = [...action.letterIds];
      state.resumedAt = Date.now();
      if (withPrompt) for (const id of action.letterIds) state.pointed.add(id);
      else state.pointerAfter = state.resumedAt;

      const launchStartedAt = performance.now();
      let outcome: Awaited<ReturnType<SessionsService['launch']>>;
      const choice = { by: 'wake', launchClass: action.launchClass };
      try {
        outcome = await sessions.launch(ref, 'resume', withPrompt ? { ...choice, prompt: action.text } : choice);
      } catch (error) {
        logDelivery(ref, action, 'resume', launchStartedAt, 'failed');
        throw error;
      }
      if (outcome === 'held' || outcome === 'queued') {
        // Запуск не начался и не сорвался: `held` — Codex ждёт согласия человека на папку, `queued` — потолок машины или
        // давление памяти держат его в очереди (спека сна агентов 4.2). Процесса нет, слот часа не потрачен, письма не
        // прочитаны, а сбоя нет — ни письма отправителям, ни уведомления. Как отказ бюджета, но ожидание снимает не срок:
        // согласие либо очередь, позвавшая `retry`.
        logDelivery(ref, action, 'resume', launchStartedAt, outcome);
        state.earlyExit = undefined;
        state.resumedAt = null;
        state.pointerAfter = null;
        releaseSlot(ref, state);
        for (const id of action.letterIds) state.pointed.delete(id);
        if (outcome === 'held') state.trustHeld = true;
        else state.queued = action.launchClass;
        // `resuming` снимается до публикации: вложенный пересчёт, который она вызывает, иначе записал бы «resuming».
        state.resuming = false;
        publishWaiting(ref, state, outcome === 'held' ? 'folder-trust' : 'queued');
        return;
      }
      logDelivery(ref, action, 'resume', launchStartedAt, 'launched');
      const earlyExit = state.earlyExit;
      state.earlyExit = undefined;
      if (earlyExit !== undefined) void earlyExit();
    } catch (error) {
      state.earlyExit = undefined;
      state.resumedAt = null;
      state.pointerAfter = null;
      if (isResourceDenial(error)) {
        // Бюджет работы отказал до запуска: процесса нет, слот не получен. Это не сбой подъёма — письма остаются
        // непрочитанными и ждут, а счёт часа возвращается, чтобы отказ не расходовал его впустую.
        releaseSlot(ref, state);
        for (const id of action.letterIds) state.pointed.delete(id);
        state.budgetDeniedAt = Date.now();
        limitNotice(ref, `the workspace budget is exhausted (${(error as Error).message})`);
        publishWaiting(ref, state, 'resume-limit');
      } else {
        await resumeFailed(ref, state, action.letterIds, (error as Error).message);
      }
    } finally {
      state.resuming = false;
    }
  }

  /** Процесс поднятой сессии вышел в срок сбоя: ни одного нового хука — не ожил. */
  async function checkEarlyExit(
    ref: SessionRef,
    state: AttemptState,
    exitCode: number,
    base: number,
    letterIds: readonly string[],
  ): Promise<void> {
    if ((await journalLength(ref)) > base) return;
    await resumeFailed(ref, state, letterIds, `the process exited with code ${exitCode} before starting work`);
  }

  /**
   * Печатает текст указателя и заводит оба таймера попытки: Enter и предохранитель. Codex — своим
   * порядком (спека комнат, 3.6): вставка в маркерах bracketed paste, пауза десятки миллисекунд, а
   * клавиша — Tab занятому агенту (очередь на следующий ход) и Enter у приглашения.
   */
  function beginAttempt(
    ref: SessionRef,
    state: AttemptState,
    action: { text: string; letterIds: string[]; queue?: true } & DeliveryTrace,
    codex = false,
  ): void {
    // Печать и Enter — общая механика с pty.send (кусок 5.1): Enter через паузу тому же
    // pid, отмена по вводу человека. Черновиком хоста свой указатель не помечается —
    // правила будильника (спека 7.3) прежние.
    // Перед Enter — снова `blocked`: запрос разрешения мог появиться за паузу (fix-final-b).
    const startedAt = performance.now();
    const typing = typeAndSubmit(
      { pty, enterDelayMs },
      ref,
      codex ? codexPaste(action.text) : action.text,
      true,
      {
        // Смена модели или ползунок могли открыться за паузу: Enter в ползунке сохранил бы уровень умолчанием.
        beforeEnter: () => activity.get(ref)?.activity.activity !== 'blocked' && !choiceNow(ref),
        ...(codex
          ? {
              delayMs: CODEX_SUBMIT_DELAY_MS,
              submitKey: () => codexSubmitKey(activity.get(ref)?.activity.activity),
            }
          : {}),
      },
    );
    state.typing = typing;
    for (const id of action.letterIds) state.pointed.add(id);

    // Указатель в очереди занятого агента хода не начинает — начнёт его сам Codex, когда дойдёт очередь,
    // и ждать «ход после указателя» нечего: `inFlight` и предохранитель были бы ложной тревогой.
    if (action.queue !== true) {
      state.inFlight = true;

      // Предохранитель считает с момента печати, а не с Enter: без хуков (или без
      // самого Enter, если его отменил ввод человека) хост иначе ждал бы хода
      // вечно — сигнала «письмо доставлено» без него не бывает вовсе.
      state.timeoutTimer = setTimeout(() => {
        state.timeoutTimer = undefined;
        // Попытка признана пропавшей — Enter, если ещё не ушёл, теперь не нужен:
        // ход всё равно не будет замечен.
        clearTimers(state);
        state.inFlight = false;
        abandonReturn(state);
        notice('pointer-timeout', ref, `session ${ref.sessionId} did not start a turn after the pointer`);
      }, pointerTimeoutMs);
    }

    void typing.done.then((outcome) => {
      // В журнал — любой исход, и у сменённой или отменённой попытки: по нему видно, сколько указатель пролежал.
      logDelivery(ref, action, 'pointer', startedAt, outcome);
      // Попытку уже сменили или отменили — её исход ничего не решает.
      if (state.typing !== typing) return;
      state.typing = undefined;
      if (outcome === 'input') {
        // Человек уже печатает своё — Enter чужого текста испортил бы его строку.
        // Текст указателя остаётся в поле ввода, письма — в `pointed`: повторно
        // не набираем, следующий подъём — только на новое письмо.
        clearTimers(state);
        state.inFlight = false;
        abandonReturn(state);
        notice('pointer-cancelled', ref, `the pointer for session ${ref.sessionId} was cancelled by human input`);
      } else if (outcome === 'blocked') {
        // Агент показал диалог за паузу перед Enter: отвечать на него нельзя (рамка 15.1).
        // Указатель остаётся в поле ввода, письма — в `pointed`, как при вводе человека.
        clearTimers(state);
        state.inFlight = false;
        abandonReturn(state);
        notice(
          'pointer-cancelled',
          ref,
          choiceNow(ref)
            ? `the pointer for session ${ref.sessionId} was left without Enter — a model or effort change is in progress`
            : `the pointer for session ${ref.sessionId} was left without Enter — the session is waiting for an answer`,
        );
      }
    }, (error: unknown) => {
      // Enter указателя не записался (PTY умер в окне ожидания). Сессию дальше ведёт
      // предохранитель указателя и выход процесса — здесь только след в логе.
      if (state.typing === typing) state.typing = undefined;
      host.log.error('Enter указателя не записался', { ref, error: String(error) });
    });
  }

  /** Возврат не дошёл до хода (указатель пропал, человек начал печатать, диалог): хода «по нашей просьбе» ждать нечего. */
  function abandonReturn(state: AttemptState): void {
    if (state.returnTurn === 'pending') state.returnTurn = null;
  }

  /** Эпизод лимита кончился или сессии больше нет: таймер возврата снимается, ничего не печатается. */
  function dropLimit(state: AttemptState): void {
    if (state.limit === undefined) return;
    clearTimeout(state.limit.timer);
    state.limit = undefined;
  }

  /**
   * Взводит таймер эпизода на `due`. Срок уже прошёл — таймера нет, эпизод сразу `reached`. Ждём ступенями
   * `LIMIT_TIMER_STEP_MS`: на каждой срок сверяется с часами, а не с отсчётом таймера, который во сне стоит.
   */
  function armLimit(ref: SessionRef, episode: LimitEpisode, requested: number): void {
    clearTimeout(episode.timer);
    episode.timer = undefined;
    // Непонятное время в `need` (NaN) срока не даёт: ждём повторный срок от сейчас, а не печатаем сразу.
    const due = Number.isNaN(requested) ? Date.now() + limitRetryMs : requested;
    episode.due = due;
    const delay = due - Date.now();
    if (delay <= 0) {
      episode.reached = true;
      return;
    }
    episode.reached = false;
    episode.timer = setTimeout(() => {
      episode.timer = undefined;
      // Ступень кончилась раньше срока (или таймер Node сработал на миллисекунду раньше часов): ждём остаток.
      if (episode.due > Date.now()) {
        armLimit(ref, episode, episode.due);
        return;
      }
      episode.reached = true;
      recompute(ref);
    }, Math.min(delay, LIMIT_TIMER_STEP_MS));
    // Хост живёт клиентами и сессиями, а не этим таймером (срок бывает в днях): он не должен удерживать процесс.
    episode.timer.unref?.();
  }

  /**
   * Возврат после сброса лимита (спека застрявших 6.3). Эпизод берётся из `need` активности сессии: пока он `limit` и
   * процесс жив, на срок (`limitReturnDue`) взведён один таймер. Claude Code с собственным ожиданием продолжит сам —
   * начало хода снимет `need`, и к сроку печатать будет нечего; остальных (Codex, GLM, Claude без ожидания) Parley
   * возвращает печатью. Зовётся на каждом пересчёте сессии: ведёт эпизод, счётчик возвратов и, когда срок наступил,
   * пробует вернуть сессию.
   */
  function trackLimit(
    ref: SessionRef,
    state: AttemptState,
    entry: WorkEntry,
    session: WorkSession,
    handle: PtyHandle | undefined,
  ): void {
    if (handle === undefined) {
      // Процесс вышел: эпизод кончился без «back», спящую Parley сам не поднимает (6.3).
      state.returnTurn = null;
      dropLimit(state);
      return;
    }
    const act: SessionActivity | undefined = activity.get(ref)?.activity;

    // Счётчик возвратов (6.3): ход начался не от будильника — это промпт человека; ход по возврату кончился без
    // ошибки лимита — сессия вернулась по-настоящему. Кончился ошибкой (`need` не пуст) — счёт остаётся.
    if (act !== undefined) {
      if (act.activity === 'working' && !act.heldByBackground) {
        if (state.returnTurn === 'pending') state.returnTurn = 'running';
        else if (state.returnTurn === null) state.returns = 0;
      } else if ((act.activity === 'idle' || act.activity === 'unseen') && state.returnTurn === 'running') {
        state.returnTurn = null;
        if (act.need === null) state.returns = 0;
      }
    }

    const need = session.lifecycle === 'active' ? (act?.need ?? null) : null;
    if (need === null || need.kind !== 'limit') {
      dropLimit(state);
      return;
    }
    let episode = state.limit;
    // Исход принят (возврат напечатан или отказан), а `need` с более поздним `since`: ход и ошибка уложились в одну
    // склейку активности, `need` не был пуст ни разу — лимит новый, а не тот же.
    if (episode?.settledAt != null && Date.parse(need.since) > episode.settledAt) {
      dropLimit(state);
      // Возврат был напечатан, а хода не видели: указатель не «в полёте», и предохранитель, ждавший его начала, не нужен.
      if (state.returnTurn === 'pending') {
        state.returnTurn = null;
        clearTimers(state);
        state.inFlight = false;
      }
      episode = undefined;
    }
    if (episode === undefined) {
      episode = {
        resetsAt: need.resetsAt,
        due: 0,
        timer: undefined,
        reached: false,
        settledAt: null,
        freeAt: null,
      };
      state.limit = episode;
      armLimit(ref, episode, limitReturnDue(need, limitGraceMs, limitRetryMs));
    } else if (episode.settledAt === null && need.resetsAt !== null && need.resetsAt !== episode.resetsAt) {
      // Время сброса появилось или уточнилось (квота GLM, данные провайдера): срок идёт от него.
      episode.resetsAt = need.resetsAt;
      armLimit(ref, episode, limitReturnDue(need, limitGraceMs, limitRetryMs));
    }
    // Срок по часам прошёл, а таймер ещё не сработал (Mac спал, цикл событий стоял): не ждём его ступени.
    if (!episode.reached && Date.now() >= episode.due) {
      clearTimeout(episode.timer);
      episode.timer = undefined;
      episode.reached = true;
    }
    // Время сброса неизвестно, а окно провайдера снова свободно: срок встаёт на это время плюс тот же запас, что после
    // известного сброса, — Claude мог продолжить сам, и «сразу» значит «не через 15 минут» (6.3). Один раз за эпизод.
    if (
      !episode.reached &&
      episode.settledAt === null &&
      episode.freeAt === null &&
      options.limits !== undefined &&
      limitWindowFree(need, options.limits.get(session.provider))
    ) {
      episode.freeAt = Date.now();
      if (episode.freeAt + limitGraceMs < episode.due) armLimit(ref, episode, episode.freeAt + limitGraceMs);
    }
    if (episode.reached && episode.settledAt === null) tryLimitReturn(ref, state, entry, session, handle, episode, act);
  }

  /**
   * Срок возврата наступил. Не вовремя — ждём, повтор на следующем пересчёте (конец хода, `resume()`): сессия не у
   * приглашения, будильник на паузе, свой указатель ещё в полёте. Помешали черновик, меню лимита или два возврата подряд —
   * печатать нельзя, человек получает `limit-return-blocked` с причиной, эпизод остаётся (6.3, 6.4). Иначе — тот же путь,
   * что у указателя: печать и Enter.
   */
  function tryLimitReturn(
    ref: SessionRef,
    state: AttemptState,
    entry: WorkEntry,
    session: WorkSession,
    handle: PtyHandle,
    episode: LimitEpisode,
    act: SessionActivity | undefined,
  ): void {
    if (isPaused || state.typing !== undefined || state.inFlight) return;
    if (act?.activity !== 'unseen' && act?.activity !== 'idle') return;

    const block = returnBlock({ hasDraft: handle.hasDraft(), screen: pty.screenText(ref), returns: state.returns });
    if (block !== null) {
      episode.settledAt = Date.now();
      notice(
        'limit-return-blocked',
        ref,
        `The limit has reset, but ${sessionTag(ref.sessionId)} could not continue: ${returnBlockReason(block)}`,
      );
      return;
    }
    const codex = handle.provider === 'codex';
    // Как у указателя: Codex только вставкой, а режима вставки на экране может ещё не быть; смена модели или effort идёт.
    if (codex && !handle.bracketedPaste()) {
      retryLater(ref, state, 'paste');
      return;
    }
    if (choiceNow(ref)) {
      retryLater(ref, state, 'choice');
      return;
    }
    state.pasteRetries = 0;
    state.choiceRetries = 0;

    const letters = unreadOf(entry, session.id).filter((message) => message.deleted !== true);
    const letterIds = letters.map((message) => message.id);
    beginAttempt(
      ref,
      state,
      { text: limitReturnText(letters, entry.map.rooms), letterIds, ...traceOf(letters, letterIds) },
      codex,
    );
    episode.settledAt = Date.now();
    state.returns += 1;
    state.returnTurn = 'pending';
    host.log.info('будильник: возврат после сброса лимита', { ref, returns: state.returns, letters: letterIds.length });
  }

  // Реестр провайдеров на короткий срок: пересчёт каждой спящей сессии с письмами иначе читал бы три файла каждый раз.
  let registryCache: { at: number; value: Promise<Record<string, unknown>> } | undefined;
  const registryNow = (): Promise<Record<string, unknown>> => {
    if (registryCache === undefined || Date.now() - registryCache.at > REGISTRY_TTL_MS) {
      registryCache = { at: Date.now(), value: loadProviders() };
    }
    return registryCache.value;
  };

  /**
   * Спрашивает реестр о провайдере сессии; ответ изменился — пересчёт. Реестр не прочитался (битый `providers.json`) —
   * провайдер считается на месте, как до проверки: подъём сам отчитается сбоем, а хост не падает.
   */
  async function checkProvider(ref: SessionRef, state: AttemptState, provider: string): Promise<void> {
    let present = true;
    try {
      present = provider in (await registryNow());
    } catch (error) {
      host.log.warn('будильник: реестр провайдеров не прочитался', { ref, error: String(error) });
    }
    const before = state.providerCheck;
    state.providerCheck = { provider, present };
    if (before?.provider !== provider || before.present !== present) recompute(ref);
  }

  function recompute(ref: SessionRef): void {
    if (!started) return;
    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;
    options.windowCounters?.recompute();
    ensureKnown(entry);

    const state = stateFor(refKey(ref));
    // Идёт замена агента (спека замены агента, 6.3): ни подъёма, ни указателя, ни возврата после лимита — письма ждут
    // нового агента, а путь resume будильника мимо замка замены прошёл бы. Снимает `switched` по концу замены.
    if (session.switching !== null && session.switching !== undefined) {
      publishWaiting(ref, state, hasUnread(entry, session.id) ? 'resuming' : null);
      return;
    }
    const handle = pty.get(ref);
    trackLimit(ref, state, entry, session, handle);

    if (handle === undefined) {
      const letters = hasUnread(entry, session.id);
      // Без нашего PTY письмо поднимает только спящую: живая без него —
      // сессия, поднятая не хостом (CLI), со своим каналом звонка, `pending`
      // поднимает autoLaunch, закрытая не поднимается ничем (спека 7.2). Спящую архивной работы
      // письмо ждёт до Reopen: архив освобождает процессы агентов.
      const archived = entry.map.work.status === 'archived';
      if (session.lifecycle !== 'sleeping' || archived || state.resuming || state.resumeUnavailable) {
        const reason: MailWait | null = !letters
          ? null
          : session.lifecycle === 'pending'
            ? 'pending'
            : session.lifecycle !== 'sleeping'
              ? null
              : state.resuming
                ? 'resuming'
                : 'sleeping';
        publishWaiting(ref, state, reason);
        return;
      }
      // Провайдера нет в реестре: сессия ждёт человека. До лимита часа — слот под подъём, которого не будет, не берём.
      if (letters) {
        void checkProvider(ref, state, session.provider).catch((error: unknown) => {
          host.log.warn('будильник: проверка провайдера упала', { ref, error: String(error) });
        });
        const known = state.providerCheck?.provider === session.provider ? state.providerCheck.present : null;
        if (known === null) {
          // Ответа реестра ещё нет: подъём ждёт его, пересчёт придёт следом. Ожидание не публикуется — иначе окно мигнуло
          // бы промежуточным «sleeping» перед настоящим состоянием.
          return;
        }
        if (!known) {
          publishWaiting(ref, state, 'provider-missing');
          return;
        }
      }
      const input: DeliveryInput = {
        session,
        activity: null,
        hasDraft: false,
        paused: isPaused,
        unread: unreadOf(entry, session.id),
        rooms: entry.map.rooms,
        pointed: state.pointed,
        inFlight: false,
        resumeAllowed: true,
        // Процесса нет: подъём заводит новый, хуки старого тут ни при чём.
        hooked: false,
        now: Date.now(),
        ...settle,
      };
      // Подъём стоит в очереди классом `mail`, а теперь его будит и письмо человека (спека сна агентов 4.2): класс выше,
      // и ждать `retry` значило бы отдать это письмо в хвост очереди писем. Очередь снимается — новая попытка идёт сразу,
      // классом `human`, и запись очереди поднимет класс (`mergeQueued`). Подъём, уже стоящий как `human`, ждёт, как был.
      // Удалённые письма не в счёт, как и у `deliveryAction`: иначе такая попытка шла бы по кругу на каждое событие карты.
      if (state.queued === 'mail' && input.unread.some((message) => message.from === HUMAN && message.deleted !== true)) {
        state.queued = null;
      }
      // Лимит берём только под настоящий подъём: каждый пересчёт без писем
      // иначе съедал бы его впустую.
      let action = deliveryAction(input);
      const backedOff =
        state.trustHeld ||
        state.queued !== null ||
        (state.budgetDeniedAt !== null && Date.now() - state.budgetDeniedAt < BUDGET_RETRY_MS);
      // Подъём хотели, но его не пускает удержание согласия (письма ждут человека) или очередь машины (письма ждут
      // слота): это не часовой лимит.
      const heldWait: MailWait | null =
        action.kind !== 'resume' ? null : state.trustHeld ? 'folder-trust' : state.queued !== null ? 'queued' : null;
      if (action.kind === 'resume') {
        // Подъём усыплённой хостом вызван решением хоста, а лимит часа защищает от агентов, будящих друг друга: слот под
        // него не берётся (спека сна агентов 4.1). Остановленную человеком считают по-старому.
        const hostSlept = session.autoSleep != null;
        state.slotTaken = !backedOff && !hostSlept && limiter.tryTake(ref);
        if (backedOff || !(hostSlept || state.slotTaken)) action = deliveryAction({ ...input, resumeAllowed: false });
      }
      if (action.kind === 'resume') {
        const { letterIds } = action;
        // Класс подъёма для очереди машины (спека сна агентов 4.2): среди будящих писем есть письмо человека — `human`.
        const launchClass = input.unread.some((message) => message.from === HUMAN && letterIds.includes(message.id))
          ? 'human'
          : 'mail';
        void resumeSession(ref, session, state, { ...action, ...traceOf(input.unread, letterIds), launchClass });
      } else if (action.kind === 'none' && action.reason === 'resume-limit' && heldWait === null) limitNotice(ref);
      else if (action.kind === 'none' && action.reason === 'settling') settleLater(ref, state, action.retryInMs);
      publishWaiting(
        ref,
        state,
        !letters
          ? null
          : action.kind === 'resume'
            ? 'resuming'
            : heldWait !== null
              ? heldWait
              : action.kind === 'none' && action.reason === 'resume-limit'
                ? 'resume-limit'
                : action.kind === 'none' && action.reason === 'paused'
                  ? 'paused'
                  : action.kind === 'none' && action.reason === 'settling'
                    ? 'settling'
                    : 'sleeping',
      );
      return;
    }

    // Процесс поднят — человеком или нами: следующий сон снова можно будить письмом.
    state.resumeUnavailable = false;
    state.trustHeld = false;
    state.queued = null;
    const live = activity.get(ref);
    if (state.pointerAfter !== null) {
      const endedAt = live?.activity.turnEndedAt ?? null;
      if (endedAt === null || Date.parse(endedAt) < state.pointerAfter) {
        publishWaiting(ref, state, hasUnread(entry, session.id) ? 'resuming' : null);
        return;
      }
      state.pointerAfter = null;
    }

    // Codex занятому агенту письмо ставит в очередь (Tab): указатель не ждёт конца хода.
    const codex = handle.provider === 'codex';
    const action = deliveryAction({
      session,
      activity: live?.activity ?? null,
      hasDraft: handle.hasDraft(),
      paused: isPaused,
      unread: unreadOf(entry, session.id),
      rooms: entry.map.rooms,
      pointed: state.pointed,
      inFlight: state.inFlight,
      resumeAllowed: false,
      hooked: hookedSince(live?.activity, handle.startedAt),
      queueWhileBusy: codex,
      now: Date.now(),
      ...settle,
    });

    if (action.kind !== 'type-pointer') {
      if (action.kind === 'none' && action.reason === 'settling') settleLater(ref, state, action.retryInMs);
      // Пауза будильника проверяется раньше писем: без непрочитанных причины нет и на паузе.
      const letters = hasUnread(entry, session.id);
      publishWaiting(ref, state, letters ? waitingOf(action, state) : null);
      return;
    }
    if (codex) {
      // Codex — только вставкой, как в `pty.send`: без режима вставки на экране TUI ещё не поднялся (или его
      // сменил), и маркеры ушли бы в поле ввода знаками. Отказа, как у `pty.send`, тут вернуть некому — пересчёт
      // повторяется сам.
      if (!handle.bracketedPaste()) {
        retryLater(ref, state, 'paste');
        publishWaiting(ref, state, 'busy');
        return;
      }
      state.pasteRetries = 0;
    }
    // Идёт смена модели или effort, либо открыт ползунок: ни текста, ни Enter. Пересчёт повторится сам.
    if (choiceNow(ref)) {
      retryLater(ref, state, 'choice');
      publishWaiting(ref, state, 'busy');
      return;
    }
    state.choiceRetries = 0;
    beginAttempt(ref, state, { ...action, ...traceOf(unreadOf(entry, session.id), action.letterIds) }, codex);
    // Указатель в очереди занятого Codex хода не начинает — он «сообщён», а не «в полёте».
    publishWaiting(ref, state, action.queue === true ? 'pointed' : 'in-flight');
  }

  /** Причина ожидания по отказу `deliveryAction` у сессии с живым процессом; `null` — писем нет. */
  function waitingOf(action: Extract<DeliveryAction, { kind: 'none' | 'resume' }>, state: AttemptState): MailWait | null {
    if (action.kind === 'resume') return 'resuming';
    switch (action.reason) {
      case 'no-letters':
      case 'closed':
        return null;
      case 'paused':
        return 'paused';
      // Указатель напечатан: ход по нему ещё не начался — или уже идёт, а письма агент пока не прочёл.
      case 'already-pointed':
        return state.inFlight ? 'in-flight' : 'pointed';
      case 'not-live':
        return 'pending';
      case 'resume-limit':
        return 'resume-limit';
      case 'settling':
        return 'settling';
      case 'stuck':
      case 'no-hooks':
      case 'busy':
      case 'draft':
      case 'in-flight':
        return action.reason;
    }
  }

  // Работы, в которых письмо новому ведущему уже пишется: два события подряд не ставят второе письмо.
  const recipeDelivering = new Set<string>();

  /**
   * Смена ведущего у комнаты с рецептом: письмо с плейбуком пишется в карту, а подъём и указатель
   * делает этот же будильник по следующему изменению карты (спека рецептов, 6.4).
   */
  function deliverRecipes(): void {
    for (const entry of works.snapshot().entries) {
      const key = workKeyOf(entry.projectPath, entry.map.work.id);
      if (recipeDelivering.has(key)) continue;
      recipeDelivering.add(key);
      void deliverRecipeToNewLeads(entry.projectPath, entry.map)
        .catch((error: unknown) => {
          host.log.error('плейбук рецепта новому ведущему не записался', { key, error: String(error) });
        })
        .finally(() => recipeDelivering.delete(key));
    }
  }

  /** Сессии уведомлений `onMail`, ждущие пересчёта в конце хода (`flushMail`); ключ — `refKey`. */
  const mailDirty = new Map<string, SessionRef>();
  let mailFlushQueued = false;

  /** Все сессии всех работ: живые получают указатель, спящие — подъём. */
  function recomputeAll(): void {
    for (const entry of works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        recompute({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      }
    }
  }

  /**
   * Запись писем (спека rooms.mail 6.7): без записи карты `onChange` молчит, и письмо будит только свои адресатов, а отметка
   * прочтения снимает «письма ждут» только у читателя. Смешанная запись зовёт и это, и `onChange`: пересчёт идемпотентен.
   * Карта — из снимка работ: адресаты комнаты берутся по ней, и комната, заведённая записью, ещё не попавшей в снимок, до
   * её `onChange` адресатов не имеет.
   */
  function recomputeAddressees(notice: MailNotice): void {
    const entry = works.entry(notice.projectPath, notice.workId);
    if (entry === undefined) return;
    for (const sessionId of mailSessions(notice, entry.map)) {
      const ref: SessionRef = { projectPath: notice.projectPath, workId: notice.workId, sessionId };
      mailDirty.set(refKey(ref), ref);
    }
    if (mailDirty.size === 0 || mailFlushQueued) return;
    mailFlushQueued = true;
    queueMicrotask(flushMail);
  }

  /**
   * Каждая запись письма зовёт `onMail` отдельно, и пересчёт на каждое уведомление давал на пачку из 60 писем в комнату из
   * трёх 120 пересчётов вместо трёх у `onChange` мастера с его debounce. Сессии уведомлений собираются в `mailDirty`, и в
   * конце текущего синхронного хода (микрозадача, не таймер: пересчёт письма не ждёт окна, а письма одной пачки, записанные
   * подряд без `await`, делят один проход) каждая пересчитывается один раз. Адресаты берутся по карте на момент уведомления,
   * сам пересчёт видит уже свежее состояние. Упавший пересчёт — предупреждение, а не необработанное исключение микрозадачи:
   * подписчика `onMail` защищает `try` службы работ, а здесь его уже нет.
   */
  function flushMail(): void {
    mailFlushQueued = false;
    const refs = [...mailDirty.values()];
    mailDirty.clear();
    for (const ref of refs) {
      try {
        recompute(ref);
      } catch (error) {
        host.log.warn('будильник: пересчёт после письма упал', { ref, error: String(error) });
      }
    }
  }

  return {
    enterDelayMs,

    inFlight: (ref) => attempts.get(refKey(ref))?.typing !== undefined,

    retry(ref) {
      const state = stateFor(refKey(ref));
      state.trustHeld = false;
      state.queued = null;
      state.budgetDeniedAt = null;
      // Спящая сессия без процесса: каждое её непрочитанное письмо снова свежее — именно это и делает будильник при
      // подъёме. Без этого после перезапуска хоста старт (`ensureKnown`) уже записал бы такие письма как указанные, и
      // согласие ничего бы не подняло. У живого процесса `pointed` не трогаем: повторный указатель задвоил бы доставку.
      if (pty.get(ref) === undefined) state.pointed.clear();
      recompute(ref);
    },

    switched(ref) {
      const state = stateFor(refKey(ref));
      clearTimers(state);
      dropLimit(state);
      state.inFlight = false;
      state.pointed.clear();
      state.pointerAfter = null;
      state.resumedAt = null;
      state.resumeLetters = [];
      state.earlyExit = undefined;
      state.resumeUnavailable = false;
      state.trustHeld = false;
      state.queued = null;
      state.budgetDeniedAt = null;
      state.returns = 0;
      state.returnTurn = null;
      recompute(ref);
    },

    start() {
      if (started) return;
      started = true;

      void loadConfig()
        .then(({ config }) => {
          resumeRate = config.resumeRate;
        })
        .catch(() => {});

      for (const entry of works.snapshot().entries) ensureKnown(entry);
      unsubscribeWorks = works.onChange(() => {
        deliverRecipes();
        recomputeAll();
      });
      unsubscribeMail = works.onMail(recomputeAddressees);
      unsubscribeActivity = activity.onChange((ref, value) => {
        const state = attempts.get(refKey(ref));
        // Ход начался (`UserPromptSubmit`) — попытка удалась, предохранитель не нужен. Сессия, которую
        // держат одни фоновые субагенты, `working` и до указателя: любой её пересчёт — не начало хода,
        // и Enter указателя он отменять не вправе. Пока свой Enter ещё не ушёл (`typing`), `working` —
        // тоже не ход по указателю: записи журнала Claude Code сразу после Stop возвращают сессию в
        // `working` на порог тишины, и отмена оставляла бы указатель в поле ввода без Enter, а письма —
        // «указанными» навсегда (живая проверка 2026-10-02: сессия не отвечала в комнате).
        if (
          state?.inFlight === true &&
          state.typing === undefined &&
          value.activity.activity === 'working' &&
          !value.activity.heldByBackground
        ) {
          clearTimers(state);
          state.inFlight = false;
        }
        recompute(ref);
      });
      // Ввод человека в окне ожидания Enter ловит сама печать (`typeAndSubmit`).
      unsubscribeDraft = pty.on('draft', (ref) => recompute(ref));
      // Черновик хоста снят (свой Enter pty.send) — письмо, пришедшее за ожидание, уходит
      // сразу, а не ждёт следующего события сессии: у агента без хуков оно не пришло бы.
      unsubscribeHostDraft = pty.on('host-draft', (ref) => recompute(ref));
      unsubscribeExit = pty.on('exit', (ref, exit) => {
        const state = stateFor(refKey(ref));
        clearTimers(state);
        dropLimit(state);
        state.returnTurn = null;
        state.inFlight = false;
        state.pointerAfter = null;
        // Уснувшую будят новые письма, а не те, что лежали при выходе: иначе
        // «Остановить» при непрочитанном тут же поднимало бы сессию обратно, а
        // провалившийся подъём без промпта повторялся бы до конца лимита. Кроме усыплённой хостом (спека сна агентов 4.1):
        // письма, что пришли, пока их держала ограда, агент не прочёл, и они ждут подъёма, а не «лежали». Указанными
        // их не считаем, а указатели, ушедшие в умирающий процесс, забываем: письма поднимут сессию обычным путём.
        if (hostSleeps(ref)) state.pointed.clear();
        else markUnreadPointed(ref, state);

        const resumedAt = state.resumedAt;
        state.resumedAt = null;
        if (resumedAt !== null && Date.now() - resumedAt <= resumeFailWindowMs) {
          const check = (): Promise<void> =>
            checkEarlyExit(ref, state, exit.exitCode, state.journalBase, state.resumeLetters);
          if (state.resuming) state.earlyExit = check;
          else void check();
        }
      });

      recomputeAll();
    },

    paused: () => isPaused,

    pause() {
      if (isPaused) return;
      isPaused = true;
      host.broadcast('wake.changed', { paused: isPaused });
    },

    resume() {
      if (!isPaused) return;
      isPaused = false;
      host.broadcast('wake.changed', { paused: isPaused });
      recomputeAll();
    },

    stop() {
      if (!started) return;
      started = false;
      unsubscribeWorks?.();
      unsubscribeMail?.();
      unsubscribeActivity?.();
      unsubscribeDraft?.();
      unsubscribeHostDraft?.();
      unsubscribeExit?.();
      mailDirty.clear();
      for (const state of attempts.values()) {
        clearTimers(state);
        dropLimit(state);
      }
      attempts.clear();
    },
  };
}
