// The app's single runtime. Built from the real platform adapters; tests build `AppRuntime` with fakes.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { seedHostFromEnv } from '../dev/seed-host';
import { createPlatform } from '../platform';
import { LocalSettings } from '../settings/local-settings';
import { AppRuntime } from './runtime';

const version = Constants.expoConfig?.version ?? '0.0.0';
const devRelay = Constants.expoConfig?.extra?.devRelay;

let relayHost: () => string | null = () => null;

const platform = createPlatform({ allowLocalRelay: __DEV__, relayHost: () => relayHost() });

// The marker lives in the app's own storage, which iOS deletes with the app; the Keychain survives (spec §7.8).
const markerDir = new Directory(Paths.document);
const markerFile = new File(markerDir, 'parley-install-marker');

export const runtime = new AppRuntime({
  platform,
  marker: {
    exists: () => markerFile.exists,
    create: () => markerFile.create({ intermediates: true, overwrite: true }),
  },
  settings: new LocalSettings(SecureStore, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  client: { app: 'parley-mobile', version, platform: 'ios' },
  seedHost: __DEV__ && typeof devRelay === 'string' ? seedHostFromEnv(devRelay, platform.random) : null,
});
relayHost = () => runtime.relayHost;
