/**
 * Язычок убранного острова (итерация 2026-10-12): форма уехала вверх за кадр окна, а у верхнего края остался тонкий
 * язычок на том же месте по горизонтали (`anchorClass` — то же выравнивание, что у формы) и под чёлкой (`topInset`).
 * Видна полоска 40×5, ловит мышь невидимая область 64×16. Наведение делает окно интерактивным (иначе клик ушёл бы
 * приложению под прозрачным кадром), клик и потяжка вниз дальше `PULL_EXPAND_PX` выдвигают остров. Потяжка — не
 * перетаскивание окна: форма стоит на месте, пока язычок не выдвинет её.
 */

import { useRef } from 'react';
import { S } from '../../shared/strings.js';

/** Насколько вниз надо потянуть язычок, чтобы остров выдвинулся без клика. */
export const PULL_EXPAND_PX = 8;

export function IslandTab({
  anchorClass,
  topInset,
  onEnter,
  onLeave,
  onExpand,
}: {
  anchorClass: string;
  topInset: number;
  onEnter(): void;
  onLeave(): void;
  onExpand(): void;
}): JSX.Element {
  /** Высота курсора на экране в момент нажатия; `null` — язычок не зажат. */
  const pressY = useRef<number | null>(null);
  return (
    <div className={`absolute inset-x-0 flex ${anchorClass}`} style={{ top: topInset }}>
      <button
        type="button"
        data-testid="island-tab"
        aria-label={S.island.showIsland}
        title={S.island.showIsland}
        className="flex h-4 w-16 cursor-pointer items-start justify-center"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onExpand}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pressY.current = event.screenY;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pressY.current === null || event.screenY - pressY.current <= PULL_EXPAND_PX) return;
          pressY.current = null;
          onExpand();
        }}
        onPointerUp={() => {
          pressY.current = null;
        }}
        onPointerCancel={() => {
          pressY.current = null;
        }}
      >
        <span className="mt-0.5 h-[5px] w-10 rounded-full bg-foreground/60" />
      </button>
    </div>
  );
}
