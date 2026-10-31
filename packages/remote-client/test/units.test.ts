import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostStore, encodeTs } from '../src/host-store.js';
import { RELAY_READY_TIMEOUT_MS, RelayError, RelayLink } from '../src/relay-client.js';
import { Rpc, decodeFrame, utf8Decode } from '../src/rpc.js';
import { FakeBridge, advance, flush, makePlatform } from './fakes.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('utf8Decode', () => {
  const samples = ['', 'plain', 'Привет, мир', '日本語', '😀 emoji 𝄞', 'x'.repeat(20_000) + 'ё'];

  it('the fallback without TextDecoder matches the native decoder and is strict', () => {
    const native = globalThis.TextDecoder;
    const encoded = samples.map((t) => new TextEncoder().encode(t));
    // Hermes может не иметь TextDecoder: проверяем свой разбор.
    vi.stubGlobal('TextDecoder', undefined);
    try {
      encoded.forEach((bytes, i) => expect(utf8Decode(bytes)).toBe(samples[i]));
      for (const bad of [
        [0xff],
        [0xc0, 0x80],
        [0xe0, 0x80, 0x80],
        [0xed, 0xa0, 0x80],
        [0xf4, 0x90, 0x80, 0x80],
        [0xe2, 0x82],
      ]) {
        expect(() => utf8Decode(Uint8Array.from(bad))).toThrow();
      }
    } finally {
      vi.stubGlobal('TextDecoder', native);
      vi.unstubAllGlobals();
    }
    expect(() => decodeFrame(Uint8Array.from([0xff]))).toThrow();
  });
});

describe('RelayLink', () => {
  it('no `ready` in 10 s → timeout and the socket closed', async () => {
    const platform = makePlatform();
    platform.relay.mode = 'silent';
    const link = RelayLink.open(platform, 'wss://relay.example.com', {
      v: 1,
      t: 'pair',
      lookup: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const result = link.ready.then(
      () => null,
      (e: unknown) => e,
    );
    await advance(RELAY_READY_TIMEOUT_MS - 1);
    expect(platform.relay.sockets[0]!.closed).toBe(false);
    await advance(1);
    const error = (await result) as RelayError;
    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe('timeout');
    expect(error.relayCode).toBeNull();
    expect(platform.relay.sockets[0]!.closed).toBe(true);
  });

  it('a relay error carries the code as an unauthenticated relayCode', async () => {
    const platform = makePlatform();
    platform.relay.mode = { error: 'unknown_route' };
    const link = RelayLink.open(platform, 'wss://relay.example.com', {
      v: 1,
      t: 'pair',
      lookup: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const error = (await link.ready.catch((e: unknown) => e)) as RelayError;
    expect(error.relayCode).toBe('unknown_route');
  });
});

describe('HostStore', () => {
  it('nextTs is max(now, lastTs + 1), persisted, serialised; broken records are skipped, not erased', async () => {
    const platform = makePlatform();
    const store = new HostStore(platform.keyStore);
    const record = new FakeBridge().enroll();
    await store.put(record);
    platform.keys.records.set('broken', '{"hostId":"broken"}');
    const [a, b] = await Promise.all([
      store.nextTs(record.hostId, 1000),
      store.nextTs(record.hostId, 1000),
    ]);
    expect([a, b]).toEqual([1000, 1001]);
    expect(await store.nextTs(record.hostId, 5)).toBe(1002);
    expect((await store.get(record.hostId))!.lastTs).toBe(1002);
    expect((await store.list()).map((r) => r.hostId)).toEqual([record.hostId]);
    expect(platform.keys.records.has('broken')).toBe(true);
    await expect(store.nextTs('missing', 1)).rejects.toThrow();
  });

  it('encodeTs is 8 bytes big-endian', () => {
    expect([...encodeTs(0x0102_0304_0506)]).toEqual([0, 0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('Rpc', () => {
  it('a send failure → connection_lost; a late answer after the timeout is ignored; failAll closes', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let fail = false;
    const rpc = new Rpc(
      (f) => {
        if (fail) throw new Error('closed');
        sent.push(f as Record<string, unknown>);
      },
      {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    );
    const slow = rpc.call('works.list', undefined, 100).catch((e: unknown) => e);
    await advance(100);
    expect(await slow).toMatchObject({ code: 'timeout' });
    expect(rpc.handle({ id: sent[0]!.id, result: 1 })).toBe(true);
    fail = true;
    expect(await rpc.call('x').catch((e: unknown) => e)).toMatchObject({ code: 'connection_lost' });
    fail = false;
    const pending = rpc.call('y').catch((e: unknown) => e);
    rpc.failAll();
    expect(await pending).toMatchObject({ code: 'connection_lost' });
    expect(await rpc.call('z').catch((e: unknown) => e)).toMatchObject({ code: 'connection_lost' });
    expect(rpc.pendingCount).toBe(0);
    await flush();
  });
});
