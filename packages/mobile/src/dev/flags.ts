import Constants from 'expo-constants';

/** Developer build with PARLEY_MOBILE_DEV_DEMO=1: made-up data, and decisions look possible (nothing is sent). */
export const DEMO = __DEV__ && Constants.expoConfig?.extra?.devDemo === true;
export const DEMO_ROUTE: unknown = Constants.expoConfig?.extra?.devRoute;
/** Developer build, PARLEY_MOBILE_DEV_CONSENT=c-3: the demo shows only that consent card (screenshots). */
export const DEMO_CONSENT: unknown = Constants.expoConfig?.extra?.devConsent;
