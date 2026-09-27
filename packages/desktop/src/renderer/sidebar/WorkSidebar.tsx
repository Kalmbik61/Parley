/**
 * Сайдбар работ как у Orca (кусок 3.3, спека 6.1–6.3): сверху «Search» и «New workspace»,
 * ниже — «Закреплённые» и группы проектов с карточками работ.
 *
 * Секции и внимание сайдбар не считает: их пишет `SidebarSectionsWriter` под `AppShell`
 * (`use-sidebar-sections.ts`), здесь только чтение — тот же порядок видят ⌘1–9 и строка
 * статуса. Сайдбар лишь сообщает, что порядок держится (`sidebarHovering`): указатель над
 * списком, открыто меню сайдбара или идёт переименование (кусок 3.4) — тогда пересортировка
 * ждёт, чтобы карточка не уехала из-под курсора (спека 6.2).
 *
 * Своей правой границы у сайдбара нет: шов с центром рисует `shell/Resizer.tsx` (1px),
 * вторая линия рядом читалась бы толще (находка 2.3).
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, Search } from 'lucide-react';
import type { WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { attentionOf } from '../attention/derive.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { workKey } from '../lib/tree-order.js';
import { useNow } from '../lib/use-now.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { ProjectGroup } from './ProjectGroup.js';
import type { SidebarSection } from './sort.js';
import { useSidebarKeys } from './use-sidebar-keys.js';
import { useSidebarAttention, useSidebarSections } from './use-sidebar-sections.js';
import { showClosedSessions, WorkCard } from './WorkCard.js';

export interface WorkSidebarProps {
  /** Мост для меню карточек и строк (кусок 3.4). */
  bridge: HarnasBridge;
  /** Клик по карточке — работа становится активной (спека 6.4). */
  onActivateWork(workKey: string): void;
  /** Клик по строке сессии — работа активна, вкладка терминала открыта или в фокусе. */
  onOpenSession(workKey: string, sessionId: string): void;
  /** Клик по ✉N карточки — вкладка почты работы. */
  onOpenMail(workKey: string): void;
  /** Выбор комнаты в меню `#` карточки — вкладка комнаты (кусок 3.4). */
  onOpenRoom(workKey: string, roomId: string): void;
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

/**
 * Срез активности одной работы: только записи её сессий. Прежний объект, если все записи
 * те же по ссылке (стор активности заменяет лишь изменённую), — тогда `memo`-карточка этой
 * работы не перерисовывается на событие чужой (раунд исправлений 1 куска 3.3).
 */
function activitySlice(
  entry: WorkEntry,
  byRef: Record<string, ActivityEntry>,
  previous: Record<string, ActivityEntry> | undefined,
): Record<string, ActivityEntry> {
  const next: Record<string, ActivityEntry> = {};
  let same = previous !== undefined;
  for (const session of entry.map.sessions) {
    const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
    const value = byRef[key];
    if (value !== undefined) next[key] = value;
    if (same && previous?.[key] !== value) same = false;
  }
  if (same && previous !== undefined && Object.keys(previous).length === Object.keys(next).length) return previous;
  return next;
}

interface CardHandlers {
  onActivate(): void;
  onOpenSession(sessionId: string): void;
  onOpenMail(): void;
  onOpenRoom(roomId: string): void;
}

