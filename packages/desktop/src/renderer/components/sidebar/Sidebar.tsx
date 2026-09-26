/**
 * Сайдбар: список работ слева, дерево сессий каждой — навигация мышью по
 * работам и сессиям (кусок 1.10 плана окна). С куска 2.1 строка сессии не
 * держит собственную панель — «выбрать» и «открыть» одинаково просят
 * `Workspace` сфокусировать существующую панель или завести новую вкладку.
 */

import type { WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { workKey } from '../../lib/tree-order.js';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { useActivityStore } from '../../store/activity.js';
import { useUiStore } from '../../store/ui.js';
import { orderedWorks, useWorksStore } from '../../store/works.js';
import { NewWorkDialog } from '../dialogs/NewWorkDialog.js';
import { WorkList } from './WorkList.js';

export interface SidebarProps {
  bridge: HarnasBridge;
  /** Клик по строке или «Открыть» в меню сессии — `Workspace.openSession` через `App.tsx`. */
  onOpenSession: (workKey: string, ref: SessionRef, session: WorkSession) => void;
}

export function Sidebar({ bridge, onOpenSession }: SidebarProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const branches = useWorksStore((state) => state.branches);
  const activityByRef = useActivityStore((state) => state.byRef);

  const selectedWorkKey = useUiStore((state) => state.selectedWorkKey);
  const selectedRef = useUiStore((state) => state.selectedRef);
  const newWorkOpen = useUiStore((state) => state.dialogs.newWork);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const closeNewWorkDialog = useUiStore((state) => state.closeNewWorkDialog);

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
  const handleDelete = (ref: SessionRef): void => {
    bridge.call('sessions.delete', { ref }).catch(() => {});
  };

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-[var(--h-overlay)] bg-[var(--h-mantle)]">
      <div className="flex items-center justify-between border-b border-[var(--h-overlay)] px-2 py-2">
        <span className="text-sm font-medium text-[var(--h-text)]">Работы</span>
        <button
          type="button"
          onClick={openNewWorkDialog}
          className="rounded px-2 py-1 text-xs text-[var(--h-text)] hover:bg-[var(--h-surface)]"
        >
          + работа
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {ordered.length === 0 ? (
          <p className="p-2 text-sm text-[var(--h-muted)]">Работ пока нет</p>
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
            onDelete={(ref) => handleDelete(ref)}
          />
        )}
      </div>
      <NewWorkDialog
        open={newWorkOpen}
        bridge={bridge}
        onOpenChange={(open) => (open ? openNewWorkDialog() : closeNewWorkDialog())}
      />
    </div>
  );
}
