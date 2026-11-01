import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { mergedWith, visibleOut, type OutMessage } from './outbox';

const prompt = (text: string, at: string): FeedItem => ({ kind: 'prompt', id: 'p', at, text, images: 0 });
const T = Date.parse('2026-11-01T10:00:00.000Z');
const msg = (state: OutMessage['state'], text = 'go'): OutMessage => ({ id: 'k-12345678', text, at: T, state });

describe('outbox', () => {
  it('a sent message merges into the feed prompt with the same text after the call — never two bubbles', () => {
    const items = [prompt('go', '2026-11-01T10:00:02.000Z')];
    expect(mergedWith(msg({ kind: 'sent' }), items)).toBe(true);
    expect(visibleOut([msg({ kind: 'sent' })], items)).toEqual([]);
    expect(mergedWith(msg({ kind: 'queued' }), items)).toBe(true);
    expect(mergedWith(msg({ kind: 'unconfirmed' }), items)).toBe(true);
  });

  it('an older prompt with the same text is not ours; other text does not merge', () => {
    expect(mergedWith(msg({ kind: 'sent' }), [prompt('go', '2026-11-01T09:00:00.000Z')])).toBe(false);
    expect(mergedWith(msg({ kind: 'sent' }), [prompt('other', '2026-11-01T10:00:02.000Z')])).toBe(false);
  });

  it('sending and failed messages stay', () => {
    const items = [prompt('go', '2026-11-01T10:00:02.000Z')];
    expect(mergedWith(msg({ kind: 'sending' }), items)).toBe(false);
    expect(mergedWith(msg({ kind: 'failed', message: 'x', retry: true, edit: false, textBack: false, hideComposer: false }), items)).toBe(false);
  });
});
