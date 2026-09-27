/**
 * Оболочка окна (кусок 2.3, спека 4.4, 5.1, 5.9, 5.10): заголовок, сайдбар
 * работ, центр и строка статуса — рамка, которую раньше собирал `App.tsx`
 * напрямую. Центр до 2.4 — прежний `Workspace` на dockview; новый центр
 * (дерево сплитов) появится за флагом `?center=new`.
 *
 * Сюда же переехали из `App.tsx`: ручка `Workspace` (`workspaceRef`),
 * `selectWorkByNumber` (⌘1…⌘9) и подписка на меню `work-1…9` — читать снимок
 * работ и решать, какую сессию открыть, можно и здесь, и там, но `AppShell`
 * уже держит саму ручку `Workspace`, а App.tsx после этого куска — нет.
 * `CommandPalette`, `SessionPicker`, `NewWorkDialog` и `CreateRoomDialog`
 * монтируются здесь же (а не в `Sidebar`/`Workspace`) — они нужны и над
 * `Landing`, где ни сайдбара, ни `Workspace` вовсе нет.
 */

import { useEffect, useRef } from 'react';
import type { WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { LEFT_SIDEBAR } from '../../shared/ui-types.js';
import { InterruptedBanner } from '../components/InterruptedBanner.js';
import { NewWorkDialog } from '../components/dialogs/NewWorkDialog.js';
import { Workspace, type WorkspaceHandle } from '../components/layout/Workspace.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { SessionPicker, sessionCandidates } from '../components/palette/SessionPicker.js';
import { CreateRoomDialog, type RoomCandidate } from '../components/rooms/CreateRoomDialog.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { buildCommands } from '../lib/commands.js';
import { sessionRowLabel } from '../lib/participant.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { orderedWorks, useWorksStore } from '../store/works.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Landing } from './Landing.js';
import { Resizer } from './Resizer.js';
import { StatusBar } from './StatusBar.js';
import { Titlebar } from './Titlebar.js';

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

  useEffect(
    () =>
      bridge.app.onMenu((action) => {
        if (action === 'palette') setPaletteOpen(true);
        else if (action === 'new-work') openNewWorkDialog();
        else if (action === 'toggle-left-sidebar') setSidebar('left', { open: !useUiStore.getState().ui.leftSidebar.open });
        else if (action.startsWith('work-')) selectWorkByNumber(Number(action.slice('work-'.length)));
      }),
    [bridge],
  );

  const pickerEntry = picker === null ? undefined : ordered.find((entry) => workKey(entry.projectPath, entry.map.work.id) === picker.workKey);
  const pickerCandidates = picker === null || pickerEntry === undefined ? [] : sessionCandidates(pickerEntry, new Set(picker.openSessionIds));

  const commands = buildCommands({
    works: entries,
    lastSessionByWork,
    wakePaused,
    recentSessionRefs,
    actions: {
      openSession: (ref, key, title) => workspaceRef.current?.openSession(ref, key, title),
      openMail: (key) => workspaceRef.current?.openMail(key),
      openRoom: (key, roomId, title) => workspaceRef.current?.openRoom(key, roomId, title),
      closeActivePanel: () => workspaceRef.current?.closeActivePanel(),
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

  const handleOpenSession = (key: string, ref: SessionRef, session: WorkSession): void =>
    workspaceRef.current?.openSession(ref, key, sessionRowLabel(session.id, session.label));
  const handleOpenChanges = (key: string, ref: SessionRef, session: WorkSession): void =>
    workspaceRef.current?.openChanges(ref, key, sessionRowLabel(session.id, session.label));

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
                    onOpenMail={(key) => workspaceRef.current?.openMail(key)}
                    onOpenRoom={(key, roomId, title) => workspaceRef.current?.openRoom(key, roomId, title)}
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
            <Workspace ref={workspaceRef} bridge={bridge} works={entries} fontFamily={fontFamily} fontSize={fontSize} />
          </ErrorBoundary>
        </div>
      )}
      <StatusBar status={status} lastNotice={notices[0] ?? null} wakePaused={wakePaused} onToggleWake={() => void toggleWake(bridge)} />
      <CommandPalette open={paletteOpen} commands={commands} onOpenChange={setPaletteOpen} />
      <SessionPicker
        open={picker !== null}
        candidates={pickerCandidates}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
        onSelect={(sessionRef) => {
          if (picker === null) return;
          const label = sessionRowLabel(
            sessionRef.sessionId,
            pickerEntry?.map.sessions.find((session) => session.id === sessionRef.sessionId)?.label ?? '',
          );
          workspaceRef.current?.openBeside(sessionRef, picker.workKey, label, picker.direction);
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
