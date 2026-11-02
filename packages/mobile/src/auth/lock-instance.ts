// The app's single lock, on the real modules. Created by <LockGate> once the setting is read; Settings flips it.
import * as LocalAuthentication from 'expo-local-authentication';
import { createAppLock, type AppLock } from './app-lock';

let lock: AppLock | null = null;

export function startLock(enabled: boolean): AppLock {
  lock ??= createAppLock({ auth: LocalAuthentication, enabled });
  return lock;
}

/** `null` until the gate has read the setting. */
export const appLock = (): AppLock | null => lock;
