/**
 * Вид вкладки сессии (план 2026-10-01, решение 6; решение контролёра Е пересмотрено по ревью куска 3:
 * версия `null` — вид недоступен): когда вид «Chat» доступен, когда это ещё неизвестно и какой вид
 * вкладка показывает.
 */

import { describe, expect, it } from 'vitest';
import { FEED_MIN_VERSION } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { ActivityEntry } from '../store/activity.js';
import { makeActivity } from '../test-utils/work-fixtures.js';
import { effectiveView, feedAvailability, feedAvailable, sessionStarted } from './feed-view.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

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

  it('версия неизвестна (null) — недоступен: хост без версии хуков ленты не пишет; не x.y.z — тоже нет', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: null })).toBe(false);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', version: 'nightly' })).toBe(false);
  });
});

describe('feedAvailability — третье состояние «неизвестно»', () => {
  it('providers.list ещё не ответил — неизвестно (null), а не чат и не терминал', () => {
    expect(feedAvailability({ hostMethods: FEED, provider: 'claude', version: null, loaded: false })).toBeNull();
    expect(effectiveView({}, null, true)).toBeNull();
    expect(effectiveView({ view: 'terminal' }, null, true)).toBeNull();
  });

  it('ответ пришёл: 2.1.286 — чат; версии нет (null) — терминал', () => {
    expect(feedAvailability({ hostMethods: FEED, provider: 'claude', version: '2.1.286', loaded: true })).toBe(true);
    expect(effectiveView({}, feedAvailability({ hostMethods: FEED, provider: 'claude', version: '2.1.286', loaded: true }), true)).toBe('chat');
    expect(feedAvailability({ hostMethods: FEED, provider: 'claude', version: null, loaded: true })).toBe(false);
    expect(effectiveView({}, feedAvailability({ hostMethods: FEED, provider: 'claude', version: null, loaded: true }), true)).toBe('terminal');
  });

  it('хост без ленты и codex ответа не ждут — сразу недоступен', () => {
    expect(feedAvailability({ hostMethods: NO_FEED, provider: 'claude', version: null, loaded: false })).toBe(false);
    expect(feedAvailability({ hostMethods: FEED, provider: 'codex', version: null, loaded: false })).toBe(false);
  });
});

describe('effectiveView', () => {
  it('без поля view — chat, если вид доступен, иначе terminal', () => {
    expect(effectiveView({}, true, true)).toBe('chat');
    expect(effectiveView({}, false, true)).toBe('terminal');
  });

  it('явный view побеждает, пока вид доступен', () => {
    expect(effectiveView({ view: 'terminal' }, true, true)).toBe('terminal');
    expect(effectiveView({ view: 'chat' }, true, true)).toBe('chat');
  });

  it('явный chat при недоступном виде — terminal', () => {
    expect(effectiveView({ view: 'chat' }, false, true)).toBe('terminal');
  });
});

describe('effectiveView — автопоказ до SessionStart (кусок 4a, решение М)', () => {
  it('без явного view и без событий журнала — terminal; после первого события — chat', () => {
    expect(effectiveView({}, true, false)).toBe('terminal');
    expect(effectiveView({}, true, true)).toBe('chat');
  });

  it('явный view побеждает в обе стороны, стартовала сессия или нет', () => {
    expect(effectiveView({ view: 'chat' }, true, false)).toBe('chat');
    expect(effectiveView({ view: 'terminal' }, true, true)).toBe('terminal');
  });

  it('вид недоступен или неизвестен — started ничего не меняет', () => {
    expect(effectiveView({}, false, true)).toBe('terminal');
    expect(effectiveView({}, null, true)).toBeNull();
    expect(effectiveView({ view: 'chat' }, false, true)).toBe('terminal');
  });
});

describe('sessionStarted', () => {
  const entry = (lastEventAt: string | null): ActivityEntry => makeActivity(REF, 'idle', { lastEventAt });

  it('lastEventAt не null — стартовала; null, нет записи — нет', () => {
    expect(sessionStarted(entry('2026-10-02T10:00:00.000Z'))).toBe(true);
    expect(sessionStarted(entry(null))).toBe(false);
    expect(sessionStarted(null)).toBe(false);
    expect(sessionStarted(undefined)).toBe(false);
  });
});
