// App lock (decision 6 as of 2026-11-01, spec §11.4, plans A33 and A34): Face ID when the app opens, after more than five
// minutes in the background, and after five minutes without a touch while Parley is on screen — and nothing on single
// actions. A guard against someone else's hands on an unlocked phone, not an access boundary: the bridge and the Mac never
// see it. Pure state machine; the screen only draws it.
//
// Time. Every term is measured on two clocks: a monotonic one (the person cannot move it) and the wall clock. The longer of
// the two decides — the monotonic clock may stand still while the phone sleeps, the wall clock may be set by hand — and a
// wall clock that went BACKWARDS counts as expired: setting the date back must not extend the window.

export const LOCK_AFTER_MS = 5 * 60 * 1000;
/** A wall clock this much behind the stamp (network time sync wobbles by less) counts as "moved backwards". */
export const CLOCK_BACK_TOLERANCE_MS = 1000;

/** The slice of `expo-local-authentication` used here. */
export interface LocalAuth {
  authenticateAsync(options: {
    promptMessage: string;
    disableDeviceFallback: boolean;
    cancelLabel?: string;
  }): Promise<{ success: true } | { success: false; error: string }>;
}

export interface LockClock {
  /** Milliseconds from a fixed point that only moves forward (`performance.now()`). */
  mono(): number;
  /** Milliseconds since the epoch (`Date.now()`); the person can change it. */
  wall(): number;
}

export const systemClock: LockClock = { mono: () => performance.now(), wall: () => Date.now() };

interface Stamp {
  m: number;
  w: number;
}

export type LockState = 'locked' | 'unlocking' | 'unlocked';
export type UnlockResult = 'ok' | 'cancelled' | 'no-passcode';

export interface AppLock {
  state(): LockState;
  /** Locked, or about to ask: the data must not be on screen. */
  covered(): boolean;
  /** The "Lock Parley with Face ID" switch. */
  enabled(): boolean;
  /** The app came back to the foreground. Locks when it was away for too long (or the clock went back). */
  onForeground(): void;
  /** The app left the foreground (home, app switcher, device lock). */
  onBackground(): void;
  /** A finger touched the screen: the idle term starts again. Cheap; call it on every touch. */
  touch(): void;
  /** Called every few seconds while on screen: locks after five minutes without a touch. */
  tick(): void;
  /** Ask Face ID (or the device passcode when Face ID is not set up). Resolves with what happened. */
  unlock(): Promise<UnlockResult>;
  /** The "Lock Parley with Face ID" switch changed. Off opens the app; on locks only after the next long trip or idle. */
  setEnabled(enabled: boolean): void;
  subscribe(listener: () => void): () => void;
}

export interface AppLockDeps {
  auth: LocalAuth;
  /** The setting at start: on by default. */
  enabled: boolean;
  thresholdMs?: number;
  clock?: LockClock;
}

export function createAppLock({ auth, enabled: initial, thresholdMs = LOCK_AFTER_MS, clock = systemClock }: AppLockDeps): AppLock {
  let enabled = initial;
  // A cold start is a relaunch: locked until Face ID says yes.
  let state: LockState = enabled ? 'locked' : 'unlocked';
  const stamp = (): Stamp => ({ m: clock.mono(), w: clock.wall() });
  let lastTouch: Stamp = stamp();
  /** Set while the app is away from the foreground. */
  let leftAt: Stamp | null = null;
  let asking: Promise<UnlockResult> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: LockState): void => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  /** More than the threshold since `since` on either clock, or the wall clock went back. */
  const expired = (since: Stamp): boolean => {
    const dm = clock.mono() - since.m;
    const dw = clock.wall() - since.w;
    return dw < -CLOCK_BACK_TOLERANCE_MS || dm > thresholdMs || dw > thresholdMs;
  };

  return {
    state: () => state,
    covered: () => state !== 'unlocked',
    enabled: () => enabled,
    touch() {
      lastTouch = stamp();
    },
    tick() {
      if (!enabled || state !== 'unlocked' || leftAt !== null) return;
      if (expired(lastTouch)) set('locked');
    },
    onBackground() {
      leftAt ??= stamp();
    },
    onForeground() {
      const left = leftAt;
      leftAt = null;
      if (left !== null && enabled && state === 'unlocked' && expired(left)) set('locked');
      else lastTouch = stamp();
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
            lastTouch = stamp();
            leftAt = null;
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
      else lastTouch = stamp();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Whether the lock screen covers the app: locked, still reading the setting, or away from the foreground with the lock on
 * (`inactive` and `background` both: the app-switcher snapshot is taken as the app leaves the foreground).
 *
 * No paired Mac — no lock (spec §11.4, critic s-220 m1): with `hosts === 0` there is nothing to protect, and pairing must
 * stay usable (also on a phone without a passcode). `hosts === null` — the list is not read yet: covered as locked.
 */
export const shouldCover = (lock: AppLock | null, active: boolean, hosts: number | null): boolean =>
  hosts !== 0 && (lock === null || lock.covered() || (!active && lock.enabled()));
