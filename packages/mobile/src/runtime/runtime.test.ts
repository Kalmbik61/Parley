import { describe, expect, it } from 'vitest';
import type { HostRecord, KeyStore, Platform } from '@parley/remote-client';
import { withSeedHost } from '../dev/seed-host';
import { AppRuntime } from './runtime';

describe('AppRuntime.start', () => {
  it('wipes old records on the first run (before listing), once, then reports ready with no host', async () => {
    const calls: string[] = [];
    const records = new Map<string, HostRecord>([['old', { hostId: 'old' } as HostRecord]]);
    const keyStore: KeyStore = {
      list: async () => (calls.push('list'), [...records.values()]),
      put: async (r) => void records.set(r.hostId, r),
      remove: async (id) => (calls.push(`remove:${id}`), void records.delete(id)),
    };
    let marked = false;
    const rt = new AppRuntime({
      platform: { keyStore } as unknown as Platform,
      marker: { exists: () => marked, create: () => void (marked = true) },
      client: { app: 'parley-mobile', version: '0.1.0', platform: 'ios' },
    });
    await rt.start();
    await rt.start();
    expect(calls.slice(0, 2)).toEqual(['list', 'remove:old']);
    expect(records.size).toBe(0);
    expect(marked).toBe(true);
    expect(rt.getState()).toMatchObject({ phase: 'ready', host: null });
  });

  it('starts again after stop() (remounted root)', async () => {
    const keyStore: KeyStore = { list: async () => [], put: async () => undefined, remove: async () => undefined };
    let n = 0;
    const rt = new AppRuntime({
      platform: { keyStore } as unknown as Platform,
      marker: { exists: () => (n++, true), create: () => undefined },
      client: { app: 'parley-mobile', version: '0.1.0', platform: 'ios' },
    });
    await rt.start();
    rt.stop();
    await rt.start();
    expect(n).toBe(2);
  });
});

describe('withSeedHost', () => {
  const seed = { hostId: 'dev-seed', lastTs: 0 } as HostRecord;
  const real = { hostId: 'real', lastTs: 0 } as HostRecord;
  const memory = (initial: HostRecord[]) => {
    const records = new Map(initial.map((r) => [r.hostId, r]));
    const store: KeyStore = {
      list: async () => [...records.values()],
      put: async (r) => void records.set(r.hostId, r),
      remove: async (id) => void records.delete(id),
    };
    return { records, store };
  };

  it('lists the seed only while no real record exists, and never writes it to the real store', async () => {
    const { records, store } = memory([]);
    const keys = withSeedHost(store, seed);
    expect(await keys.list()).toEqual([seed]);
    await keys.put({ ...seed, lastTs: 7 });
    expect((await keys.list())[0]!.lastTs).toBe(7);
    expect(records.size).toBe(0);
    await keys.put(real);
    expect((await keys.list()).map((r) => r.hostId)).toEqual(['real']);
    await keys.remove('dev-seed');
    expect(records.has('dev-seed')).toBe(false);
  });
});
