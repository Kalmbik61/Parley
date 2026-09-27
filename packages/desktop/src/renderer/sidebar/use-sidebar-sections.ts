/**
 * Общий источник секций и внимания сайдбара (кусок 3.3). Порядок работ нужен не только
 * самому списку: ⌘1–9 и ⌘⇧↑↓ (3.4), строка статуса и «следующая, где нужен ты» (4.2)
 * должны видеть ровно то, что на экране, — в том числе отложенный под указателем порядок.
 * Поэтому считает один писатель, а остальные читают готовое из стора.
 *
 * Писатель живёт в `AppShell`, а не в `WorkSidebar`: сайдбар прячется по ⌘B, а порядок
 * для клавиш и статуса должен обновляться и тогда.
 */

import { useLayoutEffect, useMemo } from 'react';
import { create } from 'zustand';
import { workAttention, type WorkAttention } from '../attention/derive.js';
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
}

/** Пишет только `useSidebarSectionsSync`; экспорт — для тестов. */
export const useSidebarSectionsStore = create<SidebarSectionsState>(() => ({ sections: [], attention: {} }));

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
 * затем useDeferredOrder по sidebarHovering. Зовётся один раз в AppShell — живёт и при
 * свёрнутом сайдбаре. Возвращает секции своего рендера: стор пишет эффект, поэтому
 * useSidebarSections() отстаёт на рендер, а AppShell берёт видимый порядок из возврата (3.4).
 */
export function useSidebarSectionsSync(): SidebarSection[] {
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const pinned = useUiStore((state) => state.ui.pinnedWorks);
  const collapsed = useUiStore((state) => state.ui.collapsedProjects);
  const showDone = useUiStore((state) => state.ui.showDoneWorks);
  const hovering = useUiStore((state) => state.sidebarHovering);

  const attention = useMemo(
    () =>
      Object.fromEntries(
        entries.map((entry) => [workKey(entry.projectPath, entry.map.work.id), workAttention(entry, byRef)]),
      ),
    [entries, byRef],
  );
  const fresh = useMemo(
    () => buildSections({ entries, attention, pinned, collapsed, showDone }),
    [entries, attention, pinned, collapsed, showDone],
  );
  const sections = useDeferredOrder(fresh, hovering, MAX_DEFER_MS);

  // Layout-эффект, а не обычный: читатели получают новый порядок до отрисовки кадра,
  // и сайдбар не мигает прежним порядком после смены данных.
  useLayoutEffect(() => {
    useSidebarSectionsStore.setState({ sections, attention });
  }, [sections, attention]);

  return sections;
}
