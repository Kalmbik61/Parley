import { describe, expect, it } from 'vitest';
import { parseRolloutLine, rolloutRecordOf } from './rollout-record.js';

describe('rollout-record', () => {
  it('строка 0.160: ordinal, время, тип, payload', () => {
    const line = JSON.stringify({ timestamp: '2026-10-07T10:00:00.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'task_started' } });
    expect(parseRolloutLine(line)).toEqual({ ordinal: 7, at: '2026-10-07T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } });
  });
  it('без ordinal (журналы до 0.160) — ordinal null', () => {
    expect(rolloutRecordOf({ timestamp: 't', type: 'session_meta', payload: {} })?.ordinal).toBeNull();
  });
  it('битая, пустая и чужая строки — null', () => {
    expect(parseRolloutLine('{"timestamp":')).toBeNull();
    expect(parseRolloutLine('   ')).toBeNull();
    expect(parseRolloutLine('[1,2]')).toBeNull();
    expect(rolloutRecordOf({ timestamp: 't', type: 'x', payload: 'nope' })).toBeNull();
  });
});
