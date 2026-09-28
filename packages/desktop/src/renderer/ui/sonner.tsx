/**
 * Тосты shadcn/ui на `sonner`, поверх — облик Orca (спека 4.5): справа
 * внизу, отступ снизу 2.5rem, ширина `min(26rem, calc(100vw - 32px))`.
 *
 * Без `next-themes` (эталонный shadcn его использует) — у окна нет темы
 * страницы, только `.dark` на `<html>` от `useUiStore` (кусок 1.1). Тема
 * тоста читается напрямую оттуда.
 */

import type { CSSProperties } from 'react';
import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';
import { useUiStore } from '../store/ui.js';

export function Toaster(props: ToasterProps): JSX.Element {
  const dark = useUiStore((state) => state.dark);

  return (
    <SonnerToaster
      theme={dark ? 'dark' : 'light'}
      position="bottom-right"
      offset={{ bottom: '2.5rem' }}
      style={{ '--width': 'min(26rem, calc(100vw - 32px))' } as CSSProperties}
      {...props}
    />
  );
}
