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
 *
 * Раунд исправлений 1: roving tabindex (WAI-ARIA tree). Точка входа в порядке Tab одна —
 * элемент под курсором (`useCursorStop`), остальные карточки и строки −1: Tab с курсора
 * уходит из списка одним нажатием, а не по всем строкам сессий.
 */

import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { create } from 'zustand';
import { isTextEntryTarget } from '../layout/keys.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useSidebarSectionsStore } from './use-sidebar-sections.js';

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

interface CursorState {
  /** Элемент под курсором; `null` — курсора ещё нет, точка входа — активная карточка. */
  cursor: SidebarCursor | null;
  /** Курсор, чьё меню открыто по Shift+F10: закрытое меню возвращает фокус ему. */
  menuReturn: SidebarCursor | null;
}

/**
 * Курсор — в отдельном сторе, а не в состоянии сайдбара: карточки и строки — `memo`, и на
 * шаг курсора перерисовываются только два элемента, прежний и новый.
 */
export const useSidebarCursorStore = create<CursorState>(() => ({ cursor: null, menuReturn: null }));

const setCursor = (cursor: SidebarCursor | null): void => {
  const current = useSidebarCursorStore.getState().cursor;
  if (current === cursor || (current !== null && cursor !== null && sameCursor(current, cursor))) return;
  useSidebarCursorStore.setState({ cursor });
};

/**
 * Точка входа ли этот элемент (tabIndex 0 и `aria-selected`). Пока курсора нет — активная
 * карточка. Элемент под курсором ушёл из DOM (сессия закрыта, работа удалена, карточка
 * уехала за край виртуального списка) — курсор сбрасывается, иначе в список не войти Tab.
 */
export function useCursorStop(workKey: string, sessionId: string | null, active: boolean): boolean {
  const stop = useSidebarCursorStore((state) =>
    state.cursor === null ? sessionId === null && active : state.cursor.workKey === workKey && state.cursor.sessionId === sessionId,
  );
  useEffect(
    () => () => {
      const cursor = useSidebarCursorStore.getState().cursor;
      if (cursor !== null && cursor.workKey === workKey && cursor.sessionId === sessionId) setCursor(null);
    },
    [workKey, sessionId],
  );
  return stop;
}

/**
 * `onCloseAutoFocus` меню карточки и строки. Меню, открытое Shift+F10, возвращает фокус
 * элементу под курсором, найденному заново по его ключу: Radix держит ссылку на прежний
 * узел, и после перерисовки карточки (→/← по «+N closed») фокус уходил не туда (раунд
 * исправлений 1, находка 4). Меню, открытое мышью, фокус не трогает — пусть решает Radix.
 */
export function returnCursorFocus(event: Event): void {
  const back = useSidebarCursorStore.getState().menuReturn;
  if (back === null) return;
  useSidebarCursorStore.setState({ menuReturn: null });
  const list = document.querySelector<HTMLElement>('[data-sidebar-list]');
  const element = list === null ? null : elementOf(list, back);
  if (element === null) return;
  event.preventDefault();
  element.focus();
}

/**
 * `onCloseAutoFocus` подтверждений из меню карточки и строки (раунд исправлений 2): фокус —
 * элементу, чьё меню открыло диалог, найденному заново по ключу. Сам Radix Dialog
 * возвращает фокус только своему `Dialog.Trigger`, а подтверждение открывает пункт уже
 * закрытого меню — и фокус падал на `<body>`. Элемента нет (работа удалена или архивирована, сессия удалена) —
 * фокус на список: его `onFocus` ставит курсор на активную карточку.
 */
export function focusSidebarItem(event: Event, cursor: SidebarCursor): void {
  const list = document.querySelector<HTMLElement>('[data-sidebar-list]');
  if (list === null) return;
  event.preventDefault();
  const element = elementOf(list, cursor) ?? elementOf(list, { workKey: cursor.workKey, sessionId: null });
  if (element !== null) element.focus();
  else list.focus();
}

