// A7 acceptance: the bridge's access layer against the real relay (A4) and a test phone on @parley/noise.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { createRelay, type Relay } from '@parley/relay/dist/server.js';
import { Store } from '@parley/relay/dist/store.js';
import {
  derivePairKeys,
  FrameCodec,
  generateKeyPair,
  initiator,
  sas,
  type HandshakeState,
  type KeyPair,
  type TransportCiphers,
} from '@parley/noise';
import {
  b64urlDecode,
  b64urlEncode,
  parsePairUrl,
  type BridgeHello,
} from '@parley/protocol/remote';
import { createAuditLog, type AuditLog, type AuditRecord } from './audit.js';
import type { ControlEvents } from './control.js';
import { openRemoteAccess, type RemoteAccess, type RemoteAccessOptions } from './access.js';
import { createLog } from './log.js';
import { connectPrologue } from './sessions.js';
import type { SessionHandler } from './session-contract.js';

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const json = (b: Uint8Array): unknown => JSON.parse(dec.decode(b));
const bytes = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

async function until<T>(probe: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

// ---------- test phone ----------

/** A WebSocket with a message queue. */
class Wire {
  readonly ws: WebSocket;
  readonly #queue: { data: Uint8Array; binary: boolean }[] = [];
  readonly #waiters: ((m: { data: Uint8Array; binary: boolean } | null) => void)[] = [];
  closed = false;
  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on('error', () => {});
    this.ws.on('message', (data: RawData, binary) => {
      const m = { data: new Uint8Array(data as Buffer), binary };
      const w = this.#waiters.shift();
      if (w) w(m);
      else this.#queue.push(m);
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.#waiters.splice(0)) w(null);
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  /** Next message; null when the socket closed. */
  next(ms = 3000): Promise<{ data: Uint8Array; binary: boolean } | null> {
    const m = this.#queue.shift();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no message')), ms);
      this.#waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }
  send(data: Uint8Array | string): void {
    this.ws.send(data);
  }
}

/** Opens /v1/connect with a first frame; resolves 'ready' or the relay error code. */
async function dial(relayUrl: string, first: object): Promise<{ wire: Wire; status: string }> {
  const wire = new Wire(`${relayUrl}/v1/connect`);
  await wire.open();
  wire.send(JSON.stringify(first));
  const m = await wire.next();
  if (!m) return { wire, status: 'closed' };
  const reply = JSON.parse(dec.decode(m.data)) as { t: string; code?: string };
  return { wire, status: reply.t === 'ready' ? 'ready' : (reply.code ?? 'error') };
}

class PhoneChannel {
  readonly #out = new FrameCodec({ maxFrame: 8 << 20 });
  readonly #in = new FrameCodec({ maxFrame: 8 << 20 });
  constructor(
    readonly wire: Wire,
    readonly ciphers: TransportCiphers,
  ) {}
  send(frame: unknown): void {
    for (const p of this.#out.encode(bytes(frame)))
      this.wire.send(this.ciphers.send.encryptWithAd(EMPTY, p));
  }
  /** Next whole frame; null when the stream closed. */
  async recv(ms = 3000): Promise<unknown> {
    for (;;) {
      const m = await this.wire.next(ms);
      if (!m) return null;
      const f = this.#in.decode(this.ciphers.receive.decryptWithAd(EMPTY, m.data));
      if (f) return json(f);
    }
  }
}

interface Paired {
  ds: KeyPair;
  deviceId: string;
  relayToken: string;
  routeId: string;
  hostId: string;
}

const phonePayload = { v: 1, name: 'Test iPhone', platform: 'ios', app: '1.0.0' };

/** IKpsk0 msg1 for an offer, as the phone builds it. */
function pairMsg1(
  qr: string,
  ds: KeyPair,
  pskOverride?: Uint8Array,
): { hs: HandshakeState; msg1: Uint8Array } {
  const { k, s } = parsePairUrl(qr);
  const psk = pskOverride ?? derivePairKeys(s).psk;
  const hs = initiator({
    pattern: 'IKpsk0',
    prologue: enc.encode('parley-pair/1'),
    s: ds,
    rs: k,
    psk,
  });
  return { hs, msg1: hs.writeMessage(bytes(phonePayload)) };
}

function lookupOf(qr: string): string {
  return b64urlEncode(derivePairKeys(parsePairUrl(qr).s).lookup);
}

// ---------- fixture ----------

interface Fixture {
  dir: string;
  relay: Relay;
  store: Store;
  relayUrl: string;
  relayHost: string;
  audit: AuditLog;
  logFile: string;
  auditFile: string;
  events: { event: keyof ControlEvents; data: ControlEvents[keyof ControlEvents] }[];
  app: { opened: string[]; frames: { deviceId: string; frame: unknown }[]; closed: string[] };
  access: RemoteAccess;
  open(extra?: Partial<RemoteAccessOptions>): Promise<RemoteAccess>;
}

let f: Fixture;

const fastTiming = {
  offerMs: 60_000,
  requestMs: 60_000,
  ackMs: 2_000,
  msg1Ms: 2_000,
  confirmMs: 2_000,
};

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'parley-a7-'));
  const store = new Store(null);
  const relay = createRelay({ store, log: () => {}, timing: { acceptWaitMs: 1500 } });
  await new Promise<void>((r) => relay.server.listen(0, '127.0.0.1', () => r()));
  const port = (relay.server.address() as AddressInfo).port;
  const relayHost = `127.0.0.1:${port}`;
  const relayUrl = `ws://${relayHost}`;
  const logFile = path.join(dir, 'bridge.log');
  const auditFile = path.join(dir, 'audit.jsonl');
  const audit = createAuditLog({ file: auditFile, archive: `${auditFile}.1` });
  const events: Fixture['events'] = [];
  const app: Fixture['app'] = { opened: [], frames: [], closed: [] };
  const handler: SessionHandler = {
    hello: (): BridgeHello => ({
      protocol: 1,
      minClient: '1.0.0',
      hostId: 'h',
      hostName: 'Mac',
      bridgeVersion: '0.0.0',
      hostVersion: null,
      host: 'online',
      epoch: 'e:1',
      stage: 'A',
      methods: [],
      events: [],
      relays: [],
      serverTime: 1,
    }),
    onOpen: (id) => app.opened.push(id),
    onFrame: (id, frame) => app.frames.push({ deviceId: id, frame: json(frame) }),
    onClose: (id) => app.closed.push(id),
  };
  const fx: Fixture = {
    dir,
    relay,
    store,
    relayUrl,
    relayHost,
    audit,
    logFile,
    auditFile,
    events,
    app,
    access: undefined as unknown as RemoteAccess,
    async open(extra = {}) {
      const access = await openRemoteAccess({
        keysFile: path.join(dir, 'remote', 'keys.json'),
        devicesFile: path.join(dir, 'remote', 'devices.json'),
        relay: relayHost,
        hostName: 'Test Mac',
        audit,
        log: createLog({ file: logFile }),
        emit: (event, data) => events.push({ event, data }),
        timing: fastTiming,
        relayBackoff: { initialMs: 50, maxMs: 200 },
        lazyWriteMs: 20,
        resolveRelayUrl: (r) => `ws://${r}`,
        ...extra,
      });
      access.setSessionHandler(handler);
      access.start();
      await until(() => access.relayState === 'connected');
      fx.access = access;
      return access;
    },
  };
  return fx;
}

const auditRecords = (): AuditRecord[] => f.audit.tail(200);
const eventsOf = <E extends keyof ControlEvents>(e: E): ControlEvents[E][] =>
  f.events.filter((x) => x.event === e).map((x) => x.data as ControlEvents[E]);
const devicesOnDisk = (): { deviceId: string; state: string }[] => {
  try {
    return (
      JSON.parse(readFileSync(path.join(f.dir, 'remote', 'devices.json'), 'utf8')) as {
        devices: { deviceId: string; state: string }[];
      }
    ).devices;
  } catch {
    return [];
  }
};
const relayHasDevice = (deviceId: string): boolean =>
  f.store.deviceHash(f.access.keys().routeId, deviceId) !== undefined;

/** Starts a pairing up to `pair.request`; returns the phone side ready for credentials. */
async function startPairing(qr: string, ds = generateKeyPair()) {
  const { wire, status } = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(qr) });
  expect(status).toBe('ready');
  const { hs, msg1 } = pairMsg1(qr, ds);
  wire.send(msg1);
  const msg2 = await wire.next();
  expect(msg2?.binary).toBe(true);
  expect(json(hs.readMessage(msg2!.data))).toEqual({ v: 1 });
  const code = sas(hs.handshakeHash());
  const channel = new PhoneChannel(wire, hs.split());
  const request = await until(() => eventsOf('pair.request').at(-1));
  return { ds, code, channel, request };
}

