// packages/desktop/src/main/browser/guest-data.ts
/**
 * Разбор данных из скриптов страницы (`guest-pick.js`, `guest-annotate.js`) и из ответов CDP: всё это данные
 * недоверенной страницы, поэтому форма проверяется, а длины режутся здесь, до окна. Помощники переехали из
 * `design-mode.ts` (кусок 9.3a): ими же пользуются аннотации и React (этап B).
 */

import type { Rect } from '../../shared/browser-types.js';

export type Point = { x: number; y: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Первые `limit` кодовых точек (ленивая, не раскладывает строку целиком): общая с окном — `shared/code-points.ts`. */
export { cutCodePoints } from '../../shared/code-points.js';

export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function readRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

export function readPoint(value: unknown): Point | null {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y)) return null;
  return { x: value.x, y: value.y };
}

/** Точка для `DOM.getNodeForLocation`: координаты документа — точка вьюпорта плюс прокрутка (спайк 0.4, 0.6). */
export function documentPoint(point: Point | null, scroll: Point): Point | null {
  return point === null ? null : { x: point.x + scroll.x, y: point.y + scroll.y };
}
