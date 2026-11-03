import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createCardStore } from '../assistant/cards.js';
import { LEASE_MS, MAX_ATTEMPTS, createNotificationStore, jobKey, needsConfirmationKey, type NewNotification } from './store.js';

const event = (dedupeKey: string, extra: Partial<NewNotification> = {}): NewNotification => ({
  dedupeKey,
  eventId: `ev:${dedupeKey}`,
  hostId: 'host-1',
  entityRef: 'job:j1',
  type: 'job-finished',
  severity: 'info',
  ...extra,
});

describe('notification store', () => {
  it('write: повтор с тем же dedupeKey не создаёт строку', () => {
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    const first = store.write(event(jobKey('j1', 'completed')), 10);
    const again = store.write(event(jobKey('j1', 'completed')), 20);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.row.notificationId).toBe(first.row.notificationId);
    expect(again.row.createdAt).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });
  });

  it('dedupeKey и notificationId переживают рестарт (переоткрытие стора на той же базе)', () => {
    const db = openMemoryDb();
    const id = createNotificationStore(db).write(event(needsConfirmationKey('p1'), { severity: 'critical', requiresAction: true }), 10).row.notificationId;
    const reopened = createNotificationStore(db);
    const again = reopened.write(event(needsConfirmationKey('p1')), 99);
    expect(again.created).toBe(false);
    expect(again.row).toMatchObject({ notificationId: id, severity: 'critical', requiresAction: true });
    expect(reopened.get('needs_confirmation:p1')?.notificationId).toBe(id);
  });

  it('пассивный сток: свежая база с готовым состоянием даёт ноль строк, живое событие — одну', () => {
    const db = openMemoryDb();
    const cards = createCardStore(db);
    cards.put({ proposalId: 'p1', kind: 'message', view: { id: 'p1' }, payload: {}, source: 'island', expiresAt: 100 }, 1);
    db.prepare(`INSERT INTO assistant_jobs (job_id, idempotency_key, origin, correlation_json, state, revision, request_text, provider, created_at, updated_at) VALUES ('j1','k1','island','{}','completed',1,'t','claude',1,1)`).run();
    const store = createNotificationStore(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()).toEqual({ n: 0 });
    store.write(event(jobKey('j2', 'failed')), 5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });
  });

  it('ack/seen/markExpired: переходы один раз, ack и expired снимают ожидающую доставку', () => {
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    store.write(event('a', { channels: ['telegram'] }), 1);
    store.write(event('b', { channels: ['telegram'] }), 1);
    expect(store.seen('a', 2)).toBe(true);
    expect(store.seen('a', 3)).toBe(false);
    expect(store.ack('a', 'mobile', 4)).toBe(true);
    expect(store.ack('a', 'telegram', 5)).toBe(false);
    expect(store.get('a')).toMatchObject({ state: 'acked', ackedAt: 4, ackedVia: 'mobile', seenAt: 2 });
    expect(store.markExpired('b')).toBe(true);
    expect(store.markExpired('b')).toBe(false);
    expect(store.get('b')?.state).toBe('expired');
    expect(store.dueOutbox(1000)).toEqual([]);
    expect(store.ack('missing', 'island', 1)).toBe(false);
  });

  it('envelope-only: id, маршруты и виды принимаются, пользовательский текст отвергается; в строках текстов нет', () => {
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    expect(() => store.write(event('k1', { entityRef: 'Проект Альфа' }), 1)).toThrow(/opaque/);
    expect(() => store.write(event('k2', { payloadRef: 'rm -rf /tmp x' }), 1)).toThrow(/opaque/);
    expect(() => store.write(event('k3', { type: 'Deploy finished' }), 1)).toThrow(/kind/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    store.write(event('k4', { workspaceId: 'ws-1', payloadRef: 'job/j1', channels: ['telegram'] }), 1);
    const json = JSON.stringify(db.prepare('SELECT * FROM notifications').all()) + JSON.stringify(db.prepare('SELECT * FROM notification_outbox').all());
    expect(json).not.toMatch(/[^ -~]/);
    expect(json).not.toMatch(/[A-Za-z]+ [A-Za-z]+/);
  });

  it('outbox: попытки с jitter, предел попыток, markSent', () => {
    const store = createNotificationStore(openMemoryDb(), () => 0);
    store.write(event('a', { channels: ['telegram', 'mobile'] }), 100);
    const due = store.dueOutbox(100);
    expect(due.map((r) => r.channel)).toEqual(['telegram', 'mobile']);
    const [tg, mobile] = due as [(typeof due)[number], (typeof due)[number]];
    store.markSent(mobile.id, 101);
    // Выданная запись под арендой: второй вызов её не получает, после аренды — получает.
    expect(store.dueOutbox(100)).toEqual([]);
    expect(store.dueOutbox(100 + LEASE_MS).map((r) => r.channel)).toEqual(['telegram']);

    let now = 100;
    let row = store.markFailed(tg.id, now)!;
    expect(row).toMatchObject({ state: 'pending', attempts: 1 });
    expect(row.nextAttemptAt).toBe(now + 2_500); // база 5 с, jitter 0.5 при random=0
    expect(store.dueOutbox(now)).toEqual([]);
    expect(store.dueOutbox(row.nextAttemptAt)).toHaveLength(1);
    const delays: number[] = [row.nextAttemptAt - now];
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      now = row.nextAttemptAt;
      row = store.markFailed(tg.id, now)!;
      delays.push(row.nextAttemptAt - now);
    }
    expect(row).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect(delays.slice(0, 3)).toEqual([2_500, 5_000, 10_000]);
    expect(store.dueOutbox(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(store.markFailed(tg.id, now)?.state).toBe('failed');
  });

  it('outbox: jitter меняет паузу в пределах [0.5, 1] базы', () => {
    const lo = createNotificationStore(openMemoryDb(), () => 0);
    const hi = createNotificationStore(openMemoryDb(), () => 1);
    const a = lo.write(event('a', { channels: ['t'] }), 0);
    const b = hi.write(event('a', { channels: ['t'] }), 0);
    expect(a.created && b.created).toBe(true);
    expect(lo.markFailed(lo.dueOutbox(0)[0]!.id, 0)?.nextAttemptAt).toBe(2_500);
    expect(hi.markFailed(hi.dueOutbox(0)[0]!.id, 0)?.nextAttemptAt).toBe(5_000);
  });

  it('outbox: аренда не даёт выдать запись дважды, истёкшая аренда после рестарта возвращает её', () => {
    const db = openMemoryDb();
    createNotificationStore(db).write(event('a', { channels: ['t'] }), 0);
    expect(createNotificationStore(db).dueOutbox(10)).toHaveLength(1);
    expect(createNotificationStore(db).dueOutbox(11)).toEqual([]);
    expect(createNotificationStore(db).dueOutbox(10 + LEASE_MS)).toHaveLength(1);
  });

  it('ack и markExpired снимают очередь, а закрытое уведомление не выдаётся', () => {
    const store = createNotificationStore(openMemoryDb());
    store.write(event('a', { channels: ['t'] }), 0);
    store.write(event('b', { channels: ['t'] }), 0);
    expect(store.ack('a', 'island', 1)).toBe(true);
    expect(store.markExpired('b')).toBe(true);
    expect(store.dueOutbox(2)).toEqual([]);
  });

  it('outbox: строка, закрытая после постановки в очередь, не выдаётся даже при живой записи', () => {
    const db = openMemoryDb();
    const store = createNotificationStore(db);
    store.write(event('a', { channels: ['t'] }), 0);
    db.prepare(`UPDATE notifications SET state = 'acked' WHERE dedupe_key = 'a'`).run();
    expect(store.dueOutbox(1)).toEqual([]);
  });

  it('конверт отвергает абсолютные и пользовательские пути', () => {
    const store = createNotificationStore(openMemoryDb());
    for (const [i, ref] of ['/Users/name/project', 'Users/name/project', 'a/../b', 'x//y', '/etc/passwd'].entries()) {
      expect(() => store.write(event(`p${i}`, { payloadRef: ref }), 1)).toThrow(/opaque/);
      expect(() => store.write(event(`q${i}`, { entityRef: ref }), 1)).toThrow(/opaque/);
    }
    expect(() => store.write(event('ok', { payloadRef: 'room/r1:card-2' }), 1)).not.toThrow();
  });
});
