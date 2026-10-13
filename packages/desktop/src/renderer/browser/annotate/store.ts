// packages/desktop/src/renderer/browser/annotate/store.ts
/**
 * Аннотации вкладки браузера (спека браузера 4.7): пункты лотка и открытый редактор комментария — по id вкладки, в
 * памяти окна. Данные каждой метки снимаются в момент её создания: новый документ стирает метки со страницы, а лоток с
 * данными остаётся (пункты помечаются «element gone»). Номера — 1…N без дыр: удаление перенумеровывает, и номера лотка,
 * файла и меток на снимке совпадают.
 *
 * Поколение документа. Ключ метки (`a1`, `a2`…) скрипт страницы нумерует заново в каждом документе, а лоток хранит и
 * пункты прошлых: без различия «a1» нового документа совпал бы с «a1» прошлого, и страница нарисовала бы обе метки на
 * одной цели. Поэтому у вкладки есть `generation` (растёт на каждом новом документе), а у пункта — поколение документа,
 * где он поставлен. В страницу уходят только пункты текущего поколения; пункты прошлых в её мире не существуют.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { AnnotationPick, AnnotationPin, AnnotationPosition, AnnotationTarget, Rect, ViewportFraction } from '../../../shared/browser-types.js';
import { CONTEXT_LIMITS } from '../../../shared/context-markdown.js';

export interface AnnotationItem {
  n: number;
  /** Ключ цели в мире скрипта меток: уникален только в пределах поколения `generation`. */
  key: string;
  /** Поколение документа вкладки, в котором поставлена метка (`AnnotateTabState.generation` в тот момент). */
  generation: number;
  /** Адрес страницы в момент метки: в файле он называет страницу метки, если она не та, что в шапке. */
  url: string;
  target: AnnotationTarget;
  comment: string;
  /** Элемента больше нет на странице (или страница сменилась). */
  gone: boolean;
  /** Где цель сейчас — доли вьюпорта из последней перерисовки; `null` — неизвестно. */
  rect: Rect | null;
}

export interface AnnotationEditing {
  n: number;
  /** Новая метка: Esc её отменяет. */
  isNew: boolean;
  anchor: ViewportFraction;
  draft: string;
}

export interface AnnotateTabState {
  items: AnnotationItem[];
  editing: AnnotationEditing | null;
  collapsed: boolean;
  /** Поколение текущего документа: `markAllGone` (новый документ) увеличивает его, даже когда лоток пуст. */
  generation: number;
}

export const EMPTY_ANNOTATE: AnnotateTabState = { items: [], editing: null, collapsed: false, generation: 0 };

/** Метки для страницы: только пункты её документа — ключ прошлого документа в её мире ничего не называет или называет чужое. */
export function pinsOf(tab: Pick<AnnotateTabState, 'items' | 'generation'>): AnnotationPin[] {
  return tab.items.filter((item) => item.generation === tab.generation).map(({ n, key }) => ({ n, key }));
}

function renumber(items: readonly AnnotationItem[]): AnnotationItem[] {
  return items.map((item, index) => (item.n === index + 1 ? item : { ...item, n: index + 1 }));
}

/** Комментарий человека: без пробелов по краям, не длиннее предела в кодовых точках. */
function limitComment(text: string): string {
  return Array.from(text.trim()).slice(0, CONTEXT_LIMITS.comment).join('');
}

function editOf(tab: AnnotateTabState, n: number): AnnotationEditing | null {
  const item = tab.items.find((candidate) => candidate.n === n);
  if (item === undefined) return null;
  const anchor = item.rect === null ? item.target.anchor : { fx: item.rect.x, fy: item.rect.y };
  return { n, isNew: false, anchor, draft: item.comment };
}

