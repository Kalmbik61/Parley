/**
 * Стор активной работы и раскладок всех работ окна (спека 5.6–5.8, кусок 2.2
 * плана каркаса). Сама раскладка — чистые функции `layout/tree.ts`; этот файл
 * — состояние zustand вокруг них: какая работа активна, что уже гидрировано с
 * диска, что накопилось до гидрации, история переходов и MRU вкладок.
 * Загрузка/сохранение на диск и слежение за составом снимка работ — отдельно,
 * в `layout/persistence.ts`: этот стор ничего не знает про `HarnasBridge`.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { closeTab, emptyLayout, findTab, focusTab, groups } from './tree.js';
import type { OpError, OpResult } from './tree.js';
import { EMPTY_HISTORY, pushHistory, removeMru, stepHistory, touchMru } from './history.js';
import type { History, HistoryEntry, Mru } from './history.js';

export type LayoutOp = (layout: WorkLayout) => WorkLayout | OpResult;

/**
 * Вопрос перед закрытием вкладок человеком (`requestCloseTabs`); `false` —
 * человек отменил. С 7.3 — про несохранённые буферы редактора.
 */
export type CloseGuard = (workKey: string, tabIds: string[]) => Promise<boolean>;

export interface LayoutState {
  /** Владелец активной работы; `ui.json.activeWorkKey` — её копия на диске (`layout/persistence.ts`). */
  activeWorkKey: string | null;
  layouts: Record<string, WorkLayout>;
  /** Раскладка работы загружена с диска или признана пустой (см. `hydrate`). */
  hydrated: Record<string, true>;
  /** Операции над работой до её `hydrate` — применяются по порядку сразу после него. */
  pending: Record<string, LayoutOp[]>;
  history: History;
  mru: Mru;
  /** `true` на время перехода самой историей: смена работы и вкладки в историю не пишется. */
  navigating: boolean;

  setActiveWork(workKey: string | null): void;
  hydrate(workKey: string, layout: WorkLayout | null): void;
  /** Применяет операцию к раскладке работы; ошибку операции возвращает, раскладку не трогает. */
  apply(workKey: string, op: LayoutOp): OpError | null;
  /**
   * Единственный путь закрытия вкладок человеком: крестик, средняя кнопка,
   * меню вкладки, `close-panel` (⌘W). Сначала guard, потом `closeTab` по
   * каждой; `false` — отменено, раскладка та же.
   */
  requestCloseTabs(workKey: string, tabIds: string[]): Promise<boolean>;
  /** `null` — закрывать без вопроса (до 7.3). */
  setCloseGuard(guard: CloseGuard | null): void;
  drop(workKey: string): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  entries(): readonly HistoryEntry[];
}

/** `LayoutOp` может вернуть либо готовую раскладку, либо `OpResult` с ошибкой — приводит к одному виду. */
function applyOp(layout: WorkLayout, op: LayoutOp): { layout: WorkLayout; error: OpError | null } {
  const result = op(layout);
  return 'error' in result ? result : { layout: result, error: null };
}

/** Активная вкладка активной группы раскладки — то, что видит человек прямо сейчас. */
function activeTabOf(layout: WorkLayout): string | null {
  const group = groups(layout).find((g) => g.id === layout.activeGroupId);
  return group?.activeTabId ?? null;
}

/**
 * Выбранная сессия: активная работа и терминал активной вкладки её активной группы; иначе null.
 *
 * Выводится, а не хранится (кусок 2.7): прежний центр сам писал «выбранную
 * сессию» в `store/ui.ts` на каждую смену активной панели, и копия могла
 * разойтись с тем, что видно. Отсюда её берут подсветка строки в сайдбаре и
 * «следующая, где нужен ты» (`attention/next.ts`).
 */
export function selectedSessionOf(
  state: Pick<LayoutState, 'activeWorkKey' | 'layouts'>,
  works: WorkEntry[],
): { workKey: string; ref: SessionRef } | null {
  const key = state.activeWorkKey;
  if (key === null) return null;
  const layout = state.layouts[key];
  if (layout === undefined) return null;
  const group = groups(layout).find((g) => g.id === layout.activeGroupId);
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId);
  if (tab?.kind !== 'terminal') return null;
  const entry = works.find((candidate) => workKeyOf(candidate.projectPath, candidate.map.work.id) === key);
  if (entry === undefined) return null;
  return { workKey: key, ref: { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId } };
}

/** Сессия вкладки терминала или диффа; прочие вкладки сессии не называют. */
function sessionOfTab(tab: TabSpec | undefined): string | null {
  return tab?.kind === 'terminal' || tab?.kind === 'diff' ? tab.sessionId : null;
}

