import { describe, expect, it } from 'vitest';
import { normalizeMicStatus } from './mic.js';

describe('normalizeMicStatus', () => {
  it('статусы macOS как есть, unknown и прочее — not-determined', () => {
    expect(normalizeMicStatus('granted')).toBe('granted');
    expect(normalizeMicStatus('denied')).toBe('denied');
    expect(normalizeMicStatus('restricted')).toBe('restricted');
    expect(normalizeMicStatus('not-determined')).toBe('not-determined');
    expect(normalizeMicStatus('unknown')).toBe('not-determined');
  });
});
