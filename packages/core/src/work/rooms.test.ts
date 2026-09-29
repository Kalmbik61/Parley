import { describe, expect, it } from 'vitest';
import { unreadFor } from './letters.js';
import { addSession, removeSession, setResult, transitionSession } from './map.js';
import {
  addMember,
  addRoom,
  isDescendant,
  isMember,
  isRoomClosed,
  joinNotice,
  leaveOtherRooms,
  nextRoomId,
  roomLead,
  RoomRuleError,
} from './rooms.js';
import { HUMAN, SYSTEM, type Room, type WorkMap } from './types.js';

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
    map.rooms.push({ id: 'r-01', title: 'x', creator: 's-01', members: [], createdAt: '', lead: null, proposal: null });
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
      lead: null,
      proposal: null,
    });
    expect(map.rooms).toEqual([room]);
  });
});

describe('isMember', () => {
  const room: Room = {
    id: 'r-01',
    title: 'x',
    creator: 's-01',
    members: ['s-02', 's-03'],
    createdAt: '',
    lead: null,
    proposal: null,
  };

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

/** Четыре сессии и две комнаты человека: r-01 {s-01, s-02} с ведущим s-01, r-02 {s-03}. */
function twoRooms(): WorkMap {
  const map = emptyMap();
  for (const label of ['архитектор', 'бэкенд', 'ревью', 'тесты']) {
    addSession(map, { provider: 'claude', label, task: 'x' });
  }
  addRoom(map, { title: 'Возвраты', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
  addRoom(map, { title: 'Ревью', creator: HUMAN, members: ['s-03'] });
  return map;
}

describe('addRoom: ведущий', () => {
  it('ведущего нет в вызове — lead: null, решения нет', () => {
    const map = emptyMap();
    const room = addRoom(map, { title: 'x', creator: HUMAN, members: ['s-01', 's-02'] });
    expect(room.lead).toBeNull();
    expect(room.proposal).toBeNull();
  });

  it('явный ведущий записывается: участник из members или сам создатель-сессия', () => {
    const map = emptyMap();
    expect(addRoom(map, { title: 'x', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-02' }).lead).toBe(
      's-02',
    );
    expect(addRoom(map, { title: 'y', creator: 's-01', members: ['s-02'], lead: 's-01' }).lead).toBe('s-01');
  });

  it('ведущий — не участник или человек: RoomRuleError, комната не заведена', () => {
    const map = emptyMap();
    expect(() => addRoom(map, { title: 'x', creator: HUMAN, members: ['s-01'], lead: 's-09' })).toThrow(
      RoomRuleError,
    );
    expect(() => addRoom(map, { title: 'x', creator: HUMAN, members: ['s-01'], lead: HUMAN })).toThrow(
      RoomRuleError,
    );
    expect(map.rooms).toEqual([]);
    // Счётчик комнат тоже не уехал: неудачный вызов номера не тратит.
    expect(addRoom(map, { title: 'x', creator: HUMAN, members: ['s-01'] }).id).toBe('r-01');
  });
});

describe('roomLead', () => {
  const room = (patch: Partial<Room>): Room => ({
    id: 'r-01',
    title: 'x',
    creator: HUMAN,
    members: ['s-02', 's-03'],
    createdAt: '',
    lead: null,
    proposal: null,
    ...patch,
  });

  it('явный lead выигрывает', () => {
    expect(roomLead(room({ lead: 's-03' }))).toBe('s-03');
  });

  it('lead: null — первый из members, как у карт до ведущего (дизайн комнат, 3.1)', () => {
    expect(roomLead(room({}))).toBe('s-02');
  });

  it('пустая комната без ведущего — null', () => {
    expect(roomLead(room({ members: [] }))).toBeNull();
  });
});

describe('isRoomClosed', () => {
  it('открыта, пока жива хотя бы одна сессия участника или создателя', () => {
    const map = twoRooms();
    const [first] = map.rooms as [Room, Room];
    transitionSession(map, 's-01', 'closed');
    expect(isRoomClosed(map, first)).toBe(false);
    transitionSession(map, 's-02', 'closed');
    expect(isRoomClosed(map, first)).toBe(true);
  });

  it('удалённая из карты сессия не считается живой; человек — не сессия', () => {
    const map = twoRooms();
    const second = map.rooms[1] as Room;
    removeSession(map, 's-03');
    expect(isRoomClosed(map, second)).toBe(true);
  });

  it('комната сессии-создателя жива, пока жив он сам', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const room = addRoom(map, { title: 'x', creator: 's-01', members: [] });
    expect(isRoomClosed(map, room)).toBe(false);
    transitionSession(map, 's-01', 'closed');
    expect(isRoomClosed(map, room)).toBe(true);
  });
});

describe('leaveOtherRooms', () => {
  it('убирает сессию из members прочих комнат, а свою (except) не трогает', () => {
    const map = twoRooms();
    leaveOtherRooms(map, 's-02', 'r-02');
    expect(map.rooms[0]?.members).toEqual(['s-01']);
    expect(map.rooms[1]?.members).toEqual(['s-03']);
  });

  it('уходящий ведущий оставляет lead: null — ведущим станет первый из оставшихся', () => {
    const map = twoRooms();
    leaveOtherRooms(map, 's-01', 'r-02');
    expect(map.rooms[0]).toMatchObject({ members: ['s-02'], lead: null });
    expect(roomLead(map.rooms[0] as Room)).toBe('s-02');
  });

  it('создатель-сессия уходит из своей комнаты: комната остаётся за человеком', () => {
    const map = emptyMap();
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'агентская', creator: 's-01', members: ['s-02'], lead: 's-01' });
    addRoom(map, { title: 'другая', creator: HUMAN, members: ['s-03'] });

    leaveOtherRooms(map, 's-01', 'r-02');
    expect(map.rooms[0]).toMatchObject({ creator: HUMAN, members: ['s-02'], lead: null });
    // Иначе isMember по-прежнему считал бы её участницей, а recipientsOf — адресатом рассылок.
    expect(isMember(map.rooms[0] as Room, 's-01')).toBe(false);
  });
});

describe('addMember', () => {
  const NOW = '2026-09-29T12:00:00.000Z';

  it('сессия входит в комнату: последней в members, системное «@s04 joined the room»', () => {
    const map = twoRooms();
    const message = addMember(map, 'r-01', 's-04', NOW);

    expect(map.rooms[0]?.members).toEqual(['s-01', 's-02', 's-04']);
    expect(message).toMatchObject({
      roomId: 'r-01',
      from: SYSTEM,
      to: [HUMAN],
      kind: 'note',
      text: '@s04 joined the room',
      at: NOW,
    });
    expect(map.messages).toEqual([message]);
  });

  it('уводит сессию из прочих комнат работы (правило одной комнаты, решение 4)', () => {
    const map = twoRooms();
    addMember(map, 'r-02', 's-02');

    expect(map.rooms[0]?.members).toEqual(['s-01']);
    expect(map.rooms[1]?.members).toEqual(['s-03', 's-02']);
  });

  it('системная запись не будит сессии и не считается непрочитанной человеком', () => {
    const map = twoRooms();
    const message = addMember(map, 'r-01', 's-04', NOW);

    for (const id of ['s-01', 's-02', 's-03', 's-04']) expect(unreadFor(map, id)).toEqual([]);
    // Действие человека: его же отметка «прочитано» стоит с самой записи.
    expect(message.readBy).toEqual({ [HUMAN]: NOW });
  });

  it('уже участник, закрытая, неизвестная сессия и комната — RoomRuleError, карта не тронута', () => {
    const map = twoRooms();
    transitionSession(map, 's-04', 'closed');
    const before = JSON.stringify(map);

    const cases: Array<[() => unknown, RegExp]> = [
      [() => addMember(map, 'r-01', 's-02'), /уже участник/],
      [() => addMember(map, 'r-01', 's-04'), /закрыта/],
      [() => addMember(map, 'r-01', 's-09'), /нет в карте/],
      [() => addMember(map, 'r-09', 's-03'), /нет в карте/],
    ];
    for (const [call, message] of cases) {
      expect(call).toThrow(RoomRuleError);
      expect(call).toThrow(message);
    }
    expect(JSON.stringify(map)).toBe(before);
  });

  it('сессия с итогом (report) — не закрыта: в комнату входит', () => {
    const map = twoRooms();
    setResult(map, 's-04', 'done');
    expect(() => addMember(map, 'r-01', 's-04')).not.toThrow();
  });
});
