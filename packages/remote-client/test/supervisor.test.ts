import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostStore, type HostRecord } from '../src/host-store.js';
import { RpcError } from '../src/rpc.js';
import {
  BACKGROUND_MARGIN_MS,
  BACKOFF_LONG_AFTER_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  Supervisor,
} from '../src/supervisor.js';
import { FakeBridge, advance, flush, makePlatform, type TestPlatform } from './fakes.js';

let platform: TestPlatform;
let store: HostStore;
let bridge: FakeBridge;
let record: HostRecord;
let sup: Supervisor;

const NEAR_ONE = 0xffffffff / 0x1_0000_0000;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  platform = makePlatform();
  store = new HostStore(platform.keyStore);
  bridge = new FakeBridge();
  platform.relay.bridge = bridge;
  record = bridge.enroll();
  await platform.keyStore.put(record);
  platform.log.length = 0;
  sup = new Supervisor(platform, store, {
    hostId: record.hostId,
    client: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' },
  });
});
afterEach(() => {
  sup.stop();
  vi.useRealTimers();
});

async function connect(): Promise<void> {
  sup.start();
  await flush(200);
  expect(sup.status.state).toBe('ready');
}

function retryDelay(): number {
  expect(sup.status.state).toBe('waiting');
  return sup.status.retryAt! - Date.now();
}

async function failure(p: Promise<unknown>): Promise<RpcError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

describe('connect', () => {
  it('reaches ready; lastTs is stored before msg1; client.info is the first transport frame', async () => {
    let storedAtMsg1: number | null = null;
    bridge.onMsg1 = () => (storedAtMsg1 = platform.keys.get(record.hostId)!.lastTs);
    await connect();
    const conn = bridge.last;
    expect(conn.ts).toBe(Date.now());
    expect(storedAtMsg1).toBe(conn.ts);
    expect(conn.frames[0]).toMatchObject({
      method: 'client.info',
      params: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' },
    });
    expect(sup.status.hello?.hostId).toBe(record.hostId);
    expect(platform.relay.sockets[0]!.url).toBe('wss://relay.example.com/v1/connect');
    expect(platform.relay.sockets[0]!.fromClient[0]).toBe(
      JSON.stringify({
        v: 1,
        t: 'connect',
        route: record.routeId,
        device: record.deviceId,
        token: record.relayToken,
      }),
    );
  });

  it('forwards bridge and host events, not session.closing', async () => {
    const events: Array<[string, unknown]> = [];
    sup.onEvent((e, d) => events.push([e, d]));
    await connect();
    bridge.last.event('bridge.status', { host: 'online', epoch: 'e1' });
    bridge.last.event('works.changed', { revision: 2 });
    await flush();
    expect(events).toEqual([
      ['bridge.status', { host: 'online', epoch: 'e1' }],
      ['works.changed', { revision: 2 }],
    ]);
  });
});

