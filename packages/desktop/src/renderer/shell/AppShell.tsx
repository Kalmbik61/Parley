/**
 * Оболочка окна (куски 2.3–2.4, спека 4.4, 5.1, 5.3, 5.9, 5.10): заголовок,
 * сайдбар работ, центр и строка статуса — рамка, которую раньше собирал
 * `App.tsx` напрямую. Центр — прежний `Workspace` на dockview; с
 * `?center=new` (читается из `location.search` один раз при монтировании,
 * кусок 2.4) — `LayoutView` активной работы, а `Workspace` вовсе не
 * монтируется. Флаг сохранится до 2.7, когда dockview уйдёт совсем.
 *
 * Сюда же переехали из `App.tsx`: ручка `Workspace` (`workspaceRef`),
 * `selectWorkByNumber` (⌘1…⌘9) и подписка на меню `work-1…9` — читать снимок
 * работ и решать, какую сессию открыть, можно и здесь, и там, но `AppShell`
 * уже держит саму ручку `Workspace`, а App.tsx после этого куска — нет.
 * `selectWorkByNumber` пока не тронут флагом (бриф куска 2.4 не называет его
 * среди действий, которые под флагом ведут себя иначе) — под `?center=new`
 * ⌘1…⌘9 временно не переключают сессию, это донастроят более поздние куски.
 * `CommandPalette`, `SessionPicker`, `NewWorkDialog` и `CreateRoomDialog`
 * монтируются здесь же (а не в `Sidebar`/`Workspace`) — они нужны и над
 * `Landing`, где ни сайдбара, ни `Workspace` вовсе нет.
 *
 * Под флагом `AppShell` сам обслуживает часть меню (`close-panel`,
 * `reopen-tab`, `prev-panel`, `next-panel`, `split-right`, `split-down`) и
 * «открывающие» действия палитры (`openSession`/`openMail`/`openRoom`) —
 * прежний путь через `workspaceRef` для них недоступен (`Workspace` не
 * смонтирован), поэтому вместо dockview-API они зовут `setActiveWork` и
 * `apply` в `layout/store.ts` напрямую.
 *
 * Кусок 2.5 (спека 5.5): под флагом центр — контейнеры трёх последних активных
 * работ (LRU). Контейнер — `position: absolute; inset: 0`, в нём `LayoutView`
 * работы и следом её `SurfaceLayer`; контейнер — containing block поверхностей,
 * а тела групп — его потомки, поэтому `anchor()` действительны. Неактивные
 * контейнеры скрыты (`visibility: hidden`, `inert`), но смонтированы — терминалы
 * живы. Меню `find` и входы сайдбара под флагом тоже обслуживает `AppShell`.
 */

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkSession } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { noticeText, S } from '../../shared/strings.js';
import { LEFT_SIDEBAR } from '../../shared/ui-types.js';
import { InterruptedBanner } from '../components/InterruptedBanner.js';
import { NewWorkDialog } from '../components/dialogs/NewWorkDialog.js';
import { Workspace, type WorkspaceHandle } from '../components/layout/Workspace.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { SessionPicker, sessionCandidates } from '../components/palette/SessionPicker.js';
import { CreateRoomDialog, type RoomCandidate } from '../components/rooms/CreateRoomDialog.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { buildCommands } from '../lib/commands.js';
import { sessionLabelFor, sessionRowLabel } from '../lib/participant.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import { tabId } from '../layout/ids.js';
import { LayoutView } from '../layout/LayoutView.js';
import { createLru, type Lru } from '../layout/lru.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { useLayoutStore } from '../layout/store.js';
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

/** Слои поверхностей живут у трёх последних работ (план, «Числа»). */
const SURFACE_WORKS = 3;

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
 */
function WorkContainer({ workKey, active, bridge, fontFamily, fontSize }: WorkContainerProps): JSX.Element {
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
}

export interface AppShellProps {
  bridge: HarnasBridge;
  /** Строка статуса; `App` рендерит `AppShell` только при `'connected'`. */
  status: HostStatus;
  /** Из `settings.get` в `App`, до ответа — запасные; идут в центр. */
  fontFamily: string;
  fontSize: number;
}