export function WorkSidebar({ bridge, onActivateWork, onOpenSession, onOpenMail, onOpenRoom }: WorkSidebarProps): JSX.Element {
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
  const holding = useUiStore((state) => Object.keys(state.sidebarHolds).length > 0);
  const now = useNow(NOW_PERIOD_MS);
  const listRef = useRef<HTMLDivElement>(null);

  // Порядок держат указатель над списком и открытые меню или переименование (кусок 3.4):
  // уход указателя в портал меню — не уход с сайдбара.
  const [pointerOver, setPointerOver] = useState(false);
  const hovering = pointerOver || holding;
  useEffect(() => setSidebarHovering(hovering), [hovering, setSidebarHovering]);
  // ⌘B прячет сайдбар под указателем без `pointerleave`: флаг залип бы, и каждая
  // пересортировка ждала бы 3 с.
  useEffect(() => () => setSidebarHovering(false), [setSidebarHovering]);

  // Колбэки карточек устойчивы (карточка — `memo`): один набор на работу, а зовёт он всегда
  // свежие пропсы сайдбара — `AppShell` передаёт их стрелками.
  const props = useRef({ onActivateWork, onOpenSession, onOpenMail, onOpenRoom });
  props.current = { onActivateWork, onOpenSession, onOpenMail, onOpenRoom };
  const handlers = useRef(new Map<string, CardHandlers>());
  const handlersFor = (key: string): CardHandlers => {
    let found = handlers.current.get(key);
    if (found === undefined) {
      found = {
        onActivate: () => props.current.onActivateWork(key),
        onOpenSession: (sessionId) => props.current.onOpenSession(key, sessionId),
        onOpenMail: () => props.current.onOpenMail(key),
        onOpenRoom: (roomId) => props.current.onOpenRoom(key, roomId),
      };
      handlers.current.set(key, found);
    }
    return found;
  };
  // Срезы активности прошлого рендера — по workKey.
  const slices = useRef(new Map<string, Record<string, ActivityEntry>>());
  // Записи работ, ушедших из снимка, не копятся (решение контролёра 3 куска 3.4): иначе
  // кеши росли бы за всю жизнь окна, а вернувшаяся работа получила бы устаревший срез.
  const liveKeys = new Set(entries.map((entry) => workKey(entry.projectPath, entry.map.work.id)));
  for (const cache of [handlers.current, slices.current]) {
    for (const key of cache.keys()) {
      if (!liveKeys.has(key)) cache.delete(key);
    }
  }

  const keys = useSidebarKeys({
    listRef,
    activeWorkKey,
    onActivateWork: (key) => props.current.onActivateWork(key),
    onShowClosed: showClosedSessions,
  });

  const pinned = new Set(pinnedWorks);
  const toggleCollapsed = (projectPath: string): void => {
    const next = collapsedProjects.includes(projectPath)
      ? collapsedProjects.filter((path) => path !== projectPath)
      : [...collapsedProjects, projectPath];
    patchUi({ collapsedProjects: next });
  };

  const renderCard = (entry: WorkEntry): JSX.Element => {
    const key = workKey(entry.projectPath, entry.map.work.id);
    const slice = activitySlice(entry, activity, slices.current.get(key));
    slices.current.set(key, slice);
    const cardHandlers = handlersFor(key);
    return (
      <WorkCard
        key={key}
        entry={entry}
        attention={attentionOf(attention, entry)}
        activity={slice}
        active={key === activeWorkKey}
        pinned={pinned.has(key)}
        branch={branches[entry.projectPath] ?? null}
        now={now}
        selectedSessionId={selected?.workKey === key ? selected.ref.sessionId : null}
        onActivate={cardHandlers.onActivate}
        onOpenSession={cardHandlers.onOpenSession}
        onOpenMail={cardHandlers.onOpenMail}
        onOpenRoom={cardHandlers.onOpenRoom}
        bridge={bridge}
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
          <kbd className="rounded border border-work-sidebar-border px-1 text-[10px] text-work-sidebar-muted-foreground">⌘J</kbd>
        </button>
        <button
          type="button"
          // Без проекта: обработчик напрямую получил бы событие клика вместо пути.
          onClick={() => openNewWorkDialog()}
          className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-work-sidebar-accent"
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">{S.sidebar.addWorkspace}</span>
          <kbd className="rounded border border-work-sidebar-border px-1 text-[10px] text-work-sidebar-muted-foreground">⌘N</kbd>
        </button>
      </div>
      {/* Один и тот же узел списка по обе стороны порога виртуализации: иначе при переходе
          через 50 карточек под указателем старый узел пропадал без `pointerleave`, и флаг
          `sidebarHovering` залипал (раунд исправлений 1 куска 3.3). */}
      <div
        ref={listRef}
        data-sidebar-list
        // Дерево WAI-ARIA: ↑↓ по карточкам и строкам, →/← — раскрыть и свернуть (спека 6.5).
        role="tree"
        aria-label={S.sidebar.workspaceList}
        // Клик по пустому месту списка — фокус сайдбара (спека 6.5), курсор на активной карточке.
        tabIndex={-1}
        onFocus={keys.onFocus}
        onKeyDown={keys.onKeyDown}
        onPointerDown={keys.onPointerDown}
        onPointerUp={keys.onPointerUp}
        onPointerEnter={() => setPointerOver(true)}
        onPointerLeave={() => setPointerOver(false)}
        className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
      >
        {cardCount > VIRTUALIZE_ABOVE ? (
          <VirtualList
            scrollRef={listRef}
            rows={rowsOf(sections)}
            renderCard={renderCard}
            onToggleCollapsed={toggleCollapsed}
            onNewWork={openNewWorkDialog}
          />
        ) : (
          sections.map((section) => (
            <ProjectGroup
              key={section.key}
              section={section}
              onToggleCollapsed={() => toggleCollapsed(section.key)}
              onNewWork={openNewWorkDialog}
            >
              {section.collapsed ? null : <div className="pt-0.5">{section.works.map(renderCard)}</div>}
            </ProjectGroup>
          ))
        )}
      </div>
    </div>
  );
}

interface VirtualListProps {
  /** Прокручиваемый список `WorkSidebar` — он же ловит наведение. */
  scrollRef: RefObject<HTMLDivElement>;
  rows: Row[];
  renderCard(entry: WorkEntry): JSX.Element;
  onToggleCollapsed(projectPath: string): void;
  onNewWork(projectPath: string): void;
}

/** Больше 50 карточек (спека 6.1): в DOM — только видимые строки и запас по краям. */
function VirtualList({ scrollRef, rows, renderCard, onToggleCollapsed, onNewWork }: VirtualListProps): JSX.Element {
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
  );
}
