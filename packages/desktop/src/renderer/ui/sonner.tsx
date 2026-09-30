/**
 * Тосты shadcn/ui на `sonner`, поверх — облик Orca (спека 4.5): справа
 * внизу, отступ снизу 2.5rem, ширина `min(26rem, calc(100vw - 32px))`.
 *
 * Без `next-themes` (эталонный shadcn его использует) — у окна нет темы
 * страницы, только `.dark` на `<html>` от `useUiStore` (кусок 1.1). Тема
 * тоста читается напрямую оттуда.
 *
 * Правый нижний угол делят с тостами и другие плавающие панели — карточки решений в окне (`WindowNotes`). Панель,
 * что стоит в углу, пишет свою высоту с зазором в `TOAST_INSET_VAR` на `<html>`, и тосты встают над ней, а не на
 * её кнопки. Потолок `100vh − 4.5rem` не даёт поднятому тосту уйти за верх окна: у очень высокой панели он лучше
 * перекроет её верх, чем пропадёт.
 */

import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';
import { useUiStore } from '../store/ui.js';

/** Переменная `<html>`: сколько места снизу занято панелью в углу (высота и зазор, `px`); нет панели — не задана. */
export const TOAST_INSET_VAR = '--toast-inset-bottom';

/** Нижний отступ тостов: 2.5rem, а над панелью в углу — выше неё, но в пределах окна. */
export const TOAST_BOTTOM_OFFSET = `min(calc(2.5rem + var(${TOAST_INSET_VAR}, 0px)), calc(100vh - 4.5rem))`;

export function Toaster(props: ToasterProps): JSX.Element {
  const dark = useUiStore((state) => state.dark);

  return (
    <SonnerToaster
      theme={dark ? 'dark' : 'light'}
      position="bottom-right"
      offset={{ bottom: TOAST_BOTTOM_OFFSET }}
      style={{ '--width': 'min(26rem, calc(100vw - 32px))' } as CSSProperties}
      {...props}
    />
  );
}
