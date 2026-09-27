/**
 * Контекст фокуса для обработчика клавиш (кусок 6.1a, спека 9.6): от него зависит,
 * какое сочетание достаётся полю, а какое окну.
 */

export type FocusContext = 'dialog' | 'terminal' | 'monaco' | 'input' | 'other';

/** Типы `input`, где ⌘A, ⌘←/→ и ⌘⇧↑/↓ — правка текста. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel']);

/**
 * Редактируемость по атрибуту: ближайший `[contenteditable]` решает, как в браузере —
 * `false` внутри редактируемого родителя поле выключает. jsdom `isContentEditable` не
 * считает, поэтому атрибут проверяется и сам.
 */
function isEditable(element: Element): boolean {
  if (element instanceof HTMLElement && element.isContentEditable === true) return true;
  const host = element.closest('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

/** По ролям, data-атрибутам и тегам; порядок проверок — из плана куска. */
export function focusContext(active: Element | null): FocusContext {
  if (active === null) return 'other';
  // Палитра (6.2) — тоже `role="dialog"`, но её поле — обычное поле: ⌘1–9 выбирают строку.
  if (active.closest('[role="dialog"], [role="alertdialog"]') !== null && active.closest('[data-palette]') === null) {
    return 'dialog';
  }
  // Фокус xterm — `textarea.xterm-helper-textarea`: `.xterm` раньше полей, иначе терминал стал бы полем.
  if (active.closest('.xterm') !== null) return 'terminal';
  if (active.closest('.monaco-editor') !== null) return 'monaco';
  if (active instanceof HTMLTextAreaElement) return 'input';
  if (active instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(active.type) ? 'input' : 'other';
  return isEditable(active) ? 'input' : 'other';
}
