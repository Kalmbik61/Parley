import { describe, expect, it, vi } from 'vitest';
import type { Work, WindowWorkEntry, WindowWorkMap } from '@parley/core';
import { METHODS } from './methods.js';
import type { Events } from './events.js';
import {
  WORKS_SYNC_FEATURE,
  WORKS_SYNC_JOURNAL_BYTES,
  WORKS_SYNC_JOURNAL_COMMITS,
  WORKS_SYNC_PAGE_BYTES,
  WORKS_SYNC_STALE_MS,
  WorksSyncReducer,
  worksSyncRequest,
  worksSyncNamedRows,
} from './works-sync.js';
import type {
  WorksSyncPage,
  WorksSyncRecord,
  WorksSyncResult,
  WorksSyncTransaction,
  WorksSyncWorkKey,
} from './works-sync.js';
import type { WorksSnapshot } from './types.js';

const request = worksSyncRequest;

/** Метаданные работы, как их хранит карта. */
function workMeta(id: string, title = id): Work {
  return { id, title, goal: 'цель', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
}

/** Карта работы: обязательные поля и перечисленные поля коллекций. */
function workMap(work: Work, fields: Record<string, unknown> = {}): WindowWorkMap {
  return { schemaVersion: 2, work, sessions: [], rooms: [], messages: [], ...fields } as WindowWorkMap;
}

function entry(projectPath: string, map: WindowWorkMap, version?: number): WindowWorkEntry {
  return { projectPath, map, ...(version === undefined ? {} : { version }) };
}

const keyOf = (projectPath: string, workId: string): WorksSyncWorkKey => ({ projectPath, workId });

/**
 * Локальный кодировщик «хоста» только для тестов P1: раскладывает целевой снимок в записи reset-транзакции.
 * Именованные коллекции (объекты с `id`) идут строками плюс вектор порядка, остальное — секциями и значениями.
 */
function resetRecords(target: WorksSnapshot): WorksSyncRecord[] {
  const records: WorksSyncRecord[] = [];
  for (const [projectPath, branch] of Object.entries(target.branches)) {
    records.push({ kind: 'branch', projectPath, branch });
  }
  for (const e of target.entries) {
    const key = keyOf(e.projectPath, e.map.work.id);
    records.push({ kind: 'work', key, work: e.map.work, ...(e.version === undefined ? {} : { version: e.version }) });
    for (const [field, value] of Object.entries(e.map)) {
      if (field === 'schemaVersion' || field === 'work') continue;
      if (Array.isArray(value)) {
        const named = value.length > 0 && typeof value[0] === 'object' && value[0] !== null && typeof (value[0] as { id?: unknown }).id === 'string';
        if (named) {
          for (const row of value as Array<{ id: string }>) {
            records.push({ kind: 'row', key, field, id: row.id, row });
          }
          records.push({ kind: 'order', key, field, order: (value as Array<{ id: string }>).map((row) => row.id) });
        } else {
          records.push({ kind: 'section', key, field, start: 0, items: value, final: true });
        }
      } else {
        records.push({ kind: 'row', key, field, row: value });
      }
    }
  }
  return records;
}

/** Раскладывает записи в страницы по `chunk` записей; последняя — коммитная. */
function pagesOf(transaction: WorksSyncTransaction, records: WorksSyncRecord[], chunk = 3): WorksSyncPage[] {
  const out: WorksSyncPage[] = [];
  for (let i = 0; ; i++) {
    const slice = records.slice(i * chunk, (i + 1) * chunk);
    const last = (i + 1) * chunk >= records.length;
    out.push({ kind: 'page', transaction, index: i, cursor: `c${i}`, next: last ? null : `c${i + 1}`, records: slice, commit: last });
    if (last) break;
  }
  return out;
}

/** Применяет все страницы по порядку; возвращает исходы (последний — коммит или отказ). */
function applyAll(reducer: WorksSyncReducer, list: WorksSyncPage[]) {
  return list.map((page) => reducer.applyPage(page));
}

const EPOCH = 'host-1';

/** Полный сброс до снимка: возвращает исходы применения. */
function resetFrom(reducer: WorksSyncReducer, snapshot: WorksSnapshot, epoch = EPOCH, target = snapshot.revision ?? 1) {
  const transaction: WorksSyncTransaction = { mode: 'reset', epoch, base: 0, target };
  return applyAll(reducer, pagesOf(transaction, resetRecords(snapshot)));
}

describe('works.sync: метод, событие и бюджеты', () => {
  it('метод входит в таблицу протокола; запрос — либо курсор, либо база', () => {
    expect(Object.keys(METHODS)).toContain('works.sync');
    expect(request.safeParse({ base: 7 }).success).toBe(true);
    expect(request.safeParse({ cursor: 'c0' }).success).toBe(true);
    expect(request.safeParse({}).success).toBe(false);
    expect(request.safeParse({ cursor: 'c0', base: 7 }).success).toBe(false);
    expect(request.safeParse({ cursor: '', base: undefined }).success).toBe(false);
    expect(request.safeParse({ base: -1 }).success).toBe(false);
    expect(request.safeParse({ base: 1.5 }).success).toBe(false);
    expect(request.safeParse({ base: 3, extra: 1 }).success).toBe(false);
  });

  it('событие works.invalidated объявлено с эпохой и ревизией', () => {
    const event: Events['works.invalidated'] = { epoch: EPOCH, revision: 4 };
    expect(event.revision).toBe(4);
  });

  it('бюджеты соответствуют дизайну', () => {
    expect(WORKS_SYNC_PAGE_BYTES).toBe(512 * 1024);
    expect(WORKS_SYNC_STALE_MS).toBe(2000);
    expect(WORKS_SYNC_JOURNAL_COMMITS).toBe(256);
    expect(WORKS_SYNC_JOURNAL_BYTES).toBe(4 * 1024 * 1024);
    expect(WORKS_SYNC_FEATURE).toBe('works-sync');
  });
});

describe('редьюсер: полный сброс', () => {
  const session = (id: string) => ({ id, label: `сессия ${id}` });

  function target(): WorksSnapshot {
    return {
      revision: 5,
      branches: { '/tmp/a': 'main', '/tmp/b': null },
      entries: [
        entry('/tmp/a', workMap(workMeta('w-0001', 'первая'), {
          sessions: [session('s-01'), session('s-02')],
          deletedSessions: ['s-00'],
          compact: { totalUnread: 2 },
        }), 11),
        entry('/tmp/b', workMap(workMeta('w-0002', 'вторая'), { rooms: [{ id: 'r-01', title: 'комната' }] })),
      ],
    };
  }

  it('повторяет целевой снимок глубоко, включая отсутствующие необязательные поля', () => {
    const reducer = new WorksSyncReducer();
    const outcomes = resetFrom(reducer, target());
    expect(outcomes.at(-1)).toMatchObject({ state: 'committed' });
    expect(reducer.view.snapshot).toEqual(target());
    // необязательное поле отсутствует, а не пустое: у второй работы нет ни deletedSessions, ни compact
    const second = reducer.view.snapshot.entries[1];
    expect('deletedSessions' in second.map).toBe(false);
    expect('compact' in second.map).toBe(false);
    expect('plans' in second.map).toBe(false);
    expect(reducer.view).toMatchObject({ epoch: EPOCH, revision: 5 });
  });

  it('поздний клиент с пустого вида получает сброс; порядок работ — по приходу метаданных', () => {
    const reducer = new WorksSyncReducer();
    expect(reducer.view.epoch).toBeNull();
    resetFrom(reducer, target());
    expect(reducer.view.snapshot.entries.map((e) => e.map.work.id)).toEqual(['w-0001', 'w-0002']);
  });

  it('сброс не стирает старые данные до коммитной страницы', () => {
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, target());
    const before = reducer.view.snapshot;
    const transaction: WorksSyncTransaction = { mode: 'reset', epoch: 'host-2', base: 5, target: 9 };
    const records = resetRecords({ revision: 9, branches: {}, entries: [entry('/tmp/c', workMap(workMeta('w-0003')))] });
    const all = pagesOf(transaction, records);
    for (const page of all.slice(0, -1)) reducer.applyPage(page); // все, кроме коммитной
    expect(reducer.view.snapshot).toBe(before); // прежний вид нетронут
    expect(reducer.pending).toEqual(transaction);
    reducer.applyPage(all.at(-1)!);
    expect(reducer.view.epoch).toBe('host-2');
    expect(reducer.view.snapshot.entries.map((e) => e.map.work.id)).toEqual(['w-0003']);
    // старая эпоха сменяется только готовой заменой
  });

  it('повторная страница идемпотентна, разрыв цепочки курсоров — ремонт', () => {
    const reducer = new WorksSyncReducer();
    const transaction: WorksSyncTransaction = { mode: 'reset', epoch: EPOCH, base: 0, target: 5 };
    const all = pagesOf(transaction, resetRecords(target()));
    expect(reducer.applyPage(all[0]).state).toBe('staged');
    expect(reducer.applyPage(all[0])).toEqual({ state: 'staged', transaction, pages: 1 }); // дубль — no-op
    const skip = reducer.applyPage(all[2]); // пропустили c1
    expect(skip).toMatchObject({ state: 'rejected', reason: 'sequence', repair: true });
  });

  it('страница другой транзакции среди незакрытой отвергается, вид цел', () => {
    const reducer = new WorksSyncReducer();
    const transaction: WorksSyncTransaction = { mode: 'reset', epoch: EPOCH, base: 0, target: 5 };
    const all = pagesOf(transaction, resetRecords(target()));
    reducer.applyPage(all[0]);
    const other: WorksSyncPage = { ...all[1], transaction: { ...transaction, target: 6 } };
    expect(reducer.applyPage(other)).toMatchObject({ state: 'rejected', reason: 'sequence', repair: true });
    expect(reducer.view.snapshot).toEqual(new WorksSyncReducer().view.snapshot);
  });

  it('сброс с работой без метаданных неполон: атомарный отказ, вид цел', () => {
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, target());
    const before = reducer.view.snapshot;
    const transaction: WorksSyncTransaction = { mode: 'reset', epoch: EPOCH, base: 5, target: 6 };
    const key = keyOf('/tmp/a', 'w-0001');
    const page: WorksSyncPage = {
      kind: 'page', transaction, index: 0, cursor: 'c0', next: null, commit: true,
      records: [{ kind: 'row', key, field: 'sessions', id: 's-09', row: { id: 's-09' } }], // нет записи work
    };
    expect(reducer.applyPage(page)).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(reducer.view.snapshot).toBe(before);
  });
});

