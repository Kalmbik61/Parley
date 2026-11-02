import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompactMail, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE, type WorksMailStatePage, type WorksMailStateResult, type WorksSyncPage, type WorksSyncRecord, type WorksSyncSurfaceBatch, type WorksSyncSurfaceStatus } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { useWorksStore } from './works.js';
import { DesktopWorksSync } from '../../main/works-sync.js';
import { useRoomPagesStore } from './room-pages.js';

const disposers: Array<() => void> = [];
beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: true, ready: false, error: null });
  useRoomPagesStore.setState({ opened: {}, pending: {}, chains: {}, loading: {}, quotes: {} });
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); });

function work(version?: number): WindowWorkEntry {
  const entry = makeWork('w-01', { rooms: [makeRoom('r-01', 'Room')] });
  return { ...entry, ...(version === undefined ? {} : { version }), map: { ...entry.map, compact: {
    version: 2, rooms: { 'r-01': { total: 0, top: 0, lastAt: null, unread: 0, decision: null } },
    unread: { letters: 0, rooms: { 'r-01': 0 } }, mentionCandidates: [], cut: [], omitted: {},
  } } };
}
function records(entry: WindowWorkEntry): WorksSyncRecord[] {
  const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
  return [{ kind: 'work', key, work: entry.map.work, ...(entry.version === undefined ? {} : { version: entry.version }) },
    ...Object.entries(entry.map).filter(([field]) => field !== 'work' && field !== 'schemaVersion')
      .map(([field, row]): WorksSyncRecord => ({ kind: 'row', key, field, row }))];
}
function mailPage(entry: WindowWorkEntry, sourceVersion = entry.version ?? 0, requiredStructuralVersion = entry.version ?? 0, unread = 0, epoch = 'a'): WorksMailStatePage {
  const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
  const compact = entry.map.compact as MapCompactMail;
  return { kind: 'mail-page', epoch, key, sourceVersion, requiredStructuralVersion, index: 0, cursor: 'm0', next: null, commit: true,
    records: [{ kind: 'mail-summary', key, unreadLetters: unread },
      { kind: 'section', key, field: 'mailRooms', start: 0, items: Object.entries(compact.rooms).map(([roomId, metadata]) => ({ roomId, metadata })), final: true },
      { kind: 'section', key, field: 'unreadRooms', start: 0, items: [], final: true },
      { kind: 'section', key, field: 'mentionCandidates', start: 0, items: [], final: true }] };
}
function surface() {
  const bridge = createFakeBridge();
  bridge.emitStatus({ state: 'connected', hostVersion: 'test', methods: null, features: [ROOMS_MAIL_FEATURE] });
  let latest = work();
  bridge.setHandler('works.mailState', () => mailPage(latest));
  let batch!: (batch: WorksSyncSurfaceBatch) => void | Promise<void>;
  let status!: (status: WorksSyncSurfaceStatus) => void;
  const unsubscribe = vi.fn();
  const retry = vi.fn();
  bridge.worksSync = { subscribe: (onBatch, onStatus) => { batch = onBatch; status = onStatus; return unsubscribe; }, retry };
  disposers.push(useWorksStore.getState().init(bridge, { sync: true }));
  return { bridge, status: (value: WorksSyncSurfaceStatus) => status(value), retry, unsubscribe,
    batch: (value: WorksSyncSurfaceBatch) => batch(value),
    commit: (entry: WindowWorkEntry, target = 1, base = 0, epoch = 'a') => { latest = entry; return batch({ kind: 'works-sync-batch',
      transaction: { mode: base === 0 ? 'reset' : 'delta', epoch, base, target }, index: 0, records: records(entry), commit: true }); } };
}
const numbers = (): MapCompactMail => useWorksStore.getState().entries[0]!.map.compact as MapCompactMail;

