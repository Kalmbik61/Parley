/** `turnActive`: тот же вывод, что и у окна (его тесты — `desktop/.../feed-model.test.ts`), здесь — опорные случаи. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from './types.js';
import { turnActive } from './turn.js';

const prompt = (text: string): FeedItem => ({ id: `p:${text}`, at: '2026-10-02T10:00:00.000Z', kind: 'prompt', text, images: 0 });
const turn: FeedItem = { id: 't', at: '2026-10-02T10:00:05.000Z', kind: 'turn', durationMs: 5000 };

describe('turnActive', () => {
  it('a retry keeps the turn active, while a terminal API error ends it', () => {
    const retry: FeedItem = {
      id: 'retry', at: turn.at, kind: 'error', error: '429', message: 'Usage limit reached',
      retry: { delayMs: 8000, attempt: 6, maxAttempts: 10 },
    };
    expect(turnActive([prompt('hello'), retry])).toBe(true);
    expect(turnActive([prompt('hello'), retry, turn])).toBe(false);
    const failed: FeedItem = { id: 'failed', at: turn.at, kind: 'error', error: '429', message: 'Usage limit reached' };
    expect(turnActive([prompt('hello'), retry, failed])).toBe(false);
  });
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