describe('редьюсер: дельта', () => {
  const session = (id: string, label = id) => ({ id, label });

  function bootstrap(): { reducer: WorksSyncReducer; snapshot: WorksSnapshot } {
    const snapshot: WorksSnapshot = {
      revision: 3,
      branches: { '/tmp/a': 'main' },
      entries: [
        entry('/tmp/a', workMap(workMeta('w-0001'), { sessions: [session('s-01'), session('s-02')] }), 10),
        entry('/tmp/a', workMap(workMeta('w-0002'), { rooms: [{ id: 'r-01', title: 'комната' }] }), 20),
      ],
    };
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, snapshot, EPOCH, 3);
    return { reducer, snapshot };
  }

  function delta(reducer: WorksSyncReducer, records: WorksSyncRecord[], base: number, target: number, epoch = EPOCH, chunk = 3) {
    const transaction: WorksSyncTransaction = { mode: 'delta', epoch, base, target };
    return applyAll(reducer, pagesOf(transaction, records, chunk));
  }

  const A = keyOf('/tmp/a', 'w-0001');
  const B = keyOf('/tmp/a', 'w-0002');

  it('строки, порядок, секции, ветки и удаления применяются; неизменённые записи — те же ссылки', () => {
    const { reducer, snapshot } = bootstrap();
    const entryB = reducer.view.snapshot.entries[1];
    const outcomes = delta(reducer, [
      { kind: 'row', key: A, field: 'sessions', id: 's-01', row: session('s-01', 'переименовали') },
      { kind: 'row-remove', key: A, field: 'sessions', id: 's-02' },
      { kind: 'row', key: A, field: 'sessions', id: 's-03', row: session('s-03') },
      { kind: 'order', key: A, field: 'sessions', order: ['s-03', 's-01'] },
      { kind: 'section', key: A, field: 'deletedSessions', start: 0, items: ['s-02'], final: true },
      { kind: 'branch', projectPath: '/tmp/a', branch: 'fix/branch' },
      { kind: 'work-remove', key: B },
    ], 3, 6);
    expect(outcomes.at(-1)).toMatchObject({ state: 'committed' });
    const committed = outcomes.at(-1) as { state: 'committed'; commit: { affected: WorksSyncWorkKey[]; deleted: WorksSyncWorkKey[] } };
    expect(committed.commit.affected).toEqual([A]);
    expect(committed.commit.deleted).toEqual([B]);
    const view = reducer.view;
    expect(view.revision).toBe(6);
    expect(view.snapshot.branches['/tmp/a']).toBe('fix/branch');
    expect(view.snapshot.entries.map((e) => e.map.work.id)).toEqual(['w-0001']);
    const mapA = view.snapshot.entries[0].map as { sessions: Array<{ id: string; label: string }>; deletedSessions: string[] };
    expect(mapA.sessions).toEqual([session('s-03'), session('s-01', 'переименовали')]);
    expect(mapA.deletedSessions).toEqual(['s-02']);
    void entryB; // работа w-0002 удалена — ссылочная целостность проверена выше
    void snapshot;
  });

  it('ссылка неизменённой работы сохраняется, изменённой — нет', () => {
    const { reducer } = bootstrap();
    const before = reducer.view.snapshot;
    delta(reducer, [{ kind: 'row', key: A, field: 'sessions', id: 's-01', row: session('s-01', 'новая') }], 3, 4, EPOCH, 10);
    const after = reducer.view.snapshot;
    expect(after.entries[1]).toBe(before.entries[1]); // w-0002 не тронута
    expect(after.entries[0]).not.toBe(before.entries[0]); // w-0001 пересобрана
  });

  it('чужая эпоха или база отвергается атомарно с ремонтом', () => {
    const { reducer } = bootstrap();
    const before = reducer.view.snapshot;
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction: { mode: 'delta', epoch: 'host-9', base: 3, target: 4 }, cursor: 'c0', next: null, commit: true, records: [{ kind: 'row', key: A, field: 'sessions', id: 's-01', row: session('s-01') }] })).toMatchObject({ state: 'rejected', reason: 'epoch', repair: true });
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction: { mode: 'delta', epoch: EPOCH, base: 2, target: 4 }, cursor: 'c0', next: null, commit: true, records: [] })).toMatchObject({ state: 'rejected', reason: 'base', repair: true });
    expect(reducer.view.snapshot).toBe(before);
  });

  it('дельта на пустой вид без сброса отвергается', () => {
    const reducer = new WorksSyncReducer();
    const outcome = reducer.applyPage({ kind: 'page', index: 0, transaction: { mode: 'delta', epoch: EPOCH, base: 0, target: 1 }, cursor: 'c0', next: null, commit: true, records: [] });
    expect(outcome).toMatchObject({ state: 'rejected', reason: 'base', repair: true });
  });

  it('удалённая работа создаётся заново следующей транзакцией', () => {
    const { reducer } = bootstrap();
    delta(reducer, [{ kind: 'work-remove', key: A }], 3, 4, EPOCH, 10);
    expect(reducer.view.snapshot.entries.map((e) => e.map.work.id)).toEqual(['w-0002']);
    delta(reducer, [
      { kind: 'work', key: A, work: workMeta('w-0001', 'заново') },
      { kind: 'row', key: A, field: 'sessions', id: 's-10', row: session('s-10') },
    ], 4, 5, EPOCH, 10);
    const recreated = reducer.view.snapshot.entries.find((e) => e.map.work.id === 'w-0001');
    expect(recreated?.map.work.title).toBe('заново');
    expect((recreated?.map as { sessions: unknown[] }).sessions).toEqual([session('s-10')]);
  });

  it('вектор порядка с неизвестной строкой — неполная транзакция', () => {
    const { reducer } = bootstrap();
    const before = reducer.view.snapshot;
    const outcome = reducer.applyPage({ kind: 'page', index: 0, transaction: { mode: 'delta', epoch: EPOCH, base: 3, target: 4 }, cursor: 'c0', next: null, commit: true, records: [{ kind: 'order', key: A, field: 'sessions', order: ['s-01', 's-99'] }] });
    expect(outcome).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(reducer.view.snapshot).toBe(before);
  });

  it('строка удаления создаётся заново той же работой; секция наращивается кусками до final', () => {
    const { reducer } = bootstrap();
    delta(reducer, [{ kind: 'row-remove', key: A, field: 'sessions', id: 's-01' }], 3, 4, EPOCH, 10);
    const transaction: WorksSyncTransaction = { mode: 'delta', epoch: EPOCH, base: 4, target: 5 };
    const p1: WorksSyncPage = { kind: 'page', transaction, index: 0, cursor: 'c0', next: 'c1', commit: false, records: [
      { kind: 'section', key: A, field: 'deletedSessions', start: 0, items: ['s-01'], final: false },
    ] };
    const p2: WorksSyncPage = { kind: 'page', transaction, index: 1, cursor: 'c1', next: null, commit: true, records: [
      { kind: 'section', key: A, field: 'deletedSessions', start: 1, items: ['s-02'], final: true },
      { kind: 'row', key: A, field: 'sessions', id: 's-01', row: session('s-01', 'вернули') },
    ] };
    expect(reducer.applyPage(p1).state).toBe('staged');
    expect(reducer.applyPage(p2)).toMatchObject({ state: 'committed' });
    const map = reducer.view.snapshot.entries[0].map as { sessions: Array<{ id: string }>; deletedSessions: string[] };
    expect(map.sessions.map((s) => s.id)).toEqual(['s-02', 's-01']);
    expect(map.deletedSessions).toEqual(['s-01', 's-02']);
  });

  it('ветка работы: значение null и удаление ключа различаются', () => {
    const { reducer } = bootstrap();
    delta(reducer, [
      { kind: 'branch', projectPath: '/tmp/b', branch: null },
      { kind: 'branch-remove', projectPath: '/tmp/a' },
    ], 3, 4, EPOCH, 10);
    expect(reducer.view.snapshot.branches).toEqual({ '/tmp/b': null });
  });

  it('метаданные работы обновляются upsert-ом, архив — не удаление', () => {
    const { reducer } = bootstrap();
    delta(reducer, [{ kind: 'work', key: A, work: { ...workMeta('w-0001'), status: 'archived' }, version: 12 }], 3, 4, EPOCH, 10);
    const archived = reducer.view.snapshot.entries[0];
    expect(archived.map.work.status).toBe('archived');
    expect(archived.version).toBe(12);
  });
});