describe('bounded works sync renderer', () => {
  it('preserves restored entries and readiness through partial bootstrap; never calls works.list', async () => {
    const restored = makeWork('restored');
    useWorksStore.setState({ entries: [restored] });
    const sync = surface();
    sync.status({ state: 'loading', epoch: null, applied: 0, wanted: 1, pages: 0, rows: 0 });
    const transaction = { mode: 'reset', epoch: 'a', base: 0, target: 1 } as const;
    await sync.batch({ kind: 'works-sync-batch', transaction, index: 0, records: records(work(40)), commit: false });
    expect(useWorksStore.getState().entries).toEqual([restored]);
    expect(useWorksStore.getState().ready).toBe(false);
    expect(sync.bridge.calls.some(call => call.method === 'works.list')).toBe(false);
    await sync.batch({ kind: 'works-sync-batch', transaction, index: 1, records: [], commit: true });
    expect(useWorksStore.getState().entries[0]?.map.work.id).toBe('w-01');
    expect(useWorksStore.getState().ready).toBe(true);
    sync.bridge.emit('works.changed', { entries: [restored], branches: {}, revision: 999 });
    expect(useWorksStore.getState().entries[0]?.map.work.id).toBe('w-01');
  });

  it('gates every mail merge on committed entry.version, distinct from held mail and global revision', async () => {
    const sync = surface();
    await sync.commit(work(40), 1000);
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 55, prevVersion: 40, unread: { letters: 8, rooms: {} } }));
    expect(numbers().unread.letters).toBe(8);
    const mail = vi.fn();
    disposers.push(useWorksStore.getState().onMail(mail));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 56, prevVersion: 55, requiredStructuralVersion: 50,
      rooms: [makeMailRoom('r-01')], unread: { letters: 1, rooms: {} } }));
    expect(numbers().unread.letters).toBe(8);
    expect(mail).not.toHaveBeenCalled();
    await sync.commit(work(50), 1001, 1000);
    expect(numbers().unread.letters).toBe(1);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it('does not infer structural coverage for a versionless committed work', async () => {
    const sync = surface();
    await sync.commit(work());
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 0, requiredStructuralVersion: 1,
      unread: { letters: 9, rooms: {} } }));
    expect(numbers().unread.letters).toBe(0);
    await sync.commit(work(1), 2, 1);
    expect(numbers().unread.letters).toBe(9);
  });

  it('keeps sync status and explicit retry while preserving committed data on errors', async () => {
    const sync = surface();
    await sync.commit(work(40));
    const entries = useWorksStore.getState().entries;
    sync.status({ state: 'stale', epoch: 'a', wanted: 2, applied: 1, reason: 'no-commit' });
    expect(useWorksStore.getState().syncStatus?.state).toBe('stale');
    expect(useWorksStore.getState().entries).toBe(entries);
    useWorksStore.getState().retrySync();
    expect(sync.retry).toHaveBeenCalledTimes(1);
    await sync.commit(work(41), 2, 1);
    expect(useWorksStore.getState().error).toBeNull();
  });

  it('preserves newer mail numbers through a versionless snapshot without inventing structural coverage', async () => {
    const sync = surface();
    await sync.commit(work(40));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 55, prevVersion: 40, unread: { letters: 8, rooms: {} } }));
    await sync.commit(work(), 2, 1);
    expect(numbers().unread.letters).toBe(8);
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 56, prevVersion: 55, requiredStructuralVersion: 50,
      unread: { letters: 1, rooms: {} } }));
    expect(numbers().unread.letters).toBe(8);
  });

  it('keeps mail received during a new-epoch partial reset until that epoch commits', async () => {
    const sync = surface();
    await sync.commit(work(100));
    const transaction = { mode: 'reset', epoch: 'b', base: 0, target: 1 } as const;
    await sync.batch({ kind: 'works-sync-batch', transaction, index: 0, records: records(work(2)), commit: false });
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 3, prevVersion: 2, requiredStructuralVersion: 2,
      unread: { letters: 3, rooms: {} } }));
    expect(numbers().unread.letters).toBe(0);
    await sync.batch({ kind: 'works-sync-batch', transaction, index: 1, records: [], commit: true });
    expect(numbers().unread.letters).toBe(3);
  });

  it('retains mail delivery after a duplicate committed reset replay', async () => {
    const sync = surface();
    await sync.commit(work(1));
    await sync.commit(work(1));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 2, prevVersion: 1, requiredStructuralVersion: 1,
      unread: { letters: 2, rooms: {} } }));
    expect(numbers().unread.letters).toBe(2);
  });
  it('keeps queue overflow durable after a complete structural commit', async () => {
    const sync = surface();
    await sync.commit(work(1));
    for (let version = 2; version <= 34; version++) sync.bridge.emit('rooms.mail', makeMailEvent({ version,
      prevVersion: version - 1, requiredStructuralVersion: 50, unread: { letters: version, rooms: {} } }));
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    await sync.commit(work(50), 2, 1);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    expect(numbers().unread.letters).toBe(0);
  });

  it('records a durable repair when the waiting-work queue evicts its oldest work', async () => {
    const sync = surface();
    await sync.commit(work(1));
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    let release!: (page: WorksMailStateResult) => void;
    sync.bridge.setHandler('works.mailState', () => new Promise(resolve => { release = resolve; }));
    for (let index = 0; index < 17; index++) sync.bridge.emit('rooms.mail', makeMailEvent({ workId: `pending-${index}`,
      version: 2, prevVersion: 1, requiredStructuralVersion: 2 }));
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    await sync.commit(work(2), 2, 1);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    release(mailPage(work(2)));
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
  });

  it('cancels queued mail for deleted works before the same ID is added again', async () => {
    const sync = surface();
    await sync.commit(work(1));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 1, requiredStructuralVersion: 9,
      unread: { letters: 9, rooms: {} } }));
    await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, index: 0,
      records: [{ kind: 'work-remove', key: { projectPath: '/tmp/proj', workId: 'w-01' } }], commit: true });
    await sync.commit(work(9), 3, 2);
    expect(numbers().unread.letters).toBe(0);
  });

  it('does not let an old held-range repair populate a deleted and recreated work', async () => {
    const sync = surface();
    let release!: (value: { messages: ReturnType<typeof makeLetter>[]; page: { complete: boolean; next: null } }) => void;
    sync.bridge.setHandler('context.messages', () => new Promise(resolve => { release = resolve; }));
    const initial = work(1);
    initial.map.messages = [makeLetter('m-1', { roomId: 'r-01' })];
    await sync.commit(initial);
    expect(release).toBeTypeOf('function');
    await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, index: 0,
      records: [{ kind: 'work-remove', key: { projectPath: '/tmp/proj', workId: 'w-01' } }], commit: true });
    await sync.commit(work(5), 3, 2);
    release({ messages: [makeLetter('m-999', { roomId: 'r-01' })], page: { complete: true, next: null } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useWorksStore.getState().entries[0]?.map.messages).toEqual([]);
  });

  it('preserves the last commit on malformed local batches and keeps a persistent consumer error until retry', async () => {
    const sync = surface();
    await sync.commit(work(1));
    const entries = useWorksStore.getState().entries;
    const malformed: WorksSyncSurfaceBatch = { kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 },
      index: 1, records: [], commit: true };
    expect(() => sync.batch(malformed)).toThrow('rejected');
    sync.status({ state: 'current', epoch: 'a', applied: 2 });
    expect(useWorksStore.getState().syncStatus?.state).toBe('error');
    expect(useWorksStore.getState().entries).toBe(entries);
    useWorksStore.getState().retrySync();
    await sync.commit(work(2), 2);
    expect(useWorksStore.getState().syncStatus?.state).toBe('current');
  });


  it('reconciles a zero-held-message bootstrap with exact equal-version replacement', async () => {
    const sync = surface();
    const entry = work(5);
    (entry.map.compact as MapCompactMail).mentionCandidates = [makeLetter('m-1')];
    sync.bridge.setHandler('works.mailState', () => mailPage(entry, 5, 5, 7));
    await sync.commit(entry);
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(7));
    expect(numbers().unread.rooms).toEqual({});
    expect(numbers().mentionCandidates).toEqual([]);
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
  });

  it('publishes multi-page mail state only after atomic completion', async () => {
    const sync = surface();
    const whole = mailPage(work(1), 5, 1, 7);
    let release!: (value: WorksMailStateResult) => void;
    sync.bridge.setHandler('works.mailState', ({ cursor }) => cursor === undefined
      ? { ...whole, records: whole.records.slice(0, 2), commit: false, next: 'm1' }
      : new Promise(resolve => { release = resolve; }));
    await sync.commit(work(1));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(numbers().unread.letters).toBe(0);
    release({ ...whole, index: 1, cursor: 'm1', records: whole.records.slice(2) });
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(7));
  });

  it('holds authoritative replacement until committed structure covers the dependency without raising coverage', async () => {
    const sync = surface();
    sync.bridge.setHandler('works.mailState', () => mailPage(work(1), 5, 3, 7));
    await sync.commit(work(1), 1000);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(numbers().unread.letters).toBe(0);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    await sync.commit(work(3), 1001, 1000);
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(7));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, requiredStructuralVersion: 4, unread: { letters: 1, rooms: {} } }));
    expect(numbers().unread.letters).toBe(7);
    expect(useWorksStore.getState().entries[0]?.version).toBe(3);
  });

  it('discards a repair older than newer held mail, retries durably, and accepts equal-version decreases', async () => {
    vi.useFakeTimers();
    const sync = surface();
    let release!: (value: WorksMailStateResult) => void;
    let reads = 0;
    sync.bridge.setHandler('works.mailState', () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : mailPage(work(1), 6, 1, 2));
    await sync.commit(work(1));
    sync.bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 1, unread: { letters: 8, rooms: {} } }));
    release(mailPage(work(1), 5, 1, 99));
    await vi.advanceTimersByTimeAsync(0);
    expect(numbers().unread.letters).toBe(8);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(numbers().unread.letters).toBe(2);
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
  });

  it('serializes work repairs to the producer pin limit and preserves unchanged work references', async () => {
    const sync = surface();
    const entries = Array.from({ length: 9 }, (_, index) => {
      const entry = work(1);
      return { ...entry, map: { ...entry.map, work: { ...entry.map.work, id: `w-${index}` } } };
    });
    const pending: Array<{ entry: WindowWorkEntry; resolve(value: WorksMailStateResult): void }> = [];
    let running = 0;
    let maximum = 0;
    sync.bridge.setHandler('works.mailState', ({ workId }) => {
      running++;
      maximum = Math.max(maximum, running);
      return new Promise(resolve => pending.push({ entry: entries.find(entry => entry.map.work.id === workId)!,
        resolve: value => { running--; resolve(value); } }));
    });
    await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'reset', epoch: 'a', base: 0, target: 1 }, index: 0,
      records: entries.flatMap(records), commit: true });
    for (let index = 0; index < entries.length; index++) {
      await vi.waitFor(() => expect(pending).toHaveLength(index + 1));
      const request = pending[index]!;
      request.resolve(mailPage(request.entry));
    }
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(maximum).toBe(1);
    expect(sync.bridge.calls.some(call => call.method === 'works.list' || call.method === 'works.sync')).toBe(false);
    const unchanged = useWorksStore.getState().entries[1];
    await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, index: 0,
      records: records({ ...entries[0]!, version: 2 }), commit: true });
    expect(useWorksStore.getState().entries[1]).toBe(unchanged);
  });

  it.each(['busy', 'retry', 'not-found', 'cursor-expired', 'cursor-unknown', 'cursor-client', 'cursor-work'] as const)(
    'keeps %s pending and visible, then retries without an empty replacement', async reason => {
      vi.useFakeTimers();
      const sync = surface();
      const entry = work(1);
      (entry.map.compact as MapCompactMail).unread.letters = 8;
      let reads = 0;
      sync.bridge.setHandler('works.mailState', () => ++reads === 1 ? { kind: 'mail-unavailable', reason } : mailPage(entry, 1, 1, 2));
      await sync.commit(entry);
      await vi.advanceTimersByTimeAsync(0);
      expect(numbers().unread.letters).toBe(8);
      expect(useWorksStore.getState().mailRepairFailed).toBe(true);
      expect(useWorksStore.getState().mailRepairPending).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(reads).toBe(2);
      expect(numbers().unread.letters).toBe(2);
      expect(useWorksStore.getState().mailRepairFailed).toBe(false);
      expect(useWorksStore.getState().mailRepairPending).toBe(0);
    });

  it('explicitly retries failed mail without restarting structural sync', async () => {
    const sync = surface();
    let reads = 0;
    sync.bridge.setHandler('works.mailState', () => ++reads === 1 ? { kind: 'mail-unavailable', reason: 'retry' } : mailPage(work(1), 1, 1, 3));
    await sync.commit(work(1));
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairFailed).toBe(true));
    useWorksStore.getState().retrySync();
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(3));
    expect(sync.retry).not.toHaveBeenCalled();
  });

  it.each(['delete', 'reset', 'epoch'] as const)('discards an in-flight mail capture across %s and reconciles the new lifetime', async change => {
    const sync = surface();
    let release!: (value: WorksMailStateResult) => void;
    let reads = 0;
    sync.bridge.setHandler('works.mailState', () => ++reads === 1 ? new Promise(resolve => { release = resolve; })
      : mailPage(work(2), 5, 2, 3, change === 'epoch' ? 'b' : 'a'));
    await sync.commit(work(1));
    if (change === 'delete') {
      await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, index: 0,
        records: [{ kind: 'work-remove', key: { projectPath: '/tmp/proj', workId: 'w-01' } }], commit: true });
      expect(useWorksStore.getState().mailRepairPending).toBe(0);
      await sync.commit(work(2), 3, 2);
    } else await sync.commit(work(2), 2, 0, change === 'epoch' ? 'b' : 'a');
    release(mailPage(work(1), 999, 1, 99));
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(3));
    expect(reads).toBe(2);
    expect(useWorksStore.getState().entries[0]?.version).toBe(2);
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
  });

  it('rejects a wrong-epoch mail page without applying any data', async () => {
    const sync = surface();
    sync.bridge.setHandler('works.mailState', () => mailPage(work(1), 1, 1, 99, 'other'));
    await sync.commit(work(1));
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairFailed).toBe(true));
    expect(numbers().unread.letters).toBe(0);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
  });

  it('preserves direct empty keys and sparse unread replacement exactly', async () => {
    const sync = surface();
    const entry = work(1);
    const page = mailPage(entry, 1, 1, 2);
    const metadata = { total: 2, top: 2, lastAt: null, unread: 2, decision: null };
    page.records[1] = { kind: 'section', key: page.key, field: 'mailRooms', start: 0,
      items: [{ roomId: '', metadata }, { roomId: 'r-01', metadata }], final: true };
    page.records[2] = { kind: 'section', key: page.key, field: 'unreadRooms', start: 0, items: [{ roomId: '', count: 2 }], final: true };
    sync.bridge.setHandler('works.mailState', () => page);
    await sync.commit(entry);
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(numbers().rooms).toEqual({ '': metadata, 'r-01': metadata });
    expect(numbers().unread).toEqual({ letters: 2, rooms: { '': 2 } });
  });

  it('repairs an already open empty room separately from authoritative count reconciliation', async () => {
    const sync = surface();
    useRoomPagesStore.setState({ opened: { ['/tmp/proj\u0000w-01\u0000r-01']: true } });
    sync.bridge.setHandler('context.messages', () => ({ messages: [makeLetter('m-1', { roomId: 'r-01' })], page: { complete: true, next: null } }));
    await sync.commit(work(1));
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]?.map.messages.map(message => message.id)).toEqual(['m-1']));
    expect(sync.bridge.calls.some(call => call.method === 'works.mailState')).toBe(true);
    expect(sync.bridge.calls.some(call => call.method === 'context.messages')).toBe(true);
  });

  it('reassembles large Unicode candidates from bounded mail pages without changing structure', async () => {
    const sync = surface();
    const entry = work(1);
    const message = makeLetter('m-1', { text: '🙂漢'.repeat(5000) });
    const whole = mailPage(entry);
    const chunks = JSON.stringify(message).match(/[\s\S]{1,128}/g)!;
    const pages: WorksMailStatePage[] = [{ ...whole, records: whole.records.slice(0, 3), commit: false, next: 'c1', cursor: 'c0' }];
    chunks.forEach((text, index) => pages.push({ ...whole, cursor: `c${pages.length}`, index: pages.length, next: `c${pages.length + 1}`, commit: false,
      records: [{ kind: 'section-fragment', key: whole.key, field: 'mentionCandidates', element: 0, index, text, final: index === chunks.length - 1 }] }));
    pages.push({ ...whole, cursor: `c${pages.length}`, index: pages.length, records: [{ kind: 'section', key: whole.key,
      field: 'mentionCandidates', start: 1, items: [], final: true }] });
    sync.bridge.setHandler('works.mailState', ({ cursor }) => {
      const page = pages[cursor === undefined ? 0 : Number(cursor.slice(1))]!;
      expect(new TextEncoder().encode(JSON.stringify({ id: 1, result: page }) + '\n').byteLength).toBeLessThanOrEqual(1500);
      return page;
    });
    await sync.commit(entry);
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(numbers().mentionCandidates).toEqual([message]);
    expect(useWorksStore.getState().entries[0]?.version).toBe(1);
    expect(useWorksStore.getState().entries[0]?.map.messages).toEqual([]);
  });

  it('retries a failed held-range repair visibly without requiring another mail event', async () => {
    vi.useFakeTimers();
    const sync = surface();
    const entry = work(1);
    entry.map.messages = [makeLetter('m-1', { roomId: 'r-01' })];
    let reads = 0;
    sync.bridge.setHandler('context.messages', () => {
      if (++reads === 1) throw new Error('temporary range failure');
      return { messages: [makeLetter('m-1', { roomId: 'r-01', readBy: { human: 'read' } })], page: { complete: true, next: null } };
    });
    await sync.commit(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorksStore.getState().mailRepairFailed).toBe(true);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    expect(useWorksStore.getState().entries[0]?.map.messages[0]?.readBy.human).toBe('read');
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
    expect(useWorksStore.getState().mailRepairFailed).toBe(false);
  });

  it.each(['retry', 'auto', 'delete'])('keeps empty-open repair failure durable through two retries (%s)', async mode => {
    vi.useFakeTimers();
    const sync = surface();
    useRoomPagesStore.setState({ opened: { ['/tmp/proj\u0000w-01\u0000r-01']: true } });
    let reads = 0;
    sync.bridge.setHandler('context.messages', () => {
      if (++reads <= 2) throw new Error('empty-open failure');
      return { messages: [makeLetter('m-2', { roomId: 'r-01', text: 'recovered' })], page: { complete: true, next: null } };
    });
    await sync.commit(work(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    expect(useWorksStore.getState().mailRepairFailed).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(reads).toBe(2);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    expect(useWorksStore.getState().mailRepairFailed).toBe(true);
    if (mode === 'delete') {
      await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 1, target: 2 }, index: 0,
        records: [{ kind: 'work-remove', key: { projectPath: '/tmp/proj', workId: 'w-01' } }], commit: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reads).toBe(2);
      expect(useWorksStore.getState().entries).toEqual([]);
    } else {
      if (mode === 'retry') useWorksStore.getState().retrySync();
      await vi.advanceTimersByTimeAsync(mode === 'auto' ? 2000 : 0);
      expect(reads).toBe(3);
      expect(useWorksStore.getState().entries[0]?.map.messages[0]?.text).toBe('recovered');
      expect(sync.retry).not.toHaveBeenCalled();
    }
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
    expect(useWorksStore.getState().mailRepairFailed).toBe(false);
  });

  it('rejects a late mail capture after disconnect before the next reset arrives', async () => {
    const sync = surface();
    let release!: (value: WorksMailStateResult) => void;
    let reads = 0;
    sync.bridge.setHandler('works.mailState', () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : mailPage(work(2), 2, 2, 3));
    await sync.commit(work(1));
    sync.bridge.emitStatus({ state: 'disconnected', reason: 'closed' });
    release(mailPage(work(1), 999, 1, 99));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(numbers().unread.letters).toBe(0);
    expect(useWorksStore.getState().ready).toBe(false);
    sync.bridge.emitStatus({ state: 'connected', hostVersion: 'test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    await sync.commit(work(2), 2);
    await vi.waitFor(() => expect(numbers().unread.letters).toBe(3));
  });

  it('replaces an old empty-room opening joined by a new same-epoch reset lifetime', async () => {
    const sync = surface();
    useRoomPagesStore.setState({ opened: { ['/tmp/proj\u0000w-01\u0000r-01']: true } });
    const pending: Array<(value: { messages: ReturnType<typeof makeLetter>[]; page: { complete: boolean; next: null } }) => void> = [];
    sync.bridge.setHandler('context.messages', () => new Promise(resolve => { pending.push(resolve); }));
    await sync.commit(work(1));
    expect(pending).toHaveLength(1);
    await sync.commit(work(2), 2);
    expect(pending).toHaveLength(1);
    pending[0]!({ messages: [makeLetter('m-999', { roomId: 'r-01' })], page: { complete: true, next: null } });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(useWorksStore.getState().entries[0]?.map.messages).toEqual([]);
    expect(useWorksStore.getState().mailRepairPending).toBe(1);
    pending[1]!({ messages: [makeLetter('m-2', { roomId: 'r-01' })], page: { complete: true, next: null } });
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(useWorksStore.getState().entries[0]?.map.messages.map(message => message.id)).toEqual(['m-2']);
  });


  it('cancels the fresh empty-room replacement when its work is deleted', async () => {
    const sync = surface();
    useRoomPagesStore.setState({ opened: { ['/tmp/proj\u0000w-01\u0000r-01']: true } });
    const pending: Array<(value: { messages: ReturnType<typeof makeLetter>[]; page: { complete: boolean; next: null } }) => void> = [];
    sync.bridge.setHandler('context.messages', () => new Promise(resolve => { pending.push(resolve); }));
    await sync.commit(work(1));
    await sync.commit(work(2), 2);
    pending[0]!({ messages: [], page: { complete: true, next: null } });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'delta', epoch: 'a', base: 2, target: 3 }, index: 0,
      records: [{ kind: 'work-remove', key: { projectPath: '/tmp/proj', workId: 'w-01' } }], commit: true });
    pending[1]!({ messages: [makeLetter('m-999', { roomId: 'r-01' })], page: { complete: true, next: null } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useWorksStore.getState().entries).toEqual([]);
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
    expect(pending).toHaveLength(2);
  });

  it('coalesces repeated resets onto only one fresh open-room replacement', async () => {
    const sync = surface();
    useRoomPagesStore.setState({ opened: { ['/tmp/proj\u0000w-01\u0000r-01']: true } });
    const pending: Array<(value: { messages: ReturnType<typeof makeLetter>[]; page: { complete: boolean; next: null } }) => void> = [];
    sync.bridge.setHandler('context.messages', () => new Promise(resolve => { pending.push(resolve); }));
    await sync.commit(work(1));
    await sync.commit(work(2), 2);
    await sync.commit(work(3), 3);
    pending[0]!({ messages: [], page: { complete: true, next: null } });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ messages: [makeLetter('m-3', { roomId: 'r-01' })], page: { complete: true, next: null } });
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(pending).toHaveLength(2);
    expect(useWorksStore.getState().entries[0]?.map.messages.map(message => message.id)).toEqual(['m-3']);
  });
  it('retains visible mail failure after main retires a stalled call, then repairs a fresh reset', async () => {
    vi.useFakeTimers();
    const sync = surface();
    const first = work(1);
    const second = { ...work(1), map: { ...work(1).map, work: { ...work(1).map.work, id: 'w-02' } } };
    let release!: (value: WorksMailStateResult) => void;
    let reads = 0;
    sync.bridge.setHandler('works.mailState', ({ workId }) => ++reads === 1
      ? new Promise((resolve, reject) => {
        release = resolve;
        // Main owns this deadline and rejects the actual RPC when retiring its socket.
        setTimeout(() => {
          sync.bridge.emitStatus({ state: 'disconnected', reason: 'mail page timed out' });
          sync.status({ state: 'error', epoch: 'a', applied: 1, error: 'connection', retryable: true });
          reject(new Error('connection lost'));
        }, 30_000);
      }) : mailPage(workId === 'w-02' ? second : first, 1, 1, 3));
    const commit = () => sync.batch({ kind: 'works-sync-batch', transaction: { mode: 'reset', epoch: 'a', base: 0, target: 1 }, index: 0,
      records: [...records(first), ...records(second)], commit: true });
    await commit();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(useWorksStore.getState().mailRepairFailed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);
    expect(useWorksStore.getState().mailRepairPending).toBe(2);
    expect(useWorksStore.getState().mailRepairFailed).toBe(true);
    useWorksStore.getState().retrySync();
    expect(sync.retry).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
    sync.bridge.emitStatus({ state: 'connected', hostVersion: 'test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    await commit();
    release(mailPage(first, 999, 1, 99));
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorksStore.getState().entries.every(entry => (entry.map.compact as MapCompactMail).unread.letters === 3)).toBe(true);
    expect(useWorksStore.getState().mailRepairPending).toBe(0);
    expect(useWorksStore.getState().mailRepairFailed).toBe(false);
  });
  it('uses P4 progress/stale timers and clears real stalls while sustained commits stay current', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    const pending: Array<(page: WorksSyncPage) => void> = [];
    const main = new DesktopWorksSync({ pull: () => new Promise(resolve => { pending.push(resolve); }) }, { staleMs: 20 });
    bridge.worksSync = { subscribe: (batch, status) => main.attach({ batch: async value => { await batch(value); }, status }),
      retry: () => main.retry() };
    disposers.push(useWorksStore.getState().init(bridge, { sync: true }), () => main.dispose());
    const page = (target: number): WorksSyncPage => ({ kind: 'page', transaction: {
      mode: target === 1 ? 'reset' : 'delta', epoch: 'a', base: target - 1, target,
    }, index: 0, cursor: `p${target}`, next: null, records: records(work(target)), commit: true });
    main.connect();
    await vi.advanceTimersByTimeAsync(19);
    expect(useWorksStore.getState().syncStatus?.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);
    expect(useWorksStore.getState().syncStatus?.state).toBe('stale');
    expect(useWorksStore.getState().ready).toBe(false);
    pending.shift()!(page(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorksStore.getState().ready).toBe(true);
    for (let target = 2; target <= 5; target++) {
      main.invalidate({ epoch: 'a', revision: target });
      pending.shift()!(page(target));
      await vi.advanceTimersByTimeAsync(10);
      expect(useWorksStore.getState().syncStatus?.state).toBe('current');
    }
    const committed = useWorksStore.getState().entries;
    main.invalidate({ epoch: 'a', revision: 6 });
    await vi.advanceTimersByTimeAsync(20);
    expect(useWorksStore.getState().syncStatus?.state).toBe('stale');
    expect(useWorksStore.getState().entries).toBe(committed);
    pending.shift()!(page(6));
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorksStore.getState().syncStatus?.state).toBe('current');
    expect(useWorksStore.getState().entries[0]?.version).toBe(6);
  });

});


