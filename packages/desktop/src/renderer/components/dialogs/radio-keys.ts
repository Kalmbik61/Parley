/**
 * Стрелки в группе пилюль `role="radiogroup"` (диалоги 1.5 и 1.6): как у радиогруппы по образцу APG, фокус и выбор идут
 * на соседний доступный пункт по кругу; пункты с `disabled` стрелки пропускают. В порядке Tab стоит один пункт группы —
 * выбранный (`tabIndex` 0, у прочих −1), это ставит сама разметка. Пилюли — обычные кнопки с `role="radio"`, а не
 * Radix ToggleGroup: рамка и заливка выбранной пилюли — не вид сегмента.
 */

import type { KeyboardEvent } from 'react';

export function radioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (!forward && !backward) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  const at = radios.findIndex((radio) => radio === document.activeElement);
  if (at === -1) return;
  event.preventDefault();
  const next = radios[(at + (forward ? 1 : -1) + radios.length) % radios.length];
  next?.focus();
  // Выбор — щелчком: обработчик у пункта один, и у пилюли вне выбранной он его и меняет.
  next?.click();
}
