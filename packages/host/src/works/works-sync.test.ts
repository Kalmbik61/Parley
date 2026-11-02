import { describe, expect, it, vi } from 'vitest';
import type { WindowWorkEntry, WindowWorkMap } from '@parley/core';
import { WorksSyncReducer, WORKS_SYNC_FEATURE } from '@parley/protocol';
import type { WorksSyncPage, WorksSyncWorkKey } from '@parley/protocol';
import type { Client } from '../client.js';
import { WorksSyncHost, prepareWorksSyncReply, resolvePreparedWorksSyncReply } from './works-sync.js';

const keyOf = (entry: WindowWorkEntry): WorksSyncWorkKey => ({ projectPath: entry.projectPath, workId: entry.map.work.id });
function fixture(works = 1, sessions = 3, text = 30): WindowWorkEntry[] {
  return Array.from({ length: works }, (_, w) => ({ projectPath: '/fixture', version: 1, map: {
    schemaVersion: 2, work: { id: `w-${w}`, title: 'work', goal: 'goal', status: 'active', createdAt: 'x', updatedAt: 'x' },
    sessions: Array.from({ length: sessions }, (_, i) => ({ id: `s-${i}`, task: 'x'.repeat(text) })), rooms: [], messages: [],
  } as unknown as WindowWorkMap }));
}
function client(id = 'client'): Client & { sent: unknown[]; queued: number } {
  return { id, name: id, features: new Set([WORKS_SYNC_FEATURE]), sent: [], queued: 0,
    send(data) { this.sent.push(data); return true; }, writableLength() { return this.queued; }, close() {} };
}
const publish = (host: WorksSyncHost, entries: WindowWorkEntry[], branches: Record<string, string | null> = { '/fixture': 'main' }) => host.publish(entries, entries.map(keyOf), branches);
async function finish(host: WorksSyncHost, c: Client, reducer = new WorksSyncReducer(), base = 0) {
  let request: { base: number } | { cursor: string } = { base };
  let pages = 0;
  for (;;) {
    const reply = await host.pull(c, request, -1.7976931348623157e308);
    expect(reply.bytes).toBe(Buffer.byteLength(reply.line));
    expect(reply.bytes).toBeLessThanOrEqual(host.pageBytes);
    expect(JSON.parse(reply.line)).toEqual({ id: -1.7976931348623157e308, result: reply.result });
    if (reply.result.kind !== 'page') throw new Error(reply.result.reason);
    const outcome = reducer.applyPage(reply.result);
    expect(outcome.state).not.toBe('rejected');
    pages += 1;
    if (reply.result.commit) return { reducer, pages, mode: reply.result.transaction.mode };
    request = { cursor: reply.result.next! };
  }
}

