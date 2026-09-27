/**
 * Оболочка окна (куски 2.3–2.7, спека 4.4, 5.1, 5.3, 5.6, 5.9, 5.10):
 * заголовок, сайдбар работ, центр и строка статуса. Центр — раскладка
 * активной работы (`LayoutView`); с куска 2.7 он единственный: прежний центр и
 * его флаг ушли.
 *
 * `CommandPalette`, `SessionPicker`, `NewWorkDialog` и `CreateRoomDialog`
 * монтируются здесь же (а не в `Sidebar`) — они нужны и над `Landing`, где
 * сайдбара вовсе нет.
 *
 * `AppShell` обслуживает меню раскладки (`close-panel`, `reopen-tab`,
 * `prev-panel`, `next-panel`, `split-right`, `split-down`, `find`,
 * `history-back`, `history-forward`, `work-1…9`), входы сайдбара и
 * «открывающие» действия палитры: все они идут в `layout/store.ts`. Сессия,
 * почта или комната могут принадлежать не активной сейчас работе — сначала
 * `setActiveWork`, потом `apply` в её раскладке.
 *
 * Кусок 2.5 (спека 5.5): центр — контейнеры трёх последних активных
 * работ (LRU). Контейнер — `position: absolute; inset: 0`, в нём `LayoutView`
 * работы и следом её `SurfaceLayer`; контейнер — containing block поверхностей,
 * а тела групп — его потомки, поэтому `anchor()` действительны. Неактивные
 * контейнеры скрыты (`visibility: hidden`, `inert`), но смонтированы — терминалы
 * живы.
 *
 * Кусок 3.3 (спека 6.1–6.4): слева — сайдбар карточек `WorkSidebar`. Секции и
 * внимание для него (и для ⌘1–9, строки статуса в 3.4) считает `useSidebarSectionsSync`
 * здесь, а не в сайдбаре: ⌘B прячет сайдбар, а порядок должен жить. Прежний `Sidebar`
 * доступен до 3.5 за флагом `?sidebar=old` (`HARNAS_DESKTOP_SIDEBAR=old` в main) — для
 * сравнения.
 *
 * Кусок 2.6 (спека 5.4): один `DndContext` на всё окно — строка сессии живёт
 * в сайдбаре, строка вкладок одной группы — в заголовке, зоны броска — в
 * центре, а `useDraggable` вне провайдера молча не тащит. `PointerSensor` — с
 * порогом 4 px: без него @dnd-kit начинает перетаскивание уже на
 * `pointerdown` и глушит следующий `click`, и строка сессии перестала бы
 * открываться по клику, а крестик — закрывать вкладку.
 */

import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { noticeText, S } from '../../shared/strings.js';
import { LEFT_SIDEBAR } from '../../shared/ui-types.js';
import { InterruptedBanner } from '../components/InterruptedBanner.js';
import { NewWorkDialog } from '../components/dialogs/NewWorkDialog.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { SessionPicker, sessionCandidates } from '../components/palette/SessionPicker.js';
import { CreateRoomDialog, type RoomCandidate } from '../components/rooms/CreateRoomDialog.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { useSidebarSectionsSync } from '../sidebar/use-sidebar-sections.js';
import { WorkSidebar } from '../sidebar/WorkSidebar.js';
import { buildCommands, recentSessionsFromHistory } from '../lib/commands.js';
import { sessionLabelFor, sessionRowLabel } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { applyDrop, centerOverlayOnCursor, dragItemOf, dropFromDragEnd, layoutCollision, onTerminalDrop, type DragItem } from '../layout/dnd.js';
import { setDropPreview } from '../layout/DropIndicator.js';
import { tabId } from '../layout/ids.js';
import { tabMeta } from '../layout/tab-meta.js';
import { LayoutView } from '../layout/LayoutView.js';
import { createLru, type Lru } from '../layout/lru.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { focusGroup, groups, openTab, openTerminalSessionIds, reopenClosed, splitGroup, type GroupSizes } from '../layout/tree.js';
import { terminalSurfaces } from '../terminal/TerminalSurface.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { orderedWorks, useWorksStore } from '../store/works.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Landing } from './Landing.js';
import { Resizer } from './Resizer.js';
import { StatusBar } from './StatusBar.js';
import { Titlebar } from './Titlebar.js';

