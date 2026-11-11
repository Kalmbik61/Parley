// `sessions.codeMode` (plan T12a-indicator): the request names a session by its ref and nothing else, so the host never takes a path.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS, type Result } from './methods.js';

const ref = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };

describe('sessions.codeMode', () => {
  it('takes only a ref', () => {
    expect(METHODS['sessions.codeMode'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['sessions.codeMode'].safeParse({}).success).toBe(false);
    expect(METHODS['sessions.codeMode'].safeParse({ ref: { projectPath: '/p', workId: 'w-01' } }).success).toBe(false);
  });
  it('refuses a path or any other key beside the ref', () => {
    for (const extra of [{ workDir: '/elsewhere' }, { path: '/etc' }, { sessionId: 's-01' }, { reason: 'classic' }]) {
      expect(METHODS['sessions.codeMode'].safeParse({ ref, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
  it('answers a closed mode and a reason token or null', () => {
    expectTypeOf<Result<'sessions.codeMode'>>().toEqualTypeOf<{ mode: 'code-mode' | 'classic' | 'unknown'; reason: string | null }>();
  });
});
