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
  // bg.overlay=crust, bg.selection=surface (таблица 3.2).
  const backgrounds: Array<{ name: string; slot: 'base' | 'mantle' | 'crust' | 'surface' }> = [
    { name: 'bg.panel', slot: 'base' },
    { name: 'bg.sidebar', slot: 'mantle' },
    { name: 'bg.overlay', slot: 'crust' },
    { name: 'bg.selection', slot: 'surface' },
  ];
  // fg.default, fg.second — тело: не ниже 4.5:1 против base/mantle/crust,
  // не ниже 3:1 против surface (выбранный ряд — не место для мелкого текста,
  // но это не мета).
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
        const bodyMin = bg.slot === 'surface' ? 3 : 4.5;
        for (const fg of bodySlots) {
          it(`${fg.name} против ${bg.name} не ниже ${bodyMin}:1`, () => {
            expect(contrastRatio(palette[fg.slot], palette[bg.slot])).toBeGreaterThanOrEqual(bodyMin);
          });
        }
        // fg.muted — мета (время, токены, pending), не тело: порог ниже, но
        // одинаковый на всех четырёх фонах, включая выбранный ряд.
        it(`fg.muted против ${bg.name} не ниже 3:1`, () => {
          expect(contrastRatio(palette.muted, palette[bg.slot])).toBeGreaterThanOrEqual(3);
        });
        for (const fg of lowSlots) {
          it(`${fg.name} против ${bg.name} не ниже 3:1`, () => {
            expect(contrastRatio(palette[fg.slot], palette[bg.slot])).toBeGreaterThanOrEqual(3);
          });
        }
      }
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
