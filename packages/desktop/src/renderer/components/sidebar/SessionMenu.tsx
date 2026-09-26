/**
 * Меню строки сессии (Radix ContextMenu, кусок 1.10 плана окна): «Открыть»
 * всегда, «Возобновить» у `exited`/`done`/`failed`, «Остановить» и «Удалить» —
 * с подтверждением через `ConfirmDialog`.
 */

import { useState, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { SessionStatus } from '@harnas/core';
import { ConfirmDialog } from '../dialogs/ConfirmDialog.js';

const RESUMABLE: ReadonlySet<SessionStatus> = new Set(['exited', 'done', 'failed']);
const STOPPABLE: ReadonlySet<SessionStatus> = new Set(['active', 'pending']);

export interface SessionMenuProps {
  status: SessionStatus;
  label: string;
  onOpen: () => void;
  onResume: () => void;
  onStop: () => void;
  onDelete: () => void;
  children: ReactNode;
}

export function SessionMenu({ status, label, onOpen, onResume, onStop, onDelete, children }: SessionMenuProps): JSX.Element {
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);

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
        open={confirm === 'delete'}
        title={`Удалить «${label}»?`}
        confirmLabel="Удалить"
        onConfirm={onDelete}
        onOpenChange={(open) => setConfirm(open ? 'delete' : null)}
      />
    </>
  );
}
