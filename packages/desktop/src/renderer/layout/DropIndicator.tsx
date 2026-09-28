/**
 * Индикаторы броска (кусок 2.6, спека 5.4): подсветка тела группы в центре и
 * полупрозрачная половина у края. Линию строки вкладок рисует `TabStrip.tsx`,
 * рамку терминала — `TerminalSurface.tsx`; где сейчас бросок, им сообщает
 * `setDropPreview` из `AppShell.tsx`.
 *
 * Раунд исправлений 1 (ревью A): превью — не контекст над всем окном, а
 * маленькое хранилище с селекторами по зоне. Контекст (и `useState` в
 * `AppShell`) на каждую смену зоны перерисовывал все тела групп, строки
 * вкладок и поверхности трёх работ LRU; селектор отдаёт компоненту примитив
 * только про ЕГО зону, и перерисовывается лишь та зона, что зажглась или
 * погасла. Ключ работы — в хранилище: id групп и сессий уникальны только
 * внутри работы.
 *
 * `z-index: 10`: слой поверхностей идёт в контейнере работы после
 * `LayoutView` и без него закрыл бы индикатор над вкладкой-терминалом. Предки
 * индикатора внутри контейнера работы своего контекста наложения не создают.
 */

import type { CSSProperties } from 'react';
import { create } from 'zustand';
import type { Edge } from './tree.js';
import type { DropZone } from './dnd.js';

interface DropPreviewState {
  /** Работа, чья зона под указателем; `null` — не тащат или мимо зон. */
  workKey: string | null;
  zone: DropZone | null;
}

const useDropPreviewStore = create<DropPreviewState>(() => ({ workKey: null, zone: null }));

function sameZone(a: DropZone | null, b: DropZone | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Зона под указателем; та же зона повторно ничего не меняет — `onDragMove` зовёт на каждый сдвиг. */
export function setDropPreview(workKey: string | null, zone: DropZone | null): void {
  const prev = useDropPreviewStore.getState();
  const next = zone === null ? null : workKey;
  if (prev.workKey === next && sameZone(prev.zone, zone)) return;
  useDropPreviewStore.setState({ workKey: next, zone });
}

/** Индикатор тела группы: `'center'`, край или `null`. */
export function useBodyDropPreview(workKey: string, groupId: string): Edge | 'center' | null {
  return useDropPreviewStore((state) => {
    const zone = state.zone;
    if (state.workKey !== workKey || zone === null) return null;
    if (zone.kind === 'center' && zone.groupId === groupId) return 'center';
    if (zone.kind === 'edge' && zone.groupId === groupId) return zone.edge;
    return null;
  });
}

/** Место вставки в строке вкладок группы или `null`. */
export function useStripDropSlot(workKey: string, groupId: string): number | null {
  return useDropPreviewStore((state) =>
    state.workKey === workKey && state.zone?.kind === 'strip' && state.zone.groupId === groupId ? state.zone.index : null,
  );
}

/** Бросок сейчас — в терминал этой сессии. */
export function useTerminalDropPreview(workKey: string, sessionId: string): boolean {
  return useDropPreviewStore(
    (state) => state.workKey === workKey && state.zone?.kind === 'terminal' && state.zone.sessionId === sessionId,
  );
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
