/**
 * Общее подтверждение (Radix Dialog) — «Остановить»/«Удалить» сессию и т. п.
 * Кусок 1.4 плана «облик Orca»: примитив `ui/dialog`, кнопка действия —
 * `variant="destructive"` (спека 4.5, поведение «Диалоги»: «удаление —
 * destructive») — все нынешние вызовы confirmLabel'ят необратимое или
 * прерывающее действие (остановить/закрыть/удалить/отбросить), отдельного
 * флажка «это не удаление» пока никто не просил (простота вместо
 * конфигурируемости, которую не заказывали).
 */

import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';

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
  // `aria-describedby={undefined}` без описания — приём из `ui/ui.test.tsx`,
  // чтобы Radix не предупреждал в консоли про отсутствующее описание. С
  // реальным `DialogDescription` атрибут не задаём вовсе (не то же самое, что
  // `undefined` явно — см. `exactOptionalPropertyTypes` ниже по коду в других
  // файлах): Radix сам связывает `aria-describedby` со своим id через контекст.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...(description === undefined ? { 'aria-describedby': undefined } : null)}
        className="w-80 max-w-80"
      >
        <DialogTitle>{title}</DialogTitle>
        {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
