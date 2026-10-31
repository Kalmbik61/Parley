// Супервизор подключения к одному хосту (спека §10.2, §7.5–7.6, §8.2–8.3).
import { FrameCodec, initiator, type TransportCiphers } from '@parley/noise';
import {
  REMOTE_PROTOCOL,
  appEventFrame,
  b64urlDecode,
  bridgeEventSchemas,
  bridgeHelloSchema,
  relayUrlFor,
  type BridgeHello,
} from '@parley/protocol/remote';
import { encodeTs, type HostStore } from './host-store.js';
import { HANDSHAKE_TIMEOUT_MS } from './pair.js';
import type { AppState, NetworkState, Platform, TimerHandle } from './platform.js';
import { RelayError, RelayLink, type RelayErrorCode } from './relay-client.js';
import { Rpc, RpcError, decodeFrame, encodeFrame } from './rpc.js';

/**
 * Запас фона перед закрытием (§10.2). Число ещё сверяется на устройстве (план A20, пп. 19–20): менять только
 * здесь.
 */
export const BACKGROUND_MARGIN_MS = 30_000;
/** Прикладной heartbeat в `ready` на переднем плане. */
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 10_000;
/** Проверка `ping` при смене сети и при возврате на передний план. */
export const PROBE_TIMEOUT_MS = 3_000;
/** На `active` соединение остаётся без проверки, если последний ответ на `ping` моложе этого. */
export const FRESH_PONG_MS = 5_000;
/** Отступ: полный джиттер, `0,5 с × 2ⁿ`, потолок 30 с; после 5 минут неудач — 60 с. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
export const BACKOFF_LONG_CAP_MS = 60_000;
export const BACKOFF_LONG_AFTER_MS = 5 * 60_000;
/** Потолок принятого кадра приложения на телефоне (§5.7). */
export const PHONE_MAX_FRAME = 8 * 1024 * 1024;

/**
 * Вызовы с токенами уходят без сжатия: сжатие кадра, где секрет соседствует с текстом, подконтрольным
 * атакующему, даёт оракул длины (ревью A3, m5).
 */
const UNCOMPRESSED_METHODS: ReadonlySet<string> = new Set(['push.register']);
/** Кодек отправки без сжатия: порог больше любого кадра. */
const PLAIN_CODEC = new FrameCodec({ maxFrame: 0, compressMin: Number.MAX_SAFE_INTEGER });

const CONNECT_PROLOGUE = new TextEncoder().encode('parley-remote/1');
const EMPTY = new Uint8Array(0);

export type ConnectionState =
  'idle' | 'connecting' | 'handshaking' | 'ready' | 'waiting' | 'offline' | 'blocked';
/**
 * `revoked`, `reset` — аутентифицированный `session.closing`; `update_phone` / `update_mac` — версия из hello
 * моста (§8.2). Выход из `blocked` — только действие человека (`unblock()` или новый паринг).
 */
export type BlockReason = 'revoked' | 'reset' | 'update_phone' | 'update_mac';

export interface SupervisorStatus {
  state: ConnectionState;
  /** Последний отказ relay — только для плашки: неаутентифицирован, ни на что не влияет. Чистится в `ready`. */
  relayError: RelayErrorCode | null;
  blocked: BlockReason | null;
  /** Hello моста последнего подключения; остаётся на время переподключения. */
  hello: BridgeHello | null;
  /** Когда сработает таймер отступа (`waiting`). */
  retryAt: number | null;
}

export interface ClientInfo {
  app: string;
  /** `x.y.z`: сверяется с `minClient` моста. */
  version: string;
  platform: string;
}

export interface SupervisorOptions {
  hostId: string;
  client: ClientInfo;
}

interface Conn {
  link: RelayLink | null;
  ciphers: TransportCiphers | null;
  codec: FrameCodec | null;
  rpc: Rpc | null;
  heartbeat: TimerHandle | null;
  lastPongAt: number;
}

