import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createRouter, route, type DeliveryMode, type Presence } from './router.js';
import { createNotificationStore, type NewNotification } from './store.js';

const MIN = 60_000;
const idle: Presence = { appActive: false, telegramAllowed: true };
const info = { severity: 'info', requiresAction: false, state: 'new' } as const;
const critical = { severity: 'critical', requiresAction: true, state: 'new' } as const;

const setup = (mode: DeliveryMode = 'SMART', presence: Presence = idle) => {
  const db = openMemoryDb();
  const store = createNotificationStore(db);
  const router = createRouter({ store, mode: () => mode, presence: () => presence, now: () => 1000 });
  const done = (key = 'job:a:completed') => store.write({ dedupeKey: key, eventId: 'e1', hostId: 'h', entityRef: 'job:a', type: 'job-finished', severity: 'info' } as NewNotification, 1000).row;
  const ask = (key = 'needs_confirmation:c1') =>
    store.write({ dedupeKey: key, eventId: 'e2', hostId: 'h', entityRef: 'card:c1', type: 'needs-confirmation', severity: 'critical', requiresAction: true }, 1000).row;
  const channels = (): string[] => (db.prepare('SELECT channel FROM notification_outbox ORDER BY id').all() as { channel: string }[]).map((r) => r.channel);
  return { store, router, done, ask, channels };
};

describe('route', () => {
  it('VO-08: обычное в SMART уходит в приложение и не в Telegram', () => {
    expect(route(info, 'SMART', idle, false)).toEqual({ app: true, telegram: false, escalate: false });
  });

  it('режимы: APP_ONLY без Telegram, TELEGRAM_ONLY без push, BOTH в оба', () => {
    expect(route(info, 'APP_ONLY', idle, false)).toEqual({ app: true, telegram: false, escalate: false });
    expect(route(info, 'TELEGRAM_ONLY', idle, false)).toEqual({ app: false, telegram: true, escalate: false });
    expect(route(info, 'BOTH', idle, false)).toEqual({ app: true, telegram: true, escalate: false });
  });

  it('Telegram запрещён: его нет ни сразу, ни в эскалации', () => {
    const off = { ...idle, telegramAllowed: false };
    expect(route(critical, 'BOTH', off, false).telegram).toBe(false);
    expect(route(critical, 'SMART', off, false).escalate).toBe(false);
  });

  it('deliveredInline или активный экран: push нет, Telegram не затронут', () => {
    expect(route(info, 'SMART', idle, true).app).toBe(false);
    expect(route(info, 'SMART', { ...idle, appActive: true }, false).app).toBe(false);
    expect(route(info, 'BOTH', idle, true)).toEqual({ app: false, telegram: true, escalate: false });
  });

  it('эскалация только у критичного с действием и только в SMART', () => {
    expect(route(critical, 'SMART', idle, false).escalate).toBe(true);
    expect(route({ ...critical, requiresAction: false }, 'SMART', idle, false).escalate).toBe(false);
    expect(route({ ...critical, severity: 'warning' }, 'SMART', idle, false).escalate).toBe(false);
    expect(route(critical, 'APP_ONLY', idle, false).escalate).toBe(false);
  });

  it('закрытое событие ничего не рассылает', () => {
    expect(route({ ...critical, state: 'expired' }, 'BOTH', idle, false)).toEqual({ app: false, telegram: false, escalate: false });
    expect(route({ ...critical, state: 'acked' }, 'BOTH', idle, false).app).toBe(false);
  });
});

describe('router dispatch', () => {
  it('VO-08: Done в SMART — запись app, Telegram нет', () => {
    const { router, done, channels } = setup();
    router.dispatch(done(), false);
    expect(channels()).toEqual(['app']);
  });

  it('deliveredInline: записи app нет, строка остаётся в store', () => {
    const { router, done, channels, store } = setup();
    const row = done();
    router.dispatch(row, true);
    expect(channels()).toEqual([]);
    expect(store.get(row.dedupeKey)?.state).toBe('new');
  });

  it('VO-09: критичное не подтверждено 10 минут — одна эскалация в Telegram с тем же notificationId', () => {
    const { router, ask, store, channels } = setup();
    const row = ask();
    router.dispatch(row, false);
    router.dispatch(row, false);
    expect(channels()).toEqual(['app', 'telegram']);
    const first = store.dueOutbox(1000);
    expect(first.map((o) => o.channel)).toEqual(['app']);
    for (const o of first) store.markSent(o.id, 1000);
    expect(store.dueOutbox(1000 + 9 * MIN)).toEqual([]);
    const due = store.dueOutbox(1000 + 10 * MIN);
    expect(due.map((o) => o.channel)).toEqual(['telegram']);
    expect(due[0]?.notificationId).toBe(row.notificationId);
  });

  it('интервал эскалации настраивается', () => {
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    const router = createRouter({ store, mode: () => 'SMART', presence: () => idle, escalationMs: () => 2 * MIN, now: () => 1000 });
    const row = store.write({ dedupeKey: 'needs_confirmation:c2', eventId: 'e', hostId: 'h', entityRef: 'card:c2', type: 'needs-confirmation', severity: 'critical', requiresAction: true }, 1000).row;
    router.dispatch(row, false);
    for (const o of store.dueOutbox(1000)) store.markSent(o.id, 1000);
    expect(store.dueOutbox(1000 + 2 * MIN).map((o) => o.channel)).toEqual(['telegram']);
  });

  it('expired снимает ожидающую эскалацию без push', () => {
    const { router, ask, store, channels } = setup();
    const row = ask();
    router.dispatch(row, false);
    store.markExpired(row.dedupeKey);
    expect(store.dueOutbox(1000 + 60 * MIN)).toEqual([]);
    expect(router.dispatch(row, false)).toEqual({ app: false, telegram: false, escalate: false });
    expect(channels()).toEqual([]);
  });

  it('VO-10: ack из Telegram снимает эскалацию, повтор из App — already_handled', () => {
    const { router, ask, store } = setup();
    const row = ask();
    router.dispatch(row, false);
    expect(router.ack(row.dedupeKey, 'telegram')).toBe('acked');
    expect(router.ack(row.dedupeKey, 'mobile')).toBe('already_handled');
    expect(store.get(row.dedupeKey)).toMatchObject({ state: 'acked', ackedVia: 'telegram' });
    expect(store.dueOutbox(1000 + 60 * MIN)).toEqual([]);
  });

  it('смена режима действует без рестарта', () => {
    let mode: DeliveryMode = 'APP_ONLY';
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    const router = createRouter({ store, mode: () => mode, presence: () => idle, now: () => 1000 });
    const mk = (k: string) => store.write({ dedupeKey: k, eventId: 'e', hostId: 'h', entityRef: 'job:x', type: 'job-finished', severity: 'info' }, 1000).row;
    expect(router.dispatch(mk('job:1:completed'), false).telegram).toBe(false);
    mode = 'BOTH';
    expect(router.dispatch(mk('job:2:completed'), false).telegram).toBe(true);
  });
});
