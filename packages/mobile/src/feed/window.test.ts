import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { foldFeed } from './fold';
import { sizeToInclude, widened, windowStart, WINDOW_ROWS } from './window';

const at = '2026-11-01T10:00:00.000Z';
const prompt = (id: string): FeedItem => ({ kind: 'prompt', id, at, text: id, images: 0 });
const text = (id: string): FeedItem => ({ kind: 'text', id, at, messageId: null, text: id, streaming: false });
const tool = (id: string): FeedItem => ({ kind: 'tool', id, at, toolUseId: id, name: 'Bash', input: {}, status: 'done' });
const turn = (id: string): FeedItem => ({ kind: 'turn', id, at, durationMs: 1000 });
const none = (): number => 0;

describe('tail window', () => {
  it('shows the last `size` rows', () => {
    expect(windowStart(200, WINDOW_ROWS, none)).toBe(170);
    expect(windowStart(20, WINDOW_ROWS, none)).toBe(0);
  });

  it('prepends the next page and stops at the first row', () => {
    let size = WINDOW_ROWS;
    size = widened(200, size);
    expect(windowStart(200, size, none)).toBe(140);
    size = widened(200, 190);
    expect(size).toBe(200);
    expect(windowStart(200, size, none)).toBe(0);
  });

  it('widens to include a target row, with context', () => {
    expect(sizeToInclude(200, WINDOW_ROWS, 50)).toBe(153);
    expect(windowStart(200, sizeToInclude(200, WINDOW_ROWS, 50), none)).toBe(47);
    expect(sizeToInclude(200, WINDOW_ROWS, 190)).toBe(WINDOW_ROWS);
    expect(sizeToInclude(200, WINDOW_ROWS, 0)).toBe(200);
  });

  it('a group opened by the person never splits at the window edge', () => {
    // turn 1 is finished and closed, turn 2 is its follower: its work group is opened and lists its items
    const items = [prompt('p0'), tool('t0'), tool('t1'), text('a0'), turn('u0'), prompt('p1'), tool('t2'), tool('t3'), tool('t4'), text('a1'), turn('u1')];
    const rows = foldFeed(items, new Set(['t0']));
    const g = rows.findIndex((r) => r.kind === 'group' && r.open);
    expect(g).toBeGreaterThan(0);
    const span = (i: number): number => {
      const r = rows[i]!;
      return r.kind === 'group' && r.open ? r.items.length : 0;
    };
    // a window that would start inside the group's items starts at the group row instead
    expect(windowStart(rows.length, rows.length - (g + 2), span)).toBe(g);
    // a window that starts at the group row, or after the whole block, is left alone
    expect(windowStart(rows.length, rows.length - g, span)).toBe(g);
  });
});