describe('pinned works sync transport', () => {
  it('captures one target while later edits coalesce, then repairs skipped edit/delete revisions', async () => {
    const a = client(), host = new WorksSyncHost({ pageBytes: 2048, journalCommits: 1 });
    const entries = fixture(2, 60, 200);
    await publish(host, entries);
    const first = await host.pull(a, { base: 0 }, 1);
    expect(first.result.kind).toBe('page');
    const old = structuredClone(entries);
    entries[0]!.map.sessions[0]!.task = 'edited'; entries[0]!.version = 2;
    await publish(host, entries);
    entries[0]!.map.sessions.splice(1, 1); entries[0]!.version = 3;
    await publish(host, entries);
    const reducer = new WorksSyncReducer();
    let page = first.result as WorksSyncPage;
    for (;;) {
      expect(reducer.applyPage(page).state).not.toBe('rejected');
      if (page.commit) break;
      page = (await host.pull(a, { cursor: page.next! }, 2)).result as WorksSyncPage;
    }
    expect(reducer.view.snapshot.entries).toEqual(old);
    const repaired = await finish(host, a, reducer, 1);
    expect(repaired.reducer.view.snapshot.entries).toEqual(entries);
  });

  it('shares resident payloads across subscribers and regenerates evicted pages from pinned state', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048, cacheBytes: 2048 });
    const entries = fixture(1, 100, 100);
    await publish(host, entries);
    const a = client('a'), b = client('b');
    const first = await host.pull(a, { base: 0 }, 1);
    const afterFirst = host.stats.attempts;
    const shared = await host.pull(b, { base: 0 }, 123);
    expect(shared.result).toMatchObject({ transaction: (first.result as WorksSyncPage).transaction, index: 0 });
    // Cache pressure may regenerate, but retains only its declared encoded budget.
    expect(host.cacheBytes).toBeLessThanOrEqual(2048);
    let page = first.result as WorksSyncPage;
    while (!page.commit) page = (await host.pull(a, { cursor: page.next! }, 1)).result as WorksSyncPage;
    entries[0]!.map.sessions[0]!.task = 'new'; entries[0]!.version = 2;
    await publish(host, entries);
    const reducer = new WorksSyncReducer();
    page = shared.result as WorksSyncPage;
    while (true) {
      expect(reducer.applyPage(page).state).not.toBe('rejected');
      if (page.commit) break;
      page = (await host.pull(b, { cursor: page.next! }, 5)).result as WorksSyncPage;
    }
    expect(reducer.view.snapshot.entries[0]!.map.sessions[0]!.task).toBe('x'.repeat(100));
    expect(host.stats.attempts).toBeGreaterThan(afterFirst);
  });

  it('does not expose a partially failed publication and recovers after a complete retry', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048 });
    await publish(host, fixture());
    const entries = fixture(2);
    entries[0]!.version = 2; entries[0]!.map.sessions[0]!.task = 'new';
    Object.defineProperty(entries[1]!.map, '__proto__', { value: {}, enumerable: true, configurable: true });
    await expect(publish(host, entries)).rejects.toThrow('Unsafe');
    await expect(host.pull(client('fresh'), { base: 0 }, 1)).rejects.toThrow('publication');
    await expect(host.committedSnapshot({ projectPath: entries[0]!.projectPath, workId: entries[0]!.map.work.id })).rejects.toThrow('publication');
    delete (entries[1]!.map as unknown as Record<string, unknown>).__proto__;
    await publish(host, entries);
    expect((await finish(host, client('retry'))).reducer.view.snapshot.entries).toEqual(entries);
    await expect(host.publish(entries, undefined, undefined, () => false)).rejects.toThrow('superseded');
    expect((await finish(host, client('after-superseded'))).reducer.view.snapshot.entries).toEqual(entries);
  });

  it('propagates work/branch deletion and repairs catalogue reordering with a reset', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048 });
    const c = client(); const entries = fixture(2);
    await publish(host, entries);
    const { reducer } = await finish(host, c);
    await publish(host, [entries[0]!], {});
    expect((await finish(host, c, reducer, 1)).reducer.view.snapshot).toMatchObject({ entries: [entries[0]], branches: {} });
    await publish(host, entries);
    await finish(host, c, reducer, 2);
    entries.reverse(); await publish(host, entries);
    const page = (await host.pull(c, { base: 3 }, 1)).result as WorksSyncPage;
    expect(page.transaction.mode).toBe('reset');
  });

  it.each([0, 1, 2])('preserves a newly admitted work at catalogue position %i, resetting only when necessary', async at => {
    const host = new WorksSyncHost({ pageBytes: 2048 }), c = client();
    try {
      const entries = fixture(3), original = entries.slice(0, 2);
      await publish(host, original);
      const { reducer } = await finish(host, c);
      const target = [...original]; target.splice(at, 0, entries[2]!);
      await publish(host, target);
      const result = await finish(host, c, reducer, 1);
      expect(result.reducer.view.snapshot.entries).toEqual(target);
      expect(result.mode).toBe(at === 2 ? 'delta' : 'reset');
    } finally { host.stop(); }
  });

  it.each([false, true])('keeps a reset/pruning horizon after eviction when a client skips revisions (deleted=%s)', async deleted => {
    const host = new WorksSyncHost({ pageBytes: 2048, journalCommits: 2 }), c = client();
    try {
      const entries = fixture(4), original = entries.slice(0, deleted ? 3 : 2);
      await publish(host, original);
      const { reducer } = await finish(host, c);
      const reordered = deleted ? [entries[2]!, entries[1]!] : [entries[1]!, entries[0]!];
      await publish(host, reordered);
      const target = [...reordered, entries[3]!];
      await publish(host, target);
      const result = await finish(host, c, reducer, 1);
      expect(result.reducer.view.snapshot.entries).toEqual(target);
      expect(result.mode).toBe('reset');
    } finally { host.stop(); }
  });

  it('retains newer mail progress while a structural cache publication yields', async () => {
    const host = new WorksSyncHost(); const entries = fixture(1, 3000);
    await publish(host, entries);
    entries[0]!.version = 2; entries[0]!.map.sessions[0]!.task = 'structure';
    const pending = publish(host, entries);
    await Promise.resolve();
    host.noteMailVersion(keyOf(entries[0]!), 55);
    await pending;
    expect(host.snapshot(keyOf(entries[0]!))!.sourceVersion).toBe(55);
    expect(host.snapshot(keyOf(entries[0]!))!.structuralSourceVersion).toBe(2);
  });

  it('reuses encoded payloads without per-subscriber row encodes when resident', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048 });
    await publish(host, fixture(1, 50, 200));
    await host.pull(client('a'), { base: 0 }, 1);
    const attempts = host.stats.attempts;
    await host.pull(client('b'), { base: 0 }, Number.MAX_SAFE_INTEGER);
    expect(host.stats.attempts).toBe(attempts);
  });

  it('binds cursors, expires pins, releases disconnects and resets old journal bases', async () => {
    let now = 0;
    const host = new WorksSyncHost({ pageBytes: 2048, pinIdleMs: 30, journalCommits: 1, now: () => now });
    const entries = fixture(1, 50, 200);
    await publish(host, entries);
    const a = client('a'), b = client('b');
    const page = (await host.pull(a, { base: 0 }, 1)).result as WorksSyncPage;
    expect((await host.pull(b, { cursor: page.next! }, 1)).result).toMatchObject({ kind: 'reset-required', reason: 'cursor-client' });
    now = 31;
    expect((await host.pull(a, { cursor: page.next! }, 1)).result).toMatchObject({ kind: 'reset-required', reason: 'cursor-expired' });
    await finish(host, a);
    entries[0]!.version = 2; entries[0]!.map.work.status = 'archived'; await publish(host, entries);
    entries[0]!.version = 3; entries[0]!.map.work.title = 'later'; await publish(host, entries);
    const reset = await host.pull(a, { base: 1 }, 1);
    expect(reset.result).toMatchObject({ kind: 'page', transaction: { mode: 'reset' } });
    host.dropClient(a.id);
    expect(host.pinCount).toBe(0);
  });

  it('pauses after a queued sendLine(false), allowing other clients to progress', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048, highWaterBytes: 100 });
    await publish(host, fixture(1, 50, 200));
    const a = client('a'), b = client('b');
    const reply = await host.pull(a, { base: 0 }, 1);
    a.queued = 101; reply.sent(false);
    let settled = false;
    const pending = host.pull(a, { cursor: (reply.result as WorksSyncPage).next! }, 2).then(result => { settled = true; return result; });
    await finish(host, b);
    expect(settled).toBe(false);
    a.queued = 0;
    expect((await pending).result.kind).toBe('page');
  });

  it.each([[30, 1000], [30, 3000], [1, 3000]])('completes %iw/%i sessions beyond the old aggregate limit', async (works, sessions) => {
    const host = new WorksSyncHost();
    const entries = fixture(works, sessions, works === 1 ? 2000 : 200);
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(5 * 1024 * 1024);
    await publish(host, entries);
    const c = client();
    const { reducer, pages } = await finish(host, c);
    expect(reducer.view.snapshot.entries).toEqual(entries);
    expect(pages).toBeGreaterThan(1);
    entries[0]!.version = 2; entries[0]!.map.sessions[0]!.task = 'edited';
    entries[0]!.map.sessions.push({ id: 's-new', task: 'new' } as never);
    entries[0]!.map.sessions.splice(1, 1);
    await publish(host, entries);
    expect((await finish(host, c, reducer, 1)).reducer.view.snapshot.entries).toEqual(entries);
  }, 30000);

  it('fragments huge Unicode metadata/rows, rejects remote and never trusts duck-typed prepared data', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048 });
    const entries = fixture(); entries[0]!.map.work.goal = '😀"\\'.repeat(20000);
    await publish(host, entries);
    expect((await finish(host, client())).reducer.view.snapshot.entries).toEqual(entries);
    await expect(host.pull({ ...client(), role: 'remote' }, { base: 0 }, 1)).rejects.toThrow();
    expect(await resolvePreparedWorksSyncReply({ json: 'malicious', bytes: 1 }, 1)).toBeUndefined();
    const c = client('prepared');
    const prepared = prepareWorksSyncReply(host, c, { base: 0 });
    expect((await resolvePreparedWorksSyncReply(prepared, 1))?.line.endsWith('\n')).toBe(true);
  });
});