/** Full pairing to an active device. */
async function pairDevice(): Promise<Paired> {
  const { qr } = await f.access.handlers['pair.start']();
  const p = await startPairing(qr);
  await f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: true });
  const creds = (await p.channel.recv()) as {
    t: string;
    deviceId: string;
    relayToken: string;
    routeId: string;
    hostId: string;
  };
  expect(creds.t).toBe('credentials');
  p.channel.send({ t: 'paired' });
  await until(() => eventsOf('pair.done').find((d) => d.deviceId === creds.deviceId));
  return {
    ds: p.ds,
    deviceId: creds.deviceId,
    relayToken: creds.relayToken,
    routeId: creds.routeId,
    hostId: creds.hostId,
  };
}

let lastTs = 1_000_000;

function connectMsg1(
  d: Paired,
  hsPub: Uint8Array,
  routeId = d.routeId,
  ts = ++lastTs,
): { hs: HandshakeState; msg1: Uint8Array } {
  const hs = initiator({ pattern: 'IK', prologue: connectPrologue(routeId), s: d.ds, rs: hsPub });
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, BigInt(ts), false);
  return { hs, msg1: hs.writeMessage(payload) };
}

/** Connection handshake through the relay; `confirm` sends the first transport frame. */
async function connect(
  d: Paired,
  opts: {
    msg1?: Uint8Array;
    hs?: HandshakeState;
    confirm?: boolean;
    device?: string;
    token?: string;
    route?: string;
  } = {},
) {
  const made =
    opts.msg1 && opts.hs ? { hs: opts.hs, msg1: opts.msg1 } : connectMsg1(d, f.access.keys().hsPub);
  const { wire, status } = await dial(f.relayUrl, {
    v: 1,
    t: 'connect',
    route: opts.route ?? d.routeId,
    device: opts.device ?? d.deviceId,
    token: opts.token ?? d.relayToken,
  });
  if (status !== 'ready') return { status, wire, channel: null, msg1: made.msg1 };
  wire.send(made.msg1);
  const msg2 = await wire.next();
  if (!msg2) return { status: 'closed', wire, channel: null, msg1: made.msg1 };
  const hello = json(made.hs.readMessage(msg2.data)) as BridgeHello;
  expect(hello.protocol).toBe(1);
  const channel = new PhoneChannel(wire, made.hs.split());
  if (opts.confirm !== false) {
    channel.send({
      id: '1',
      method: 'client.info',
      params: { app: 'parley', version: '1.0.0', platform: 'ios' },
    });
    await until(() =>
      f.app.frames.some(
        (x) => x.deviceId === d.deviceId && (x.frame as { id?: string }).id === '1',
      ),
    );
  }
  return { status: 'ready', wire, channel, msg1: made.msg1 };
}

