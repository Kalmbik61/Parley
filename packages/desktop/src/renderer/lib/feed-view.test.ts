/**
 * Вид вкладки сессии (план 2026-10-01, решение 6, решение контролёра Е): когда вид «Chat» доступен и
 * какой вид вкладка показывает.
 */

import { describe, expect, it } from 'vitest';
import { FEED_MIN_VERSION } from '@parley/protocol';
import { effectiveView, feedAvailable } from './feed-view.js';

const FEED = new Set(['hello', 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe']);
const NO_FEED = new Set(['hello', 'pty.attach']);

describe('feedAvailable', () => {
  it('без feed.snapshot у хоста — недоступен', () => {
    expect(feedAvailable({ hostMethods: NO_FEED, provider: 'claude', version: '2.1.286' })).toBe(false);
  });

  it('codex — недоступен', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'codex', version: null })).toBe(false);
  });

  it('claude 2.1.280 — недоступен, 2.1.286 и новее — доступен', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: '2.1.280' })).toBe(false);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: '2.1.285' })).toBe(false);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: '2.1.286' })).toBe(true);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: '2.2.0' })).toBe(true);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: '3.0.0' })).toBe(true);
    expect(FEED_MIN_VERSION).toBe('2.1.286');
  });

  it('версия неизвестна (null) — доступен; не x.y.z — нет', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: null })).toBe(true);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: 'nightly' })).toBe(false);
  });
});

describe('effectiveView', () => {
  it('без поля view — chat, если вид доступен, иначе terminal', () => {
    expect(effectiveView({}, true)).toBe('chat');
    expect(effectiveView({}, false)).toBe('terminal');
  });

  it('явный view побеждает, пока вид доступен', () => {
    expect(effectiveView({ view: 'terminal' }, true)).toBe('terminal');
    expect(effectiveView({ view: 'chat' }, true)).toBe('chat');
  });

  it('явный chat при недоступном виде — terminal', () => {
    expect(effectiveView({ view: 'chat' }, false)).toBe('terminal');
  });
});
