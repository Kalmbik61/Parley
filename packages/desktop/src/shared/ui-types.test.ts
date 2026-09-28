import { describe, expect, it } from 'vitest';
import { DEFAULT_UI, fitRightSidebar, LEFT_SIDEBAR, normalizeUi, RIGHT_SIDEBAR } from './ui-types.js';

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

// Раунд main-r2, п. 7 (ревью 7.2-A, Important 3): центр — не меньше reserveCenter.
describe('fitRightSidebar', () => {
  it('влезает — сохранённая ширина, предел — окно − левый − reserveCenter', () => {
    expect(fitRightSidebar(350, 1400, 280)).toEqual({ width: 350, max: 800 });
  });

  it('не влезает сохранённая — ужимается до предела, но не ниже min', () => {
    expect(fitRightSidebar(500, 900, 280)).toEqual({ width: 300, max: 300 });
    expect(fitRightSidebar(350, 820, 280)).toEqual({ width: 220, max: 220 });
  });

  it('не влезает и min — null (скрыт на время): 800 px, левый 280', () => {
    expect(fitRightSidebar(350, 800, 280)).toBeNull();
  });

  it('левый закрыт (0) — место есть и на 800 px', () => {
    expect(fitRightSidebar(350, 800, 0)).toEqual({ width: 350, max: 480 });
  });
});
