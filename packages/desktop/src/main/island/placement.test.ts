import { describe, expect, it } from 'vitest';
import { displayAt, islandBounds, notchInset, resolveDisplay, snapAnchor, type DisplayLike } from './placement.js';

const EXTERNAL: DisplayLike = {
  id: 3,
  bounds: { x: 0, y: 0, width: 3440, height: 1440 },
  workArea: { x: 0, y: 25, width: 3440, height: 1415 },
  internal: false,
};
const MACBOOK: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 1440, width: 1512, height: 982 },
  workArea: { x: 0, y: 1478, width: 1512, height: 944 },
  internal: true,
};
const DISPLAYS = [EXTERNAL, MACBOOK];

describe('остров: место у верхнего края', () => {
  it('чёлка — встроенный экран со строкой меню 38 px; у внешнего 25 px отступа нет', () => {
    expect(notchInset(MACBOOK)).toBe(38);
    expect(notchInset(EXTERNAL)).toBe(0);
  });

  it('встроенный экран без чёлки (строка меню 24 px) — без отступа', () => {
    expect(notchInset({ ...MACBOOK, workArea: { ...MACBOOK.workArea, y: 1464 } })).toBe(0);
  });

  it('центр, левый и правый край — верхний край монитора, поля 12 px', () => {
    const size = { width: 380, height: 150 };
    expect(islandBounds(EXTERNAL, 'center', size)).toEqual({ x: 1530, y: 0, width: 380, height: 150 });
    expect(islandBounds(EXTERNAL, 'left', size)).toEqual({ x: 12, y: 0, width: 380, height: 150 });
    expect(islandBounds(EXTERNAL, 'right', size)).toEqual({ x: 3048, y: 0, width: 380, height: 150 });
    expect(islandBounds(MACBOOK, 'center', size)).toEqual({ x: 566, y: 1440, width: 380, height: 150 });
  });

  it('остров шире монитора — ширина режется по монитору', () => {
    expect(islandBounds(MACBOOK, 'center', { width: 4000, height: 40 }).width).toBe(1512);
  });

  it('остров шире монитора у левой и правой точки — поля входят в ширину, окно не вылезает за край', () => {
    expect(islandBounds(MACBOOK, 'right', { width: 4000, height: 40 })).toEqual({ x: 12, y: 1440, width: 1512 - 24, height: 40 });
    expect(islandBounds(MACBOOK, 'left', { width: 4000, height: 40 })).toEqual({ x: 12, y: 1440, width: 1512 - 24, height: 40 });
  });

  it('прилипание по третям ширины монитора', () => {
    expect(snapAnchor(EXTERNAL, 100)).toBe('left');
    expect(snapAnchor(EXTERNAL, 1720)).toBe('center');
    expect(snapAnchor(EXTERNAL, 3400)).toBe('right');
    expect(snapAnchor(MACBOOK, 1400)).toBe('right');
  });

  it('сохранённый монитор пропал — основной; основного нет в списке — первый', () => {
    expect(resolveDisplay(DISPLAYS, 3, 1)).toBe(MACBOOK);
    expect(resolveDisplay(DISPLAYS, 3, 99)).toBe(EXTERNAL);
    expect(resolveDisplay(DISPLAYS, 3, null)).toBe(EXTERNAL);
    expect(resolveDisplay([MACBOOK], 3, 99)).toBe(MACBOOK);
  });

  it('монитор под курсором; курсор между мониторами — ближайший', () => {
    expect(displayAt(DISPLAYS, 700, 1500)).toBe(MACBOOK);
    expect(displayAt(DISPLAYS, 2000, 10)).toBe(EXTERNAL);
    expect(displayAt(DISPLAYS, 1600, 1600)).toBe(MACBOOK);
  });
});
