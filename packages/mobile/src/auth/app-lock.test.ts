import { describe, expect, it, vi } from 'vitest';
import { createAppLock, LOCK_AFTER_MS, type LocalAuth } from './app-lock';

const auth = (ok: boolean, error = 'user_cancel') => ({
  authenticateAsync: vi.fn<LocalAuth['authenticateAsync']>(async () => (ok ? { success: true } : { success: false, error })),
});

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
    const lock = createAppLock({ auth: auth(true), enabled: true });
    await lock.unlock();
    lock.onBackground(1_000);
    lock.onForeground(1_000 + LOCK_AFTER_MS);
    expect(lock.state()).toBe('unlocked');
    lock.onBackground(10_000_000);
    lock.onForeground(10_000_000 + LOCK_AFTER_MS + 1);
    expect(lock.state()).toBe('locked');
    expect(lock.covered()).toBe(true);
  });

  it('a second background event does not move the start of the trip', async () => {
    const lock = createAppLock({ auth: auth(true), enabled: true });
    await lock.unlock();
    lock.onBackground(0);
    lock.onBackground(LOCK_AFTER_MS); // inactive → background
    lock.onForeground(LOCK_AFTER_MS + 1);
    expect(lock.state()).toBe('locked');
  });

  it('one prompt at a time', async () => {
    const a = auth(true);
    const lock = createAppLock({ auth: a, enabled: true });
    await Promise.all([lock.unlock(), lock.unlock()]);
    expect(a.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it('switched off: open, never locks; switched on locks at the next long trip, not at once', async () => {
    const a = auth(true);
    const lock = createAppLock({ auth: a, enabled: false });
    expect(lock.state()).toBe('unlocked');
    lock.onBackground(0);
    lock.onForeground(LOCK_AFTER_MS * 3);
    expect(lock.state()).toBe('unlocked');
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    lock.setEnabled(true);
    expect(lock.state()).toBe('unlocked');
    lock.onBackground(0);
    lock.onForeground(LOCK_AFTER_MS + 1);
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
