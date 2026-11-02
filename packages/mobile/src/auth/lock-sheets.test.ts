import { describe, expect, it, vi } from 'vitest';
import { createAppLock, LOCK_AFTER_MS, type LocalAuth, type LockClock } from './app-lock';
import { closeSheetsOnLock, createLockSheets, touchLock } from './lock-sheets';

const clockAt = (): LockClock & { forward(ms: number): void } => {
  let m = 1_000;
  let w = 1_700_000_000_000;
  return {
    mono: () => m,
    wall: () => w,
    forward(ms) {
      m += ms;
      w += ms;
    },
  };
};

/** An unlocked lock with its clock and a set of sheets watched by it. */
const unlocked = async () => {
  const clock = clockAt();
  const auth = { authenticateAsync: vi.fn<LocalAuth['authenticateAsync']>(async () => ({ success: true })) };
  const lock = createAppLock({ auth, enabled: true, clock });
  await lock.unlock();
  expect(lock.state()).toBe('unlocked');
  const sheets = createLockSheets();
  closeSheetsOnLock(lock, sheets);
  return { lock, clock, sheets };
};

describe('sheets close when the app locks (critic N2, plan A35b)', () => {
  it('idle lock closes every open sheet once; closed sheets are unregistered', async () => {
    const { lock, clock, sheets } = await unlocked();
    const decision = vi.fn();
    const team = vi.fn();
    const newScreen = vi.fn();
    sheets.add(decision);
    sheets.add(team);
    sheets.add(newScreen);
    clock.forward(LOCK_AFTER_MS + 1);
    lock.tick();
    expect(lock.state()).toBe('locked');
    for (const close of [decision, team, newScreen]) expect(close).toHaveBeenCalledTimes(1);
    expect(sheets.size()).toBe(0);
  });

  it('a long trip to the background locks on return and closes the sheets', async () => {
    const { lock, clock, sheets } = await unlocked();
    const close = vi.fn();
    sheets.add(close);
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS + 1);
    lock.onForeground();
    expect(lock.state()).toBe('locked');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a short trip to the background (the app-switcher cover) keeps the sheets open', async () => {
    const { lock, clock, sheets } = await unlocked();
    const close = vi.fn();
    sheets.add(close);
    lock.onBackground();
    clock.forward(LOCK_AFTER_MS - 1000);
    lock.onForeground();
    expect(lock.state()).toBe('unlocked');
    expect(close).not.toHaveBeenCalled();
    expect(sheets.size()).toBe(1);
  });

  it('a sheet that closed itself before the lock is not closed again', async () => {
    const { lock, clock, sheets } = await unlocked();
    const close = vi.fn();
    const remove = sheets.add(close);
    remove();
    clock.forward(LOCK_AFTER_MS + 1);
    lock.tick();
    expect(close).not.toHaveBeenCalled();
  });

  it('unlock does not close sheets; a failing close does not keep the others open', async () => {
    const { lock, clock, sheets } = await unlocked();
    const after = vi.fn();
    sheets.add(() => {
      throw new Error('gone');
    });
    sheets.add(after);
    clock.forward(LOCK_AFTER_MS + 1);
    lock.tick();
    expect(after).toHaveBeenCalledTimes(1);
    const again = vi.fn();
    await lock.unlock();
    sheets.add(again);
    expect(lock.state()).toBe('unlocked');
    expect(again).not.toHaveBeenCalled();
  });

  it('a touch from a sheet restarts the idle term: no lock five minutes after the first touch', async () => {
    const { lock, clock, sheets } = await unlocked();
    const close = vi.fn();
    sheets.add(close);
    const onSheetTouch = touchLock(() => lock);
    clock.forward(LOCK_AFTER_MS - 1000);
    onSheetTouch();
    clock.forward(2000);
    lock.tick();
    expect(lock.state()).toBe('unlocked');
    expect(close).not.toHaveBeenCalled();
    // Without further touches the term runs out again.
    clock.forward(LOCK_AFTER_MS);
    lock.tick();
    expect(lock.state()).toBe('locked');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('touchLock with no lock yet (setting still being read, demo build) does nothing', () => {
    expect(() => touchLock(() => null)()).not.toThrow();
  });
});
