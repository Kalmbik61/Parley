import { describe, expect, it } from 'vitest';
import type { PlanItem, Room, RoomPlan } from '@parley/core';
import { S } from '../../shared/strings.js';
import { activityMap, makeActivity, makeNeed, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import type { TakenTarget } from './board-model.js';
import { targetInfo } from './target-info.js';

const PROJECT = '/tmp/proj';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const sessionTarget = (lifecycle: 'active' | 'closed' = 'active', status: 'active' | 'archived' = 'active'): TakenTarget => {
  const session = makeSession('s-01', 'backend', { lifecycle });
  const entry = makeWork('w-01', { status, sessions: [session] });
  return { kind: 'session', entry, session };
};
const roomTarget = (room: Room, status: 'active' | 'archived' = 'active', sessions = [makeSession('s-01', 'lead')]): TakenTarget => {
  const entry = makeWork('w-01', { status, sessions, rooms: [room] });
  return { kind: 'room', entry, room };
};
const ref = { projectPath: PROJECT, workId: 'w-01', sessionId: 's-01' };
const room = (patch: Partial<Room> = {}): Room => ({ ...makeRoom('r-01', 'Plan'), members: ['s-01'], lead: 's-01', ...patch });

describe('targetInfo', () => {
  it('нет цели — null', () => {
    expect(targetInfo(null, {}, NOW)).toBeNull();
  });

  it('слово сессии — состояние точки', () => {
    const info = targetInfo(sessionTarget(), activityMap([makeActivity(ref, 'working')]), NOW)!;
    expect(info.word).toBe(S.states.working);
    expect(info.gone).toBe(false);
    expect(info.focus).toEqual({ kind: 'session', ref });
    expect(info.label.startsWith('S01')).toBe(true);
  });

  it('сессии нужен человек — слово причины, как в строке сайдбара', () => {
    const live = makeActivity(ref, 'idle', { need: makeNeed('approval') });
    expect(targetInfo(sessionTarget(), activityMap([live]), NOW)!.word).toBe('approval');
  });

  it('закрытая сессия и неактивная работа — gone', () => {
    expect(targetInfo(sessionTarget('closed'), {}, NOW)!.gone).toBe(true);
    expect(targetInfo(sessionTarget('active', 'archived'), {}, NOW)!.gone).toBe(true);
  });

  it('комната: подпись, ссылка и пустое слово', () => {
    const info = targetInfo(roomTarget(room()), {}, NOW)!;
    expect(info.label).toBe('Plan');
    expect(info.word).toBe('');
    expect(info.gone).toBe(false);
    expect(info.focus).toEqual({ kind: 'room', projectPath: PROJECT, workId: 'w-01', roomId: 'r-01' });
    expect(targetInfo(roomTarget(room({ title: '' })), {}, NOW)!.label).toBe(S.rooms.fallbackTitle);
  });

  it('комната ждёт решения — слово decision', () => {
    const waiting = room({ proposal: { id: 'p-01', rev: 1 } } as unknown as Partial<Room>);
    expect(targetInfo(roomTarget(waiting), {}, NOW)!.word).toBe(S.sidebar.roomDecision);
  });

  it('участнику комнаты нужен человек — слово blocked', () => {
    const live = makeActivity(ref, 'idle', { need: makeNeed('approval') });
    expect(targetInfo(roomTarget(room()), activityMap([live]), NOW)!.word).toBe(S.states.blocked);
  });

  it('архивная комната, комната без живого ведущего и неактивная работа — gone', () => {
    expect(targetInfo(roomTarget(room({ archivedAt: '2026-11-01T00:00:00Z' } as Partial<Room>)), {}, NOW)!.gone).toBe(true);
    expect(targetInfo(roomTarget(room(), 'active', [makeSession('s-01', 'lead', { lifecycle: 'closed' })]), {}, NOW)!.gone).toBe(true);
    expect(targetInfo(roomTarget(room(), 'archived'), {}, NOW)!.gone).toBe(true);
  });
});

describe('targetInfo — ход плана комнаты', () => {
  const planItem = (id: number, status: PlanItem['status']): PlanItem => ({
    id, title: `Item ${id}`, owner: 's-01', scope: 'src', after: [], criteria: [], verifier: null, status, evidence: null, note: null, log: [],
  });
  const planOf = (status: RoomPlan['status']): RoomPlan => ({
    id: 'pl-01', roomId: 'r-01', rev: 1, mode: 'verified', status, goal: 'Goal', items: [planItem(1, 'verified'), planItem(2, 'in_progress')], backlog: [],
    acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null,
  });
  const many = (n: number) => Array.from({ length: n }, (_, index) => makeSession(`s-${String(index + 1).padStart(2, '0')}`, `agent ${index + 1}`));
  const target = (plan: RoomPlan | null, members: string[], sessions = many(members.length)): TakenTarget => {
    const found = roomTarget(room({ members, lead: members[0] ?? null }), 'active', sessions);
    if (plan !== null) found.entry.map.plans = [plan];
    return found;
  };
  const working = (ids: string[]) => activityMap(ids.map((sessionId) => makeActivity({ ...ref, sessionId }, 'working')));

  it('комната с активным планом получает ход и работающих с подписями', () => {
    const info = targetInfo(target(planOf('active'), ['s-01', 's-02']), working(['s-02']), NOW)!;
    expect(info.plan).toEqual({ progress: '1/2 verified', working: [{ id: 's-02', provider: 'claude', label: 'S02 agent 2' }], more: 0 });
  });

  it('сессия перестала работать — из списка уходит', () => {
    const idle = activityMap([makeActivity({ ...ref, sessionId: 's-02' }, 'idle')]);
    expect(targetInfo(target(planOf('active'), ['s-01', 's-02']), idle, NOW)!.plan!.working).toEqual([]);
    expect(targetInfo(target(planOf('active'), ['s-01', 's-02']), {}, NOW)!.plan!.working).toEqual([]);
  });

  it('не больше четырёх значков, остальные числом, порядок по номеру сессии', () => {
    const members = ['s-10', 's-03', 's-02', 's-09', 's-01', 's-05'];
    const sessions = members.map((id) => makeSession(id, id));
    const info = targetInfo(target(planOf('active'), members, sessions), working(members), NOW)!;
    expect(info.plan!.working.map((row) => row.id)).toEqual(['s-01', 's-02', 's-03', 's-05']);
    expect(info.plan!.more).toBe(2);
  });

  it('план completing даёт поле; completed, proposed, cancelled, комната без плана и цель-сессия — нет', () => {
    expect(targetInfo(target(planOf('completing'), ['s-01']), {}, NOW)!.plan).toBeDefined();
    for (const status of ['completed', 'proposed', 'cancelled'] as const) expect(targetInfo(target(planOf(status), ['s-01']), {}, NOW)!.plan).toBeUndefined();
    expect(targetInfo(target(null, ['s-01']), {}, NOW)!.plan).toBeUndefined();
    expect('plan' in targetInfo(target(null, ['s-01']), {}, NOW)!).toBe(false);
    expect(targetInfo(sessionTarget(), {}, NOW)!.plan).toBeUndefined();
  });
});