/**
 * Сессия вкладки terminal или diff активной группы работы; иначе — самой свежей записи entries()
 * этой работы, чья вкладка terminal или diff ещё в раскладке; иначе null. selectedSessionOf (2.7) —
 * другое: только терминал активной вкладки активной работы (⌘T, подсветка строки сайдбара).
 *
 * Одна «сессия в фокусе» правого сайдбара: «Файлы» (7.2) и «Изменения» (8.2). История нужна,
 * чтобы фокус на вкладке файла не сбрасывал корень на проект (кусок 7.2).
 */
export function focusedSessionOf(state: Pick<LayoutState, 'layouts' | 'entries'>, workKey: string): string | null {
  const layout = state.layouts[workKey];
  if (layout === undefined) return null;
  const group = groups(layout).find((g) => g.id === layout.activeGroupId);
  const active = sessionOfTab(group?.tabs.find((candidate) => candidate.id === group.activeTabId));
  if (active !== null) return active;
  const history = state.entries();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry === undefined || entry.workKey !== workKey || entry.tabId === null) continue;
    const found = findTab(layout, entry.tabId);
    const sessionId = sessionOfTab(found?.group.tabs[found.index]);
    if (sessionId !== null) return sessionId;
  }
  return null;
}

function layoutTabIds(layout: WorkLayout): Set<string> {
  return new Set(groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id)));
}

/**
 * MRU (спека 5.7): `touchMru` при смене активной вкладки активной группы,
 * `removeMru` при закрытии вкладки — обе стороны одной и той же операции, раз
 * `apply` — единственное место, где раскладка работы вообще меняется.
 */
function updateMru(mru: Mru, workKey: string, prev: WorkLayout, next: WorkLayout): Mru {
  let result = mru;
  const prevIds = layoutTabIds(prev);
  const nextIds = layoutTabIds(next);
  for (const id of prevIds) {
    if (!nextIds.has(id)) result = removeMru(result, workKey, id);
  }
  const prevActive = activeTabOf(prev);
  const nextActive = activeTabOf(next);
  if (nextActive !== null && nextActive !== prevActive) result = touchMru(result, workKey, nextActive);
  return result;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) next[k] = v;
  }
  return next;
}

/**
 * Годна ли запись истории для `stepHistory`: раскладка её работы должна быть
 * в памяти, а вкладка (если запись её знает) — по-прежнему существовать
 * (спека 5.7: «запись пропускается, если раскладки её работы нет в `layouts`
 * или вкладка закрыта»).
 */
function isEntryAlive(state: LayoutState, entry: HistoryEntry): boolean {
  const layout = state.layouts[entry.workKey];
  if (layout === undefined) return false;
  return entry.tabId === null || findTab(layout, entry.tabId) !== null;
}

/**
 * `hydrate` активной работы дописывает `tabId` в её последнюю запись истории
 * вместо новой (спека 5.7) — запись уже стоит на месте: её сделал
 * `setActiveWork` с `tabId: null`, раз раскладка ещё не была известна. Вызывать
 * здесь `pushHistory` значило бы задвоить переход на одну и ту же работу.
 * Вызывающая сторона уже проверила, что последняя запись — про эту же работу
 * (условие `activeWorkKey === workKey`, которое только `setActiveWork` и
 * поддерживает как инвариант).
 */
function amendLastTabId(history: History, tabId: string | null): History {
  const last = history.entries[history.index];
  if (last === undefined || last.tabId === tabId) return history;
  const entries = history.entries.slice();
  entries[history.index] = { ...last, tabId };
  return { ...history, entries };
}

