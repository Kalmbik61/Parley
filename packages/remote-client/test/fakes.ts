// Фейки для тестов: платформа, сокет, relay в памяти и мост на @parley/noise.
import { vi } from 'vitest';
import {
  FrameCodec,
  derivePairKeys,
  generateKeyPair,
  initiator,
  responder,
  sas,
  type HandshakeState,
  type KeyPair,
  type TransportCiphers,
} from '@parley/noise';
import { b64urlDecode, b64urlEncode, type BridgeHello } from '@parley/protocol/remote';
import { decodeFrame, encodeFrame } from '../src/rpc.js';
import { hostIdFor } from '../src/pair.js';
import type { HostRecord } from '../src/host-store.js';
import type {
  AppState,
  KeyStore,
  NetworkState,
  Platform,
  SocketMessageEvent,
  Subscribable,
  WebSocketLike,
} from '../src/platform.js';

const EMPTY = new Uint8Array(0);
const te = new TextEncoder();

/** Даёт отработать цепочкам промисов и «сетевым» доставкам (микрозадачи). */
export async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Сдвиг фейкового времени с прогоном микрозадач. Таймер с задержкой 0 фейковые таймеры запускают только при сдвиге ≥ 1 мс. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

export class Value<T> implements Subscribable<T> {
  #value: T;
  #listeners = new Set<(v: T) => void>();
  constructor(value: T) {
    this.#value = value;
  }
  get(): T {
    return this.#value;
  }
  set(value: T): void {
    this.#value = value;
    for (const l of [...this.#listeners]) l(value);
  }
  subscribe(listener: (v: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class MemoryKeyStore implements KeyStore {
  readonly records = new Map<string, string>();
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  async list(): Promise<HostRecord[]> {
    return [...this.records.values()].map((r) => JSON.parse(r) as HostRecord);
  }
  async put(record: HostRecord): Promise<void> {
    this.log.push(`put:${record.hostId}:${record.lastTs}`);
    this.records.set(record.hostId, JSON.stringify(record));
  }
  async remove(hostId: string): Promise<void> {
    this.log.push(`remove:${hostId}`);
    this.records.delete(hostId);
  }
  get(hostId: string): HostRecord | null {
    const raw = this.records.get(hostId);
    return raw === undefined ? null : (JSON.parse(raw) as HostRecord);
  }
}

/** Сокет телефона; «сервер» — relay. Доставка в обе стороны — асинхронная, как у настоящего WebSocket. */
export class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: SocketMessageEvent) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Закрыт телефоном. */
  closed = false;
  /** Закрыт relay. */
  dropped = false;
  readonly fromClient: Array<string | Uint8Array> = [];
  onClientData: (data: string | Uint8Array) => void = () => undefined;
  onClientClose: () => void = () => undefined;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    void Promise.resolve().then(() => !this.closed && this.onopen?.({}));
  }

  send(data: string | Uint8Array): void {
    if (this.closed || this.dropped) throw new Error('socket closed');
    const copy = typeof data === 'string' ? data : new Uint8Array(data);
    this.fromClient.push(copy);
    // Отправленное до `close()` доходит, как у настоящего WebSocket.
    void Promise.resolve().then(() => !this.dropped && this.onClientData(copy));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void Promise.resolve().then(() => this.onClientClose());
  }

  /** Relay → телефон. Кадры, отправленные до `drop`, доходят (порядок микрозадач). */
  push(data: string | Uint8Array): void {
    if (this.closed || this.dropped) return;
    const payload = typeof data === 'string' ? data : new Uint8Array(data).buffer;
    void Promise.resolve().then(() => !this.closed && this.onmessage?.({ data: payload }));
  }

  /** Relay закрывает сокет. */
  drop(): void {
    if (this.closed || this.dropped) return;
    this.dropped = true;
    void Promise.resolve().then(() => !this.closed && this.onclose?.({}));
  }
}

type RelayMode = 'ok' | 'silent' | { error: string };

/** Relay в памяти: разбирает первый кадр, отвечает `ready` или `error` и соединяет трубу с мостом. */
export class FakeRelay {
  readonly sockets: FakeSocket[] = [];
  mode: RelayMode = 'ok';
  bridge: FakeBridge | null = null;

  open(url: string): FakeSocket {
    const sock = new FakeSocket(url);
    this.sockets.push(sock);
    let first = true;
    sock.onClientData = (data) => {
      if (first) {
        first = false;
        if (typeof data !== 'string') return sock.drop();
        const hello = JSON.parse(data) as { t: string; lookup?: string; device?: string };
        const mode = this.mode;
        if (mode === 'silent') return;
        if (mode !== 'ok') {
          sock.push(JSON.stringify({ v: 1, t: 'error', code: mode.error }));
          return sock.drop();
        }
        if (this.bridge === null) {
          sock.push(JSON.stringify({ v: 1, t: 'error', code: 'host_offline' }));
          return sock.drop();
        }
        const conn = this.bridge.accept(sock, hello);
        sock.onClientData = (bytes) =>
          typeof bytes === 'string' ? sock.drop() : conn.onBinary(bytes);
        sock.onClientClose = () => conn.onClose();
        sock.push(JSON.stringify({ v: 1, t: 'ready' }));
      }
    };
    return sock;
  }

  get openSockets(): FakeSocket[] {
    return this.sockets.filter((s) => !s.closed && !s.dropped);
  }
}

interface DeviceEntry {
  dsPub: Uint8Array;
  lastTs: number;
}

export interface BridgeOptions {
  routeId?: Uint8Array;
}

/** Мост: IK для подключения, IKpsk0 для паринга, транспорт через FrameCodec. */
export class FakeBridge {
  readonly hs: KeyPair;
  readonly routeId: Uint8Array;
  readonly devices = new Map<string, DeviceEntry>();
  readonly conns: BridgeConn[] = [];
  /** Отвечать ли на `ping` и `client.info`. */
  autoPong = true;
  helloPatch: Record<string, unknown> = {};
  /** Секрет оффера паринга (`s` из QR). */
  offer: Uint8Array | null = null;
  /** Свой ответ на msg1 паринга вместо честного (противник). */
  pairOverride: ((conn: BridgeConn) => void) | null = null;
  /** Зовётся на каждый msg1 подключения до его разбора. */
  onMsg1: ((conn: BridgeConn) => void) | null = null;

  constructor(options: BridgeOptions = {}) {
    this.hs = generateKeyPair();
    this.routeId = options.routeId ?? crypto.getRandomValues(new Uint8Array(16));
  }

  get hostId(): string {
    return hostIdFor(this.hs.publicKey);
  }

  accept(sock: FakeSocket, hello: { t: string; device?: string }): BridgeConn {
    const conn = new BridgeConn(
      this,
      sock,
      hello.t === 'pair' ? 'pair' : 'connect',
      hello.device ?? null,
    );
    this.conns.push(conn);
    return conn;
  }

  hello(): BridgeHello {
    return {
      protocol: 1,
      minClient: '1.0.0',
      hostId: this.hostId,
      hostName: 'Test Mac',
      bridgeVersion: '0.26.0',
      hostVersion: '0.26.0',
      host: 'online',
      epoch: 'e1',
      stage: 'A',
      methods: ['ping', 'client.info', 'feed.decide'],
      events: ['works.changed'],
      relays: ['relay.example.com'],
      serverTime: Date.now(),
      ...this.helloPatch,
    } as BridgeHello;
  }

  /** Запись хоста на телефоне и устройство на мосту — как после паринга. */
  enroll(): HostRecord {
    const ds = generateKeyPair();
    const deviceId = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    this.devices.set(deviceId, { dsPub: ds.publicKey, lastTs: 0 });
    return {
      hostId: this.hostId,
      hostName: 'Test Mac',
      hsPub: b64urlEncode(this.hs.publicKey),
      relay: 'relay.example.com',
      relays: ['relay.example.com'],
      routeId: b64urlEncode(this.routeId),
      deviceId,
      relayToken: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
      dsPriv: b64urlEncode(ds.privateKey),
      dsPub: b64urlEncode(ds.publicKey),
      lastTs: 0,
      pairedAt: 1,
    };
  }

  get last(): BridgeConn {
    const conn = this.conns[this.conns.length - 1];
    if (conn === undefined) throw new Error('no bridge connection');
    return conn;
  }
}

export class BridgeConn {
  readonly bridge: FakeBridge;
  readonly sock: FakeSocket;
  readonly kind: 'pair' | 'connect';
  readonly device: string | null;
  hs: HandshakeState | null = null;
  ciphers: TransportCiphers | null = null;
  readonly codec = new FrameCodec({ maxFrame: 64 * 1024 });
  /** Байт флагов каждого принятого транспортного сообщения (§7.7: бит 1 — deflate). */
  readonly flags: number[] = [];
  /** Принятые кадры приложения. */
  readonly frames: Array<Record<string, unknown>> = [];
  ts: number | null = null;
  sas: string | null = null;
  pairPayload: unknown = null;
  rejected: string | null = null;
  closed = false;
  onFrame: ((frame: Record<string, unknown>) => void) | null = null;

  constructor(
    bridge: FakeBridge,
    sock: FakeSocket,
    kind: 'pair' | 'connect',
    device: string | null,
  ) {
    this.bridge = bridge;
    this.sock = sock;
    this.kind = kind;
    this.device = device;
  }

  onBinary(bytes: Uint8Array): void {
    if (this.ciphers === null)
      return this.kind === 'pair' ? this.#pairMsg1(bytes) : this.#connectMsg1(bytes);
    const plaintext = this.ciphers.receive.decryptWithAd(EMPTY, bytes);
    this.flags.push(plaintext[0]!);
    const chunk = this.codec.decode(plaintext);
    if (chunk === null) return;
    const frame = decodeFrame(chunk) as Record<string, unknown>;
    this.frames.push(frame);
    this.onFrame?.(frame);
    if (this.bridge.autoPong && (frame.method === 'ping' || frame.method === 'client.info')) {
      this.send({ id: frame.id, result: {} });
    }
  }

  onClose(): void {
    this.closed = true;
  }

  #connectMsg1(msg1: Uint8Array): void {
    this.bridge.onMsg1?.(this);
    const prologue = new Uint8Array([...te.encode('parley-remote/1'), ...this.bridge.routeId]);
    const hs = responder({ pattern: 'IK', prologue, s: this.bridge.hs });
    let payload: Uint8Array;
    try {
      payload = hs.readMessage(msg1);
    } catch {
      return this.#reject('unknown-key');
    }
    const entry = this.device === null ? undefined : this.bridge.devices.get(this.device);
    const rs = hs.remoteStatic();
    if (entry === undefined || rs === null || b64urlEncode(rs) !== b64urlEncode(entry.dsPub))
      return this.#reject('device-mismatch');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const ts = view.getUint32(0) * 0x1_0000_0000 + view.getUint32(4);
    this.ts = ts;
    if (ts <= entry.lastTs) return this.#reject('replay');
    entry.lastTs = ts;
    this.sock.push(hs.writeMessage(encodeFrame(this.bridge.hello())));
    this.ciphers = hs.split();
  }

  #pairMsg1(msg1: Uint8Array): void {
    if (this.bridge.pairOverride !== null) return this.bridge.pairOverride(this);
    if (this.bridge.offer === null) return this.#reject('no-offer');
    const { psk } = derivePairKeys(this.bridge.offer);
    const hs = responder({
      pattern: 'IKpsk0',
      prologue: te.encode('parley-pair/1'),
      s: this.bridge.hs,
      psk,
    });
    try {
      this.pairPayload = decodeFrame(hs.readMessage(msg1));
    } catch {
      return this.#reject('bad-psk');
    }
    this.sock.push(hs.writeMessage(encodeFrame({ v: 1 })));
    this.sas = sas(hs.handshakeHash());
    this.hs = hs;
    this.ciphers = hs.split();
  }

