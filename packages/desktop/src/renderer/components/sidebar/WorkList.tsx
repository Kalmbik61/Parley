/** Список работ: номер 1…9 по порядку создания, заголовок, хвост пути, ветка, точка работы. */

import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { displayStatus, dotState, maxDotState } from '../../lib/dot-state.js';
import { treeOrder, workKey } from '../../lib/tree-order.js';
import type { ActivityEntry } from '../../store/activity.js';
import { activityFor } from '../../store/activity.js';
import { SessionTree } from './SessionTree.js';
import { StatusDot } from './StatusDot.js';

/** Хвост пути проекта — колонка сайдбара узкая, полный путь туда не влезает. */
function pathTail(projectPath: string): string {
  const segments = projectPath.split('/').filter((part) => part !== '');
  if (segments.length <= 2) return projectPath;
  return `…/${segments.slice(-2).join('/')}`;
}

export interface WorkListProps {
  /** Уже отсортированы по времени создания — `store/works.ts#orderedWorks`. */
  entries: readonly WorkEntry[];
  branches: Record<string, string | null>;
  selectedWorkKey: string | null;
  selectedSessionId: string | null;
  activityByRef: Record<string, ActivityEntry>;
  onSelectSession: (workKey: string, ref: SessionRef, session: WorkSession) => void;
  onOpen: (ref: SessionRef, session: WorkSession) => void;
  onResume: (ref: SessionRef, session: WorkSession) => void;
  onStop: (ref: SessionRef, session: WorkSession) => void;
  onClose: (ref: SessionRef, session: WorkSession) => void;
  onDelete: (ref: SessionRef, session: WorkSession) => void;
  /** «Создать комнату с…» (кусок 3.6) — сессия, с которой открыли пункт меню. */
  onCreateRoom: (ref: SessionRef, session: WorkSession) => void;
  /** «Вся почта работы» (кусок 2.4) — `Workspace.tsx#openMail` через `App.tsx`. */
  onOpenMail: (workKey: string) => void;
  /** Строка комнаты (кусок 3.6) — `Workspace.tsx#openRoom` через `App.tsx`. */
  onOpenRoom: (workKey: string, room: Room) => void;
  /** «Изменения» из меню сессии (кусок 4.3) — `Workspace.tsx#openChanges` через `App.tsx`. */
  onOpenChanges: (ref: SessionRef, session: WorkSession) => void;
}

export function WorkList({
  entries,
  branches,
  selectedWorkKey,
  selectedSessionId,
  activityByRef,
  onSelectSession,
  onOpen,
  onResume,
  onStop,
  onClose,
  onDelete,
  onCreateRoom,
  onOpenMail,
  onOpenRoom,
  onOpenChanges,
}: WorkListProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry, index) => {
        const key = workKey(entry.projectPath, entry.map.work.id);
        const branch = branches[entry.projectPath] ?? null;
        const states = treeOrder(entry.map.sessions).map(({ session }) => {
          const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
          const activity = activityFor(activityByRef, ref)?.activity.activity ?? null;
          return dotState(displayStatus(session), activity);
        });
        const workDot = maxDotState(states);

        return (
          <div key={key} data-work-key={key}>
            <div className="flex min-w-0 items-center gap-2 px-2 py-1">
              <span className="w-4 shrink-0 text-right text-xs text-[var(--h-muted)]">{index < 9 ? index + 1 : ''}</span>
              {workDot !== null ? <StatusDot state={workDot} /> : <span className="h-2 w-2 shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--h-text)]">{entry.map.work.title}</span>
            </div>
            <div className="truncate px-2 pb-1 pl-8 text-xs text-[var(--h-muted)]">
              {pathTail(entry.projectPath)}
              {branch !== null ? ` · ${branch}` : ''}
            </div>
            <SessionTree
              projectPath={entry.projectPath}
              workId={entry.map.work.id}
              sessions={entry.map.sessions}
              rooms={entry.map.rooms}
              selectedSessionId={selectedWorkKey === key ? selectedSessionId : null}
              activityByRef={activityByRef}
              hasMail={entry.map.messages.length > 0}
              onOpenMail={() => onOpenMail(key)}
              onOpenRoom={(room) => onOpenRoom(key, room)}
              onSelect={(session) =>
                onSelectSession(key, { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onOpen={(session) =>
                onOpen({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onResume={(session) =>
                onResume({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onStop={(session) =>
                onStop({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onClose={(session) =>
                onClose({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onDelete={(session) =>
                onDelete({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onCreateRoom={(session) =>
                onCreateRoom({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
              onOpenChanges={(session) =>
                onOpenChanges({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, session)
              }
            />
          </div>
        );
      })}
    </div>
  );
}
