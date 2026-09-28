/** Тест 1 куска 3.3: цвет проекта (спека 4.1). */

import { describe, expect, it } from 'vitest';
import { PROJECT_COLORS, projectColor } from './project-color.js';

describe('projectColor', () => {
  it('восемь цветов REPO_COLORS Orca в порядке спеки 4.1', () => {
    expect(PROJECT_COLORS).toEqual(['#737373', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#8b5cf6', '#ec4899']);
  });

  it('детерминирован и даёт цвет из восьми', () => {
    const path = '/Users/me/Projects/VoiceStudio';
    expect(projectColor(path)).toBe(projectColor(path));
    expect(PROJECT_COLORS).toContain(projectColor(path));
    expect(PROJECT_COLORS).toContain(projectColor(''));
  });

  it('800 путей /p/<i> дают каждый цвет от 60 до 140 раз', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 800; i += 1) {
      const color = projectColor(`/p/${i}`);
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    for (const color of PROJECT_COLORS) {
      const count = counts.get(color) ?? 0;
      expect(count).toBeGreaterThanOrEqual(60);
      expect(count).toBeLessThanOrEqual(140);
    }
  });
});