/**
 * Пиксельные размеры всех групп текущей раскладки — `GroupView.tsx` метит
 * каждую `data-group-id` (кусок 2.4). Нужны `splitGroup`/`moveTab` для отказа
 * «слишком мало места» (спека 5.2, «Числа»: минимум 240×160): в jsdom
 * (компонентные тесты) `getBoundingClientRect` без подмены дал бы одни нули.
 */
function measureGroupSizes(): GroupSizes {
  const sizes: GroupSizes = {};
  for (const element of document.querySelectorAll<HTMLElement>('[data-group-id]')) {
    const id = element.dataset.groupId;
    if (id === undefined) continue;
    const rect = element.getBoundingClientRect();
    sizes[id] = { width: rect.width, height: rect.height };
  }
  return sizes;
}

/**
 * Ярлык предмета в `DragOverlay`: заголовок вкладки или строка сессии активной
 * работы — тот же текст, что человек видел под курсором.
 */
function dragLabel(item: DragItem, key: string | null): string {
  const entry = useWorksStore.getState().entries.find((candidate) => workKey(candidate.projectPath, candidate.map.work.id) === key);
  if (item.kind === 'session') {
    const session = entry?.map.sessions.find((candidate) => candidate.id === item.sessionId);
    return sessionRowLabel(item.sessionId, session?.label ?? '');
  }
  const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
  const tab = layout === undefined ? undefined : groups(layout).flatMap((group) => group.tabs).find((candidate) => candidate.id === item.tabId);
  return tab === undefined ? item.tabId : tabMeta(tab, entry ?? null).title;
}

/** Слои поверхностей живут у трёх последних работ (план, «Числа»). */
const SURFACE_WORKS = 3;

/** Модификаторы оверлея — одна ссылка на всё время жизни окна. */
const OVERLAY_MODIFIERS = [centerOverlayOnCursor];

interface WorkContainerProps {
  workKey: string;
  active: boolean;
  bridge: HarnasBridge;
  fontFamily: string;
  fontSize: number;
}

/**
 * Контейнер одной работы LRU (кусок 2.5). Пока раскладки работы нет в
 * `layouts` (до `hydrate` после `setActiveWork`), контейнер пуст: ни
 * `LayoutView`, ни `SurfaceLayer`.
 *
 * `memo` (раунд исправлений 1 куска 2.6, ревью A): пропы — ключ, флаг, мост и
 * шрифт, стабильны; начало и конец перетаскивания (`dragging` в `AppShell`)
 * иначе перерисовывали бы все тела групп и поверхности трёх работ.
 */
const WorkContainer = memo(function WorkContainer({ workKey, active, bridge, fontFamily, fontSize }: WorkContainerProps): JSX.Element {
  const hasLayout = useLayoutStore((state) => state.layouts[workKey] !== undefined);
  const ref = useRef<HTMLDivElement>(null);
  // `inert` в React 18 — не булев проп, ставится руками.
  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !active);
  }, [active]);
  return (
    <div
      ref={ref}
      data-work-container={workKey}
      className="absolute inset-0 flex"
      style={active ? undefined : { visibility: 'hidden' }}
    >
      {hasLayout ? (
        <>
          <LayoutView workKey={workKey} active={active} bridge={bridge} fontFamily={fontFamily} fontSize={fontSize} />
          <SurfaceLayer workKey={workKey} active={active} bridge={bridge} fontFamily={fontFamily} fontSize={fontSize} />
        </>
      ) : null}
    </div>
  );
});

export interface AppShellProps {
  bridge: HarnasBridge;
  /** Строка статуса; `App` рендерит `AppShell` только при `'connected'`. */
  status: HostStatus;
  /** Из `settings.get` в `App`, до ответа — запасные; идут в центр. */
  fontFamily: string;
  fontSize: number;
}

