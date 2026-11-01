import type { NetworkState, Subscribable } from '@parley/remote-client';

/** The slice of `@react-native-community/netinfo` used here. */
export interface NetInfoStateLike {
  type: string;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}
export interface NetInfoLike {
  fetch(): Promise<NetInfoStateLike>;
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

/**
 * Online when NetInfo says the device is connected and the internet is not known to be unreachable. When NetInfo
 * says "connected but no internet" (a Wi-Fi without internet is the normal case for a LAN dev relay), the relay
 * `/v1/health` probe decides. Until the first NetInfo answer the source reports online, so a cold start connects.
 */
export function createNetworkSource(
  netInfo: NetInfoLike,
  probe: () => Promise<boolean> | null,
): Subscribable<NetworkState> {
  let current: NetworkState = { online: true, kind: 'unknown' };
  const listeners = new Set<(v: NetworkState) => void>();
  let off: (() => void) | null = null;
  let seq = 0;

  const set = (next: NetworkState): void => {
    if (next.online === current.online && next.kind === current.kind) return;
    current = next;
    for (const l of [...listeners]) l(next);
  };

  const apply = (s: NetInfoStateLike): void => {
    const mine = ++seq;
    const kind = s.type;
    if (s.isConnected === false || s.type === 'none') return set({ online: false, kind });
    if (s.isInternetReachable !== false) return set({ online: true, kind });
    const p = probe();
    if (p === null) return set({ online: false, kind });
    void p.then((ok) => {
      if (mine === seq) set({ online: ok, kind });
    });
  };

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (off === null) {
        off = netInfo.addEventListener(apply);
        void netInfo.fetch().then(apply, () => undefined);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          off?.();
          off = null;
        }
      };
    },
  };
}
