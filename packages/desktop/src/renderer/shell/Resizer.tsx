/**
 * Ручка ресайза сайдбара, 12px над швом (кусок 2.3, спека 4.4, 5.1). Во время
 * перетаскивания ширина цели пишется прямо в DOM через `requestAnimationFrame`
 * (без ре-рендера React на каждый `pointermove`), а в `store/ui.ts` (`onCommit`)
 * уходит только на `pointerup` — так раскладка не пишет `ui.json` десятки раз
 * за одно движение мыши.
 *
 * Поверх центра во время перетаскивания — прозрачный оверлей (спека 5.1:
 * «поверх `<webview>` и Monaco кладётся прозрачный оверлей, чтобы они не
 * перехватывали мышь», раунд исправлений 1, Important A1): `setPointerCapture`
 * самого `Resizer` держит `pointermove`/`pointerup` независимо от того, что
 * физически под курсором, но гостевой процесс `<webview>` — не часть
 * host-документа, и то, что он не перехватит мышь сам по себе, не гарантия
 * Electron, а наблюдение сегодня (в центре пока только xterm).
 * `position: fixed` — растягивается на весь экран независимо от места
 * `Resizer` в дереве, `relative` на самой ручке не создаёт containing block
 * для `fixed` (это делают только `transform`/`filter`/`contain` и т. п.,
 * которых на предках нет).
 *
 * Захват указателя может пропасть и без `pointerup`/`pointercancel`
 * (например, окно ушло из фокуса ОС посреди перетаскивания) — раунд
 * исправлений 2, Important: без сброса на `lostpointercapture` и на `blur`
 * окна состояние перетаскивания и оверлей застревали бы навсегда, а оверлей
 * (потомок ручки в DOM) ловил бы любой следующий клик где угодно и
 * запускал бы новое перетаскивание всплытием до `onPointerDown` ручки.
 *
 * Ручка не занимает места в раскладке (раунд исправлений 3, Important, спека
 * 4.4: «зона ресайза — 12px над швом»): внешняя обёртка — нулевой ширины
 * flex-элемент, ровно на шве между сайдбаром и центром; зона захвата (12px,
 * все обработчики) — `absolute`, отцентрована на этой точке (`left-0
 * -translate-x-1/2`), поэтому сосед слева и сосед справа стоят вплотную, а не
 * раздвинуты на 12px, сквозь которые раньше просвечивал фон окна.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  // Единственное состояние React в этом компоненте: только чтобы включить/
  // выключить оверлей в разметке — сама ширина по-прежнему идёт через рефы
  // выше и лишних рендеров на `pointermove` не просит.
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

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
    setDragging(true);
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

  // Общий для завершения (commit) и отмены (без commit) сброс — обе стороны
  // должны одинаково снять оверлей, забыть начало перетаскивания и не дать
  // сработать уже запланированному rAF с устаревшей шириной.
  const resetDragState = useCallback((): void => {
    dragStart.current = null;
    setDragging(false);
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  const endDrag = (): void => {
    if (dragStart.current === null) return;
    resetDragState();
    onCommit(pendingWidth.current);
  };

  // `onLostPointerCapture` и потеря фокуса окна — раунд исправлений 2:
  // перетаскивание прервано не человеком (крестик/отпускание кнопки), а
  // средой, поэтому commit не зовём — по интерфейсу он только на `pointerup`.
  const cancelDrag = useCallback((): void => {
    if (dragStart.current === null) return;
    resetDragState();
  }, [resetDragState]);

  useEffect(() => {
    if (!dragging) return undefined;
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, [dragging, cancelDrag]);

  return (
    // Нулевая ширина: сам этот `div` — то, что стоит между сайдбаром и
    // центром во flex-потоке, и стоять он должен ровно на шве, ничего не
    // раздвигая. `relative` — для `absolute` зоны захвата внутри.
    <div className="relative w-0 shrink-0">
      <div
        role="separator"
        aria-orientation="vertical"
        className="group absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-ring/50" />
      </div>
      {dragging ? (
        // На весь экран, не только на центр: сам `Resizer` уже держит
        // `pointermove`/`pointerup` через `setPointerCapture`, оверлею
        // достаточно просто существовать поверх всего остального, чтобы
        // ничего под курсором (в первую очередь — гостевые поверхности) не
        // перехватило мышь по пути.
        <div data-testid="resize-overlay" className="fixed inset-0 z-40 cursor-col-resize" />
      ) : null}
    </div>
  );
}
