/**
 * Будильник живых сессий без канала (план, кусок 1.8): когда простаивающего
 * агента ждёт непрочитанное письмо, хост сам печатает в его терминал текст
 * указателя и, если человек за это время не начал печатать своё, нажимает
 * Enter. Этап 1 умеет только живые сессии — комнаты и подъём по конкретному
 * письму придут в этапе 3 (§7.3).
 *
 * Правило «печатать или нет» — чистая `deliveryAction` из core; сервис здесь
 * решает, КОГДА её позвать (по событиям `works`/`activity`/`draft` и по
 * `resume`, без опроса), и держит между вызовами состояние попытки: какие
 * письма уже указаны и не в полёте ли уже указатель.
 */

import { deliveryAction } from '@harnas/core';
import type { Message, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { SessionRef } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';

export interface WakeServiceOptions {
  /** Пауза перед Enter — если человек уже не печатает, указатель уходит как ход (спека 7.3). */
  enterDelayMs?: number;
  /** Ход не начался за это время после указателя — предупреждение, повторного набора нет. */
  pointerTimeoutMs?: number;
}

export interface WakeService {
  start(): void;
  paused(): boolean;
  pause(): void;
  resume(): void;
  stop(): void;
}

const DEFAULT_ENTER_DELAY_MS = 500;
const DEFAULT_POINTER_TIMEOUT_MS = 10_000;

/** Состояние одной попытки доставки указателя, живёт между пересчётами сессии. */
interface AttemptState {
  /** Id писем, на которые указатель уже печатали, — второй раз не набираем. */
  pointed: Set<string>;
  /** Указатель напечатан, ход по нему ещё не начался и не признан пропавшим. */
  inFlight: boolean;
  /** Человек тронул клавиши в окне между текстом и Enter — событие `draft`. */
  sawInput: boolean;
  enterTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
}

const unreadOf = (session: WorkSession, messages: readonly Message[]): Message[] =>
  messages.filter((message) => message.to === session.id && message.readAt === null);

export function createWakeService(
  host: HostContext,
  works: WorksService,
  activity: ActivityService,
  pty: PtyManager,
  options: WakeServiceOptions = {},
): WakeService {
  const enterDelayMs = options.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;
  const pointerTimeoutMs = options.pointerTimeoutMs ?? DEFAULT_POINTER_TIMEOUT_MS;

  const attempts = new Map<string, AttemptState>();
  let isPaused = false;
  let started = false;
  let unsubscribeWorks: (() => void) | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  let unsubscribeDraft: (() => void) | undefined;
  let unsubscribeExit: (() => void) | undefined;

  function stateFor(key: string): AttemptState {
    let state = attempts.get(key);
    if (state === undefined) {
      state = {
        pointed: new Set(),
        inFlight: false,
        sawInput: false,
        enterTimer: undefined,
        timeoutTimer: undefined,
      };
      attempts.set(key, state);
    }
    return state;
  }

  function clearTimers(state: AttemptState): void {
    if (state.enterTimer !== undefined) {
      clearTimeout(state.enterTimer);
      state.enterTimer = undefined;
    }
    if (state.timeoutTimer !== undefined) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = undefined;
    }
  }

  function notice(kind: 'pointer-cancelled' | 'pointer-timeout', ref: SessionRef, text: string): void {
    host.broadcast('host.notice', { kind, ref, text, at: new Date().toISOString() });
  }

  /** Печатает текст указателя и заводит оба таймера попытки: Enter и предохранитель. */
  function beginAttempt(
    ref: SessionRef,
    state: AttemptState,
    pid: number,
    action: { text: string; letterIds: string[] },
  ): void {
    pty.write(ref, action.text);
    for (const id of action.letterIds) state.pointed.add(id);
    state.inFlight = true;
    state.sawInput = false;

    // Предохранитель считает с момента печати, а не с Enter: без хуков (или без
    // самого Enter, если его отменил ввод человека) хост иначе ждал бы хода
    // вечно — сигнала «письмо доставлено» без него не бывает вовсе.
    state.timeoutTimer = setTimeout(() => {
      state.timeoutTimer = undefined;
      // Попытка признана пропавшей — Enter, если ещё не ушёл, теперь не нужен:
      // ход всё равно не будет замечен.
      if (state.enterTimer !== undefined) {
        clearTimeout(state.enterTimer);
        state.enterTimer = undefined;
      }
      state.inFlight = false;
      notice('pointer-timeout', ref, `сессия ${ref.sessionId} не начала ход после указателя`);
    }, pointerTimeoutMs);

    state.enterTimer = setTimeout(() => {
      state.enterTimer = undefined;
      if (state.sawInput) {
        // Человек уже печатает своё — Enter чужого текста испортил бы его строку.
        // Текст указателя остаётся в поле ввода, письма — в `pointed`: повторно
        // не набираем, следующий подъём — только на новое письмо.
        clearTimers(state);
        state.inFlight = false;
        notice('pointer-cancelled', ref, `указатель сессии ${ref.sessionId} отменён вводом человека`);
        return;
      }
      // Enter — тому же процессу, которому печатали текст: за время задержки
      // сессию могли перезапустить, и посторонний Enter в чужой процесс не идёт.
      if (pty.get(ref)?.pid === pid) pty.write(ref, '\r');
    }, enterDelayMs);
  }

  function recompute(ref: SessionRef): void {
    if (!started) return;
    const handle = pty.get(ref);
    // Не наш PTY — сессия, поднятая TUI, живёт своим каналом звонка (спека 7.2).
    if (handle === undefined) return;

    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;

    const state = stateFor(refKey(ref));
    const live = activity.get(ref);

    const action = deliveryAction({
      session,
      activity: live?.activity ?? null,
      hasDraft: handle.hasDraft(),
      paused: isPaused,
      unread: unreadOf(session, entry.map.messages),
      pointed: state.pointed,
      inFlight: state.inFlight,
    });

    if (action.kind === 'type-pointer') beginAttempt(ref, state, handle.pid, action);
  }

  function recomputeAllLive(): void {
    for (const handle of pty.list()) recompute(handle.ref);
  }

  return {
    start() {
      if (started) return;
      started = true;

      unsubscribeWorks = works.onChange(() => recomputeAllLive());
      unsubscribeActivity = activity.onChange((ref, value) => {
        const state = attempts.get(refKey(ref));
        // Ход начался (`UserPromptSubmit`) — попытка удалась, предохранитель не нужен.
        if (state?.inFlight === true && value.activity.activity === 'working') {
          clearTimers(state);
          state.inFlight = false;
        }
        recompute(ref);
      });
      unsubscribeDraft = pty.on('draft', (ref) => {
        const state = attempts.get(refKey(ref));
        // Любое изменение флага черновика в окне ожидания Enter — это ввод
        // человека, даже если черновик сам потом снова опустел.
        if (state?.enterTimer !== undefined) state.sawInput = true;
        recompute(ref);
      });
      unsubscribeExit = pty.on('exit', (ref) => {
        const key = refKey(ref);
        const state = attempts.get(key);
        if (state !== undefined) clearTimers(state);
        attempts.delete(key);
      });

      recomputeAllLive();
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
      recomputeAllLive();
    },

    stop() {
      if (!started) return;
      started = false;
      unsubscribeWorks?.();
      unsubscribeActivity?.();
      unsubscribeDraft?.();
      unsubscribeExit?.();
      for (const state of attempts.values()) clearTimers(state);
      attempts.clear();
    },
  };
}
