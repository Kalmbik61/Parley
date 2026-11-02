import { describe, expect, it, vi } from 'vitest';
import { createAppLock, LOCK_AFTER_MS, shouldCover, type LocalAuth, type LockClock } from './app-lock';

const auth = (ok: boolean, error = 'user_cancel') => ({
  authenticateAsync: vi.fn<LocalAuth['authenticateAsync']>(async () => (ok ? { success: true } : { success: false, error })),
});

/** A clock the test moves: `mono` only forward, `wall` any way. */
const clockAt = (): LockClock & { forward(ms: number): void; setWall(ms: number): void; sleep(ms: number): void } => {
  let m = 1_000;
  let w = 1_700_000_000_000;
  return {
    mono: () => m,
    wall: () => w,
    forward(ms) {
      m += ms;
      w += ms;
    },
    // The phone sleeps: the monotonic clock stands still, the wall clock goes on.
    sleep(ms) {
      w += ms;
    },
    setWall(ms) {
      w = ms;
    },
  };
};
const make = (enabled = true, ok = true) => {
  const clock = clockAt();
  const a = auth(ok);
  return { clock, a, lock: createAppLock({ auth: a, enabled, clock }) };
};

describe('app lock', () => {
  it('a cold start is locked and covered; Face ID unlocks', async () => {
    const a = auth(true);
    const lock = createAppLock({ auth: a, enabled: true });
    expect(lock.state()).toBe('locked');
    expect(lock.covered()).toBe(true);
    expect(await lock.unlock()).toBe('ok');
    expect(lock.state()).toBe('unlocked');
    expect(lock.covered()).toBe(false);
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(a.authenticateAsync.mock.calls[0]![0].disableDeviceFallback).toBe(false);
  });

  it('a failed or cancelled Face ID keeps it locked; no passcode says so', async () => {
    const cancelled = createAppLock({ auth: auth(false), enabled: true });
    expect(await cancelled.unlock()).toBe('cancelled');
    expect(cancelled.state()).toBe('locked');
    const none = createAppLock({ auth: auth(false, 'passcode_not_set'), enabled: true });
    expect(await none.unlock()).toBe('no-passcode');
    expect(none.state()).toBe('locked');
  });

  it('inside the window nothing is asked; after more than five minutes in the background it locks', async () => {
    const { clock, lock } = make();
    await lock.unlock();
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS);
    lock.onForeground();
    expect(lock.state()).toBe('unlocked');
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS + 1);
    lock.onForeground();
    expect(lock.state()).toBe('locked');
    expect(lock.covered()).toBe(true);
  });

  it('a second background event does not move the start of the trip', async () => {
    const { clock, lock } = make();
    await lock.unlock();
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS);
    lock.onBackground(); // inactive → background
    clock.forward(1);
    lock.onForeground();
    expect(lock.state()).toBe('locked');
  });

  it('one prompt at a time', async () => {
    const a = auth(true);
    const lock = createAppLock({ auth: a, enabled: true });
    await Promise.all([lock.unlock(), lock.unlock()]);
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it('switched off: open, never locks; switched on locks at the next long trip, not at once', async () => {
    const { clock, a, lock } = make(false);
    expect(lock.state()).toBe('unlocked');
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS * 3);
    lock.onForeground();
    lock.tick();
    expect(lock.state()).toBe('unlocked');
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    lock.setEnabled(true);
    expect(lock.state()).toBe('unlocked');
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS + 1);
    lock.onForeground();
    expect(lock.state()).toBe('locked');
    lock.setEnabled(false);
    expect(lock.state()).toBe('unlocked');
  });

  it('notifies subscribers on every change', async () => {
    const lock = createAppLock({ auth: auth(true), enabled: true });
    const seen: string[] = [];
    lock.subscribe(() => seen.push(lock.state()));
    await lock.unlock();
    expect(seen).toEqual(['unlocking', 'unlocked']);
  });
});

describe('the cover (R1)', () => {
  it('covers while locked, before the setting is read, and away from the foreground with the lock on', async () => {
    expect(shouldCover(null, true)).toBe(true);
    const lock = createAppLock({ auth: auth(true), enabled: true });
    expect(shouldCover(lock, true)).toBe(true); // locked
    await lock.unlock();
    expect(shouldCover(lock, true)).toBe(false);
    expect(shouldCover(lock, false)).toBe(true); // inactive or background: no data in the app switcher
  });
  it('with the lock off nothing is covered', () => {
    const lock = createAppLock({ auth: auth(true), enabled: false });
    expect(shouldCover(lock, true)).toBe(false);
    expect(shouldCover(lock, false)).toBe(false);
  });
});

describe('idle re-lock and the clocks (A34)', () => {
  it('five minutes without a touch on screen lock it; a touch starts the term again', async () => {
    const { clock, lock } = make();
    await lock.unlock();
    clock.forward(LOCK_AFTER_MS - 1000);
    lock.touch();
    clock.forward(LOCK_AFTER_MS - 1000);
    lock.tick();
    expect(lock.state()).toBe('unlocked');
    clock.forward(2000);
    lock.tick();
    expect(lock.state()).toBe('locked');
    expect(lock.covered()).toBe(true);
  });

  it('the idle term does not run in the background (the trip has its own), and not while locked or switched off', async () => {
    const { clock, lock } = make();
    await lock.unlock();
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS * 2);
    lock.tick();
    expect(lock.state()).toBe('unlocked');
    const off = make(false);
    off.clock.forward(LOCK_AFTER_MS * 2);
    off.lock.tick();
    expect(off.lock.state()).toBe('unlocked');
  });

  it('an unlock starts the idle term', async () => {
    const { clock, lock } = make();
    clock.forward(LOCK_AFTER_MS * 3);
    await lock.unlock();
    lock.tick();
    expect(lock.state()).toBe('unlocked');
  });

  it('a wall clock moved back locks — idle and trip — and a small wobble does not', async () => {
    const idle = make();
    await idle.lock.unlock();
    idle.clock.forward(1000);
    idle.clock.setWall(idle.clock.wall() - 60_000);
    idle.lock.tick();
    expect(idle.lock.state()).toBe('locked');

    const trip = make();
    await trip.lock.unlock();
    trip.lock.onBackground();
    trip.clock.forward(1000);
    trip.clock.setWall(trip.clock.wall() - 3_600_000);
    trip.lock.onForeground();
    expect(trip.lock.state()).toBe('locked');

    const wobble = make();
    await wobble.lock.unlock();
    wobble.clock.forward(5000);
    wobble.clock.setWall(wobble.clock.wall() - 5500);
    wobble.lock.tick();
    expect(wobble.lock.state()).toBe('unlocked');
  });

  it('the longer clock wins: a sleeping phone (monotonic stood still) still locks; setting the date forward locks too', async () => {
    const slept = make();
    await slept.lock.unlock();
    slept.lock.onBackground();
    slept.clock.sleep(LOCK_AFTER_MS + 1);
    slept.lock.onForeground();
    expect(slept.lock.state()).toBe('locked');

    const forward = make();
    await forward.lock.unlock();
    forward.clock.setWall(forward.clock.wall() + LOCK_AFTER_MS + 1);
    forward.lock.tick();
    expect(forward.lock.state()).toBe('locked');
  });

  it('moving the date back does not stretch a term that the monotonic clock has used up', async () => {
    const { clock, lock } = make();
    await lock.unlock();
    clock.forward(LOCK_AFTER_MS + 1);
    clock.setWall(clock.wall() - 10 * LOCK_AFTER_MS);
    lock.tick();
    expect(lock.state()).toBe('locked');
  });
});
