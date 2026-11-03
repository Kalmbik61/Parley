import { describe, expect, it } from 'vitest';
import type { Room } from '@parley/core';
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
