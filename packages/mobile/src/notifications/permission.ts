// Notification permission (D1 §6.6, §11.2). Whether push reaches this build is A16's call; `pushAvailable` is its hook.
import * as Notifications from 'expo-notifications';

import type { Permission } from './row';

export async function getPermission(): Promise<Permission> {
  const r = await Notifications.getPermissionsAsync();
  return r.granted ? 'granted' : r.canAskAgain ? 'undetermined' : 'denied';
}

/** The system prompt, shown by iOS only once in the life of the app. */
export async function requestPermission(): Promise<Permission> {
  const r = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
  return r.granted ? 'granted' : r.canAskAgain ? 'undetermined' : 'denied';
}

/** Stage A, Personal Team builds have no APNs token. A16 replaces this with the real check. */
export const pushAvailable = (): boolean => true;
