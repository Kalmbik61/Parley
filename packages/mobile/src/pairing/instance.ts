import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { pair } from '@parley/remote-client';
import { haptic } from '../haptics';
import { runtime } from '../runtime/instance';
import { PairingSession } from './session';

const version = Constants.expoConfig?.version ?? '0.0.0';

export const pairing = new PairingSession({
  pair: (url, options) => pair(runtime.platform, runtime.hostStore, url, options),
  adopt: (record) => runtime.adoptPaired(record),
  now: () => Date.now(),
  haptic: { sasShown: haptic.sasShown, paired: haptic.paired },
  app: `parley-mobile/${version}`,
  platformName: 'ios',
  allowLocalRelay: runtime.platform.allowLocalRelay,
});

export const defaultDeviceName = (): string => Device.deviceName ?? Device.modelName ?? 'iPhone';
