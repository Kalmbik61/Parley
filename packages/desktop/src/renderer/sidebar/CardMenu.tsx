/**
 * Меню карточки работы по правой кнопке (кусок 3.4, спека 6.4). Действия без внешнего
 * состояния меню делает само — сторы и мост; наружу — только то, что живёт у карточки:
 * переименование на месте и вкладка почты.
 *
 * Пункты с методами, которых хост не знает, спрятаны (`useHostSupports`, спека 3.2).
 * Ошибка хоста или main — тост `errorText(код, действие)`; русский текст хоста — только в
 * консоль (сквозное правило E.1).
 *
 * «Delete…»: хост отвечает `conflict`, пока у работы есть живая сессия. Поэтому после
 * подтверждения окно останавливает живые сессии и только затем удаляет работу.
 * Подтверждение — согласие человека на остановку (рамка 15.1); без него ни одного вызова.
 */

import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { WorkEntry, WorkStatus } from '@harnas/core';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { useHostSupports } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu.js';
import { useSidebarHold } from './use-sidebar-hold.js';

/** Пункты спеки 6.4 — они же `data-card-action` пунктов. */
export type CardAction = 'pin' | 'unpin' | 'new-session' | 'new-room' | 'open-mail' | 'rename'
  | 'reveal' | 'copy-path' | 'finish' | 'reopen' | 'archive' | 'delete';

/** Действия без внешнего состояния меню делает само (сторы, мост); наружу — то, что у карточки. */
export interface CardMenuProps {
  entry: WorkEntry;
  pinned: boolean;
  bridge: HarnasBridge;
  /** InlineRename своей карточки. */
  onRename(): void;
  /** Вкладка mail этой работы. */
  onOpenMail(): void;
  /** Карточка — триггер ui/context-menu. */
  children: ReactNode;
}

/**
 * «Разрушитель» читается и на подсветке фокуса: фон — общий `--accent` пункта, текст — свой
 * токен `--menu-destructive` (≥ 4.5:1 в обеих темах, `tokens.test.ts`). Прежний
 * `SessionMenu` красил фокус в `--destructive`, и в тёмной теме текст пропадал.
 */
export const DESTRUCTIVE_ITEM = 'text-menu-destructive focus:bg-accent focus:text-menu-destructive';

/** Ошибка вызова — в консоль как есть, человеку — английский текст по коду. */
function reportError(label: string, action: string): (error: unknown) => void {
  return (error) => {
    console.warn(`[harnas] ${label}`, error);
    toast(errorText(decodeIpcError(error).code, action));
  };
}