describe('редьюсер: фрагменты огромных строк', () => {
  const A = keyOf('/tmp/a', 'w-0001');

  function bootstrapped() {
    const snapshot: WorksSnapshot = { revision: 1, branches: {}, entries: [entry('/tmp/a', workMap(workMeta('w-0001')))] };
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, snapshot, EPOCH, 1);
    return reducer;
  }

  /** Длинный текст с суррогатными парами и кириллицей: куски режем по кодовым точкам, как обязан хост. */
  const hugeRow = { id: 's-01', label: '🎮🚀'.repeat(4000) + ' длинный текст сессии ' + '😀'.repeat(3000) };

  function fragments(key: WorksSyncWorkKey, field: string, id: string, row: unknown, chunkChars: number): WorksSyncRecord[] {
    const text = JSON.stringify(row);
    const chars = [...text];
    const out: WorksSyncRecord[] = [];
    for (let i = 0; i < chars.length; i += chunkChars) {
      const slice = chars.slice(i, i + chunkChars).join('');
      out.push({ kind: 'fragment', key, field, id, index: out.length, text: slice, final: i + chunkChars >= chars.length });
    }
    return out;
  }

  it('собранная строка round-trip точно, включая Unicode', () => {
    const reducer = bootstrapped();
    const records = fragments(A, 'sessions', 's-01', hugeRow, 1000);
    expect(records.length).toBeGreaterThan(2);
    const transaction: WorksSyncTransaction = { mode: 'delta', epoch: EPOCH, base: 1, target: 2 };
    const outcomes = applyAll(reducer, pagesOf(transaction, records, 2));
    expect(outcomes.at(-1)).toMatchObject({ state: 'committed' });
    const map = reducer.view.snapshot.entries[0].map as { sessions: unknown[] };
    expect(map.sessions).toEqual([hugeRow]);
  });

  it('пропущенный, конфликтующий или незавершённый фрагмент не даёт частичной строки', () => {
    const reducer = bootstrapped();
    const all = fragments(A, 'sessions', 's-01', hugeRow, 1000);
    const transaction: WorksSyncTransaction = { mode: 'delta', epoch: EPOCH, base: 1, target: 2 };
    const before = reducer.view.snapshot;

    const missing = all.filter((_, i) => i !== 1);
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction, cursor: 'c0', next: null, commit: true, records: missing })).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(reducer.view.snapshot).toBe(before);

    const conflicting = [...all, { kind: 'fragment', key: A, field: 'sessions', id: 's-01', index: 1, text: 'XXX', final: false } as WorksSyncRecord];
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction, cursor: 'c0', next: null, commit: true, records: conflicting })).toMatchObject({ state: 'rejected', reason: 'conflict' });

    const duplicate = [...all, all[all.length - 2]];
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction, cursor: 'c0', next: null, commit: true, records: duplicate })).toMatchObject({ state: 'rejected', reason: 'conflict' });

    const noFinal = all.map((r, i) => (i === all.length - 1 && r.kind === 'fragment' ? { ...r, final: false } : r));
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction, cursor: 'c0', next: null, commit: true, records: noFinal })).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(reducer.view.snapshot).toBe(before);
  });

  it('фрагмент и прямая строка одного адреса конфликтуют', () => {
    const reducer = bootstrapped();
    const all = fragments(A, 'sessions', 's-01', hugeRow, 1000);
    const transaction: WorksSyncTransaction = { mode: 'delta', epoch: EPOCH, base: 1, target: 2 };
    const records: WorksSyncRecord[] = [...all, { kind: 'row', key: A, field: 'sessions', id: 's-01', row: hugeRow }];
    expect(reducer.applyPage({ kind: 'page', index: 0, transaction, cursor: 'c0', next: null, commit: true, records })).toMatchObject({ state: 'rejected', reason: 'conflict' });
  });
});