beforeEach(async () => {
  f = await makeFixture();
  await f.open();
});

afterEach(async () => {
  await f.access.stop();
  await f.relay.close();
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- acceptance ----------

describe('pairing', () => {
  it('1: right QR → pair.request with the client SAS; allow → credentials; paired → active, token on relay', async () => {
    const { qr, expiresAt } = await f.access.handlers['pair.start']();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(parsePairUrl(qr).r).toBe(f.relayHost);
    const p = await startPairing(qr);
    expect(p.request.sas).toBe(p.code);
    expect(p.request.name).toBe('Test iPhone');
    // Before «Allow»: nothing on disk, nothing on the relay.
    expect(devicesOnDisk()).toEqual([]);
    expect(f.store.devicesOf(f.access.keys().routeId)).toEqual([]);

    await f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: true });
    const creds = (await p.channel.recv()) as Record<string, unknown>;
    expect(creds).toMatchObject({
      t: 'credentials',
      hostName: 'Test Mac',
      routeId: f.access.keys().routeId,
      relays: [f.relayHost],
    });
    expect(creds.hostId).toBe(f.access.hostId);
    const deviceId = creds.deviceId as string;
    expect(devicesOnDisk()).toEqual([expect.objectContaining({ deviceId, state: 'pending' })]);
    await until(() => relayHasDevice(deviceId));
    const tokenHash = b64urlEncode(
      createHash('sha256')
        .update(b64urlDecode(creds.relayToken as string))
        .digest(),
    );
    expect(f.store.deviceHash(f.access.keys().routeId, deviceId)).toBe(tokenHash);

    p.channel.send({ t: 'paired' });
    await until(() => eventsOf('pair.done').length === 1);
    expect(eventsOf('pair.done')[0]).toEqual({ requestId: p.request.requestId, deviceId });
    expect(devicesOnDisk()).toEqual([expect.objectContaining({ deviceId, state: 'active' })]);
    expect((await f.access.handlers['devices.list']()).map((d) => d.deviceId)).toEqual([deviceId]);
    expect(auditRecords().map((r) => r.kind)).toEqual([
      'pair-offer',
      'pair-request',
      'pair-allowed',
    ]);
  });

  it('2: wrong psk burns the offer; the second msg1 gets offer_closed; pair-failed bad-psk', async () => {
    const { qr } = await f.access.handlers['pair.start']();
    const { wire, status } = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(qr) });
    expect(status).toBe('ready');
    wire.send(pairMsg1(qr, generateKeyPair(), new Uint8Array(32).fill(7)).msg1);
    expect(await wire.next()).toBeNull(); // closed, no msg2
    await until(() => auditRecords().some((r) => r.kind === 'pair-failed'));
    expect(auditRecords().find((r) => r.kind === 'pair-failed')?.detail).toBe('bad-psk');

    const second = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(qr) });
    expect(second.status).toBe('offer_closed');
    expect(eventsOf('pair.request')).toEqual([]);
  });

  it('3: adversary with the same s goes first → real phone gets offer_closed, no SAS; replay vs new offer → bad-psk', async () => {
    const { qr } = await f.access.handlers['pair.start']();
    // The real phone's msg1 is held back by the relay; the adversary's msg1 arrives instead.
    const realDs = generateKeyPair();
    const realMsg1 = pairMsg1(qr, realDs).msg1;
    const adversary = await startPairing(qr);
    expect(adversary.request.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);

    let sasShown = false;
    const real = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(qr) });
    if (real.status === 'ready') sasShown = true; // a SAS would need a msg2 first
    expect(real.status).toBe('offer_closed');
    expect(sasShown).toBe(false);

    // Before «Allow»: no credentials, no device.
    expect(devicesOnDisk()).toEqual([]);
    await sleep(50);
    expect(adversary.channel.wire.closed).toBe(false);

    // The held-back msg1 replayed against a fresh offer: another psk.
    const fresh = await f.access.handlers['pair.start']();
    const replay = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(fresh.qr) });
    expect(replay.status).toBe('ready');
    replay.wire.send(realMsg1);
    expect(await replay.wire.next()).toBeNull();
    await until(() =>
      auditRecords().some((r) => r.kind === 'pair-failed' && r.detail === 'bad-psk'),
    );
    expect(devicesOnDisk()).toEqual([]);
  });

  it('4: answer for a request cancelled by a reissue, or expired, → stale_request; the current one is not approved', async () => {
    const first = await f.access.handlers['pair.start']();
    const a = await startPairing(first.qr);
    const second = await f.access.handlers['pair.start'](); // reissue: request A is gone
    expect(eventsOf('pair.failed')).toEqual([
      { requestId: a.request.requestId, reason: 'cancelled' },
    ]);
    const b = await startPairing(second.qr);
    expect(b.request.requestId).not.toBe(a.request.requestId);

    await expect(
      f.access.handlers['pair.answer']({ requestId: a.request.requestId, allow: true }),
    ).rejects.toMatchObject({
      code: 'stale_request',
    });
    expect(devicesOnDisk()).toEqual([]);
    await sleep(50);
    expect(b.channel.wire.closed).toBe(false); // B still waits, not approved

    // Expired request.
    await f.access.stop();
    f.events.length = 0;
    await f.open({ timing: { ...fastTiming, requestMs: 150 } });
    const third = await f.access.handlers['pair.start']();
    const c = await startPairing(third.qr);
    await sleep(250);
    await expect(
      f.access.handlers['pair.answer']({ requestId: c.request.requestId, allow: true }),
    ).rejects.toMatchObject({
      code: 'stale_request',
    });
    expect(eventsOf('pair.failed').at(-1)).toEqual({
      requestId: c.request.requestId,
      reason: 'timeout',
    });
    expect(devicesOnDisk()).toEqual([]);
  });

  it('5: no paired within the wait → device removed from devices.json and from the relay', async () => {
    await f.access.stop();
    await f.open({ timing: { ...fastTiming, ackMs: 200 } });
    const { qr } = await f.access.handlers['pair.start']();
    const p = await startPairing(qr);
    await f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: true });
    const creds = (await p.channel.recv()) as { deviceId: string };
    await until(() => relayHasDevice(creds.deviceId));
    expect(devicesOnDisk()).toHaveLength(1);
    await until(() => eventsOf('pair.failed').length === 1, 2000);
    expect(eventsOf('pair.failed')[0]).toEqual({
      requestId: p.request.requestId,
      reason: 'no-ack',
    });
    await until(() => devicesOnDisk().length === 0);
    await until(() => !relayHasDevice(creds.deviceId));
    expect(
      auditRecords()
        .filter((r) => r.kind === 'pair-failed')
        .map((r) => r.detail),
    ).toEqual(['no-ack']);
  });

  it('deny → pair.failed denied, no device', async () => {
    const { qr } = await f.access.handlers['pair.start']();
    const p = await startPairing(qr);
    await f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: false });
    expect(await p.channel.recv()).toBeNull();
    expect(eventsOf('pair.failed')).toEqual([{ requestId: p.request.requestId, reason: 'denied' }]);
    expect(auditRecords().some((r) => r.kind === 'pair-denied')).toBe(true);
    expect(devicesOnDisk()).toEqual([]);
    // A second answer to the same request is stale.
    await expect(
      f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: true }),
    ).rejects.toMatchObject({
      code: 'stale_request',
    });
  });
});

