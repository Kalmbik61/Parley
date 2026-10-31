import { describe, expect, it } from 'vitest';
import type { HostRecord, KeyStore, Platform } from '@parley/remote-client';
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
});
