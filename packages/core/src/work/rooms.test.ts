import { describe, expect, it } from 'vitest';
import { addSession, removeSession } from './map.js';
import { addRoom, isDescendant, isMember, joinNotice, nextRoomId } from './rooms.js';
import { HUMAN, type WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'комнаты',
    goal: '',
    status: 'active',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

describe('nextRoomId', () => {
  it('первая комната — r-01, дальше по порядку', () => {
    const map = emptyMap();
    expect(nextRoomId(map)).toBe('r-01');
    map.rooms.push({ id: 'r-01', title: 'x', creator: 's-01', members: [], createdAt: '' });
    expect(nextRoomId(map)).toBe('r-02');
  });

  it('id не переиспользуется: счётчик помнит номер даже без записи в rooms', () => {
    const map = emptyMap();
    map.work.roomSeq = 5;
    expect(nextRoomId(map)).toBe('r-06');
    expect(map.work.roomSeq).toBe(6);
  });
});

describe('addRoom', () => {
  it('заводит комнату с создателем и участниками', () => {
    const map = emptyMap();
    const room = addRoom(
      map,
      { title: 'бэкенд', creator: 's-01', members: ['s-02', 's-03'] },
      '2026-09-26T10:05:00.000Z',
    );

    expect(room).toEqual({
      id: 'r-01',
      title: 'бэкенд',
      creator: 's-01',
      members: ['s-02', 's-03'],
      createdAt: '2026-09-26T10:05:00.000Z',
    });
    expect(map.rooms).toEqual([room]);
  });
});

describe('isMember', () => {
  const room = { id: 'r-01', title: 'x', creator: 's-01', members: ['s-02', 's-03'], createdAt: '' };

  it('создатель, участник и человек — участники; посторонний — нет', () => {
    expect(isMember(room, 's-01')).toBe(true);
    expect(isMember(room, 's-02')).toBe(true);
    expect(isMember(room, HUMAN)).toBe(true);
    expect(isMember(room, 's-09')).toBe(false);
  });
});

describe('joinNotice', () => {
  it('перечисляет участников короткими тегами через «и»', () => {
    const map = emptyMap();
    const room = addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-02', 's-03'] });

    expect(joinNotice(room, map)).toBe('Вас добавили в r-01 «бэкенд» с S02 и S03');
  });

  it('один участник — без «и»', () => {
    const map = emptyMap();
    const room = addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-02'] });

    expect(joinNotice(room, map)).toBe('Вас добавили в r-01 «бэкенд» с S02');
  });

  it('удалённый участник помечен отдельно', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addSession(map, { provider: 'claude', label: 'b', task: 'x' });
    removeSession(map, 's-02');
    const room = addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-01', 's-02'] });

    expect(joinNotice(room, map)).toBe('Вас добавили в r-01 «бэкенд» с S01 и S02 (удалена)');
  });
});

describe('isDescendant', () => {
  it('прямой и косвенный потомок — true, сосед и предок — false', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'корень', task: 'x' }); // s-01
    addSession(map, { provider: 'claude', label: 'дитя', task: 'x', parent: 's-01' }); // s-02
    addSession(map, { provider: 'claude', label: 'внук', task: 'x', parent: 's-02' }); // s-03
    addSession(map, { provider: 'claude', label: 'сосед', task: 'x', parent: 's-01' }); // s-04

    expect(isDescendant(map, 's-01', 's-02')).toBe(true);
    expect(isDescendant(map, 's-01', 's-03')).toBe(true);
    expect(isDescendant(map, 's-02', 's-04')).toBe(false);
    expect(isDescendant(map, 's-02', 's-01')).toBe(false);
    expect(isDescendant(map, 's-01', 's-01')).toBe(false);
  });

  it('неизвестная сессия — false, а не ошибка', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'корень', task: 'x' });
    expect(isDescendant(map, 's-01', 's-09')).toBe(false);
  });
});