describe('connection', () => {
  it('6: replayed msg1 → connect-refused replay; the live session is untouched', async () => {
    const d = await pairDevice();
    const live = await connect(d);
    expect(f.app.opened).toEqual([d.deviceId]);
    const replay = await connect(d, {
      msg1: live.msg1,
      hs: connectMsg1(d, f.access.keys().hsPub).hs,
      confirm: false,
    }).catch(() => null);
    expect(replay?.channel ?? null).toBeNull();
    await until(() => auditRecords().some((r) => r.kind === 'connect-refused'));
    expect(
      auditRecords()
        .filter((r) => r.kind === 'connect-refused')
        .map((r) => r.detail),
    ).toEqual(['replay']);
    // Live session still works both ways.
    live.channel!.send({ id: '2', method: 'ping', params: {} });
    await until(() => f.app.frames.some((x) => (x.frame as { id?: string }).id === '2'));
    expect(f.access.sessions.send(d.deviceId, bytes({ id: '2', result: {} }))).toBe(true);
    expect(await live.channel!.recv()).toEqual({ id: '2', result: {} });
  });

  it('7: another DS_pub with a valid relayToken → device-mismatch', async () => {
    const a = await pairDevice();
    const b = await pairDevice();
    // Phone B presents A's relay identity: the relay lets it through, Noise names B.
    const r = await connect(b, { device: a.deviceId, token: a.relayToken, confirm: false });
    expect(r.channel).toBeNull();
    await until(() => auditRecords().some((x) => x.kind === 'connect-refused'));
    const refused = auditRecords().find((x) => x.kind === 'connect-refused')!;
    expect(refused.detail).toBe('device-mismatch');
    expect(f.app.opened).toEqual([]);
  });

  it('8: a confirmed new session closes the old one with replaced; an unconfirmed one does not', async () => {
    const d = await pairDevice();
    const old = await connect(d);
    const pending = await connect(d, { confirm: false });
    // Unconfirmed: the old one is still live.
    expect(f.access.sessions.send(d.deviceId, bytes({ event: 'x', data: 1 }))).toBe(true);
    expect(await old.channel!.recv()).toEqual({ event: 'x', data: 1 });
    // Confirm the new one.
    pending.channel!.send({ id: '9', method: 'ping', params: {} });
    expect(await old.channel!.recv()).toEqual({
      event: 'session.closing',
      data: { reason: 'replaced' },
    });
    expect(await old.channel!.recv()).toBeNull();
    expect(f.app.opened).toEqual([d.deviceId, d.deviceId]);
    expect(f.app.closed).toEqual([d.deviceId]);
    expect(f.access.sessions.send(d.deviceId, bytes({ event: 'y', data: 2 }))).toBe(true);
    expect(await pending.channel!.recv()).toEqual({ event: 'y', data: 2 });
  });

  it('unconfirmed session dies after the confirm window; nothing reaches A8', async () => {
    await f.access.stop();
    await f.open({ timing: { ...fastTiming, confirmMs: 150 } });
    const d = await pairDevice();
    const s = await connect(d, { confirm: false });
    expect(await s.wire.next(2000)).toBeNull();
    expect(f.app.opened).toEqual([]);
  });

  it('session lifetime → session.closing rekey', async () => {
    await f.access.stop();
    await f.open({ timing: { ...fastTiming, maxLifeMs: 300 } });
    const d = await pairDevice();
    const s = await connect(d);
    expect(await s.channel!.recv(2000)).toEqual({
      event: 'session.closing',
      data: { reason: 'rekey' },
    });
    expect(await s.channel!.recv()).toBeNull();
  });

  it('a frame over 64 KiB closes the session', async () => {
    const d = await pairDevice();
    const s = await connect(d);
    s.channel!.send({
      id: '3',
      method: 'ping',
      params: {
        pad: 'x'
          .repeat(70_000)
          .split('')
          .map((c, i) => c + (i % 97))
          .join(''),
      },
    });
    expect(await s.wire.next(2000)).toBeNull();
    expect(f.app.closed).toEqual([d.deviceId]);
  });
});

