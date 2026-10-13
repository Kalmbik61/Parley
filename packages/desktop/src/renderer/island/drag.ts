/**
 * Перетаскивание острова за любое место формы (итерация 2026-10-12): точку курсора на экране шлёт main, тот двигает
 * окно вдоль верхнего края монитора под курсором и при отпускании прилепляет. Жест начинается не с нажатия, а когда
 * указатель ушёл от точки нажатия дальше `DRAG_THRESHOLD_PX`: нажатие без сдвига — обычный клик, он доходит до кнопок
 * и строк. Нажатие на кнопке, ссылке, `[role="button"]` или элементе с `data-no-drag` жест не начинает вовсе. Захват
 * указателя держит события, когда курсор уходит за пределы маленького окна. Необязательные `onDragStart` /
 * `onDragEnd` сообщают проводке (`IslandApp`), что жест идёт: пока он идёт, «курсор ушёл с формы» не должно делать
 * окно сквозным для мыши.
 *
 * Смахивание вверх (итерация 2026-10-13) — второй способ убрать остров в язычок, кроме стрелки внизу формы: зажать мышь
 * на острове и потянуть вверх. Направление решается один раз, на первом движении дальше `DRAG_THRESHOLD_PX`: вверх и
 * по вертикали больше, чем по горизонтали, — смахивание (захват указателя берётся, `dragStart` и `onDragStart` не
 * зовутся), иначе — перетаскивание, как раньше; движение вверх после начавшегося перетаскивания смахиванием не
 * становится. Смахивание срабатывает, как только указатель ушёл вверх от точки нажатия на `SWIPE_UP_PX`: один
 * `onSwipeUp`, и жест кончен (до нового нажатия движения ничего не делают); отпустили раньше — ничего. Порог мал нарочно:
 * курсор упирается в верх экрана, а нажатие в середине пилюли у самого верха оставляет запаса всего 10–15 px.
 * Без `onSwipeUp` режима смахивания нет — вверх тащится, как в любую сторону.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { IslandApi, IslandPoint } from '../../shared/island.js';

/** Насколько указатель должен уйти от точки нажатия, чтобы нажатие стало перетаскиванием, а не кликом. */
export const DRAG_THRESHOLD_PX = 4;

/** На сколько указатель должен уйти вверх от точки нажатия, чтобы смахивание убрало остров. */
export const SWIPE_UP_PX = 8;

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
  { onDragStart, onDragEnd, onSwipeUp }: { onDragStart?(): void; onDragEnd?(): void; onSwipeUp?(): void },
): ShapeDrag {
  /** Точка нажатия, пока кнопка зажата и жест ещё не начался (или идёт). */
  const origin = useRef<IslandPoint | null>(null);
  const active = useRef(false);
  /** Смахивание: `off` — не оно, `armed` — идёт и ждёт `SWIPE_UP_PX`, `done` — `onSwipeUp` позван, жест кончен. */
  const swipe = useRef<'off' | 'armed' | 'done'>('off');
  const [dragging, setDragging] = useState(false);

  // Отпускание, отмена жеста и потеря захвата заканчивают перетаскивание одинаково: потерянный `pointerup` не должен
  // оставить main в «тащим». После отпускания приходит ещё и `lostpointercapture` — повторный `dragEnd` не шлём.
  // Режим смахивания сбрасывается так же; `dragEnd` — только если шло перетаскивание.
  const end: PointerHandler = (event) => {
    origin.current = null;
    swipe.current = 'off';
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
        if (!active.current && swipe.current === 'off') {
          // Кнопку отпустили там, где форма события не увидела: жеста нет, и следующее движение его не начинает.
          if (event.buttons === 0) {
            origin.current = null;
            return;
          }
          const dx = event.screenX - start.screenX;
          const dy = event.screenY - start.screenY;
          if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          if (onSwipeUp !== undefined && dy < 0 && Math.abs(dy) > Math.abs(dx)) {
            swipe.current = 'armed';
          } else {
            active.current = true;
            setDragging(true);
            api.dragStart(start);
            onDragStart?.();
          }
        }
        if (swipe.current !== 'off') {
          // Первое же движение за порог направления может уже уйти вверх дальше `SWIPE_UP_PX` — проверка в том же событии.
          if (swipe.current === 'armed' && start.screenY - event.screenY >= SWIPE_UP_PX) {
            swipe.current = 'done';
            onSwipeUp?.();
          }
          return;
        }
        api.dragMove(pointOf(event));
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    },
  };
}
