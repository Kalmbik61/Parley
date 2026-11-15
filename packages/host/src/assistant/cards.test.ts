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

  describe('автономные карточки (спека автономии §5.3)', () => {
    it('putDecided: одна транзакция вытесняет активную карточку источника и пишет строку сразу decided с ходом recorded и result_state pending', () => {
      const store = createCardStore(openMemoryDb());
      store.put(card('p1'), 10);
      store.put(card('p2', 'job:a'), 11);
      const row = store.putDecided({ ...card('p3'), steps: 2 }, 'auto', 12);
      expect(row).toMatchObject({ proposalId: 'p3', state: 'decided', decidedVia: 'auto', decidedAt: null, outcome: null, progress: { steps: 2, started: [], confirmed: [] }, resultState: 'pending' });
      expect(store.get('p1')?.state).toBe('superseded');
      expect(store.get('p2')?.state).toBe('active');
      expect(store.active().map((item) => item.proposalId)).toEqual(['p2']);
      // Решить или вернуть её нельзя: активной она не была.
      expect(store.claim('p3', 13)).toEqual({ ok: false, reason: 'gone' });
      expect(store.release('p3')).toBe(false);
    });
    it('putDecided: сбой вставки откатывает и вытеснение', () => {
      const store = createCardStore(openMemoryDb());
      store.put(card('p1'), 10);
      expect(() => store.putDecided({ ...card('p1'), steps: 1 }, 'auto', 11)).toThrow(/UNIQUE/);
      expect(store.get('p1')?.state).toBe('active');
    });
    it('recordStep пишет started и confirmed по шагам, повтор не дублирует; карточке клика хода нет', () => {
      const store = createCardStore(openMemoryDb());
      store.putDecided({ ...card('p1'), steps: 3 }, 'auto', 10);
      store.recordStep('p1', 'started', 1);
      store.recordStep('p1', 'confirmed', 1);
      store.recordStep('p1', 'started', 2);
      store.recordStep('p1', 'started', 2);
      expect(store.get('p1')?.progress).toEqual({ steps: 3, started: [1, 2], confirmed: [1] });
      store.put(card('p2'), 11);
      store.recordStep('p2', 'started', 1);
      expect(store.get('p2')?.progress).toBeNull();
    });
    it('takeResult: из pending выигрывает один переход; у карточки клика перехода нет', () => {
      const store = createCardStore(openMemoryDb());
      store.putDecided({ ...card('p1'), steps: 1 }, 'auto', 10);
      expect(store.takeResult('p1', 'taken_by_run')).toBe(true);
      expect(store.takeResult('p1', 'sent_as_message')).toBe(false);
      expect(store.takeResult('p1', 'taken_by_run')).toBe(false);
      expect(store.get('p1')?.resultState).toBe('taken_by_run');
      store.put(card('p2'), 11);
      expect(store.takeResult('p2', 'taken_by_run')).toBe(false);
      expect(store.get('p2')?.resultState).toBeNull();
    });
    it('unsettledAuto отдаёт автономные без итога; closeUnsettled их не закрывает', () => {
      const store = createCardStore(openMemoryDb());
      store.putDecided({ ...card('p1'), steps: 1 }, 'auto', 10);
      store.putDecided({ ...card('p2', 'job:a'), steps: 1 }, 'auto', 11);
      store.settle('p2', 'auto', 'done', 12);
      store.put(card('p3', 'job:b'), 13);
      store.claim('p3', 14);
      expect(store.unsettledAuto().map((row) => row.proposalId)).toEqual(['p1']);
      expect(store.closeUnsettled(20).map((row) => row.proposalId)).toEqual(['p3']);
      expect(store.get('p1')).toMatchObject({ outcome: null, decidedVia: 'auto' });
      expect(store.get('p2')).toMatchObject({ outcome: 'done', decidedAt: 12, decidedVia: 'auto' });
    });
    it('settleAuto пишет исход и структурный итог один раз; pendingResults — закрытые с невыданным итогом, по источнику', () => {
      const store = createCardStore(openMemoryDb());
      store.putDecided({ ...card('p1', 'job:a'), steps: 1 }, 'auto', 10);
      store.putDecided({ ...card('p2'), steps: 1 }, 'auto', 11);
      store.putDecided({ ...card('p3', 'job:a'), steps: 1 }, 'auto', 12);
      const result = { status: 'partial' as const, effects: ['room "QA" created'], retry: 'unsafe' as const, reason: 'its task was not sent' };
      store.settleAuto('p1', 'partial', result, 20);
      store.settleAuto('p1', 'done', { ...result, status: 'done' }, 21);
      store.settleAuto('p2', 'done', { ...result, status: 'done' }, 22);
      store.takeResult('p2', 'taken_by_run');
      expect(store.get('p1')).toMatchObject({ outcome: 'partial', decidedAt: 20, decidedVia: 'auto', result, resultState: 'pending' });
      expect(store.pendingResults().map((row) => row.proposalId)).toEqual(['p1']);
      expect(store.pendingResults('job:a').map((row) => row.proposalId)).toEqual(['p1']);
      expect(store.pendingResults('island')).toEqual([]);
      store.put(card('p4'), 13);
      store.claim('p4', 14);
      store.settleAuto('p4', 'done', result, 30);
      expect(store.get('p4')).toMatchObject({ outcome: null, result: null });
    });
    it('строка, прочитанная без столбца result_json (схема шага 15), читается без итога', () => {
      const db = openMemoryDb();
      db.exec('ALTER TABLE assistant_cards DROP COLUMN result_json');
      db.prepare(
        `INSERT INTO assistant_cards (proposal_id, kind, view_json, payload_json, source, state, revision, expires_at, created_at, decided_via, outcome, progress_json, result_state) VALUES ('p5', 'message', '{}', '{}', 'island', 'decided', 2, 1000, 10, 'auto', 'done', '{"steps":1,"started":[1],"confirmed":[1]}', 'pending')`,
      ).run();
      expect(createCardStore(db).get('p5')).toMatchObject({ outcome: 'done', progress: { steps: 1 }, result: null, resultState: 'pending' });
    });
    it('строка прежней версии (без хода и result_state, как пишет её старый код) читается: хода нет, клик работает', () => {
      // Сам шаг миграции 14 → 15 с сохранением строк проверяет core (db.test.ts, шаг 15).
      const db = openMemoryDb();
      db.prepare(
        `INSERT INTO assistant_cards (proposal_id, kind, view_json, payload_json, source, state, revision, expires_at, created_at) VALUES ('p4', 'message', '{"id":"p4"}', '{"to":[]}', 'island', 'active', 1, 1000, 10)`,
      ).run();
      const store = createCardStore(db);
      expect(store.get('p4')).toMatchObject({ proposalId: 'p4', state: 'active', view: { id: 'p4' }, progress: null, result: null, resultState: null });
      expect(store.claim('p4', 20)).toMatchObject({ ok: true });
    });
  });

  it('recent: только решённые с исходом, новые первыми, не больше limit', () => {
    const store = createCardStore(openMemoryDb());
    store.put(card('p1'), 1); // активная
    for (const [id, at] of [['p2', 10], ['p3', 20], ['p4', 30]] as const) {
      store.put(card(id, id), at);
      store.claim(id, at);
      store.settle(id, 'island', 'sent', at);
    }
    store.put(card('p5', 'p5'), 40);
    store.claim('p5', 40); // захвачена, исхода нет
    expect(store.recent(10).map((row) => row.proposalId)).toEqual(['p4', 'p3', 'p2']);
    expect(store.recent(2).map((row) => row.proposalId)).toEqual(['p4', 'p3']);
  });
});