  #reject(reason: string): void {
    this.rejected = reason;
    this.sock.drop();
  }

  send(frame: object): void {
    if (this.ciphers === null) throw new Error('not ready');
    for (const pt of this.codec.encode(encodeFrame(frame)))
      this.sock.push(this.ciphers.send.encryptWithAd(EMPTY, pt));
  }

  /** «Allow» на Маке: устройство и `credentials`. */
  allow(overrides: Record<string, unknown> = {}): { deviceId: string; relayToken: string } {
    const deviceId = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const relayToken = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    this.send({
      t: 'credentials',
      hostId: this.bridge.hostId,
      hostName: 'Test Mac',
      deviceId,
      routeId: b64urlEncode(this.bridge.routeId),
      relayToken,
      relays: ['relay.example.com'],
      ...overrides,
    });
    return { deviceId, relayToken };
  }

  event(event: string, data: unknown): void {
    this.send({ event, data });
  }

  /** Мост закрывает поток. */
  drop(): void {
    this.sock.drop();
  }

  methods(name: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.method === name);
  }
}

export interface TestPlatform extends Platform {
  appStateValue: Value<AppState>;
  networkValue: Value<NetworkState>;
  relay: FakeRelay;
  keys: MemoryKeyStore;
  log: string[];
  /** Байт, которым заполняется `random` для джиттера; `null` — настоящая случайность. */
  jitterByte: number | null;
}

