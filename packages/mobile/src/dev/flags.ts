import Constants from 'expo-constants';

/** Developer build with PARLEY_MOBILE_DEV_DEMO=1: made-up data, and decisions look possible (nothing is sent). */
export const DEMO = __DEV__ && Constants.expoConfig?.extra?.devDemo === true;
export const DEMO_ROUTE: unknown = Constants.expoConfig?.extra?.devRoute;
