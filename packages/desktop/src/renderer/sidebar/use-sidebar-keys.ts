/**
 * Клавиатура сайдбара (кусок 3.4, спека 6.5). Курсор — фокус DOM: карточка
 * `[data-work-key]` или строка сессии `[data-session-id]` внутри неё. Так курсор виден
 * обычной рамкой фокуса, Enter строки работает её собственным обработчиком, а Shift+F10
 * открывает меню того, что под фокусом.
 *
 * - Tab в сайдбар (или клик по пустому месту списка) ставит курсор на активную карточку.
 * - ↑↓ идут по карточкам и строкам сессий в порядке на экране; Enter открывает.
 * - → на карточке разворачивает закрытые сессии, ← сворачивает; ← на строке — к карточке.
 * - Shift+F10 — контекстное меню элемента под курсором.
 *
 * Порядок берётся из DOM, а не из секций: курсор ходит ровно по тому, что нарисовано, — с
 * отложенным порядком, свёрнутыми группами и раскрытыми закрытыми сессиями. При
 * виртуализации (больше 50 карточек) это только нарисованная часть; `focus()` прокручивает
 * к элементу, и виртуализатор дорисовывает следующие.
 */

import { useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { isTextEntryTarget } from '../layout/keys.js';

export interface SidebarCursor {
  workKey: string;
  sessionId: string | null;
}

const sameCursor = (a: SidebarCursor, b: SidebarCursor): boolean => a.workKey === b.workKey && a.sessionId === b.sessionId;

/**
 * Следующая позиция курсора. У краёв курсор стоит на месте; курсора нет или его элемент
 * пропал — ↓ на первый, ↑ на последний; порядок пуст — `null`.
 */
export function moveCursor(
  order: SidebarCursor[],
  current: SidebarCursor | null,
  key: 'ArrowUp' | 'ArrowDown',
): SidebarCursor | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.findIndex((item) => sameCursor(item, current));
  if (index === -1) return (key === 'ArrowDown' ? order[0] : order[order.length - 1]) ?? null;
  const next = key === 'ArrowDown' ? Math.min(index + 1, order.length - 1) : Math.max(index - 1, 0);
  return order[next] ?? null;
}

/** Позиция курсора элемента — только сама карточка или сама строка, не их потомки. */
function cursorOf(element: Element): SidebarCursor | null {
  if (!(element instanceof HTMLElement)) return null;
  const sessionId = element.dataset.sessionId;
  if (sessionId !== undefined) {
    const card = element.closest<HTMLElement>('[data-work-key]');
    const workKey = card?.dataset.workKey;
    return workKey === undefined ? null : { workKey, sessionId };
  }
  const workKey = element.dataset.workKey;
  return workKey === undefined ? null : { workKey, sessionId: null };
}

function cursorElements(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('[data-work-key], [data-work-key] [data-session-id]')];
}

function elementOf(list: HTMLElement, cursor: SidebarCursor): HTMLElement | null {
  return cursorElements(list).find((element) => {
    const found = cursorOf(element);
    return found !== null && sameCursor(found, cursor);
  }) ?? null;
}

export interface SidebarKeysInput {
  /** Прокручиваемый список сайдбара. */
  listRef: RefObject<HTMLElement>;
  activeWorkKey: string | null;
  onActivateWork(workKey: string): void;
  /** → и ← на карточке: закрытые сессии развернуть или свернуть. */
  onShowClosed(workKey: string, shown: boolean): void;
}

export interface SidebarKeyHandlers {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onPointerDown(): void;
  onPointerUp(): void;
}

export function useSidebarKeys({ listRef, activeWorkKey, onActivateWork, onShowClosed }: SidebarKeysInput): SidebarKeyHandlers {
  // Фокус от указателя остаётся там, куда кликнули: курсор на активную карточку ставит
  // только вход с клавиатуры (или клик по пустому месту списка).
  const pointer = useRef(false);

  return {
    onPointerDown: () => {
      pointer.current = true;
    },
    onPointerUp: () => {
      pointer.current = false;
    },
    onFocus: (event) => {
      const list = listRef.current;
      if (list === null) return;
      const related = event.relatedTarget;
      if (related instanceof Node && list.contains(related)) return;
      if (pointer.current && event.target !== list) return;
      // Поле переименования берёт фокус само, а закрытое меню или диалог возвращают его
      // своему триггеру — это не вход в сайдбар, курсор не переставляется.
      if (isTextEntryTarget(event.target)) return;
      if (related instanceof Element && related.closest('[role="menu"], [role="dialog"]') !== null) return;
      const cards = [...list.querySelectorAll<HTMLElement>('[data-work-key]')];
      const target = cards.find((card) => card.dataset.workKey === activeWorkKey) ?? cards[0];
      if (target !== undefined && target !== event.target) target.focus();
    },
    onKeyDown: (event) => {
      const list = listRef.current;
      if (list === null || event.defaultPrevented) return;
      pointer.current = false;
      const current = cursorOf(event.target as Element);
      if (current === null) return;
      const element = event.target as HTMLElement;

      if (event.key === 'F10' && event.shiftKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.bottom }),
        );
        return;
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = moveCursor(cursorElements(list).flatMap((item) => cursorOf(item) ?? []), current, event.key);
        if (next !== null) elementOf(list, next)?.focus();
      } else if (current.sessionId === null && event.key === 'Enter') {
        event.preventDefault();
        onActivateWork(current.workKey);
      } else if (current.sessionId === null && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        onShowClosed(current.workKey, event.key === 'ArrowRight');
      } else if (current.sessionId !== null && event.key === 'ArrowLeft') {
        event.preventDefault();
        elementOf(list, { workKey: current.workKey, sessionId: null })?.focus();
      }
    },
  };
}
