import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { foldFeed, groupTitle, turnStatusText } from './fold';

const at = '2026-11-01T10:00:00.000Z';
const prompt = (id: string): FeedItem => ({ kind: 'prompt', id, at, text: id, images: 0 });
const text = (id: string): FeedItem => ({ kind: 'text', id, at, messageId: null, text: id, streaming: false });
const tool = (id: string, name: string): FeedItem => ({ kind: 'tool', id, at, toolUseId: id, name, input: {}, status: 'done' });
const turn = (id: string, durationMs = 372_000): FeedItem => ({ kind: 'turn', id, at, durationMs });

describe('foldFeed', () => {
  it('a finished turn after a closed one folds to prompt, work row, last reply and status', () => {
    const rows = foldFeed([prompt('p1'), tool('t1', 'Read'), tool('t2', 'Bash'), tool('t3', 'Bash'), text('answer'), turn('u1'), prompt('p2'), text('live')], new Set());
    expect(rows.map((r) => r.kind)).toEqual(['item', 'group', 'item', 'control', 'item', 'item']);
    const group = rows.find((r) => r.kind === 'group');
    expect(group).toMatchObject({ count: 3, title: 'Ran commands, read files', open: false });
    expect(rows[2]).toMatchObject({ kind: 'item', key: 'answer' });
  });

  it('a running turn stays open; an opened group lists its items', () => {
    const items = [prompt('p1'), tool('t1', 'Bash'), text('x')];
    expect(foldFeed(items, new Set()).map((r) => r.kind)).toEqual(['item', 'item', 'item']);
    const done = [prompt('p1'), tool('t1', 'Bash'), text('a'), turn('u')];
    expect(foldFeed(done, new Set(['t1'])).filter((r) => r.kind === 'item').map((r) => (r as { key: string }).key)).toEqual(['p1', 't1', 'a']);
  });

  it('titles and status text', () => {
    expect(groupTitle([text('a')]).title).toBe('Wrote replies');
    expect(turnStatusText('completed', 372_000)).toBe('Completed in 6m 12s');
    expect(turnStatusText('stopped', null)).toBe('Stopped');
  });
});
