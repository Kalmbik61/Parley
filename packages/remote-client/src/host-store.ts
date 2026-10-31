// Запись хоста на телефоне (спека §7.8) и монотонная метка подключения (§7.5).
import { z } from 'zod';
import { deviceIdSchema, relayTokenSchema, routeIdSchema } from '@parley/protocol/remote';
import type { KeyStore } from './platform.js';

const key32 = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Одна запись на хост, JSON в защищённом хранилище. Ключи — b64url. Имена спеки: `hsPub` = `HS_pub`,
 * `dsPriv`/`dsPub` = `DS_priv`/`DS_pub`, `relay` = `relayUrl`: хранится `host[:port]` из QR, схему подключение
 * выводит каждый раз через `relayUrlFor`, так что релизная сборка не пойдёт по `ws://` и со старой записью.
 */
export const hostRecordSchema = z.strictObject({
  hostId: z.string().min(1).max(64),
  hostName: z.string().max(256),
  hsPub: key32,
  relay: z.string().min(1).max(64),
  relays: z.array(z.string().min(1).max(64)).max(16),
  routeId: routeIdSchema,
  deviceId: deviceIdSchema,
  relayToken: relayTokenSchema,
  dsPriv: key32,
  dsPub: key32,
  /** Последняя метка `ts`, отправленная в msg1 подключения; 0 — ещё не подключались. */
  lastTs: z.number().int().nonnegative(),
  pairedAt: z.number().int().nonnegative(),
});
export type HostRecord = z.infer<typeof hostRecordSchema>;

/**
 * Обёртка над `KeyStore`: записи проверяются при чтении (битая запись пропускается, но не стирается), записи
 * идут строго по очереди — `nextTs` читает и пишет `lastTs` без гонок.
 */
export class HostStore {
  readonly #keyStore: KeyStore;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(keyStore: KeyStore) {
    this.#keyStore = keyStore;
  }

  async list(): Promise<HostRecord[]> {
    const raw = await this.#keyStore.list();
    const out: HostRecord[] = [];
    for (const r of raw) {
      const parsed = hostRecordSchema.safeParse(r);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async get(hostId: string): Promise<HostRecord | null> {
    return (await this.list()).find((r) => r.hostId === hostId) ?? null;
  }

  put(record: HostRecord): Promise<void> {
    const checked = hostRecordSchema.parse(record);
    return this.#serial(() => this.#keyStore.put(checked));
  }

  remove(hostId: string): Promise<void> {
    return this.#serial(() => this.#keyStore.remove(hostId));
  }

  /**
   * Метка для msg1 (§7.5): `max(now, lastTs + 1)`, сохранённая до возврата. Монотонна, даже если часы телефона
   * ушли назад. Нет записи — ошибка.
   */
  nextTs(hostId: string, now: number): Promise<number> {
    return this.#serial(async () => {
      const record = await this.get(hostId);
      if (record === null) throw new Error('host record not found');
      const ts = Math.max(Math.floor(now), record.lastTs + 1);
      await this.#keyStore.put({ ...record, lastTs: ts });
      return ts;
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** `ts` — 8 байт big-endian (payload msg1 подключения). */
export function encodeTs(ts: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(ts / 0x1_0000_0000));
  view.setUint32(4, ts >>> 0);
  return out;
}