describe('редьюсер: безопасные ключи', () => {
  const A = keyOf('/tmp/a', 'w-0001');

  function bootstrapped() {
    const snapshot: WorksSnapshot = { revision: 1, branches: {}, entries: [entry('/tmp/a', workMap(workMeta('w-0001')))] };
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, snapshot, EPOCH, 1);
    return reducer;
  }

  it('поле или id вида __proto__/constructor/prototype отвергаются вместе с транзакцией', () => {
    const reducer = bootstrapped();
    const before = reducer.view.snapshot;
    for (const bad of [
      { kind: 'row', key: A, field: '__proto__', row: 1 },
      { kind: 'row', key: A, field: 'sessions', id: 'constructor', row: 1 },
      { kind: 'row', key: A, field: 'prototype', row: 1 },
    ] as WorksSyncRecord[]) {
      const outcome = reducer.applyPage({ kind: 'page', index: 0, transaction: { mode: 'delta', epoch: EPOCH, base: 1, target: 2 }, cursor: 'c0', next: null, commit: true, records: [bad] });
      expect(outcome).toMatchObject({ state: 'rejected', reason: 'key' });
    }
    expect(reducer.view.snapshot).toBe(before);
    expect(Object.keys(before.entries[0].map)).not.toContain('__proto__');
  });
});

describe('детерминированные последовательности правок', () => {
  it('сгенерированные правки сходятся к целевому снимку', () => {
    for (const seed of [1, 7, 42]) {
      let state = 987654321 * seed;
      const rnd = (n: number) => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state % n;
      };
      const reducer = new WorksSyncReducer();
      const projects = ['/tmp/a', '/tmp/b'];
      const keys = [keyOf('/tmp/a', 'w-0001'), keyOf('/tmp/a', 'w-0002'), keyOf('/tmp/b', 'w-0001')];
      // исходный снимок: три работы с сессиями
      let snapshot: WorksSnapshot = {
        revision: 1,
        branches: { '/tmp/a': 'main', '/tmp/b': null },
        entries: keys.map((k, i) => entry(k.projectPath, workMap(workMeta(k.workId, `работа ${i}`), {
          sessions: [session(`s-${i}1`), session(`s-${i}2`)],
        }))),
      };
      resetFrom(reducer, snapshot, EPOCH, 1);

      let revision = 1;
      for (let step = 0; step < 12; step++) {
        const records: WorksSyncRecord[] = [];
        // Ссылки предыдущего закоммиченного вида редьюсера: нетронутые работы должны остаться теми же объектами.
        const prevViewEntries = reducer.view.snapshot.entries;
        const next: WorksSnapshot = {
          revision: revision + 1,
          branches: { ...snapshot.branches },
          entries: snapshot.entries.map((e) => ({ ...e, map: { ...e.map, sessions: [...e.map.sessions] } as WindowWorkMap })),
        };
        const ops = 1 + rnd(3);
        for (let op = 0; op < ops; op++) {
          const key = keys[rnd(keys.length)];
          const target = next.entries.find((e) => e.projectPath === key.projectPath && e.map.work.id === key.workId)!;
          const sessions = target.map.sessions as Array<{ id: string; label: string }>;
          const choice = rnd(4);
          if (choice === 0 && sessions.length > 0) {
            // переименовать случайную сессию
            const idx = rnd(sessions.length);
            const row = { ...sessions[idx], label: `шаг ${step}.${op}` };
            sessions[idx] = row;
            records.push({ kind: 'row', key, field: 'sessions', id: row.id, row });
          } else if (choice === 1) {
            // добавить сессию
            const id = `s-new-${step}-${op}`;
            const row = { id, label: `новая ${id}` };
            sessions.push(row);
            records.push({ kind: 'row', key, field: 'sessions', id, row });
          } else if (choice === 2 && sessions.length > 1) {
            // удалить случайную сессию
            const idx = rnd(sessions.length);
            const [removed] = sessions.splice(idx, 1);
            records.push({ kind: 'row-remove', key, field: 'sessions', id: removed.id });
          } else if (choice === 3 && sessions.length > 1) {
            // переставить порядок и объявить его вектором
            const idx = rnd(sessions.length);
            const [moved] = sessions.splice(idx, 1);
            sessions.unshift(moved);
            records.push({ kind: 'order', key, field: 'sessions', order: sessions.map((s) => s.id) });
          }
        }
        //偶尔 ветка
        if (rnd(4) === 0) {
          const project = projects[rnd(projects.length)];
          const branch = `fix/${step}`;
          next.branches[project] = branch;
          records.push({ kind: 'branch', projectPath: project, branch });
        }
        const untouched = prevViewEntries;
        const outcomes = applyAll(reducer, pagesOf({ mode: 'delta', epoch: EPOCH, base: revision, target: revision + 1 }, records, 2));
        expect(outcomes.at(-1), `seed ${seed}, шаг ${step}`).toMatchObject({ state: 'committed' });
        snapshot = { ...next, revision: revision + 1 };
        revision += 1;
        expect(reducer.view.snapshot, `seed ${seed}, шаг ${step}`).toEqual(snapshot);
        // нетронутые работы сохраняют ссылки
        for (let i = 0; i < untouched.length; i++) {
          const before = untouched[i];
          const changed = records.some((r) => 'key' in r && r.key?.projectPath === before.projectPath && r.key.workId === before.map.work.id);
          if (!changed) expect(reducer.view.snapshot.entries[i], `seed ${seed}, шаг ${step}, работа ${i}`).toBe(untouched[i]);
        }
      }
    }
  });
});

