/**
 * Ручка ресайза сайдбара, 12px над швом (кусок 2.3, спека 4.4, 5.1). Во время
 * перетаскивания ширина цели пишется прямо в DOM через `requestAnimationFrame`
 * (без ре-рендера React на каждый `pointermove`), а в `store/ui.ts` (`onCommit`)
 * уходит только на `pointerup` — так раскладка не пишет `ui.json` десятки раз
 * за одно движение мыши.
 */

import { useRef } from 'react';

export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(Math.max(width, min), max);
}

export interface ResizerProps {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  /** Чью ширину двигать в DOM во время перетаскивания. */
  target: React.RefObject<HTMLElement>;
  /** Только на `pointerup`. */
  onCommit(width: number): void;
}

export function Resizer({ side, width, min, max, target, onCommit }: ResizerProps): JSX.Element {
  // Не состояние React: значения меняются на каждый `pointermove` (до
  // нескольких раз за кадр), а перерисовывать сам `Resizer` из-за них незачем
  // — ширину читает DOM напрямую (`target.current.style.width`).
  const dragStart = useRef<{ pointerX: number; startWidth: number } | null>(null);
  const pendingWidth = useRef(width);
  const rafId = useRef<number | null>(null);

  const applyWidth = (next: number): void => {
    pendingWidth.current = next;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const element = target.current;
      if (element !== null) element.style.width = `${pendingWidth.current}px`;
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // `setPointerCapture` — не везде реализован одинаково (jsdom в тестах);
    // без него перетаскивание просто останется активным, пока зажата кнопка.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStart.current = { pointerX: event.clientX, startWidth: width };
    pendingWidth.current = width;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (start === null) return;
    // Левый сайдбар растёт вправе (курсор вправо — шире), правый — наоборот
    // (курсор влево от начальной точки — тоже шире, он растёт от своего
    // левого края внутрь окна).
    const delta = side === 'left' ? event.clientX - start.pointerX : start.pointerX - event.clientX;
    applyWidth(clampWidth(start.startWidth + delta, min, max));
  };

  const endDrag = (): void => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    onCommit(pendingWidth.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group relative w-3 shrink-0 cursor-col-resize touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-ring/50" />
    </div>
  );
}
