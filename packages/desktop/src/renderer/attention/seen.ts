/**
 * «Просмотрено» (спека 7.2): какие терминалы человек видит и когда хосту сказать
 * `activity.seen`. Видимость поверхностей решает не этот модуль, а `TerminalSurface`
 * (`store/ui.ts#visibleSessionRefs`: работа активна, вкладка активна в группе) —
 * источник один, раскладка здесь заново не разбирается.
 */

import type { SessionRef } from '@harnas/protocol';

/** Непрерывная видимость до отметки (план, «Числа»). */
const VISIBLE_MS = 1000;
/** Повтор для одной сессии не чаще (план, «Числа»). */
const REPEAT_MS = 2000;

export interface VisibilityInput {
  windowFocused: boolean;
  documentVisible: boolean;
  /** store/ui.ts, пишет TerminalSurface (2.5): поверхность видима — работа активна, вкладка активна в группе. */
  visibleSessionRefs: Readonly<Record<string /* refKey */, true>>;
}

const NOTHING: ReadonlySet<string> = new Set();

/** refKey сессий, чей терминал человек видит: поверхность видима при фокусе окна и видимом документе. */
export function visibleSessions(input: VisibilityInput): ReadonlySet<string> {
  if (!input.windowFocused || !input.documentVisible) return NOTHING;
  return new Set(Object.keys(input.visibleSessionRefs));
}

export interface SeenTracker {
  update(visible: ReadonlySet<string> /* refKey */, unseen: ReadonlyMap<string /* refKey */, SessionRef>): void;
  dispose(): void;
}

/** 1 с непрерывной видимости сессии в unseen → send(ref); не чаще раза в 2 с на сессию. */
export function createSeenTracker(deps: {
  send(ref: SessionRef): void;
  now(): number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}): SeenTracker {
  // Таймеры — отдельными функциями, а не методами `deps`: настоящий `setTimeout` Chromium,
  // вызванный с чужим `this` (`deps.setTimer(…)`), бросает «Illegal invocation».
  const { setTimer, clearTimer } = deps;
  // Отсчёт идёт только у сессий «видна ∧ unseen»; выпала из пары — отсчёт сброшен.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const refs = new Map<string, SessionRef>();
  const lastSent = new Map<string, number>();

  const schedule = (key: string, delay: number): void => {
    timers.set(
      key,
      setTimer(() => fire(key), delay),
    );
  };

  const fire = (key: string): void => {
    timers.delete(key);
    const ref = refs.get(key);
    if (ref === undefined) return;
    const now = deps.now();
    const last = lastSent.get(key);
    if (last !== undefined && now - last < REPEAT_MS) {
      schedule(key, last + REPEAT_MS - now);
      return;
    }
    lastSent.set(key, now);
    deps.send(ref);
    // Сессия всё ещё видна и unseen — повтор через 2 с: хост мог уведомление не принять
    // (старый хост без `activity.seen`, переподключение), а человек так и смотрит.
    schedule(key, REPEAT_MS);
  };

  return {
    update(visible, unseen) {
      for (const [key, timer] of [...timers]) {
        if (visible.has(key) && unseen.has(key)) continue;
        clearTimer(timer);
        timers.delete(key);
        refs.delete(key);
      }
      for (const [key, ref] of unseen) {
        if (!visible.has(key)) continue;
        refs.set(key, ref);
        if (!timers.has(key)) schedule(key, VISIBLE_MS);
      }
      // Метки прошлых отправок нужны только в окне повтора — дальше не копятся.
      const now = deps.now();
      for (const [key, at] of [...lastSent]) {
        if (!timers.has(key) && now - at >= REPEAT_MS) lastSent.delete(key);
      }
    },
    dispose() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      refs.clear();
    },
  };
}
