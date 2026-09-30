/**
 * Что показывал диалог в тот миг, когда его содержимое попало в DOM. jsdom ничего не рисует, поэтому «форма сброшена до
 * отрисовки» проверяется по вставке: узел, что React кладёт в `document.body` (портал диалога), читается тем же вызовом,
 * что вставляет его, — раньше, чем какой-нибудь эффект успеет что-то поправить. Сброс в `useEffect` шёл после вставки,
 * и поле появлялось со значениями прошлого открытия; сброс в `useLayoutEffect` идёт до неё.
 *
 * Стирание набранного, из-за которого сброс переносили (E2E rooms-dialogs: название, введённое сразу после открытия,
 * пропадало), в jsdom не воспроизводится и со старым `useEffect`: React ставит введённое после сброса в ту же очередь
 * обновлений, и оно побеждает. Воспроизводится само окно гонки — поле на экране с прежними значениями, — его и ловит это.
 */

export interface InsertRecording<T> {
  /** Что прочитано у каждого вставленного в `body` узла; `null` из `read` — узел не интересен и не записывается. */
  readonly seen: T[];
  /** Вернуть `body` прежние `appendChild` и `insertBefore`. */
  stop: () => void;
}

export function recordOnInsert<T>(read: (inserted: HTMLElement) => T | null): InsertRecording<T> {
  const seen: T[] = [];
  const undo: Array<() => void> = [];
  for (const method of ['appendChild', 'insertBefore'] as const) {
    const original = document.body[method] as unknown as (...args: unknown[]) => unknown;
    const own = Object.getOwnPropertyDescriptor(document.body, method);
    Object.defineProperty(document.body, method, {
      configurable: true,
      writable: true,
      value(this: Node, ...args: unknown[]): unknown {
        const inserted = args[0];
        if (inserted instanceof HTMLElement) {
          const value = read(inserted);
          if (value !== null) seen.push(value);
        }
        return original.apply(this, args);
      },
    });
    undo.push(() => {
      if (own === undefined) Reflect.deleteProperty(document.body, method);
      else Object.defineProperty(document.body, method, own);
    });
  }
  return { seen, stop: () => undo.forEach((restore) => restore()) };
}
