import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkMap } from '@parley/core';
import { WorksSyncReducer, type WorksSyncPage, type WorksSyncRecord, type WorksSyncSurfaceBatch } from '@parley/protocol';
import { DesktopWorksSync, surfaceBatches } from './works-sync.js';
import { bindWorksSyncWindow } from './ipc.js';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';

const key = { projectPath: '/project', workId: 'w-1' };
const work = { id: 'w-1', title: 'Work', goal: '', status: 'active', createdAt: '', updatedAt: '' } as const;
const map = (): WorkMap => ({ schemaVersion: 2, work: { ...work }, sessions: [], messages: [], rooms: [] });
const records = (): WorksSyncRecord[] => [
  { kind: 'work', key, work: { ...work }, version: 7 },
  { kind: 'row', key, field: 'sessions', row: [] },
  { kind: 'row', key, field: 'rooms', row: [] },
];
function page(target = 1, patch: Partial<WorksSyncPage> = {}): WorksSyncPage {
  return { kind: 'page', transaction: { mode: 'reset', epoch: 'a', base: 0, target }, index: 0,
    cursor: 'p0', next: null, records: records(), commit: true, ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function apply(reducer: WorksSyncReducer, batch: WorksSyncSurfaceBatch) {
  return reducer.applyPage({ ...batch, kind: 'page', cursor: `p${batch.index}`,
    next: batch.commit ? null : `p${batch.index + 1}` });
}
const instances: DesktopWorksSync[] = [];
function create(...args: ConstructorParameters<typeof DesktopWorksSync>) {
  const sync = new DesktopWorksSync(...args);
  instances.push(sync);
  return sync;
}
afterEach(() => { for (const sync of instances.splice(0)) sync.dispose(); vi.useRealTimers(); });

describe('desktop works synchronizer (fake transport, capability disabled)', () => {
  it('delivers a completed same-revision reset to both consumers after Retry and reconnect', async () => {
    const sync = create({ pull: async () => page() });
    const main: WorksSyncSurfaceBatch[] = [], island: WorksSyncSurfaceBatch[] = [];
    sync.attach({ batch: async batch => { main.push(batch); }, status: () => {} });
    sync.attach({ batch: async batch => { island.push(batch); }, status: () => {} }, true);
    sync.connect();
    await vi.waitFor(() => expect(main.filter(batch => batch.commit)).toHaveLength(1));
    sync.retry();
    await vi.waitFor(() => expect(island.filter(batch => batch.commit)).toHaveLength(2));
    sync.disconnect(); sync.connect();
    await vi.waitFor(() => expect(main.filter(batch => batch.commit)).toHaveLength(3));
    expect(island.filter(batch => batch.commit)).toHaveLength(3);
    expect(main.every(batch => batch.transaction.mode === 'reset' && batch.transaction.target === 1)).toBe(true);
  });

  it('preserves fragment generations around field deletion/recreation in main, renderer and island', async () => {
    const pull = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(2, {
      transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, records: [
        { kind: 'fragment', key, field: 'future', index: 0, text: '"A"', final: true },
        { kind: 'field-remove', key: { workId: key.workId, projectPath: key.projectPath }, field: 'future' },
        { kind: 'fragment', key, field: 'future', index: 0, text: '"B"', final: true },
      ],
    }));
    const sync = create({ pull });
    const renderer = new WorksSyncReducer();
    const island = new WorksSyncReducer();
    sync.attach({ batch: async (batch) => { apply(renderer, batch); }, status: () => {} });
    sync.attach({ batch: async (batch) => { apply(island, batch); }, status: () => {} }, true);
    sync.connect();
    await vi.waitFor(() => expect(renderer.view.revision).toBe(1));
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.waitFor(() => expect(island.view.revision).toBe(2));
    expect(sync.view.snapshot.entries[0]?.map).toHaveProperty('future', 'B');
    expect(renderer.view).toEqual(sync.view);
    expect(island.view).toEqual(sync.view);
  });
  it('stages pages atomically, permits only one pull, and coalesces invalidations', async () => {
    const first = deferred<WorksSyncPage>();
    const second = deferred<WorksSyncPage>();
    const pull = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(page(3, { transaction: { mode: 'delta', epoch: 'a', base: 1, target: 3 }, records: [] }));
    const sync = create({ pull });
    const statuses: string[] = [];
    sync.attach({ batch: async () => {}, status: (status) => { statuses.push(status.state); } });
    sync.connect();
    expect(statuses).not.toContain('error');
    sync.invalidate({ epoch: 'a', revision: 2 });
    sync.invalidate({ epoch: 'a', revision: 3 });
    expect(pull).toHaveBeenCalledTimes(1);
    first.resolve(page(1, { next: 'p1', commit: false }));
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    expect(sync.ready).toBe(false);
    expect(sync.view.snapshot.entries).toEqual([]);
    second.resolve(page(1, { index: 1, cursor: 'p1', records: [] }));
    await vi.waitFor(() => expect(sync.status).toEqual({ state: 'current', epoch: 'a', applied: 3 }));
    expect(pull.mock.calls.map(([request]) => request)).toEqual([{ base: 0 }, { cursor: 'p1' }, { base: 1 }]);
    expect(sync.view.snapshot.entries[0]?.version).toBe(7);
  });

  it('retains the committed view across rejected reset and bounded retry', async () => {
    vi.useFakeTimers();
    const pull = vi.fn().mockResolvedValueOnce(page())
      .mockResolvedValueOnce({ kind: 'reset-required', reason: 'base' })
      .mockResolvedValueOnce(page(2));
    const sync = create({ pull }, { retryMs: 50 });
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    const committed = sync.view;
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.view).toBe(committed);
    expect(sync.status.state).toBe('error');
    expect(pull).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(pull.mock.calls[2]?.[0]).toEqual({ base: 0 });
    expect(sync.status).toEqual({ state: 'current', epoch: 'a', applied: 2 });
  });

  it('ignores old replies after reconnect or disposal and never overlaps pulls', async () => {
    const old = deferred<WorksSyncPage>();
    const pull = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(4, {
      transaction: { mode: 'reset', epoch: 'b', base: 0, target: 4 },
    }));
    const sync = create({ pull });
    sync.connect();
    sync.disconnect();
    sync.connect();
    expect(pull).toHaveBeenCalledTimes(1);
    old.resolve(page());
    await vi.waitFor(() => expect(sync.view.epoch).toBe('b'));
    expect(pull).toHaveBeenCalledTimes(2);
    const late = deferred<WorksSyncPage>();
    pull.mockReturnValueOnce(late.promise);
    sync.invalidate({ epoch: 'b', revision: 5 });
    sync.dispose();
    late.resolve(page(5));
    await Promise.resolve();
    expect(sync.view.revision).toBe(4);
  });

  it('waits for one commit for main lookups and fails closed on connection loss', async () => {
    const pending = deferred<WorksSyncPage>();
    const sync = create({ pull: () => pending.promise });
    sync.connect();
    const lookup = sync.snapshotForLookup();
    let finished = false;
    void lookup.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    pending.resolve(page());
    expect((await lookup).entries[0]?.map.work.id).toBe('w-1');
    sync.disconnect();
    await expect(sync.snapshotForLookup()).rejects.toThrow('not ready');
  });

  it('tracks bootstrap page progress and persistent legacy oversize staleness', async () => {
    vi.useFakeTimers();
    const next = deferred<WorksSyncPage>();
    const pull = vi.fn().mockResolvedValueOnce(page(1, { commit: false, next: 'p1' })).mockReturnValueOnce(next.promise);
    const sync = create({ pull }, { staleMs: 100 });
    sync.connect();
    await vi.advanceTimersByTimeAsync(99);
    expect(sync.status.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.status).toMatchObject({ state: 'stale', reason: 'no-page-progress' });
    next.resolve(page(1, { index: 1, cursor: 'p1', records: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.status.state).toBe('current');
    const legacy = create({ pull: vi.fn(), list: async () => { throw Object.assign(new Error('too large'), { code: 'snapshot_too_large' }); } });
    legacy.connect(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(legacy.status.state).toBe('stale');
    expect(legacy.ready).toBe(false);
  });

  it('replays a bounded coherent reset to late surfaces, then sparse deltas with backpressure', async () => {
    const delta = page(2, { transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 },
      records: [{ kind: 'row', key, field: 'future', row: 'updated' }] });
    const pull = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(delta);
    const sync = create({ pull }, { pageBytes: 700 });
    sync.connect();
    await vi.waitFor(() => expect(sync.ready).toBe(true));
    const received: WorksSyncSurfaceBatch[] = [];
    const ack = deferred<void>();
    const consumer = new WorksSyncReducer();
    const detach = sync.attach({ batch: async (batch) => {
      received.push(batch);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(700);
      apply(consumer, batch);
      if (received.length === 1) await ack.promise;
    }, status: () => {} });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.waitFor(() => expect(sync.view.revision).toBe(2));
    expect(received).toHaveLength(1);
    ack.resolve();
    await vi.waitFor(() => expect(consumer.view.revision).toBe(2));
    const changes = received.filter((batch) => batch.transaction.mode === 'delta').flatMap((batch) => batch.records);
    expect(changes).toEqual(delta.records);
    detach();
  });

  it('sanitizes fragmented island sessions before any IPC, retaining public binding and source version', async () => {
    const session = { id: 's-1', providerSessionId: 'public-thread', task: '🙂'.repeat(500), codexThreadBinding: { threadId: 'SECRET', pid: 42 } };
    const json = JSON.stringify(session);
    const source = page(1, { records: [ ...records(), { kind: 'field-remove', key, field: 'sessions' },
      { kind: 'fragment', key, field: 'sessions', id: 's-1', index: 0, text: json.slice(0, 300), final: false },
      { kind: 'fragment', key, field: 'sessions', id: 's-1', index: 1, text: json.slice(300), final: true },
      { kind: 'order', key, field: 'sessions', order: ['s-1'] } ] });
    const sync = create({ pull: async () => source }, { pageBytes: 700 });
    const received: WorksSyncSurfaceBatch[] = [];
    const consumer = new WorksSyncReducer();
    sync.attach({ batch: async (batch) => { received.push(batch); apply(consumer, batch); }, status: () => {} }, true);
    sync.connect();
    await vi.waitFor(() => expect(consumer.view.revision).toBe(1));
    expect(JSON.stringify(received)).not.toContain('SECRET');
    expect(JSON.stringify(received)).not.toContain('codexThreadBinding');
    expect(consumer.view.snapshot.entries[0]?.map.sessions[0]?.providerSessionId).toBe('public-thread');
    expect(consumer.view.snapshot.entries[0]?.version).toBe(7);
    expect(source.records).toHaveLength(7);
  });

  it('does not encode the global view or untouched work rows for a sparse delta', async () => {
    const sync = create({ pull: vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(2, {
      transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, records: [{ kind: 'row', key, field: 'future', row: 2 }],
    })) });
    const batches: WorksSyncSurfaceBatch[] = [];
    sync.attach({ batch: async (batch) => { batches.push(batch); }, status: () => {} });
    sync.connect();
    await vi.waitFor(() => expect(sync.status.state).toBe('current'));
    const snapshot = sync.view.snapshot;
    const untouched = snapshot.entries[0]?.map.work;
    const stringify = vi.spyOn(JSON, 'stringify');
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.waitFor(() => expect(sync.view.revision).toBe(2));
    expect(stringify.mock.calls.some(([value]) => value === snapshot || value === untouched)).toBe(false);
    stringify.mockRestore();
    expect(sync.view.snapshot.entries[0]?.map.work).toBe(untouched);
    expect(batches.filter((b) => b.transaction.mode === 'delta').flatMap((b) => b.records))
      .toEqual([{ kind: 'row', key, field: 'future', row: 2 }]);
  });

  it('reports reset deletions to the committed-only adapter, never partial or failed pages', async () => {
    const last = deferred<WorksSyncPage>();
    const pull = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(2, {
      transaction: { mode: 'reset', epoch: 'b', base: 0, target: 2 }, records: [], commit: false, next: 'p1',
    })).mockReturnValueOnce(last.promise);
    const sync = create({ pull });
    const listener = vi.fn();
    sync.onCommit(listener);
    sync.connect();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    sync.invalidate({ epoch: 'b', revision: 2 });
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(3));
    expect(listener).toHaveBeenCalledTimes(1);
    last.resolve(page(2, { transaction: { mode: 'reset', epoch: 'b', base: 0, target: 2 }, index: 1, cursor: 'p1', records: [] }));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls[1]?.[0]).toMatchObject({ deleted: [key], changed: [], complete: { entries: [] } });
  });

  it('treats actual old-host oversize as persistent stale and ordinary errors as retryable connection errors', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValueOnce(Object.assign(new Error('oversize'), { code: 'internal', data: { reason: 'snapshot-too-large' } }))
      .mockResolvedValueOnce({ entries: [{ projectPath: key.projectPath, map: map() }], branches: {} });
    const sync = create({ pull: vi.fn(), list });
    const statuses: string[] = [];
    sync.attach({ batch: async () => {}, status: (status) => { statuses.push(status.state); } });
    sync.connect(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.status.state).toBe('stale');
    sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('current');
    const broken = create({ pull: vi.fn(), list: async () => { throw new Error('socket closed'); } });
    broken.connect(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(broken.status).toMatchObject({ state: 'error', error: 'connection', retryable: true });
  });

  it('backs off on missing page prefixes and no-progress replies without publishing a partial view', async () => {
    vi.useFakeTimers();
    const pull = vi.fn().mockResolvedValueOnce(page(1, { index: 1 })).mockResolvedValueOnce(page());
    const sync = create({ pull }, { retryMs: 50 });
    const commits = vi.fn();
    sync.onCommit(commits);
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.status).toMatchObject({ state: 'error', error: 'protocol' });
    expect(commits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(commits).toHaveBeenCalledTimes(1);
    pull.mockResolvedValue(page(1, { transaction: { mode: 'delta', epoch: 'a', base: 1, target: 1 }, records: [] }));
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.status.state).toBe('error');
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('counts page progress during reconnect while retaining old data until the replacement commit', async () => {
    vi.useFakeTimers();
    const first = deferred<WorksSyncPage>();
    const last = deferred<WorksSyncPage>();
    const pull = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const sync = create({ pull }, { staleMs: 100 });
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    const old = sync.view;
    sync.connect();
    await vi.advanceTimersByTimeAsync(90);
    first.resolve(page(2, { transaction: { mode: 'reset', epoch: 'b', base: 0, target: 2 }, next: 'p1', commit: false }));
    await vi.advanceTimersByTimeAsync(90);
    expect(sync.status.state).toBe('loading');
    expect(sync.view).toBe(old);
    last.resolve(page(2, { transaction: { mode: 'reset', epoch: 'b', base: 0, target: 2 }, index: 1, cursor: 'p1', records: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.status.state).toBe('current');
  });

  it('forwards deletion after a fragment without fabricating an undefined row', async () => {
    const pull = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page(2, {
      transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, records: [
        { kind: 'fragment', key, field: 'future', index: 0, text: '"value"', final: true },
        { kind: 'field-remove', key, field: 'future' },
      ],
    }));
    const sync = create({ pull });
    const consumer = new WorksSyncReducer();
    sync.attach({ batch: async (batch) => { apply(consumer, batch); }, status: () => {} });
    sync.connect();
    await vi.waitFor(() => expect(consumer.view.revision).toBe(1));
    sync.invalidate({ epoch: 'a', revision: 2 });
    await vi.waitFor(() => expect(consumer.view.revision).toBe(2));
    expect(consumer.view.snapshot.entries[0]?.map).not.toHaveProperty('future');
  });

  it('preserves named/indexed field transitions and section-fragment generations in every consumer', async () => {
    const named = { id: 'valid', value: 1 };
    const indexed = { id: 'x'.repeat(200), value: 'B' };
    const values = [
      page(1, { records: [...records(), { kind: 'row', key, field: 'futureRows', id: named.id, row: named },
        { kind: 'order-slice', key, field: 'futureRows', start: 0, ids: [named.id], final: true }] }),
      page(2, { transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, records: [
        { kind: 'field-remove', key, field: 'futureRows' },
        { kind: 'section-fragment', key, field: 'futureRows', element: 0, index: 0, text: '"A"', final: true },
        { kind: 'field-remove', key, field: 'futureRows' },
        { kind: 'section-fragment', key, field: 'futureRows', element: 0, index: 0, text: JSON.stringify(indexed), final: true },
        { kind: 'section', key, field: 'futureRows', start: 1, items: [], final: true },
      ] }),
      page(3, { transaction: { mode: 'delta', epoch: 'a', base: 2, target: 3 }, records: [
        { kind: 'field-remove', key, field: 'futureRows' },
        { kind: 'row', key, field: 'futureRows', id: named.id, row: named },
        { kind: 'order-slice', key, field: 'futureRows', start: 0, ids: [named.id], final: true },
      ] }),
      page(4, { transaction: { mode: 'delta', epoch: 'a', base: 3, target: 4 }, records: [{ kind: 'field-remove', key, field: 'futureRows' }] }),
    ];
    const sync = create({ pull: async () => values.shift()! }, { pageBytes: 1_024 });
    const renderer = new WorksSyncReducer();
    const island = new WorksSyncReducer();
    sync.attach({ batch: async (batch) => { expect(apply(renderer, batch).state).not.toBe('rejected'); }, status: () => {} });
    sync.attach({ batch: async (batch) => { expect(apply(island, batch).state).not.toBe('rejected'); }, status: () => {} }, true);
    sync.connect();
    for (let revision = 1; revision <= 4; revision++) {
      if (revision > 1) sync.invalidate({ epoch: 'a', revision });
      await vi.waitFor(() => expect(island.view.revision).toBe(revision));
      expect(renderer.view).toEqual(sync.view);
      expect(island.view).toEqual(sync.view);
      if (revision === 2) expect((sync.view.snapshot.entries[0]?.map as unknown as { futureRows: unknown[] }).futureRows).toEqual([indexed]);
    }
  });
});

