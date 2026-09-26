/** Общее подтверждение (Radix Dialog) — «Остановить»/«Удалить» сессию и т. п. */

import * as Dialog from '@radix-ui/react-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--h-base)] p-4 text-[var(--h-text)] shadow-lg">
          <Dialog.Title className="text-sm font-medium">{title}</Dialog.Title>
          {description !== undefined ? (
            <Dialog.Description className="mt-1 text-xs text-[var(--h-subtext)]">{description}</Dialog.Description>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="rounded px-3 py-1 text-sm text-[var(--h-subtext)]">
                Отмена
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="rounded bg-[var(--h-red)] px-3 py-1 text-sm text-[var(--h-base)]"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