export interface AnnotateState {
  tabs: Record<string, AnnotateTabState>;
  /** Ответ скрипта: новая метка — пункт и редактор; правка — редактор этого пункта. `url` — адрес страницы сейчас. */
  receive(tabId: string, pick: AnnotationPick, url: string): void;
  setDraft(tabId: string, draft: string): void;
  save(tabId: string): void;
  cancelEdit(tabId: string): void;
  startEdit(tabId: string, n: number): void;
  remove(tabId: string, n: number): void;
  /** Убрать все пункты; убранные — для «Undo». */
  clear(tabId: string): AnnotationItem[];
  restore(tabId: string, items: readonly AnnotationItem[]): void;
  markPositions(tabId: string, positions: readonly AnnotationPosition[]): void;
  markAllGone(tabId: string): void;
  setCollapsed(tabId: string, collapsed: boolean): void;
  drop(tabId: string): void;
}

export const useAnnotateStore: UseBoundStore<StoreApi<AnnotateState>> = create<AnnotateState>((set, get) => {
  const patch = (tabId: string, change: (tab: AnnotateTabState) => AnnotateTabState): void =>
    set((state) => ({ tabs: { ...state.tabs, [tabId]: change(state.tabs[tabId] ?? EMPTY_ANNOTATE) } }));

  return {
    tabs: {},
    receive: (tabId, pick, url) =>
      patch(tabId, (tab) => {
        if (pick.kind === 'edit') return { ...tab, editing: editOf(tab, pick.n) };
        if (tab.items.length >= CONTEXT_LIMITS.annotations) return tab;
        const n = tab.items.length + 1;
        return {
          ...tab,
          collapsed: false,
          items: [...tab.items, { n, key: pick.key, generation: tab.generation, url, target: pick, comment: '', gone: false, rect: null }],
          editing: { n, isNew: true, anchor: pick.anchor, draft: '' },
        };
      }),
    setDraft: (tabId, draft) => patch(tabId, (tab) => (tab.editing === null ? tab : { ...tab, editing: { ...tab.editing, draft } })),
    save: (tabId) =>
      patch(tabId, (tab) => {
        const editing = tab.editing;
        if (editing === null) return tab;
        const comment = limitComment(editing.draft);
        return { ...tab, editing: null, items: tab.items.map((item) => (item.n === editing.n ? { ...item, comment } : item)) };
      }),
    cancelEdit: (tabId) =>
      patch(tabId, (tab) => {
        const editing = tab.editing;
        if (editing === null) return tab;
        return { ...tab, editing: null, items: editing.isNew ? renumber(tab.items.filter((item) => item.n !== editing.n)) : tab.items };
      }),
    startEdit: (tabId, n) => patch(tabId, (tab) => ({ ...tab, editing: editOf(tab, n) })),
    remove: (tabId, n) => patch(tabId, (tab) => ({ ...tab, editing: null, items: renumber(tab.items.filter((item) => item.n !== n)) })),
    clear: (tabId) => {
      const removed = get().tabs[tabId]?.items ?? [];
      patch(tabId, (tab) => ({ ...tab, items: [], editing: null }));
      return removed;
    },
    restore: (tabId, items) =>
      patch(tabId, (tab) => {
        // Пока тост «Undo» висел, страница могла смениться: пункты прошлого документа возвращаются, но «gone».
        const back = items.map((item) => (item.generation === tab.generation ? item : { ...item, gone: true, rect: null }));
        return { ...tab, editing: null, items: renumber([...back, ...tab.items].slice(0, CONTEXT_LIMITS.annotations)) };
      }),
    markPositions: (tabId, positions) =>
      patch(tabId, (tab) => ({
        ...tab,
        items: tab.items.map((item) => {
          const position = positions.find((candidate) => candidate.n === item.n);
          return position === undefined ? item : { ...item, rect: position.rect, gone: position.rect === null };
        }),
      })),
    // Новый документ: поколение растёт всегда, и при пустом лотке — иначе «Undo» вернёт пункты прошлой страницы как живые.
    markAllGone: (tabId) =>
      patch(tabId, (tab) => ({ ...tab, generation: tab.generation + 1, items: tab.items.map((item) => ({ ...item, gone: true, rect: null })) })),
    setCollapsed: (tabId, collapsed) => patch(tabId, (tab) => ({ ...tab, collapsed })),
    drop: (tabId) =>
      set((state) => {
        if (!(tabId in state.tabs)) return state;
        const rest = { ...state.tabs };
        delete rest[tabId];
        return { tabs: rest };
      }),
  };
});
