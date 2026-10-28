/**
 * Меню строки роя по правой кнопке (спека роя v1, 7.1): «Open the queen», «Mark as seen» (рой закончен, итог не
 * просмотрен; метод `swarms.seen`), «Cancel swarm…» (рой идёт; метод `swarms.cancel`, с подтверждением — отмена закрывает
 * живых трутней и проверяющих, королева остаётся). Отменяет рой только человек, из этого меню. Методы, которых хост не
 * знает, спрятаны (`useHostSupports`); ошибка хоста — тост `errorText(код, действие)`, текст хоста — только в консоль.
 */

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { WorkSwarm } from '@parley/core';
import { isSwarmTerminal } from '@parley/core/swarms';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { useHostSupports } from '../lib/capabilities.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu.js';
import { DESTRUCTIVE_ITEM } from './CardMenu.js';
import { useSidebarHold } from './use-sidebar-hold.js';
import { returnCursorFocus } from './use-sidebar-keys.js';

/** Итог можно отметить просмотренным: рой закончился `done` или `failed`, и человек его ещё не видел. */
export const swarmResultUnseen = (swarm: WorkSwarm): boolean => (swarm.status === 'done' || swarm.status === 'failed') && swarm.seenAt === null;

/** «Mark as seen» — общий вызов меню и кнопки итога в раскрытой строке. */
export function markSwarmSeen(bridge: ParleyBridge, projectPath: string, workId: string, swarmId: string): void {
  bridge.call('swarms.seen', { projectPath, workId, swarmId }).catch((error: unknown) => {
    console.warn('[parley] swarms.seen', error);
    toast(errorText(decodeIpcError(error).code, S.errors.actions.markSwarmSeen));
  });
}

export interface SwarmRowMenuProps {
  workKey: string;
  projectPath: string;
  workId: string;
  swarm: WorkSwarm;
  bridge: ParleyBridge;
  /** «Open the queen» — открыть сессию королевы; `null` — её удалили из карты, пункта нет. */
  onOpenQueen: (() => void) | null;
  /** Строка — триггер ui/context-menu. */
  children: ReactNode;
}

export function SwarmRowMenu({ workKey, projectPath, workId, swarm, bridge, onOpenQueen, children }: SwarmRowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useSidebarHold(`swarm-menu ${workKey} ${swarm.id}`, open || confirming);
  const canCancel = useHostSupports('swarms.cancel') && !isSwarmTerminal(swarm.status);
  const canMarkSeen = useHostSupports('swarms.seen') && swarmResultUnseen(swarm);

  const cancel = (): void => {
    bridge.call('swarms.cancel', { projectPath, workId, swarmId: swarm.id }).catch((error: unknown) => {
      console.warn('[parley] swarms.cancel', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.cancelSwarm));
    });
  };

  return (
    <>
      <ContextMenu onOpenChange={setOpen}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={returnCursorFocus}>
          {onOpenQueen === null ? null : (
            <ContextMenuItem data-swarm-action="open" onSelect={onOpenQueen}>
              {S.workSwarm.menu.open}
            </ContextMenuItem>
          )}
          {canMarkSeen ? (
            <ContextMenuItem data-swarm-action="seen" onSelect={() => markSwarmSeen(bridge, projectPath, workId, swarm.id)}>
              {S.workSwarm.menu.markSeen}
            </ContextMenuItem>
          ) : null}
          {canCancel ? (
            <ContextMenuItem data-swarm-action="cancel" className={DESTRUCTIVE_ITEM} onSelect={() => setConfirming(true)}>
              {S.workSwarm.menu.cancel}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog
        open={confirming}
        title={S.workSwarm.menu.cancelTitle(swarm.tag)}
        description={S.workSwarm.menu.cancelDescription}
        confirmLabel={S.workSwarm.menu.cancel}
        onConfirm={cancel}
        onOpenChange={setConfirming}
      />
    </>
  );
}
