// packages/desktop/src/main/browser/human-typing.ts
/**
 * Тишина клавиатуры человека (рецензия M3): агент не вводит текст, пока человек печатает в окне Parley или в любой
 * странице. Считает main по `before-input-event` окна и всех гостей: окно само тишину не ждёт. События гостя, на котором
 * сейчас вводит агент, не считаются (`ignore`), отпускание клавиш и автоповтор — тоже.
 *
 * Пока фокус гостя одолжен агенту (`lend`, D1 живых проверок 2026-10-20), клавиатурное событие этого гостя — нажатие
 * человека: CDP-ввод агента (`Input.insertText`, `Input.dispatchKeyEvent`) `before-input-event` не порождает (проба
 * 2026-10-20 в Electron 44). Такое нажатие гасится (`preventDefault`: в страницу не попадает, за ним Chromium гасит и `char`),
 * сбрасывает тишину и сообщается тому, кто одолжил фокус.
 */
import type { WebContents } from 'electron';

export interface TypingClock {
  /** `before-input-event` контента: только нажатие (`keyDown`), не автоповтор. Возвращает отписку. */
  track(contents: Pick<WebContents, 'id' | 'on' | 'off'>): () => void;
  /** Гость, на котором сейчас вводит агент: его события в тишину не входят. */
  ignore(webContentsId: number, on: boolean): void;
  /**
   * Фокус гостя одолжен агенту: его `keyDown`, `rawKeyDown` и `char` (и автоповтор) гасятся, сбрасывают тишину и зовут
   * `onHuman`; `ignore` на них не действует. Возвращает снятие.
   */
  lend(webContentsId: number, onHuman: () => void): () => void;
  /** С последнего нажатия человека прошло не меньше `ms`. */
  idleFor(ms: number): boolean;
  /** Ждёт тишины `ms` не дольше `limitMs`; `false` — не дождались. Отмена `signal` — отказ с её причиной. */
  waitIdle(ms: number, limitMs: number, signal: AbortSignal): Promise<boolean>;
}

/** Как часто `waitIdle` перепроверяет тишину. */
const POLL_MS = 100;

type InputEvent = { type?: string; isAutoRepeat?: boolean };

/** Клавиатурные события, которые печатают в страницу; `keyUp` не печатает. */
const PRESSES = new Set(['keyDown', 'rawKeyDown', 'char']);

export function createTypingClock(deps: { now?(): number; setTimer?(fn: () => void, ms: number): () => void } = {}): TypingClock {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const ignored = new Set<number>();
  /** Гости с одолженным фокусом → кому сообщить о нажатии человека. */
  const lent = new Map<number, () => void>();
  let lastKeyAt = Number.NEGATIVE_INFINITY;

  const idleFor = (ms: number): boolean => now() - lastKeyAt >= ms;

  return {
    track(contents) {
      const listener = (event: { preventDefault(): void }, input: InputEvent): void => {
        const onHuman = lent.get(contents.id);
        if (onHuman !== undefined && input.type !== undefined && PRESSES.has(input.type)) {
          event.preventDefault();
          lastKeyAt = now();
          onHuman();
          return;
        }
        if (input.type !== 'keyDown' || input.isAutoRepeat === true || ignored.has(contents.id)) return;
        lastKeyAt = now();
      };
      contents.on('before-input-event', listener as never);
      return () => {
        contents.off('before-input-event', listener as never);
      };
    },
    ignore(webContentsId, on) {
      if (on) ignored.add(webContentsId);
      else ignored.delete(webContentsId);
    },
    lend(webContentsId, onHuman) {
      lent.set(webContentsId, onHuman);
      return () => {
        if (lent.get(webContentsId) === onHuman) lent.delete(webContentsId);
      };
    },
    idleFor,
    waitIdle(ms, limitMs, signal) {
      return new Promise<boolean>((resolve, reject) => {
        const started = now();
        let cancel: (() => void) | null = null;
        const onAbort = (): void => {
          cancel?.();
          reject(signal.reason);
        };
        const finish = (value: boolean): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const tick = (): void => {
          if (idleFor(ms)) return finish(true);
          if (now() - started >= limitMs) return finish(false);
          cancel = setTimer(tick, POLL_MS);
        };
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        tick();
      });
    },
  };
}
