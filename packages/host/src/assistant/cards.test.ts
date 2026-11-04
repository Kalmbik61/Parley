import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createCardStore, type NewCard } from './cards.js';

const card = (id: string, source = 'island', expiresAt = 1000): NewCard => ({ proposalId: id, kind: 'message', view: { id, text: id }, payload: { to: [] }, source, expiresAt });

describe('card store', () => {
  it('put → claim один раз; settle пишет след решения', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1'), 10);
    expect(store.claim('p1', 20)).toMatchObject({ ok: true });
    expect(store.claim('p1', 20)).toEqual({ ok: false, reason: 'gone' });
    store.settle('p1', 'mobile', 'sent', 30);
    expect(store.get('p1')).toMatchObject({ state: 'decided', decidedAt: 30, decidedVia: 'mobile', outcome: 'sent' });
  });
  it('claim по просроченной → expired терминально', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1', 'island', 100), 10);
    expect(store.claim('p1', 100)).toEqual({ ok: false, reason: 'expired' });
    expect(store.claim('p1', 1)).toEqual({ ok: false, reason: 'expired' });
    expect(store.get('p1')?.state).toBe('expired');
  });
  it('release возвращает карточку, пока источник не занят новой', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1'), 10);
    store.claim('p1', 11);
    expect(store.release('p1')).toBe(true);
    expect(store.get('p1')?.state).toBe('active');
    store.claim('p1', 12);
    store.put(card('p2'), 13);
    expect(store.release('p1')).toBe(false);
  });
  it('карточки переживают переоткрытие хранилища на той же базе', () => {
    const db = openMemoryDb();
    createCardStore(db).put(card('p7'), 10);
    const again = createCardStore(db);
    expect(again.active().map((row) => row.proposalId)).toEqual(['p7']);
    expect(again.lastNumber()).toBe(7);
  });
  it('reissue только для expired и даёт новый id', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1', 'island', 50), 10);
    expect(store.reissue('p1', 'p2', 500, 20)).toBeNull();
    store.expireDue(60);
    expect(store.reissue('p1', 'p2', 500, 70)).toMatchObject({ proposalId: 'p2', state: 'active', view: { id: 'p2' } });
  });
  it('closeUnsettled: захваченная карточка без итога получает unknown и не возвращается в active', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1'), 10);
    store.claim('p1', 11);
    expect(store.closeUnsettled(20).map((row) => row.proposalId)).toEqual(['p1']);
    expect(store.get('p1')).toMatchObject({ state: 'decided', outcome: 'unknown', decidedAt: 20 });
    expect(store.release('p1')).toBe(false);
    expect(store.claim('p1', 21)).toEqual({ ok: false, reason: 'gone' });
    expect(store.closeUnsettled(30)).toEqual([]);
  });
  it('withdrawBySource отзывает активные карточки источника, захваченную не трогает; bySource видит все', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1', 'job:a'), 10);
    store.put(card('p2', 'job:a'), 11); // p1 вытеснена своим источником
    store.put(card('p3', 'job:b'), 12);
    expect(store.bySource('job:a').map((row) => [row.proposalId, row.state])).toEqual([['p1', 'superseded'], ['p2', 'active']]);
    const withdrawn = store.withdrawBySource('job:a');
    expect(withdrawn.map((row) => [row.proposalId, row.state, row.revision])).toEqual([['p2', 'superseded', 2]]);
    expect(store.get('p2')).toMatchObject({ state: 'superseded', revision: 2 });
    expect(store.get('p3')?.state).toBe('active');
    expect(store.claim('p3', 20)).toMatchObject({ ok: true });
    expect(store.withdrawBySource('job:b')).toEqual([]);
    expect(store.get('p3')?.state).toBe('decided');
    expect(store.withdrawBySource('job:a')).toEqual([]);
  });
  it('отозванную (superseded) карточку решить нельзя: claim отказывает', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1', 'job:a', 1000), 10);
    store.withdrawBySource('job:a');
    expect(store.claim('p1', 20)).toEqual({ ok: false, reason: 'gone' });
    expect(store.get('p1')?.state).toBe('superseded');
  });
});
