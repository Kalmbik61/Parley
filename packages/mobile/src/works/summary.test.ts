import { describe, expect, it } from 'vitest';
import { elapsed } from './summary';

describe('elapsed', () => {
  const t0 = '2026-10-31T12:00:00Z';
  it('formats mm:ss and h:mm:ss, ends at endedAt, and tolerates bad dates', () => {
    expect(elapsed(t0, null, Date.parse('2026-10-31T12:12:07Z'))).toBe('12:07');
    expect(elapsed(t0, '2026-10-31T13:02:03Z', 0)).toBe('1:02:03');
    expect(elapsed(t0, null, Date.parse('2026-10-31T11:00:00Z'))).toBe('00:00');
    expect(elapsed('nope', null, 0)).toBe('');
  });
});
