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
import { effectiveView, feedAvailability, feedAvailable, feedAvailableNow, sessionStarted, sessionStartedOrUnknown } from './feed-view.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

const FEED = new Set(['hello', 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe']);
const NO_FEED = new Set(['hello', 'pty.attach']);

describe('feedAvailable', () => {
  it('Chat доступен доверенному семейству Claude, а версия берётся у выбранной записи', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'glm', family: 'claude', version: '2.1.287' })).toBe(true);
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', family: null, version: '2.1.287' })).toBe(false);
    expect(feedAvailable({ hostMethods: FEED, provider: 'glm', version: '2.1.287' })).toBe(false);
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods: [...FEED] } });
    useProvidersStore.setState({ providers: [
      { id: 'claude', label: 'Claude', available: true, family: 'claude', version: '2.1.300', limits: null },
      { id: 'glm', label: 'GLM', available: true, family: 'claude', version: '2.1.280', limits: null },
    ] });
    expect(feedAvailableNow('glm')).toBe(false);
    expect(feedAvailableNow('claude')).toBe(true);
    useProvidersStore.setState({ providers: [] });
    useHostStore.setState({ status: { state: 'connecting' } });
  });
  it('без feed.snapshot у хоста — недоступен', () => {
    expect(feedAvailable({ hostMethods: NO_FEED, provider: 'claude', version: '2.1.286' })).toBe(false);
  });

  it('Codex: нужен признак feed-codex и версия не ниже 0.160.0', () => {
    const codex = { hostMethods: FEED, provider: 'codex', version: '0.160.0' };
    expect(feedAvailable({ ...codex, features: new Set(['feed-codex']) })).toBe(true);
    expect(feedAvailable({ ...codex, features: new Set() })).toBe(false);
    expect(feedAvailable({ ...codex, features: new Set(['feed-codex']), version: '0.159.0' })).toBe(false);
    expect(feedAvailable({ ...codex, features: new Set(['feed-codex']), version: null })).toBe(false);
  });

  it('Codex до загрузки провайдеров — неизвестно (null), как у Claude', () => {
    expect(feedAvailability({ hostMethods: FEED, features: new Set(['feed-codex']), provider: 'codex', version: null, loaded: false })).toBeNull();
  });

  it('Claude без признака — как раньше', () => {
    expect(feedAvailable({ hostMethods: FEED, provider: 'claude', family: 'claude', version: '2.1.289' })).toBe(true);
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
  it('GLM до загрузки списка остаётся неизвестным, после старого ответа без family — недоступен', () => {
    expect(feedAvailability({ hostMethods: FEED, provider: 'glm', version: null, loaded: false })).toBeNull();
    expect(feedAvailability({ hostMethods: FEED, provider: 'glm', version: '2.1.287', loaded: true })).toBe(false);
  });
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

  it('хост без ленты ответа не ждёт — сразу недоступен; codex до загрузки провайдеров — неизвестно', () => {
    expect(feedAvailability({ hostMethods: NO_FEED, provider: 'claude', version: null, loaded: false })).toBe(false);
    expect(feedAvailability({ hostMethods: FEED, provider: 'codex', version: null, loaded: false })).toBeNull();
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

describe('effectiveView — started неизвестен до снимка активности (кусок 4a, ревью)', () => {
  it('без явного view и с неизвестным started — null (вид не выбран)', () => {
    expect(effectiveView({}, true, null)).toBeNull();
  });

  it('явный view побеждает и при неизвестном started', () => {
    expect(effectiveView({ view: 'terminal' }, true, null)).toBe('terminal');
    expect(effectiveView({ view: 'chat' }, true, null)).toBe('chat');
  });

  it('вид недоступен — терминал и при неизвестном started; доступность неизвестна — null', () => {
    expect(effectiveView({}, false, null)).toBe('terminal');
    expect(effectiveView({ view: 'chat' }, null, null)).toBeNull();
  });
});

describe('sessionStartedOrUnknown', () => {
  it('до снимка — null, после — как sessionStarted', () => {
    const entry = makeActivity(REF, 'idle', { lastEventAt: '2026-10-02T10:00:00.000Z' });
    expect(sessionStartedOrUnknown(false, entry)).toBeNull();
    expect(sessionStartedOrUnknown(true, entry)).toBe(true);
    expect(sessionStartedOrUnknown(true, undefined)).toBe(false);
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
