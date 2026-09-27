/**
 * Индикаторы броска (кусок 2.6, спека 5.4): подсветка тела группы в центре и
 * полупрозрачная половина у края. Линию строки вкладок рисует `TabStrip.tsx`,
 * рамку терминала — `TerminalSurface.tsx`; где сейчас бросок, им сообщает
 * `DropPreviewContext` из `AppShell.tsx`.
 *
 * `z-index: 10`: слой поверхностей идёт в контейнере работы после
 * `LayoutView` и без него закрыл бы индикатор над вкладкой-терминалом. Предки
 * индикатора внутри контейнера работы своего контекста наложения не создают.
 */

import { createContext, useContext, type CSSProperties } from 'react';
import type { Edge } from './tree.js';
import type { DropZone } from './dnd.js';

/** Зона под указателем во время перетаскивания; `null` — не тащат или мимо зон. */
export const DropPreviewContext = createContext<DropZone | null>(null);

export function useDropPreview(): DropZone | null {
  return useContext(DropPreviewContext);
}

const HALF: Record<Edge, CSSProperties> = {
  left: { top: 0, bottom: 0, left: 0, width: '50%' },
  right: { top: 0, bottom: 0, right: 0, width: '50%' },
  top: { left: 0, right: 0, top: 0, height: '50%' },
  bottom: { left: 0, right: 0, bottom: 0, height: '50%' },
};

export function DropIndicator({ edge }: { edge: Edge | null }): JSX.Element {
  const style: CSSProperties =
    edge === null
      ? { inset: 0, backgroundColor: 'rgba(59,130,246,.12)' }
      : { ...HALF[edge], backgroundColor: 'rgba(59,130,246,.2)' };
  return (
    <div
      data-drop-indicator={edge ?? 'center'}
      aria-hidden="true"
      className="pointer-events-none"
      style={{ position: 'absolute', zIndex: 10, ...style }}
    />
  );
}
