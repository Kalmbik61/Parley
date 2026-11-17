import { describe, expect, it } from 'vitest';
import type { PlanAttempt, PlanItem, PlanMode, Room, RoomPlan } from '@parley/core';
import { autonomousPlan } from '../../../test-utils/autonomous-plan.js';
import { makeRoom, makeSession, makeWork } from '../../../test-utils/work-fixtures.js';
import { boardEvents, participantItemTags } from './room-board-activity.js';

const item = (id: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `Item ${id}`, owner: 's-01', scope: 'src', after: [], criteria: [], verifier: 's-02', status: 'waiting', evidence: null, note: null, log: [], ...patch,
});
const planOf = (mode: PlanMode, items: PlanItem[], patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01', roomId: 'r-01', rev: 2, mode, status: 'active', goal: 'Goal', items, backlog: [],
  acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null, ...patch,
});
const attempt = (patch: Partial<PlanAttempt>): PlanAttempt => ({ ...autonomousPlan().attempts[0]!, worker: 's-01', verifier: null, ...patch });
const autoPlan = (items: PlanItem[], attempts: PlanAttempt[], halted: RoomPlan['autonomous'] extends infer A ? (A extends { halted: infer H } ? H : never) : never = null): RoomPlan =>
  planOf('autonomous', items, { autonomous: { ...autonomousPlan(), attempts, ops: [], halted } });

function tags(plan: RoomPlan, room: Partial<Room> = {}): Record<string, number[]> {
  const full: Room = { ...makeRoom('r-01', 'Delivery'), members: ['s-01', 's-02', 's-03'], lead: 's-03', ...room };
  const entry = makeWork('w-01', { sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b'), makeSession('s-03', 'lead')], rooms: [full] });
  return Object.fromEntries(participantItemTags(plan, full, entry));
}

describe('метки пунктов', () => {
  it('Verified: начать, продолжить, переделать, проверить, снять блокировку — у нужной сессии', () => {
    const plan = planOf('verified', [
      item(1, { status: 'ready' }), item(2, { status: 'in_progress', owner: 's-02', verifier: 's-01' }), item(3, { status: 'returned', owner: 's-02' }),
      item(4, { status: 'done', owner: 's-01', verifier: 's-02' }), item(5, { status: 'blocked', owner: 's-02' }),
    ]);
    // s-01: начать #1, проверить #4; s-02: продолжить #2, переделать #3; ведущий s-03: снять блокировку #5.
    expect(tags(plan)).toEqual({ 's-01': [1], 's-02': [2, 3, 4], 's-03': [5] });
  });

  it('Checklist: начать, продолжить, переделать; проверяющего нет', () => {
    const plan = planOf('checklist', [item(1, { status: 'ready' }), item(2, { status: 'in_progress', owner: 's-02' }), item(3, { status: 'returned', owner: 's-02' }), item(4, { status: 'done' })]);
    expect(tags(plan)).toEqual({ 's-01': [1], 's-02': [2, 3] });
  });

  it('ожидающий исполнитель и человек-проверяющий меток не получают', () => {
    const plan = planOf('verified', [item(1), item(2, { status: 'done', verifier: 'human' })]);
    expect(tags(plan)).toEqual({});
  });

  it('проверяющий недоступен — метка у живого ведущего', () => {
    const plan = planOf('verified', [item(1, { status: 'done', verifier: 's-09' })]);
    expect(tags(plan)).toEqual({ 's-03': [1] });
  });

  it('план completing даёт метки; completed и cancelled — нет', () => {
    const items = [item(1, { status: 'in_progress' })];
    expect(tags(planOf('verified', items, { status: 'completing' }))).toEqual({ 's-01': [1] });
    expect(tags(planOf('verified', items, { status: 'completed' }))).toEqual({});
    expect(tags(planOf('verified', items, { status: 'cancelled' }))).toEqual({});
  });

  it('Autonomous: исполнитель при starting и running; проверяющий при submitted и checking; при queued — никто', () => {
    const run = (status: PlanAttempt['status']) => tags(autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status, worker: 's-01', verifier: 's-02' })]));
    expect(run('starting')).toEqual({ 's-01': [1] });
    expect(run('running')).toEqual({ 's-01': [1] });
    expect(run('submitted')).toEqual({ 's-02': [1] });
    expect(run('checking')).toEqual({ 's-02': [1] });
    expect(run('queued')).toEqual({});
    expect(tags(autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status: 'submitted', verifier: null })]))).toEqual({});
  });

  it('Autonomous: берётся последняя попытка', () => {
    const plan = autoPlan([item(1, { status: 'in_progress' })], [attempt({ id: 'at-01', n: 1, item: 1, status: 'running', worker: 's-01' }), attempt({ id: 'at-02', n: 2, item: 1, status: 'running', worker: 's-02' })]);
    expect(tags(plan)).toEqual({ 's-02': [1] });
  });

  it('Autonomous остановлен — меток нет', () => {
    const halted = { reason: 'budget' as const, at: 'x', detail: 'd' };
    expect(tags(autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status: 'running' })], halted))).toEqual({});
  });
});

