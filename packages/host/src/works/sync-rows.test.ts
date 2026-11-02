import { describe, expect, it, vi } from 'vitest';
import { addSession, mailWorkMap, mapLetterReader } from '@parley/core';
import type { WindowWorkMap } from '@parley/core';
import { WorksSyncReducer, WORKS_SYNC_PAGE_BYTES } from '@parley/protocol';
import type { WorksSyncPage, WorksSyncRecord } from '@parley/protocol';
import { SyncRows, encodeSyncRecords, EncodedSyncPageCache } from './sync-rows.js';

const key = { projectPath: '/fixture', workId: 'w-01' };
function fixture(count = 3): WindowWorkMap {
  const map: WindowWorkMap = {
    schemaVersion: 2,
    work: { id: key.workId, title: 'work', goal: 'goal', status: 'active', createdAt: 'x', updatedAt: 'x' },
    sessions: [], rooms: [], messages: [],
  };
  for (let i = 0; i < count; i += 1) addSession(map, { provider: 'codex', label: `session${i}`, task: 'task' });
  return mailWorkMap(map, mapLetterReader(map));
}
const collect = async <T>(rows: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const row of rows) out.push(row); return out; };
const frame = (records: WorksSyncRecord[]): unknown => ({ id: '😀"\\', result: { records } });
const makeStats = () => ({ attempts: 0, attemptedRecords: 0, attemptedBytes: 0, encodeMs: 0, retries: 0, fragments: 0 });
function apply(reducer: WorksSyncReducer, records: WorksSyncRecord[], base: number, target: number, reset = false) {
  const page: WorksSyncPage = { kind: 'page', transaction: { mode: reset ? 'reset' : 'delta', epoch: 'fixture', base, target }, index: 0, cursor: 'c', next: null, records, commit: true };
  expect(reducer.applyPage(page).state).toBe('committed');
}

