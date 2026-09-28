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
 *
 * «+» строки (кусок 6.2) сначала делает активной СВОЮ группу, затем открывает палитру в
 * режиме `open`: выбранное откроется в этой группе, а не в активной группе работы.
 *
 * Раунд исправлений 1 (ревью A, Important №2): строка — `role="tablist"`, а
 * стрелки ←/→ между вкладками — тут, а не в `Tab.tsx`, потому что только
 * строка целиком видит весь список вкладок сразу (по кругу — `wrapIndex`, тот
 * же приём, что и у `keys/mru-cycle.ts`). Активация (Enter/Space)
 * остаётся в `Tab.tsx` — она про САМУ вкладку, не про список.
 *
 * Колесо мыши (ревью A, Minor №4) держится на РУЧНОМ `addEventListener` с
 * `{ passive: false }`, а не на пропе `onWheel`: React с 17-й версии сам вешает
 * `wheel` пассивным слушателем на корень, и `event.preventDefault()` из
 * синтетического обработчика тогда молча ничего не делает (проверено —
 * `dispatchEvent` всё равно возвращает `true`, будто отмены не было).
 *
 * Кусок 2.6 (спека 5.4): вкладки — sortable @dnd-kit, сама строка — droppable
 * «хвост» с индексом после последней вкладки. Своего `DndContext` нет — он
 * один, в `AppShell.tsx`. У неактивной работы зоны выключены: её строка
 * лежит под строкой активной. Порядок вкладок во время перетаскивания не
 * сдвигается — место вставки показывает линия 2px blue-500.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Activity, WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { GroupNode } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { displayStatus, dotState } from '../lib/dot-state.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { usePaletteStore } from '../palette/store.js';
import { dndId, type DragSourceData, type DropTargetData } from './dnd.js';
import { useStripDropSlot } from './DropIndicator.js';
import { Tab } from './Tab.js';
import { focusGroup } from './tree.js';
import { fileTabTitles, tabMeta, truncateTitle } from './tab-meta.js';
import { useLayoutStore } from './store.js';
import { useTabMetaExtras } from './use-tab-meta-extras.js';

export interface TabStripProps {
  workKey: string;
  group: GroupNode;
  entry: WorkEntry;
  /** Одна группа на всю работу — строка портали­руется в `#titlebar-tabs` (спека 5.3). */
  portal: boolean;
  /** Работа активна: у неактивной зоны броска выключены (кусок 2.6). */
  active: boolean;
}

/** Линия места вставки в строке (спека 5.4). */
function DropLine(): JSX.Element {
  return <span data-drop-line aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-blue-500" />;
}

interface SortableTabProps {
  workKey: string;
  groupId: string;
  tabId: string;
  index: number;
  active: boolean;
  lineBefore: boolean;
  children: ReactNode;
}

/**
 * Обёртка вкладки для `useSortable`: сам `Tab` не знает о перетаскивании.
 * Атрибуты @dnd-kit (`role="button"`, `tabIndex`) не ставятся — они сломали бы
 * roving tabindex и роль `tab`; обёртка — `presentation`.
 */
function SortableTab({ workKey, groupId, tabId, index, active, lineBefore, children }: SortableTabProps): JSX.Element {
  const data: DropTargetData & DragSourceData = { workKey, kind: 'strip', groupId, index, item: { kind: 'tab', tabId } };
  const { setNodeRef, listeners } = useSortable({ id: dndId.tab(workKey, tabId), data, disabled: !active });
  return (
    <div ref={setNodeRef} role="presentation" className="relative flex shrink-0 items-center" {...listeners}>
      {lineBefore ? <DropLine /> : null}
      {children}
    </div>
  );
}

/** Затухание краёв строки (`maskImage` ниже): вкладка под ним видна не целиком. */
const EDGE_FADE_PX = 12;

/**
 * Сдвиг строки, при котором вкладка видна целиком (раунд fix-7-accept, п. 3): к ближайшему краю, с
 * полем под затухание; уже видна — сдвиг прежний, шире строки — к её началу. `tab.left` — от начала
 * содержимого строки, не от видимой части.
 */
export function revealScrollLeft(view: { scrollLeft: number; width: number }, tab: { left: number; width: number }): number {
  const start = tab.left - EDGE_FADE_PX;
  const end = tab.left + tab.width + EDGE_FADE_PX;
  if (end - start > view.width || start < view.scrollLeft) return Math.max(0, start);
  if (end > view.scrollLeft + view.width) return end - view.width;
  return view.scrollLeft;
}

