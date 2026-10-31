import { describe, expect, it } from 'vitest';
import { parseSessionParam, parseWorkParam, sessionParam, workParam } from './refs';

describe('route params', () => {
  it('round-trips awkward characters', () => {
    const ref = { projectPath: '/Users/a b/проект|x', workId: 'w-1', sessionId: 's/2?#' };
    expect(parseSessionParam(sessionParam(ref))).toEqual(ref);
    const work = { projectPath: '/p|q', workId: 'w' };
    expect(parseWorkParam(workParam(work))).toEqual(work);
  });
  it('rejects missing, short and empty params', () => {
    expect(parseSessionParam(undefined)).toBeNull();
    expect(parseSessionParam('a|b')).toBeNull();
    expect(parseSessionParam('a||c')).toBeNull();
    expect(parseWorkParam('%E0%A4%A|b')).toBeNull();
  });
});
