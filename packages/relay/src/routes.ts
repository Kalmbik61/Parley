// Состояние маршрутов в памяти: подключённые мосты, офферы паринга, ожидающие потоки, счётчик потоков.
import { createHash, timingSafeEqual } from 'node:crypto';
import { b64urlDecode } from '@parley/protocol/remote';
import type { WebSocket } from 'ws';

export const MAX_STREAMS_PER_ROUTE = 10;
/** Оффер живёт 120 с (спека 7.3); больше десяти минут `exp` не принимается. */
export const MAX_OFFER_MS = 10 * 60_000;

const ZERO = Buffer.alloc(32);

/** sha256 от байтов, закодированных в b64url. null — не b64url. */
export function sha256OfB64(text: string): Buffer | null {
  try {
    return createHash('sha256').update(b64urlDecode(text)).digest();
  } catch {
    return null;
  }
}

/** Сравнение хэшей за постоянное время; нет сохранённого хэша — сравнение с нулями, ответ всё равно «нет». */
export function hashMatches(stored: string | undefined, presented: Buffer | null): boolean {
  let expected: Buffer | null = null;
  if (stored !== undefined) {
    try {
      expected = Buffer.from(b64urlDecode(stored));
    } catch {
      expected = null;
    }
  }
  const a = expected !== null && expected.length === 32 ? expected : ZERO;
  const b = presented !== null && presented.length === 32 ? presented : Buffer.alloc(32, 1);
  const equal = timingSafeEqual(a, b);
  return equal && expected !== null && presented !== null && expected.length === 32;
}

export interface Pending {
  phone: WebSocket;
  timer: NodeJS.Timeout;
  /** Снимает слушатели ожидания с сокета телефона. */
  release: () => void;
}

export interface Host {
  routeId: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
  offer: { lookup: string; exp: number } | null;
}

export class Registry {
  private readonly hosts = new Map<string, Host>();
  private readonly offers = new Map<string, string>();
  private readonly active = new Map<string, number>();

  host(routeId: string): Host | undefined {
    return this.hosts.get(routeId);
  }

  hostCount(): number {
    return this.hosts.size;
  }

  offerCount(): number {
    return this.offers.size;
  }

  /** Принимает мост; прежний управляющий сокет маршрута вытесняется. */
  attach(routeId: string, ws: WebSocket): Host {
    const old = this.hosts.get(routeId);
    if (old) this.detach(old, 4000);
    const host: Host = { routeId, ws, pending: new Map(), offer: null };
    this.hosts.set(routeId, host);
    return host;
  }

  /** Снимает мост: оффер закрывается, ожидающие потоки получают `host_offline` через `failPending`. */
  detach(host: Host, closeCode?: number): Pending[] {
    if (this.hosts.get(host.routeId) === host) this.hosts.delete(host.routeId);
    this.setOffer(host, null, 0);
    const list = [...host.pending.values()];
    host.pending.clear();
    for (const p of list) clearTimeout(p.timer);
    if (closeCode !== undefined) host.ws.close(closeCode);
    for (const p of list) failPhone(p.phone);
    return list;
  }

  /** Возвращает false, если `lookup` уже занят другим маршрутом. */
  setOffer(host: Host, lookup: string | null, exp: number): boolean {
    if (lookup !== null) {
      const owner = this.offers.get(lookup);
      if (owner !== undefined && owner !== host.routeId) return false;
    }
    if (host.offer) this.offers.delete(host.offer.lookup);
    host.offer = lookup === null ? null : { lookup, exp };
    if (lookup !== null) this.offers.set(lookup, host.routeId);
    return true;
  }

  /** Открытый оффер → его мост; истёкший оффер удаляется. */
  findOffer(lookup: string, now: number): Host | undefined {
    const routeId = this.offers.get(lookup);
    const host = routeId === undefined ? undefined : this.hosts.get(routeId);
    if (!host?.offer) return undefined;
    if (host.offer.exp <= now) {
      this.setOffer(host, null, 0);
      return undefined;
    }
    return host;
  }

  streams(routeId: string): number {
    return (this.hosts.get(routeId)?.pending.size ?? 0) + (this.active.get(routeId) ?? 0);
  }

  pipeOpened(routeId: string): void {
    this.active.set(routeId, (this.active.get(routeId) ?? 0) + 1);
  }

  pipeClosed(routeId: string): void {
    const n = (this.active.get(routeId) ?? 0) - 1;
    if (n > 0) this.active.set(routeId, n);
    else this.active.delete(routeId);
  }
}

function failPhone(phone: WebSocket): void {
  phone.send(JSON.stringify({ v: 1, t: 'error', code: 'host_offline' }), () => phone.close(1000));
}
