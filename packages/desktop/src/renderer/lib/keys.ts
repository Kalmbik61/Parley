/**
 * Решает, отдаёт ли xterm нажатие агенту (кусок 1.11 плана окна, дополнено
 * куском 2.4). Сочетания с ⌘ — это всегда пункты системного меню (⌘T, ⌘W, ⌘F,
 * ⌘,, ⌘1…⌘9, копирование выделения) и в `pty.input` уходить не должны: иначе
 * агент получит управляющий байт, который сам не просил, а меню — нет.
 *
 * Кусок 2.4 добавляет ⌃Tab/⌃⇧Tab (MRU вкладок) и ⌃1–9 (вкладка по номеру) —
 * их тоже перехватывает окно (`layout/keys.ts#layoutKeyAction`), не xterm.
 * ⌃C и ⌃A остаются обычными терминальными сочетаниями (SIGINT, «в начало
 * строки») — только `ctrlKey` недостаточно, нужно смотреть саму клавишу.
 */

export interface TerminalKeyEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

/** `false` — отдать нажатие меню/раскладке; `true` — xterm обрабатывает сам. */
export function shouldForwardToTerminal(event: TerminalKeyEvent): boolean {
  if (event.metaKey) return false;
  if (event.ctrlKey) {
    if (event.key === 'Tab') return false; // ⌃Tab и ⌃⇧Tab — MRU вкладок
    if (!event.shiftKey && event.key >= '1' && event.key <= '9') return false; // ⌃1–9
  }
  return true;
}
