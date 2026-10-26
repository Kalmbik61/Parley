import { describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { roomMembership } from './room-membership.js';
import { addMember, addRoom } from './rooms.js';
import { HUMAN, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T11:00:00.000Z';
const T2 = '2026-10-14T12:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

describe('roomMembership (спека расхода токенов, 4.3, 5.1)', () => {
  it('журнал: окна как записаны, повторный вход — второе окно', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addMember(map, lt(map), r2.id, 's-01', T1);
    addMember(map, lt(map), r1.id, 's-01', T2);
    expect(roomMembership(map, r1.id)).toEqual({
      reconstructed: false,
      members: [{ session: 's-01', periods: [{ from: T0, to: T1 }, { from: T2, to: null }] }],
    });
  });

  it('старая комната: создатель — с создания, вошедший позже — по строке «joined», ушедший — до входа в другую комнату; ушедший начальный участник не восстанавливается', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addSession(map, { provider: 'claude', label: 'b', task: 'x' });
    addSession(map, { provider: 'claude', label: 'c', task: 'x' });
    const old = addRoom(map, { title: 'old', creator: 's-01', members: ['s-01', 's-02'] }, T0);
    addMember(map, lt(map), old.id, 's-03', T1);
    const fresh = addRoom(map, { title: 'new', creator: HUMAN, members: [] }, T0);
    addMember(map, lt(map), fresh.id, 's-03', T2);
    addMember(map, lt(map), fresh.id, 's-02', T2);
    delete old.memberLog;
    expect(roomMembership(map, old.id)).toEqual({
      reconstructed: true,
      members: [
        { session: 's-01', periods: [{ from: T0, to: null }] },
        { session: 's-03', periods: [{ from: T1, to: T2 }] },
      ],
    });
  });

  it('старая карта: текущий участник, числящийся и в другой комнате, из этой не уходил', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: ['s-01'] }, T1);
    delete r1.memberLog;
    delete r2.memberLog;
    expect(roomMembership(map, r1.id).members).toEqual([{ session: 's-01', periods: [{ from: T0, to: null }] }]);
  });

  it('неизвестная комната — ошибка', () => {
    expect(() => roomMembership(emptyMap(), 'r-09')).toThrow('room r-09 is not in the map');
  });
});
