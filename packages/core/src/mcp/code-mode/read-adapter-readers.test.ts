// The shape readers and `Mismatch` that read-adapters.ts exports for the T11 decoders (B0.1): each reader returns a valid value
// unchanged and refuses anything else with `Mismatch('shape-mismatch')`. The five decoders use only some of them, so these
// cases pin the rest before an R batch relies on them.
import { describe, expect, it } from 'vitest';
import { Mismatch, asArray, asBool, asCount, asCountOrNull, asObject, asString, asStringOrNull, asStrings } from './read-adapters.js';

const refused = (read: () => unknown): void => {
  let caught: unknown;
  try {
    read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Mismatch);
  expect((caught as Mismatch).code).toBe('shape-mismatch');
};

describe('exported readers (B0.1)', () => {
  it('Mismatch is an Error that carries its code', () => {
    const error = new Mismatch('echo-mismatch');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('echo-mismatch');
  });

  it('asObject takes a plain object only', () => {
    const o = { a: 1 };
    expect(asObject(o)).toBe(o);
    for (const bad of [[], null, undefined, 'x', 1, true]) refused(() => asObject(bad));
  });

  it('asArray takes an array only', () => {
    const a = [1];
    expect(asArray(a)).toBe(a);
    for (const bad of [{}, null, undefined, 'x', 1]) refused(() => asArray(bad));
  });

  it('asString takes a string only', () => {
    expect(asString('')).toBe('');
    for (const bad of [1, null, undefined, true, {}]) refused(() => asString(bad));
  });

  it('asStringOrNull takes a string or null, and not undefined', () => {
    expect(asStringOrNull(null)).toBeNull();
    expect(asStringOrNull('a')).toBe('a');
    for (const bad of [undefined, 1, true, {}]) refused(() => asStringOrNull(bad));
  });

  it('asBool takes a boolean only, never 0, 1 or a string', () => {
    expect(asBool(true)).toBe(true);
    expect(asBool(false)).toBe(false);
    for (const bad of [0, 1, 'true', null, undefined]) refused(() => asBool(bad));
  });

  it('asCount takes a non-negative safe integer only', () => {
    expect(asCount(0)).toBe(0);
    expect(asCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) refused(() => asCount(bad));
  });

  it('asCountOrNull takes a count or null, and not undefined', () => {
    expect(asCountOrNull(null)).toBeNull();
    expect(asCountOrNull(3)).toBe(3);
    for (const bad of [undefined, -1, 1.5, '1']) refused(() => asCountOrNull(bad));
  });

  it('asStrings takes an array of strings only', () => {
    expect(asStrings([])).toEqual([]);
    expect(asStrings(['a', 'b'])).toEqual(['a', 'b']);
    for (const bad of [[1], ['a', null], 'a', {}, null]) refused(() => asStrings(bad));
  });
});