describe('revoke and reset', () => {
  it('9: revoke → live session gets session.closing revoked, then close; next handshake → unknown-key', async () => {
    const d = await pairDevice();
    const s = await connect(d);
    const stale = f.store.deviceHash(d.routeId, d.deviceId)!;
    await f.access.handlers['devices.revoke']({ deviceId: d.deviceId });
    expect(devicesOnDisk()).toEqual([]);
    expect(await s.channel!.recv()).toEqual({
      event: 'session.closing',
      data: { reason: 'revoked' },
    });
    expect(await s.channel!.recv()).toBeNull();
    expect(auditRecords().some((r) => r.kind === 'revoked' && r.deviceId === d.deviceId)).toBe(
      true,
    );
    await until(() => !relayHasDevice(d.deviceId));
    // A relay that still lets the token through: the bridge refuses locally.
    f.store.replaceDevices(d.routeId, [{ device: d.deviceId, tokenHash: stale }]);
    const again = await connect(d, { confirm: false });
    expect(again.channel).toBeNull();
    await until(() => auditRecords().some((r) => r.kind === 'connect-refused'));
    expect(auditRecords().find((r) => r.kind === 'connect-refused')?.detail).toBe('unknown-key');
    await expect(
      f.access.handlers['devices.revoke']({ deviceId: d.deviceId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('10: revoke between msg1 and confirmation → the session never activates, frames never reach A8', async () => {
    const d = await pairDevice();
    const s = await connect(d, { confirm: false });
    await f.access.handlers['devices.revoke']({ deviceId: d.deviceId });
    s.channel!.send({ id: '1', method: 'client.info', params: {} });
    expect(await s.wire.next()).toBeNull(); // closed silently: no session.closing for an unconfirmed session
    expect(f.app.opened).toEqual([]);
    expect(f.app.frames).toEqual([]);
  });

  it('11: revoke with a relay that does not answer → the window gets its answer; next handshake → unknown-key', async () => {
    const d = await pairDevice();
    // The relay stops reading the bridge's control socket: the new device list never lands.
    const host = f.relay.registry.host(d.routeId)!;
    host.ws.pause();
    await f.access.handlers['devices.revoke']({ deviceId: d.deviceId });
    expect(devicesOnDisk()).toEqual([]);
    expect(relayHasDevice(d.deviceId)).toBe(true); // still admitted by the relay
    const again = await connect(d, { confirm: false });
    expect(again.channel).toBeNull();
    await until(() => auditRecords().some((r) => r.kind === 'connect-refused'));
    expect(auditRecords().find((r) => r.kind === 'connect-refused')?.detail).toBe('unknown-key');
    host.ws.resume();
  });

  it('12: revoke, then bridge restart → the device stays revoked', async () => {
    const d = await pairDevice();
    const keep = await pairDevice();
    const stale = f.store.deviceHash(d.routeId, d.deviceId)!;
    await f.access.handlers['devices.revoke']({ deviceId: d.deviceId });
    await f.access.stop();
    await f.open();
    expect(f.access.devices.get(d.deviceId)).toBeUndefined();
    expect(f.access.devices.get(keep.deviceId)?.state).toBe('active');
    await until(() => !relayHasDevice(d.deviceId)); // full list re-sent after hello
    f.store.replaceDevices(d.routeId, [
      ...f.access.devices.relayList(),
      { device: d.deviceId, tokenHash: stale },
    ]);
    expect((await connect(d, { confirm: false })).channel).toBeNull();
    await until(() =>
      auditRecords().some((r) => r.kind === 'connect-refused' && r.detail === 'unknown-key'),
    );
    expect((await connect(keep)).channel).not.toBeNull();
  });

  it('13: reset → old route without devices (unknown_device); a stale relay still fails locally; a new QR works', async () => {
    const d = await pairDevice();
    const s = await connect(d);
    const oldPub = f.access.keys().hsPub;
    const stale = f.store.deviceHash(d.routeId, d.deviceId)!;
    await f.access.handlers.reset();
    expect(await s.channel!.recv()).toEqual({
      event: 'session.closing',
      data: { reason: 'reset' },
    });
    expect(devicesOnDisk()).toEqual([]);
    const keys = f.access.keys();
    expect(keys.routeId).not.toBe(d.routeId);
    expect(Buffer.from(keys.hsPub).equals(Buffer.from(oldPub))).toBe(false);
    expect(auditRecords().some((r) => r.kind === 'reset')).toBe(true);

    // Documented relay state: the old route has no devices.
    await until(
      () => !relayHasDevice(d.deviceId) && f.store.deviceHash(d.routeId, d.deviceId) === undefined,
    );
    await until(() => f.relay.registry.host(keys.routeId) !== undefined);
    expect(
      (
        await dial(f.relayUrl, {
          v: 1,
          t: 'connect',
          route: d.routeId,
          device: d.deviceId,
          token: d.relayToken,
        })
      ).status,
    ).toBe('unknown_device');

    // A stub relay that still admits the old token (on the route the bridge now holds): msg1 is sealed to the old HS.
    f.store.replaceDevices(keys.routeId, [{ device: d.deviceId, tokenHash: stale }]);
    const old = connectMsg1(d, oldPub, keys.routeId);
    const r = await connect(d, { msg1: old.msg1, hs: old.hs, route: keys.routeId, confirm: false });
    expect(r.channel).toBeNull();
    await until(() =>
      auditRecords().some((x) => x.kind === 'connect-refused' && x.detail === 'unknown-key'),
    );

    // A new QR pairs and connects.
    const fresh = await pairDevice();
    expect(fresh.routeId).toBe(keys.routeId);
    expect((await connect(fresh)).channel).not.toBeNull();
  });
});

describe('logs', () => {
  it('14: no s, psk, keys or tokens in bridge.log and audit.jsonl', async () => {
    const { qr } = await f.access.handlers['pair.start']();
    const offer = parsePairUrl(qr);
    const p = await startPairing(qr);
    await f.access.handlers['pair.answer']({ requestId: p.request.requestId, allow: true });
    const creds = (await p.channel.recv()) as {
      deviceId: string;
      relayToken: string;
      routeId: string;
    };
    p.channel.send({ t: 'paired' });
    await until(() => eventsOf('pair.done').length === 1);
    const d: Paired = {
      ds: p.ds,
      deviceId: creds.deviceId,
      relayToken: creds.relayToken,
      routeId: creds.routeId,
      hostId: '',
    };
    await connect(d);
    // A wrong-psk attempt and a reset add more paths that touch secrets.
    const again = await f.access.handlers['pair.start']();
    const bad = await dial(f.relayUrl, { v: 1, t: 'pair', lookup: lookupOf(again.qr) });
    bad.wire.send(pairMsg1(again.qr, generateKeyPair(), new Uint8Array(32).fill(1)).msg1);
    await bad.wire.next();
    const before = f.access.keys();
    await f.access.handlers.reset();
    await f.access.stop();
    const after = JSON.parse(
      readFileSync(path.join(f.dir, 'remote', 'keys.json'), 'utf8'),
    ) as Record<string, string>;

    const text = readFileSync(f.logFile, 'utf8') + readFileSync(f.auditFile, 'utf8');
    expect(text.length).toBeGreaterThan(0);
    const secrets = {
      s: b64urlEncode(offer.s),
      sHex: Buffer.from(offer.s).toString('hex'),
      psk: b64urlEncode(derivePairKeys(offer.s).psk),
      lookup: b64urlEncode(derivePairKeys(offer.s).lookup),
      relayToken: creds.relayToken,
      routeSecret: before.routeSecret,
      newRouteSecret: after.routeSecret!,
      hsPriv: b64urlEncode(before.hsPriv),
      newHsPriv: after.hsPriv!,
      dsPriv: b64urlEncode(p.ds.privateKey),
      qr,
    };
    for (const [name, value] of Object.entries(secrets))
      expect(text.includes(value), name).toBe(false);
  });
});