/** Показана ли работа в каком-нибудь развёрнутом разделе сайдбара. */
function shownInSidebar(key: string): boolean {
  return useSidebarSectionsStore
    .getState()
    .sections.some((section) => !section.collapsed && section.works.some((entry) => workKeyOf(entry.projectPath, entry.map.work.id) === key));
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
  /** Идёт свой перевод фокуса: вложенный `onFocus` от него — не новый вход. */
  const redirecting = useRef(false);

  // Элемент с фокусом ушёл из DOM (раунд исправлений 2): подтверждение Archive/Delete
  // вернуло фокус карточке, а следующий снимок хоста её убрал — фокус падал на `<body>`, и
  // Tab начинался с начала окна. Тот же элемент перерисован заново (карточка переехала в
  // Pinned) — фокус ему; пропала строка — её карточке; пропала работа — списку, то есть
  // активной карточке. Работа ещё показана, но её узла нет — это край виртуального списка:
  // фокус не трогаем, иначе прокрутка колесом дёргала бы список к активной карточке.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    let last: { element: HTMLElement; cursor: SidebarCursor } | null = null;
    const onFocusIn = (event: globalThis.FocusEvent): void => {
      const target = event.target;
      const cursor = target instanceof Element ? cursorOf(target) : null;
      last = cursor === null ? null : { element: target as HTMLElement, cursor };
    };
    const onFocusOut = (event: globalThis.FocusEvent): void => {
      // Без `relatedTarget` фокус уходит в никуда — так же выглядит и удаление узла.
      if (event.relatedTarget !== null) last = null;
    };
    const observer = new MutationObserver(() => {
      if (last === null || last.element.isConnected) return;
      const { cursor } = last;
      last = null;
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const element = elementOf(list, cursor) ?? elementOf(list, { workKey: cursor.workKey, sessionId: null });
      if (element !== null) element.focus();
      else if (!shownInSidebar(cursor.workKey)) list.focus();
    });
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('focusout', onFocusOut);
    observer.observe(list, { childList: true, subtree: true });
    return () => {
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
    };
  }, [listRef]);

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
      const target = event.target;
      // Фокус в порталах меню и диалогов всплывает сюда по дереву React, но это не список.
      // Прежде курсор уводил фокус из меню на карточку, ловушка фокуса меню возвращала
      // его — и так до переполнения стека (раунд исправлений 1, находка 2).
      if (!list.contains(target) || redirecting.current) return;
      const own = cursorOf(target);
      const related = event.relatedTarget;
      // Клик по пустому месту списка — всегда курсор на активную карточку, откуда бы ни
      // пришёл фокус (находка 3). Вход с клавиатуры (Tab, Shift+Tab) — только снаружи: не
      // из списка, не из меню или диалога (они возвращают фокус своему триггеру) и не без
      // источника (окно снова стало активным, программный `focus()`).
      const entered =
        target === list ||
        (!pointer.current &&
          related instanceof Element &&
          !list.contains(related) &&
          related.closest('[role="menu"], [role="dialog"]') === null &&
          !isTextEntryTarget(target));
      if (!entered) {
        if (own !== null) setCursor(own);
        return;
      }
      const cards = [...list.querySelectorAll<HTMLElement>('[data-work-key]')];
      const card = cards.find((item) => item.dataset.workKey === activeWorkKey) ?? cards[0];
      if (card === undefined) return;
      setCursor(cursorOf(card));
      if (card === target) return;
      redirecting.current = true;
      try {
        card.focus();
      } finally {
        redirecting.current = false;
      }
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
        useSidebarCursorStore.setState({ menuReturn: current });
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
        if (next !== null) {
          setCursor(next);
          elementOf(list, next)?.focus();
        }
      } else if (current.sessionId === null && event.key === 'Enter') {
        event.preventDefault();
        onActivateWork(current.workKey);
      } else if (current.sessionId === null && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        onShowClosed(current.workKey, event.key === 'ArrowRight');
      } else if (current.sessionId !== null && event.key === 'ArrowLeft') {
        event.preventDefault();
        const card = { workKey: current.workKey, sessionId: null };
        setCursor(card);
        elementOf(list, card)?.focus();
      }
    },
  };
}
