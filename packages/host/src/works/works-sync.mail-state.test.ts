import { describe, expect, it, vi } from 'vitest';
import type { WindowWorkMap } from '@parley/core';
import { WORKS_SYNC_FEATURE, WorksMailStateAssembler } from '@parley/protocol';
import type { WorksMailStatePage } from '@parley/protocol';
import type { Client } from '../client.js';
import { WorksSyncHost } from './works-sync.js';
import type { WorksMailCaptureResult } from './works-sync.js';

const key = { projectPath: '/p', workId: 'w-1' };
const metadata = { total: 2, top: 2, lastAt: 'now', unread: 1, decision: null };
function captured(): Extract<WorksMailCaptureResult, { kind: 'captured' }> {
  return { kind: 'captured', key, sourceVersion: 55, requiredStructuralVersion: 40, mail: { rooms: { '': metadata, ['r' + '💬'.repeat(3000)]: metadata }, unread: { letters: 1, rooms: { '': 1 } }, mentionCandidates: [] } };
}
function client(id: string): Client { return { id, name: id, features: new Set([WORKS_SYNC_FEATURE]), send: () => true, close() {}, writableLength: () => 0 }; }
async function finish(host: WorksSyncHost, c: Client, first?: WorksMailStatePage) {
  const assembler = new WorksMailStateAssembler({ epoch: host.epoch, key });
  let page = first ?? (await host.pullMailState(c, key, -Number.MAX_VALUE)).result as WorksMailStatePage;
  for (;;) {
    expect(page.kind).toBe('mail-page');
    expect(assembler.applyPage(page).state).not.toBe('rejected');
    if (page.commit) return assembler.value!;
    const reply = await host.pullMailState(c, { ...key, cursor: page.next! }, -Number.MAX_VALUE);
    expect(Buffer.byteLength(reply.line)).toBeLessThanOrEqual(host.pageBytes);
    page = reply.result as WorksMailStatePage;
  }
}

