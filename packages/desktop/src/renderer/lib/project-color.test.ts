/**
 * Цвет проекта — хеш `projectPath` по ступеням 400 палитры Organic (спека окна 2026-09-29, раздел 4,
 * «Цвет проекта»): `accent-400`, `accent-2-400`, `neutral-400`. Цвет — выражение `var(--color-…)`, а не
 * hex: в тёмной теме рампы перевёрнуты, и ступень сама подстраивается под тему.
 */

import { describe, expect, it } from 'vitest';
import { PROJECT_COLORS, projectColor } from './project-color.js';

describe('projectColor', () => {
  it('три ступени 400 палитры Organic: accent, accent-2, neutral', () => {
    expect(PROJECT_COLORS).toEqual(['var(--color-accent-400)', 'var(--color-accent-2-400)', 'var(--color-neutral-400)']);
  });

  it('детерминирован и даёт цвет из палитры', () => {
    const path = '/Users/me/Projects/VoiceStudio';
    expect(projectColor(path)).toBe(projectColor(path));
    expect(PROJECT_COLORS).toContain(projectColor(path));
    expect(PROJECT_COLORS).toContain(projectColor(''));
  });

  it('800 путей /p/<i> дают каждый цвет от 200 до 330 раз', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 800; i += 1) {
      const color = projectColor(`/p/${i}`);
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    for (const color of PROJECT_COLORS) {
      const count = counts.get(color) ?? 0;
      expect(count).toBeGreaterThanOrEqual(200);
      expect(count).toBeLessThanOrEqual(330);
    }
  });
});
