/**
 * Ручка перетаскивания острова (спайк 2026-10-12): точку курсора на экране шлёт main, тот двигает окно вдоль верхнего
 * края монитора под курсором и при отпускании прилепляет. Захват указателя держит события, когда курсор уходит за
 * пределы маленького окна. Необязательные `onDragStart` / `onDragEnd` сообщают проводке (`IslandApp`), что жест идёт:
 * пока он идёт, «курсор ушёл с формы» не должно делать окно сквозным для мыши.
 */

import { S } from '../../shared/strings.js';
import type { IslandApi } from '../../shared/island.js';

export function DragHandle({
  api,
  onDragStart,
  onDragEnd,
}: {
  api: Pick<IslandApi, 'dragStart' | 'dragMove' | 'dragEnd'>;
  onDragStart?(): void;
  onDragEnd?(): void;
}): JSX.Element {
  // Отпускание, отмена жеста и потеря захвата заканчивают перетаскивание одинаково: потерянный `pointerup` не должен
  // оставить main в «тащим» (повторный `dragEnd` main отбрасывает — отпускание само снимает захват).
  const end = (event: { screenX: number; screenY: number }): void => {
    api.dragEnd({ screenX: event.screenX, screenY: event.screenY });
    onDragEnd?.();
  };
  return (
    <span
      data-testid="island-drag"
      title={S.island.drag}
      aria-label={S.island.drag}
      role="separator"
      className="cursor-grab select-none px-1 text-muted-foreground active:cursor-grabbing"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        api.dragStart({ screenX: event.screenX, screenY: event.screenY });
        onDragStart?.();
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) api.dragMove({ screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      ⠿
    </span>
  );
}
