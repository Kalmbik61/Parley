import { describe, expect, it } from 'vitest';
import { reportLetterText, isReportLetterAbout, lastTaskGiver } from './task-giver.js';
import { addSession } from './map.js';
import { mapLetterTx } from './letter-store.js';
import type { WindowWorkMap } from './types.js';

it('builds a bounded first non-empty summary line', () => {
  expect(reportLetterText('s-02', 'failed', '\n  Problem  \nDetails')).toBe(
    's-02 reported failed: Problem. Full summary: get_map {session: "s-02", field: "summary"}',
  );
  expect(reportLetterText('s-02', 'done', 'x'.repeat(201))).toContain(`${'x'.repeat(199)}…`);
  expect(reportLetterText('s-02', 'done', '\n')).toBe(
    's-02 reported done. Full summary: get_map {session: "s-02", field: "summary"}',
  );
});

describe('report letter matcher', () => {
  const message = { from: 'system', roomId: null, text: 's-02 reported done: Ready' };
  it('only matches direct system reports about the target', () => {
    expect(isReportLetterAbout(message, 's-02')).toBe(true);
    expect(isReportLetterAbout(message, 's-03')).toBe(false);
    expect(isReportLetterAbout({ ...message, from: 's-01' }, 's-02')).toBe(false);
    expect(isReportLetterAbout({ ...message, roomId: 'r-01' }, 's-02')).toBe(false);
  });
});

it('defers swarm members to their own reporting protocol', () => {
  const map: WindowWorkMap = { schemaVersion: 3,
    work: { id: 'w-0001', title: '', goal: '', status: 'active', createdAt: '', updatedAt: '' },
    sessions: [], rooms: [], messages: [],
  };
  addSession(map, { provider: 'claude', label: 'giver', task: '' });
  addSession(map, { provider: 'claude', label: 'worker', task: '', createdBy: 's-01' });
  const { letters } = mapLetterTx(map);
  expect(lastTaskGiver(map, letters, 's-02')).toBe('s-01');
  map.swarms = [{ id: 'sw-01', tag: 'Work', creator: { kind: 'human' }, objective: '', queen: 's-01',
    members: [{ sessionId: 's-02', role: 'drone', n: 1, addedAt: '', handedAt: null }],
    status: 'running', createdAt: '', endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null }];
  expect(lastTaskGiver(map, letters, 's-02')).toBeNull();
});
