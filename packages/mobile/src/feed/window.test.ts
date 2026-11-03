import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { foldFeed } from './fold';
import { anchorAt, anchorStart, startToInclude, TAIL, widenedStart, WINDOW_ROWS } from './window';

const at = '2026-11-01T10:00:00.000Z';
const prompt = (id: string): FeedItem => ({ kind: 'prompt', id, at, text: id, images: 0 });
const text = (id: string): FeedItem => ({ kind: 'text', id, at, messageId: null, text: id, streaming: false });
const tool = (id: string): FeedItem => ({ kind: 'tool', id, at, toolUseId: id, name: 'Bash', input: {}, status: 'done' });
const turn = (id: string): FeedItem => ({ kind: 'turn', id, at, durationMs: 1000 });
const none = (): number => 0;
const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `k${i}`);

describe('tail window', () => {
  it('opens on the last WINDOW_ROWS rows, or on all of a short feed', () => {
    expect(anchorStart(keys(200), TAIL, none)).toBe(170);
    expect(anchorStart(keys(20), TAIL, none)).toBe(0);
    expect(anchorAt(keys(20), 0)).toBe('all');
  });

  it('is anchored by the key of its first row: new rows extend it at the bottom, its top stays', () => {
    const open = anchorAt(keys(200), 170);
    expect(anchorStart(keys(200), open, none)).toBe(170);
    expect(anchorStart(keys(203), open, none)).toBe(170);
    expect(anchorStart(keys(260), open, none)).toBe(170);
  });

  it('a full-width window stays at 0 when a row is added, and a page of older rows lands in it at once', () => {
    const all = anchorAt(keys(40), 0);
    expect(anchorStart(keys(41), all, none)).toBe(0);
    const older = ['old0', 'old1', ...keys(41)]; // a server page prepended in the room
    expect(anchorStart(older, all, none)).toBe(0);
  });

  it('a vanished anchor falls back to the tail', () => {
    expect(anchorStart(keys(100), { key: 'gone' }, none)).toBe(100 - WINDOW_ROWS);
  });

  it('prepends the next page on start reached and stops at the first row', () => {
    expect(widenedStart(170, none)).toBe(140);
    expect(widenedStart(20, none)).toBe(0);
    expect(anchorAt(keys(200), widenedStart(20, none))).toBe('all');
  });

  it('widens to include a target row, with context, and leaves a target inside alone', () => {
    expect(startToInclude(170, 50, none)).toBe(47);
    expect(startToInclude(170, 180, none)).toBe(170);
    expect(startToInclude(170, 1, none)).toBe(0);
  });

  it('a group opened by the person never splits at the window edge', () => {
    const items = [prompt('p0'), tool('t0'), tool('t1'), text('a0'), turn('u0'), prompt('p1'), tool('t2'), tool('t3'), tool('t4'), text('a1'), turn('u1')];
    const rows = foldFeed(items, new Set(['t0']));
    const g = rows.findIndex((r) => r.kind === 'group' && r.open);
    expect(g).toBeGreaterThan(0);
    const span = (i: number): number => {
      const r = rows[i]!;
      return r.kind === 'group' && r.open ? r.items.length : 0;
    };
    const k = rows.map((r) => r.key);
    // an anchor inside the group's items moves up to the group row; one on it, or after the block, is left alone
    expect(anchorStart(k, { key: k[g + 2]! }, span)).toBe(g);
    expect(anchorStart(k, { key: k[g]! }, span)).toBe(g);
    expect(widenedStart(g + 2, span, 1)).toBe(g);
  });
});
