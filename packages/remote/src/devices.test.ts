// Critic m13: devices.json has one writer and a serialized write queue; a deferred lastTs write must never bring
// a revoked device back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore, type DeviceRecord } from './devices.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let dir: string;
let file: string;

const record = (n: number): DeviceRecord => ({
  deviceId: `device${n}`.padEnd(22, 'A').slice(0, 22),
  dsPub: 'B'.repeat(42) + String.fromCharCode(65 + n),
  name: `Phone ${n}`,
  platform: 'ios',
  pairedAt: 1,
  lastSeen: null,
  lastTs: 0,
  relayTokenHash: 'C'.repeat(43),
  state: 'active',
});
const onDisk = (): string[] =>
  (JSON.parse(readFileSync(file, 'utf8')) as { devices: DeviceRecord[] }).devices.map(
    (d) => d.deviceId,
  );

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'parley-devices-'));
  file = path.join(dir, 'devices.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DeviceStore writes', () => {
  it('a deferred lastTs write after a revoke does not resurrect the device', async () => {
    const store = await DeviceStore.load(file, { lazyWriteMs: 30 });
    const a = record(1);
    await store.add(a);
    store.noteConnect(a.deviceId, 5, 10); // schedules the lazy write
    expect(store.invalidate(a.deviceId)).toBe(true);
    await store.persist();
    await sleep(80); // the lazy timer fires after the revoke
    expect(onDisk()).toEqual([]);
    expect((await DeviceStore.load(file)).get(a.deviceId)).toBeUndefined();
    store.noteConnect(a.deviceId, 6, 11); // a late note for a revoked device is a no-op
    await store.flush();
    expect(onDisk()).toEqual([]);
  });

  it('a write in flight when the revoke happens is followed by the revoke write', async () => {
    const store = await DeviceStore.load(file, { lazyWriteMs: 10_000 });
    const a = record(1);
    const b = record(2);
    await store.add(a);
    await store.add(b);
    store.noteConnect(a.deviceId, 7, 12);
    const inFlight = store.flush();
    await new Promise((r) => setImmediate(r)); // that write has serialized memory (A included) and is on disk I/O
    store.invalidate(a.deviceId);
    const revoke = store.persist();
    await Promise.all([inFlight, revoke]);
    expect(onDisk()).toEqual([b.deviceId]);
  });

  it('interleaved changes end with the file equal to memory', async () => {
    const store = await DeviceStore.load(file, { lazyWriteMs: 5 });
    const writes: Promise<unknown>[] = [];
    for (let n = 0; n < 5; n++) writes.push(store.add(record(n)));
    for (let n = 0; n < 5; n++) store.noteConnect(record(n).deviceId, 100 + n, 1);
    store.invalidate(record(1).deviceId);
    store.invalidate(record(3).deviceId);
    writes.push(store.persist(), store.activate(record(4).deviceId));
    await Promise.all(writes);
    await sleep(30);
    await store.flush();
    expect(onDisk().sort()).toEqual(
      store
        .list()
        .map((d) => d.deviceId)
        .sort(),
    );
    expect(onDisk()).toHaveLength(3);
    const reloaded = await DeviceStore.load(file);
    expect(reloaded.get(record(0).deviceId)?.lastTs).toBe(100);
  });
});