describe('atomic publication candidates', () => {
  it.each(['update', 'records'] as const)('discards after %s yields without leaking rows, removals, branches, floor or pins', async phase => {
    const c = client(), host = new WorksSyncHost({ pageBytes: 2048, journalCommits: 1, clients: () => [c] });
    const old = fixture(2, 50, 100);
    await publish(host, old);
    const first = (await host.pull(c, { base: 0 }, 1)).result as WorksSyncPage;
    const revision = host.currentRevision, notifications = c.sent.length;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const fork = host.rows.fork.bind(host.rows);
    const spy = vi.spyOn(host.rows, 'fork').mockImplementation(async () => {
      const candidate = await fork();
      if (phase === 'update') {
        const update = candidate.update.bind(candidate);
        vi.spyOn(candidate, 'update').mockImplementation(async (...args) => { await update(...args); entered(); await gate; });
      } else {
        const records = candidate.records.bind(candidate);
        vi.spyOn(candidate, 'records').mockImplementation((...args) => ({ async *[Symbol.asyncIterator]() {
          for await (const record of records(...args)) { entered(); await gate; yield record; }
        } }));
      }
      return candidate;
    });
    const next = structuredClone(old.slice(0, 1)); next[0]!.version = 2; next[0]!.map.work.goal = 'candidate';
    let alive = true;
    const pending = host.publish(next, next.map(keyOf), { '/fixture': 'candidate-branch' }, () => alive);
    const rejection = expect(pending).rejects.toThrow('superseded');
    await started;
    expect(host.snapshot(keyOf(old[0]!))!.map).toEqual(old[0]!.map);
    expect(host.snapshot(keyOf(old[1]!))!.map).toEqual(old[1]!.map);
    // Concurrent mail-only advancement belongs to live state, even when candidate is discarded.
    host.noteMailVersion(keyOf(old[0]!), 10);
    alive = false; release(); await rejection; spy.mockRestore();
    expect(host.currentRevision).toBe(revision); expect(c.sent.length).toBe(notifications);
    expect((await host.committedSnapshot(keyOf(old[0]!)))!.sourceVersion).toBe(10);
    const reducer = new WorksSyncReducer(); let page = first;
    for (;;) {
      expect(reducer.applyPage(page).state).not.toBe('rejected');
      if (page.commit) break;
      page = (await host.pull(c, { cursor: page.next! }, 2)).result as WorksSyncPage;
    }
    expect(reducer.view.snapshot.entries).toEqual(old);
    expect(reducer.view.snapshot.branches).toEqual({ '/fixture': 'main' });
    // Discard did not advance journal floor or poison the old committed snapshot.
    const unchanged = await finish(host, c, reducer, revision);
    expect(unchanged.mode).toBe('delta'); expect(unchanged.reducer.view.snapshot.entries).toEqual(old);
    await host.publish(next, next.map(keyOf), { '/fixture': 'next' });
    expect(host.snapshot(keyOf(next[0]!))).toMatchObject({ sourceVersion: 10, structuralSourceVersion: 2 });
    const adopted = await finish(host, c, reducer, revision);
    expect(adopted.reducer.view.snapshot.entries).toEqual(next);
    expect(adopted.reducer.view.snapshot.branches).toEqual({ '/fixture': 'next' }); host.stop();
  });

  it('rechecks stop and final validation after staging; queued repairs cannot roll structure back', async () => {
    const host = new WorksSyncHost(), old = fixture(); await publish(host, old);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const fork = host.rows.fork.bind(host.rows);
    const spy = vi.spyOn(host.rows, 'fork').mockImplementation(async () => { const candidate = await fork(); entered(); await gate; return candidate; });
    const next = structuredClone(old); next[0]!.version = 2; next[0]!.map.work.goal = 'staged';
    const pending = publish(host, next), rejection = expect(pending).rejects.toThrow('superseded');
    await started; host.stop(); release(); await rejection; spy.mockRestore();
    expect(host.currentRevision).toBe(1); expect(host.snapshot(keyOf(old[0]!))!.map).toEqual(old[0]!.map);

    const live = new WorksSyncHost(); await publish(live, old);
    await live.publish(next, undefined, undefined, () => true);
    await expect(live.publish(old, old.map(keyOf), {})).rejects.toThrow('superseded');
    expect((await live.committedSnapshot(keyOf(old[0]!)))!.structuralSourceVersion).toBe(2);
    expect((await finish(live, client())).reducer.view.snapshot.entries).toEqual(next); live.stop();
  });
});