export function AppShell({ bridge, status, fontFamily, fontSize }: AppShellProps): JSX.Element {
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  // Флаг прежнего сайдбара читается один раз: `main/index.ts` ставит его в `search` до
  // загрузки окна, за время жизни окна он не меняется.
  const [oldSidebar] = useState(() => new URLSearchParams(location.search).get('sidebar') === 'old');
  // Единственный писатель порядка сайдбара — живёт и при свёрнутом сайдбаре. Возврат
  // (видимый порядок этого рендера) понадобится ⌘1–9 в 3.4.
  useSidebarSectionsSync();

  // LRU контейнеров работ (кусок 2.5). Касание — прямо в рендере: контейнер
  // новой активной работы должен появиться в том же кадре, что и смена
  // `activeWorkKey`, а повторное касание того же ключа безвредно.
  const lruRef = useRef<Lru<string> | null>(null);
  if (lruRef.current === null) lruRef.current = createLru<string>(SURFACE_WORKS);
  const lru = lruRef.current;
  const touchedRef = useRef<string | null>(null);
  if (activeWorkKey !== null && touchedRef.current !== activeWorkKey) {
    lru.touch(activeWorkKey);
    touchedRef.current = activeWorkKey;
  }
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // `drop` (работа пропала из снимка) убирает работу и из LRU — её контейнер
  // размонтируется, xterm освобождаются. Раскладка исчезает из `layouts`
  // только в `drop`.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, prev) => {
        let changed = false;
        for (const key of Object.keys(prev.layouts)) {
          if (key in state.layouts || !lru.has(key)) continue;
          lru.remove(key);
          if (touchedRef.current === key) touchedRef.current = null;
          changed = true;
        }
        if (changed) rerender();
      }),
    [lru],
  );

  const entries = useWorksStore((state) => state.entries);
  const loading = useWorksStore((state) => state.loading);
  const worksLoaded = !loading;
  const ordered = orderedWorks(entries);
  const order = ordered.map((entry) => workKey(entry.projectPath, entry.map.work.id));
  // «Работ нет» — это ответ хоста, а не просто пустой начальный снимок:
  // до первого `works.list` показывать `Landing` рано (спека 5.10, «после загрузки»).
  const showLanding = worksLoaded && entries.length === 0;

  useLayoutPersistence({ bridge, works: entries, worksLoaded, order });

  const ui = useUiStore((state) => state.ui);
  const setSidebar = useUiStore((state) => state.setSidebar);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const picker = useUiStore((state) => state.picker);
  const closePicker = useUiStore((state) => state.closePicker);
  const newWorkOpen = useUiStore((state) => state.dialogs.newWork);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const closeNewWorkDialog = useUiStore((state) => state.closeNewWorkDialog);
  const createRoom = useUiStore((state) => state.dialogs.createRoom);
  const closeCreateRoomDialog = useUiStore((state) => state.closeCreateRoomDialog);
  const wakePaused = useUiStore((state) => state.wakePaused);
  // Недавние сессии палитры — из истории переходов (кусок 2.7); подписка на
  // `history`, чтобы список обновлялся вместе с ней.
  const history = useLayoutStore((state) => state.history);
  const recentSessionRefs = recentSessionsFromHistory(history.entries, entries);
  const toggleWake = useUiStore((state) => state.toggleWake);
  const notices = useNoticesStore((state) => state.notices);
  // Раунд исправлений 1 куска E.1: `notice.text` хоста — русский свободный
  // текст (сквозное правило его не переводит), строка статуса показывает
  // `noticeText` по виду уведомления вместо него; сырой текст — только в
  // консоли (`store/notices.ts`).
  const lastNotice = notices[0] ?? null;
  const noticeLine = lastNotice === null ? '' : noticeText(lastNotice, sessionLabelFor(entries, lastNotice.ref));

  const leftSidebarRef = useRef<HTMLDivElement>(null);

  // Перетаскивание (кусок 2.6). `dragging` — ярлык в `DragOverlay`. Где сейчас
  // бросок, индикаторам сообщает `setDropPreview` — не состояние `AppShell`:
  // иначе каждая смена зоны перерисовывала бы всё окно (раунд исправлений 1).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [dragging, setDragging] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent): void => {
    const item = dragItemOf(event.active.data.current);
    setDragging(item === null ? null : dragLabel(item, useLayoutStore.getState().activeWorkKey));
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    const zone = dropFromDragEnd(event)?.zone ?? null;
    setDropPreview(useLayoutStore.getState().activeWorkKey, zone);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    setDragging(null);
    setDropPreview(null, null);
    const drop = dropFromDragEnd(event);
    const key = useLayoutStore.getState().activeWorkKey;
    if (drop === null || key === null) return;
    // Зона чужой работы сюда не доходит (`layoutCollision`), но раскладку
    // меняем только у той работы, чья зона под указателем.
    const owner = (event.over?.data.current as { workKey?: unknown } | undefined)?.workKey;
    if (owner !== key) return;
    const { item, zone } = drop;
    if (zone.kind === 'terminal') {
      onTerminalDrop(item, zone.sessionId);
      return;
    }
    const error = useLayoutStore.getState().apply(key, (layout) => applyDrop(layout, item, zone, measureGroupSizes()));
    if (error === 'too-many-groups') toast(S.tabs.tooManyGroups);
    else if (error === 'too-small') toast(S.tabs.tooSmall);
  };

  const handleDragCancel = (): void => {
    setDragging(null);
    setDropPreview(null, null);
  };

  // ⌘1…⌘9 — N-я по порядку создания работа становится активной и открывается
  // своей раскладкой (кусок 2.7); порядок сайдбара придёт в 3.4.
  const selectWorkByNumber = (n: number): void => {
    const work = orderedWorks(useWorksStore.getState().entries)[n - 1];
    if (work === undefined) return;
    useLayoutStore.getState().setActiveWork(workKey(work.projectPath, work.map.work.id));
  };

  // Меню раскладки работает прямо через `layout/store.ts` на раскладке
  // активной работы (спека 5.3, п. «Клавиши»).
  const closeActiveTab = (): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const activeTabId = activeGroup?.activeTabId;
    if (activeTabId !== null && activeTabId !== undefined) void useLayoutStore.getState().requestCloseTabs(key, [activeTabId]);
  };

  const focusAdjacentGroup = (delta: 1 | -1): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const all = groups(layout);
    if (all.length === 0) return;
    const index = all.findIndex((group) => group.id === layout.activeGroupId);
    const nextIndex = (((index === -1 ? 0 : index + delta) % all.length) + all.length) % all.length;
    const target = all[nextIndex];
    if (target !== undefined) useLayoutStore.getState().apply(key, (l) => focusGroup(l, target.id));
  };

  const beginSplit = (direction: 'right' | 'down'): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    useUiStore.getState().openPicker({ workKey: key, direction, openSessionIds: openTerminalSessionIds(layout) });
  };

  // ⌘F: полоса поиска только у видимой поверхности активной группы
  // активной работы — сами поверхности на меню не подписаны (их смонтировано
  // много, и полоса открылась бы во всех, включая скрытые).
  const openSearch = (): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const tab = activeGroup?.tabs.find((candidate) => candidate.id === activeGroup.activeTabId);
    if (tab?.kind !== 'terminal') return;
    const entry = useWorksStore.getState().entries.find((item) => workKey(item.projectPath, item.map.work.id) === key);
    if (entry === undefined) return;
    terminalSurfaces.get(refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId }))?.openSearch();
  };

  useEffect(
    () =>
      bridge.app.onMenu((action) => {
        if (action === 'palette') setPaletteOpen(true);
        else if (action === 'new-work') openNewWorkDialog();
        else if (action === 'toggle-left-sidebar') setSidebar('left', { open: !useUiStore.getState().ui.leftSidebar.open });
        else if (action.startsWith('work-')) selectWorkByNumber(Number(action.slice('work-'.length)));
        else if (action === 'close-panel') closeActiveTab();
        else if (action === 'reopen-tab') {
          const key = useLayoutStore.getState().activeWorkKey;
          if (key !== null) useLayoutStore.getState().apply(key, reopenClosed);
        } else if (action === 'prev-panel') focusAdjacentGroup(-1);
        else if (action === 'next-panel') focusAdjacentGroup(1);
        else if (action === 'split-right') beginSplit('right');
        else if (action === 'split-down') beginSplit('down');
        else if (action === 'find') openSearch();
        else if (action === 'history-back') useLayoutStore.getState().back();
        else if (action === 'history-forward') useLayoutStore.getState().forward();
      }),
    [bridge],
  );

  const pickerEntry = picker === null ? undefined : ordered.find((entry) => workKey(entry.projectPath, entry.map.work.id) === picker.workKey);
  const pickerCandidates = picker === null || pickerEntry === undefined ? [] : sessionCandidates(pickerEntry, new Set(picker.openSessionIds));

  // Открывающие действия палитры и сайдбара: сессия/почта/комната могут
  // принадлежать НЕ активной сейчас работе (у каждой работы своя раскладка) —
  // сначала переключить работу, потом открыть вкладку в НЕЙ.
  const openTabInWork = (key: string, tab: TabSpec): void => {
    useLayoutStore.getState().setActiveWork(key);
    useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
  };

  const commands = buildCommands({
    works: entries,
    wakePaused,
    recentSessionRefs,
    actions: {
      openWork: (key) => useLayoutStore.getState().setActiveWork(key),
      openSession: (ref, key) => openTabInWork(key, { kind: 'terminal', id: tabId.terminal(ref.sessionId), sessionId: ref.sessionId }),
      openMail: (key) => openTabInWork(key, { kind: 'mail', id: tabId.mail() }),
      openRoom: (key, roomId) => openTabInWork(key, { kind: 'room', id: tabId.room(roomId), roomId }),
      closeActivePanel: closeActiveTab,
      newSession: () => {
        const selected = selectedSessionOf(useLayoutStore.getState(), useWorksStore.getState().entries);
        useUiStore.getState().openNewSessionDialog(selected?.ref.sessionId ?? null);
      },
      newWork: () => useUiStore.getState().openNewWorkDialog(),
      settings: () => useUiStore.getState().openSettingsDialog(),
      toggleWake: () => void toggleWake(bridge),
    },
  });

  // Кандидаты «Создать комнату с…» — остальные сессии той же работы, кроме
  // обязательного участника (сессии, с которой открыли пункт меню в сайдбаре).
  const roomCandidates: RoomCandidate[] =
    createRoom === null
      ? []
      : (entries
          .find((item) => item.projectPath === createRoom.projectPath && item.map.work.id === createRoom.workId)
          ?.map.sessions.filter((session) => session.id !== createRoom.requiredMember.id)
          .map((session) => ({
            id: session.id,
            label: sessionRowLabel(session.id, session.label),
            closed: session.lifecycle === 'closed',
          })) ?? []);

  // Входы сайдбара (кусок 2.5): сначала работа, по которой кликнули,
  // становится активной (id `mail` общий на раскладку), затем вкладка
  // открывается в её раскладке.
  const handleOpenSession = (key: string, ref: SessionRef): void =>
    openTabInWork(key, { kind: 'terminal', id: tabId.terminal(ref.sessionId), sessionId: ref.sessionId });
  const handleOpenChanges = (key: string, ref: SessionRef): void =>
    openTabInWork(key, { kind: 'diff', id: tabId.diff(ref.sessionId, null), sessionId: ref.sessionId, commit: null });
  const handleOpenMail = (key: string): void => openTabInWork(key, { kind: 'mail', id: tabId.mail() });
  const handleOpenRoom = (key: string, roomId: string): void => openTabInWork(key, { kind: 'room', id: tabId.room(roomId), roomId });

  const shell = (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Titlebar bridge={bridge} />
      <InterruptedBanner bridge={bridge} />
      {showLanding ? (
        <Landing />
      ) : (
        <div data-testid="app-shell" className="flex min-h-0 flex-1">
          {ui.leftSidebar.open ? (
            <>
              <div ref={leftSidebarRef} style={{ width: ui.leftSidebar.width }} className="h-full shrink-0 overflow-hidden">
                <ErrorBoundary title={S.shell.sidebarError}>
                  {oldSidebar ? (
                    <Sidebar
                      bridge={bridge}
                      onOpenSession={handleOpenSession}
                      onOpenMail={handleOpenMail}
                      onOpenRoom={handleOpenRoom}
                      onOpenChanges={handleOpenChanges}
                    />
                  ) : (
                    <WorkSidebar
                      onActivateWork={(key) => useLayoutStore.getState().setActiveWork(key)}
                      onOpenSession={(key, sessionId) =>
                        openTabInWork(key, { kind: 'terminal', id: tabId.terminal(sessionId), sessionId })
                      }
                      onOpenMail={handleOpenMail}
                    />
                  )}
                </ErrorBoundary>
              </div>
              <Resizer
                side="left"
                width={ui.leftSidebar.width}
                min={LEFT_SIDEBAR.min}
                max={LEFT_SIDEBAR.max}
                target={leftSidebarRef}
                onCommit={(width) => setSidebar('left', { width })}
              />
            </>
          ) : null}
          <ErrorBoundary title={S.shell.layoutError}>
            {/* Активной работы ещё нет (`layout/persistence.ts` её не выбрал) —
                LRU пуст, центр пуст: ни групп, ни строки вкладок в
                `#titlebar-tabs` (спека 5.3, тест 15). Контейнеры — в порядке
                ключей, а не LRU: смена активной работы не должна переставлять
                узлы DOM с живыми xterm. */}
            <div className="relative min-h-0 min-w-0 flex-1">
              {lru
                .keys()
                .sort()
                .map((key) => (
                  <WorkContainer
                    key={key}
                    workKey={key}
                    active={key === activeWorkKey}
                    bridge={bridge}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                  />
                ))}
            </div>
          </ErrorBoundary>
        </div>
      )}
      <StatusBar
        status={status}
        noticeLine={noticeLine}
        wakePaused={wakePaused}
        onToggleWake={() => void toggleWake(bridge)}
        onRestartHost={() => void bridge.app.restartHost()}
      />
      <CommandPalette open={paletteOpen} commands={commands} onOpenChange={setPaletteOpen} />
      <SessionPicker
        open={picker !== null}
        candidates={pickerCandidates}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
        onSelect={(sessionRef) => {
          if (picker === null) return;
          const layout = useLayoutStore.getState().layouts[picker.workKey];
          if (layout !== undefined) {
            const tab: TabSpec = { kind: 'terminal', id: tabId.terminal(sessionRef.sessionId), sessionId: sessionRef.sessionId };
            const direction = picker.direction === 'right' ? 'row' : 'column';
            const error = useLayoutStore
              .getState()
              .apply(picker.workKey, (l) => splitGroup(l, layout.activeGroupId, direction, tab, measureGroupSizes()));
            if (error === 'too-many-groups') toast(S.tabs.tooManyGroups);
            else if (error === 'too-small') toast(S.tabs.tooSmall);
          }
          closePicker();
        }}
      />
      <NewWorkDialog
        open={newWorkOpen}
        bridge={bridge}
        onOpenChange={(open) => (open ? openNewWorkDialog() : closeNewWorkDialog())}
      />
      {createRoom !== null ? (
        <CreateRoomDialog
          open
          bridge={bridge}
          projectPath={createRoom.projectPath}
          workId={createRoom.workId}
          requiredMember={createRoom.requiredMember}
          candidates={roomCandidates}
          onOpenChange={(open) => {
            if (!open) closeCreateRoomDialog();
          }}
        />
      ) : null}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={layoutCollision(activeWorkKey)}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {shell}
      {/* Обёртка оверлея — размером с источник, её центр модификатор ставит
          под указатель; ярлык — по центру обёртки (раунд исправлений 1, ревью B). */}
      <DragOverlay dropAnimation={null} modifiers={OVERLAY_MODIFIERS}>
        {dragging === null ? null : (
          <div className="flex h-full w-full items-center justify-center">
            <div
              data-drag-overlay
              className="inline-flex h-7 max-w-60 shrink-0 items-center truncate rounded border border-border bg-popover px-2 text-xs text-popover-foreground shadow"
            >
              {dragging}
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