/** Индекс по кругу — стрелки в конце строки уводят на начало и наоборот. */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function TabStrip({ workKey, group, entry, portal, active }: TabStripProps): JSX.Element {
  // Точке нужен только вид активности сессий этой строки, а не вся запись с метриками:
  // поверхностное сравнение держит строку от перерисовки на каждое `activity.changed`
  // (решение контролёра 2 куска 4.2) — как и `useTabMetaExtras`.
  const liveActivity = useActivityStore(
    useShallow((state) => {
      const out: Record<string, Activity | null> = {};
      for (const tab of group.tabs) {
        if (tab.kind !== 'terminal') continue;
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId };
        out[tab.sessionId] = activityFor(state.byRef, ref)?.activity.activity ?? null;
      }
      return out;
    }),
  );
  const extras = useTabMetaExtras();
  // Совпадение имён файлов решается по всей строке (спека 5.3): `tabMeta` видит одну вкладку.
  const fileTitles = useMemo(() => fileTabTitles(group.tabs), [group.tabs]);

  const tablistRef = useRef<HTMLDivElement | null>(null);

  const tailData: DropTargetData = { workKey, kind: 'strip', groupId: group.id, index: group.tabs.length };
  const { setNodeRef } = useDroppable({ id: dndId.strip(workKey, group.id), data: tailData, disabled: !active });
  const setTablist = useCallback(
    (node: HTMLDivElement | null) => {
      tablistRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  const slot = useStripDropSlot(workKey, group.id);

  useEffect(() => {
    const el = tablistRef.current;
    if (el === null) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      // Строке нечего прокручивать (вкладки помещаются целиком) — событию
      // лучше дойти дальше как обычно, а не глохнуть тут без дела (ревью A,
      // Minor №4: без этой проверки возможный прокручиваемый предок в будущем
      // получил бы двойной эффект).
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Открытая или ставшая активной вкладка — любым путём: клик, ⌃1–9, ⌃Tab, дерево, ⌘P,
  // восстановление раскладки — в видимую часть строки. Без этого на узком окне она оставалась за
  // краем, и человек не видел, какой файл перед ним (приёмка этапа 7).
  useLayoutEffect(() => {
    const list = tablistRef.current;
    if (list === null || group.activeTabId === null) return;
    const tab = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) => el.dataset.tabId === group.activeTabId);
    if (tab === undefined) return;
    const outer = list.getBoundingClientRect();
    const inner = tab.getBoundingClientRect();
    const next = revealScrollLeft(
      { scrollLeft: list.scrollLeft, width: list.clientWidth },
      { left: inner.left - outer.left + list.scrollLeft, width: inner.width },
    );
    if (next !== list.scrollLeft) list.scrollLeft = next;
  }, [group.activeTabId, group.tabs.length]);

  const content = (
    <div
      ref={setTablist}
      role="tablist"
      aria-label={S.tabs.tablist}
      // Полоса прокрутки скрыта (fix-7-accept, п. 3): на macOS она накладная и после прокрутки
      // перехватывала клики по нижней половине вкладок. Строку крутят колесо, жест и выбор вкладки.
      className={
        portal
          ? 'flex h-full min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]'
          : 'flex h-8 min-w-0 shrink-0 items-center overflow-x-auto border-b border-border bg-card [scrollbar-width:none]'
      }
      style={{
        maskImage: 'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const tabEls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
        const currentIndex = tabEls.indexOf(document.activeElement as HTMLElement);
        if (currentIndex === -1 || tabEls.length === 0) return;
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        tabEls[wrapIndex(currentIndex + delta, tabEls.length)]?.focus();
        event.preventDefault();
      }}
    >
      <SortableContext items={group.tabs.map((tab) => dndId.tab(workKey, tab.id))} strategy={horizontalListSortingStrategy}>
        {group.tabs.map((tab, index) => {
          const base = tabMeta(tab, entry, extras);
          const fileTitle = fileTitles.get(tab.id);
          const meta = fileTitle === undefined ? base : { ...base, title: truncateTitle(fileTitle) };
          const dot =
            tab.kind === 'terminal' && meta.session !== null
              ? {
                  state: dotState(displayStatus(meta.session), liveActivity[tab.sessionId] ?? null),
                  lifecycle: meta.session.lifecycle,
                }
              : null;
          return (
            <SortableTab
              key={tab.id}
              workKey={workKey}
              groupId={group.id}
              tabId={tab.id}
              index={index}
              active={active}
              lineBefore={slot === index}
            >
              <Tab
                workKey={workKey}
                group={group}
                tab={tab}
                meta={meta}
                dot={dot}
                isActive={tab.id === group.activeTabId}
              />
            </SortableTab>
          );
        })}
      </SortableContext>
      {slot === group.tabs.length ? (
        <span className="relative h-8 w-0 shrink-0">
          <DropLine />
        </span>
      ) : null}
      <button
        type="button"
        aria-label={S.tabs.openTab}
        onClick={() => {
          useLayoutStore.getState().apply(workKey, (layout) => focusGroup(layout, group.id));
          usePaletteStore.getState().openWith('open');
        }}
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