describe('bounded local batches', () => {
  it('keeps near-cap ordinary rows lossless when the batch index gains digits', async () => {
    const empty = { kind: 'row', key, field: 'futureRows', id: 'r000', row: { id: 'r000', text: '' } };
    const transaction = { mode: 'reset', epoch: 'a', base: 0, target: 1 } as const;
    const base = Buffer.byteLength(JSON.stringify({ kind: 'works-sync-batch', transaction, index: 0, records: [empty], commit: false }));
    const m = map();
    Object.assign(m, { futureRows: Array.from({ length: 120 }, (_, i) => ({ id: `r${String(i).padStart(3, '0')}`, text: 'x'.repeat(700 - base) })) });
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m }], branches: {} };
    for await (const batch of surfaceBatches(snapshot, transaction, 700)) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(700);
      expect(apply(reducer, batch).state).not.toBe('rejected');
    }
    expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
  });
  it('bounds fragment sizing candidates before encoding and counts/yields rejected attempts', async () => {
    const m = map();
    m.work.title = '雪\\"🙂'.repeat(20_000);
    const counters = { valueEncodes: 0, fragmentSizingAttempts: 0, fragmentRejectedAttempts: 0,
      maxFragmentCandidateChars: 0, fragmentCandidateChars: 0, fragmentSizingYields: 0 };
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m, version: 3 }], branches: {} };
    let actualAttempts = 0;
    let actualMax = 0;
    const encode = JSON.stringify.bind(JSON);
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (value?.kind === 'works-sync-batch' && value.records?.[0]?.kind === 'fragment') {
        actualAttempts++;
        actualMax = Math.max(actualMax, value.records[0].text.length);
      }
      return encode(value, ...args);
    });
    try {
      for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 1 }, 2_048, false, counters)) {
        expect(Buffer.byteLength(encode(batch))).toBeLessThanOrEqual(2_048);
        apply(reducer, batch);
      }
      expect(actualAttempts).toBeGreaterThan(0);
      expect(actualMax).toBeLessThanOrEqual(2_048);
      expect(counters.fragmentSizingAttempts).toBeGreaterThan(0);
      expect(counters.maxFragmentCandidateChars).toBeLessThanOrEqual(2_048);
      expect(counters.fragmentRejectedAttempts).toBeGreaterThan(0);
      expect(counters.fragmentSizingYields).toBe(counters.fragmentRejectedAttempts);
      expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
    } finally { spy.mockRestore(); }
  });
  it('replays an oversized order with bounded slices and no aggregate list/vector encoding', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `r-${i}`, text: '雪' }));
    const sync = create({ pull: async () => page(1, { records: [...records(), { kind: 'row', key, field: 'futureRows', row: rows }] }) }, { pageBytes: 700 });
    sync.connect();
    await vi.waitFor(() => expect(sync.ready).toBe(true));
    const consumer = new WorksSyncReducer();
    const received: WorksSyncSurfaceBatch[] = [];
    const stringify = vi.spyOn(JSON, 'stringify');
    sync.attach({ batch: async (batch) => {
      received.push(batch);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(700);
      apply(consumer, batch);
    }, status: () => {} });
    await vi.waitFor(() => expect(consumer.view.revision).toBe(1));
    expect(consumer.view).toEqual(sync.view);
    expect(received.flatMap((batch) => batch.records).some((record) => record.kind === 'order-slice')).toBe(true);
    expect(stringify.mock.calls.some(([value]) => value?.kind === 'order')).toBe(false);
    expect(stringify.mock.calls.some(([value]) => value === rows)).toBe(false);
    stringify.mockRestore();
  });

  it('replays an escaped max-ID vector larger than both512KiB wire and2KiB local budgets', async () => {
    const rows = Array.from({ length: 6_000 }, (_, i) => ({ id: String(i).padStart(4, '0') + '雪"\\'.repeat(41) + 'Z' }));
    expect(rows.every(row => row.id.length === 128)).toBe(true);
    const orderBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.id)) + 1, 1);
    expect(orderBytes).toBeGreaterThan(512 * 1_024);
    const m = map();
    Object.assign(m, { futureRows: rows });
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m }], branches: {} };
    const reducer = new WorksSyncReducer();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 1 }, 2_048)) {
        expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(2_048);
        expect(apply(reducer, batch).state).not.toBe('rejected');
      }
      expect(stringify.mock.calls.some(([value]) => value === rows || value?.kind === 'order')).toBe(false);
      expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
    } finally { stringify.mockRestore(); }
  });

  it.each([0, 1, 2])('fragments only an oversized unnamed Unicode element at index %i', async (at) => {
    const m = map();
    const list: unknown[] = ['before', null, { after: true }];
    list[at] = { id: 'huge'.repeat(100), text: '雪"\\🙂'.repeat(3_000) };
    Object.assign(m, { future: list });
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m }], branches: {} };
    const records: WorksSyncRecord[] = [];
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 1 }, 2_048)) {
        expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(2_048);
        records.push(...batch.records);
        expect(apply(reducer, batch).state).not.toBe('rejected');
      }
      expect(records.some((r) => r.kind === 'section-fragment' && r.element === at)).toBe(true);
      expect(records.some((r) => r.kind === 'section' && r.field === 'future' && r.final)).toBe(true);
      expect(stringify.mock.calls.some(([value]) => value === list)).toBe(false);
      expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
    } finally { stringify.mockRestore(); }
  });

  it('uses lossless indexed fallback for unsafe, duplicate and huge IDs', async () => {
    const m = map();
    const list = [{ id: '__proto__', value: 1 }, { id: 'duplicate' }, { id: 'duplicate' }, { id: 'x'.repeat(200), text: 'large'.repeat(1_000) }];
    Object.assign(m, { futureRows: list });
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m }], branches: {} };
    for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 1 }, 2_048)) {
      expect(apply(reducer, batch).state).not.toBe('rejected');
    }
    expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
  });

  it('projects host section fragments before island IPC, including fragments after section completion', async () => {
    const session = { id: 'x'.repeat(200), providerSessionId: 'public-thread', task: '雪'.repeat(4_000), codexThreadBinding: { pid: 42, threadId: 'SECRET' } };
    const text = JSON.stringify(session);
    const source = page(1, { records: [...records(), { kind: 'field-remove', key, field: 'sessions' },
      { kind: 'section', key, field: 'sessions', start: 1, items: [], final: true },
      { kind: 'section-fragment', key, field: 'sessions', element: 0, index: 0, text: text.slice(0, 200), final: false },
      { kind: 'section-fragment', key: { workId: key.workId, projectPath: key.projectPath }, field: 'sessions', element: 0, index: 1, text: text.slice(200), final: true },
    ] });
    const sync = create({ pull: async () => source }, { pageBytes: 2_048 });
    const island = new WorksSyncReducer();
    const received: WorksSyncSurfaceBatch[] = [];
    sync.attach({ batch: async (batch) => { received.push(batch); expect(apply(island, batch).state).not.toBe('rejected'); }, status: () => {} }, true);
    sync.connect();
    await vi.waitFor(() => expect(island.view.revision).toBe(1));
    expect(JSON.stringify(received)).not.toContain('SECRET');
    expect(JSON.stringify(received)).not.toContain('codexThreadBinding');
    const expected = { ...session };
    delete (expected as Partial<typeof session>).codexThreadBinding;
    expect(island.view.snapshot.entries[0]?.map.sessions).toEqual([expected]);
    const late = new WorksSyncReducer();
    sync.attach({ batch: async (batch) => { expect(apply(late, batch).state).not.toBe('rejected'); }, status: () => {} }, true);
    await vi.waitFor(() => expect(late.view.revision).toBe(1));
    expect(late.view).toEqual(island.view);
  });

  it('round-trips oversized Unicode work metadata with source versions and unknown fields', async () => {
    const m = map();
    m.work.title = '🚀'.repeat(500);
    Object.assign(m, { future: Array.from({ length: 100 }, () => ({ text: '雪' })) });
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m, version: 12 }], branches: { '/project': 'main' } };
    for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 6 }, 700)) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(700);
      apply(reducer, batch);
    }
    expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 6 });
  });

  it('replays many unnamed elements in bounded sections without aggregate array encoding', async () => {
    const m = map();
    Object.assign(m, { futureRows: Array.from({ length: 100 }, () => ({ text: '雪' })) });
    const reducer = new WorksSyncReducer();
    const snapshot = { entries: [{ projectPath: key.projectPath, map: m }], branches: {} };
    for await (const batch of surfaceBatches(snapshot, { mode: 'reset', epoch: 'a', base: 0, target: 1 }, 700)) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(700);
      apply(reducer, batch);
    }
    expect(reducer.view.snapshot).toEqual({ ...snapshot, revision: 1 });
  });
});

