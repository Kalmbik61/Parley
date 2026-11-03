// The app's single lock, on the real modules. Created by <LockGate> once the setting is read; Settings flips it.
import * as LocalAuthentication from 'expo-local-authentication';
import { DEV_LOCK_MS } from '../dev/flags';
import { confirmWithOwner, type OwnerConfirm } from './confirm-owner';
import { createAppLock, type AppLock } from './app-lock';
import { closeSheetsOnLock, createLockSheets, touchLock } from './lock-sheets';

let lock: AppLock | null = null;

/** Open sheets that close when the app locks (plan A35b). */
export const lockSheets = createLockSheets();

export function startLock(enabled: boolean): AppLock {
  if (lock === null) {
    lock = createAppLock({ auth: LocalAuthentication, enabled, ...(DEV_LOCK_MS === null ? {} : { thresholdMs: DEV_LOCK_MS }) });
    closeSheetsOnLock(lock, lockSheets);
  }
  return lock;
}

/** `null` until the gate has read the setting. */
export const appLock = (): AppLock | null => lock;

/** `onTouchStart` for the root view of a natively presented sheet: a touch there restarts the idle term too. */
export const touchAppLock = touchLock(appLock);

/** Face ID (or the device passcode) for one action: 'ok', 'cancelled' (nothing is sent) or 'unavailable' (nothing is set up). */
export const confirmByOwner = (promptMessage: string): Promise<OwnerConfirm> => confirmWithOwner(LocalAuthentication, promptMessage);
