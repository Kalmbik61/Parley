// App lock (decision 6 as of 2026-11-01, spec §11.4, plan A33): Face ID when the app opens and after more than five
// minutes in the background — and nothing on single actions. A guard against someone else's hands on an unlocked phone,
// not an access boundary: the bridge and the Mac never see it. Pure state machine; the screen only draws it.

export const LOCK_AFTER_MS = 5 * 60 * 1000;

/** The slice of `expo-local-authentication` used here. */
export interface LocalAuth {
  authenticateAsync(options: {
    promptMessage: string;
    disableDeviceFallback: boolean;
    cancelLabel?: string;
  }): Promise<{ success: true } | { success: false; error: string }>;
}

export type LockState = 'locked' | 'unlocking' | 'unlocked';
export type UnlockResult = 'ok' | 'cancelled' | 'no-passcode';

export interface AppLock {
  state(): LockState;
  /** Locked, or about to ask: the data must not be on screen. */
  covered(): boolean;
  /** The "Lock Parley with Face ID" switch. */
  enabled(): boolean;
  /** The app came to the foreground at `now`, after `backgroundedAt` (null — it never left). */
  onForeground(now: number): void;
  /** The app left the foreground (home, app switcher, device lock). */
  onBackground(now: number): void;
  /** Ask Face ID (or the device passcode when Face ID is not set up). Resolves with what happened. */
  unlock(): Promise<UnlockResult>;
  /** The "Lock Parley with Face ID" switch changed. Off opens the app; on locks only after the next background trip. */
  setEnabled(enabled: boolean): void;
  subscribe(listener: () => void): () => void;
}

export interface AppLockDeps {
  auth: LocalAuth;
  /** The setting at start: on by default. */
  enabled: boolean;
  thresholdMs?: number;
}

export function createAppLock({ auth, enabled: initial, thresholdMs = LOCK_AFTER_MS }: AppLockDeps): AppLock {
  let enabled = initial;
  // A cold start is a relaunch: locked until Face ID says yes.
  let state: LockState = enabled ? 'locked' : 'unlocked';
  let leftAt: number | null = null;
  let asking: Promise<UnlockResult> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: LockState): void => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  return {
    state: () => state,
    covered: () => state !== 'unlocked',
    enabled: () => enabled,
    onBackground(now) {
      if (leftAt === null) leftAt = now;
    },
    onForeground(now) {
      const left = leftAt;
      leftAt = null;
      if (!enabled || state !== 'unlocked' || left === null) return;
      if (now - left > thresholdMs) set('locked');
    },
    unlock() {
      if (!enabled) {
        set('unlocked');
        return Promise.resolve('ok');
      }
      // One prompt at a time: the foreground event and the Unlock button must not stack two.
      if (asking !== null) return asking;
      set('unlocking');
      asking = (async (): Promise<UnlockResult> => {
        try {
          const res = await auth.authenticateAsync({ promptMessage: 'Unlock Parley', disableDeviceFallback: false });
          if (res.success) {
            set('unlocked');
            return 'ok';
          }
          set('locked');
          return res.error === 'passcode_not_set' || res.error === 'not_available' ? 'no-passcode' : 'cancelled';
        } catch {
          set('locked');
          return 'cancelled';
        } finally {
          asking = null;
        }
      })();
      return asking;
    },
    setEnabled(next) {
      enabled = next;
      if (!next) set('unlocked');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
