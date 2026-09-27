/**
 * Меню строки сессии (кусок 1.10 плана окна; «Закрыть…» и «Создать комнату
 * с…» — кусок 3.6): «Открыть» всегда, «Возобновить» у `exited`/`done`/`failed`,
 * «Остановить», «Закрыть…» и «Удалить» — с подтверждением через `ConfirmDialog`
 * (тест 4 куска 3.6: без подтверждения «Закрыть…» ничего не шлёт). Уже
 * закрытую сессию закрывать повторно незачем — пункт скрыт (спека 5.1:
 * закрытая сессия и так тусклая в дереве). С куска 1.3 плана окна — на общих
 * примитивах `ui/context-menu` (облик «стекло», спека 4.5) вместо голого
 * `@radix-ui/react-context-menu`; пункты и их условия те же.
 */

import { useState, type ReactNode } from 'react';
import type { SessionStatus } from '@harnas/core';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/context-menu.js';
import { ConfirmDialog } from '../dialogs/ConfirmDialog.js';

const RESUMABLE: ReadonlySet<SessionStatus> = new Set(['exited', 'done', 'failed']);
const STOPPABLE: ReadonlySet<SessionStatus> = new Set(['active', 'pending']);

export interface SessionMenuProps {
  status: SessionStatus;
  /** Сессия уже закрыта (`lifecycle === 'closed'`) — не выводится из `status`, он на закрытие не влияет (`dot-state.ts#displayStatus`). */
  closed: boolean;
  label: string;
  /** Сессия в своём worktree (`session.worktree !== null`) — только тогда есть что смотреть в «Изменения» (кусок 4.3 плана worktree). */
  hasWorktree: boolean;
  onOpen: () => void;
  onResume: () => void;
  onStop: () => void;
  onClose: () => void;
  onDelete: () => void;
  onCreateRoom: () => void;
  onOpenChanges: () => void;
  children: ReactNode;
}

export function SessionMenu({
  status,
  closed,
  label,
  hasWorktree,
  onOpen,
  onResume,
  onStop,
  onClose,
  onDelete,
  onCreateRoom,
  onOpenChanges,
  children,
}: SessionMenuProps): JSX.Element {
  const [confirm, setConfirm] = useState<'stop' | 'close' | 'delete' | null>(null);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>Открыть</ContextMenuItem>
          {RESUMABLE.has(status) ? <ContextMenuItem onSelect={onResume}>Возобновить</ContextMenuItem> : null}
          {STOPPABLE.has(status) ? (
            <ContextMenuItem onSelect={() => setConfirm('stop')}>Остановить</ContextMenuItem>
          ) : null}
          {!closed ? <ContextMenuItem onSelect={() => setConfirm('close')}>Закрыть…</ContextMenuItem> : null}
          <ContextMenuItem onSelect={onCreateRoom}>Создать комнату с…</ContextMenuItem>
          {hasWorktree ? <ContextMenuItem onSelect={onOpenChanges}>Изменения</ContextMenuItem> : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
            onSelect={() => setConfirm('delete')}
          >
            Удалить
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDialog
        open={confirm === 'stop'}
        title={`Остановить «${label}»?`}
        confirmLabel="Остановить"
        onConfirm={onStop}
        onOpenChange={(open) => setConfirm(open ? 'stop' : null)}
      />
      <ConfirmDialog
        open={confirm === 'close'}
        title={`Закрыть «${label}»?`}
        description="Сессия больше не получит писем"
        confirmLabel="Закрыть"
        onConfirm={onClose}
        onOpenChange={(open) => setConfirm(open ? 'close' : null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Удалить «${label}»?`}
        confirmLabel="Удалить"
        onConfirm={onDelete}
        onOpenChange={(open) => setConfirm(open ? 'delete' : null)}
      />
    </>
  );
}
