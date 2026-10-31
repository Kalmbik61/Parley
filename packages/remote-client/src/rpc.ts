// RPC поверх кадров приложения (спека §8.1, §8.4, §10.1): корреляция `id`, таймаут, `connection_lost`.
import { appResponseFrame } from '@parley/protocol/remote';
import type { Platform, TimerHandle } from './platform.js';

/** Таймаут вызова по умолчанию (§10.1). */
export const RPC_TIMEOUT_MS = 15_000;

/**
 * Коды клиента: `timeout` — ответа нет в срок; `connection_lost` — соединение ушло до ответа (итог вызова
 * неизвестен); `not_connected` — вызов не отправлен. Остальные коды пришли от моста или хоста (`remote: true`).
 */
export class RpcError extends Error {
  readonly code: string;
  readonly data: unknown;
  readonly remote: boolean;
  constructor(code: string, message: string, remote = false, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.remote = remote;
    this.data = data;
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: RpcError): void;
  timer: TimerHandle;
}

type Timers = Pick<Platform, 'setTimeout' | 'clearTimeout'>;

/**
 * Вызовы одного соединения. Ни один вызов этот слой не повторяет — ни по таймауту, ни после обрыва: итог
 * изменяющего вызова после `connection_lost` клиент узнаёт перечитыванием (§8.4, §11.4).
 */
export class Rpc {
  readonly #send: (frame: object) => void;
  readonly #timers: Timers;
  readonly #pending = new Map<string, Pending>();
  #seq = 0;
  #closed = false;

  constructor(send: (frame: object) => void, timers: Timers) {
    this.#send = send;
    this.#timers = timers;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  call(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RpcError('connection_lost', 'connection lost'));
    const id = String(++this.#seq);
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (this.#pending.delete(id)) reject(new RpcError('timeout', `${method}: no answer`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send(params === undefined ? { id, method } : { id, method, params });
      } catch {
        this.#settle(id)?.reject(new RpcError('connection_lost', 'connection lost'));
      }
    });
  }

  /** Кадр с `id` — ответ: разрешает свой вызов и возвращает `true`. Ответ без ожидающего вызова отбрасывается. */
  handle(frame: unknown): boolean {
    const parsed = appResponseFrame.safeParse(frame);
    if (!parsed.success) return false;
    const pending = this.#settle(parsed.data.id);
    if (pending === null) return true;
    if ('error' in parsed.data) {
      const { code, message, data } = parsed.data.error;
      pending.reject(new RpcError(code, message, true, data));
    } else {
      pending.resolve(parsed.data.result);
    }
    return true;
  }

  /** Обрыв: все ожидающие получают `connection_lost`, новые вызовы — тоже. */
  failAll(): void {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id)?.reject(new RpcError('connection_lost', 'connection lost'));
    }
  }

  #settle(id: string): Pending | null {
    const pending = this.#pending.get(id);
    if (pending === undefined) return null;
    this.#pending.delete(id);
    this.#timers.clearTimeout(pending.timer);
    return pending;
  }
}

/** Кадр приложения → UTF-8 JSON. */
export function encodeFrame(frame: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** UTF-8 JSON → значение. Неверный UTF-8 или JSON — исключение. */
export function decodeFrame(bytes: Uint8Array): unknown {
  return JSON.parse(utf8Decode(bytes));
}

interface TextDecoderLike {
  decode(input: Uint8Array): string;
}
type TextDecoderCtor = new (label: string, options: { fatal: boolean }) => TextDecoderLike;

/** Строгий UTF-8: родной `TextDecoder`, если он есть (в Hermes его может не быть), иначе свой разбор. */
export function utf8Decode(bytes: Uint8Array): string {
  const Ctor = (globalThis as { TextDecoder?: TextDecoderCtor }).TextDecoder;
  if (Ctor !== undefined) return new Ctor('utf-8', { fatal: true }).decode(bytes);
  return utf8DecodeStrict(bytes);
}

function utf8DecodeStrict(bytes: Uint8Array): string {
  const parts: string[] = [];
  let units: number[] = [];
  const cont = (i: number): number => {
    const b = bytes[i];
    if (b === undefined || (b & 0xc0) !== 0x80) throw new Error('invalid utf-8');
    return b & 0x3f;
  };
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i]!;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = ((b0 & 0x1f) << 6) | cont(i + 1);
      if (cp < 0x80) throw new Error('invalid utf-8');
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = ((b0 & 0x0f) << 12) | (cont(i + 1) << 6) | cont(i + 2);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('invalid utf-8');
      i += 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = ((b0 & 0x07) << 18) | (cont(i + 1) << 12) | (cont(i + 2) << 6) | cont(i + 3);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Error('invalid utf-8');
      i += 4;
    } else {
      throw new Error('invalid utf-8');
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      units.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= 8192) {
      parts.push(String.fromCharCode(...units));
      units = [];
    }
  }
  parts.push(String.fromCharCode(...units));
  return parts.join('');
}
