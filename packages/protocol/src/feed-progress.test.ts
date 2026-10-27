import { describe, expect, it } from 'vitest';
import { FEED_PROGRESS_ID_LIMIT, FEED_PROGRESS_MAX_BYTES, FEED_PROGRESS_RECENT_LIMIT, progressLine, progressResult } from './feed-progress.js';

const AT = '2026-10-27T00:00:00.000Z';
const ENDED = '2026-10-27T00:00:01.000Z';
const line = (patch: Record<string, unknown> = {}) => ({ id: 'opaque-1', at: AT, category: 'execute', status: 'running', ...patch });
const result = (patch: Record<string, unknown> = {}) => ({ revision: 1, availability: 'available', current: line(), recent: [line()], truncated: false, ...patch });

describe('feed.progress line', () => {
  it('accepts the bounded opaque wire id and only declared enums', () => {
    for (const id of ['x', 'x'.repeat(FEED_PROGRESS_ID_LIMIT), 'opaque:provider-independent']) expect(progressLine.safeParse(line({ id })).success).toBe(true);
    for (const category of ['read', 'edit', 'execute', 'search', 'delegate', 'other']) expect(progressLine.safeParse(line({ category })).success).toBe(true);
    for (const status of ['running', 'done', 'failed', 'rejected']) expect(progressLine.safeParse(line({ status, endedAt: ENDED })).success).toBe(true);
    expect(progressLine.safeParse(line()).success).toBe(true);
  });
  it.each(['', 'x'.repeat(129), 1, null])('rejects invalid id %j', (id) => {
    expect(progressLine.safeParse(line({ id })).success).toBe(false);
  });
  it.each(['2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00.000+00:00', '+010000-01-01T00:00:00.000Z', 'invalid', '', null])('requires real canonical UTC ISO24 dates: %j', (at) => {
    expect(progressLine.safeParse(line({ at })).success).toBe(false);
    expect(progressLine.safeParse(line({ endedAt: at })).success).toBe(false);
  });
  it('accepts a canonical leap-day timestamp and rejects unknown category/status', () => {
    expect(progressLine.safeParse(line({ at: '2024-02-29T23:59:59.999Z' })).success).toBe(true);
    expect(progressLine.safeParse(line({ category: 'Bash' })).success).toBe(false);
    expect(progressLine.safeParse(line({ status: 'error' })).success).toBe(false);
  });
  it.each(['name', 'input', 'args', 'response', 'patch', 'path', 'command', 'error', 'prompt', 'transcriptPath', 'result', 'providerSessionId', 'startedAtProcess'])('rejects forbidden free-text/provenance field %s', (field) => {
    expect(progressLine.safeParse(line({ [field]: 'SECRET_CANARY' })).success).toBe(false);
  });
});

describe('feed.progress result', () => {
  it('current is the last running row in array order; settled/current-null mismatches are rejected', () => {
    const early = line({ id: 'early', at: ENDED }); const last = line({ id: 'last', at: AT });
    expect(progressResult.safeParse(result({ recent: [early, last], current: last })).success).toBe(true);
    expect(progressResult.safeParse(result({ recent: [early, last], current: early })).success).toBe(false);
    expect(progressResult.safeParse(result({ current: null })).success).toBe(false);
    for (const status of ['done', 'failed', 'rejected']) {
      const settled = line({ status });
      expect(progressResult.safeParse(result({ recent: [settled], current: settled })).success).toBe(false);
      expect(progressResult.safeParse(result({ recent: [settled], current: null })).success).toBe(true);
    }
  });
  it('accepts available empty/filled snapshots and retained revision on unavailable', () => {
    expect(progressResult.safeParse(result()).success).toBe(true);
    expect(progressResult.safeParse(result({ current: null, recent: [] })).success).toBe(true);
    for (const revision of [0, 42, Number.MAX_SAFE_INTEGER]) expect(progressResult.safeParse(result({ revision, availability: 'unavailable', current: null, recent: [], truncated: false })).success).toBe(true);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])('requires a nonnegative safe integer revision: %j', (revision) => {
    expect(progressResult.safeParse(result({ revision })).success).toBe(false);
  });
  it('strictly bounds recent to 20 unique ids and rejects free-text fields at every result level', () => {
    const recent = Array.from({ length: FEED_PROGRESS_RECENT_LIMIT }, (_, at) => line({ id: String(at) }));
    expect(progressResult.safeParse(result({ recent, current: recent.at(-1), truncated: true })).success).toBe(true);
    expect(progressResult.safeParse(result({ recent: [...recent, line({ id: 'extra' })], current: null })).success).toBe(false);
    expect(progressResult.safeParse(result({ recent: [line(), line()] })).success).toBe(false);
    expect(progressResult.safeParse(result({ command: 'SECRET_CANARY' })).success).toBe(false);
    expect(progressResult.safeParse(result({ current: line({ path: 'SECRET_CANARY' }) })).success).toBe(false);
    expect(progressResult.safeParse(result({ recent: [line({ response: 'SECRET_CANARY' })] })).success).toBe(false);
    expect(progressResult.safeParse(result({ availability: 'unknown' })).success).toBe(false);
    expect(progressResult.safeParse(result({ truncated: 'yes' })).success).toBe(false);
  });
  it.each([{ id: 'outside' }, { at: ENDED }, { endedAt: ENDED }, { category: 'read' }, { status: 'done' }])('requires exact current row membership, not just matching id: %j', (patch) => {
    expect(progressResult.safeParse(result({ current: line(patch) })).success).toBe(false);
  });
  it('unavailable never carries current, old history or truncated state', () => {
    const unavailable = result({ availability: 'unavailable', current: null, recent: [] });
    for (const patch of [{ current: line() }, { recent: [line()] }, { truncated: true }]) expect(progressResult.safeParse({ ...unavailable, ...patch }).success).toBe(false);
  });
  it('caps the entire serialized UTF-8 result, including current; character counts are insufficient', () => {
    const payload = (controls: number) => {
      const recent = Array.from({ length: 20 }, (_, at) => line({ id: String(at).padStart(2, '0') + '\u0000'.repeat(controls) + '界'.repeat(126 - controls), category: 'delegate', status: at === 19 ? 'running' : 'done', endedAt: ENDED }));
      return result({ recent, current: recent.at(-1) });
    };
    const below = payload(90); const above = payload(95);
    expect(new TextEncoder().encode(JSON.stringify(below)).byteLength).toBeLessThanOrEqual(FEED_PROGRESS_MAX_BYTES);
    expect(progressResult.safeParse(below).success).toBe(true);
    expect(JSON.stringify(above).length).toBeLessThan(FEED_PROGRESS_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(above)).byteLength).toBeGreaterThan(FEED_PROGRESS_MAX_BYTES);
    expect(progressResult.safeParse(above).success).toBe(false);
  });
});
