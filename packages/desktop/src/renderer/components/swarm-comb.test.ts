/** Иконка «Соты из капель» (спека роя v1, 7.5): раскладка, форма ячейки, реакции по времени и кадр без холста. */

import { describe, expect, it, vi } from 'vitest';
import { combLayout, createCombIcon, sdHex, type CombTheme } from './swarm-comb.js';

describe('combLayout', () => {
  it('столько ячеек, сколько просят, от 1 до 7; вне границ — прижато', () => {
    for (let count = 1; count <= 7; count += 1) expect(combLayout(count, 32).pos).toHaveLength(count);
    expect(combLayout(0, 32).pos).toHaveLength(1);
    expect(combLayout(12, 32).pos).toHaveLength(7);
  });

  it('все ячейки целиком внутри холста, в любом размере', () => {
    for (const size of [14, 16, 24, 32, 112]) {
      for (let count = 1; count <= 7; count += 1) {
        const { a, pos } = combLayout(count, size);
        expect(a).toBeGreaterThan(0);
        for (const [x, y] of pos) {
          // Шестиугольник вершиной вверх: полуширина — апофема, полувысота — до вершины.
          expect(x - a).toBeGreaterThanOrEqual(-1e-9);
          expect(x + a).toBeLessThanOrEqual(size + 1e-9);
          expect(y - a / 0.8660254).toBeGreaterThanOrEqual(-1e-9);
          expect(y + a / 0.8660254).toBeLessThanOrEqual(size + 1e-9);
        }
      }
    }
  });

  it('растёт кучно: первая ячейка в центре холста', () => {
    expect(combLayout(1, 40).pos[0]).toEqual([20, 20]);
  });
});

describe('sdHex', () => {
  it('на середине грани — около нуля, в центре — минус, у вершины — плюс (угол скруглён)', () => {
    const a = 10;
    expect(Math.abs(sdHex(a, 0, a))).toBeLessThan(0.05);
    expect(sdHex(0, 0, a)).toBeLessThan(0);
    // Вершина настоящего шестиугольника вершиной вверх — (0, -a/0.866): мягкая форма её срезает.
    expect(sdHex(0, -a / 0.8660254, a)).toBeGreaterThan(0);
  });
});

const T0 = 10_000;
const make = (theme: CombTheme = 'dark') => createCombIcon({ size: 16, theme });

describe('set и needsFrame', () => {
  it('первый set и смена total реакций не дают', () => {
    const icon = make();
    icon.set({ status: 'running', handed: 1, total: 3 }, T0);
    expect(icon.needsFrame(T0)).toBe(false);
    icon.set({ status: 'running', handed: 1, total: 5 }, T0 + 5000);
    expect(icon.needsFrame(T0 + 5000)).toBe(false);
    icon.set({ status: 'running', handed: 4, total: 5 }, T0 + 6000);
    // Рост handed при том же total — реакция; а при смене total вместе с handed её не было.
    expect(icon.needsFrame(T0 + 6000)).toBe(true);
  });

  it('рост handed держит кадры около 1,45 с', () => {
    const icon = make();
    icon.set({ status: 'running', handed: 0, total: 3 }, T0);
    icon.set({ status: 'running', handed: 1, total: 3 }, T0 + 1000);
    expect(icon.needsFrame(T0 + 1000)).toBe(true);
    expect(icon.needsFrame(T0 + 1000 + 1400)).toBe(true);
    expect(icon.needsFrame(T0 + 1000 + 1500)).toBe(false);
  });

  it('done держит кадры 1,6 с', () => {
    const icon = make();
    icon.set({ status: 'collecting', handed: 3, total: 3 }, T0);
    icon.set({ status: 'done', handed: 3, total: 3 }, T0 + 1000);
    expect(icon.needsFrame(T0 + 1000 + 1500)).toBe(true);
    expect(icon.needsFrame(T0 + 1000 + 1650)).toBe(false);
  });

  it('done без сдачи всех: ячейки дозаполняются, кадры идут те же 1,6 с', () => {
    const icon = make();
    icon.set({ status: 'running', handed: 1, total: 3 }, T0);
    icon.set({ status: 'done', handed: 1, total: 3 }, T0 + 1000);
    expect(icon.needsFrame(T0 + 1000 + 1500)).toBe(true);
    expect(icon.needsFrame(T0 + 1000 + 1700)).toBe(false);
  });

  it('failed, cancelled и показ done с самого начала — без движения', () => {
    for (const status of ['failed', 'cancelled', 'done'] as const) {
      const icon = make();
      icon.set({ status, handed: 1, total: 3 }, T0);
      expect(icon.needsFrame(T0)).toBe(false);
    }
    const icon = make();
    icon.set({ status: 'running', handed: 1, total: 3 }, T0);
    icon.set({ status: 'failed', handed: 1, total: 3 }, T0 + 500);
    expect(icon.needsFrame(T0 + 500)).toBe(false);
  });
});

/** Холст, который принимает любые вызовы 2d-контекста и помнит, какие из них нужны проверке. */
function fakeContext(size: number): { ctx: CanvasRenderingContext2D; calls: string[]; canvas: { width: number; height: number } } {
  const calls: string[] = [];
  const canvas = { width: size, height: size };
  const target: Record<string, unknown> = { canvas };
  const ctx = new Proxy(target, {
    get: (object, key: string) => {
      if (key in object) return object[key];
      return (...args: unknown[]) => {
        calls.push(key === 'drawImage' && args[0] === canvas ? 'flash:drawImage' : key === 'fillRect' ? 'flash:fillRect' : key);
        return key === 'createLinearGradient' ? { addColorStop: () => undefined } : undefined;
      };
    },
    set: (object, key: string, value: unknown) => {
      object[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, canvas };
}

describe('frame', () => {
  it('без контекста ничего не рисует и не падает', () => {
    const icon = make();
    expect(() => icon.frame(null, T0, false)).not.toThrow();
    icon.set({ status: 'running', handed: 0, total: 3 }, T0);
    expect(() => icon.frame(null, T0 + 100, true)).not.toThrow();
  });

  it('до первого set кадр пуст', () => {
    const icon = make();
    const { ctx, calls } = fakeContext(16);
    icon.frame(ctx, T0, false);
    expect(calls).toEqual([]);
  });

  it('reduce motion: вспышка яркости 300 мс вместо реакции (тёмная — слоем «lighter», светлая — заливкой)', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) });
    try {
      for (const theme of ['dark', 'light'] as const) {
        const icon = make(theme);
        icon.set({ status: 'running', handed: 0, total: 3 }, T0);
        icon.set({ status: 'running', handed: 1, total: 3 }, T0 + 1000);
        const mark = theme === 'dark' ? 'flash:drawImage' : 'flash:fillRect';
        const during = fakeContext(16);
        icon.frame(during.ctx, T0 + 1150, true);
        expect(during.calls).toContain(mark);
        const after = fakeContext(16);
        icon.frame(after.ctx, T0 + 1400, true);
        expect(after.calls).not.toContain(mark);
        // Без reduce motion вспышки нет: реакцию рисует само движение.
        const moving = fakeContext(16);
        icon.frame(moving.ctx, T0 + 1150, false);
        expect(moving.calls).not.toContain(mark);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