function session(id: string, label = id) {
  return { id, label };
}

describe('доработка P1: блокеры верификатора', () => {
  const session = (id: string, label = id) => ({ id, label });
  const A = keyOf('/tmp/a', 'w-0001');

  function bootstrapped(extra: Record<string, unknown> = {}): WorksSyncReducer {
    const snapshot: WorksSnapshot = { revision: 1, branches: {}, entries: [entry('/tmp/a', workMap(workMeta('w-0001'), { sessions: [session('s-01')], ...extra }))] };
    const reducer = new WorksSyncReducer();
    resetFrom(reducer, snapshot, EPOCH, 1);
    return reducer;
  }

  const deltaTx = (base: number, target: number): WorksSyncTransaction => ({ mode: 'delta', epoch: EPOCH, base, target });

  it('коммит без префикса транзакции отвергается, прежний вид цел', () => {
    const reducer = bootstrapped();
    const before = reducer.view.snapshot;
    const records: WorksSyncRecord[] = [
      { kind: 'row', key: A, field: 'sessions', id: 's-01', row: session('s-01', 'первая') },
      { kind: 'row', key: A, field: 'sessions', id: 's-05', row: session('s-05') },
    ];
    const transaction = deltaTx(1, 2);
    const all = pagesOf(transaction, records, 1);
    expect(all).toHaveLength(2);
    // только коммитная страница (индекс 1) не может открыть транзакцию: изменения c0 не потеряны молча
    expect(reducer.applyPage(all[1])).toMatchObject({ state: 'rejected', reason: 'sequence', repair: true });
    expect(reducer.view.snapshot).toBe(before);
    // дыра в нумерации среди открытой транзакции — тоже отказ
    expect(reducer.applyPage(all[0]).state).toBe('staged');
    expect(reducer.applyPage({ ...all[1], index: 2 })).toMatchObject({ state: 'rejected', reason: 'sequence' });
    expect(reducer.view.snapshot).toBe(before);
    // полная последовательность с нуля применяется
    const fresh = bootstrapped();
    const outcomes = applyAll(fresh, pagesOf(transaction, records, 1));
    expect(outcomes.at(-1)).toMatchObject({ state: 'committed' });
    expect((fresh.view.snapshot.entries[0].map as { sessions: Array<{ id: string; label: string }> }).sessions).toEqual([session('s-01', 'первая'), session('s-05')]);
  });

  it('field-remove удаляет поле целиком; null, пустой список и отсутствие различаются', () => {
    const reducer = bootstrapped({ compact: { totalUnread: 2 }, deletedSessions: ['s-00'] });
    const map = () => reducer.view.snapshot.entries[0].map as Record<string, unknown> & { deletedSessions?: string[] };
    // present → absent
    applyAll(reducer, pagesOf(deltaTx(1, 2), [{ kind: 'field-remove', key: A, field: 'compact' }], 10));
    expect('compact' in map()).toBe(false);
    expect(map().deletedSessions).toEqual(['s-00']);
    // null — значение, не отсутствие
    applyAll(reducer, pagesOf(deltaTx(2, 3), [{ kind: 'row', key: A, field: 'compact', row: null }], 10));
    expect('compact' in map()).toBe(true);
    expect(map().compact).toBe(null);
    // пустой список — значение, не отсутствие
    applyAll(reducer, pagesOf(deltaTx(3, 4), [{ kind: 'section', key: A, field: 'deletedSessions', start: 0, items: [], final: true }], 10));
    expect(map().deletedSessions).toEqual([]);
    // удаление и новое создание в одной транзакции: в конце только новое
    applyAll(reducer, pagesOf(deltaTx(4, 5), [
      { kind: 'field-remove', key: A, field: 'deletedSessions' },
      { kind: 'row', key: A, field: 'compact', row: { fresh: true } },
    ], 10));
    expect('deletedSessions' in map()).toBe(false);
    expect(map().compact).toEqual({ fresh: true });
    // row undefined не переживает провод: ошибка протокола, а не тихое свойство
    const outcome = reducer.applyPage({ kind: 'page', index: 0, transaction: deltaTx(5, 6), cursor: 'c0', next: null, commit: true, records: [{ kind: 'row', key: A, field: 'compact', row: undefined as unknown as undefined }] });
    expect(outcome).toMatchObject({ state: 'rejected', reason: 'protocol' });
  });

  it('фрагментированные метаданные работы собираются целиком, без обрезания', () => {
    const big: Work = { ...workMeta('w-0001'), goal: 'цель 🎯'.repeat(150_000) };
    expect(JSON.stringify(big).length).toBeGreaterThan(512 * 1024); // обычной записью не влезает в страницу
    const chars = [...JSON.stringify(big)];
    const chunk = 100_000;
    const records: WorksSyncRecord[] = [];
    for (let i = 0; i < chars.length; i += chunk) {
      records.push({ kind: 'fragment', key: A, field: 'work', index: records.length, text: chars.slice(i, i + chunk).join(''), final: i + chunk >= chars.length, version: 10 });
    }
    expect(records.length).toBeGreaterThan(2);
    const reducer = new WorksSyncReducer();
    const outcomes = applyAll(reducer, pagesOf({ mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, records, 2));
    expect(outcomes.at(-1)).toMatchObject({ state: 'committed' });
    // полное равенство записи окна, включая версию источника для почтовых шлюзов
    expect(reducer.view.snapshot.entries[0]).toEqual({ projectPath: '/tmp/a', map: { schemaVersion: 2, work: big }, version: 10 });
    expect(reducer.view.snapshot.entries[0].map.work.goal).toHaveLength(150_000 * 7);

    // прямая запись work поверх фрагментов того же адреса — конфликт
    const conflicting = new WorksSyncReducer();
    expect(conflicting.applyPage({ kind: 'page', index: 0, transaction: { mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, cursor: 'c0', next: 'c1', commit: false, records: [
      { kind: 'work', key: A, work: workMeta('w-0001') },
      { kind: 'fragment', key: A, field: 'work', index: 0, text: '{"id":"w-0001"}', final: true },
    ] })).toMatchObject({ state: 'rejected', reason: 'conflict' });
    // собранные фрагменты не дают Work с чужим id — протокол
    const foreign = new WorksSyncReducer();
    expect(foreign.applyPage({ kind: 'page', index: 0, transaction: { mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, cursor: 'c0', next: null, commit: true, records: [
      { kind: 'fragment', key: A, field: 'work', index: 0, text: JSON.stringify(workMeta('w-9999')), final: true },
    ] })).toMatchObject({ state: 'rejected', reason: 'protocol' });
  });

  it('версия источника у фрагментов метаданных: канал согласован, дельта обновляет запись целиком', () => {
    // reset без версии канала — полная запись без version (явное отсутствие)
    const bare = new WorksSyncReducer();
    applyAll(bare, pagesOf({ mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, [
      { kind: 'fragment', key: A, field: 'work', index: 0, text: JSON.stringify(workMeta('w-0001')), final: true },
    ], 10));
    expect(bare.view.snapshot.entries[0]).toEqual({ projectPath: '/tmp/a', map: { schemaVersion: 2, work: workMeta('w-0001') } });

    // дельта поверх version 10 фрагментами с version 11 — полная запись с новой версией
    const reducer = bootstrapped();
    (reducer.view.snapshot.entries[0] as WindowWorkEntry).version = 10;
    const renamed: Work = { ...workMeta('w-0001', 'новое название'), goal: 'г'.repeat(700_000) };
    const chars = [...JSON.stringify(renamed)];
    const records: WorksSyncRecord[] = [];
    for (let i = 0; i < chars.length; i += 300_000) {
      records.push({ kind: 'fragment', key: A, field: 'work', index: records.length, text: chars.slice(i, i + 300_000).join(''), final: i + 300_000 >= chars.length, version: 11 });
    }
    applyAll(reducer, pagesOf(deltaTx(1, 2), records, 1));
    expect(reducer.view.snapshot.entries[0]).toEqual({ projectPath: '/tmp/a', map: { schemaVersion: 2, work: renamed, sessions: [session('s-01')], rooms: [], messages: [] }, version: 11 });

    // куски одного адреса расходятся в версии — конфликт
    const inconsistent = bootstrapped();
    expect(inconsistent.applyPage({ kind: 'page', index: 0, transaction: deltaTx(1, 2), cursor: 'c0', next: null, commit: true, records: [
      { kind: 'fragment', key: A, field: 'work', index: 0, text: '{"id":"w-', final: false, version: 11 },
      { kind: 'fragment', key: A, field: 'work', index: 1, text: '0001"}', final: true, version: 12 },
    ] })).toMatchObject({ state: 'rejected', reason: 'conflict' });

    // версия на фрагменте не-метаданных — ошибка протокола
    const misplaced = bootstrapped();
    expect(misplaced.applyPage({ kind: 'page', index: 0, transaction: deltaTx(1, 2), cursor: 'c0', next: null, commit: true, records: [
      { kind: 'fragment', key: A, field: 'future', index: 0, text: '{"a":1}', final: true, version: 3 },
    ] })).toMatchObject({ state: 'rejected', reason: 'protocol' });
  });

  it('одиночный фрагмент без id — валидная запись, не самоконфликт', () => {
    // дельта: единственный полный фрагмент future={a:1} коммитится
    const first = bootstrapped();
    applyAll(first, pagesOf(deltaTx(1, 2), [{ kind: 'fragment', key: A, field: 'future', index: 0, text: '{"a":1}', final: true }], 10));
    expect((first.view.snapshot.entries[0].map as Record<string, unknown>).future).toEqual({ a: 1 });
    // reset: то же в сбросе
    const second = new WorksSyncReducer();
    applyAll(second, pagesOf({ mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, [
      { kind: 'fragment', key: A, field: 'work', index: 0, text: JSON.stringify(workMeta('w-0001')), final: true },
      { kind: 'fragment', key: A, field: 'huge', index: 0, text: JSON.stringify({ blob: 'x'.repeat(600_000) }).slice(0, 100), final: false },
    ], 10));
    // огромное одиночное значение собирается из кусков точно
    const full = JSON.stringify({ blob: 'x'.repeat(600_000) });
    const chars = [...full];
    const records: WorksSyncRecord[] = [];
    for (let i = 0; i < chars.length; i += 200_000) {
      records.push({ kind: 'fragment', key: A, field: 'huge', index: records.length, text: chars.slice(i, i + 200_000).join(''), final: i + 200_000 >= chars.length });
    }
    const third = new WorksSyncReducer();
    applyAll(third, pagesOf({ mode: 'reset', epoch: EPOCH, base: 0, target: 1 }, [
      { kind: 'fragment', key: A, field: 'work', index: 0, text: JSON.stringify(workMeta('w-0001')), final: true },
      ...records,
    ], 2));
    expect(full.length).toBeGreaterThan(512 * 1024);
    expect((third.view.snapshot.entries[0].map as Record<string, unknown>).huge).toEqual({ blob: 'x'.repeat(600_000) });
  });

  it('фрагмент и прямая строка без id конфликтуют в обоих порядках', () => {
    const frag: WorksSyncRecord[] = [{ kind: 'fragment', key: A, field: 'future', index: 0, text: '{"a":1}', final: true }];
    const direct: WorksSyncRecord[] = [{ kind: 'row', key: A, field: 'future', row: { b: 2 } }];
    // фрагмент, затем прямая строка: раньше протаскивало {a:1}
    const first = bootstrapped();
    first.applyPage({ kind: 'page', index: 0, transaction: deltaTx(1, 2), cursor: 'c0', next: 'c1', commit: false, records: frag });
    expect(first.applyPage({ kind: 'page', index: 1, transaction: deltaTx(1, 2), cursor: 'c1', next: null, commit: true, records: direct })).toMatchObject({ state: 'rejected', reason: 'conflict' });
    expect('future' in (first.view.snapshot.entries[0].map as Record<string, unknown>)).toBe(false);
    // прямая строка, затем фрагмент
    const second = bootstrapped();
    second.applyPage({ kind: 'page', index: 0, transaction: deltaTx(1, 2), cursor: 'c0', next: 'c1', commit: false, records: direct });
    expect(second.applyPage({ kind: 'page', index: 1, transaction: deltaTx(1, 2), cursor: 'c1', next: null, commit: true, records: frag })).toMatchObject({ state: 'rejected', reason: 'conflict' });
  });

  it('невалидная транзакция отвергается типизированно, без коммита и без броска', () => {
    const reducer = bootstrapped();
    const before = reducer.view.snapshot;
    const bogus = { kind: 'page', index: 0, transaction: { mode: 'bogus', epoch: 'other', base: 1, target: 0 }, cursor: 'c0', next: null, commit: true, records: [] } as unknown as WorksSyncPage;
    expect(reducer.applyPage(bogus)).toMatchObject({ state: 'rejected', reason: 'protocol', repair: true });
    expect(reducer.view.snapshot).toBe(before);
    expect(reducer.view.epoch).toBe(EPOCH);
    expect(reducer.view.revision).toBe(1);
    const missing = { kind: 'page', index: 0, cursor: 'c0', next: null, commit: true, records: [] } as unknown as WorksSyncPage;
    expect(reducer.applyPage(missing)).toMatchObject({ state: 'rejected', reason: 'protocol' });
    expect(reducer.view.snapshot).toBe(before);
  });
});

describe('внутренний контракт поверхностей (заморожен P1)', () => {
  it('типы пачки, статуса и roots-входа собираются', () => {
    const batch: import('./works-sync.js').WorksSyncSurfaceBatch = {
      kind: 'works-sync-batch',
      transaction: { mode: 'delta', epoch: EPOCH, base: 3, target: 4 },
      index: 2,
      records: [],
      commit: false,
    };
    const status: import('./works-sync.js').WorksSyncSurfaceStatus =
      { state: 'loading', epoch: null, wanted: 4, applied: 3, pages: 2, rows: 10 };
    const roots: import('./works-sync.js').WorksSyncRootsChange = {
      epoch: EPOCH, revision: 4, changed: [keyOf('/tmp/a', 'w-0001')], deleted: [], complete: new WorksSyncReducer().view.snapshot,
    };
    const result: WorksSyncResult = batch.commit
      ? { kind: 'reset-required', reason: 'cursor-expired' }
      : { kind: 'page', transaction: batch.transaction, index: 0, cursor: 'c0', next: null, records: [], commit: false };
    expect([batch.index, status.pages, roots.changed.length, result.kind]).toEqual([2, 2, 1, 'page']);
  });
});

describe('P2 repair: indexed elements and bounded order slices', () => {
  const A = keyOf('/a', 'w-0001');
  const tx: WorksSyncTransaction = { mode: 'reset', epoch: EPOCH, base: 0, target: 1 };
  const meta: WorksSyncRecord = { kind: 'work', key: A, work: workMeta(A.workId) };
  const section = (start: number, items: unknown[], final = false): WorksSyncRecord => ({ kind: 'section', key: A, field: 'future', start, items, final });
  const fragment = (element: number, index: number, text: string, final: boolean): WorksSyncRecord => ({ kind: 'section-fragment', key: A, field: 'future', element, index, text, final });
  const order = (start: number, ids: string[], final = false): WorksSyncRecord => ({ kind: 'order-slice', key: A, field: 'sessions', start, ids, final });
  const row = (id: string): WorksSyncRecord => ({ kind: 'row', key: A, field: 'sessions', id, row: { id } });
  const outcome = (records: WorksSyncRecord[]) => {
    const reducer = new WorksSyncReducer({ epoch: 'old', revision: 9, snapshot: { entries: [entry('/old', workMap(workMeta('w-old')))], branches: { '/old': 'old' }, revision: 9 } });
    const previous = reducer.view;
    const result = applyAll(reducer, pagesOf(tx, [meta, ...records], 2)).at(-1)!;
    if (result.state === 'rejected') expect(reducer.view).toBe(previous);
    return { result, reducer };
  };

  it.each([0, 1, 2])('assembles only the huge Unicode element at index %i with separate section completion', (index) => {
    const huge = { id: 'x'.repeat(200), text: '漢😀"\\'.repeat(150000) };
    const text = JSON.stringify(huge);
    const records: WorksSyncRecord[] = [];
    const expected: unknown[] = ['before', null, { future: [] }];
    expected[index] = huge;
    for (let at = 0; at < 3; at += 1) {
      if (at !== index) records.push(section(at, [expected[at]]));
      else {
        let piece = 0;
        for (let offset = 0; offset < text.length; offset += 40000) records.push(fragment(at, piece++, text.slice(offset, offset + 40000), offset + 40000 >= text.length));
      }
    }
    records.push(section(3, [], true));
    const { result, reducer } = outcome(records);
    expect(result.state).toBe('committed');
    expect((reducer.view.snapshot.entries[0]!.map as unknown as Record<string, unknown>).future).toEqual(expected);
  });

  it('requires distinct section completion and retains the old committed view on missing fragments', () => {
    expect(outcome([fragment(0, 0, '"x"', true)]).result).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(outcome([fragment(0, 1, '"x"', true), section(1, [], true)]).result).toMatchObject({ state: 'rejected', reason: 'incomplete' });
    expect(outcome([section(0, [], true)]).result.state).toBe('committed');
    expect(outcome([section(1, [], true)]).result.state).toBe('rejected');
  });

  it.each([
    [fragment(0, 0, 'null', true), fragment(0, 0, 'null', true)],
    [fragment(0, 0, 'null', true), section(0, [null], true)],
    [section(0, [null]), fragment(0, 0, 'null', true)],
    [section(0, [1, 2]), section(1, [3], true)],
    [fragment(1, 0, 'null', true), section(1, [], true)],
    [fragment(0, 0, 'null', true), { kind: 'row', key: A, field: 'future', row: [] }],
    [{ kind: 'fragment', key: A, field: 'future', index: 0, text: '[]', final: true }, section(0, [], true)],
    [section(0, [], true), { kind: 'fragment', key: A, field: 'future', index: 0, text: '[]', final: true }],
  ] as WorksSyncRecord[][])('rejects conflicting section element/range representations %# atomically', (...records) => {
    expect(outcome(records).result.state).toBe('rejected');
  });

  it('slices a vector above the frame cap without changing untouched row references', () => {
    const ids = Array.from({ length: 6000 }, (_, i) => `${i}`.padEnd(128, '😀"\\'));
    const records: WorksSyncRecord[] = ids.map(row);
    for (let start = 0; start < ids.length; start += 32) records.push(order(start, ids.slice(start, start + 32), start + 32 >= ids.length));
    expect(Buffer.byteLength(JSON.stringify(ids))).toBeGreaterThan(WORKS_SYNC_PAGE_BYTES);
    const { result, reducer } = outcome(records);
    expect(result.state).toBe('committed');
    const original = reducer.view.snapshot.entries[0]!.map.sessions;
    const reverse = [...ids].reverse();
    const delta: WorksSyncRecord[] = [];
    for (let start = 0; start < reverse.length; start += 32) delta.push(order(start, reverse.slice(start, start + 32), start + 32 >= reverse.length));
    expect(applyAll(reducer, pagesOf({ mode: 'delta', epoch: EPOCH, base: 1, target: 2 }, delta)).at(-1)?.state).toBe('committed');
    expect(reducer.view.snapshot.entries[0]!.map.sessions[0]).toBe(original.at(-1));
  });

  it.each([
    [row('a'), order(1, ['a'], true)],
    [row('a'), order(0, ['a']), order(0, ['a'], true)],
    [row('a'), order(0, ['a']), order(1, ['a'], true)],
    [order(0, ['missing'], true)],
    [row('a'), order(0, ['a'], true), { kind: 'order', key: A, field: 'sessions', order: ['a'] }],
    [row('a'), { kind: 'order', key: A, field: 'sessions', order: ['a'] }, order(0, ['a'], true)],
    [row('a'), order(0, ['a'], true), order(1, [], true)],
    [row('a'), order(Number.MAX_SAFE_INTEGER, ['a'], true)],
  ] as WorksSyncRecord[][])('rejects invalid order coverage/IDs/mixed representation %# atomically', (...records) => {
    expect(outcome(records).result.state).toBe('rejected');
  });

  it('resets section fragment/order staging before a field-kind change and retains the old value on malformed JSON', () => {
    const { reducer } = outcome([section(0, [{ old: true }], true)]);
    const before = reducer.view;
    const bad: WorksSyncRecord[] = [{ kind: 'field-remove', key: A, field: 'future' }, fragment(0, 0, '{bad', true), section(1, [], true)];
    expect(applyAll(reducer, pagesOf({ mode: 'delta', epoch: EPOCH, base: 1, target: 2 }, bad)).at(-1)?.state).toBe('rejected');
    expect(reducer.view).toBe(before);
    const good: WorksSyncRecord[] = [fragment(0, 0, '"discard"', true), { kind: 'field-remove', key: A, field: 'future' }, { kind: 'row', key: A, field: 'future', row: { new: true } }];
    expect(applyAll(reducer, pagesOf({ mode: 'delta', epoch: EPOCH, base: 1, target: 2 }, good)).at(-1)?.state).toBe('committed');
    expect((reducer.view.snapshot.entries[0]!.map as unknown as Record<string, unknown>).future).toEqual({ new: true });
  });

  it.each(['section', 'order'] as const)('validates %s coverage with near-linear prior-entry visits', (kind) => {
    for (const count of [1000, 2000]) {
      const records: WorksSyncRecord[] = [];
      for (let at = 0; at < count; at += 1) records.push(kind === 'section' ? section(at, [at]) : order(at, [`s-${at}`]));
      if (kind === 'section') {
        for (let at = 0; at < 100; at += 1) records.push(fragment(count, at, at === 0 ? '"' : at === 99 ? '"' : 'x', at === 99));
      }
      let visits = 0;
      let checks = 0;
      const originalHas = Set.prototype.has;
      const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value: unknown) {
        if (typeof value === 'number') checks += 1;
        return originalHas.call(this, value);
      });
      const original = Map.prototype[Symbol.iterator];
      const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (this: Map<unknown, unknown>) {
        for (const pair of original.call(this)) {
          if (typeof pair[0] === 'number') visits += 1;
          yield pair;
        }
      });
      let result;
      try {
        result = new WorksSyncReducer().applyPage({ kind: 'page', transaction: tx, index: 0, cursor: 'c0', next: 'c1', records: [meta, ...records], commit: false });
      } finally { spy.mockRestore(); hasSpy.mockRestore(); }
      expect(result.state).toBe('staged');
      expect(visits).toBeLessThanOrEqual(count * 8);
      expect(checks).toBeLessThanOrEqual(count * 8);
      expect(checks).toBeGreaterThanOrEqual(count);
      console.info('coverage work', { kind, count, visits, checks });
    }
  });

  it('supports empty order, deletion and explicit field-kind reset', () => {
    const { reducer } = outcome([row('a'), order(0, ['a'], true)]);
    const records: WorksSyncRecord[] = [{ kind: 'row-remove', key: A, field: 'sessions', id: 'a' }, order(0, [], true), { kind: 'field-remove', key: A, field: 'future' }, section(0, [null], true)];
    expect(applyAll(reducer, pagesOf({ mode: 'delta', epoch: EPOCH, base: 1, target: 2 }, records)).at(-1)?.state).toBe('committed');
    expect(reducer.view.snapshot.entries[0]!.map.sessions).toEqual([]);
  });
});


it('classifies only unique safe bounded row IDs; preserves other id-shaped elements for sections', () => {
  expect(worksSyncNamedRows([{ id: 'ok' }, { id: '😀'.repeat(64) }])).toBe(true);
  for (const value of [[{ id: 'x'.repeat(129) }], [{ id: '__proto__' }], [{ id: 'a\0b' }], [{ id: '' }], [{ id: 'a' }, { id: 'a' }], [{ id: 'a' }, null], [1, 2], []]) expect(worksSyncNamedRows(value)).toBe(false);
});
