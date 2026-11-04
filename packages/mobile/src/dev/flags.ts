import Constants from 'expo-constants';

/** Developer build with PARLEY_MOBILE_DEV_DEMO=1: made-up data, and decisions look possible (nothing is sent). */
export const DEMO = __DEV__ && Constants.expoConfig?.extra?.devDemo === true;
export const DEMO_ROUTE: unknown = Constants.expoConfig?.extra?.devRoute;
/** Developer build, PARLEY_MOBILE_DEV_CONSENT=c-3: the demo shows only that consent card (screenshots). */
export const DEMO_CONSENT: unknown = Constants.expoConfig?.extra?.devConsent;
/**
 * Developer build with PARLEY_MOBILE_DEV_LOCK_MS=<ms>: the app lock locks after that much idle time instead of five
 * minutes, and stays on with demo data, so the lock can be looked at on a simulator (plan A35b). Never in release.
 */
const devLockMs: unknown = Constants.expoConfig?.extra?.devLockMs;
export const DEV_LOCK_MS: number | null = __DEV__ && typeof devLockMs === 'number' && devLockMs > 0 ? devLockMs : null;
/** Developer build with PARLEY_MOBILE_DEV_FOCUS=1: the main text field of a screen takes focus, so the keyboard is up in screenshots (plan A35e). */
export const DEV_FOCUS = __DEV__ && Constants.expoConfig?.extra?.devFocus === true;
/**
 * Developer build with PARLEY_MOBILE_DEV_VOICE=fake (or fake-off): the dictation engine is a fake one, so the microphone button
 * can be looked at on a simulator; fake-off has no recognition for any language (spec A47 §4.4). Never in release.
 */
const devVoice: unknown = Constants.expoConfig?.extra?.devVoice;
export const DEV_VOICE: 'fake' | 'fake-off' | null = __DEV__ && (devVoice === 'fake' || devVoice === 'fake-off') ? devVoice : null;
