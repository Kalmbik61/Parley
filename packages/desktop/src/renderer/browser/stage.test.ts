import { describe, expect, it } from 'vitest';
import { fitArea, panelHeight, stageBox } from './stage.js';

describe('поле страницы при эмуляции (спека 4.2)', () => {
  it('fitArea: без полей 16 px и строки подписи 20 px; не меньше 1×1', () => {
    expect(fitArea({ width: 800, height: 600 })).toEqual({ width: 768, height: 548 });
    expect(fitArea({ width: 10, height: 10 })).toEqual({ width: 1, height: 1 });
  });

  it('stageBox: Mobile M 2x со scale 0.5 — 187×406 по центру, в подписи процент', () => {
    expect(stageBox({ width: 800, height: 600 }, { preset: 'mobile-m', rotated: false, dpr: 2 }, 0.5)).toEqual({
      left: 307,
      top: 107,
      width: 187,
      height: 406,
      label: '375 × 812 · 2x · 50%',
    });
  });

  it('stageBox: влезает целиком — без процента', () => {
    expect(stageBox({ width: 1600, height: 1000 }, { preset: 'laptop', rotated: false, dpr: 1 }, 1)).toMatchObject({
      left: 160,
      width: 1280,
      height: 800,
      label: '1280 × 800 · 1x',
    });
  });
});

describe('высота панели (спека 4.3)', () => {
  it('по умолчанию — 40 % вкладки; не ниже 120; не выше места над страницей', () => {
    expect(panelHeight(null, 700)).toEqual({ height: 280, max: 584 });
    expect(panelHeight(50, 700)).toEqual({ height: 120, max: 584 });
    expect(panelHeight(900, 700)).toEqual({ height: 584, max: 584 });
    expect(panelHeight(null, 0)).toEqual({ height: 120, max: 120 });
  });
});
