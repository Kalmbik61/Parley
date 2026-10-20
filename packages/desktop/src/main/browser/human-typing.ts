// packages/desktop/src/main/browser/human-typing.ts
/**
 * Тишина клавиатуры человека (рецензия M3): агент не вводит текст, пока человек печатает в окне Parley или в любой
 * странице. Считает main по `before-input-event` окна и всех гостей: окно само тишину не ждёт. События гостя, на котором
 * сейчас вводит агент, не считаются (`ignore`), отпускание клавиш и автоповтор — тоже.
 */
import type { WebContents } from 'electron';

export interface TypingClock {
  /** `before-input-event` контента: только нажатие (`keyDown`), не автоповтор. Возвращает отписку. */
  track(contents: Pick<WebContents, 'id' | 'on' | 'off'>): () => void;
  /** Гость, на котором сейчас вводит агент: его события в тишину не входят. */
  ignore(webContentsId: number, on: boolean): void;
  /** С последнего нажатия человека прошло не меньше `ms`. */
  idleFor(ms: number): boolean;
  /** Ждёт тишины `ms` не дольше `limitMs`; `false` — не дождались. Отмена `signal` — отказ с её причиной. */
  waitIdle(ms: number, limitMs: number, signal: AbortSignal): Promise<boolean>;
}

/** Как часто `waitIdle` перепроверяет тишину. */
const POLL_MS = 100;

type InputEvent = { type?: string; isAutoRepeat?: boolean };

export function createTypingClock(deps: { now?(): number; setTimer?(fn: () => void, ms: number): () => void } = {}): TypingClock {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const ignored = new Set<number>();
  let lastKeyAt = Number.NEGATIVE_INFINITY;

  const idleFor = (ms: number): boolean => now() - lastKeyAt >= ms;

  return {
    track(contents) {
      const listener = (_event: unknown, input: InputEvent): void => {
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
