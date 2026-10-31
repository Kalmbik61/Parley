import { describe, expect, it, vi } from 'vitest';
import { HostStore, type HostRecord, type KeyStore, type WebSocketLike } from '@parley/remote-client';
import { createAppStateSource } from './app-state';
import { wipeOnFirstRun } from './first-run';
import { healthUrl, probeRelay } from './health';
import { createKeyStore, INDEX_KEY, type SecureStoreLike } from './key-store';
import { createNetworkSource, type NetInfoStateLike } from './network';
import { createOpenSocket } from './socket';

const record = (hostId: string): HostRecord =>
  ({ hostId, hostName: 'Mac', relay: 'relay.example.com', lastTs: 0 }) as unknown as HostRecord;

function memorySecureStore(): SecureStoreLike & { data: Map<string, string>; options: object[] } {
  const data = new Map<string, string>();
  const options: object[] = [];
  return {
    data,
    options,
    getItemAsync: async (k, o) => (o && options.push(o), data.get(k) ?? null),
    setItemAsync: async (k, v, o) => void (o && options.push(o), data.set(k, v)),
    deleteItemAsync: async (k) => void data.delete(k),
  };
}

describe('key store', () => {
  it('stores one record per host with the Keychain options and an id index', async () => {
    const secure = memorySecureStore();
    const opts = { keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' };
    const store = createKeyStore(secure, opts);
    await store.put(record('h1'));
    await store.put(record('h2'));
    await store.put({ ...record('h1'), lastTs: 5 });
    expect((await store.list()).map((r) => [r.hostId, r.lastTs])).toEqual([['h1', 5], ['h2', 0]]);
    expect(JSON.parse(secure.data.get(INDEX_KEY)!)).toEqual(['h1', 'h2']);
    expect(secure.options.every((o) => o === opts)).toBe(true);
    await store.remove('h1');
    expect((await store.list()).map((r) => r.hostId)).toEqual(['h2']);
    expect(secure.data.has('parley.host.h1')).toBe(false);
  });

  it('lists an unreadable record by id so wipeAll removes it', async () => {
    const secure = memorySecureStore();
    const keys = createKeyStore(secure, {});
    await keys.put(record('h1'));
    secure.data.set('parley.host.h1', '{not json');
    await new HostStore(keys).wipeAll();
    expect(secure.data.has('parley.host.h1')).toBe(false);
    expect(await keys.list()).toEqual([]);
  });

  it('refuses a host id the Keychain cannot hold', async () => {
    await expect(createKeyStore(memorySecureStore(), {}).put(record('bad id/'))).rejects.toThrow();
  });
});

describe('openSocket', () => {
  const make = (allowLocal: boolean) => {
    const ctor = vi.fn(function (this: unknown) {
      return {} as WebSocketLike;
    });
    return { ctor, open: createOpenSocket(ctor as never, allowLocal) };
  };

  it('with __DEV__ = false a private relay is rejected before any socket opens', () => {
    const { ctor, open } = make(false);
    expect(() => open('ws://192.168.1.5:8787')).toThrow(/not allowed/);
    expect(() => open('ws://192.168.1.5:8787/v1/connect')).toThrow(/not allowed/);
    expect(() => open('ws://mac.local:8787')).toThrow(/not allowed/);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('a developer build opens ws:// only to a private address', () => {
    const { ctor, open } = make(true);
    open('ws://192.168.1.5:8787');
    expect(ctor).toHaveBeenCalledWith('ws://192.168.1.5:8787');
    expect(() => open('ws://relay.example.com')).toThrow(/not allowed/);
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('wss:// opens in both builds; other shapes are refused', () => {
    for (const allow of [false, true]) {
      const { ctor, open } = make(allow);
      open('wss://relay.example.com');
      expect(ctor).toHaveBeenCalledTimes(1);
      expect(() => open('http://relay.example.com')).toThrow();
      open('wss://relay.example.com/v1/connect');
      expect(ctor).toHaveBeenCalledTimes(2);
      expect(() => open('wss://relay.example.com?x=1')).toThrow();
    }
  });
});

describe('relay health probe', () => {
  it('builds http(s) URLs through relayUrlFor, so a release build never probes a private address', () => {
    expect(healthUrl('relay.example.com', false)).toBe('https://relay.example.com/v1/health');
    expect(healthUrl('192.168.1.5:8787', true)).toBe('http://192.168.1.5:8787/v1/health');
    expect(() => healthUrl('192.168.1.5:8787', false)).toThrow();
  });

  it('is true only for an ok answer, and never rejects', async () => {
    expect(await probeRelay(async () => ({ ok: true }), 'relay.example.com', false)).toBe(true);
    expect(await probeRelay(async () => ({ ok: false }), 'relay.example.com', false)).toBe(false);
    expect(
      await probeRelay(
        () => {
          throw new Error('x');
        },
        'relay.example.com',
        false,
      ),
    ).toBe(false);
    expect(await probeRelay(async () => ({ ok: true }), '192.168.1.5:8787', false)).toBe(false);
  });

  it('aborts after the timeout', async () => {
    const res = await probeRelay(
      (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('abort')))),
      'relay.example.com',
      false,
      10,
    );
    expect(res).toBe(false);
  });
});

describe('app state source', () => {
  it('maps inactive to no change and notifies on active/background', () => {
    let handler: (s: string) => void = () => undefined;
    const remove = vi.fn();
    const source = createAppStateSource({
      currentState: 'active',
      addEventListener: (_t, l) => ((handler = l), { remove }),
    });
    const seen: string[] = [];
    const off = source.subscribe((v) => seen.push(v));
    handler('inactive');
    handler('background');
    handler('background');
    handler('inactive');
    handler('active');
    expect(seen).toEqual(['background', 'active']);
    expect(source.get()).toBe('active');
    off();
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe('network source', () => {
  const setup = (probe: () => Promise<boolean> | null) => {
    let push: (s: NetInfoStateLike) => void = () => undefined;
    const source = createNetworkSource(
      {
        fetch: async () => ({ type: 'wifi', isConnected: true, isInternetReachable: true }),
        addEventListener: (l) => ((push = l), () => undefined),
      },
      probe,
    );
    const seen: Array<[boolean, string]> = [];
    source.subscribe((v) => seen.push([v.online, v.kind]));
    return { push: (s: NetInfoStateLike) => push(s), seen, source };
  };

  it('is offline when disconnected; online again with the new kind', () => {
    const { push, seen } = setup(() => null);
    push({ type: 'none', isConnected: false, isInternetReachable: false });
    push({ type: 'cellular', isConnected: true, isInternetReachable: true });
    expect(seen).toEqual([[false, 'none'], [true, 'cellular']]);
  });

  it('connected without internet: the relay probe decides (LAN dev relay)', async () => {
    const { push, seen } = setup(() => Promise.resolve(true));
    push({ type: 'wifi', isConnected: true, isInternetReachable: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([[true, 'wifi']]);
  });

  it('connected without internet and no probe target: offline', () => {
    const { push, seen } = setup(() => null);
    push({ type: 'wifi', isConnected: true, isInternetReachable: false });
    expect(seen).toEqual([[false, 'wifi']]);
  });
});

describe('first-run wipe', () => {
  it('wipes once and sets the marker; a later start does nothing', async () => {
    const keyStore: KeyStore = { list: async () => [record('h1')], put: async () => undefined, remove: async () => undefined };
    const hosts = new HostStore(keyStore);
    const wipeAll = vi.spyOn(hosts, 'wipeAll');
    let marked = false;
    const marker = {
      exists: () => marked,
      create: () => {
        marked = true;
      },
    };
    expect(await wipeOnFirstRun(hosts, marker)).toBe(true);
    expect(await wipeOnFirstRun(hosts, marker)).toBe(false);
    expect(wipeAll).toHaveBeenCalledTimes(1);
    expect(marked).toBe(true);
  });

  it('does not set the marker when the wipe fails, so the next start retries', async () => {
    let marked = false;
    const hosts = { wipeAll: () => Promise.reject(new Error('keychain')) };
    await expect(
      wipeOnFirstRun(hosts, { exists: () => marked, create: () => void (marked = true) }),
    ).rejects.toThrow();
    expect(marked).toBe(false);
  });
});
