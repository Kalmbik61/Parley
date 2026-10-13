/**
 * Ручка перетаскивания острова (спайк 2026-10-12): точку курсора на экране шлёт main, тот двигает окно вдоль верхнего
 * края монитора под курсором и при отпускании прилепляет. Захват указателя держит события, когда курсор уходит за
 * пределы маленького окна.
 */

import { S } from '../../shared/strings.js';
import type { IslandApi } from '../../shared/island.js';

export function DragHandle({ api }: { api: Pick<IslandApi, 'dragStart' | 'dragMove' | 'dragEnd'> }): JSX.Element {
  return (
    <span
      data-testid="island-drag"
      title={S.island.drag}
      aria-label={S.island.drag}
      role="separator"
      className="cursor-grab select-none px-1 text-neutral-400 active:cursor-grabbing"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        api.dragStart({ screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) api.dragMove({ screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerUp={(event) => api.dragEnd({ screenX: event.screenX, screenY: event.screenY })}
    >
      ⠿
    </span>
  );
}
