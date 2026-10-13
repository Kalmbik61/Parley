/**
 * Место острова у верхнего края монитора (спека острова, разделы 3–5.1): чистые функции без Electron, в DIP.
 * Признак чёлки — встроенный дисплей со строкой меню не ниже `NOTCH_MENU_BAR_MIN` (у MacBook с вырезом 38 px,
 * у внешнего монитора 25 px): API безопасной зоны у Electron нет. Отступ — на всю высоту строки меню, чтобы
 * содержимое острова начиналось ниже физического выреза.
 */

import type { IslandAnchor } from '../../shared/ui-types.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** То, что острову нужно от `Electron.Display`. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  workArea: Rect;
  internal: boolean;
}

export interface IslandPlacement {
  displayId: number | null;
  anchor: IslandAnchor;
}

export interface Size {
  width: number;
  height: number;
}

/** Поле от бокового края монитора у левой и правой точки. */
export const ISLAND_MARGIN = 12;
const NOTCH_MENU_BAR_MIN = 32;

export function notchInset(display: DisplayLike): number {
  const menuBar = display.workArea.y - display.bounds.y;
  return display.internal && menuBar >= NOTCH_MENU_BAR_MIN ? menuBar : 0;
}

/** Сохранённый монитор; пропал — основной; нет и его — первый из списка. */
export function resolveDisplay(displays: readonly DisplayLike[], primaryId: number, displayId: number | null): DisplayLike {
  const found = displays.find((display) => display.id === displayId) ?? displays.find((display) => display.id === primaryId);
  const result = found ?? displays[0];
  if (result === undefined) throw new Error('no displays');
  return result;
}

export function islandBounds(display: DisplayLike, anchor: IslandAnchor, size: Size): Rect {
  const { bounds } = display;
  const width = Math.min(size.width, bounds.width);
  const x =
    anchor === 'left'
      ? bounds.x + ISLAND_MARGIN
      : anchor === 'right'
        ? bounds.x + bounds.width - width - ISLAND_MARGIN
        : Math.round(bounds.x + (bounds.width - width) / 2);
  return { x, y: bounds.y, width, height: size.height };
}

/** Точка по месту отпускания: трети ширины монитора. */
export function snapAnchor(display: DisplayLike, screenX: number): IslandAnchor {
  const relative = (screenX - display.bounds.x) / display.bounds.width;
  if (relative < 1 / 3) return 'left';
  if (relative > 2 / 3) return 'right';
  return 'center';
}

/** Монитор, в котором точка; вне всех — ближайший (как `screen.getDisplayNearestPoint`). */
export function displayAt(displays: readonly DisplayLike[], x: number, y: number): DisplayLike {
  let best: DisplayLike | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { bounds } = display;
    const nearestX = Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - 1);
    const nearestY = Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - 1);
    const distance = (x - nearestX) ** 2 + (y - nearestY) ** 2;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  if (best === undefined) throw new Error('no displays');
  return best;
}
