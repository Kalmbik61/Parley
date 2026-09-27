/**
 * Сайдбар работ как у Orca (кусок 3.3, спека 6.1–6.3): сверху «Search» и «+ workspace»,
 * ниже — «Закреплённые» и группы проектов с карточками работ.
 *
 * Секции и внимание сайдбар не считает: их пишет `useSidebarSectionsSync` в `AppShell`
 * (`use-sidebar-sections.ts`), здесь только чтение — тот же порядок видят ⌘1–9 и строка
 * статуса. Сайдбар лишь сообщает, что указатель над списком (`sidebarHovering`): тогда
 * пересортировка ждёт, чтобы карточка не уехала из-под курсора (спека 6.2).
 *
 * Своей правой границы у сайдбара нет: шов с центром рисует `shell/Resizer.tsx` (1px),
 * вторая линия рядом читалась бы толще (находка 2.3).
 */

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, Search } from 'lucide-react';
import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import type { WorkAttention } from '../attention/derive.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { workKey } from '../lib/tree-order.js';
import { useNow } from '../lib/use-now.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { ProjectGroup } from './ProjectGroup.js';
import type { SidebarSection } from './sort.js';
import { useSidebarAttention, useSidebarSections } from './use-sidebar-sections.js';
import { WorkCard } from './WorkCard.js';

export interface WorkSidebarProps {
  /** Клик по карточке — работа становится активной (спека 6.4). */
  onActivateWork(workKey: string): void;
  /** Клик по строке сессии — работа активна, вкладка терминала открыта или в фокусе. */
  onOpenSession(workKey: string, sessionId: string): void;
  /** Клик по ✉N карточки — вкладка почты работы. */
  onOpenMail(workKey: string): void;
}

/** С какого числа карточек список виртуализируется (спека 6.1). */
const VIRTUALIZE_ABOVE = 50;
/** Оценка высоты для виртуализатора (план 3.3): карточка 44px плюс 24px на строку сессии. */
const HEADER_HEIGHT = 28;
const CARD_HEIGHT = 44;
const SESSION_ROW_HEIGHT = 24;
/** Раз в сколько обновляется относительное время (план 3.3). */
const NOW_PERIOD_MS = 30_000;
/**
 * Высота списка до первого замера: первый кадр уже с карточками, а не пустой. Сразу после
 * монтирования virtual-core берёт настоящий `offsetHeight` списка.
 */
const INITIAL_LIST_RECT = { width: 280, height: 800 };

type Row = { kind: 'header'; section: SidebarSection } | { kind: 'card'; section: SidebarSection; entry: WorkEntry };

function rowsOf(sections: SidebarSection[]): Row[] {
  return sections.flatMap((section) => [
    { kind: 'header' as const, section },
    ...(section.collapsed ? [] : section.works.map((entry) => ({ kind: 'card' as const, section, entry }))),
  ]);
}

/** Строки сессий, которые карточка покажет свёрнутой: закрытые спрятаны. */
function estimateCard(entry: WorkEntry): number {
  const open = entry.map.sessions.filter((session) => session.lifecycle !== 'closed').length;
  return CARD_HEIGHT + SESSION_ROW_HEIGHT * open;
}

const OFF: WorkAttention = { level: 'off', needsYou: 0, unseen: 0, humanUnread: 0, roomsUnread: {}, lastEventAt: '' };