describe('bounded mail-only pinned producer', () => {
  it('retains all 64 disconnected capture reservations until settlement and never installs late pins', async () => {
    const captures: Array<{ resolve(value: WorksMailCaptureResult): void; reject(error: Error): void }> = [];
    let immediate = false;
    const host = new WorksSyncHost({ pageBytes: 2048, captureMail: async () => immediate ? captured()
      : new Promise((resolve, reject) => { captures.push({ resolve, reject }); }) });
    const pulls: Array<Promise<unknown>> = [];
    try {
      for (let i = 0; i < 64; i++) {
        const c = client(`old-${i}`);
        pulls.push(host.pullMailState(c, key, i));
        host.dropClient(c.id);
      }
      expect(captures).toHaveLength(64);
      for (let i = 0; i < 70; i++) {
        const c = client(`reconnect-${i}`);
        expect((await host.pullMailState(c, key, i)).result).toEqual({ kind: 'mail-unavailable', reason: 'busy' });
        host.dropClient(c.id);
      }
      expect(captures).toHaveLength(64);
      captures[0]!.resolve(captured());
      expect((await pulls[0] as { result: unknown }).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-unknown' });
      expect(host.mailPinCount).toBe(0);
      const replacement = client('replacement');
      pulls.push(host.pullMailState(replacement, key, 100));
      host.dropClient(replacement.id);
      expect(captures).toHaveLength(65);
      // Exactly one released reservation: a second replacement is still refused.
      expect((await host.pullMailState(client('excess'), key, 101)).result).toEqual({ kind: 'mail-unavailable', reason: 'busy' });
      const rejected = pulls[1]!.catch(error => error);
      captures[1]!.reject(new Error('capture failed after disconnect'));
      expect(await rejected).toBeInstanceOf(Error);
      for (let i = 2; i < captures.length; i++) captures[i]!.resolve(captured());
      await Promise.all(pulls.filter((_pull, index) => index !== 1));
      expect(host.mailPinCount).toBe(0);
      expect(host.cacheBytes).toBe(0);
      immediate = true;
      expect((await finish(host, client('fresh'))).mail.unread.letters).toBe(1);
      expect(host.mailPinCount).toBe(0);
    } finally { host.stop(); }
  });

  it('pins one coherent capture across huge Unicode fragments, later writes and cache eviction', async () => {
    let current = captured(), reads = 0;
    const host = new WorksSyncHost({ pageBytes: 2048, cacheBytes: 64, captureMail: async () => { reads += 1; return current; } });
    try {
      const c = client('a');
      const first = (await host.pullMailState(c, key, 1)).result as WorksMailStatePage;
      expect(first.commit).toBe(false);
      const old = structuredClone(current.mail);
      current.mail.unread.letters = 99;
      current = { ...current, sourceVersion: 60, mail: { rooms: {}, unread: { letters: 0, rooms: {} }, mentionCandidates: [] } };
      expect((await finish(host, c, first)).mail).toEqual(old);
      expect(reads).toBe(1);
      expect((await finish(host, c)).mail).toEqual(current.mail);
      expect(host.currentRevision).toBe(0);
      expect(host.cacheBytes).toBeLessThanOrEqual(64);
    } finally { host.stop(); }
  });

  it('binds cursors to method, client and work; disconnect/expiry/deletion never returns fabricated empty', async () => {
    let now = 0, alive = true;
    const host = new WorksSyncHost({ pageBytes: 2048, pinIdleMs: 20, now: () => now, captureMail: async () => captured(), mailAlive: () => alive });
    const a = client('a'), b = client('b');
    const begin = async () => (await host.pullMailState(a, key, 1)).result as WorksMailStatePage;
    try {
      let p = await begin();
      expect((await host.pullMailState(b, { ...key, cursor: p.next! }, 2)).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-client' });
      expect((await host.pullMailState(a, { ...key, workId: 'other', cursor: p.next! }, 3)).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-work' });
      expect((await host.pull(a, { cursor: p.next! }, 4)).result.kind).toBe('reset-required');
      now = 21;
      expect((await host.pullMailState(a, { ...key, cursor: p.next! }, 5)).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-expired' });
      p = await begin(); host.dropClient(a.id);
      expect((await host.pullMailState(a, { ...key, cursor: p.next! }, 6)).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-unknown' });
      p = await begin(); alive = false;
      expect((await host.pullMailState(a, { ...key, cursor: p.next! }, 7)).result).toEqual({ kind: 'mail-unavailable', reason: 'not-found' });
    } finally { host.stop(); }
  });

  it('bounds admission and isolates blocked/failed mail from structural and other clients', async () => {
    let release!: (v: WorksMailCaptureResult) => void;
    const host = new WorksSyncHost({ pageBytes: 2048, maxPins: 1, captureMail: async () => new Promise(resolve => { release = resolve; }) });
    const a = client('a'), b = client('b');
    try {
      const pending = host.pullMailState(a, key, 1);
      await Promise.resolve();
      expect((await host.pullMailState(a, key, 2)).result).toEqual({ kind: 'mail-unavailable', reason: 'busy' });
      expect((await host.pullMailState(b, key, 3)).result).toEqual({ kind: 'mail-unavailable', reason: 'busy' });
      expect((await host.pull(b, { base: 0 }, 4)).result.kind).toBe('page');
      release(captured());
      const p = (await pending).result as WorksMailStatePage;
      expect(p.kind).toBe('mail-page');
      host.dropClient(a.id);
      const denied = client('remote'); denied.role = 'remote';
      await expect(host.pullMailState(denied, key, 5)).rejects.toMatchObject({ code: 'bad_request' });
    } finally { host.stop(); }
  });

  it('keeps simultaneous structural/mail pins separate in both cursor directions', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048, captureMail: async () => captured() });
    const c = client('a');
    try {
      const map = { schemaVersion: 2, work: { id: key.workId, title: 'x', goal: 'x', status: 'active', createdAt: 'now', updatedAt: 'now' }, sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}`, task: 'x'.repeat(200) })), rooms: [], messages: [] } as unknown as WindowWorkMap;
      await host.publish([{ projectPath: key.projectPath, map, version: 40 }], [key], {});
      const structure = (await host.pull(c, { base: 0 }, 1)).result;
      expect(structure.kind).toBe('page');
      if (structure.kind !== 'page') throw new Error('missing structural page');
      expect(structure.commit).toBe(false);
      const first = (await host.pullMailState(c, key, 2)).result as WorksMailStatePage;
      expect(host.pinCount).toBe(1); expect(host.mailPinCount).toBe(1);
      expect((await host.pullMailState(c, { ...key, cursor: structure.next! }, 3)).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-unknown' });
      expect((await finish(host, c, first)).mail.unread.letters).toBe(1);
      expect(host.mailPinCount).toBe(0); expect(host.pinCount).toBe(1);
      expect((await host.pull(c, { cursor: structure.next! }, 4)).result.kind).toBe('page');
    } finally { host.stop(); }
  });

  it('expires abandoned pins without another request and releases admission', async () => {
    let now = 0;
    const host = new WorksSyncHost({ pageBytes: 2048, pinIdleMs: 10, maxPins: 1, now: () => now, captureMail: async () => captured() });
    try {
      expect(((await host.pullMailState(client('a'), key, 1)).result as WorksMailStatePage).commit).toBe(false);
      expect(host.mailPinCount).toBe(1);
      now = 11;
      await vi.waitFor(() => expect(host.mailPinCount).toBe(0), { timeout: 500, interval: 5 });
      expect((await host.pullMailState(client('b'), key, 2)).result.kind).toBe('mail-page');
    } finally { host.stop(); }
  });

  it('does not admit a pin after disconnect during capture and preserves explicit failures', async () => {
    let resolve!: (value: WorksMailCaptureResult) => void;
    const host = new WorksSyncHost({ maxPins: 1, captureMail: async () => new Promise(done => { resolve = done; }) });
    const c = client('a');
    try {
      const pending = host.pullMailState(c, key, 1); await Promise.resolve();
      host.dropClient(c.id); resolve(captured());
      expect((await pending).result).toEqual({ kind: 'mail-unavailable', reason: 'cursor-unknown' });
      expect(host.mailPinCount).toBe(0);
      const denied = host.pullMailState(c, key, 2); await Promise.resolve();
      resolve({ kind: 'mail-unavailable', reason: 'busy' });
      expect((await denied).result).toEqual({ kind: 'mail-unavailable', reason: 'busy' });
    } finally { host.stop(); }
  });

  it('lets another client complete while one socket is backpressured and never retries a false send', async () => {
    const host = new WorksSyncHost({ pageBytes: 2048, highWaterBytes: 1, captureMail: async () => captured() });
    let queued = 10;
    const a = client('a'), b = client('b'); a.writableLength = () => queued;
    try {
      let settled = false;
      const pending = host.pullMailState(a, key, 1).then(reply => { settled = true; return reply; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await finish(host, b)).mail.unread.letters).toBe(1);
      expect(settled).toBe(false);
      queued = 0;
      const first = await pending; first.sent(false);
      const page = first.result as WorksMailStatePage;
      const next = (await host.pullMailState(a, { ...key, cursor: page.next! }, 2)).result as WorksMailStatePage;
      expect(next.index).toBe(page.index + 1);
      expect(next.cursor).toBe(page.next);
    } finally { queued = 0; host.stop(); }
  });
});
