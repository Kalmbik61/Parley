import { describe, expect, it } from 'vitest';
import { unreadFor } from './letters.js';
import { addSession, removeSession, setResult, transitionSession } from './map.js';
import {
  addMember,
  addMemberByLead,
  addRoom,
  addRoomOriginMessage,
  isDescendant,
  isMember,
  isRoomClosed,
  joinNotice,
  leaveOtherRooms,
  liveLead,
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

describe('liveLead', () => {
  /** Три сессии и комната человека r-01 {s-01, s-02, s-03}. */
  function trio(lead: string | null = null): WorkMap {
    const map = emptyMap();
    for (const label of ['архитектор', 'бэкенд', 'ревью']) {
      addSession(map, { provider: 'claude', label, task: 'x' });
    }
    addRoom(map, { title: 'Возвраты', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead });
    return map;
  }
  const first = (map: WorkMap): Room => map.rooms[0] as Room;

  it('ведущий жив — им и остаётся: и явный, и первый из members', () => {
    const explicit = trio('s-03');
    expect(liveLead(explicit, first(explicit))).toBe('s-03');
    const byDefault = trio();
    expect(liveLead(byDefault, first(byDefault))).toBe('s-01');
  });

  it('спящая и ещё не запущенная сессия жива и ведущего не теряет', () => {
    const map = trio('s-02');
    transitionSession(map, 's-02', 'active');
    transitionSession(map, 's-02', 'sleeping');
    expect(liveLead(map, first(map))).toBe('s-02');
    expect(map.sessions.find((session) => session.id === 's-03')?.lifecycle).toBe('pending');
  });

  it('явный ведущий закрыт — ведущим становится первый живой из members', () => {
    const map = trio('s-02');
    transitionSession(map, 's-02', 'closed');
    expect(liveLead(map, first(map))).toBe('s-01');
    // Запись комнаты при этом не переписывается: `roomLead` по-прежнему отдаёт назначенного.
    expect(roomLead(first(map))).toBe('s-02');
    expect(first(map).lead).toBe('s-02');
  });

  it('первый из members закрыт, ведущий не назначен — следующий живой', () => {
    const map = trio();
    transitionSession(map, 's-01', 'closed');
    expect(liveLead(map, first(map))).toBe('s-02');
    transitionSession(map, 's-02', 'closed');
    expect(liveLead(map, first(map))).toBe('s-03');
  });

  it('удалённая из карты сессия тоже пропускается: removeSession оставляет id в members', () => {
    const map = trio('s-01');
    removeSession(map, 's-01');
    expect(first(map).members).toContain('s-01');
    expect(liveLead(map, first(map))).toBe('s-02');
  });

  it('members никого не оставили — создатель-сессия; создатель-человек не ведущий', () => {
    const map = emptyMap();
    for (const label of ['a', 'b']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'агентская', creator: 's-01', members: ['s-02'], lead: 's-02' });
    transitionSession(map, 's-02', 'closed');
    expect(liveLead(map, first(map))).toBe('s-01');

    const human = trio();
    for (const id of ['s-01', 's-02', 's-03']) transitionSession(human, id, 'closed');
    expect(liveLead(human, first(human))).toBeNull();
  });

  it('ведущего нет ровно тогда, когда комната закрыта (isRoomClosed): круг тот же', () => {
    const map = trio('s-02');
    const ids = ['s-01', 's-02', 's-03'];
    for (let closed = 0; closed <= ids.length; closed += 1) {
      expect(liveLead(map, first(map)) === null).toBe(isRoomClosed(map, first(map)));
      const next = ids[closed];
      if (next !== undefined) transitionSession(map, next, 'closed');
    }
    expect(isRoomClosed(map, first(map))).toBe(true);
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

  it('старая карта: сессия в двух комнатах, бросок на позднюю, где она тоже участница, — уходит из ранней', () => {
    const map = twoRooms();
    // Карта до правила одной комнаты: s-01 состоит и в r-01 (ведущий), и в r-02.
    (map.rooms[1] as Room).members.push('s-01');
    const message = addMember(map, 'r-02', 's-01', NOW);

    // В целевой комнате запись одна, а не две: `members` не дублируется.
    expect(map.rooms[1]?.members).toEqual(['s-03', 's-01']);
    // Из ранней ушла вместе с ролью ведущего.
    expect(map.rooms[0]).toMatchObject({ members: ['s-02'], lead: null });
    expect(map.rooms.filter((room) => isMember(room, 's-01')).map((room) => room.id)).toEqual(['r-02']);
    expect(message).toMatchObject({ roomId: 'r-02', from: SYSTEM, text: '@s01 joined the room', at: NOW });
  });

  it('создатель-сессия целевой комнаты, состоящая ещё и в другой, — уходит из другой, в members не пишется', () => {
    const map = emptyMap();
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'своя', creator: 's-01', members: ['s-02'], lead: 's-01' });
    addRoom(map, { title: 'чужая', creator: HUMAN, members: ['s-01', 's-03'] });

    const message = addMember(map, 'r-01', 's-01');

    expect(map.rooms[0]).toMatchObject({ creator: 's-01', members: ['s-02'], lead: 's-01' });
    expect(map.rooms[1]?.members).toEqual(['s-03']);
    expect(message.text).toBe('@s01 joined the room');
  });

  it('участник только этой комнаты — «уже участник», а с ним и создатель-сессия: карта не тронута', () => {
    const map = emptyMap();
    for (const label of ['a', 'b']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'своя', creator: 's-01', members: ['s-02'] });
    const before = JSON.stringify(map);

    expect(() => addMember(map, 'r-01', 's-02')).toThrow(/уже участник/);
    expect(() => addMember(map, 'r-01', 's-01')).toThrow(/уже участник/);
    expect(JSON.stringify(map)).toBe(before);
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

describe('addMemberByLead', () => {
  const NOW = '2026-09-29T12:00:00.000Z';

  it('ведущий вводит сессию: последней в members, системное «@s04 joined the room»', () => {
    const map = twoRooms();
    const message = addMemberByLead(map, 'r-01', 's-01', 's-04', NOW);

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
    // Письма о добавлении новый участник не получает: строка адресована человеку.
    expect(unreadFor(map, 's-04')).toEqual([]);
  });

  it('одна комната на сессию: введённая уходит из прочих комнат работы', () => {
    const map = twoRooms();
    addMemberByLead(map, 'r-01', 's-01', 's-03');

    expect(map.rooms[0]?.members).toEqual(['s-01', 's-02', 's-03']);
    expect(map.rooms[1]?.members).toEqual([]);
  });

  it('не ведущий — RoomRuleError, карта не тронута: участник, посторонний и человек', () => {
    const map = twoRooms();
    const before = JSON.stringify(map);

    for (const caller of ['s-02', 's-04', HUMAN]) {
      expect(() => addMemberByLead(map, 'r-01', caller, 's-03'), caller).toThrow(RoomRuleError);
      expect(() => addMemberByLead(map, 'r-01', caller, 's-03'), caller).toThrow(/не ведущий/);
    }
    expect(JSON.stringify(map)).toBe(before);
  });

  it('ведущий — живой ведущий: без назначенного им считается первый из members, закрытого — первый живой', () => {
    const byDefault = twoRooms();
    // r-02 без назначенного ведущего: ведёт первый из members.
    expect(() => addMemberByLead(byDefault, 'r-02', 's-03', 's-04')).not.toThrow();
    expect(byDefault.rooms[1]?.members).toEqual(['s-03', 's-04']);

    const replaced = twoRooms();
    transitionSession(replaced, 's-01', 'closed');
    // Назначенный s-01 закрыт: право за первым живым участником — s-02, а не за самим s-01.
    expect(() => addMemberByLead(replaced, 'r-01', 's-01', 's-04')).toThrow(/не ведущий/);
    expect(() => addMemberByLead(replaced, 'r-01', 's-02', 's-04')).not.toThrow();
  });

  it('закрытая комната — отказ «закрыта», а не «не ведущий»: ведущего у неё нет', () => {
    const map = twoRooms();
    transitionSession(map, 's-01', 'closed');
    transitionSession(map, 's-02', 'closed');
    const before = JSON.stringify(map);

    expect(() => addMemberByLead(map, 'r-01', 's-01', 's-04')).toThrow(RoomRuleError);
    expect(() => addMemberByLead(map, 'r-01', 's-01', 's-04')).toThrow(/закрыта/);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('закрытая и чужая сессия, уже участник и неизвестная комната — RoomRuleError, карта не тронута', () => {
    const map = twoRooms();
    transitionSession(map, 's-04', 'closed');
    const before = JSON.stringify(map);

    const cases: Array<[() => unknown, RegExp]> = [
      [() => addMemberByLead(map, 'r-01', 's-01', 's-04'), /закрыта/],
      // Чужая — нет в карте этой работы.
      [() => addMemberByLead(map, 'r-01', 's-01', 's-77'), /нет в карте/],
      [() => addMemberByLead(map, 'r-01', 's-01', HUMAN), /нет в карте/],
      [() => addMemberByLead(map, 'r-01', 's-01', 's-02'), /уже участник/],
      // Ведущий вводит и самого себя: он уже участник.
      [() => addMemberByLead(map, 'r-01', 's-01', 's-01'), /уже участник/],
      [() => addMemberByLead(map, 'r-09', 's-01', 's-03'), /нет в карте/],
    ];
    for (const [call, message] of cases) {
      expect(call).toThrow(RoomRuleError);
      expect(call).toThrow(message);
    }
    expect(JSON.stringify(map)).toBe(before);
  });
});

describe('addRoomOriginMessage', () => {
  const NOW = '2026-09-29T12:00:00.000Z';

  it('системная строка «Room created from @s03 and @s02» — в порядке origin, для человека', () => {
    const map = twoRooms();
    const line = addRoomOriginMessage(map, 'r-01', ['s-03', 's-02'], NOW);

    expect(line).toMatchObject({
      roomId: 'r-01',
      from: SYSTEM,
      to: [HUMAN],
      kind: 'note',
      text: 'Room created from @s03 and @s02',
      at: NOW,
    });
    expect(map.messages).toEqual([line]);
  });

  it('строка никого не будит и человеку непрочитанной не значится, как и «joined the room»', () => {
    const map = twoRooms();
    const line = addRoomOriginMessage(map, 'r-01', ['s-01', 's-02'], NOW);

    for (const id of ['s-01', 's-02', 's-03', 's-04']) expect(unreadFor(map, id)).toEqual([]);
    expect(line.readBy).toEqual({ [HUMAN]: NOW });
  });
});
