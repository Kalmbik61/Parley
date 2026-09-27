/**
 * Раскладка активной работы (кусок 2.4, спека 5.1–5.3): дерево сплитов из
 * групп вкладок за флагом `?center=new` (`AppShell.tsx` решает, когда её
 * монтировать — при `activeWorkKey === null` `LayoutView` вовсе не в дереве).
 * `bridge`/`fontFamily`/`fontSize` приходят пропами и раздаются телам вкладок
 * контекстом (`GroupView.tsx#LayoutBodyContext`), как раньше `PanelHostContext`
 * у `Workspace.tsx`.
 *
 * Клавиши, которые ловит сам рендерер, а не системное меню (спека 5.3, до
 * реестра клавиш 6.1) — ⌃Tab/⌃⇧Tab (MRU вкладок работы), ⌃1–9 (вкладка по
 * номеру в активной группе), ⌘⇧[/⌘⇧] (соседняя вкладка активной группы) —
 * висят тут: `LayoutView` монтирован, только пока его работа активна, поэтому
 * слушатель на `window` всегда бьёт по правильной работе без доп. проверки.
 */

import { useEffect } from 'react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { LayoutBodyContext } from './GroupView.js';
import { layoutKeyAction } from './keys.js';
import { NodeView } from './SplitView.js';
import { useLayoutStore } from './store.js';
import { focusTab, groups } from './tree.js';

export interface LayoutViewProps {
  workKey: string;
  bridge: HarnasBridge;
  fontFamily: string;
  fontSize: number;
}

/** Индекс по кругу: `step` может увести и вперёд, и назад за границы массива. */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function LayoutView({ workKey, bridge, fontFamily, fontSize }: LayoutViewProps): JSX.Element | null {
  const layout = useLayoutStore((state) => state.layouts[workKey]);
  const entries = useWorksStore((state) => state.entries);
  const entry = entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const action = layoutKeyAction(event);
      if (action === null) return;

      const current = useLayoutStore.getState().layouts[workKey];
      if (current === undefined) return;
      const activeGroup = groups(current).find((candidate) => candidate.id === current.activeGroupId);

      if (action.kind === 'mru') {
        const list = useLayoutStore.getState().mru[workKey] ?? [];
        // 0 — сама текущая вкладка (MRU обновляется на каждый фокус, спека 5.7):
        // «вперёд» — позиция 1 (предыдущая), «назад» — последняя, круг из двух и
        // более записей.
        if (list.length < 2) return;
        const tabId = list[wrapIndex(action.step, list.length)];
        if (tabId !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tabId));
      } else if (action.kind === 'tab-index') {
        const tab = activeGroup?.tabs[action.index];
        if (tab !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tab.id));
      } else {
        if (activeGroup === undefined || activeGroup.tabs.length === 0) return;
        const currentIndex = activeGroup.tabs.findIndex((tab) => tab.id === activeGroup.activeTabId);
        const tab = activeGroup.tabs[wrapIndex(currentIndex + action.step, activeGroup.tabs.length)];
        if (tab !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tab.id));
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workKey]);

  // Раскладка ещё не гидрирована (`layout/persistence.ts`, доля кадра сразу
  // после смены активной работы) или сама работа уже пропала из снимка —
  // молчаливо ничего не показываем, не «Workspace closed»: это переходное
  // состояние, а не ошибка (следующий снимок либо принесёт работу, либо
  // `AppShell` вовсе уберёт эту работу из активных).
  if (entry === undefined || layout === undefined) return null;

  const singleGroup = groups(layout).length === 1;

  return (
    <LayoutBodyContext.Provider value={{ bridge, fontFamily, fontSize }}>
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <NodeView workKey={workKey} node={layout.root} entry={entry} singleGroup={singleGroup} />
      </div>
    </LayoutBodyContext.Provider>
  );
}
