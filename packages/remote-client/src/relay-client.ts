// Телефон → relay `/v1/connect` (спека §6.3): первый текстовый кадр, ответ `ready` или `error`, затем бинарная
// труба с кадрами Noise. Ошибки relay — неаутентифицированные сигналы: их показывают, но по ним не действуют.
import { relayErrorFrame, relayReadyFrame, type RELAY_ERROR_CODES } from '@parley/protocol/remote';
import type { Platform, TimerHandle, WebSocketLike } from './platform.js';

/** Ожидание `ready` от relay (§10.2). */
export const RELAY_READY_TIMEOUT_MS = 10_000;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];
export type RelayFailure = RelayErrorCode | 'timeout' | 'closed' | 'protocol';

/**
 * Отказ relay или обрыв трубы. `relayCode` — код пришёл кадром `{t:'error'}` от relay: он неаутентифицирован,
 * его показывают, но по нему не действуют (§6.3).
 */
export class RelayError extends Error {
  readonly code: RelayFailure;
  readonly relayCode: RelayErrorCode | null;
  constructor(code: 'timeout' | 'closed' | 'protocol' | { relay: RelayErrorCode }) {
    const relayCode = typeof code === 'object' ? code.relay : null;
    super(relayCode !== null ? `relay error: ${relayCode}` : `relay link: ${code as string}`);
    this.name = 'RelayError';
    this.code = relayCode ?? (code as RelayFailure);
    this.relayCode = relayCode;
  }
}

export type RelayHello =
  | { v: 1; t: 'connect'; route: string; device: string; token: string }
  | { v: 1; t: 'pair'; lookup: string };

interface Waiter {
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
  timer: TimerHandle;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

/**
 * Одна труба через relay. `ready` разрешается на `{t:'ready'}`; дальше — только бинарные кадры. Пока
 * обработчик не задан, входящие кадры копятся и забираются `receive`; `onMessage` переводит трубу в режим
 * обработчика. Закрытие собеседником зовёт `onClose` один раз; своё `close()` его не зовёт.
 */
export class RelayLink {
  readonly ready: Promise<void>;
  readonly #platform: Platform;
  #ws: WebSocketLike | null = null;
  #phase: 'opening' | 'ready' | 'closed' = 'opening';
  #queue: Uint8Array[] = [];
  #waiter: Waiter | null = null;
  #onMessage: ((bytes: Uint8Array) => void) | null = null;
  #onClose: (() => void) | null = null;
  #readyTimer: TimerHandle = null;
  #settleReady: { resolve(): void; reject(error: Error): void } | null = null;
  #remoteClosed = false;

  private constructor(platform: Platform) {
    this.#platform = platform;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#settleReady = { resolve, reject };
    });
    // Отказ `ready` разбирает тот, кто его ждёт; без ожидающего он не должен стать необработанным.
    this.ready.catch(() => undefined);
  }

  /** `baseUrl` — результат `relayUrlFor` (`wss://host[:port]` или `ws://` в dev-сборке). */
  static open(
    platform: Platform,
    baseUrl: string,
    hello: RelayHello,
    readyTimeoutMs = RELAY_READY_TIMEOUT_MS,
  ): RelayLink {
    const link = new RelayLink(platform);
    link.#start(`${baseUrl}/v1/connect`, hello, readyTimeoutMs);
    return link;
  }

  get closed(): boolean {
    return this.#phase === 'closed';
  }

  send(bytes: Uint8Array): void {
    if (this.#phase !== 'ready' || this.#ws === null) throw new RelayError('closed');
    this.#ws.send(bytes);
  }

  /** Следующий бинарный кадр (рукопожатие). Таймаут или закрытие — `RelayError`. */
  receive(timeoutMs: number): Promise<Uint8Array> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#phase === 'closed') return Promise.reject(new RelayError('closed'));
    if (this.#waiter !== null) return Promise.reject(new RelayError('protocol'));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = this.#platform.setTimeout(() => {
        this.#waiter = null;
        reject(new RelayError('timeout'));
      }, timeoutMs);
      this.#waiter = { resolve, reject, timer };
    });
  }

  /** Режим обработчика: накопленные кадры уходят в него сразу, по порядку. */
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.#onMessage = handler;
    while (this.#queue.length > 0 && this.#onMessage === handler && this.#phase !== 'closed') {
      handler(this.#queue.shift()!);
    }
  }

  /** Труба уже закрыта собеседником — обработчик зовётся сразу. */
  onClose(handler: () => void): void {
    this.#onClose = handler;
    if (this.#remoteClosed) handler();
  }

  close(): void {
    if (this.#phase === 'closed') return;
    this.#finish(new RelayError('closed'), false);
  }

  #start(url: string, hello: RelayHello, readyTimeoutMs: number): void {
    let ws: WebSocketLike;
    try {
      ws = this.#platform.openSocket(url);
    } catch {
      this.#finish(new RelayError('closed'), false);
      return;
    }
    this.#ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.#phase !== 'opening') return;
      try {
        ws.send(JSON.stringify(hello));
      } catch {
        this.#finish(new RelayError('closed'), true);
      }
    };
    ws.onmessage = (event) => this.#onSocketMessage(event.data);
    ws.onclose = () => this.#finish(new RelayError('closed'), true);
    ws.onerror = () => this.#finish(new RelayError('closed'), true);
    this.#readyTimer = this.#platform.setTimeout(() => {
      if (this.#phase === 'opening') this.#finish(new RelayError('timeout'), false);
    }, readyTimeoutMs);
  }

  #onSocketMessage(data: unknown): void {
    if (this.#phase === 'closed') return;
    if (typeof data === 'string') {
      // После `ready` текстовых кадров нет: это нарушение протокола.
      if (this.#phase !== 'opening') return this.#finish(new RelayError('protocol'), true);
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return this.#finish(new RelayError('protocol'), true);
      }
      if (relayReadyFrame.safeParse(json).success) {
        this.#phase = 'ready';
        this.#platform.clearTimeout(this.#readyTimer);
        this.#settleReady?.resolve();
        return;
      }
      const error = relayErrorFrame.safeParse(json);
      return this.#finish(
        error.success ? new RelayError({ relay: error.data.code }) : new RelayError('protocol'),
        true,
      );
    }
    const bytes = toBytes(data);
    if (bytes === null || this.#phase !== 'ready')
      return this.#finish(new RelayError('protocol'), true);
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      this.#platform.clearTimeout(waiter.timer);
      waiter.resolve(bytes);
    } else if (this.#onMessage !== null) {
      this.#onMessage(bytes);
    } else {
      this.#queue.push(bytes);
    }
  }

  /** `remote` — закрыл собеседник (или сломался протокол): тогда зовётся `onClose`. */
  #finish(error: RelayError, remote: boolean): void {
    if (this.#phase === 'closed') return;
    const wasReady = this.#phase === 'ready';
    this.#phase = 'closed';
    this.#platform.clearTimeout(this.#readyTimer);
    this.#queue = [];
    const ws = this.#ws;
    if (ws !== null) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        // Сокет уже закрыт.
      }
    }
    if (!wasReady) this.#settleReady?.reject(error);
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      this.#platform.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (remote && wasReady) {
      this.#remoteClosed = true;
      this.#onClose?.();
    }
  }
}