describe('события', () => {
  const log = (at: string, status: PlanItem['log'][number]['status'], by = 's-01') => ({ at, by, status, note: null });
  const row = (at: string, status: PlanAttempt['status']) => ({ at, by: 'engine', status, note: null, op: null });

  it('записи пунктов и попыток, новые первыми, три по умолчанию', () => {
    const plan = autoPlan(
      [item(1, { log: [log('2026-11-17T10:00:00.000Z', 'in_progress'), log('2026-11-17T12:00:00.000Z', 'verified', 'engine')] })],
      [attempt({ item: 1, log: [row('2026-11-17T09:00:00.000Z', 'running'), row('2026-11-17T11:00:00.000Z', 'submitted'), row('2026-11-17T11:30:00.000Z', 'checking')] })],
    );
    const events = boardEvents(plan);
    expect(events.map((event) => event.at)).toEqual(['2026-11-17T12:00:00.000Z', '2026-11-17T11:30:00.000Z', '2026-11-17T11:00:00.000Z']);
    expect(events[0]).toEqual({ at: '2026-11-17T12:00:00.000Z', by: 'engine', itemId: 1, change: { source: 'item', status: 'verified' } });
    expect(events[1]!.change).toEqual({ source: 'attempt', status: 'checking' });
    expect(boardEvents(plan, 10)).toHaveLength(4);
    expect(boardEvents(planOf('verified', [item(1)]))).toEqual([]);
  });

  it('повтор состояния попытки отброшен', () => {
    const plan = autoPlan([item(1)], [attempt({ item: 1, log: [row('2026-11-17T10:00:00.000Z', 'submitted'), row('2026-11-17T10:01:00.000Z', 'submitted'), row('2026-11-17T10:02:00.000Z', 'checking'), row('2026-11-17T10:03:00.000Z', 'checking'), row('2026-11-17T10:04:00.000Z', 'submitted')] })]);
    expect(boardEvents(plan, 10).map((event) => `${event.change.status}@${event.at.slice(14, 16)}`)).toEqual(['submitted@04', 'checking@02', 'submitted@00']);
  });

  it('равное время — порядок устойчив: пункт с меньшим номером, запись пункта раньше записи попытки', () => {
    const at = '2026-11-17T10:00:00.000Z';
    const plan = autoPlan(
      [item(2, { log: [log(at, 'in_progress')] }), item(1, { log: [log(at, 'returned')] })],
      [attempt({ item: 1, log: [row(at, 'submitted')] })],
    );
    const order = boardEvents(plan).map((event) => `${event.itemId}:${event.change.source}`);
    expect(order).toEqual(['1:item', '1:attempt', '2:item']);
    expect(boardEvents(plan).map((event) => `${event.itemId}:${event.change.source}`)).toEqual(order);
  });
});
