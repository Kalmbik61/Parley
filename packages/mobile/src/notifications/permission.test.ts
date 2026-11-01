import { describe, expect, it } from 'vitest';
import { notificationRow } from './row';

describe('notificationRow', () => {
  it('follows the D1 §11.2 table', () => {
    expect(notificationRow({ permission: 'granted', enabled: true, pushAvailable: true })).toEqual({ kind: 'switch', on: true });
    expect(notificationRow({ permission: 'granted', enabled: false, pushAvailable: true })).toEqual({ kind: 'switch', on: false });
    expect(notificationRow({ permission: 'undetermined', enabled: true, pushAvailable: true })).toEqual({ kind: 'switch', on: false });
    expect(notificationRow({ permission: 'denied', enabled: true, pushAvailable: true })).toEqual({ kind: 'denied' });
    expect(notificationRow({ permission: 'granted', enabled: true, pushAvailable: false })).toEqual({ kind: 'unavailable' });
  });
});
