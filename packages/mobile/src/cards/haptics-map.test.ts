import { describe, expect, it } from 'vitest';
import { hapticFor } from './haptics-map';

describe('hapticFor (D1 §16)', () => {
  const allow = { kind: 'permission', behavior: 'allow' } as const;
  const deny = { kind: 'permission', behavior: 'deny' } as const;
  it('success for approvals and answers, warning for Deny', () => {
    expect(hapticFor({ kind: 'done' }, allow)).toBe('success');
    expect(hapticFor({ kind: 'done' }, { kind: 'question', answers: {} })).toBe('success');
    expect(hapticFor({ kind: 'done' }, { kind: 'plan', choice: 'manual' })).toBe('success');
    expect(hapticFor({ kind: 'done' }, deny)).toBe('warning');
  });
  it('not applied is a warning, a cancelled Face ID makes none', () => {
    for (const kind of ['already-answered', 'conflict', 'unconfirmed', 'no-longer-pending'] as const) expect(hapticFor({ kind }, allow)).toBe('warning');
    expect(hapticFor({ kind: 'cancelled' }, allow)).toBe('none');
    expect(hapticFor({ kind: 'error' }, allow)).toBe('error');
  });
});