describe('acceptance 1: backoff', () => {
  it('a drop in ready → 0.5 → 1 → 2 … ≤ 30 s, 60 s after 5 minutes; `active` resets and connects at once', async () => {
    platform.jitterByte = 0xff;
    await connect();
    platform.relay.mode = { error: 'host_offline' };
    const startedFailing = Date.now();
    bridge.last.drop();
    await flush();

    const ceilings: number[] = [];
    while (Date.now() - startedFailing < BACKOFF_LONG_AFTER_MS + 120_000) {
      const delay = retryDelay();
      const failingFor = Date.now() - startedFailing;
      const ceiling = Math.min(
        failingFor >= BACKOFF_LONG_AFTER_MS ? 60_000 : 30_000,
        500 * 2 ** ceilings.length,
      );
      ceilings.push(ceiling);
      expect(delay).toBe(Math.floor(ceiling * NEAR_ONE));
      await advance(delay);
      await flush(200);
    }
    expect(ceilings.slice(0, 8)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(ceilings).toContain(60_000);
    expect(sup.status.relayError).toBe('host_offline');

    // `active` сбрасывает отступ и подключает сразу.
    platform.relay.mode = 'ok';
    const sockets = platform.relay.sockets.length;
    platform.appStateValue.set('background');
    platform.appStateValue.set('active');
    await flush(200);
    expect(platform.relay.sockets.length).toBe(sockets + 1);
    expect(sup.status.state).toBe('ready');
    expect(sup.status.relayError).toBeNull();

    // После сброса серия начинается заново: 0,5 с.
    platform.relay.mode = { error: 'host_offline' };
    bridge.last.drop();
    await flush();
    expect(retryDelay()).toBe(Math.floor(500 * NEAR_ONE));
  });

  it('the jitter is full: random 0 → immediate retry', async () => {
    platform.jitterByte = 0;
    await connect();
    bridge.last.drop();
    await flush();
    expect(retryDelay()).toBe(0);
    await advance(1);
    await flush(200);
    expect(sup.status.state).toBe('ready');
    expect(bridge.conns).toHaveLength(2);
  });

  it('a session that answers ping resets the failure series', async () => {
    platform.jitterByte = 0xff;
    platform.relay.mode = { error: 'host_offline' };
    sup.start();
    await flush(200);
    await advance(retryDelay());
    await flush(200);
    expect(retryDelay()).toBe(Math.floor(1000 * NEAR_ONE));
    platform.relay.mode = 'ok';
    await advance(retryDelay());
    await flush(200);
    expect(sup.status.state).toBe('ready');
    await advance(PING_INTERVAL_MS);
    bridge.last.drop();
    await flush();
    expect(retryDelay()).toBe(Math.floor(500 * NEAR_ONE));
  });
});

describe('acceptance 2: heartbeat', () => {
  it('ping every 15 s; no answer in 10 s → reconnect', async () => {
    platform.jitterByte = 0;
    await connect();
    await advance(PING_INTERVAL_MS);
    expect(bridge.last.methods('ping')).toHaveLength(1);
    await advance(PING_INTERVAL_MS);
    expect(bridge.last.methods('ping')).toHaveLength(2);

    bridge.autoPong = false;
    await advance(PING_INTERVAL_MS);
    expect(bridge.last.methods('ping')).toHaveLength(3);
    await advance(PING_TIMEOUT_MS - 1);
    expect(sup.status.state).toBe('ready');
    await advance(1);
    expect(['waiting', 'connecting', 'handshaking', 'ready']).toContain(sup.status.state);
    expect(bridge.conns[0]!.sock.closed).toBe(true);
    await advance(1);
    await flush(200);
    expect(bridge.conns).toHaveLength(2);
  });

  it('network change in ready → immediate ping with a 3 s timeout', async () => {
    await connect();
    platform.networkValue.set({ online: true, kind: 'cellular' });
    await flush();
    expect(bridge.last.methods('ping')).toHaveLength(1);
    expect(sup.status.state).toBe('ready');
    expect(bridge.conns).toHaveLength(1);

    bridge.autoPong = false;
    platform.networkValue.set({ online: true, kind: 'wifi' });
    await flush();
    expect(bridge.last.methods('ping')).toHaveLength(2);
    await advance(PROBE_TIMEOUT_MS - 1);
    expect(sup.status.state).toBe('ready');
    await advance(1);
    expect(bridge.conns[0]!.sock.closed).toBe(true);
    expect(sup.status.state).not.toBe('ready');
  });

  it('offline → state offline and the socket closed; back online → connects at once', async () => {
    await connect();
    const pending = failure(sup.call('works.list'));
    platform.networkValue.set({ online: false, kind: 'none' });
    await flush();
    expect(sup.status.state).toBe('offline');
    expect((await pending).code).toBe('connection_lost');
    expect(bridge.conns[0]!.sock.closed).toBe(true);
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(1);
    platform.networkValue.set({ online: true, kind: 'wifi' });
    await flush(200);
    expect(sup.status.state).toBe('ready');
  });
});

describe('acceptance 3: background', () => {
  it('background → closed after 30 s, state idle, no pings and no retries in background', async () => {
    await connect();
    platform.appStateValue.set('background');
    await advance(BACKGROUND_MARGIN_MS - 1);
    expect(sup.status.state).toBe('ready');
    expect(bridge.last.methods('ping')).toHaveLength(0);
    await advance(1);
    expect(sup.status.state).toBe('idle');
    expect(bridge.last.sock.closed).toBe(true);
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(1);

    platform.appStateValue.set('active');
    await flush(200);
    expect(sup.status.state).toBe('ready');
    expect(platform.relay.sockets).toHaveLength(2);
  });

  it('`active` after 10 s with a live ping → no reconnect', async () => {
    await connect();
    platform.appStateValue.set('background');
    await advance(10_000);
    platform.appStateValue.set('active');
    await flush();
    expect(bridge.last.methods('ping')).toHaveLength(1);
    await advance(BACKGROUND_MARGIN_MS);
    expect(sup.status.state).toBe('ready');
    expect(platform.relay.sockets).toHaveLength(1);
    expect(bridge.last.sock.closed).toBe(false);
  });

  it('`active` after 10 s with a dead connection → reconnect after the 3 s probe', async () => {
    platform.jitterByte = 0;
    await connect();
    platform.appStateValue.set('background');
    await advance(10_000);
    bridge.autoPong = false;
    platform.appStateValue.set('active');
    await advance(PROBE_TIMEOUT_MS);
    await advance(1);
    await flush(200);
    expect(bridge.conns[0]!.sock.closed).toBe(true);
    expect(platform.relay.sockets).toHaveLength(2);
  });

  it('`active` within 5 s of the last ping answer → kept without a probe', async () => {
    await connect();
    platform.appStateValue.set('background');
    await advance(2_000);
    platform.appStateValue.set('active');
    await flush();
    expect(bridge.last.methods('ping')).toHaveLength(0);
    expect(sup.status.state).toBe('ready');
  });

  it('a pending retry is dropped in background; `active` connects at once', async () => {
    platform.jitterByte = 0xff;
    platform.relay.mode = { error: 'host_offline' };
    sup.start();
    await flush(200);
    expect(sup.status.state).toBe('waiting');
    platform.appStateValue.set('background');
    expect(sup.status.state).toBe('idle');
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(1);
  });
});

describe('acceptance 4: unauthenticated vs authenticated signals', () => {
  it('relay `unknown_device` → waiting with a banner; the host record stays', async () => {
    platform.jitterByte = 0xff;
    platform.relay.mode = { error: 'unknown_device' };
    sup.start();
    await flush(200);
    expect(sup.status).toMatchObject({
      state: 'waiting',
      relayError: 'unknown_device',
      blocked: null,
    });
    expect(platform.keys.get(record.hostId)).not.toBeNull();
    expect(platform.log.filter((l) => l.startsWith('remove'))).toEqual([]);
    await advance(retryDelay());
    await flush(200);
    expect(platform.relay.sockets).toHaveLength(2);
    expect(sup.status.state).toBe('waiting');
  });

  it('`session.closing revoked` inside Noise → blocked; nothing reconnects until the human acts', async () => {
    await connect();
    bridge.last.event('session.closing', { reason: 'revoked' });
    await flush();
    expect(sup.status).toMatchObject({ state: 'blocked', blocked: 'revoked' });
    expect(bridge.last.sock.closed).toBe(true);
    platform.appStateValue.set('background');
    platform.appStateValue.set('active');
    platform.networkValue.set({ online: true, kind: 'cellular' });
    sup.refresh();
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(1);
    expect(platform.keys.get(record.hostId)).not.toBeNull();

    sup.unblock();
    await flush(200);
    expect(sup.status).toMatchObject({ state: 'ready', blocked: null });
  });

  it('`session.closing reset` → blocked', async () => {
    await connect();
    bridge.last.event('session.closing', { reason: 'reset' });
    await flush();
    expect(sup.status).toMatchObject({ state: 'blocked', blocked: 'reset' });
  });

  it('a forged frame from the relay is not a signal: decryption fails → reconnect, not blocked', async () => {
    await connect();
    bridge.last.sock.push(new Uint8Array(40).fill(1));
    await flush();
    expect(sup.status.state).toBe('waiting');
    expect(sup.status.blocked).toBeNull();
  });

  it('a text frame after ready → reconnect, not blocked', async () => {
    await connect();
    bridge.last.sock.push(JSON.stringify({ v: 1, t: 'error', code: 'unknown_device' }));
    await flush();
    expect(sup.status.state).toBe('waiting');
    expect(sup.status.blocked).toBeNull();
  });

  it('version: bridge protocol newer → update_phone; older → update_mac; minClient above ours → update_phone', async () => {
    bridge.helloPatch = { protocol: 2 };
    await flushStart();
    expect(sup.status).toMatchObject({ state: 'blocked', blocked: 'update_phone' });
    sup.stop();

    bridge.helloPatch = { protocol: 0 };
    sup = newSupervisor();
    await flushStart();
    expect(sup.status).toMatchObject({ state: 'blocked', blocked: 'update_mac' });
    sup.stop();

    bridge.helloPatch = { minClient: '1.2.0' };
    sup = newSupervisor();
    await flushStart();
    expect(sup.status).toMatchObject({ state: 'blocked', blocked: 'update_phone' });
  });

  it('a hello for another host → failure with backoff, not ready', async () => {
    bridge.helloPatch = { hostId: 'someone-else' };
    sup.start();
    await flush(200);
    expect(sup.status.state).toBe('waiting');
  });
});

describe('acceptance 5: one attempt at a time', () => {
  it('two quick attempts → one in flight; the next ts is strictly larger even with the same clock', async () => {
    sup.start();
    sup.refresh();
    platform.networkValue.set({ online: true, kind: 'cellular' });
    platform.appStateValue.set('background');
    platform.appStateValue.set('active');
    sup.refresh();
    await flush(200);
    expect(platform.relay.sockets).toHaveLength(1);
    expect(sup.status.state).toBe('ready');
    const first = bridge.last.ts!;

    // `rekey` — сразу, без отступа, при тех же часах.
    bridge.last.event('session.closing', { reason: 'rekey' });
    await flush(200);
    expect(platform.relay.sockets).toHaveLength(2);
    expect(sup.status.state).toBe('ready');
    const second = bridge.last.ts!;
    expect(second).toBe(first + 1);
    expect(bridge.last.rejected).toBeNull();
  });

  it('the clock going back does not lower ts', async () => {
    await connect();
    const first = bridge.last.ts!;
    vi.setSystemTime(Date.now() - 3_600_000);
    bridge.last.event('session.closing', { reason: 'rekey' });
    await flush(200);
    expect(bridge.last.ts).toBe(first + 1);
    expect(sup.status.state).toBe('ready');
  });

  it('`replaced` → idle without an automatic reconnect', async () => {
    await connect();
    bridge.last.event('session.closing', { reason: 'replaced' });
    await flush();
    expect(sup.status.state).toBe('idle');
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(1);
    sup.refresh();
    await flush(200);
    expect(sup.status.state).toBe('ready');
  });
});

describe('acceptance 6: RPC', () => {
  it('pending calls get connection_lost on a drop; a mutating call is not repeated', async () => {
    platform.jitterByte = 0;
    await connect();
    const decide = failure(sup.call('feed.decide', { ref: 's-1', cardId: 'c', decision: 'allow' }));
    const read = failure(sup.call('works.list'));
    await flush();
    expect(bridge.last.methods('feed.decide')).toHaveLength(1);
    bridge.last.drop();
    expect((await decide).code).toBe('connection_lost');
    expect((await read).code).toBe('connection_lost');
    await advance(1);
    await flush(200);
    expect(sup.status.state).toBe('ready');
    await advance(PING_INTERVAL_MS * 3);
    expect(bridge.conns.flatMap((c) => c.methods('feed.decide'))).toHaveLength(1);
  });

  it('results, remote errors and the 15 s timeout', async () => {
    await connect();
    bridge.last.onFrame = (f) => {
      if (f.method === 'works.list') bridge.last.send({ id: f.id, result: { works: [] } });
      if (f.method === 'feed.decide')
        bridge.last.send({ id: f.id, error: { code: 'conflict', message: 'changed' } });
    };
    await expect(sup.call('works.list')).resolves.toEqual({ works: [] });
    const conflict = await failure(sup.call('feed.decide', {}));
    expect(conflict).toMatchObject({ code: 'conflict', remote: true });
    const slow = failure(sup.call('host.info'));
    await advance(15_000);
    expect((await slow).code).toBe('timeout');
    expect(sup.status.state).toBe('ready');
  });

  it('push.register goes uncompressed even when large; other large frames are compressed (review A3 m5)', async () => {
    await connect();
    const conn = bridge.last;
    const pad = 'x'.repeat(4000);
    void sup
      .call('push.register', { apnsToken: 'ab'.repeat(32), env: 'sandbox', pad })
      .catch(() => undefined);
    await flush();
    const registerFlags = conn.flags.at(-1)!;
    void sup.call('works.list', { pad }).catch(() => undefined);
    await flush();
    expect(conn.methods('push.register')).toHaveLength(1);
    expect(registerFlags & 0x02).toBe(0);
    expect(conn.flags.at(-1)! & 0x02).toBe(0x02);
  });

  it('a call without a connection → not_connected, nothing sent', async () => {
    platform.relay.mode = { error: 'host_offline' };
    sup.start();
    await flush(200);
    expect((await failure(sup.call('feed.decide', {}))).code).toBe('not_connected');
  });
});

describe('host record', () => {
  it('a private relay in a release build or a missing record → idle without retries', async () => {
    await platform.keyStore.put({ ...record, relay: '192.168.1.5:8787' });
    sup.start();
    await flush(200);
    expect(sup.status.state).toBe('idle');
    await platform.keyStore.remove(record.hostId);
    sup.refresh();
    await flush(200);
    expect(sup.status.state).toBe('idle');
    await advance(10 * 60_000);
    expect(platform.relay.sockets).toHaveLength(0);
  });
});

describe('stop', () => {
  it('closes the connection and stays idle', async () => {
    await connect();
    sup.stop();
    expect(sup.status.state).toBe('idle');
    expect(bridge.last.sock.closed).toBe(true);
    platform.appStateValue.set('background');
    platform.appStateValue.set('active');
    await advance(60_000);
    expect(platform.relay.sockets).toHaveLength(1);
  });
});

function newSupervisor(): Supervisor {
  return new Supervisor(platform, store, {
    hostId: record.hostId,
    client: { app: 'parley-mobile', version: '1.0.0', platform: 'ios' },
  });
}

async function flushStart(): Promise<void> {
  sup.start();
  await flush(200);
}
