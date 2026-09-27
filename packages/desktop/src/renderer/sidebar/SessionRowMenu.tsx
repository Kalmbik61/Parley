/**
 * Меню строки сессии в карточке (кусок 3.4, спека 6.4): пункты прежнего `SessionMenu.tsx`
 * (тот живёт у старого сайдбара до 3.5) плюс «Open to the side» и «Copy worktree path».
 * Действия меню делает само — через мост, сторы раскладки и зеркала `ui`; наружу — только
 * «Open», тот же вход, что клик по строке.
 *
 * «Open to the side»: сначала работа строки становится активной, затем сплит вправо в её
 * раскладке. Группа и размеры берутся внутри операции: у ещё не гидрированной работы
 * операция ждёт в очереди `apply` до `hydrate` и должна увидеть уже её раскладку.
 */

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { SessionStatus, WorkSession } from '@harnas/core';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { tabId } from '../layout/ids.js';
import { measureGroupSizes } from '../layout/measure.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab, splitGroup } from '../layout/tree.js';
import { displayStatus } from '../lib/dot-state.js';
import { sessionRowLabel } from '../lib/participant.js';
import { useUiStore } from '../store/ui.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu.js';
import { DESTRUCTIVE_ITEM } from './CardMenu.js';
import { useSidebarHold } from './use-sidebar-hold.js';
import { returnCursorFocus } from './use-sidebar-keys.js';

const RESUMABLE: ReadonlySet<SessionStatus> = new Set(['exited', 'done', 'failed']);
const STOPPABLE: ReadonlySet<SessionStatus> = new Set(['active', 'pending']);

export interface SessionRowMenuProps {
  workKey: string;
  projectPath: string;
  workId: string;
  session: WorkSession;
  bridge: HarnasBridge;
  /** «Open» — как клик по строке. */
  onOpen(): void;
  /** Строка — триггер ui/context-menu. */
  children: ReactNode;
}

export function SessionRowMenu({ workKey, projectPath, workId, session, bridge, onOpen, children }: SessionRowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<'stop' | 'close' | 'delete' | null>(null);
  useSidebarHold(`session-menu ${workKey} ${session.id}`, open || confirm !== null);

  const status = displayStatus(session);
  const closed = session.lifecycle === 'closed';
  const label = sessionRowLabel(session.id, session.label);
  const ref = { projectPath, workId, sessionId: session.id };
  // Ошибки управления сессией — как у прежнего меню: в консоль, строка сама покажет исход.
  const call = (method: 'sessions.resume' | 'sessions.stop' | 'sessions.close' | 'sessions.delete'): void => {
    bridge.call(method, { ref }).catch((error: unknown) => console.warn(`[harnas] ${method}`, error));
  };

  const openBeside = (): void => {
    const tab: TabSpec = { kind: 'terminal', id: tabId.terminal(session.id), sessionId: session.id };
    const store = useLayoutStore.getState();
    store.setActiveWork(workKey);
    // Отказ сообщается изнутри операции: у негидрированной работы она выполняется позже, в
    // `hydrate`, а тот ошибки очереди молча отбрасывает — ответ `apply` тогда всегда `null`
    // (раунд исправлений 1, находка 1). Одна пустая группа (работу ни разу не открывали) —
    // не отказ: `splitGroup` просто кладёт вкладку в неё, сплитить там нечего.
    store.apply(workKey, (layout) => {
      const result = splitGroup(layout, layout.activeGroupId, 'row', tab, measureGroupSizes());
      if (result.error === 'too-many-groups') toast(S.tabs.tooManyGroups);
      else if (result.error === 'too-small') toast(S.tabs.tooSmall);
      return result;
    });
  };

  const openChanges = (): void => {
    const store = useLayoutStore.getState();
    store.setActiveWork(workKey);
    store.apply(workKey, (layout) => openTab(layout, { kind: 'diff', id: tabId.diff(session.id, null), sessionId: session.id, commit: null }));
  };

  const worktree = session.worktree;

  return (
    <>
      <ContextMenu onOpenChange={setOpen}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={returnCursorFocus}>
          <ContextMenuItem onSelect={onOpen}>{S.sidebar.sessionMenu.open}</ContextMenuItem>
          <ContextMenuItem onSelect={openBeside}>{S.sidebar.sessionMenu.openBeside}</ContextMenuItem>
          {RESUMABLE.has(status) ? (
            <ContextMenuItem onSelect={() => call('sessions.resume')}>{S.sidebar.sessionMenu.resume}</ContextMenuItem>
          ) : null}
          {STOPPABLE.has(status) ? (
            <ContextMenuItem onSelect={() => setConfirm('stop')}>{S.sidebar.sessionMenu.stop}</ContextMenuItem>
          ) : null}
          {!closed ? (
            <ContextMenuItem onSelect={() => setConfirm('close')}>{S.sidebar.sessionMenu.closeEllipsis}</ContextMenuItem>
          ) : null}
          <ContextMenuItem
            onSelect={() =>
              useUiStore.getState().openCreateRoomDialog({ projectPath, workId, requiredMember: { id: session.id, label } })
            }
          >
            {S.sidebar.sessionMenu.createRoomWith}
          </ContextMenuItem>
          {worktree !== null ? (
            <>
              <ContextMenuItem onSelect={openChanges}>{S.sidebar.sessionMenu.changes}</ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  navigator.clipboard.writeText(worktree.path).catch((error: unknown) => console.warn('[harnas] clipboard', error));
                }}
              >
                {S.sidebar.sessionMenu.copyWorktreePath}
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem className={DESTRUCTIVE_ITEM} onSelect={() => setConfirm('delete')}>
            {S.common.delete}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDialog
        open={confirm === 'stop'}
        title={S.sidebar.sessionMenu.stopConfirmTitle(label)}
        confirmLabel={S.sidebar.sessionMenu.stop}
        onConfirm={() => call('sessions.stop')}
        onOpenChange={(next) => setConfirm(next ? 'stop' : null)}
      />
      <ConfirmDialog
        open={confirm === 'close'}
        title={S.sidebar.sessionMenu.closeConfirmTitle(label)}
        description={S.sidebar.sessionMenu.closeConfirmDescription}
        confirmLabel={S.common.close}
        onConfirm={() => call('sessions.close')}
        onOpenChange={(next) => setConfirm(next ? 'close' : null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={S.sidebar.sessionMenu.deleteConfirmTitle(label)}
        confirmLabel={S.common.delete}
        onConfirm={() => call('sessions.delete')}
        onOpenChange={(next) => setConfirm(next ? 'delete' : null)}
      />
    </>
  );
}