it('merges mail-only watermarks during successful staging and serializes a newer per-work repair', async () => {
  const host = new WorksSyncHost(), old = fixture(); await publish(host, old);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const fork = host.rows.fork.bind(host.rows);
  vi.spyOn(host.rows, 'fork').mockImplementationOnce(async () => { const candidate = await fork(); entered(); await gate; return candidate; });
  const next = structuredClone(old); next[0]!.version = 2; next[0]!.map.work.goal = 'V2';
  const pending = publish(host, next); await started;
  host.noteMailVersion(keyOf(old[0]!), 10);
  const repair = structuredClone(next); repair[0]!.version = 3; repair[0]!.map.work.goal = 'V3 repair';
  const queued = host.publish(repair, undefined, undefined, () => true);
  release(); await Promise.all([pending, queued]);
  expect(host.snapshot(keyOf(old[0]!))).toMatchObject({ sourceVersion: 10, structuralSourceVersion: 3, map: { work: { goal: 'V3 repair' } } });
  expect((await finish(host, client())).reducer.view.snapshot.entries).toEqual(repair); host.stop();
});

it('reports genuine staging errors without leaking candidate state and recovers on a complete publication', async () => {
  const host = new WorksSyncHost(), old = fixture(); await publish(host, old);
  const fork = host.rows.fork.bind(host.rows);
  vi.spyOn(host.rows, 'fork').mockImplementationOnce(async () => {
    const candidate = await fork(); vi.spyOn(candidate, 'update').mockRejectedValueOnce(new Error('staging failure')); return candidate;
  });
  const next = structuredClone(old); next[0]!.version = 2;
  await expect(publish(host, next)).rejects.toThrow('staging failure');
  expect(host.currentRevision).toBe(1); expect(host.snapshot(keyOf(old[0]!))!.map).toEqual(old[0]!.map);
  await expect(host.committedSnapshot(keyOf(old[0]!))).rejects.toThrow('requires repair');
  await publish(host, next);
  expect((await finish(host, client())).reducer.view.snapshot.entries).toEqual(next); host.stop();
});


