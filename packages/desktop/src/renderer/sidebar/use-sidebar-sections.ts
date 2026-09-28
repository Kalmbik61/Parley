/**
 * Общий источник секций и внимания сайдбара (кусок 3.3). Порядок работ нужен не только
 * самому списку: ⌘1–9 и ⌘⇧↑↓ (3.4), строка статуса и «следующая, где нужен ты» (4.2)
 * должны видеть ровно то, что на экране, — в том числе отложенный под указателем порядок.
 * Поэтому считает один писатель, а остальные читают готовое из стора.
 *
 * Писатель живёт в `AppShell`, а не в `WorkSidebar`: сайдбар прячется по ⌘B, а порядок
 * для клавиш и статуса должен обновляться и тогда. Но не в теле `AppShell`, а в маленьком
 * дочернем `SidebarSectionsWriter`: писатель подписан на активность, а хост шлёт
 * `activity.changed` на каждое изменение метрик — иначе на каждое событие перерисовывалась
 * бы вся оболочка (раунд исправлений 1 куска 3.3, ревью A).
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { WorkEntry } from '@harnas/core';
import { sameWorkAttention, workAttention, type WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { buildSections, type SidebarSection } from './sort.js';
import { useDeferredOrder } from './use-deferred-order.js';

/** Сколько пересортировка ждёт под указателем (спека 6.2). */
const MAX_DEFER_MS = 3000;

interface SidebarSectionsState {
  sections: SidebarSection[];
  attention: Record<string, WorkAttention>;
  /**
   * Снимок работ (ссылка `useWorksStore.entries`), по которому посчитаны `sections` и
   * `attention`; `null` — ещё не считали. Обработчики клавиш (3.4) берут порядок через
   * `getState()`: соседа и работу на старте выбирают, только когда здесь текущий снимок.
   */
  entries: WorkEntry[] | null;
}

/** Пишет только `useSidebarSectionsSync`; экспорт — для тестов. */
export const useSidebarSectionsStore = create<SidebarSectionsState>(() => ({ sections: [], attention: {}, entries: null }));

/** Секции в порядке на экране — общий источник WorkSidebar, ⌘1–9 и ⌘⇧↑↓ (3.4), nextAttentionTarget (4.2). */
export function useSidebarSections(): SidebarSection[] {
  return useSidebarSectionsStore((state) => state.sections);
}

/** Внимание работ того же расчёта (ключ — workKey): WorkSidebar и карточки его не пересчитывают. */
export function useSidebarAttention(): Record<string, WorkAttention> {
  return useSidebarSectionsStore((state) => state.attention);
}

/**
 * Единственный писатель: buildSections из сторов работ, активности и зеркала ui.json,
 * затем useDeferredOrder по sidebarHovering. Зовётся один раз — в `SidebarSectionsWriter`
 * под AppShell — и живёт при свёрнутом сайдбаре. Возвращает секции своего рендера: стор
 * пишет эффект, поэтому useSidebarSections() отстаёт на рендер; обработчикам клавиш (3.4)
 * хватает `getState()`.
 */
export function useSidebarSectionsSync(): SidebarSection[] {
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const pinned = useUiStore((state) => state.ui.pinnedWorks);
  const collapsed = useUiStore((state) => state.ui.collapsedProjects);
  const showDone = useUiStore((state) => state.ui.showDoneWorks);
  const showArchived = useUiStore((state) => state.showArchived);
  const hovering = useUiStore((state) => state.sidebarHovering);

  // Структурное разделение: работа, чьё внимание не изменилось, сохраняет прежний объект, а
  // если не изменилось ни у одной — прежней остаётся и вся карта. Тогда `memo`-карточка
  // чужой работы не перерисовывается, а порядок не пересчитывается на метрики.
  const previous = useRef<Record<string, WorkAttention>>({});
  const attention = useMemo(() => {
    const prev = previous.current;
    let reused = 0;
    const next: Record<string, WorkAttention> = {};
    for (const entry of entries) {
      const key = workKey(entry.projectPath, entry.map.work.id);
      const fresh = workAttention(entry, byRef);
      const old = prev[key];
      if (old !== undefined && sameWorkAttention(old, fresh)) {
        next[key] = old;
        reused += 1;
      } else {
        next[key] = fresh;
      }
    }
    return reused === entries.length && reused === Object.keys(prev).length ? prev : next;
  }, [entries, byRef]);
  previous.current = attention;
  const fresh = useMemo(
    () => buildSections({ entries, attention, pinned, collapsed, showDone, showArchived }),
    [entries, attention, pinned, collapsed, showDone, showArchived],
  );
  const sections = useDeferredOrder(fresh, hovering, MAX_DEFER_MS);

  // Layout-эффект, а не обычный: читатели получают новый порядок до отрисовки кадра,
  // и сайдбар не мигает прежним порядком после смены данных.
  useLayoutEffect(() => {
    useSidebarSectionsStore.setState({ sections, attention, entries });
  }, [sections, attention, entries]);

  return sections;
}

/**
 * Писатель как компонент: `AppShell` монтирует его и сам на активность не подписан. Ничего
 * не рисует.
 */
export function SidebarSectionsWriter(): null {
  useSidebarSectionsSync();
  return null;
}
