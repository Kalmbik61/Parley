// Face ID on a single destructive action (spec §11.4, plan A41b): archiving or deleting a room from the phone. Not the app
// lock: the "Lock Parley with Face ID" setting does not matter here, the question is asked every time. Device passcode is
// the fallback; a phone with neither Face ID nor a passcode cannot confirm, so the action is not offered to the host.

/** The slice of `expo-local-authentication` used here. */
export interface OwnerAuth {
  /** `SecurityLevel`: 0 — nothing is set up on the device. */
  getEnrolledLevelAsync(): Promise<number>;
  authenticateAsync(options: { promptMessage: string; disableDeviceFallback: boolean }): Promise<{ success: true } | { success: false; error: string }>;
}

export type OwnerConfirm = 'ok' | 'cancelled' | 'unavailable';

const NOT_SET_UP = new Set(['passcode_not_set', 'not_available', 'not_enrolled']);

export async function confirmWithOwner(auth: OwnerAuth, promptMessage: string): Promise<OwnerConfirm> {
  try {
    if ((await auth.getEnrolledLevelAsync()) === 0) return 'unavailable';
    const res = await auth.authenticateAsync({ promptMessage, disableDeviceFallback: false });
    if (res.success) return 'ok';
    return NOT_SET_UP.has(res.error) ? 'unavailable' : 'cancelled';
  } catch {
    return 'cancelled';
  }
}