export function makePlatform(options: { allowLocalRelay?: boolean } = {}): TestPlatform {
  const log: string[] = [];
  const relay = new FakeRelay();
  const keys = new MemoryKeyStore(log);
  const appStateValue = new Value<AppState>('active');
  const networkValue = new Value<NetworkState>({ online: true, kind: 'wifi' });
  const platform: TestPlatform = {
    keyStore: keys,
    openSocket: (url) => relay.open(url),
    random(n) {
      if (platform.jitterByte !== null && n === 4)
        return new Uint8Array(4).fill(platform.jitterByte);
      return crypto.getRandomValues(new Uint8Array(n));
    },
    appState: appStateValue,
    network: networkValue,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    allowLocalRelay: options.allowLocalRelay ?? false,
    appStateValue,
    networkValue,
    relay,
    keys,
    log,
    jitterByte: null,
  };
  return platform;
}

export function qrFor(bridge: FakeBridge, relayHost = 'relay.example.com'): string {
  const s = crypto.getRandomValues(new Uint8Array(16));
  bridge.offer = s;
  return `parley://pair?v=1&k=${b64urlEncode(bridge.hs.publicKey)}&s=${b64urlEncode(s)}&r=${relayHost}`;
}

/** msg2, собранный чужим ключом хоста: противник прогоняет своё рукопожатие и шлёт его msg2. */
export function foreignMsg2(): Uint8Array {
  const foreign = generateKeyPair();
  const psk = derivePairKeys(crypto.getRandomValues(new Uint8Array(16))).psk;
  const prologue = te.encode('parley-pair/1');
  const a = initiator({
    pattern: 'IKpsk0',
    prologue,
    s: generateKeyPair(),
    rs: foreign.publicKey,
    psk,
  });
  const b = responder({ pattern: 'IKpsk0', prologue, s: foreign, psk });
  b.readMessage(a.writeMessage(encodeFrame({ v: 1, name: 'x', platform: 'ios', app: 'x' })));
  return b.writeMessage(encodeFrame({ v: 1 }));
}

export { b64urlDecode };