describe('works sync window IPC', () => {
  it('replays an unnamed list above5MiB through bounded trusted-frame envelopes without aggregate encoding', async () => {
    const list = Array.from({ length: 1_024 }, (_, position) => ({ position, text: '雪'.repeat(2_048) }));
    expect(list.length * list[0]!.text.length * 3).toBeGreaterThan(5 * 1_024 * 1_024);
    const source: WorksSyncRecord[] = [...records(), ...list.map((value, start): WorksSyncRecord =>
      ({ kind: 'section', key, field: 'futureMany', start, items: [value], final: false })),
    { kind: 'section', key, field: 'futureMany', start: list.length, items: [], final: true }];
    const pages: WorksSyncPage[] = [];
    for (let from = 0; from < source.length; from += 64) {
      const index = pages.length;
      const commit = from + 64 >= source.length;
      const next = page(1, { index, cursor: `p${index}`, next: commit ? null : `p${index + 1}`, commit, records: source.slice(from, from + 64) });
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(512 * 1_024);
      pages.push(next);
    }
    const sync = create({ pull: async () => pages.shift()! });
    sync.connect();
    await vi.waitFor(() => expect(sync.ready).toBe(true));
    const ipc = new EventEmitter();
    const window = new EventEmitter();
    const contents = new EventEmitter();
    Object.assign(contents, { mainFrame: {} });
    const event = { sender: contents, senderFrame: (contents as unknown as { mainFrame: object }).mainFrame };
    const consumer = new WorksSyncReducer();
    let delivered = 0;
    Object.assign(contents, { send: (channel: string, stream: number, delivery: number, batch: WorksSyncSurfaceBatch) => {
      if (channel !== 'works-sync:batch') return;
      expect(Buffer.byteLength(JSON.stringify([channel, stream, delivery, batch]))).toBeLessThanOrEqual(512 * 1_024);
      expect(apply(consumer, batch).state).not.toBe('rejected');
      if (!batch.commit) expect(consumer.view.revision).toBe(0);
      delivered++;
      queueMicrotask(() => ipc.emit('works-sync:ack', event, stream, delivery));
    } });
    Object.assign(window, { webContents: contents, isDestroyed: () => false });
    const dispose = bindWorksSyncWindow(ipc as IpcMain, window as BrowserWindow, sync);
    const complete = (sync.view.snapshot.entries[0]!.map as unknown as { futureMany: unknown[] }).futureMany;
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      ipc.emit('works-sync:subscribe', event, 1);
      await vi.waitFor(() => expect(consumer.view.revision).toBe(1));
      expect(delivered).toBeGreaterThan(1);
      expect(stringify.mock.calls.some(([value]) => value === complete || value === sync.view.snapshot)).toBe(false);
      expect(consumer.view).toEqual(sync.view);
    } finally { stringify.mockRestore(); dispose(); }
  });

  it('waits for trusted frame acknowledgements and disposes subscription on reload/close', async () => {
    const ipc = new EventEmitter();
    const window = new EventEmitter();
    const contents = new EventEmitter();
    const send = vi.fn();
    Object.assign(contents, { mainFrame: {}, send });
    Object.assign(window, { webContents: contents, isDestroyed: () => false });
    const sync = create({ pull: async () => page(1, { records: [...records(), { kind: 'row', key, field: 'large', row: 'x'.repeat(1_000) }] }) }, { pageBytes: 700 });
    const dispose = bindWorksSyncWindow(ipc as IpcMain, window as BrowserWindow, sync);
    const event = { sender: contents, senderFrame: (contents as unknown as { mainFrame: object }).mainFrame };
    ipc.emit('works-sync:subscribe', { ...event, senderFrame: {} }, 1);
    expect(send).not.toHaveBeenCalled();
    ipc.emit('works-sync:subscribe', event, 1);
    sync.connect();
    const batches = () => send.mock.calls.filter(([channel]) => channel === 'works-sync:batch');
    await vi.waitFor(() => expect(batches()).toHaveLength(1));
    const [, stream, delivery] = batches()[0]!;
    ipc.emit('works-sync:ack', { ...event, sender: {} }, stream, delivery);
    await Promise.resolve();
    expect(batches()).toHaveLength(1);
    ipc.emit('works-sync:ack', event, stream, delivery);
    await vi.waitFor(() => expect(batches().length).toBeGreaterThan(1));
    contents.emit('did-start-navigation', {}, 'about:blank', false, true);
    const count = batches().length;
    ipc.emit('works-sync:ack', event, stream, delivery);
    await Promise.resolve();
    expect(batches()).toHaveLength(count);
    dispose();
    expect(ipc.listenerCount('works-sync:subscribe')).toBe(0);
  });

  it('exposes an ACK timeout and permits retry to reattach the same consumer', async () => {
    vi.useFakeTimers();
    const ipc = new EventEmitter();
    const window = new EventEmitter();
    const contents = new EventEmitter();
    const send = vi.fn();
    Object.assign(contents, { mainFrame: {}, send });
    Object.assign(window, { webContents: contents, isDestroyed: () => false });
    const sync = create({ pull: async () => page() });
    const dispose = bindWorksSyncWindow(ipc as IpcMain, window as BrowserWindow, sync);
    const event = { sender: contents, senderFrame: (contents as unknown as { mainFrame: object }).mainFrame };
    ipc.emit('works-sync:subscribe', event, 1);
    sync.connect();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send.mock.calls.some(([channel, , status]) => channel === 'works-sync:status' && status.state === 'error' && status.error === 'protocol')).toBe(true);
    ipc.emit('works-sync:retry', event);
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.filter(([channel]) => channel === 'works-sync:batch')).toHaveLength(2);
    dispose();
  });
});