export function WorkSidebar({ onActivateWork, onOpenSession, onOpenMail }: WorkSidebarProps): JSX.Element {
  const sections = useSidebarSections();
  const attention = useSidebarAttention();
  const entries = useWorksStore((state) => state.entries);
  const branches = useWorksStore((state) => state.branches);
  const activity = useActivityStore((state) => state.byRef);
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const layouts = useLayoutStore((state) => state.layouts);
  const selected = selectedSessionOf({ activeWorkKey, layouts }, entries);
  const pinnedWorks = useUiStore((state) => state.ui.pinnedWorks);
  const collapsedProjects = useUiStore((state) => state.ui.collapsedProjects);
  const patchUi = useUiStore((state) => state.patchUi);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const setSidebarHovering = useUiStore((state) => state.setSidebarHovering);
  const now = useNow(NOW_PERIOD_MS);

  // ⌘B прячет сайдбар под указателем без `pointerleave`: флаг залип бы, и каждая
  // пересортировка ждала бы 3 с.
  useEffect(() => () => setSidebarHovering(false), [setSidebarHovering]);

  const pinned = new Set(pinnedWorks);
  const toggleCollapsed = (projectPath: string): void => {
    const next = collapsedProjects.includes(projectPath)
      ? collapsedProjects.filter((path) => path !== projectPath)
      : [...collapsedProjects, projectPath];
    patchUi({ collapsedProjects: next });
  };

  const renderCard = (entry: WorkEntry): JSX.Element => {
    const key = workKey(entry.projectPath, entry.map.work.id);
    return (
      <WorkCard
        key={key}
        entry={entry}
        attention={attention[key] ?? { ...OFF, lastEventAt: entry.map.work.updatedAt }}
        activity={activity}
        active={key === activeWorkKey}
        pinned={pinned.has(key)}
        branch={branches[entry.projectPath] ?? null}
        now={now}
        selectedSessionId={selected?.workKey === key ? selected.ref.sessionId : null}
        onActivate={() => onActivateWork(key)}
        onOpenSession={(sessionId) => onOpenSession(key, sessionId)}
        onOpenMail={() => onOpenMail(key)}
      />
    );
  };

  const cardCount = sections.reduce((sum, section) => sum + (section.collapsed ? 0 : section.works.length), 0);

  return (
    <div data-work-sidebar className="flex h-full w-full min-w-0 flex-col bg-work-sidebar text-work-sidebar-foreground">
      <div className="flex shrink-0 flex-col gap-0.5 p-2">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-work-sidebar-accent"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">{S.sidebar.search}</span>
          <kbd className="rounded border border-work-sidebar-border px-1 text-[10px] text-work-sidebar-muted-foreground">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={openNewWorkDialog}
          className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-work-sidebar-accent"
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">{S.sidebar.addWorkspace}</span>
          <kbd className="rounded border border-work-sidebar-border px-1 text-[10px] text-work-sidebar-muted-foreground">⌘N</kbd>
        </button>
      </div>
      {cardCount > VIRTUALIZE_ABOVE ? (
        <VirtualList
          rows={rowsOf(sections)}
          renderCard={renderCard}
          onToggleCollapsed={toggleCollapsed}
          onNewWork={openNewWorkDialog}
          onHover={setSidebarHovering}
        />
      ) : (
        <div
          data-sidebar-list
          onPointerEnter={() => setSidebarHovering(true)}
          onPointerLeave={() => setSidebarHovering(false)}
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        >
          {sections.map((section) => (
            <ProjectGroup
              key={section.key}
              section={section}
              onToggleCollapsed={() => toggleCollapsed(section.key)}
              onNewWork={openNewWorkDialog}
            >
              {section.collapsed ? null : <div className="pt-0.5">{section.works.map(renderCard)}</div>}
            </ProjectGroup>
          ))}
        </div>
      )}
    </div>
  );
}

interface VirtualListProps {
  rows: Row[];
  renderCard(entry: WorkEntry): JSX.Element;
  onToggleCollapsed(projectPath: string): void;
  onNewWork(): void;
  onHover(hovering: boolean): void;
}

/** Больше 50 карточек (спека 6.1): в DOM — только видимые строки и запас по краям. */
function VirtualList({ rows, renderCard, onToggleCollapsed, onNewWork, onHover }: VirtualListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row === undefined || row.kind === 'header' ? HEADER_HEIGHT : estimateCard(row.entry);
    },
    getItemKey: (index) => {
      const row = rows[index];
      if (row === undefined) return index;
      return row.kind === 'header' ? `h ${row.section.key}` : `c ${row.section.key} ${workKey(row.entry.projectPath, row.entry.map.work.id)}`;
    },
    initialRect: INITIAL_LIST_RECT,
    overscan: 4,
  });

  return (
    <div
      ref={scrollRef}
      data-sidebar-list
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'header' ? (
                <ProjectGroup
                  section={row.section}
                  onToggleCollapsed={() => onToggleCollapsed(row.section.key)}
                  onNewWork={onNewWork}
                />
              ) : (
                renderCard(row.entry)
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