describe('new-epoch lifetime retirement through real main forwarding', () => {
  it.each([false, true])('retires equal/lower-version bodies and late reads for island=%s', async island => {
    const bridge = createFakeBridge();
    bridge.emitStatus({ state: 'connected', hostVersion: 'test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    let latest = work(1000), epoch = 'a';
    bridge.setHandler('works.mailState', () => mailPage(latest, latest.version!, latest.version!, 0, epoch));
    const pending: Array<(page: WorksSyncPage) => void> = [];
    const main = new DesktopWorksSync({ pull: () => new Promise(resolve => { pending.push(resolve); }) });
    bridge.worksSync = { subscribe: (batch, status) => main.attach({ batch: async value => { await batch(value); }, status }, island), retry: () => main.retry() };
    disposers.push(useWorksStore.getState().init(bridge, { sync: true }), () => main.dispose());
    const page = (entry: WindowWorkEntry, target: number): WorksSyncPage => ({ kind: 'page', transaction: { mode: 'reset', epoch, base: 0, target }, index: 0, cursor: 'p', next: null, records: records(entry), commit: true });
    main.connect(); await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(page(latest, 1));
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
    const oldBodies = [makeLetter('m-01', { roomId: null, text: 'old direct' }), makeLetter('m-02', { roomId: 'r-01', text: 'old room' })];
    useWorksStore.getState().addMessages(latest.projectPath, latest.map.work.id, oldBodies);
    const current = useWorksStore.getState().entries[0]!;
    const prefix = `${current.projectPath}\u0000${current.map.work.id}`;
    useRoomPagesStore.setState({ opened: { [`${prefix}\u0000`]: true, [`${prefix}\u0000r-01`]: true }, quotes: { [prefix]: { 'm-03': makeLetter('m-03', { text: 'old quote cache' }) } } });
    let releasePage!: (answer: never) => void, releaseQuote!: (answer: never) => void;
    bridge.setHandler('context.messages', () => new Promise(resolve => { releasePage = resolve as never; }));
    bridge.setHandler('context.letter', () => new Promise(resolve => { releaseQuote = resolve as never; }));
    const earlier = useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', messages => useWorksStore.getState().addMessages(current.projectPath, current.map.work.id, messages));
    const quote = useRoomPagesStore.getState().loadQuote(bridge, current, 'm-04');
    epoch = 'b'; latest = work(island ? 1000 : 900); // same birth/room/message IDs, equal OR lower numeric version
    bridge.setHandler('context.messages', () => ({ messages: [], page: { complete: true, next: null } }));
    bridge.setHandler('context.letter', () => ({ message: makeLetter('m-04', { text: 'new quote' }) }));
    main.invalidate({ epoch, revision: 2 }); await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(page(latest, 2));
    await vi.waitFor(() => expect(useWorksStore.getState().syncStatus).toMatchObject({ state: 'current', epoch: 'b' }));
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
    expect(useWorksStore.getState().entries[0]!.map.messages).toEqual([]);
    expect(useRoomPagesStore.getState().quotes).toEqual({});
    releasePage({ messages: [makeLetter('m-01', { text: 'late old page' })], page: { complete: true, next: null } } as never);
    releaseQuote({ message: makeLetter('m-04', { text: 'late old quote' }) } as never);
    await Promise.all([earlier, quote]);
    expect(useWorksStore.getState().entries[0]!.map.messages).toEqual([]); expect(useRoomPagesStore.getState().quotes).toEqual({});
    await useRoomPagesStore.getState().loadQuote(bridge, latest, 'm-04');
    expect(useRoomPagesStore.getState().quotes[prefix]!['m-04']!.text).toBe('new quote');
    expect(useWorksStore.getState().entries[0]!.version).toBe(latest.version);
  });

  it('retains stale bodies/quotes during an aborted new-epoch reset, then replaces them at successful retry', async () => {
    const sync = surface(); await sync.commit(work(1000));
    useWorksStore.getState().addMessages('/tmp/proj', 'w-01', [makeLetter('m-01', { roomId: null, text: 'old visible' })]);
    const prefix = '/tmp/proj\u0000w-01'; useRoomPagesStore.setState({ quotes: { [prefix]: { 'm-01': makeLetter('m-01', { text: 'old quote' }) } } });
    const old = useWorksStore.getState().entries;
    const transaction = { mode: 'reset', epoch: 'b', base: 0, target: 2 } as const;
    await sync.batch({ kind: 'works-sync-batch', transaction, index: 0, records: records(work(900)), commit: false });
    expect(useWorksStore.getState().entries).toBe(old); expect(useRoomPagesStore.getState().quotes[prefix]!['m-01']!.text).toBe('old quote');
    expect(() => sync.batch({ kind: 'works-sync-batch', transaction, index: 3, records: [], commit: true })).toThrow();
    expect(useWorksStore.getState().entries).toBe(old);
    useWorksStore.getState().retrySync();
    sync.bridge.setHandler('works.mailState', () => mailPage(work(900), 900, 900, 0, 'b'));
    await sync.commit(work(900), 2, 0, 'b');
    expect(useWorksStore.getState().entries[0]!.map.messages).toEqual([]); expect(useRoomPagesStore.getState().quotes).toEqual({});
    await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
  });
});


it('ignores an old high-version mail repair completing after a lower-version new epoch commits', async () => {
  const sync = surface(); await sync.commit(work(1000));
  let release!: (value: WorksMailStatePage) => void;
  sync.bridge.setHandler('works.mailState', () => new Promise(resolve => { release = resolve; }));
  sync.bridge.emit('rooms.mail', makeMailEvent({ version: 1002, prevVersion: 1001, requiredStructuralVersion: 1000, unread: { letters: 8, rooms: {} } }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  sync.bridge.setHandler('works.mailState', () => mailPage(work(900), 900, 900, 2, 'b'));
  await sync.commit(work(900), 2, 0, 'b');
  expect(useWorksStore.getState().entries[0]!.version).toBe(900);
  // The old physical RPC retains its producer admission slot until it settles. Its payload is obsolete.
  release(mailPage(work(1000), 10000, 1000, 99, 'a'));
  await vi.waitFor(() => expect(useWorksStore.getState().mailRepairPending).toBe(0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(numbers().unread.letters).toBe(2); expect(useWorksStore.getState().mailRepairPending).toBe(0);
});
