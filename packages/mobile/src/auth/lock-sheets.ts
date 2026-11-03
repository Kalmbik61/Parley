// What the lock closes (critic s-199 N2, plan A35b). The lock screen is drawn above every presented screen, and on top of
// that every open sheet closes when the app locks: the New session/room screen, the Decision "Return for rework" sheet and
// the Team sheet. Each sheet registers how to close itself while it is open. The pairing flow does not register: it is
// the only way in when no Mac is paired, and the lock screen simply covers it until Face ID says yes.
//
// Only a real lock closes sheets: the app-switcher cover on `inactive`/`background` (critic R1) only covers them, so a
// short trip to another app does not throw a draft away.
import type { AppLock } from './app-lock';

export type CloseSheet = () => void;

export interface LockSheets {
  /** An open sheet: how to close it. Returns the unregister function (call it when the sheet closes or unmounts). */
  add(close: CloseSheet): () => void;
  /** Closes every registered sheet. */
  closeAll(): void;
  size(): number;
}

export function createLockSheets(): LockSheets {
  const open = new Set<CloseSheet>();
  return {
    add(close) {
      // A fresh wrapper: the same function registered twice is two sheets.
      const entry: CloseSheet = () => close();
      open.add(entry);
      return () => void open.delete(entry);
    },
    closeAll() {
      // A close may unregister (or register) while we walk: walk a copy, and drop what was closed.
      for (const entry of [...open]) {
        open.delete(entry);
        try {
          entry();
        } catch {
          // One sheet failing to close must not keep the others open.
        }
      }
    },
    size: () => open.size,
  };
}

/**
 * Closes every sheet when the lock goes from open to covered (locked, or asking Face ID). Returns the unsubscribe.
 */
export function closeSheetsOnLock(lock: Pick<AppLock, 'covered' | 'subscribe'>, sheets: LockSheets): () => void {
  let covered = lock.covered();
  return lock.subscribe(() => {
    const now = lock.covered();
    if (now && !covered) sheets.closeAll();
    covered = now;
  });
}

/**
 * For the root view of a sheet: a touch restarts the idle term. A sheet is presented natively above the app, so its
 * touches do not pass through the root view's `onTouchStart`.
 */
export const touchLock =
  (lock: () => Pick<AppLock, 'touch'> | null) =>
  (): void => {
    lock()?.touch();
  };