export const useLayoutStore: UseBoundStore<StoreApi<LayoutState>> = create<LayoutState>((set, get) => {
  // Сам guard — не часть реактивного состояния (в `LayoutState` его нет): это
  // разовая функция-обработчик, а не данные, за которыми должны следить подписки.
  let closeGuard: CloseGuard | null = null;

  function navigate(step: -1 | 1): void {
    const state = get();
    const result = stepHistory(state.history, step, (entry) => isEntryAlive(state, entry));
    if (result === null) return;

    // `navigating` подавляет запись истории внутри `setActiveWork`/`apply`
    // ниже — это переход самой историей, а не новый шаг человека.
    set({ navigating: true });
    // `try/finally` (раунд исправлений 1, Minor): и `tree.ts`, и `focusTab`
    // сегодня никогда не бросают, но если `setActiveWork`/`apply` всё же
    // бросят (например, будущая операция расширит `LayoutOp` чем-то не таким
    // отказоустойчивым), `navigating` не должен залипнуть `true` навсегда —
    // тогда вся последующая история молча перестала бы писаться.
    try {
      get().setActiveWork(result.entry.workKey);
      const tabId = result.entry.tabId;
      if (tabId !== null) get().apply(result.entry.workKey, (layout) => focusTab(layout, tabId));
    } finally {
      set({ history: result.history, navigating: false });
    }
  }

  return {
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,

    setActiveWork: (workKey) => {
      const state = get();
      if (state.activeWorkKey === workKey) return;

      // На `null` (нет работ вовсе) и во время навигации историей запись не
      // пишем: `HistoryEntry.workKey` не бывает `null`, а переход самой
      // историей не должен порождать новых записей.
      if (state.navigating || workKey === null) {
        set({ activeWorkKey: workKey });
        return;
      }

      const layout = state.layouts[workKey];
      const tabId = layout === undefined ? null : activeTabOf(layout);
      const history = pushHistory(state.history, { workKey, tabId, at: Date.now() });
      set({ activeWorkKey: workKey, history });
    },

    hydrate: (workKey, layout) => {
      const state = get();
      // Повторный вызов для уже гидрированной работы — молчаливый no-op:
      // живое состояние в памяти не должно затираться более старым чтением
      // с диска, кто бы его ни принёс повторно (раунд исправлений 1).
      if (state.hydrated[workKey] === true) return;

      const initial = layout ?? emptyLayout();
      const queue = state.pending[workKey] ?? [];
      let current = initial;
      for (const op of queue) {
        const result = applyOp(current, op);
        if (result.error === null) current = result.layout;
      }

      const mru = updateMru(state.mru, workKey, initial, current);
      const history =
        !state.navigating && state.activeWorkKey === workKey
          ? amendLastTabId(state.history, activeTabOf(current))
          : state.history;

      set({
        layouts: { ...state.layouts, [workKey]: current },
        hydrated: { ...state.hydrated, [workKey]: true },
        pending: omit(state.pending, workKey),
        mru,
        history,
      });
    },

    apply: (workKey, op) => {
      const state = get();
      if (state.hydrated[workKey] !== true) {
        // Раскладка ещё не пришла с диска — операция ждёт своей очереди в
        // `hydrate` (см. его тело); ответ `null`, а не ошибка: вызывающая
        // сторона (клик по сессии непоказанной работы, 2.7) не виновата в том,
        // что работа ещё не гидрирована.
        const queue = [...(state.pending[workKey] ?? []), op];
        set({ pending: { ...state.pending, [workKey]: queue } });
        return null;
      }

      const layout = state.layouts[workKey];
      // `hydrated[workKey]` истинно ⇒ `layouts[workKey]` существует по
      // построению (оба выставляются вместе в `hydrate`); индексированный
      // доступ всё равно даёт `| undefined` из-за `noUncheckedIndexedAccess`.
      if (layout === undefined) return null;

      const result = applyOp(layout, op);
      if (result.error !== null) return result.error;
      const nextLayout = result.layout;
      if (nextLayout === layout) return null;

      const mru = updateMru(state.mru, workKey, layout, nextLayout);
      let history = state.history;
      if (!state.navigating && state.activeWorkKey === workKey) {
        const prevActive = activeTabOf(layout);
        const nextActive = activeTabOf(nextLayout);
        const current = history.entries[history.index];
        if (nextActive !== prevActive && prevActive === null && current?.workKey === workKey && current.tabId === null) {
          // Первая вкладка пустой работы дописывает запись `setActiveWork` с `tabId: null`, как
          // `hydrate` (раунд lane-r3): иначе «назад» после клика по сессии такой работы стоял бы
          // на её пустой записи, и порядок «гидрация до клика или после» менял бы историю.
          history = amendLastTabId(history, nextActive);
        } else if (nextActive !== prevActive) {
          history = pushHistory(history, { workKey, tabId: nextActive, at: Date.now() });
        }
      }

      set({ layouts: { ...state.layouts, [workKey]: nextLayout }, mru, history });
      return null;
    },

    requestCloseTabs: async (workKey, tabIds) => {
      if (closeGuard !== null) {
        const proceed = await closeGuard(workKey, tabIds);
        if (!proceed) return false;
      }
      for (const tabId of tabIds) {
        get().apply(workKey, (layout) => closeTab(layout, tabId));
      }
      return true;
    },

    setCloseGuard: (guard) => {
      closeGuard = guard;
    },

    drop: (workKey) => {
      set((state) => ({
        layouts: omit(state.layouts, workKey),
        hydrated: omit(state.hydrated, workKey),
        pending: omit(state.pending, workKey),
        mru: omit(state.mru, workKey),
        activeWorkKey: state.activeWorkKey === workKey ? null : state.activeWorkKey,
      }));
    },

    back: () => navigate(-1),
    forward: () => navigate(1),

    canBack: () => {
      const state = get();
      return stepHistory(state.history, -1, (entry) => isEntryAlive(state, entry)) !== null;
    },
    canForward: () => {
      const state = get();
      return stepHistory(state.history, 1, (entry) => isEntryAlive(state, entry)) !== null;
    },
    entries: () => get().history.entries,
  };
});
