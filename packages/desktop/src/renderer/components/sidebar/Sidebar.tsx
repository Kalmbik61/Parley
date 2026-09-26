/**
 * Сайдбар: список работ слева, дерево сессий каждой — навигация мышью по
 * работам и сессиям (кусок 1.10 плана окна).
 */

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
}

export function Sidebar({ bridge }: SidebarProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const branches = useWorksStore((state) => state.branches);
  const activityByRef = useActivityStore((state) => state.byRef);

  const selectedWorkKey = useUiStore((state) => state.selectedWorkKey);
  const selectedRef = useUiStore((state) => state.selectedRef);
  const selectSession = useUiStore((state) => state.selectSession);
  const newWorkOpen = useUiStore((state) => state.dialogs.newWork);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const closeNewWorkDialog = useUiStore((state) => state.closeNewWorkDialog);

  const ordered = orderedWorks(entries);

  // «Открыть» и клик по строке — одно и то же: сама панель терминала появится
  // в куске 1.11, здесь выбор только меняет подсветку и метрики под ней.
  const handleSelect = (key: string, ref: SessionRef): void => selectSession(key, ref);
  const handleOpen = (ref: SessionRef): void => selectSession(workKey(ref.projectPath, ref.workId), ref);
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
            onSelectSession={(key, ref) => handleSelect(key, ref)}
            onOpen={(ref) => handleOpen(ref)}
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
