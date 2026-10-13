/**
 * Перетаскивание острова за любое место формы (итерация 2026-10-12): точку курсора на экране шлёт main, тот двигает
 * окно вдоль верхнего края монитора под курсором и при отпускании прилепляет. Жест начинается не с нажатия, а когда
 * указатель ушёл от точки нажатия дальше `DRAG_THRESHOLD_PX`: нажатие без сдвига — обычный клик, он доходит до кнопок
 * и строк. Нажатие на кнопке, ссылке, `[role="button"]` или элементе с `data-no-drag` жест не начинает вовсе. Захват
 * указателя держит события, когда курсор уходит за пределы маленького окна. Необязательные `onDragStart` /
 * `onDragEnd` сообщают проводке (`IslandApp`), что жест идёт: пока он идёт, «курсор ушёл с формы» не должно делать
 * окно сквозным для мыши.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { IslandApi, IslandPoint } from '../../shared/island.js';

/** Насколько указатель должен уйти от точки нажатия, чтобы нажатие стало перетаскиванием, а не кликом. */
export const DRAG_THRESHOLD_PX = 4;

/** Цели, на которых нажатие не начинает перетаскивание: кнопки, ссылки и всё, что помечено `data-no-drag`. */
const NO_DRAG_SELECTOR = 'button, a, [role="button"], [data-no-drag]';

const pointOf = (event: { screenX: number; screenY: number }): IslandPoint => ({ screenX: event.screenX, screenY: event.screenY });

type PointerHandler = (event: ReactPointerEvent<HTMLElement>) => void;

export interface ShapeDrag {
  /** Обработчики указателя для внешней формы острова. */
  handlers: {
    onPointerDown: PointerHandler;
    onPointerMove: PointerHandler;
    onPointerUp: PointerHandler;
    onPointerCancel: PointerHandler;
    onLostPointerCapture: PointerHandler;
  };
  /** Жест идёт: форме нужен курсор `grabbing`. */
  dragging: boolean;
}

export function useShapeDrag(
  api: Pick<IslandApi, 'dragStart' | 'dragMove' | 'dragEnd'>,
  { onDragStart, onDragEnd }: { onDragStart?(): void; onDragEnd?(): void },
): ShapeDrag {
  /** Точка нажатия, пока кнопка зажата и жест ещё не начался (или идёт). */
  const origin = useRef<IslandPoint | null>(null);
  const active = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Отпускание, отмена жеста и потеря захвата заканчивают перетаскивание одинаково: потерянный `pointerup` не должен
  // оставить main в «тащим». После отпускания приходит ещё и `lostpointercapture` — повторный `dragEnd` не шлём.
  const end: PointerHandler = (event) => {
    origin.current = null;
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    api.dragEnd(pointOf(event));
    onDragEnd?.();
  };

  return {
    dragging,
    handlers: {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element) {
          const blocked = event.target.closest(NO_DRAG_SELECTOR);
          if (blocked !== null && event.currentTarget.contains(blocked)) return;
        }
        origin.current = pointOf(event);
      },
      onPointerMove: (event) => {
        const start = origin.current;
        if (start === null) return;
        if (!active.current) {
          // Кнопку отпустили там, где форма события не увидела: жеста нет, и следующее движение его не начинает.
          if (event.buttons === 0) {
            origin.current = null;
            return;
          }
          if (Math.hypot(event.screenX - start.screenX, event.screenY - start.screenY) <= DRAG_THRESHOLD_PX) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          active.current = true;
          setDragging(true);
          api.dragStart(start);
          onDragStart?.();
        }
        api.dragMove(pointOf(event));
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    },
  };
}
