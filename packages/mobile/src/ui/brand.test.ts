import { describe, expect, it } from 'vitest';
import { brandOf } from './brand';

describe('brandOf', () => {
  it('known providers have their colour and initial; the case does not matter', () => {
    expect(brandOf('claude')).toMatchObject({ bg: '#D97757', mark: 'C' });
    expect(brandOf('Codex')).toMatchObject({ mark: 'X' });
  });
  it('an unknown provider gets a neutral avatar with its first letter', () => {
    expect(brandOf('zeta')).toEqual({ bg: null, fg: null, mark: 'Z' });
    expect(brandOf('')).toMatchObject({ mark: '?' });
  });
});
