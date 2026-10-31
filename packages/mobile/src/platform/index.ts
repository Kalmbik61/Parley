import { AppState as RNAppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { Platform } from '@parley/remote-client';
import { createAppStateSource } from './app-state';
import { probeRelay } from './health';
import { createKeyStore } from './key-store';
import { createNetworkSource } from './network';
import { createOpenSocket, type SocketConstructor } from './socket';

export interface PlatformOptions {
  /** Developer build: allows `ws://` to a private-address relay. In the app this is `__DEV__`. */
  allowLocalRelay: boolean;
  /** `host[:port]` of the relay to probe when NetInfo reports no internet; `null` — no host yet. */
  relayHost: () => string | null;
}

export function createPlatform({ allowLocalRelay, relayHost }: PlatformOptions): Platform {
  return {
    keyStore: createKeyStore(SecureStore, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
    openSocket: createOpenSocket(WebSocket as unknown as SocketConstructor, allowLocalRelay),
    random: (n) => Crypto.getRandomBytes(n),
    appState: createAppStateSource(RNAppState),
    network: createNetworkSource(NetInfo, () => {
      const host = relayHost();
      return host === null
        ? null
        : probeRelay((url, init) => fetch(url, init), host, allowLocalRelay);
    }),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    allowLocalRelay,
  };
}
