/**
 * Будильник сессий без канала (план, куски 1.8 и 3.4): когда простаивающего
 * агента ждёт непрочитанное письмо, хост сам печатает в его терминал текст
 * указателя и, если человек за это время не начал печатать своё, нажимает
 * Enter. Спящую сессию письмо поднимает: `resume` с указателем первым ходом,
 * не чаще `resumeRate` в час (спека 7.2, 7.4).
 *
 * Правило «печатать, поднимать или нет» — чистая `deliveryAction` из core;
 * сервис здесь решает, КОГДА её позвать (по событиям `works`/`activity`/`draft`
 * и по `resume`, без опроса), и держит между вызовами состояние попытки: какие
 * письма уже указаны и не в полёте ли уже указатель.
 */

import {
  addMessage,
  DEFAULT_CONFIG,
  deliveryAction,
  hookedSince,
  HUMAN,
  loadConfig,
  loadProviders,
  openEvents,
  sessionTag,
  SYSTEM,
  unreadFor,
  updateMap,
  workPaths,
  type DeliveryInput,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { NoticeKind, SessionRef } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { CODEX_SUBMIT_DELAY_MS, codexPaste, codexSubmitKey } from '../pty/codex-input.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import type { Attempt } from '../pty/type-and-submit.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WorksService } from '../works/works-service.js';
import { ResumeLimiter } from './resume-limiter.js';

export interface WakeServiceOptions {
  /** Пауза перед Enter — если человек уже не печатает, указатель уходит как ход (спека 7.3). */
  enterDelayMs?: number;
  /** Ход не начался за это время после указателя — предупреждение, повторного набора нет. */
  pointerTimeoutMs?: number;
  /** Лимит подъёмов; по умолчанию — `resumeRate` из настроек. Тесты подставляют свой. */
  limiter?: ResumeLimiter;
  /** Поднятая сессия вышла раньше этого срока без единого хука — подъём не удался (спека 10). */
  resumeFailWindowMs?: number;
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
}

const DEFAULT_ENTER_DELAY_MS = 500;
const DEFAULT_POINTER_TIMEOUT_MS = 10_000;
const DEFAULT_RESUME_FAIL_WINDOW_MS = 5_000;
/** Уведомление о лимите подъёмов — не чаще раза в час на сессию (план, кусок 3.4). */
const LIMIT_NOTICE_EVERY_MS = 60 * 60 * 1000;
/**
 * Codex получает указатель только вставкой, а режима вставки на экране хоста может ещё не быть: экран
 * разбирает поток чуть позже сигнала терминала, по которому будильник и проснулся. Пересчёт стоит
 * повторить: 15 раз через 200 мс, дальше — до следующего события сессии.
 */
const PASTE_MODE_RETRY_MS = 200;
const PASTE_MODE_RETRIES = 15;

/** Состояние одной попытки доставки указателя, живёт между пересчётами сессии. */
interface AttemptState {
  /** Id писем, на которые указатель уже печатали, — второй раз не набираем. */
  pointed: Set<string>;
  /** Указатель напечатан, ход по нему ещё не начался и не признан пропавшим. */
  inFlight: boolean;
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
   * Подняли без промпта (в `resumeArgs` нет `{prompt}`): указатель печатается
   * обычным путём, но только после конца хода нового процесса — до первого хука
   * старый журнал выдал бы простой ещё не запущенного агента (спека 7.3).
   */
  pointerAfter: number | null;
  /**
   * Поднять письмом нечем: у провайдера нет `resumeArgs` или id его сессии не
   * известен. Письма ждут, пока сессию поднимет человек (спека 7.5), — новый
   * процесс по брифу начал бы задачу заново.
   */
  resumeUnavailable: boolean;
  /** Повтор пересчёта, пока у Codex нет режима вставки (`PASTE_MODE_RETRIES`). */
  pasteRetry: NodeJS.Timeout | undefined;
  /** Сколько повторов уже было; с режимом вставки на экране счёт начинается заново. */
  pasteRetries: number;
}


const workKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

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
  sessions: Pick<SessionsService, 'launch'>,
  options: WakeServiceOptions = {},
): WakeService {
  const enterDelayMs = options.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;
  const pointerTimeoutMs = options.pointerTimeoutMs ?? DEFAULT_POINTER_TIMEOUT_MS;
  const resumeFailWindowMs = options.resumeFailWindowMs ?? DEFAULT_RESUME_FAIL_WINDOW_MS;

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
        typing: undefined,
        timeoutTimer: undefined,
        resuming: false,
        resumedAt: null,
        journalBase: 0,
        resumeLetters: [],
        pointerAfter: null,
        resumeUnavailable: false,
        pasteRetry: undefined,
        pasteRetries: 0,
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
  }

  /** У Codex ещё нет режима вставки: пересчёт через короткий срок, но не бесконечно. */
  function waitForPasteMode(ref: SessionRef, state: AttemptState): void {
    if (state.pasteRetry !== undefined || state.pasteRetries >= PASTE_MODE_RETRIES) return;
    state.pasteRetries += 1;
    state.pasteRetry = setTimeout(() => {
      state.pasteRetry = undefined;
      recompute(ref);
    }, PASTE_MODE_RETRY_MS);
  }

  function notice(kind: NoticeKind, ref: SessionRef, text: string): void {
    host.broadcast('host.notice', { kind, ref, text, at: new Date().toISOString() });
  }

  /** Письма, непрочитанные сейчас, считаются уже указанными: будить ими некого. */
  function markUnreadPointed(ref: SessionRef, state: AttemptState): void {
    const entry = works.entry(ref.projectPath, ref.workId);
    if (entry === undefined) return;
    for (const message of unreadFor(entry.map, ref.sessionId)) state.pointed.add(message.id);
  }

  /**
   * Первая встреча с работой: её непрочитанные у неживых считаются указанными.
   * Зовётся из самого пересчёта, а не только из подписки на работы: активность
   * узнаёт о новой работе раньше будильника и зовёт пересчёт первой.
   */
  function ensureKnown(entry: WorkEntry): void {
    const wk = workKeyOf(entry.projectPath, entry.map.work.id);
    if (knownWorks.has(wk)) return;
    knownWorks.add(wk);
    for (const session of entry.map.sessions) {
      const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
      if (pty.get(ref) === undefined) markUnreadPointed(ref, stateFor(refKey(ref)));
    }
  }

  /** Лимит подъёмов исчерпан — письма ждут, человеку уведомление раз в час. */
  function limitNotice(ref: SessionRef): void {
    const key = refKey(ref);
    const at = Date.now();
    const last = limitNoticedAt.get(key);
    if (last !== undefined && at - last < LIMIT_NOTICE_EVERY_MS) return;
    limitNoticedAt.set(key, at);
    notice(
      'resume-limit',
      ref,
      `${sessionTag(ref.sessionId)} не поднята: лимит подъёмов за час исчерпан, письма ждут`,
    );
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
    const text = `${sessionTag(ref.sessionId)} не поднялась: ${reason}`;
    const ids = new Set(letterIds);
    try {
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const senders = new Set(
          map.messages.filter((message) => ids.has(message.id)).map((message) => message.from),
        );
        // Человек узнаёт из уведомления, системе писать незачем, себе — тоже.
        senders.delete(HUMAN);
        senders.delete(SYSTEM);
        senders.delete(ref.sessionId);
        for (const sender of senders) {
          if (!map.sessions.some((session) => session.id === sender)) continue;
          addMessage(map, { from: SYSTEM, to: [sender], text });
        }
      });
    } catch (error) {
      host.log.error('письмо о сбое подъёма не записалось', { ref, error: String(error) });
    }
    notice('resume-failed', ref, text);
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
    action: { text: string; letterIds: string[] },
  ): Promise<void> {
    state.resuming = true;
    try {
      const registry = await loadProviders();
      const template = registry[session.provider]?.runner.resumeArgs;
      // Без id у провайдера core запустил бы новый процесс по брифу, а не `resume`.
      if (template === undefined || session.providerSessionId === null) {
        state.resumeUnavailable = true;
        return;
      }
      const withPrompt = template.includes('{prompt}');

      state.journalBase = await journalLength(ref);
      state.resumeLetters = [...action.letterIds];
      state.resumedAt = Date.now();
      if (withPrompt) for (const id of action.letterIds) state.pointed.add(id);
      else state.pointerAfter = state.resumedAt;

      await sessions.launch(ref, 'resume', withPrompt ? { prompt: action.text } : {});
    } catch (error) {
      state.resumedAt = null;
      state.pointerAfter = null;
      await resumeFailed(ref, state, action.letterIds, (error as Error).message);
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
    await resumeFailed(ref, state, letterIds, `процесс вышел с кодом ${exitCode}, не начав работу`);
  }

  /**
   * Печатает текст указателя и заводит оба таймера попытки: Enter и предохранитель. Codex — своим
   * порядком (спека комнат, 3.6): вставка в маркерах bracketed paste, пауза десятки миллисекунд, а
   * клавиша — Tab занятому агенту (очередь на следующий ход) и Enter у приглашения.
   */
  function beginAttempt(
    ref: SessionRef,
    state: AttemptState,
    action: { text: string; letterIds: string[]; queue?: true },
    codex = false,
  ): void {
    // Печать и Enter — общая механика с pty.send (кусок 5.1): Enter через паузу тому же
    // pid, отмена по вводу человека. Черновиком хоста свой указатель не помечается —
    // правила будильника (спека 7.3) прежние.
    // Перед Enter — снова `blocked`: запрос разрешения мог появиться за паузу (fix-final-b).
    const typing = typeAndSubmit(
      { pty, enterDelayMs },
      ref,
      codex ? codexPaste(action.text) : action.text,
      true,
      {
        beforeEnter: () => activity.get(ref)?.activity.activity !== 'blocked',
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
        notice('pointer-timeout', ref, `сессия ${ref.sessionId} не начала ход после указателя`);
      }, pointerTimeoutMs);
    }

    void typing.done.then((outcome) => {
      // Попытку уже сменили или отменили — её исход ничего не решает.
      if (state.typing !== typing) return;
      state.typing = undefined;
      if (outcome === 'input') {
        // Человек уже печатает своё — Enter чужого текста испортил бы его строку.
        // Текст указателя остаётся в поле ввода, письма — в `pointed`: повторно
        // не набираем, следующий подъём — только на новое письмо.
        clearTimers(state);
        state.inFlight = false;
        notice('pointer-cancelled', ref, `указатель сессии ${ref.sessionId} отменён вводом человека`);
      } else if (outcome === 'blocked') {
        // Агент показал диалог за паузу перед Enter: отвечать на него нельзя (рамка 15.1).
        // Указатель остаётся в поле ввода, письма — в `pointed`, как при вводе человека.
        clearTimers(state);
        state.inFlight = false;
        notice('pointer-cancelled', ref, `указатель сессии ${ref.sessionId} без Enter — сессия ждёт ответа`);
      }
    }, (error: unknown) => {
      // Enter указателя не записался (PTY умер в окне ожидания). Сессию дальше ведёт
      // предохранитель указателя и выход процесса — здесь только след в логе.
      if (state.typing === typing) state.typing = undefined;
      host.log.error('Enter указателя не записался', { ref, error: String(error) });
    });
  }

  function recompute(ref: SessionRef): void {
    if (!started) return;
    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;
    ensureKnown(entry);

    const state = stateFor(refKey(ref));
    const handle = pty.get(ref);

    if (handle === undefined) {
      // Без нашего PTY письмо поднимает только спящую: живая без него —
      // сессия, поднятая не хостом (CLI), со своим каналом звонка, `pending`
      // поднимает autoLaunch, закрытая не поднимается ничем (спека 7.2).
      if (session.lifecycle !== 'sleeping' || state.resuming || state.resumeUnavailable) return;
      const input: DeliveryInput = {
        session,
        activity: null,
        hasDraft: false,
        paused: isPaused,
        unread: unreadFor(entry.map, session.id),
        rooms: entry.map.rooms,
        pointed: state.pointed,
        inFlight: false,
        resumeAllowed: true,
        // Процесса нет: подъём заводит новый, хуки старого тут ни при чём.
        hooked: false,
      };
      // Лимит берём только под настоящий подъём: каждый пересчёт без писем
      // иначе съедал бы его впустую.
      let action = deliveryAction(input);
      if (action.kind === 'resume' && !limiter.tryTake(ref)) {
        action = deliveryAction({ ...input, resumeAllowed: false });
      }
      if (action.kind === 'resume') void resumeSession(ref, session, state, action);
      else if (action.kind === 'none' && action.reason === 'resume-limit') limitNotice(ref);
      return;
    }

    // Процесс поднят — человеком или нами: следующий сон снова можно будить письмом.
    state.resumeUnavailable = false;
    const live = activity.get(ref);
    if (state.pointerAfter !== null) {
      const endedAt = live?.activity.turnEndedAt ?? null;
      if (endedAt === null || Date.parse(endedAt) < state.pointerAfter) return;
      state.pointerAfter = null;
    }

    // Codex занятому агенту письмо ставит в очередь (Tab): указатель не ждёт конца хода.
    const codex = handle.provider === 'codex';
    const action = deliveryAction({
      session,
      activity: live?.activity ?? null,
      hasDraft: handle.hasDraft(),
      paused: isPaused,
      unread: unreadFor(entry.map, session.id),
      rooms: entry.map.rooms,
      pointed: state.pointed,
      inFlight: state.inFlight,
      resumeAllowed: false,
      hooked: hookedSince(live?.activity, handle.startedAt),
      queueWhileBusy: codex,
    });

    if (action.kind !== 'type-pointer') return;
    if (codex) {
      // Codex — только вставкой, как в `pty.send`: без режима вставки на экране TUI ещё не поднялся (или его
      // сменил), и маркеры ушли бы в поле ввода знаками. Отказа, как у `pty.send`, тут вернуть некому — пересчёт
      // повторяется сам.
      if (!handle.bracketedPaste()) {
        waitForPasteMode(ref, state);
        return;
      }
      state.pasteRetries = 0;
    }
    beginAttempt(ref, state, action, codex);
  }

  /** Все сессии всех работ: живые получают указатель, спящие — подъём. */
  function recomputeAll(): void {
    for (const entry of works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        recompute({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      }
    }
  }

  return {
    enterDelayMs,

    inFlight: (ref) => attempts.get(refKey(ref))?.typing !== undefined,

    start() {
      if (started) return;
      started = true;

      void loadConfig()
        .then(({ config }) => {
          resumeRate = config.resumeRate;
        })
        .catch(() => {});

      for (const entry of works.snapshot().entries) ensureKnown(entry);
      unsubscribeWorks = works.onChange(() => recomputeAll());
      unsubscribeActivity = activity.onChange((ref, value) => {
        const state = attempts.get(refKey(ref));
        // Ход начался (`UserPromptSubmit`) — попытка удалась, предохранитель не нужен.
        if (state?.inFlight === true && value.activity.activity === 'working') {
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
        state.inFlight = false;
        state.pointerAfter = null;
        // Уснувшую будят новые письма, а не те, что лежали при выходе: иначе
        // «Остановить» при непрочитанном тут же поднимало бы сессию обратно, а
        // провалившийся подъём без промпта повторялся бы до конца лимита.
        markUnreadPointed(ref, state);

        const resumedAt = state.resumedAt;
        state.resumedAt = null;
        if (resumedAt !== null && Date.now() - resumedAt <= resumeFailWindowMs) {
          void checkEarlyExit(ref, state, exit.exitCode, state.journalBase, state.resumeLetters);
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
      unsubscribeActivity?.();
      unsubscribeDraft?.();
      unsubscribeHostDraft?.();
      unsubscribeExit?.();
      for (const state of attempts.values()) clearTimers(state);
      attempts.clear();
    },
  };
}
