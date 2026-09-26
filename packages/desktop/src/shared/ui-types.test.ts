import { describe, expect, it } from 'vitest';
import { DEFAULT_UI, LEFT_SIDEBAR, normalizeUi, RIGHT_SIDEBAR } from './ui-types.js';

describe('normalizeUi', () => {
  it('пустой объект → DEFAULT_UI', () => {
    expect(normalizeUi({})).toEqual(DEFAULT_UI);
  });

  it('ширина левого сайдбара приводится к пределам 220–500', () => {
    expect(normalizeUi({ leftSidebar: { width: 9999 } }).leftSidebar.width).toBe(500);
    expect(normalizeUi({ leftSidebar: { width: 10 } }).leftSidebar.width).toBe(220);
  });

  it('неизвестный appearance → system', () => {
    expect(normalizeUi({ appearance: 'blue' }).appearance).toBe('system');
  });

  it('лишний ключ верхнего уровня выкинут', () => {
    const result = normalizeUi({ mystery: 'value' }) as UiFileWithMystery;
    expect(result.mystery).toBeUndefined();
    expect(result).toEqual(DEFAULT_UI);
  });

  // Тест 11 раунда исправлений: граница — инвариант по диапазону, не одно число.
  // `Math.max/min` с NaN-аргументом дают NaN (спецификация ECMA) — раньше
  // `normalizeUi` пропускала NaN/±Infinity в клапан пределов как есть.
  it('ширина левого сайдбара — всегда конечное число в 220–500 (тест 11)', () => {
    const garbage: unknown[] = [NaN, Infinity, -Infinity, '300', null, undefined, {}, []];
    for (const value of garbage) {
      const width = normalizeUi({ leftSidebar: { width: value } }).leftSidebar.width;
      expect(Number.isFinite(width), `width для ${String(value)}`).toBe(true);
      expect(width).toBeGreaterThanOrEqual(LEFT_SIDEBAR.min);
      expect(width).toBeLessThanOrEqual(LEFT_SIDEBAR.max);
    }
    for (let value = -1_000_000_000; value <= 1_000_000_000; value += 137_000_000) {
      const width = normalizeUi({ leftSidebar: { width: value } }).leftSidebar.width;
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(LEFT_SIDEBAR.min);
      expect(width).toBeLessThanOrEqual(LEFT_SIDEBAR.max);
    }
  });

  it('ширина правого сайдбара — всегда конечное число ≥ 220 (тест 11)', () => {
    const garbage: unknown[] = [NaN, Infinity, -Infinity, '300', null, undefined, {}, []];
    for (const value of garbage) {
      const width = normalizeUi({ rightSidebar: { width: value } }).rightSidebar.width;
      expect(Number.isFinite(width), `width для ${String(value)}`).toBe(true);
      expect(width).toBeGreaterThanOrEqual(RIGHT_SIDEBAR.min);
    }
    for (let value = -1_000_000_000; value <= 1_000_000_000; value += 137_000_000) {
      const width = normalizeUi({ rightSidebar: { width: value } }).rightSidebar.width;
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(RIGHT_SIDEBAR.min);
    }
  });
});

interface UiFileWithMystery {
  mystery?: unknown;
}