describe('immutable sync rows', () => {
  it('dense → nochange → sparse edit preserves pinned rows and encodes no equal rows', async () => {
    const cache = new SyncRows();
    const map = fixture(20);
    await cache.update(key, map, 1, 1);
    const pinned = cache.snapshot(key)!;
    const reducer = new WorksSyncReducer();
    apply(reducer, await collect(cache.records(key, -1)), 0, 1, true);
    for (const row of map.sessions) row.task = 'dense';
    await cache.update(key, map, 2, 2);
    apply(reducer, await collect(cache.records(key, 1)), 1, 2);
    await cache.update(key, map, 2, 3);
    const stats = makeStats();
    expect(await collect(encodeSyncRecords(cache.records(key, 2), { frame, stats }))).toEqual([]);
    expect(stats.attempts).toBe(0);
    map.sessions[4]!.task = 'sparse';
    await cache.update(key, map, 3, 4);
    const changed = await collect(cache.records(key, 2));
    expect(changed.filter(r => r.kind === 'row')).toHaveLength(1);
    expect(changed.some(r => r.kind === 'order' || r.kind === 'order-slice')).toBe(false);
    const sparseStats = makeStats();
    await collect(encodeSyncRecords(cache.records(key, 2), { frame, stats: sparseStats }));
    expect(sparseStats.attemptedRecords).toBe(2);
    apply(reducer, changed, 2, 4);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
    expect(pinned.map.sessions[4]!.task).toBe('task');
    expect(Object.isFrozen(pinned.map.sessions[4])).toBe(true);
    expect(cache.snapshot(key)!.lastStructuralRevision).toBe(4);
  });

  it('skipped revisions retain deletes, order, field removal/type changes and source versions', async () => {
    const cache = new SyncRows();
    const map = fixture();
    Object.assign(map, { future: { a: 1 }, optional: null });
    await cache.update(key, map, 10, 1);
    const reducer = new WorksSyncReducer();
    apply(reducer, await collect(cache.records(key, -1)), 0, 1, true);
    map.sessions.splice(1, 1);
    Object.assign(map, { future: ['replacement'] });
    delete (map as unknown as Record<string, unknown>).optional;
    await cache.update(key, map, 11, 2);
    map.sessions.reverse();
    await cache.update(key, map, 12, 3);
    const records = await collect(cache.records(key, 1));
    expect(records.some(r => r.kind === 'row-remove')).toBe(true);
    expect(records.some(r => r.kind === 'field-remove')).toBe(true);
    apply(reducer, records, 1, 3);
    expect(reducer.view.snapshot.entries[0]).toEqual({ projectPath: key.projectPath, map, version: 12 });
    cache.noteMailVersion(key, 13);
    expect(await collect(cache.records(key, 3))).toEqual([]);
    expect(cache.snapshot(key)!.sourceVersion).toBe(13);
    expect(cache.snapshot(key)!.lastStructuralRevision).toBe(3);
    cache.remove(key, 4);
    expect(await collect(cache.records(key, 3))).toEqual([{ kind: 'work-remove', key }]);
  });

  it.each([42, undefined])('bounds counted overflow retries and round-trips huge Unicode row/work (version %s)', async (version) => {
    const cache = new SyncRows();
    const map = fixture(10);
    map.work.goal = '😀"\\\n'.repeat(150000);
    map.sessions[0]!.task = '漢😀"\\'.repeat(150000);
    await cache.update(key, map, version, 1);
    const stats = makeStats();
    const pages = await collect(encodeSyncRecords(cache.records(key, -1), { frame, maxBytes: 2048, batchSize: 8, stats }));
    expect(stats.retries).toBeGreaterThan(0);
    expect(stats.fragments).toBeGreaterThan(0);
    expect(stats.attempts).toBeGreaterThan(pages.length);
    expect(stats.attemptedBytes).toBeGreaterThan(pages.reduce((n, p) => n + p.bytes, 0));
    for (const page of pages) {
      expect(page.bytes).toBe(Buffer.byteLength(page.json + '\n'));
      expect(page.bytes).toBeLessThanOrEqual(2048);
      expect(JSON.parse(page.json)).toEqual(frame(page.records));
    }
    const reducer = new WorksSyncReducer();
    for (let i = 0; i < pages.length; i += 1) {
      const commit = i === pages.length - 1;
      const result = reducer.applyPage({ kind: 'page', transaction: { mode: 'reset', epoch: 'fixture', base: 0, target: 1 }, index: i, cursor: `c${i}`, next: commit ? null : `c${i + 1}`, records: pages[i]!.records, commit });
      expect(result.state).toBe(commit ? 'committed' : 'staged');
      if (!commit) expect(reducer.view.snapshot.entries).toEqual([]);
    }
    expect(reducer.view.snapshot.entries[0]).toEqual({ projectPath: key.projectPath, ...(version === undefined ? {} : { version }), map });
  });

  it('uses bounded native batches for allchanged and exposes cooperative slice/heap observations', async () => {
    const stats = { yields: 0, maxSliceMs: 0 };
    const cache = new SyncRows({ stats, batchSize: 128 });
    const map = fixture(3000);
    const before = process.memoryUsage().heapUsed;
    await cache.update(key, map, 1, 1);
    for (const session of map.sessions) session.task = 'changed';
    await cache.update(key, map, 2, 2);
    const encoding = makeStats();
    const pages = await collect(encodeSyncRecords(cache.records(key, 1), { frame, stats: encoding, batchSize: 32 }));
    expect(pages.every(p => p.bytes <= WORKS_SYNC_PAGE_BYTES)).toBe(true);
    expect((await collect(cache.records(key, 1))).filter(r => r.kind === 'row')).toHaveLength(3000);
    expect(stats.yields).toBeGreaterThan(0);
    console.info('P2 3k observations', { ...stats, heapGrowthBytes: process.memoryUsage().heapUsed - before, encoding });
  });

  it('keeps a pinned selection stable through prune and resets fields after work recreation', async () => {
    const cache = new SyncRows();
    const first = fixture();
    Object.assign(first, { oldField: { private: 'old' } });
    await cache.update(key, first, 1, 1);
    const pinned = cache.records(key, -1);
    const reducer = new WorksSyncReducer();
    apply(reducer, await collect(cache.records(key, -1)), 0, 1, true);
    cache.remove(key, 2);
    const replacement = fixture(1);
    await cache.update(key, replacement, 3, 3);
    apply(reducer, await collect(cache.records(key, 1)), 1, 3);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(replacement);
    await cache.prune(3);
    const historical = new WorksSyncReducer();
    apply(historical, await collect(pinned), 0, 1, true);
    expect(historical.view.snapshot.entries[0]!.map).toEqual(first);
  });

  it('replaces normal unnamed arrays through bounded indexed sections', async () => {
    const cache = new SyncRows();
    const map = fixture(1);
    Object.assign(map, { future: Array.from({ length: 2000 }, (_, i) => ({ index: i, text: `normal-${i}` })) });
    await cache.update(key, map, 1, 1);
    const stats = makeStats();
    const pages = await collect(encodeSyncRecords(cache.records(key, -1), { frame, stats, maxBytes: 2048 }));
    const records = pages.flatMap(p => p.records);
    expect(records.some(r => r.kind === 'section' && r.field === 'future')).toBe(true);
    expect(records.filter(r => r.kind === 'section').every(r => r.kind === 'section' && r.items.length <= 32)).toBe(true);
    const reducer = new WorksSyncReducer();
    apply(reducer, records, 0, 1, true);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
  });

  it.each([0, 500, 1999])('keeps unnamed lists indexed with a huge Unicode member at %i', async (index) => {
    const cache = new SyncRows();
    const map = fixture(1);
    const future = Array.from({ length: 2000 }, (_, i) => ({ index: i, text: `normal-${i}` }));
    future[index] = { index, text: '漢😀"\\'.repeat(150000) };
    Object.assign(map, { future });
    await cache.update(key, map, 1, 1);
    const fullArrayEncodes: number[] = [];
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (Array.isArray(value) && value.length > 32) fullArrayEncodes.push(value.length);
      return (original as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    const stats = makeStats();
    let pages;
    try {
      pages = await collect(encodeSyncRecords(cache.records(key, -1), {
        frame: records => {
          for (const record of records) {
            if (record.kind === 'row' && record.field === 'future' && Array.isArray(record.row)) fullArrayEncodes.push(record.row.length);
          }
          return frame(records);
        }, stats, maxBytes: 2048, batchSize: 32,
      }));
    } finally { spy.mockRestore(); }
    console.info('P2 unnamed huge-member scope', { fullArrayEncodes, stats });
    expect(fullArrayEncodes).toEqual([]);
    expect(pages.flatMap(p => p.records).some(r => r.kind === 'section' && r.field === 'future')).toBe(true);
    const reducer = new WorksSyncReducer();
    apply(reducer, pages.flatMap(p => p.records), 0, 1, true);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
  });

  it('uses indexed fallback for huge and unsafe ID-shaped values, including field-kind transitions', async () => {
    const cache = new SyncRows();
    const map = fixture(1);
    Object.assign(map, { future: [{ id: 'safe', value: 1 }] });
    await cache.update(key, map, 1, 1);
    const reducer = new WorksSyncReducer();
    apply(reducer, await collect(cache.records(key, -1)), 0, 1, true);
    Object.assign(map, { future: [{ id: '漢'.repeat(200000), value: 2 }, { id: '__proto__', value: null }] });
    await cache.update(key, map, 2, 2);
    const pages = await collect(encodeSyncRecords(cache.records(key, 1), { frame, stats: makeStats(), maxBytes: 2048 }));
    const records = pages.flatMap(p => p.records);
    expect(records.some(r => r.kind === 'field-remove' && r.field === 'future')).toBe(true);
    expect(records.some(r => r.kind === 'section-fragment')).toBe(true);
    apply(reducer, records, 1, 2);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
    Object.assign(map, { future: [{ id: 'safe-again' }] });
    await cache.update(key, map, 3, 3);
    apply(reducer, await collect(cache.records(key, 2)), 2, 3);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
  });

  it('never encodes an aggregate order vector even when escaped bounded IDs exceed the page cap', async () => {
    const cache = new SyncRows();
    const map = fixture(1);
    Object.assign(map, { futureNamed: Array.from({ length: 6000 }, (_, i) => ({ id: `${i}`.padEnd(128, '😀"\\') })) });
    await cache.update(key, map, 1, 1);
    const arrays: number[] = [];
    const pages = await collect(encodeSyncRecords(cache.records(key, -1), {
      frame: records => {
        for (const record of records) {
          if (record.kind === 'order') arrays.push(record.order.length);
          if (record.kind === 'order-slice' && record.ids.length > 32) arrays.push(record.ids.length);
        }
        return frame(records);
      }, stats: makeStats(), maxBytes: 2048,
    }));
    expect(arrays).toEqual([]);
    expect(pages.every(p => p.bytes <= 2048)).toBe(true);
    expect(pages.flatMap(p => p.records).some(r => r.kind === 'order-slice')).toBe(true);
    const reducer = new WorksSyncReducer();
    apply(reducer, pages.flatMap(p => p.records), 0, 1, true);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
  });

  it('rejects unsafe field keys atomically and falls back losslessly for duplicate identities', async () => {
    const cache = new SyncRows();
    const map = fixture();
    await cache.update(key, map, 1, 1);
    const previous = cache.snapshot(key)!;
    Object.defineProperty(map, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true });
    await expect(cache.update(key, map, 2, 2)).rejects.toThrow('Unsafe');
    expect(cache.snapshot(key)!.map).toBe(previous.map);
    delete (map as unknown as Record<string, unknown>).__proto__;
    map.sessions.push(map.sessions[0]!);
    await cache.update(key, map, 2, 2);
    const reducer = new WorksSyncReducer();
    apply(reducer, await collect(cache.records(key, -1)), 0, 2, true);
    expect(reducer.view.snapshot.entries[0]!.map).toEqual(map);
  });

  it('re-enumerates one captured pin independently after updates and iterator cancellation', async () => {
    const cache = new SyncRows();
    const map = fixture();
    await cache.update(key, map, 1, 1);
    const pinned = cache.records(key, -1);
    const expected = await collect(pinned);
    map.sessions[0]!.task = 'later';
    await cache.update(key, map, 2, 2);
    const a = pinned[Symbol.asyncIterator]();
    const b = pinned[Symbol.asyncIterator]();
    expect((await a.next()).value).toEqual(expected[0]);
    expect((await b.next()).value).toEqual(expected[0]);
    await a.return?.();
    const remaining: WorksSyncRecord[] = [];
    for (;;) { const next = await b.next(); if (next.done) break; remaining.push(next.value); }
    expect(remaining).toEqual(expected.slice(1));
    expect(await collect(pinned)).toEqual(expected);
  });

  it('reuses immutable resident pages and evicts within the separate byte budget', () => {
    const cache = new EncodedSyncPageCache(10);
    cache.set('a', { json: '12345', bytes: 5 });
    const resident = cache.get('a');
    expect(resident?.json).toBe('12345');
    expect(cache.get('a')).toBe(resident);
    expect(Object.isFrozen(resident)).toBe(true);
    expect(() => cache.set('underreported', { json: '😀', bytes: 2 })).toThrow('byte count');
    cache.set('b', { json: '123456', bytes: 6 });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.bytes).toBe(6);
    cache.set('huge', { json: 'x'.repeat(20), bytes: 20 });
    expect(cache.bytes).toBeLessThanOrEqual(10);
  });
});
