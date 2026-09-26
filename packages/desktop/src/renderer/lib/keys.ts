/**
 * Решает, отдаёт ли xterm нажатие агенту (кусок 1.11 плана окна). Сочетания с
 * ⌘ — это всегда пункты системного меню (⌘T, ⌘W, ⌘F, ⌘,, ⌘1…⌘9, копирование
 * выделения) и в `pty.input` уходить не должны: иначе агент получит
 * управляющий байт, который сам не просил, а меню — нет.
 */

export interface TerminalKeyEvent {
  readonly metaKey: boolean;
}

/** `false` — отдать нажатие меню/браузеру; `true` — xterm обрабатывает сам. */
export function shouldForwardToTerminal(event: TerminalKeyEvent): boolean {
  return !event.metaKey;
}