it('keeps unchanged immutable row maps shared across a staged publication and atomic adoption', async () => {
  const host = new WorksSyncHost(), entries = fixture(2);
  await publish(host, entries);
  const untouched = host.snapshot(keyOf(entries[1]!))!.map;
  const next = structuredClone(entries[0]!); next.version = 2; next.map.work.goal = 'only one changed';
  await host.publish([next], entries.map(keyOf));
  expect(host.snapshot(keyOf(entries[1]!))!.map).toBe(untouched);
  expect(host.snapshot(keyOf(entries[0]!))!.map).toEqual(next.map); host.stop();
});


it('adopts a lower-version new incarnation atomically, retires old pins/watermarks and notifies coalesced readers', async () => {
  const c = client(), host = new WorksSyncHost({ pageBytes: 2048, clients: () => [c] });
  const old = fixture(1, 50, 100); old[0]!.version = 1000;
  const key = keyOf(old[0]!), identities = (incarnation: number) => [{ key, incarnation }];
  await host.publish(old, [key], {}, () => true, identities(1)); const epoch = host.epoch;
  const pin = (await host.pull(c, { base: 0 }, 1)).result as WorksSyncPage;
  host.noteMailVersion(key, 2000, 1);
  const next = structuredClone(old); next[0]!.version = 900; next[0]!.map.work.goal = 'new life';
  let valid = true;
  const fork = host.rows.fork.bind(host.rows);
  vi.spyOn(host.rows, 'fork').mockImplementationOnce(async () => { const candidate = await fork(); valid = false; return candidate; });
  await expect(host.publish(next, [key], {}, () => valid, identities(2))).rejects.toThrow('superseded');
  expect(host.epoch).toBe(epoch); expect(host.pinCount).toBe(1);
  expect(host.snapshot(key)).toMatchObject({ sourceVersion: 2000, structuralSourceVersion: 1000 });
  // Keep the reader notified from a prior publication; new epoch must still notify it.
  await host.publish([{ ...old[0]!, version: 1001 }], [key], {}, () => true, identities(1));
  const notifications = c.sent.length;
  await host.publish(next, [key], {}, () => true, identities(2));
  expect(host.epoch).not.toBe(epoch); expect(host.pinCount).toBe(0); expect(c.sent.length).toBe(notifications + 1);
  expect(host.snapshot(key)).toMatchObject({ sourceVersion: 900, structuralSourceVersion: 900 });
  expect((await host.pull(c, { cursor: pin.next! }, 1)).result.kind).toBe('reset-required');
  expect((await finish(host, c)).reducer.view.snapshot.entries).toEqual(next);
  await expect(host.publish(old, [key], {}, () => true, identities(1))).rejects.toThrow('superseded');
  const second = host.epoch;
  await host.publish([{ ...next[0]!, version: 901 }], [key], {}, () => true, identities(2));
  expect(host.epoch).toBe(second);
  await host.publish([], [], {}, () => true, []); expect(host.epoch).not.toBe(second); host.stop();
});

