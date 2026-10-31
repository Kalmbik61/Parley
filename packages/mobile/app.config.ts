import { withInfoPlist } from 'expo/config-plugins';
import type { ExpoConfig } from 'expo/config';

// APP_VARIANT=dev (default) carries NSAllowsLocalNetworking and the Local Network prompt text for the Mac's LAN
// relay, and PARLEY_MOBILE_DEV_RELAY=host:port seeds a host that points at it (src/dev/seed-host.ts).
// APP_VARIANT=release has none of that (spec §6.6): the release code also refuses ws:// (relayUrlFor, allowLocal=__DEV__).
const variant = process.env.APP_VARIANT ?? 'dev';
if (variant !== 'dev' && variant !== 'release') {
  throw new Error(`APP_VARIANT must be "dev" or "release", got "${variant}"`);
}
const dev = variant === 'dev';

// Prebuild adds the dev launcher's own NSAllowsLocalNetworking and Local Network text even without the
// `expo-dev-client` plugin listed, so the release variant removes them from the generated Info.plist.
const withoutLocalNetwork = (config: ExpoConfig) =>
  withInfoPlist(config, (modConfig) => {
    const plist = modConfig.modResults;
    delete plist.NSLocalNetworkUsageDescription;
    delete plist.NSBonjourServices;
    const ats = plist.NSAppTransportSecurity as Record<string, unknown> | undefined;
    if (ats) delete ats.NSAllowsLocalNetworking;
    return modConfig;
  });

const config: ExpoConfig = {
  name: 'Parley',
  slug: 'parley-mobile',
  version: '0.1.0',
  scheme: 'parley',
  extra: dev
    ? { devRelay: process.env.PARLEY_MOBILE_DEV_RELAY ?? null, devApprove: process.env.PARLEY_MOBILE_DEV_APPROVE === '1', devDemo: process.env.PARLEY_MOBILE_DEV_DEMO === '1', devRoute: process.env.PARLEY_MOBILE_DEV_ROUTE ?? null }
    : {},
  platforms: ['ios'],
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: process.env.PARLEY_MOBILE_BUNDLE_ID ?? 'dev.example.parley.mobile',
    supportsTablet: false,
    ...(dev && {
      infoPlist: {
        NSLocalNetworkUsageDescription: 'Parley connects to the dev relay on your Mac over the local network.',
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      },
    }),
  },
  plugins: [
    'expo-router',
    // The dev client plugin writes NSAllowsLocalNetworking and its own Local Network text, so dev only.
    ...(dev ? ['expo-dev-client'] : []),
    // Plan decision Р8: iOS 17+.
    ['expo-build-properties', { ios: { deploymentTarget: '17.0' } }],
    [
      'expo-camera',
      {
        cameraPermission: 'Parley uses the camera to scan the QR code that pairs this phone with your Mac.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    'expo-secure-store',
    [
      'expo-local-authentication',
      { faceIDPermission: 'Parley uses Face ID to confirm approvals.' },
    ],
    // Personal Team cannot provision Push Notifications; the aps-environment entitlement arrives with A24.
    ['expo-notifications', { enableRemoteNotifications: false }],
  ],
};

export default dev ? config : withoutLocalNetwork(config);
