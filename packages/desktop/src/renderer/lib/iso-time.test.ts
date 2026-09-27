import { describe, expect, it } from 'vitest';
import { isoMs } from './iso-time.js';

describe('isoMs', () => {
  it('ISO с миллисекундами и без, с Z и смещением', () => {
    expect(isoMs('2026-09-27T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 27, 10));
    expect(isoMs('2026-09-27T10:00:00Z')).toBe(Date.UTC(2026, 8, 27, 10));
    expect(isoMs('2026-09-27T10:00:00+00:00')).toBe(Date.UTC(2026, 8, 27, 10));
    expect(isoMs('2026-09-27T13:00:00.000+03:00')).toBe(Date.UTC(2026, 8, 27, 10));
  });

  it('не-ISO и мусор — null', () => {
    for (const bad of ['w-9999', 's-01', '', 'garbage', 'x', '2026-09-27', '2026-09-27T10:00:00', '2026-13-45T99:00:00Z']) {
      expect(isoMs(bad)).toBeNull();
    }
  });
});
