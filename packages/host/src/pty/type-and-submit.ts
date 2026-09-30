/**
 * Общая печать хоста «напечатать и нажать Enter» (спека 8.6, кусок 5.1): одна
 * проверенная механика для будильника и для `pty.send`. Раньше она жила внутри
 * `wake-service.ts#beginAttempt`; предохранитель указателя остался там — это логика
 * будильника, а не печати.
 */

import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { PtyManager } from './pty-manager.js';

export type AttemptOutcome = 'submitted' | 'input' | 'restarted' | 'cancelled' | 'typed' | 'blocked';

export interface Attempt {
  cancel(): void;
  done: Promise<AttemptOutcome>;
}

export interface TypeAndSubmitDeps {
  pty: PtyManager;
  enterDelayMs: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * Печатает text печатью хоста (черновик человека не меняется). При submit через
 * enterDelayMs жмёт Enter тому же pid, если за это время не было события draft;
 * был ввод — 'input', сменился pid — 'restarted'. Без submit — 'typed' сразу.
 * hostDraft (pty.send): печать ставит черновик хоста, свой Enter его снимает.
 * Будильник зовёт без него — его поведение прежнее. Сбой отложенной записи Enter
 * (PTY умер между проверкой pid и записью) — отказ done, а не исключение хоста.
 * beforeEnter вернул false — Enter не жмётся, исход 'blocked': за ожидание агент показал
 * диалог (fix-final-b), и Enter его подтвердил бы. Черновик хоста тогда остаётся — текст в поле.
 * submitKey — клавиша отправки, решается в момент отправки (по умолчанию Enter): Codex занятому агенту
 * принимает письмо клавишей Tab — в очередь, а не Enter — в ход. delayMs — своя пауза вместо
 * enterDelayMs: Codex достаточно десятков миллисекунд на приём вставки.
 */
export function typeAndSubmit(
  deps: TypeAndSubmitDeps,
  ref: SessionRef,
  text: string,
  submit: boolean,
  options: {
    hostDraft?: boolean;
    beforeEnter?: () => boolean;
    submitKey?: () => string;
    delayMs?: number;
  } = {},
): Attempt {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const hostDraft = options.hostDraft === true;
  const pid = deps.pty.get(ref)?.pid;

  deps.pty.write(ref, text);
  if (hostDraft) deps.pty.setHostDraft(ref, true);
  if (!submit) return { cancel() {}, done: Promise.resolve('typed') };

  const key = refKey(ref);
  let sawInput = false;
  let settle: (outcome: AttemptOutcome) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const done = new Promise<AttemptOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Любое изменение черновика в окне ожидания — это ввод человека, даже если черновик
  // сам потом снова опустел: Enter чужого текста испортил бы его строку.
  const unsubscribe = deps.pty.on('draft', (changed) => {
    if (refKey(changed) === key) sawInput = true;
  });

  let timer: ReturnType<typeof setTimeout> | undefined = setTimer(() => {
    timer = undefined;
    unsubscribe();
    if (sawInput) {
      settle('input');
      return;
    }
    // Enter — тому же процессу, которому печатали текст: за время задержки сессию
    // могли перезапустить, и посторонний Enter в чужой процесс не идёт. У нового
    // процесса черновика хоста нет — снимать нечего.
    if (deps.pty.get(ref)?.pid !== pid) {
      settle('restarted');
      return;
    }
    // Проверка вызывающего прямо перед Enter: `blocked` приходит хуком позже вставки
    // (запрос разрешения за 500 мс ожидания), а Enter в диалог — автоответ (рамка 15.1).
    if (options.beforeEnter !== undefined && !options.beforeEnter()) {
      settle('blocked');
      return;
    }
    // Колбэк таймера — вне цепочки промисов: брошенное здесь стало бы необработанным
    // исключением хоста, поэтому сбой уходит отказом done тому, кто ждёт исход.
    try {
      deps.pty.write(ref, options.submitKey?.() ?? '\r');
      if (hostDraft) deps.pty.setHostDraft(ref, false);
    } catch (error) {
      fail(error);
      return;
    }
    settle('submitted');
  }, options.delayMs ?? deps.enterDelayMs);

  return {
    cancel() {
      if (timer === undefined) return;
      clearTimer(timer);
      timer = undefined;
      unsubscribe();
      settle('cancelled');
    },
    done,
  };
}
