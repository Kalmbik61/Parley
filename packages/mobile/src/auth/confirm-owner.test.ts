import { describe, expect, it, vi } from 'vitest';
import { confirmWithOwner, type OwnerAuth } from './confirm-owner';

const auth = (level: number, result: Awaited<ReturnType<OwnerAuth['authenticateAsync']>> | Error): OwnerAuth & { authenticateAsync: ReturnType<typeof vi.fn> } => ({
  getEnrolledLevelAsync: async () => level,
  authenticateAsync: vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  }),
});

describe('confirmWithOwner', () => {
  it('ok when the person confirms; the prompt keeps the passcode fallback', async () => {
    const a = auth(2, { success: true });
    expect(await confirmWithOwner(a, 'Delete room')).toBe('ok');
    expect(a.authenticateAsync).toHaveBeenCalledWith({ promptMessage: 'Delete room', disableDeviceFallback: false });
  });
  it('cancelled when the person cancels or the prompt fails', async () => {
    expect(await confirmWithOwner(auth(2, { success: false, error: 'user_cancel' }), 'x')).toBe('cancelled');
    expect(await confirmWithOwner(auth(2, { success: false, error: 'authentication_failed' }), 'x')).toBe('cancelled');
    expect(await confirmWithOwner(auth(2, new Error('boom')), 'x')).toBe('cancelled');
  });
  it('unavailable when the device has neither Face ID nor a passcode — without asking', async () => {
    const a = auth(0, { success: true });
    expect(await confirmWithOwner(a, 'x')).toBe('unavailable');
    expect(a.authenticateAsync).not.toHaveBeenCalled();
    expect(await confirmWithOwner(auth(1, { success: false, error: 'passcode_not_set' }), 'x')).toBe('unavailable');
  });
});
