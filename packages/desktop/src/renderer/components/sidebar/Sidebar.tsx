/**
 * Сайдбар: список работ слева, дерево сессий каждой — навигация мышью по
 * работам и сессиям (кусок 1.10 плана окна). С куска 2.1 строка сессии не
 * держит собственную панель — «выбрать» и «открыть» одинаково просят
 * `Workspace` сфокусировать существующую панель или завести новую вкладку.
 *
 * «+ работа» и «Создать комнату с…» (кусок 3.6) с куска 2.3 открывают свои
 * диалоги через `store/ui.ts`, а не монтируют их сами: `NewWorkDialog` и
 * `CreateRoomDialog` теперь общие для всей оболочки (`shell/AppShell.tsx`) —
 * им нужно жить и над `Landing`, где сайдбар вовсе не смонтирован.
 */

import type { Room, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { sessionRowLabel } from '../../lib/participant.js';
import { workKey } from '../../lib/tree-order.js';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { useActivityStore } from '../../store/activity.js';
import { useUiStore } from '../../store/ui.js';
import { orderedWorks, useWorksStore } from '../../store/works.js';
import { WorkList } from './WorkList.js';

export interface SidebarProps {
  bridge: HarnasBridge;
  /** Клик по строке или «Открыть» в меню сессии — `Workspace.openSession` через `App.tsx`. */
  onOpenSession: (workKey: string, ref: SessionRef, session: WorkSession) => void;
  /** Клик по строке «вся почта работы» — `Workspace.openMail` через `App.tsx` (кусок 2.4). */
  onOpenMail: (workKey: string) => void;
  /** Клик по строке комнаты — `Workspace.openRoom` через `App.tsx` (кусок 3.6). */
  onOpenRoom: (workKey: string, roomId: string, title: string) => void;
  /** «Изменения» из меню сессии — `Workspace.openChanges` через `App.tsx` (кусок 4.3). */
  onOpenChanges: (workKey: string, ref: SessionRef, session: WorkSession) => void;
}

export function Sidebar({ bridge, onOpenSession, onOpenMail, onOpenRoom, onOpenChanges }: SidebarProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const branches = useWorksStore((state) => state.branches);
  const activityByRef = useActivityStore((state) => state.byRef);

  const selectedWorkKey = useUiStore((state) => state.selectedWorkKey);
  const selectedRef = useUiStore((state) => state.selectedRef);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const openCreateRoomDialog = useUiStore((state) => state.openCreateRoomDialog);

  const ordered = orderedWorks(entries);

  // «Открыть» и клик по строке — одно и то же: обе просят `Workspace`
  // сфокусировать панель сессии или завести новую вкладку (кусок 2.1).
  // Подсветка строки сама обновится по факту (`onDidActivePanelChange` в
  // `Workspace` пишет `selectedRef`/`selectedWorkKey` в этот же стор).
  const handleOpen = (key: string, ref: SessionRef, session: WorkSession): void => onOpenSession(key, ref, session);
  const handleResume = (ref: SessionRef): void => {
    bridge.call('sessions.resume', { ref }).catch(() => {});
  };
  const handleStop = (ref: SessionRef): void => {
    bridge.call('sessions.stop', { ref }).catch(() => {});
  };
  const handleClose = (ref: SessionRef): void => {
    bridge.call('sessions.close', { ref }).catch(() => {});
  };
  const handleDelete = (ref: SessionRef): void => {
    bridge.call('sessions.delete', { ref }).catch(() => {});
  };
  const handleOpenRoom = (key: string, room: Room): void => onOpenRoom(key, room.id, room.title);
  const handleOpenChanges = (key: string, ref: SessionRef, session: WorkSession): void => onOpenChanges(key, ref, session);

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-work-sidebar">
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
        <span className="text-xs font-medium text-work-sidebar-foreground">Работы</span>
        <button
          type="button"
          onClick={openNewWorkDialog}
          className="rounded px-2 py-1 text-xs text-work-sidebar-foreground hover:bg-work-sidebar-accent"
        >
          + работа
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {ordered.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">Работ пока нет</p>
        ) : (
          <WorkList
            entries={ordered}
            branches={branches}
            selectedWorkKey={selectedWorkKey}
            selectedSessionId={selectedRef?.sessionId ?? null}
            activityByRef={activityByRef}
            onSelectSession={(key, ref, session) => handleOpen(key, ref, session)}
            onOpen={(ref, session) => handleOpen(workKey(ref.projectPath, ref.workId), ref, session)}
            onResume={(ref) => handleResume(ref)}
            onStop={(ref) => handleStop(ref)}
            onClose={(ref) => handleClose(ref)}
            onDelete={(ref) => handleDelete(ref)}
            onCreateRoom={(ref, session) =>
              openCreateRoomDialog({
                projectPath: ref.projectPath,
                workId: ref.workId,
                requiredMember: { id: ref.sessionId, label: sessionRowLabel(session.id, session.label) },
              })
            }
            onOpenMail={onOpenMail}
            onOpenRoom={handleOpenRoom}
            onOpenChanges={(ref, session) => handleOpenChanges(workKey(ref.projectPath, ref.workId), ref, session)}
          />
        )}
      </div>
    </div>
  );
}
