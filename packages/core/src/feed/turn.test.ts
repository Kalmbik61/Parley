/** `turnActive`: тот же вывод, что и у окна (его тесты — `desktop/.../feed-model.test.ts`), здесь — опорные случаи. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from './types.js';
import { turnActive } from './turn.js';

const prompt = (text: string): FeedItem => ({ id: `p:${text}`, at: '2026-10-02T10:00:00.000Z', kind: 'prompt', text, images: 0 });
const turn: FeedItem = { id: 't', at: '2026-10-02T10:00:05.000Z', kind: 'turn', durationMs: 5000 };

describe('turnActive', () => {
  it('промпт без конца хода — ход идёт; после черты хода — нет', () => {
    expect(turnActive([prompt('привет')])).toBe(true);
    expect(turnActive([prompt('привет'), turn])).toBe(false);
  });

  it('слеш-команда, после которой ничего нет, хода не открывает', () => {
    expect(turnActive([prompt('привет'), turn, prompt('/model opus')])).toBe(false);
  });

  it('пустая лента — хода нет', () => {
    expect(turnActive([])).toBe(false);
  });
});
