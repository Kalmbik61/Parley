/**
 * Набор текста с любого места окна, как в Telegram: печатный символ вне полей отдаёт фокус
 * полю сообщения открытого Chat или комнаты, и первая буква не теряется. Поля регистрируются
 * при монтировании; `focusComposer` выбирает видимое, предпочитая поле сфокусированной группы.
 */
import type { FocusContext } from './focus-context.js';

/** Поле сообщения: `textarea` у Chat, `contenteditable` у комнаты. */
type ComposerElement = HTMLElement;

const composers = new Set<ComposerElement>();

/** Видимость — по раскладке; в jsdom раскладки нет, тест подменяет проверку. */
const defaultIsVisible = (element: HTMLElement): boolean =>
  element.isConnected && (element.offsetParent !== null || element.getClientRects().length > 0);
let isVisible: (element: HTMLElement) => boolean = defaultIsVisible;

/** Только для тестов: подмена проверки видимости; без аргумента возвращает настоящую. */
export function setVisibilityCheck(check?: (element: HTMLElement) => boolean): void {
  isVisible = check ?? defaultIsVisible;
}

/** Поле живёт, пока смонтирован его композер; отдаёт отмену регистрации. */
export function registerComposer(element: ComposerElement): () => void {
  composers.add(element);
  return () => {
    composers.delete(element);
  };
}

/** Каретка в конец, если её нет в самом поле: у `contenteditable` фокус без выделения ставит её в начало. */
function placeCaretAtEnd(element: HTMLElement): void {
  if (element instanceof HTMLTextAreaElement) return; // textarea помнит свою каретку
  const selection = window.getSelection();
  if (selection === null || element.contains(selection.anchorNode)) return;
  selection.selectAllChildren(element);
  selection.collapseToEnd();
}

/** Фокус полю видимой вкладки; true — поле нашлось. Без preventDefault символ придёт уже в него. */
export function focusComposer(): boolean {
  const visible = [...composers].filter(isVisible);
  if (visible.length === 0) return false;
  const target = visible.find((element) => element.closest('[data-group-focused="true"]') !== null) ?? visible[0];
  if (target === undefined) return false;
  target.focus();
  placeCaretAtEnd(target);
  return true;
}

/** Нажатие, которое начинает набор: один печатный символ без ⌘/⌃/⌥, не IME и не автоповтор. */
export function shouldTypeToFocus(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'repeat'>,
  context: FocusContext,
  paletteOpen: boolean,
  hasOpenDialog: boolean,
): boolean {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.isComposing || event.repeat) return false;
  return context === 'other' && !paletteOpen && !hasOpenDialog;
}
