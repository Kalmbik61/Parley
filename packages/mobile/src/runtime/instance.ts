// The app's single runtime. Built from the real platform adapters; tests build `AppRuntime` with fakes.
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { registerPush } from '../push/register';
import { seedHostFromEnv } from '../dev/seed-host';
import { createPlatform } from '../platform';
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
  client: { app: 'parley-mobile', version, platform: 'ios' },
  registerPush: (call) => registerPush({ getToken: () => Notifications.getDevicePushTokenAsync(), call, env: __DEV__ ? 'sandbox' : 'production' }),
  seedHost: __DEV__ && typeof devRelay === 'string' ? seedHostFromEnv(devRelay, platform.random) : null,
});
relayHost = () => runtime.relayHost;

// A new APNs token goes to the bridge at once (spec §9.1).
try {
  Notifications.addPushTokenListener(() => runtime.registerPush());
} catch {
  // No push on this build.
}
