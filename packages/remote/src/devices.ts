import { z } from 'zod';
import { b64urlEncode, deviceIdSchema, hashSchema } from '@parley/protocol/remote';
import { readJsonFile, writeJsonAtomic } from './files.js';
import type { DevicePush } from './session-contract.js';

/** One paired phone (spec §5.2). Public key and hashes only: no private keys, no tokens in clear. */
export interface DeviceRecord {
  deviceId: string;
  /** DS_pub, b64url. */
  dsPub: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number | null;
  /** Last accepted connection timestamp (spec §7.5); 0 before the first connection. */
  lastTs: number;
  relayTokenHash: string;
  /** `pending` from «Allow» until the phone confirms with `{t:'paired'}` (spec §7.4). */
  state: 'pending' | 'active';
  push?: DevicePush & { updatedAt: number };
}

const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceSchema = z.strictObject({
  deviceId: deviceIdSchema,
  dsPub: key32,
  name: z.string().min(1).max(64),
  platform: z.string().min(1).max(32),
  pairedAt: z.number().int().nonnegative(),
  lastSeen: z.number().int().nonnegative().nullable(),
  lastTs: z.number().int().nonnegative(),
  relayTokenHash: hashSchema,
  state: z.enum(['pending', 'active']),
  push: z
    .strictObject({
      apnsToken: z.string().min(1).max(200),
      env: z.enum(['sandbox', 'production']),
      updatedAt: z.number().int().nonnegative(),
    })
    .optional(),
});
const devicesFile = z.strictObject({ v: z.literal(1), devices: z.array(deviceSchema).max(64) });

export const MAX_DEVICES = 5;
const LAZY_WRITE_MS = 5_000;

/**
 * devices.json, its only writer (spec §5.2). Memory is the truth for access decisions; every change that grants
 * or removes access is written atomically (`fsync`) before the caller goes on. `lastTs` and `lastSeen` are written
 * lazily: losing them on a crash is safe (a replayed msg1 still cannot finish a handshake, spec §7.5).
 *
 * Each device has an in-memory generation (`deviceGen`, spec §7.9). `invalidate` bumps it synchronously, so a
 * session bound to the old generation is dead before any await.
 */
export class DeviceStore {
  readonly #file: string;
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #gens = new Map<string, number>();
  #chain: Promise<void> = Promise.resolve();
  #lazy: NodeJS.Timeout | null = null;
  readonly #lazyMs: number;

  private constructor(file: string, lazyMs: number) {
    this.#file = file;
    this.#lazyMs = lazyMs;
  }

  static async load(file: string, options: { lazyWriteMs?: number } = {}): Promise<DeviceStore> {
    const store = new DeviceStore(file, options.lazyWriteMs ?? LAZY_WRITE_MS);
    const raw = await readJsonFile(file);
    if (raw !== undefined) {
      const parsed = devicesFile.safeParse(raw);
      if (!parsed.success) throw new Error('devices.json is invalid');
      for (const d of parsed.data.devices) {
        const { push, ...rest } = d;
        store.#devices.set(d.deviceId, push ? { ...rest, push } : rest);
      }
    }
    return store;
  }

  list(): DeviceRecord[] {
    return [...this.#devices.values()].map((d) => ({ ...d }));
  }

  get(deviceId: string): DeviceRecord | undefined {
    const d = this.#devices.get(deviceId);
    return d ? { ...d } : undefined;
  }

  get size(): number {
    return this.#devices.size;
  }

  /** The device whose static key is `dsPub` (any state). */
  byKey(dsPub: Uint8Array): DeviceRecord | undefined {
    const wanted = b64urlEncode(dsPub);
    for (const d of this.#devices.values()) if (d.dsPub === wanted) return { ...d };
    return undefined;
  }

  generation(deviceId: string): number {
    return this.#gens.get(deviceId) ?? 0;
  }

  /** Relay list: every known device, pending ones included (their token must work before `credentials`). */
  relayList(): { device: string; tokenHash: string }[] {
    return [...this.#devices.values()].map((d) => ({
      device: d.deviceId,
      tokenHash: d.relayTokenHash,
    }));
  }

  /**
   * Step 1 of revoke (spec §7.9), synchronous: the device is gone from memory and its generation grows.
   * Returns false for an unknown device.
   */
  invalidate(deviceId: string): boolean {
    this.#gens.set(deviceId, this.generation(deviceId) + 1);
    return this.#devices.delete(deviceId);
  }

  /** Reset, step 1: every device invalidated. */
  invalidateAll(): string[] {
    const ids = [...this.#devices.keys()];
    for (const id of ids) this.invalidate(id);
    return ids;
  }

  async add(record: DeviceRecord): Promise<void> {
    if (this.#devices.has(record.deviceId)) throw new Error('device exists');
    this.#devices.set(record.deviceId, { ...record });
    await this.persist();
  }

  async activate(deviceId: string): Promise<boolean> {
    const d = this.#devices.get(deviceId);
    if (!d) return false;
    d.state = 'active';
    await this.persist();
    return true;
  }

  /** Accepted connection: lastTs and lastSeen in memory now, on disk later. */
  noteConnect(deviceId: string, ts: number, at: number): void {
    const d = this.#devices.get(deviceId);
    if (!d) return;
    d.lastTs = ts;
    d.lastSeen = at;
    this.#scheduleLazy();
  }

  async setPush(deviceId: string, push: DevicePush | null, at: number): Promise<boolean> {
    const d = this.#devices.get(deviceId);
    if (!d) return false;
    if (push) d.push = { apnsToken: push.apnsToken, env: push.env, updatedAt: at };
    else delete d.push;
    await this.persist();
    return true;
  }

  /** Writes the current memory state; writes are serialized and each one carries the latest state. */
  persist(): Promise<void> {
    const run = this.#chain.then(() => this.#write());
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Flushes a pending lazy write (shutdown, tests). */
  async flush(): Promise<void> {
    if (this.#lazy) {
      clearTimeout(this.#lazy);
      this.#lazy = null;
      await this.persist();
    }
    await this.#chain;
  }

  #scheduleLazy(): void {
    if (this.#lazy) return;
    this.#lazy = setTimeout(() => {
      this.#lazy = null;
      this.persist().catch(() => {});
    }, this.#lazyMs);
    this.#lazy.unref();
  }

  async #write(): Promise<void> {
    await writeJsonAtomic(this.#file, { v: 1, devices: [...this.#devices.values()] });
  }
}
