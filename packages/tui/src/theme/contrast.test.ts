import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { PALETTES } from './palettes.js';

describe('формула', () => {
  it('чёрный на белом — 21:1, тот же цвет на себе — 1:1 (сверка с WCAG)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('порядок аргументов не важен — отношение симметрично', () => {
    expect(contrastRatio('#1e1e2e', '#cdd6f4')).toBeCloseTo(contrastRatio('#cdd6f4', '#1e1e2e'), 10);
  });
});

describe('проверка действительно падает на плохой паре', () => {
  it('чёрный на чёрном не проходит ни 4.5:1, ни 3:1 — иначе тест ничего не стоит', () => {
    const r = contrastRatio('#000000', '#000000');
    expect(r).toBeLessThan(3);
    expect(r).toBeLessThan(4.5);
  });

  it('почти неразличимые серые не проходят 4.5:1', () => {
    expect(contrastRatio('#808080', '#828282')).toBeLessThan(4.5);
  });
});

describe('контраст палитр (приёмка задачи A, дизайн 7.2)', () => {
  // Текст против фонов зон: bg.panel=base, bg.sidebar=mantle,
  // bg.overlay=crust (таблица 3.2). Выбранный ряд — отдельным блоком ниже.
  const backgrounds: Array<{ name: string; slot: 'base' | 'mantle' | 'crust' }> = [
    { name: 'bg.panel', slot: 'base' },
    { name: 'bg.sidebar', slot: 'mantle' },
    { name: 'bg.overlay', slot: 'crust' },
  ];
  // fg.default, fg.second — тело: не ниже 4.5:1 против base/mantle/crust.
  const bodySlots: Array<{ name: string; slot: 'text' | 'subtext' }> = [
    { name: 'fg.default', slot: 'text' },
    { name: 'fg.second', slot: 'subtext' },
  ];
  // fg.accent и три status.* — не ниже 3:1 против всех четырёх фонов.
  const lowSlots: Array<{ name: string; slot: 'magenta' | 'green' | 'yellow' | 'red' }> = [
    { name: 'fg.accent', slot: 'magenta' },
    { name: 'status.live', slot: 'green' },
    { name: 'status.warn', slot: 'yellow' },
    { name: 'status.fail', slot: 'red' },
  ];

  for (const [paletteName, palette] of Object.entries(PALETTES)) {
    describe(paletteName, () => {
      for (const bg of backgrounds) {
        for (const fg of bodySlots) {
          it(`${fg.name} против ${bg.name} не ниже 4.5:1`, () => {
            expect(contrastRatio(palette[fg.slot], palette[bg.slot])).toBeGreaterThanOrEqual(4.5);
          });
        }
        // fg.muted — мета (время, токены, pending), не тело: порог ниже, но
        // одинаковый на всех трёх фонах.
        it(`fg.muted против ${bg.name} не ниже 3:1`, () => {
          expect(contrastRatio(palette.muted, palette[bg.slot])).toBeGreaterThanOrEqual(3);
        });
        for (const fg of lowSlots) {
          it(`${fg.name} против ${bg.name} не ниже 3:1`, () => {
            expect(contrastRatio(palette[fg.slot], palette[bg.slot])).toBeGreaterThanOrEqual(3);
          });
        }
      }

      // Выбранный ряд (bg.selection = selection): тело читается как на
      // полотне, мета рисуется fg.second, а не fg.muted, поэтому fg.muted здесь
      // не проверяется. Статусы и акцент — 3:1, кроме красного: `✗` читается
      // формой, ему хватает 2:1. Точка `unseen` (blue) отличается от `idle`
      // только цветом — ей тоже 3:1.
      describe('bg.selection', () => {
        it('fg.default не ниже 4.5:1, fg.second не ниже 3:1', () => {
          expect(contrastRatio(palette.text, palette.selection)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(palette.subtext, palette.selection)).toBeGreaterThanOrEqual(3);
        });
        for (const slot of ['magenta', 'green', 'yellow', 'blue'] as const) {
          it(`${slot} не ниже 3:1`, () => {
            expect(contrastRatio(palette[slot], palette.selection)).toBeGreaterThanOrEqual(3);
          });
        }
        it('red (✗ failed) не ниже 2:1', () => {
          expect(contrastRatio(palette.red, palette.selection)).toBeGreaterThanOrEqual(2);
        });
      });
    });
  }
});

describe('иерархия ступеней text → subtext → muted (приёмка задачи A)', () => {
  // Три ступени текста не должны сливаться в одну и ту же видимую яркость:
  // если fg.second неотличим от fg.default или fg.muted неотличим от
  // fg.second, роль текста перестаёт читаться глазом, хотя формально каждая
  // по отдельности проходит свой порог против фона.
  for (const [paletteName, palette] of Object.entries(PALETTES)) {
    it(`${paletteName}: text/subtext и subtext/muted — не ниже 1.2:1`, () => {
      expect(contrastRatio(palette.text, palette.subtext)).toBeGreaterThanOrEqual(1.2);
      expect(contrastRatio(palette.subtext, palette.muted)).toBeGreaterThanOrEqual(1.2);
    });
  }

  it('инвариант действительно падает, когда subtext и muted совпадают — иначе он ничего не стоит', () => {
    const broken = { ...PALETTES.mocha, subtext: '#a6adc8', muted: '#a6adc8' };
    expect(contrastRatio(broken.subtext, broken.muted)).toBeLessThan(1.2);
  });
});
