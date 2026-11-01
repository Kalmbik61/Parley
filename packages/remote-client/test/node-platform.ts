// A `Platform` for Node (plan A17): in-memory key store, a WebSocket class passed in by the test (`ws`), real timers.
// remote-client itself depends on no WebSocket library; the test that needs a real one brings it.
import { randomBytes } from 'node:crypto';
import type { HostRecord, Platform, WebSocketLike } from '../src/index.js';

export interface NodePlatformOptions {
  /** The `ws` WebSocket class (or any constructor with the `WebSocketLike` shape). */
  WebSocket: new (url: string) => WebSocketLike;
  /** Rewrites the URL the client built: a relay on the loopback is `wss://` by the rules, the local test needs `ws://`. */
  rewriteUrl?: (url: string) => string;
  /** Off by default: a private relay address over `ws://` must not pass silently. Loopback needs no flag (it is `wss://` by the rules and `rewriteUrl` fixes the scheme). */
  allowLocalRelay?: boolean;
  /** Share one key store between several phones' hosts (second host on the same client). */
  records?: Map<string, HostRecord>;
}

export interface NodePlatform extends Platform {
  /** Sockets opened so far: an unchanged count proves "no reconnect". */
  readonly opened: () => number;
  readonly records: Map<string, HostRecord>;
}

const still = <T>(value: T) => ({ get: () => value, subscribe: () => () => undefined });

export function nodePlatform(options: NodePlatformOptions): NodePlatform {
  const records = options.records ?? new Map<string, HostRecord>();
  let opened = 0;
  return {
    records,
    opened: () => opened,
    keyStore: {
      list: async () => [...records.values()],
      put: async (r) => void records.set(r.hostId, r),
      remove: async (id) => void records.delete(id),
    },
    openSocket: (url) => {
      opened++;
      return new options.WebSocket(options.rewriteUrl ? options.rewriteUrl(url) : url);
    },
    random: (n) => new Uint8Array(randomBytes(n)),
    appState: still('active' as const),
    network: still({ online: true, kind: 'wifi' }),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as never),
    allowLocalRelay: options.allowLocalRelay ?? false,
  };
}
