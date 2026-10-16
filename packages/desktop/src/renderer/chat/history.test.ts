/** История поля Chat (спека 2026-10-16, 3.2): новые первыми, одинаковые подряд — одно, края обрезаны, пустых нет. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { promptHistory } from './history.js';

const AT = '2026-10-16T10:00:00.000Z';
const prompt = (id: string, text: string): FeedItem => ({ id, at: AT, kind: 'prompt', text, images: 0 });
const turn = (id: string): FeedItem => ({ id, at: AT, kind: 'turn', durationMs: 1 });

describe('promptHistory', () => {
  it('промпты ленты и ждущие — новые первыми, ждущие новее ленты', () => {
    expect(promptHistory([prompt('a', 'one'), turn('t'), prompt('b', 'two')], ['three'])).toEqual(['three', 'two', 'one']);
  });

  it('одинаковые подряд схлопываются, не подряд — остаются', () => {
    expect(promptHistory([prompt('a', 'x'), prompt('b', 'x'), prompt('c', 'y'), prompt('d', 'x')], [])).toEqual(['x', 'y', 'x']);
  });

  it('края обрезаны, пустые пропущены', () => {
    expect(promptHistory([prompt('a', '\n  hi \n'), prompt('b', '   ')], [''])).toEqual(['hi']);
  });
});