class HandshakeFailure extends Error {}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionLess(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * Одна попытка подключения за раз; каждая попытка и сессия — свой `Conn`, и всё асинхронное сверяет, что его
 * `Conn` ещё текущий. Неаутентифицированные сигналы (отказы relay, обрывы) дают только плашку и отступ;
 * `blocked` — только по `session.closing` внутри Noise или по версии из msg2.
 */
export class Supervisor {
  readonly #platform: Platform;
  readonly #store: HostStore;
  readonly #hostId: string;
  readonly #client: ClientInfo;
  readonly #clientVersion: [number, number, number];
  readonly #statusListeners = new Set<(status: SupervisorStatus) => void>();
  readonly #eventListeners = new Set<(event: string, data: unknown) => void>();
  #unsubscribe: Array<() => void> = [];
  #started = false;
  #appState: AppState = 'active';
  #network: NetworkState = { online: true, kind: 'unknown' };
  #conn: Conn | null = null;
  #retryTimer: TimerHandle | null = null;
  #backgroundTimer: TimerHandle | null = null;
  #failures = 0;
  #failingSince: number | null = null;
  #status: SupervisorStatus = {
    state: 'idle',
    relayError: null,
    blocked: null,
    hello: null,
    retryAt: null,
  };

  constructor(platform: Platform, store: HostStore, options: SupervisorOptions) {
    const version = parseVersion(options.client.version);
    if (version === null) throw new Error('client version must be x.y.z');
    this.#platform = platform;
    this.#store = store;
    this.#hostId = options.hostId;
    this.#client = options.client;
    this.#clientVersion = version;
  }

  get hostId(): string {
    return this.#hostId;
  }

  get status(): SupervisorStatus {
    return this.#status;
  }

  subscribe(listener: (status: SupervisorStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** События моста и хоста после `ready`, кроме `session.closing` (его разбирает супервизор). */
  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#appState = this.#platform.appState.get();
    this.#network = this.#platform.network.get();
    this.#unsubscribe = [
      this.#platform.appState.subscribe((s) => this.#onAppState(s)),
      this.#platform.network.subscribe((n) => this.#onNetwork(n)),
    ];
    this.#connect();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#clearRetry();
    this.#clearBackground();
    if (this.#conn !== null) this.#teardown(this.#conn);
    if (this.#status.state !== 'blocked') this.#set({ state: 'idle', retryAt: null });
  }

  /** «Потянуть для обновления»: подключиться сейчас, если соединения нет и попытка не идёт. */
  refresh(): void {
    if (this.#conn === null) this.#connect();
  }

  /** Действие человека на экране `blocked` (например, «Try again» после обновления Мака). */
  unblock(): void {
    if (this.#status.blocked === null) return;
    this.#resetBackoff();
    this.#set({ state: 'idle', blocked: null });
    this.#connect();
  }

  /** Вызов к мосту. Без соединения — `not_connected`; ни один вызов не повторяется. */
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const conn = this.#conn;
    if (conn === null || conn.rpc === null || this.#status.state !== 'ready') {
      return Promise.reject(new RpcError('not_connected', 'not connected'));
    }
    return conn.rpc.call(method, params, timeoutMs);
  }

  // ---------- попытка ----------

  #connect(): void {
    if (!this.#started || this.#status.blocked !== null || this.#conn !== null) return;
    this.#clearRetry();
    if (!this.#network.online) return this.#set({ state: 'offline', retryAt: null });
    if (this.#appState !== 'active') return this.#set({ state: 'idle', retryAt: null });
    const conn: Conn = {
      link: null,
      ciphers: null,
      codec: null,
      rpc: null,
      heartbeat: null,
      lastPongAt: 0,
    };
    this.#conn = conn;
    this.#set({ state: 'connecting', retryAt: null });
    void this.#attempt(conn);
  }

  async #attempt(conn: Conn): Promise<void> {
    try {
      const record = await this.#store.get(this.#hostId);
      if (this.#conn !== conn) return;
      let baseUrl: string | null = null;
      try {
        if (record !== null)
          baseUrl = relayUrlFor(record.relay, { allowLocal: this.#platform.allowLocalRelay });
      } catch {
        // Частный relay в релизной сборке: не исправится повтором.
      }
      if (record === null || baseUrl === null) {
        // Записи нет или адрес недопустим — подключаться не к чему; повторять бессмысленно.
        this.#teardown(conn);
        return this.#set({ state: 'idle' });
      }
      const link = RelayLink.open(this.#platform, baseUrl, {
        v: 1,
        t: 'connect',
        route: record.routeId,
        device: record.deviceId,
        token: record.relayToken,
      });
      conn.link = link;
      await link.ready;
      if (this.#conn !== conn) return;
      this.#set({ state: 'handshaking' });
      // `lastTs` сохраняется до msg1 (§7.5).
      const ts = await this.#store.nextTs(this.#hostId, this.#platform.now());
      if (this.#conn !== conn) return;
      const routeId = b64urlDecode(record.routeId);
      const prologue = new Uint8Array(CONNECT_PROLOGUE.length + routeId.length);
      prologue.set(CONNECT_PROLOGUE);
      prologue.set(routeId, CONNECT_PROLOGUE.length);
      const hs = initiator({
        pattern: 'IK',
        prologue,
        s: { privateKey: b64urlDecode(record.dsPriv), publicKey: b64urlDecode(record.dsPub) },
        rs: b64urlDecode(record.hsPub),
      });
      link.send(hs.writeMessage(encodeTs(ts)));
      const msg2 = await link.receive(HANDSHAKE_TIMEOUT_MS);
      if (this.#conn !== conn) return;
      let raw: unknown;
      try {
        raw = decodeFrame(hs.readMessage(msg2));
      } catch {
        throw new HandshakeFailure('msg2');
      }
      // Ниже всё аутентифицировано: msg2 мог прислать только владелец HS_priv.
      const protocol = (raw as { protocol?: unknown } | null)?.protocol;
      if (typeof protocol === 'number' && protocol !== REMOTE_PROTOCOL) {
        return this.#block(protocol > REMOTE_PROTOCOL ? 'update_phone' : 'update_mac');
      }
      const hello = bridgeHelloSchema.safeParse(raw);
      if (!hello.success || hello.data.hostId !== this.#hostId) throw new HandshakeFailure('hello');
      const minClient = parseVersion(hello.data.minClient);
      if (minClient !== null && versionLess(this.#clientVersion, minClient))
        return this.#block('update_phone');
      this.#ready(conn, link, hs.split(), hello.data);
    } catch (error) {
      if (this.#conn !== conn) return;
      this.#lost(conn, error instanceof RelayError ? error.relayCode : null);
    }
  }

  #ready(conn: Conn, link: RelayLink, ciphers: TransportCiphers, hello: BridgeHello): void {
    conn.ciphers = ciphers;
    conn.codec = new FrameCodec({ maxFrame: PHONE_MAX_FRAME });
    conn.rpc = new Rpc((frame) => this.#send(conn, frame), this.#platform);
    conn.lastPongAt = this.#platform.now();
    this.#set({ state: 'ready', relayError: null, hello, retryAt: null });
    // Первый транспортный кадр — подтверждение сессии для моста (§7.5).
    conn.rpc.call('client.info', { ...this.#client }).catch(() => undefined);
    if (this.#appState === 'active') this.#scheduleHeartbeat(conn);
    link.onMessage((bytes) => this.#onTransport(conn, bytes));
    link.onClose(() => {
      if (this.#conn === conn) this.#lost(conn, null);
    });
  }

  #send(conn: Conn, frame: object): void {
    if (conn.link === null || conn.ciphers === null || conn.codec === null)
      throw new Error('not ready');
    const method = (frame as { method?: unknown }).method;
    const codec =
      typeof method === 'string' && UNCOMPRESSED_METHODS.has(method) ? PLAIN_CODEC : conn.codec;
    for (const plaintext of codec.encode(encodeFrame(frame))) {
      conn.link.send(conn.ciphers.send.encryptWithAd(EMPTY, plaintext));
    }
  }

  #onTransport(conn: Conn, bytes: Uint8Array): void {
    if (this.#conn !== conn || conn.ciphers === null || conn.codec === null || conn.rpc === null)
      return;
    let frame: unknown;
    try {
      const chunk = conn.codec.decode(conn.ciphers.receive.decryptWithAd(EMPTY, bytes));
      if (chunk === null) return;
      frame = decodeFrame(chunk);
    } catch {
      // Ошибка расшифровки или кадра — закрыть без попытки восстановить (§7.7).
      return this.#lost(conn, null);
    }
    if (conn.rpc.handle(frame)) return;
    const event = appEventFrame.safeParse(frame);
    if (!event.success) return;
    if (event.data.event === 'session.closing') {
      const closing = bridgeEventSchemas['session.closing'].safeParse(event.data.data);
      if (closing.success) this.#onClosing(conn, closing.data.reason);
      return;
    }
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event.data.event, event.data.data);
      } catch {
        // Слушатель не роняет соединение.
      }
    }
  }

  /** `session.closing` пришёл внутри Noise — аутентифицирован. */
  #onClosing(
    conn: Conn,
    reason: 'revoked' | 'reset' | 'rekey' | 'replaced' | 'shutdown' | 'slow',
  ): void {
    switch (reason) {
      case 'revoked':
      case 'reset':
        return this.#block(reason);
      case 'rekey':
        // Новое рукопожатие сразу, без отступа и без счёта неудачи (§7.6).
        this.#teardown(conn);
        return this.#connect();
      case 'replaced':
        // Сессию заменило другое подключение с теми же ключами: не переподключаемся сами, чтобы два клиента не
        // выбивали друг друга по кругу. Следующий триггер подключит заново.
        this.#teardown(conn);
        return this.#set({ state: 'idle' });
      default:
        return this.#lost(conn, null);
    }
  }

  // ---------- heartbeat ----------

  #scheduleHeartbeat(conn: Conn): void {
    if (conn.heartbeat !== null) this.#platform.clearTimeout(conn.heartbeat);
    conn.heartbeat = this.#platform.setTimeout(() => {
      conn.heartbeat = null;
      this.#ping(conn, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #ping(conn: Conn, timeoutMs: number): void {
    if (this.#conn !== conn || conn.rpc === null) return;
    if (conn.heartbeat !== null) {
      this.#platform.clearTimeout(conn.heartbeat);
      conn.heartbeat = null;
    }
    const alive = (): void => {
      if (this.#conn !== conn) return;
      conn.lastPongAt = this.#platform.now();
      // Сессия жива и отвечает: серия неудач закончилась.
      this.#resetBackoff();
      if (this.#appState === 'active') this.#scheduleHeartbeat(conn);
    };
    conn.rpc.call('ping', {}, timeoutMs).then(alive, (error: unknown) => {
      // Ответ с ошибкой — тоже ответ.
      if (error instanceof RpcError && error.remote) return alive();
      if (this.#conn === conn) this.#lost(conn, null);
    });
  }

  // ---------- триггеры ----------

  #onAppState(next: AppState): void {
    if (next === this.#appState) return;
    this.#appState = next;
    if (!this.#started) return;
    if (next === 'background') {
      this.#clearRetry();
      const conn = this.#conn;
      if (conn !== null && conn.heartbeat !== null) {
        this.#platform.clearTimeout(conn.heartbeat);
        conn.heartbeat = null;
      }
      if (conn === null) {
        if (this.#status.state === 'waiting') this.#set({ state: 'idle', retryAt: null });
        return;
      }
      this.#clearBackground();
      this.#backgroundTimer = this.#platform.setTimeout(() => {
        this.#backgroundTimer = null;
        if (this.#conn !== null) this.#teardown(this.#conn);
        if (this.#status.state !== 'blocked' && this.#status.state !== 'offline')
          this.#set({ state: 'idle' });
      }, BACKGROUND_MARGIN_MS);
      return;
    }
    this.#clearBackground();
    this.#resetBackoff();
    const conn = this.#conn;
    if (conn === null) return this.#connect();
    if (this.#status.state !== 'ready') return;
    if (this.#platform.now() - conn.lastPongAt < FRESH_PONG_MS) this.#scheduleHeartbeat(conn);
    else this.#ping(conn, PROBE_TIMEOUT_MS);
  }

  #onNetwork(next: NetworkState): void {
    const prev = this.#network;
    this.#network = next;
    if (!this.#started) return;
    if (!next.online) {
      if (!prev.online) return;
      this.#clearRetry();
      if (this.#conn !== null) this.#teardown(this.#conn);
      if (this.#status.blocked === null) this.#set({ state: 'offline', retryAt: null });
      return;
    }
    if (prev.online && next.kind === prev.kind) return;
    this.#resetBackoff();
    const conn = this.#conn;
    if (conn === null) return this.#connect();
    if (this.#status.state === 'ready' && this.#appState === 'active')
      this.#ping(conn, PROBE_TIMEOUT_MS);
  }

  // ---------- переходы ----------

  /** Неудача или обрыв: плашка (если отказал relay) и отступ. */
  #lost(conn: Conn, relayError: RelayErrorCode | null): void {
    this.#teardown(conn);
    if (relayError !== null) this.#set({ relayError });
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (!this.#started || this.#status.blocked !== null) return;
    if (!this.#network.online) return this.#set({ state: 'offline', retryAt: null });
    if (this.#appState !== 'active') return this.#set({ state: 'idle', retryAt: null });
    const now = this.#platform.now();
    if (this.#failingSince === null) this.#failingSince = now;
    const cap =
      now - this.#failingSince >= BACKOFF_LONG_AFTER_MS ? BACKOFF_LONG_CAP_MS : BACKOFF_CAP_MS;
    const ceiling = Math.min(cap, BACKOFF_BASE_MS * 2 ** this.#failures);
    const delay = Math.floor(this.#jitter() * ceiling);
    if (this.#failures < 30) this.#failures++;
    this.#clearRetry();
    this.#retryTimer = this.#platform.setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
    this.#set({ state: 'waiting', retryAt: now + delay });
  }

  #block(reason: BlockReason): void {
    if (this.#conn !== null) this.#teardown(this.#conn);
    this.#clearRetry();
    this.#set({ state: 'blocked', blocked: reason, retryAt: null });
  }

  /** Закрывает попытку или сессию; ожидающие вызовы получают `connection_lost`. */
  #teardown(conn: Conn): void {
    if (this.#conn === conn) this.#conn = null;
    if (conn.heartbeat !== null) {
      this.#platform.clearTimeout(conn.heartbeat);
      conn.heartbeat = null;
    }
    conn.link?.close();
    conn.rpc?.failAll();
    conn.ciphers?.send.destroy();
    conn.ciphers?.receive.destroy();
  }

  #resetBackoff(): void {
    this.#failures = 0;
    this.#failingSince = null;
  }

  /** Равномерно в [0, 1) из `platform.random`. */
  #jitter(): number {
    const b = this.#platform.random(4);
    return (((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!) / 0x1_0000_0000;
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) this.#platform.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearBackground(): void {
    if (this.#backgroundTimer !== null) this.#platform.clearTimeout(this.#backgroundTimer);
    this.#backgroundTimer = null;
  }

  #set(patch: Partial<SupervisorStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const listener of [...this.#statusListeners]) {
      try {
        listener(this.#status);
      } catch {
        // Слушатель не ломает супервизор.
      }
    }
  }
}
