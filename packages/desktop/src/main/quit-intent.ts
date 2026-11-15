/**
 * Намерение выхода (самообновление, спека 2026-11-15, §3 решение 3 и §5.4): «Restart now» запоминает намерение и
 * вызывает `app.quit()`. Намерение переживает только повторы этого же выхода; любой другой выход сбрасывает его
 * первым же `before-quit`.
 *
 * Как различаются «свой» и «чужой» выход: Electron порождает `before-quit` синхронно внутри `app.quit()`, поэтому
 * «свой» вызов ставит отметку на время самого вызова. `before-quit` без отметки — чужой выход (⌘Q, меню, Dock) —
 * намерение сбрасывает. Вызов `quit()` во время уже идущего выхода `before-quit` не порождает: такой вызов
 * намерение не трогает, его сбрасывают явно (`clear`) там, где это нужно.
 */
export interface QuitIntent<T> {
  /** Запомнить намерение (заменяет прежнее). */
  arm(payload: T): void;
  /** Вызвать `quit` с отметкой «свой»; отметка снимается и при исключении. */
  ownQuit(quit: () => void): void;
  /** Слушатель `before-quit`: без отметки сбрасывает намерение. */
  onBeforeQuit(): void;
  /** Сбросить намерение явно. */
  clear(): void;
  /** Отдать намерение один раз; повторно и после сброса — `null`. */
  take(): T | null;
}

export function createQuitIntent<T>(): QuitIntent<T> {
  let intent: { payload: T } | null = null;
  let own = false;
  return {
    arm: (payload) => {
      intent = { payload };
    },
    ownQuit: (quit) => {
      const before = own;
      own = true;
      try {
        quit();
      } finally {
        own = before;
      }
    },
    onBeforeQuit: () => {
      if (!own) intent = null;
    },
    clear: () => {
      intent = null;
    },
    take: () => {
      const taken = intent;
      intent = null;
      return taken === null ? null : taken.payload;
    },
  };
}
