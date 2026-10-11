/**
 * Общее подтверждение (Radix Dialog) — «Остановить»/«Удалить» сессию и т. п.
 * Кусок 1.4 плана «облик Orca»: примитив `ui/dialog`, кнопка действия —
 * `variant="destructive"` (спека 4.5, поведение «Диалоги»: «удаление —
 * destructive») — все нынешние вызовы confirmLabel'ят необратимое или
 * прерывающее действие (остановить/закрыть/удалить/отбросить). Коммит и
 * слияние «Изменений» (этап 8) не разрушают — им `confirmVariant: 'default'`
 * (раунд исправлений 8, пункт 4); по умолчанию кнопка по-прежнему красная.
 */

import { useEffect, useRef, useState } from 'react';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Вид кнопки подтверждения: `destructive` (по умолчанию) — необратимое, `default` — обычное действие. */
  confirmVariant?: 'destructive' | 'default';
  /**
   * Флажок под описанием (удаление комнаты: «Also delete its N sessions»). Снят при каждом открытии — согласие на
   * большее разрушение даётся явно; его значение приходит в `onConfirm`. Включённым его открывает `checkboxChecked`.
   */
  checkbox?: string;
  /**
   * Флажок включён при каждом открытии (архив комнаты: «Also stop its N agents…» — остановка обратима, и по умолчанию
   * её хотят). Без `checkbox` ничего не значит.
   */
  checkboxChecked?: boolean;
  onConfirm: (checked: boolean) => void;
  /**
   * Второе действие между «Отменой» и подтверждением (раунд fix-final-c, п. 4: «Commit anyway»
   * рядом с «Save all and commit»). Одно нажатие на открытие — общее с подтверждением.
   */
  secondary?: { label: string; onSelect: () => void };
  onOpenChange: (open: boolean) => void;
  /** Куда вернуть фокус после закрытия, если не туда, где он был при открытии (Radix). */
  onCloseAutoFocus?: (event: Event) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = 'destructive',
  checkbox,
  checkboxChecked = false,
  onConfirm,
  secondary,
  onOpenChange,
  onCloseAutoFocus,
}: ConfirmDialogProps): JSX.Element {
  // Одно подтверждение на одно открытие (раунд исправлений 1 куска 3.4, находка 6): кнопка
  // остаётся в DOM на время анимации закрытия, и двойной клик слал второй вызов — у
  // удаления он получал `not_found` и показывал ложный тост после успешного удаления.
  const confirmed = useRef(false);
  const [checked, setChecked] = useState(checkboxChecked);
  useEffect(() => {
    if (!open) return;
    confirmed.current = false;
    setChecked(checkboxChecked);
  }, [open, checkboxChecked]);

  // `aria-describedby={undefined}` без описания — приём из `ui/ui.test.tsx`,
  // чтобы Radix не предупреждал в консоли про отсутствующее описание. С
  // реальным `DialogDescription` атрибут не задаём вовсе (не то же самое, что
  // `undefined` явно — см. `exactOptionalPropertyTypes` ниже по коду в других
  // файлах): Radix сам связывает `aria-describedby` со своим id через контекст.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        {...(description === undefined ? { 'aria-describedby': undefined } : null)}
        {...(onCloseAutoFocus === undefined ? null : { onCloseAutoFocus })}
        // Три кнопки в ряд не влезают в 320px: с вторым действием — шире, в пределах окна.
        className={secondary === undefined ? 'w-80 max-w-80' : 'w-[30rem] max-w-[calc(100vw-2rem)]'}
      >
        <DialogTitle>{title}</DialogTitle>
        {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
        {checkbox === undefined ? null : (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} />
            {checkbox}
          </label>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          {secondary === undefined ? null : (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (confirmed.current) return;
                confirmed.current = true;
                secondary.onSelect();
                onOpenChange(false);
              }}
            >
              {secondary.label}
            </Button>
          )}
          <Button
            type="button"
            variant={confirmVariant}
            onClick={() => {
              if (confirmed.current) return;
              confirmed.current = true;
              onConfirm(checked);
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
