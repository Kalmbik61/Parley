import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import type { AssistantCardChanged } from '@parley/protocol';
import type { Job, JobState } from '../assistant/jobs.js';
import { createIngest } from './ingest.js';
import { createNotificationStore } from './store.js';

const setup = () => {
  const db = openMemoryDb();
  const store = createNotificationStore(db);
  const ingest = createIngest({ store, hostId: 'host-1', now: () => 100 });
  const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
  return { store, ingest, count };
};
const job = (state: JobState, revision = 1): Job =>
  ({ jobId: 'j1', state, revision, requestText: 'secret request', resultSummary: 'secret result' }) as unknown as Job;
const card = (state: AssistantCardChanged['state'], extra: Partial<AssistantCardChanged> = {}): AssistantCardChanged => ({
  cardId: 'p1',
  kind: 'message',
  state,
  revision: 1,
  expiresAt: 500,
  decidedVia: null,
  outcome: null,
  ...extra,
});

describe('notification ingest', () => {
  it('нетерминальный job строк не даёт', () => {
    const { ingest, count } = setup();
    ingest.onJob(job('queued'));
    ingest.onJob(job('running', 2));
    ingest.onJob(job('needs_confirmation', 3));
    expect(count()).toBe(0);
  });

  it('терминальный job: одна строка job-finished, повторы дедуплицируются, текста в строке нет', () => {
    const { ingest, store, count } = setup();
    ingest.onJob(job('completed', 4));
    ingest.onJob(job('completed', 4));
    ingest.onJob(job('completed', 5));
    expect(count()).toBe(1);
    const row = store.get('job:j1:completed');
    expect(row).toMatchObject({ type: 'job-finished', entityRef: 'job:j1', severity: 'info', requiresAction: false });
    expect(JSON.stringify(row)).not.toContain('secret');
    ingest.onJob(job('failed', 6));
    expect(store.get('job:j1:failed')?.severity).toBe('warning');
    expect(count()).toBe(2);
  });

  it('needs_confirmation: ровно одна критическая строка, повтор и replay не плодят', () => {
    const { ingest, store, count } = setup();
    ingest.onCard(card('needs_confirmation'));
    ingest.onCard(card('needs_confirmation', { revision: 2 }));
    expect(count()).toBe(1);
    expect(store.get('needs_confirmation:p1')).toMatchObject({ severity: 'critical', requiresAction: true, state: 'new' });
  });

  it('decided: ack строки каналом решения; повтор и карточка без строки безвредны', () => {
    const { ingest, store, count } = setup();
    ingest.onCard(card('decided', { decidedVia: 'telegram' }));
    expect(count()).toBe(0);
    ingest.onCard(card('needs_confirmation'));
    ingest.onCard(card('decided', { decidedVia: 'mobile', revision: 2 }));
    ingest.onCard(card('decided', { decidedVia: 'island', revision: 2 }));
    expect(store.get('needs_confirmation:p1')).toMatchObject({ state: 'acked', ackedVia: 'mobile' });
  });

  it('expired: строка терминальна, ожидающая доставка снята; позднее решение её не воскрешает', () => {
    const { ingest, store } = setup();
    ingest.onCard(card('needs_confirmation'));
    ingest.onCard(card('expired', { revision: 2 }));
    expect(store.get('needs_confirmation:p1')?.state).toBe('expired');
    ingest.onCard(card('decided', { decidedVia: 'island', revision: 3 }));
    expect(store.get('needs_confirmation:p1')?.state).toBe('expired');
    ingest.onCard(card('needs_confirmation', { revision: 4 }));
    expect(store.get('needs_confirmation:p1')?.state).toBe('expired');
  });

  it('decided без канала (хост умер посреди действия): строка закрывается, доставка снята', () => {
    const { ingest, store } = setup();
    ingest.onCard(card('needs_confirmation'));
    ingest.onCard(card('decided', { revision: 2 }));
    expect(store.get('needs_confirmation:p1')?.state).toBe('expired');
    expect(store.dueOutbox(1_000_000)).toEqual([]);
  });
});
