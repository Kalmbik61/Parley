// The lock cover as a hook, for sheets that open by themselves (a finished run): they wait for the unlock instead of
// opening over the cover (critic A41b M1; LockGate: "nothing is opened under the cover").
import { useSyncExternalStore } from 'react';
import { DEMO, DEV_LOCK_MS } from '../dev/flags';
import { appLock } from './lock-instance';

const none = (): (() => void) => () => undefined;

export function useCovered(): boolean {
  return useSyncExternalStore(
    (cb) => appLock()?.subscribe(cb) ?? none(),
    () => {
      // The demo build without a lock draws no cover (LockGate); otherwise no lock yet means "not read yet": covered.
      const lock = appLock();
      return lock === null ? !(DEMO && DEV_LOCK_MS === null) : lock.covered();
    },
    () => true,
  );
}
