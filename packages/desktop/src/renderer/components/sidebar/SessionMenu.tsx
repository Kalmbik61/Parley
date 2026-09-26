/**
 * Меню строки сессии (Radix ContextMenu, кусок 1.10 плана окна, «Закрыть…» и
 * «Создать комнату с…» — кусок 3.6): «Открыть» всегда, «Возобновить» у
 * `exited`/`done`/`failed`, «Остановить», «Закрыть…» и «Удалить» — с
 * подтверждением через `ConfirmDialog` (тест 4 куска 3.6: без подтверждения
 * «Закрыть…» ничего не шлёт). Уже закрытую сессию закрывать повторно незачем —
 * пункт скрыт (спека 5.1: закрытая сессия и так тусклая в дереве).
 */

import { useState, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { SessionStatus } from '@harnas/core';
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
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="min-w-40 rounded-md bg-[var(--h-mantle)] p-1 text-sm text-[var(--h-text)] shadow-lg">
            <ContextMenu.Item
              className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
              onSelect={onOpen}
            >
              Открыть
            </ContextMenu.Item>
            {RESUMABLE.has(status) ? (
              <ContextMenu.Item
                className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
                onSelect={onResume}
              >
                Возобновить
              </ContextMenu.Item>
            ) : null}
            {STOPPABLE.has(status) ? (
              <ContextMenu.Item
                className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
                onSelect={() => setConfirm('stop')}
              >
                Остановить
              </ContextMenu.Item>
            ) : null}
            {!closed ? (
              <ContextMenu.Item
                className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
                onSelect={() => setConfirm('close')}
              >
                Закрыть…
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
              onSelect={onCreateRoom}
            >
              Создать комнату с…
            </ContextMenu.Item>
            {hasWorktree ? (
              <ContextMenu.Item
                className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-[var(--h-selection)]"
                onSelect={onOpenChanges}
              >
                Изменения
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Separator className="my-1 h-px bg-[var(--h-overlay)]" />
            <ContextMenu.Item
              className="cursor-default rounded px-2 py-1 text-[var(--h-red)] outline-none data-[highlighted]:bg-[var(--h-selection)]"
              onSelect={() => setConfirm('delete')}
            >
              Удалить
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

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