export function CardMenu({ entry, pinned, bridge, onRename, onOpenMail, children }: CardMenuProps): JSX.Element {
  const { projectPath, map } = entry;
  const workId = map.work.id;
  const key = workKey(projectPath, workId);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  // «Rename» открывает поле на месте заголовка; закрытое меню вернуло бы фокус на карточку
  // уже после того, как поле его взяло, — поле потеряло бы фокус и закрылось.
  const renameChosen = useRef(false);
  useSidebarHold(`card-menu ${key}`, open || confirm !== null);

  const canRename = useHostSupports('works.rename');
  const canSetStatus = useHostSupports('works.setStatus');
  const canDelete = useHostSupports('works.delete');
  const canCreateSession = useHostSupports('sessions.create');
  const canCreateRoom = useHostSupports('rooms.create');

  const status = map.work.status;
  const setStatus = (next: WorkStatus, action: string): void => {
    bridge.call('works.setStatus', { projectPath, workId, status: next }).catch(reportError('works.setStatus', action));
  };

  const togglePin = (): void => {
    const { ui, patchUi } = useUiStore.getState();
    patchUi({ pinnedWorks: pinned ? ui.pinnedWorks.filter((item) => item !== key) : [...ui.pinnedWorks.filter((item) => item !== key), key] });
  };

  const deleteWork = async (): Promise<void> => {
    // Сессии — из свежего снимка: пока меню было открыто, какая-то могла запуститься.
    const fresh = useWorksStore.getState().entries.find((item) => workKey(item.projectPath, item.map.work.id) === key) ?? entry;
    for (const session of fresh.map.sessions) {
      if (session.lifecycle !== 'active') continue;
      await bridge.call('sessions.stop', { ref: { projectPath, workId, sessionId: session.id } });
    }
    await bridge.call('works.delete', { projectPath, workId });
    // Иначе удалённая работа осталась бы в ui.json навсегда.
    const { ui, patchUi } = useUiStore.getState();
    if (ui.pinnedWorks.includes(key)) patchUi({ pinnedWorks: ui.pinnedWorks.filter((item) => item !== key) });
  };

  return (
    <>
      <ContextMenu onOpenChange={setOpen}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            if (!renameChosen.current) return;
            renameChosen.current = false;
            event.preventDefault();
          }}
        >
          <ContextMenuItem data-card-action={pinned ? 'unpin' : 'pin'} onSelect={togglePin}>
            {pinned ? S.cardMenu.unpin : S.cardMenu.pin}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {canCreateSession ? (
            <ContextMenuItem
              data-card-action="new-session"
              onSelect={() => useUiStore.getState().openNewSessionDialog(null, { projectPath, workId })}
            >
              {S.cardMenu.newSession}
            </ContextMenuItem>
          ) : null}
          {canCreateRoom ? (
            <ContextMenuItem
              data-card-action="new-room"
              onSelect={() => useUiStore.getState().openCreateRoomDialog({ projectPath, workId, requiredMember: null })}
            >
              {S.cardMenu.newRoom}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem data-card-action="open-mail" onSelect={onOpenMail}>
            {S.cardMenu.openMail}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {canRename ? (
            <ContextMenuItem
              data-card-action="rename"
              onSelect={() => {
                renameChosen.current = true;
                onRename();
              }}
            >
              {S.cardMenu.rename}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            data-card-action="reveal"
            onSelect={() => {
              bridge.app.revealWork(projectPath, workId).catch(reportError('app.revealWork', S.errors.actions.revealWorkspace));
            }}
          >
            {S.cardMenu.reveal}
          </ContextMenuItem>
          <ContextMenuItem
            data-card-action="copy-path"
            onSelect={() => {
              navigator.clipboard.writeText(projectPath).catch((error: unknown) => console.warn('[harnas] clipboard', error));
            }}
          >
            {S.cardMenu.copyPath}
          </ContextMenuItem>
          {canSetStatus ? (
            <>
              <ContextMenuSeparator />
              {status === 'active' ? (
                <ContextMenuItem data-card-action="finish" onSelect={() => setStatus('done', S.errors.actions.markWorkspaceDone)}>
                  {S.cardMenu.markDone}
                </ContextMenuItem>
              ) : (
                // У `done` и у `archived` (временный показ архивных, 6.3) — вернуть в работу.
                <ContextMenuItem data-card-action="reopen" onSelect={() => setStatus('active', S.errors.actions.reopenWorkspace)}>
                  {S.cardMenu.reopen}
                </ContextMenuItem>
              )}
              {status !== 'archived' ? (
                <ContextMenuItem data-card-action="archive" className={DESTRUCTIVE_ITEM} onSelect={() => setConfirm('archive')}>
                  {S.cardMenu.archive}
                </ContextMenuItem>
              ) : null}
            </>
          ) : null}
          {canDelete ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-card-action="delete" className={DESTRUCTIVE_ITEM} onSelect={() => setConfirm('delete')}>
                {S.cardMenu.deleteEllipsis}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDialog
        open={confirm === 'archive'}
        title={S.cardMenu.archiveConfirmTitle(map.work.title)}
        confirmLabel={S.cardMenu.archive}
        onConfirm={() => setStatus('archived', S.errors.actions.archiveWorkspace)}
        onOpenChange={(next) => setConfirm(next ? 'archive' : null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={S.cardMenu.deleteConfirmTitle(map.work.title)}
        description={S.cardMenu.deleteConfirmDescription(map.sessions.length)}
        confirmLabel={S.common.delete}
        onConfirm={() => {
          deleteWork().catch(reportError('works.delete', S.errors.actions.deleteWorkspace));
        }}
        onOpenChange={(next) => setConfirm(next ? 'delete' : null)}
      />
    </>
  );
}
