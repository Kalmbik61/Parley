import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostStore } from '../src/host-store.js';
import { CREDENTIALS_TIMEOUT_MS, PairError, pair, type PairOptions } from '../src/pair.js';
import {
  FakeBridge,
  advance,
  flush,
  foreignMsg2,
  makePlatform,
  qrFor,
  type TestPlatform,
} from './fakes.js';

let platform: TestPlatform;
let store: HostStore;
let bridge: FakeBridge;

beforeEach(() => {
  vi.useFakeTimers();
  platform = makePlatform();
  store = new HostStore(platform.keyStore);
  bridge = new FakeBridge();
  platform.relay.bridge = bridge;
});
afterEach(() => {
  vi.useRealTimers();
});

function options(onSas = vi.fn()): PairOptions & { onSas: ReturnType<typeof vi.fn> } {
  return { deviceName: 'iPhone', platformName: 'ios', app: 'parley-mobile', onSas };
}

async function failure(p: Promise<unknown>): Promise<PairError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PairError);
  return error as PairError;
}

describe('pair', () => {
  it('shows the SAS after msg2, stores the host record before `paired`', async () => {
    const opts = options();
    const done = pair(platform, store, qrFor(bridge), opts);
    await flush();
    const conn = bridge.last;
    expect(conn.pairPayload).toEqual({
      v: 1,
      name: 'iPhone',
      platform: 'ios',
      app: 'parley-mobile',
    });
    expect(opts.onSas).toHaveBeenCalledTimes(1);
    expect(opts.onSas).toHaveBeenCalledWith(conn.sas);
    expect(platform.relay.sockets[0]!.url).toBe('wss://relay.example.com/v1/connect');

    // Человек думает почти 2 минуты.
    await advance(CREDENTIALS_TIMEOUT_MS - 5_000);
    conn.onFrame = () => platform.log.push('paired-received');
    const creds = conn.allow();
    const record = await done;
    await flush();

    expect(conn.frames).toEqual([{ t: 'paired' }]);
    expect(platform.log).toEqual([`put:${bridge.hostId}:0`, 'paired-received']);
    expect(record).toMatchObject({
      hostId: bridge.hostId,
      deviceId: creds.deviceId,
      relayToken: creds.relayToken,
      relay: 'relay.example.com',
      lastTs: 0,
    });
    expect(await store.get(bridge.hostId)).toEqual(record);
    expect(platform.relay.openSockets).toHaveLength(0);
  });

  it('acceptance 7: `offer_closed` before msg2 → error, no onSas', async () => {
    platform.relay.mode = { error: 'offer_closed' };
    const opts = options();
    const error = await failure(pair(platform, store, qrFor(bridge), opts));
    expect(error.code).toBe('offer_closed');
    expect(opts.onSas).not.toHaveBeenCalled();
    expect(platform.keys.records.size).toBe(0);
  });

  it('acceptance 7: msg2 under a foreign host key → handshake error, no onSas', async () => {
    bridge.pairOverride = (conn) => conn.sock.push(foreignMsg2());
    const opts = options();
    const error = await failure(pair(platform, store, qrFor(bridge), opts));
    expect(error.code).toBe('handshake');
    expect(opts.onSas).not.toHaveBeenCalled();
  });

  it('garbage msg2 → handshake error, no onSas', async () => {
    bridge.pairOverride = (conn) => conn.sock.push(new Uint8Array(80).fill(7));
    const opts = options();
    expect((await failure(pair(platform, store, qrFor(bridge), opts))).code).toBe('handshake');
    expect(opts.onSas).not.toHaveBeenCalled();
  });

  it('no msg2 in 10 s → timeout, no onSas', async () => {
    bridge.pairOverride = () => undefined;
    const opts = options();
    const p = failure(pair(platform, store, qrFor(bridge), opts));
    await advance(10_000);
    expect((await p).code).toBe('timeout');
    expect(opts.onSas).not.toHaveBeenCalled();
  });

  it('no `credentials` in 120 s → timeout, nothing stored', async () => {
    const opts = options();
    const p = failure(pair(platform, store, qrFor(bridge), opts));
    await flush();
    expect(opts.onSas).toHaveBeenCalledTimes(1);
    await advance(CREDENTIALS_TIMEOUT_MS);
    expect((await p).code).toBe('timeout');
    expect(platform.keys.records.size).toBe(0);
    expect(platform.relay.openSockets).toHaveLength(0);
  });

  it('the bridge closes after the SAS (Deny) → denied, nothing stored', async () => {
    const p = failure(pair(platform, store, qrFor(bridge), options()));
    await flush();
    bridge.last.drop();
    expect((await p).code).toBe('denied');
    expect(platform.keys.records.size).toBe(0);
  });

  it('`credentials` for another host → protocol error, nothing stored', async () => {
    const p = failure(pair(platform, store, qrFor(bridge), options()));
    await flush();
    bridge.last.allow({ hostId: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect((await p).code).toBe('protocol');
    expect(platform.keys.records.size).toBe(0);
    expect(bridge.last.frames).toEqual([]);
  });

  it('bad QR and a private relay in a release build → bad_qr without opening a socket', async () => {
    expect((await failure(pair(platform, store, 'parley://pair?v=1&k=x', options()))).code).toBe(
      'bad_qr',
    );
    expect(
      (await failure(pair(platform, store, qrFor(bridge, '192.168.1.5:8787'), options()))).code,
    ).toBe('bad_qr');
    expect(platform.relay.sockets).toHaveLength(0);
  });

  it('a private relay in a dev build goes over ws://', async () => {
    platform = makePlatform({ allowLocalRelay: true });
    platform.relay.bridge = bridge;
    store = new HostStore(platform.keyStore);
    const done = pair(platform, store, qrFor(bridge, '192.168.1.5:8787'), options());
    await flush();
    bridge.last.allow();
    await done;
    expect(platform.relay.sockets[0]!.url).toBe('ws://192.168.1.5:8787/v1/connect');
  });

  it('a long device name is trimmed, not a bad QR', async () => {
    const done = pair(platform, store, qrFor(bridge), {
      ...options(),
      deviceName: 'Очень длинное имя телефона 📱'.repeat(5),
    });
    await flush();
    expect((bridge.last.pairPayload as { name: string }).name.length).toBeLessThanOrEqual(64);
    bridge.last.allow();
    await done;
  });

  it('cancel before msg2 → cancelled, no onSas', async () => {
    bridge.pairOverride = () => undefined;
    const controller = new AbortController();
    const opts = { ...options(), signal: controller.signal };
    const p = failure(pair(platform, store, qrFor(bridge), opts));
    await flush();
    controller.abort();
    expect((await p).code).toBe('cancelled');
    expect(opts.onSas).not.toHaveBeenCalled();
  });

  it('m10: re-pairing that fails before `paired` restores the previous record of that Mac', async () => {
    const old = { ...bridge.enroll(), lastTs: 5 };
    await platform.keyStore.put(old);
    const put = platform.keys.put.bind(platform.keys);
    platform.keys.put = async (record) => {
      await put(record);
      // Relay закрывает сокет между записью и `paired`.
      if (record.deviceId !== old.deviceId) bridge.last.drop();
    };
    const p = failure(pair(platform, store, qrFor(bridge), options()));
    await flush();
    bridge.last.allow();
    expect((await p).code).toBe('connection');
    expect(await store.get(bridge.hostId)).toEqual(old);
  });

  it('m10: a first pairing that fails before `paired` leaves no record', async () => {
    const put = platform.keys.put.bind(platform.keys);
    platform.keys.put = async (record) => {
      await put(record);
      bridge.last.drop();
    };
    const p = failure(pair(platform, store, qrFor(bridge), options()));
    await flush();
    bridge.last.allow();
    expect((await p).code).toBe('connection');
    expect(platform.keys.records.size).toBe(0);
  });

  it('m13: an invalid platform or app name → protocol error, no socket', async () => {
    const bad = { ...options(), platformName: 'x'.repeat(33) };
    expect((await failure(pair(platform, store, qrFor(bridge), bad))).code).toBe('protocol');
    expect(platform.relay.sockets).toHaveLength(0);
  });

  it('error messages carry no secret from the QR', async () => {
    const qr = qrFor(bridge);
    const s = new URL(qr.replace('parley://', 'https://x/')).searchParams.get('s')!;
    platform.relay.mode = { error: 'rate_limited' };
    const error = await failure(pair(platform, store, qr, options()));
    expect(error.code).toBe('relay');
    expect(error.relayCode).toBe('rate_limited');
    expect(error.message).not.toContain(s);
  });
});
