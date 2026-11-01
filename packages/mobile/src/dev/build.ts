import Constants from 'expo-constants';

/**
 * A developer build of the app: Debug (`__DEV__`), or the Release configuration of the `dev` variant built for an iPhone
 * run (`APP_VARIANT=dev`, `scripts/device-run.sh`), which carries `extra.devBuild`. The `release` variant never sets the flag,
 * so it keeps refusing `ws://` and has no Bench screen.
 */
export const DEV_BUILD = __DEV__ || Constants.expoConfig?.extra?.devBuild === true;
