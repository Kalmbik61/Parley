/**
 * Тосты shadcn/ui на `sonner`, поверх — облик Orca (спека 4.5): справа
 * внизу, отступ снизу 2.5rem, ширина `min(26rem, calc(100vw - 32px))`.
 *
 * Без `next-themes` (эталонный shadcn его использует) — у окна нет темы
 * страницы, только `.dark` на `<html>` от `useUiStore` (кусок 1.1). Тема
 * тоста читается напрямую оттуда.
 *
 * Правый нижний угол делят с тостами и другие плавающие блоки — карточки решений в окне (`WindowNotes`) и лоток аннотаций
 * вкладки браузера. Блок, что стоит в углу, заявляет свой отступ издателем (`ui/toast-inset.ts`): `TOAST_INSET_VAR` на
 * `<html>` держит наибольший из заявленных, и тосты встают над блоком, а не на его кнопки. Потолок `100vh − 4.5rem` не даёт
 * поднятому тосту уйти за верх окна: у очень высокого блока он лучше перекроет его верх, чем пропадёт.
 */

import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';
import { useUiStore } from '../store/ui.js';
import { TOAST_BASE_REM, TOAST_INSET_VAR, TOAST_SIDE_OFFSET, TOAST_WIDTH_REM } from './toast-inset.js';

export { TOAST_INSET_VAR };

/** Нижний отступ тостов: 2.5rem, а над блоком в углу — выше него, но в пределах окна. */
export const TOAST_BOTTOM_OFFSET = `min(calc(${TOAST_BASE_REM}rem + var(${TOAST_INSET_VAR}, 0px)), calc(100vh - 4.5rem))`;

export function Toaster(props: ToasterProps): JSX.Element {
  const dark = useUiStore((state) => state.dark);

  return (
    <SonnerToaster
      theme={dark ? 'dark' : 'light'}
      position="bottom-right"
      offset={{ bottom: TOAST_BOTTOM_OFFSET, right: TOAST_SIDE_OFFSET }}
      style={{ '--width': `min(${TOAST_WIDTH_REM}rem, calc(100vw - 32px))` } as CSSProperties}
      {...props}
    />
  );
}
