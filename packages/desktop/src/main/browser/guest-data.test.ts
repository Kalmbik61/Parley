import { describe, expect, it } from 'vitest';
import { cutCodePoints, documentPoint, finite, isRecord, readPoint, readRect } from './guest-data.js';

describe('guest-data — разбор данных страницы', () => {
  it('readPoint: конечные x и y — точка без лишних полей; всё остальное — null', () => {
    expect(readPoint({ x: 10.5, y: 0, extra: 'x' })).toEqual({ x: 10.5, y: 0 });
    for (const value of [null, 'x', [], {}, { x: 1 }, { x: 1, y: '2' }, { x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }]) {
      expect(readPoint(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('documentPoint: точка вьюпорта плюс прокрутка (координаты документа для DOM.getNodeForLocation); нет точки — нет и результата', () => {
    expect(documentPoint({ x: 10, y: 20 }, { x: 5, y: 300 })).toEqual({ x: 15, y: 320 });
    expect(documentPoint({ x: 10, y: 20 }, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(documentPoint(null, { x: 5, y: 300 })).toBeNull();
  });

  it('помощники, переехавшие из design-mode.ts: isRecord, finite, readRect, cutCodePoints — как были', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(finite(1)).toBe(true);
    expect(finite(Number.NaN)).toBe(false);
    expect(finite('1')).toBe(false);
    expect(readRect({ x: 1, y: 2, width: 3, height: 4, z: 5 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(readRect({ x: 1, y: 2, width: -1, height: 4 })).toBeNull();
    expect(cutCodePoints('😀😀😀', 2)).toEqual({ text: '😀😀', cut: true });
    expect(cutCodePoints('abc', 3)).toEqual({ text: 'abc', cut: false });
  });
});