export function AppShell({ bridge, status, fontFamily, fontSize }: AppShellProps): JSX.Element {
  const workspaceRef = useRef<WorkspaceHandle>(null);

  // Флаг нового центра — читается из `location.search` один раз при монтировании
  // (кусок 2.4): `?center=new` не появляется и не исчезает за время жизни окна,
  // `main/index.ts` ставит его в `search` при `HARNAS_DESKTOP_CENTER=new` ещё до
  // загрузки страницы.
  const [centerNew] = useState(() => new URLSearchParams(location.search).get('center') === 'new');
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);

  // LRU контейнеров работ (кусок 2.5). Касание — прямо в рендере: контейнер
  // новой активной работы должен появиться в том же кадре, что и смена
  // `activeWorkKey`, а повторное касание того же ключа безвредно.
  const lruRef = useRef<Lru<string> | null>(null);
  if (lruRef.current === null) lruRef.current = createLru<string>(SURFACE_WORKS);
  const lru = lruRef.current;
  const touchedRef = useRef<string | null>(null);
  if (centerNew && activeWorkKey !== null && touchedRef.current !== activeWorkKey) {
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
  const lastSessionByWork = useUiStore((state) => state.lastSessionByWork);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const recentSessionRefs = useUiStore((state) => state.recentSessionRefs);
  const toggleWake = useUiStore((state) => state.toggleWake);
  const notices = useNoticesStore((state) => state.notices);
  // Раунд исправлений 1 куска E.1: `notice.text` хоста — русский свободный
  // текст (сквозное правило его не переводит), строка статуса показывает
  // `noticeText` по виду уведомления вместо него; сырой текст — только в
  // консоли (`store/notices.ts`).
  const lastNotice = notices[0] ?? null;
  const noticeLine = lastNotice === null ? '' : noticeText(lastNotice, sessionLabelFor(entries, lastNotice.ref));

  const leftSidebarRef = useRef<HTMLDivElement>(null);

  // N-я по порядку создания работа и её последняя открытая сессия
  // (`store/ui.ts#lastSessionByWork`), иначе первая по дереву — тот же
  // принцип, что был у `selectWorkByNumber` в `App.tsx` (тест 13).
  const selectWorkByNumber = (n: number): void => {
    const work = orderedWorks(useWorksStore.getState().entries)[n - 1];
    if (work === undefined) return;
    const key = workKey(work.projectPath, work.map.work.id);
    const lastSessionId = useUiStore.getState().lastSessionByWork[key];
    const session =
      work.map.sessions.find((item) => lastSessionId !== undefined && item.id === lastSessionId) ??
      treeOrder(work.map.sessions)[0]?.session;
    if (session === undefined) return;
    workspaceRef.current?.openSession(
      { projectPath: work.projectPath, workId: work.map.work.id, sessionId: session.id },
      key,
      sessionRowLabel(session.id, session.label),
    );
  };

  // Под флагом `close-panel`/`reopen-tab`/`prev-panel`/`next-panel`/
  // `split-right`/`split-down` больше не обслуживает `Workspace` (тот вовсе не
  // смонтирован) — вместо dockview-API эти пять действий работают прямо через
  // `layout/store.ts` на раскладке активной работы (спека 5.3, п. «Клавиши»).
  const closeActiveTabCenterNew = (): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const activeTabId = activeGroup?.activeTabId;
    if (activeTabId !== null && activeTabId !== undefined) void useLayoutStore.getState().requestCloseTabs(key, [activeTabId]);
  };

  const focusAdjacentGroupCenterNew = (delta: 1 | -1): void => {
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

  const beginSplitCenterNew = (direction: 'right' | 'down'): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    useUiStore.getState().openPicker({ workKey: key, direction, openSessionIds: openTerminalSessionIds(layout) });
  };

  // ⌘F под флагом: полоса поиска только у видимой поверхности активной группы
  // активной работы — сами поверхности на меню не подписаны (их смонтировано
  // много, и полоса открылась бы во всех, включая скрытые).
  const openSearchCenterNew = (): void => {
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
        else if (!centerNew) return;
        else if (action === 'close-panel') closeActiveTabCenterNew();
        else if (action === 'reopen-tab') {
          const key = useLayoutStore.getState().activeWorkKey;
          if (key !== null) useLayoutStore.getState().apply(key, reopenClosed);
        } else if (action === 'prev-panel') focusAdjacentGroupCenterNew(-1);
        else if (action === 'next-panel') focusAdjacentGroupCenterNew(1);
        else if (action === 'split-right') beginSplitCenterNew('right');
        else if (action === 'split-down') beginSplitCenterNew('down');
        else if (action === 'find') openSearchCenterNew();
      }),
    [bridge, centerNew],
  );

  const pickerEntry = picker === null ? undefined : ordered.find((entry) => workKey(entry.projectPath, entry.map.work.id) === picker.workKey);
  const pickerCandidates = picker === null || pickerEntry === undefined ? [] : sessionCandidates(pickerEntry, new Set(picker.openSessionIds));

  // Открывающие действия палитры под флагом: сессия/почта/комната могут
  // принадлежать НЕ активной сейчас работе (в отличие от общей сетки dockview,
  // у каждой работы теперь своя раскладка) — сначала переключить работу, потом
  // открыть вкладку в НЕЙ (бриф куска 2.4, «действия палитры "открыть"»).
  const openTabCenterNew = (key: string, tab: TabSpec): void => {
    useLayoutStore.getState().setActiveWork(key);
    useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
  };

  const commands = buildCommands({
    works: entries,
    lastSessionByWork,
    wakePaused,
    recentSessionRefs,
    actions: {
      openSession: (ref, key, title) =>
        centerNew
          ? openTabCenterNew(key, { kind: 'terminal', id: tabId.terminal(ref.sessionId), sessionId: ref.sessionId })
          : workspaceRef.current?.openSession(ref, key, title),
      openMail: (key) => (centerNew ? openTabCenterNew(key, { kind: 'mail', id: tabId.mail() }) : workspaceRef.current?.openMail(key)),
      openRoom: (key, roomId, title) =>
        centerNew
          ? openTabCenterNew(key, { kind: 'room', id: tabId.room(roomId), roomId })
          : workspaceRef.current?.openRoom(key, roomId, title),
      closeActivePanel: () => (centerNew ? closeActiveTabCenterNew() : workspaceRef.current?.closeActivePanel()),
      newSession: () => {
        const state = useUiStore.getState();
        state.openNewSessionDialog(state.selectedRef?.sessionId ?? null);
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

  // Входы сайдбара под флагом (кусок 2.5): сначала работа, по которой
  // кликнули, становится активной (id `mail` общий на раскладку), затем вкладка
  // открывается в её раскладке.
  const handleOpenSession = (key: string, ref: SessionRef, session: WorkSession): void =>
    centerNew
      ? openTabCenterNew(key, { kind: 'terminal', id: tabId.terminal(ref.sessionId), sessionId: ref.sessionId })
      : workspaceRef.current?.openSession(ref, key, sessionRowLabel(session.id, session.label));
  const handleOpenChanges = (key: string, ref: SessionRef, session: WorkSession): void =>
    centerNew
      ? openTabCenterNew(key, { kind: 'diff', id: tabId.diff(ref.sessionId, null), sessionId: ref.sessionId, commit: null })
      : workspaceRef.current?.openChanges(ref, key, sessionRowLabel(session.id, session.label));
  const handleOpenMail = (key: string): void =>
    centerNew ? openTabCenterNew(key, { kind: 'mail', id: tabId.mail() }) : workspaceRef.current?.openMail(key);
  const handleOpenRoom = (key: string, roomId: string, title: string): void =>
    centerNew
      ? openTabCenterNew(key, { kind: 'room', id: tabId.room(roomId), roomId })
      : workspaceRef.current?.openRoom(key, roomId, title);

  return (
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
                  <Sidebar
                    bridge={bridge}
                    onOpenSession={handleOpenSession}
                    onOpenMail={handleOpenMail}
                    onOpenRoom={handleOpenRoom}
                    onOpenChanges={handleOpenChanges}
                  />
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
            {centerNew ? (
              // Активной работы ещё нет (`layout/persistence.ts` её не выбрал) —
              // LRU пуст, центр пуст: ни групп, ни строки вкладок в
              // `#titlebar-tabs` (спека 5.3, тест 15). Контейнеры — в порядке
              // ключей, а не LRU: смена активной работы не должна переставлять
              // узлы DOM с живыми xterm.
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
            ) : (
              <Workspace ref={workspaceRef} bridge={bridge} works={entries} fontFamily={fontFamily} fontSize={fontSize} />
            )}
          </ErrorBoundary>
        </div>
      )}
      <StatusBar status={status} noticeLine={noticeLine} wakePaused={wakePaused} onToggleWake={() => void toggleWake(bridge)} />
      <CommandPalette open={paletteOpen} commands={commands} onOpenChange={setPaletteOpen} />
      <SessionPicker
        open={picker !== null}
        candidates={pickerCandidates}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
        onSelect={(sessionRef) => {
          if (picker === null) return;
          if (centerNew) {
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
          } else {
            const label = sessionRowLabel(
              sessionRef.sessionId,
              pickerEntry?.map.sessions.find((session) => session.id === sessionRef.sessionId)?.label ?? '',
            );
            workspaceRef.current?.openBeside(sessionRef, picker.workKey, label, picker.direction);
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
}
