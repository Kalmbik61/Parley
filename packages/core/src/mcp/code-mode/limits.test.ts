import { describe, expect, it } from 'vitest';
import { GUEST_LIMITS, guestLimitsProblem } from './guest.js';
import { LOG_BYTES_MAX, RUN_LIMITS, type RunLimits, guestLimitsFor, resolveRunLimits } from './limits.js';

describe('run limits (design §6, T4b)', () => {
  it('defaults are the design §6 bounds, frozen, with logs off', () => {
    expect(RUN_LIMITS).toEqual({
      codeBytes: 32 * 1024, activeMs: 1000, wallMs: 30_000, memoryBytes: 48 * 1024 * 1024, stackBytes: 128 * 1024,
      rssSoftKb: 256 * 1024, maxRpcs: 32, maxInFlight: 2, argBytes: 64 * 1024, responseBytes: 1024 * 1024, resultBytes: 16 * 1024, logBytes: 0,
    });
    expect(Object.isFrozen(RUN_LIMITS)).toBe(true);
    expect(resolveRunLimits()).toEqual({ ok: true, limits: RUN_LIMITS });
  });

  it('a caller may lower any limit, and gets an owned frozen copy', () => {
    const over = { maxRpcs: 3, wallMs: 5000, memoryBytes: 16 * 1024 * 1024, logBytes: 0 };
    const r = resolveRunLimits(over);
    expect(r).toMatchObject({ ok: true, limits: { ...RUN_LIMITS, ...over } });
    over.maxRpcs = 99;
    expect(r.ok && r.limits.maxRpcs).toBe(3);
    expect(r.ok && Object.isFrozen(r.limits)).toBe(true);
  });

  it.each(Object.keys(RUN_LIMITS).filter((k) => k !== 'logBytes') as (keyof RunLimits)[])('raising %s is refused, not clamped', (key) => {
    const r = resolveRunLimits({ [key]: RUN_LIMITS[key] + (key === 'memoryBytes' ? 65536 : 1) });
    expect(r).toEqual({ ok: false, problem: `${key} above its maximum ${RUN_LIMITS[key]}` });
  });

  it.each([
    ['any logs (unsupported)', { logBytes: 1 }, 'logs are not supported (logBytes must be 0)'],
    ['logs at the future ceiling', { logBytes: LOG_BYTES_MAX }, 'logs are not supported (logBytes must be 0)'],
    ['zero', { maxRpcs: 0 }, 'maxRpcs must be a positive safe integer'],
    ['negative', { wallMs: -1 }, 'wallMs must be a positive safe integer'],
    ['fractional', { activeMs: 0.5 }, 'activeMs must be a positive safe integer'],
    ['a string', { maxInFlight: '1' }, 'maxInFlight must be a positive safe integer'],
    ['an unknown key', { maxCalls: 1 }, 'unknown limit maxCalls'],
    ['memory not whole pages', { memoryBytes: 20 * 1024 * 1024 + 1 }, 'memoryBytes must be whole WASM pages and at least 16 MiB'],
    ['memory under 16 MiB', { memoryBytes: 8 * 1024 * 1024 }, 'memoryBytes must be whole WASM pages and at least 16 MiB'],
  ])('%s is refused', (_label, over, problem) => {
    expect(resolveRunLimits(over)).toEqual({ ok: false, problem });
  });

  it('non-plain overrides are refused before any value is used: NaN, getters, proxies, arrays, null', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'maxRpcs', { get: () => { reads++; return reads === 1 ? 1 : 1000; }, enumerable: true });
    const proxy = new Proxy({ maxRpcs: 1 }, {});
    for (const v of [{ wallMs: Number.NaN }, { wallMs: Infinity }, getter, proxy, [1], null, 'x', 1]) {
      expect(resolveRunLimits(v).ok, String(v)).toBe(false);
    }
    expect(reads).toBe(0);
  });

  it('the guest share keeps the physical maxima and carries the remaining wall', () => {
    const g = guestLimitsFor(RUN_LIMITS, 1234.9);
    expect(g).toEqual({ ...GUEST_LIMITS, wallMs: 1234 });
    expect(guestLimitsProblem(g)).toBeNull();
    expect(guestLimitsFor(RUN_LIMITS, -5).wallMs).toBe(1);
  });
});