it('does not stamp an in-flight old mail capture with a newly adopted epoch', async () => {
  const old = fixture(), key = keyOf(old[0]!); let release!: (value: never) => void;
  const host = new WorksSyncHost({ captureMail: () => new Promise(resolve => { release = resolve; }) });
  await host.publish(old, [key], {}, () => true, [{ key, incarnation: 1 }]);
  const pending = host.pullMailState(client(), key, 1);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await host.publish(old, [key], {}, () => true, [{ key, incarnation: 2 }]);
  release({ kind: 'captured', key, sourceVersion: 1, requiredStructuralVersion: 1, mail: { rooms: {}, unread: { letters: 0, rooms: {} }, mentionCandidates: [] } } as never);
  expect((await pending).result).toEqual({ kind: 'mail-unavailable', reason: 'retry' });
  expect(host.mailPinCount).toBe(0); host.stop();
});


it('retires a missed deletion through journal eviction before the same key is re-added', async () => {
  const c = client(), host = new WorksSyncHost({ clients: () => [c], journalCommits: 1 });
  const old = fixture(); old[0]!.version = 1000; const key = keyOf(old[0]!);
  await host.publish(old, [key], {}, () => true, [{ key, incarnation: 1 }]);
  const initial = await finish(host, c), epoch = host.epoch;
  await host.publish([], [], {}, () => true, []); const retired = host.epoch;
  expect(retired).not.toBe(epoch);
  const notifications = c.sent.length;
  const next = structuredClone(old); next[0]!.map.work.goal = 'new life';
  for (const version of [900, 901, 902]) {
    next[0]!.version = version; await host.publish(next, [key], {}, () => true, [{ key, incarnation: 2 }]);
  }
  expect(host.epoch).toBe(retired); expect(c.sent.length).toBe(notifications);
  const repaired = await finish(host, c, initial.reducer, 1);
  expect(repaired.mode).toBe('reset'); expect(repaired.reducer.view.epoch).toBe(retired);
  expect(repaired.reducer.view.snapshot.entries).toEqual(next); host.stop();
});

it('rejects old structural pages completing after epoch retirement without caching them in the new epoch', async () => {
  const host = new WorksSyncHost({ pageBytes: 2048 }), c = client(), old = fixture(1, 50, 100), key = keyOf(old[0]!);
  await host.publish(old, [key], {}, () => true, [{ key, incarnation: 1 }]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const records = host.rows.records.bind(host.rows);
  const spy = vi.spyOn(host.rows, 'records').mockImplementation((...args) => {
    const stable = records(...args);
    return { async *[Symbol.asyncIterator]() { entered(); await gate; yield* stable; } };
  });
  const pending = host.pull(c, { base: 0 }, 1); await started;
  const next = structuredClone(old); next[0]!.map.work.goal = 'new incarnation';
  await host.publish(next, [key], {}, () => true, [{ key, incarnation: 2 }]);
  spy.mockRestore(); release();
  expect((await pending).result.kind).toBe('reset-required');
  expect(host.cacheBytes).toBe(0);
  expect((await finish(host, c)).reducer.view.snapshot.entries).toEqual(next); host.stop();
});
