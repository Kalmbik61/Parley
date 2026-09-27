/**
 * Строка вкладок одной группы (кусок 2.4, спека 5.1, 5.3): пока в работе одна
 * группа — портал прямо в заголовок окна (`#titlebar-tabs`, слот подготовлен
 * куском 2.3), иначе — обычная строка 32px над телом ЭТОЙ группы. Портал без
 * найденного слота (изолированный тест, ранний кадр до `Titlebar`) рисуется
 * на месте — так строка не пропадает молча.
 *
 * Точка состояния терминальных вкладок считается тут, а не в `Tab.tsx`: нужен
 * полный `SessionRef` (`entry.projectPath`/`workId` + `tab.sessionId`), а
 * `entry` есть только здесь и в `GroupView.tsx`, до `Tab.tsx` он не доходит.
 * `openSessionIds` — тоже здесь и один раз на всю строку: одинаков для всех
 * вкладок группы (кандидаты `SessionPicker` по всей раскладке работы, не по
 * одной группе).
 */

import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { GroupNode, WorkLayout } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { displayStatus, dotState } from '../lib/dot-state.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { Tab } from './Tab.js';
import { groups } from './tree.js';
import { tabMeta } from './tab-meta.js';
import { useLayoutStore } from './store.js';

export interface TabStripProps {
  workKey: string;
  group: GroupNode;
  entry: WorkEntry;
  /** Одна группа на всю работу — строка портали­руется в `#titlebar-tabs` (спека 5.3). */
  portal: boolean;
}

/** Id сессий, у которых уже открыт терминал в раскладке работы — кандидаты `SessionPicker` при «Разделить» (спека 5.2). */
function openTerminalSessionIds(layout: WorkLayout | undefined): string[] {
  if (layout === undefined) return [];
  return groups(layout).flatMap((g) => g.tabs.filter((t) => t.kind === 'terminal').map((t) => t.sessionId));
}

export function TabStrip({ workKey, group, entry, portal }: TabStripProps): JSX.Element {
  const layout = useLayoutStore((state) => state.layouts[workKey]);
  const activityByRef = useActivityStore((state) => state.byRef);
  const openSessionIds = openTerminalSessionIds(layout);

  const content = (
    <div
      className={
        portal
          ? 'flex h-full min-w-0 flex-1 items-center overflow-x-auto'
          : 'flex h-8 min-w-0 shrink-0 items-center overflow-x-auto border-b border-border bg-card'
      }
      style={{
        maskImage: 'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
      }}
      onWheel={(event) => {
        if (event.deltaY === 0) return;
        event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {group.tabs.map((tab) => {
        const meta = tabMeta(tab, entry);
        const dot =
          tab.kind === 'terminal' && meta.session !== null
            ? (() => {
                const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId };
                const activity = activityFor(activityByRef, ref);
                const session = meta.session;
                if (session === null) return null;
                return { state: dotState(displayStatus(session), activity?.activity.activity ?? null), lifecycle: session.lifecycle };
              })()
            : null;
        return (
          <Tab
            key={tab.id}
            workKey={workKey}
            group={group}
            tab={tab}
            meta={meta}
            dot={dot}
            isActive={tab.id === group.activeTabId}
            openSessionIds={openSessionIds}
          />
        );
      })}
      <button
        type="button"
        aria-label={S.tabs.openTab}
        onClick={() => useUiStore.getState().setPaletteOpen(true)}
        className="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );

  if (portal) {
    const target = typeof document === 'undefined' ? null : document.getElementById('titlebar-tabs');
    if (target !== null) return createPortal(content, target);
  }
  return content;
}
