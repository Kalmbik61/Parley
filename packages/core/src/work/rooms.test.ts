import { describe, expect, it } from 'vitest';
import { unreadFor } from './letters.js';
import { addMessage, addSession, parseMap, removeSession, setResult, transitionSession } from './map.js';
import { reservePlanEffects } from './plan-effects.js';
import { activeRoomPlan, cancelRoomPlan, setRoomMode, updatePlanItem } from './plans.js';
import { proposeCompletion, resolveProposal, setProposal } from './proposals.js';
import {
  addMember,
  addMemberByLead,
  addRoom,
  addRoomArchivedLetters,
  addRoomOriginMessage,
  addSystemMessage,
  archiveRoom,
  deleteRoom,
  isDescendant,
  isMember,
  isRoomArchived,
  isRoomClosed,
  joinNotice,
  leaveOtherRooms,
  liveLead,
  nextRoomId,
  renameRoom,
  renameSession,
  reopenRoom,
  requireOpenRoom,
  roomLead,
  RoomRuleError,
  setRoomLead,
} from './rooms.js';
import { HUMAN, PARLEY, SYSTEM, type Room, type WorkMap } from './types.js';

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
    map.rooms.push({ id: 'r-01', title: 'x', creator: 's-01', members: [], createdAt: '', lead: null, proposal: null, archivedAt: null });
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
      mode: 'free',
      proposal: null,
      recipe: null,
      archivedAt: null,
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
    archivedAt: null,
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

    expect(joinNotice(room, map)).toBe('You were added to r-01 "бэкенд" with S02 and S03');
  });

  it('один участник — без «и»', () => {
    const map = emptyMap();
    const room = addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-02'] });

    expect(joinNotice(room, map)).toBe('You were added to r-01 "бэкенд" with S02');
  });

  it('удалённый участник помечен отдельно', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addSession(map, { provider: 'claude', label: 'b', task: 'x' });
    removeSession(map, 's-02');
    const room = addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-01', 's-02'] });

    expect(joinNotice(room, map)).toBe('You were added to r-01 "бэкенд" with S01 and S02 (deleted)');
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
    archivedAt: null,
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

    expect(() => addMember(map, 'r-01', 's-02')).toThrow(/already a participant/);
    expect(() => addMember(map, 'r-01', 's-01')).toThrow(/already a participant/);
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
      [() => addMember(map, 'r-01', 's-02'), /already a participant/],
      [() => addMember(map, 'r-01', 's-04'), /is closed/],
      [() => addMember(map, 'r-01', 's-09'), /is not in the map/],
      [() => addMember(map, 'r-09', 's-03'), /is not in the map/],
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
      expect(() => addMemberByLead(map, 'r-01', caller, 's-03'), caller).toThrow(/not the lead/);
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
    expect(() => addMemberByLead(replaced, 'r-01', 's-01', 's-04')).toThrow(/not the lead/);
    expect(() => addMemberByLead(replaced, 'r-01', 's-02', 's-04')).not.toThrow();
  });

  it('закрытая комната — отказ «закрыта», а не «не ведущий»: ведущего у неё нет', () => {
    const map = twoRooms();
    transitionSession(map, 's-01', 'closed');
    transitionSession(map, 's-02', 'closed');
    const before = JSON.stringify(map);

    expect(() => addMemberByLead(map, 'r-01', 's-01', 's-04')).toThrow(RoomRuleError);
    expect(() => addMemberByLead(map, 'r-01', 's-01', 's-04')).toThrow(/is closed/);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('закрытая и чужая сессия, уже участник и неизвестная комната — RoomRuleError, карта не тронута', () => {
    const map = twoRooms();
    transitionSession(map, 's-04', 'closed');
    const before = JSON.stringify(map);

    const cases: Array<[() => unknown, RegExp]> = [
      [() => addMemberByLead(map, 'r-01', 's-01', 's-04'), /is closed/],
      // Чужая — нет в карте этой работы.
      [() => addMemberByLead(map, 'r-01', 's-01', 's-77'), /is not in the map/],
      [() => addMemberByLead(map, 'r-01', 's-01', HUMAN), /is not in the map/],
      [() => addMemberByLead(map, 'r-01', 's-01', 's-02'), /already a participant/],
      // Ведущий вводит и самого себя: он уже участник.
      [() => addMemberByLead(map, 'r-01', 's-01', 's-01'), /already a participant/],
      [() => addMemberByLead(map, 'r-09', 's-01', 's-03'), /is not in the map/],
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

describe('addRoom: снимок рецепта', () => {
  const recipe = { id: 'project:pay', name: 'Payments', playbook: 'Lead playbook' };

  it('снимок копируется: правка исходного объекта комнату не меняет', () => {
    const map = emptyMap();
    const source = { ...recipe };
    const room = addRoom(map, { title: 'x', creator: HUMAN, members: [], recipe: source });
    source.playbook = 'changed later';
    source.name = 'Other';
    expect(room.recipe).toEqual(recipe);
  });

  it('без рецепта — recipe: null', () => {
    expect(addRoom(emptyMap(), { title: 'x', creator: HUMAN, members: [] }).recipe).toBeNull();
  });

  it('снимок переживает запись на диск и чтение', () => {
    const map = emptyMap();
    addRoom(map, { title: 'x', creator: HUMAN, members: [], recipe });
    expect(parseMap(JSON.stringify(map), 'map.json').rooms[0]?.recipe).toEqual(recipe);
  });

  it('старая карта без поля recipe читается как комната без рецепта', () => {
    const map = emptyMap();
    const room = addRoom(map, { title: 'x', creator: HUMAN, members: [] });
    const raw = JSON.parse(JSON.stringify(map)) as { rooms: Record<string, unknown>[] };
    delete raw.rooms[0]?.['recipe'];
    expect(parseMap(JSON.stringify(raw), 'map.json').rooms[0]).toEqual({ ...room, recipe: null });
  });

  it('снимок неверной формы — отказ чтения карты', () => {
    const map = emptyMap();
    addRoom(map, { title: 'x', creator: HUMAN, members: [], recipe });
    for (const bad of [{ ...recipe, extra: 1 }, { id: 'a', name: 'b' }, { ...recipe, name: '' }, { ...recipe, playbook: 5 }, 'text']) {
      const raw = JSON.parse(JSON.stringify(map)) as { rooms: Record<string, unknown>[] };
      raw.rooms[0]!['recipe'] = bad;
      expect(() => parseMap(JSON.stringify(raw), 'map.json')).toThrow('invalid room recipe');
    }
  });
});

describe('renameRoom', () => {
  it('края обрезаются, как у названия работы: пробелы и невидимые символы формата', () => {
    const map = twoRooms();
    renameRoom(map, 'r-01', '  \u200BПлатежи и возвраты\u2060 ');
    expect(map.rooms[0]?.title).toBe('Платежи и возвраты');
    // Системной строки нет: название — не событие ленты.
    expect(map.messages).toEqual([]);
  });

  it('пустое, из пробелов или из одних ZWSP — отказ, прежнее название остаётся; нет комнаты — отказ', () => {
    const map = twoRooms();
    const before = JSON.stringify(map);
    for (const title of ['', '   ', '\u200B\u200B']) {
      expect(() => renameRoom(map, 'r-01', title)).toThrow(RoomRuleError);
    }
    expect(() => renameRoom(map, 'r-09', 'x')).toThrow(/is not in the map/);
    expect(JSON.stringify(map)).toBe(before);
  });
});

describe('renameSession', () => {
  it('края обрезаются, как у комнаты: пробелы и невидимые символы формата; системной строки нет', () => {
    const map = twoRooms();
    renameSession(map, 's-02', '  \u200BRuslan Backend\u2060 ');
    expect(map.sessions[1]?.label).toBe('Ruslan Backend');
    // Остальные сессии и комнаты не тронуты, в ленте ничего не появилось.
    expect(map.sessions.map((session) => session.label)).toEqual(['архитектор', 'Ruslan Backend', 'ревью', 'тесты']);
    expect(map.rooms.map((room) => room.title)).toEqual(['Возвраты', 'Ревью']);
    expect(map.messages).toEqual([]);
  });

  it('пустое, из пробелов или из одних ZWSP — отказ, прежнее имя остаётся; нет сессии — отказ', () => {
    const map = twoRooms();
    const before = JSON.stringify(map);
    for (const label of ['', '   ', '\u200B\u200B']) {
      expect(() => renameSession(map, 's-02', label)).toThrow(RoomRuleError);
    }
    expect(() => renameSession(map, 's-09', 'x')).toThrow(/is not in the map/);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('закрытую сессию тоже можно переименовать: строка в сайдбаре остаётся', () => {
    const map = twoRooms();
    transitionSession(map, 's-03', 'closed');

    renameSession(map, 's-03', 'Reviewer');

    expect(map.sessions[2]).toMatchObject({ label: 'Reviewer', lifecycle: 'closed' });
  });

  it('сессия-участник комнаты остаётся участником: меняется только ярлык', () => {
    const map = twoRooms();
    renameSession(map, 's-01', 'Lead');
    expect(map.rooms[0]?.members).toEqual(['s-01', 's-02']);
    expect(map.rooms[0]?.lead).toBe('s-01');
  });
});

describe('setRoomLead', () => {
  const NOW = '2026-10-07T12:00:00.000Z';

  it('участник становится ведущим: строка человеку, письма parley новому и прежнему ведущему в комнате', () => {
    const map = twoRooms();
    const { line, letters } = setRoomLead(map, 'r-01', 's-02', NOW);

    expect(map.rooms[0]?.lead).toBe('s-02');
    expect(liveLead(map, map.rooms[0] as Room)).toBe('s-02');
    expect(line).toMatchObject({ roomId: 'r-01', from: SYSTEM, to: [HUMAN], text: '@s02 is now the lead', readBy: { [HUMAN]: NOW } });
    expect(letters).toHaveLength(2);
    expect(letters[0]).toMatchObject({
      roomId: 'r-01',
      from: PARLEY,
      to: ['s-02'],
      kind: 'note',
      text: 'You now lead room r-01 "Возвраты": the human made you the lead. Collect the participants\' positions and bring the human a decision with propose_decision (read_guide topic: lead).',
    });
    expect(letters[1]).toMatchObject({
      roomId: 'r-01',
      from: PARLEY,
      to: ['s-01'],
      text: '@s02 now leads room r-01 "Возвраты": the human changed the lead. You are a regular participant now (read_guide topic: member).',
    });
    // Агентам письма непрочитаны — их поднимет будильник; человеку о своём действии «нового» нет.
    expect(unreadFor(map, 's-02')).toEqual([letters[0]]);
    expect(unreadFor(map, 's-01')).toEqual([letters[1]]);
    expect(letters.every((letter) => letter.readBy[HUMAN] === NOW)).toBe(true);
  });

  it('создатель-сессия может стать ведущим; ведущий-подменщик закрытого получает письмо как прежний', () => {
    const map = emptyMap();
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'своя', creator: 's-01', members: ['s-02', 's-03'], lead: 's-02' });
    transitionSession(map, 's-02', 'closed');
    // Назначенный s-02 закрыт — ведёт первый живой из members, s-03.
    expect(liveLead(map, map.rooms[0] as Room)).toBe('s-03');

    const { letters } = setRoomLead(map, 'r-01', 's-01', NOW);
    expect(map.rooms[0]?.lead).toBe('s-01');
    expect(letters.map((letter) => letter.to)).toEqual([['s-01'], ['s-03']]);
  });

  it('ждущее решение прежнего ведущего остаётся в слоте', () => {
    const map = twoRooms();
    const { proposalId } = setProposal(map, 'r-01', 's-01', 'План', NOW);
    setRoomLead(map, 'r-01', 's-02', NOW);
    expect(map.rooms[0]?.proposal).toMatchObject({ id: proposalId, from: 's-01', text: 'План' });
  });

  it('не участник, человек, закрытая, неизвестная сессия и комната, уже ведущий — RoomRuleError, карта не тронута', () => {
    const map = twoRooms();
    addMember(map, 'r-01', 's-04', NOW);
    transitionSession(map, 's-04', 'closed');
    const before = JSON.stringify(map);

    const cases: Array<[string, string, RegExp]> = [
      ['r-01', 's-03', /not a participant/],
      ['r-01', HUMAN, /not a participant/],
      ['r-01', 's-04', /is closed/],
      ['r-01', 's-09', /not a participant/],
      ['r-09', 's-02', /is not in the map/],
      ['r-01', 's-01', /already leads/],
      // Ведущий по записи без `lead` — первый из members: он «уже ведущий».
      ['r-02', 's-03', /already leads/],
    ];
    for (const [roomId, sessionId, message] of cases) {
      expect(() => setRoomLead(map, roomId, sessionId, NOW)).toThrow(RoomRuleError);
      expect(() => setRoomLead(map, roomId, sessionId, NOW)).toThrow(message);
    }
    expect(JSON.stringify(map)).toBe(before);
  });
});

describe('deleteRoom', () => {
  const NOW = '2026-10-07T12:00:00.000Z';

  /** Две комнаты из `twoRooms`, живые s-01 (active) и s-02 (sleeping); s-03, s-04 не запущены. Лента и письма. */
  function roomsWithFeed(): WorkMap {
    const map = twoRooms();
    transitionSession(map, 's-01', 'active');
    transitionSession(map, 's-02', 'active');
    transitionSession(map, 's-02', 'sleeping');
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'задача' });
    addMessage(map, { from: 's-01', to: ['s-03'], text: 'прямое' });
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-02', text: 'другая' });
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'позиция' });
    return map;
  }

  it('уходят комната, её лента и решение; прочее остаётся; живым участникам — прямое письмо parley', () => {
    const map = roomsWithFeed();
    setProposal(map, 'r-01', 's-01', 'План', NOW);
    const letters = deleteRoom(map, 'r-01', NOW);

    expect(map.rooms.map((room) => room.id)).toEqual(['r-02']);
    expect(map.messages.slice(0, 2).map((message) => message.text)).toEqual(['прямое', 'другая']);
    expect(letters.map((letter) => letter.to)).toEqual([['s-01'], ['s-02']]);
    for (const letter of letters) {
      expect(letter).toMatchObject({
        roomId: null,
        from: PARLEY,
        kind: 'note',
        text: 'The human deleted room r-01 "Возвраты": you now work as a regular session of this workspace.',
      });
    }
    expect(map.messages.slice(2)).toEqual(letters);
    expect(unreadFor(map, 's-01')).toEqual([letters[0]]);
    // Сессии остались в карте обычными сессиями работы.
    expect(map.sessions.map((session) => session.id)).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(() => parseMap(JSON.stringify(map), 'map.json')).not.toThrow();
  });

  it('архивная комната: прощальное письмо только работающему — спящего, усыплённого архивацией, оно не будит', () => {
    const map = roomsWithFeed();
    archiveRoom(map, 'r-01', NOW);
    const letters = deleteRoom(map, 'r-01', NOW);

    expect(letters.map((letter) => letter.to)).toEqual([['s-01']]);
    expect(unreadFor(map, 's-02')).toEqual([]);
  });

  it('не запущенный, закрытый и состоящий в другой комнате (старая карта) участник письма не получает', () => {
    const map = roomsWithFeed();
    addMember(map, 'r-01', 's-04', NOW);
    transitionSession(map, 's-02', 'closed');
    // Старая карта: s-01 числится и в r-02.
    (map.rooms[1] as Room).members.push('s-01');

    expect(deleteRoom(map, 'r-01', NOW)).toEqual([]);
  });

  it('номера комнаты, писем и решения не переиспользуются', () => {
    const map = roomsWithFeed();
    setProposal(map, 'r-01', 's-01', 'План', NOW);
    deleteRoom(map, 'r-02', NOW);
    const letters = deleteRoom(map, 'r-01', NOW);
    // В карте осталось одно письмо m-02, а по одному списку письма parley получили бы m-03 и m-04 — id ушедших.
    expect(map.messages.map((message) => message.id)).toEqual(['m-02', 'm-05', 'm-06']);
    expect(letters.map((letter) => letter.id)).toEqual(['m-05', 'm-06']);
    expect(addMessage(map, { from: HUMAN, to: ['s-01'], text: 'ещё' }).id).toBe('m-07');
    expect(addRoom(map, { title: 'новая', creator: HUMAN, members: ['s-01'] }).id).toBe('r-03');
    expect(setProposal(map, 'r-03', 's-01', 'Новое', NOW).proposalId).toBe('p-02');
    expect(parseMap(JSON.stringify(map), 'map.json').work.messageSeq).toBe(4);
  });

  it('план комнаты, его доставка и счётчик ресурсов уходят; снятые копии для .parley остаются; карта читается', () => {
    const map = roomsWithFeed();
    transitionSession(map, 's-03', 'active');
    addRoom(map, { title: 'План', creator: HUMAN, members: ['s-03', 's-04'], lead: 's-03', mode: 'checklist' });
    const plan = { mode: 'checklist' as const, goal: 'Готово', items: [{ id: 1, title: 'Пункт', owner: 's-03', scope: 'src/a.ts' }] };
    const proposal = setProposal(map, 'r-03', 's-03', 'Решение', NOW, { plan });
    resolveProposal(map, 'r-03', proposal.proposalId, 'accept', { rev: 0, planId: map.rooms[2]!.proposal!.plan!.id, planRev: 0 }, NOW);
    reservePlanEffects(map, 20, NOW);
    map.resources = {
      seq: 2,
      spawned: 2,
      spawnedByRoom: { 'r-03': 1, 'r-01': 1 },
      attempts: [
        { id: 'a-0001', kind: 'spawn', state: 'spent', at: NOW, actor: 's-03', session: 's-04', room: 'r-03', owner: 'o' },
        { id: 'a-0002', kind: 'spawn', state: 'spent', at: NOW, actor: 's-01', session: 's-02', room: 'r-01', owner: 'o' },
      ],
    };
    expect(map.plans).toHaveLength(1);
    expect(map.planEffects?.length).toBeGreaterThan(0);
    const exports = { plans: map.planExports, decisions: map.decisionExports };
    expect(exports.plans?.length).toBeGreaterThan(0);
    expect(exports.decisions?.length).toBeGreaterThan(0);

    deleteRoom(map, 'r-03', NOW);

    expect(map.plans).toEqual([]);
    expect(map.planEffects).toEqual([]);
    expect({ plans: map.planExports, decisions: map.decisionExports }).toEqual(exports);
    expect(map.work.planSeq).toBe(1);
    expect(map.resources.spawnedByRoom).toEqual({ 'r-01': 1 });
    expect(map.resources.attempts.map((attempt) => attempt.room)).toEqual([null, 'r-01']);
    // Без плана карта иначе не прошла бы проверку `validatePlanStorage`.
    expect(() => parseMap(JSON.stringify(map), 'map.json')).not.toThrow();
  });

  it('нет комнаты — RoomRuleError, карта не тронута', () => {
    const map = roomsWithFeed();
    const before = JSON.stringify(map);
    expect(() => deleteRoom(map, 'r-09', NOW)).toThrow(RoomRuleError);
    expect(JSON.stringify(map)).toBe(before);
  });
});

describe('requireOpenRoom и isRoomArchived', () => {
  const NOW = '2026-10-08T12:00:00.000Z';
  const REFUSAL = 'room r-01 is archived: only the human can reopen it';

  it('открытая комната возвращается; архивная — RoomRuleError с текстом из спеки; нет комнаты — отказ, как у соседей', () => {
    const map = twoRooms();
    expect(requireOpenRoom(map, 'r-01')).toBe(map.rooms[0]);

    archiveRoom(map, 'r-01', NOW);
    expect(() => requireOpenRoom(map, 'r-01')).toThrow(RoomRuleError);
    expect(() => requireOpenRoom(map, 'r-01')).toThrow(REFUSAL);
    expect(requireOpenRoom(map, 'r-02')).toBe(map.rooms[1]);
    expect(() => requireOpenRoom(map, 'r-09')).toThrow(/room r-09 is not in the map/);
  });

  it('комната из литерала без archivedAt (карта не через parseMap) открытая, а не архивная', () => {
    const legacy = { id: 'r-01', title: 'x', creator: HUMAN, members: [], createdAt: '', lead: null, proposal: null } as unknown as Room;
    expect(isRoomArchived(legacy)).toBe(false);
    expect(isRoomArchived({ ...legacy, archivedAt: null })).toBe(false);
    expect(isRoomArchived({ ...legacy, archivedAt: NOW })).toBe(true);
  });
});

/** Три сессии и комната r-01 «План» (checklist) человека: ведущий s-01, пункты у s-02 и s-03. Решение принято. */
function planRoomMap(): WorkMap {
  const map = emptyMap();
  for (const label of ['ведущий', 'первый', 'второй']) {
    addSession(map, { provider: 'claude', label, task: 'x' });
  }
  addRoom(map, { title: 'План', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01', mode: 'checklist' });
  const plan = {
    mode: 'checklist' as const,
    goal: 'Готово',
    items: [
      { id: 1, title: 'Первый', owner: 's-02', scope: 'src/a.ts' },
      { id: 2, title: 'Второй', owner: 's-03', scope: 'src/b.ts' },
    ],
  };
  const proposal = setProposal(map, 'r-01', 's-01', 'Решение', '2026-10-08T12:00:00.000Z', { plan });
  resolveProposal(map, 'r-01', proposal.proposalId, 'accept', { rev: 0, planId: map.rooms[0]!.proposal!.plan!.id, planRev: 0 }, '2026-10-08T12:00:00.000Z');
  return map;
}

describe('archiveRoom', () => {
  const NOW = '2026-10-08T12:00:00.000Z';
  const LATER = '2026-10-08T13:00:00.000Z';

  it('ставит archivedAt, пишет одну системную строку человеку и оставляет ленту нетронутой', () => {
    const map = twoRooms();
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'задача' });
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'позиция' });
    const before = map.messages.map((message) => ({ ...message }));

    archiveRoom(map, 'r-01', NOW);

    expect(map.rooms[0]).toMatchObject({ id: 'r-01', archivedAt: NOW });
    expect(map.rooms[1]?.archivedAt).toBeNull();
    expect(map.messages.slice(0, 2)).toEqual(before);
    expect(map.messages).toHaveLength(3);
    expect(map.messages[2]).toMatchObject({
      roomId: 'r-01',
      from: SYSTEM,
      to: [HUMAN],
      kind: 'note',
      text: 'Room archived by the human.',
      at: NOW,
    });
    expect(map.messages[2]?.readBy[HUMAN]).toBe(NOW);
  });

  it('очищает слот решения без ответа и письма ведущему не пишет', () => {
    const map = twoRooms();
    setProposal(map, 'r-01', 's-01', 'План', NOW);

    archiveRoom(map, 'r-01', LATER);

    expect(map.rooms[0]?.proposal).toBeNull();
    expect(map.messages.map((message) => message.text)).toEqual(['Room archived by the human.']);
  });

  it('отменяет живой план, снимает доставки в очереди и ждущую правку; новых писем доставка не шлёт', () => {
    const map = planRoomMap();
    // Лимит один: доставка первого пункта ушла письмом, второго осталась в очереди.
    reservePlanEffects(map, 1, NOW);
    expect(map.planEffects?.map((effect) => effect.status)).toEqual(['sent', 'queued']);
    const plan = map.plans![0]!;
    setProposal(map, 'r-01', 's-01', 'Правка плана', NOW, {
      plan: { mode: 'checklist', goal: 'Другая цель', items: plan.items.map(({ id, title, owner, scope }) => ({ id, title, owner, scope })), id: plan.id, rev: plan.rev },
    });
    expect(map.rooms[0]?.proposal).not.toBeNull();

    archiveRoom(map, 'r-01', LATER);

    expect(map.plans![0]).toMatchObject({ status: 'cancelled', cancelledAt: LATER });
    expect(activeRoomPlan(map, 'r-01')).toBeUndefined();
    expect(map.planEffects?.map((effect) => effect.status)).toEqual(['sent', 'cancelled']);
    expect(map.rooms[0]).toMatchObject({ proposal: null, archivedAt: LATER });
    // Порядок: сначала отмена плана, потом строка об архивации, и только потом ставится archivedAt.
    expect(map.messages.slice(-2).map((message) => message.text)).toEqual([`Plan ${plan.id} cancelled`, 'Room archived by the human.']);

    const count = map.messages.length;
    reservePlanEffects(map, 20, LATER);
    expect(map.messages).toHaveLength(count);
    expect(() => parseMap(JSON.stringify(map), 'map.json')).not.toThrow();
  });

  it('возвращает сессии, которых архивация оставила без открытой комнаты; человек и неизвестные id не входят', () => {
    const map = twoRooms();
    expect(archiveRoom(map, 'r-01', NOW)).toEqual(['s-01', 's-02']);

    // Создатель-сессия тоже участник; удалённая из карты сессия не входит.
    const agents = emptyMap();
    for (const label of ['создатель', 'участник', 'удалённый']) {
      addSession(agents, { provider: 'claude', label, task: 'x' });
    }
    addRoom(agents, { title: 'агентская', creator: 's-01', members: ['s-02', 's-03'], lead: 's-01' });
    removeSession(agents, 's-03');
    expect(archiveRoom(agents, 'r-01', NOW)).toEqual(['s-01', 's-02']);
  });

  it('сессия другой открытой комнаты (старая карта) остаётся; другая архивная комната её не держит', () => {
    const map = twoRooms();
    // Старая карта: s-02 числится и в r-02.
    (map.rooms[1] as Room).members.push('s-02');

    expect(archiveRoom(map, 'r-02', NOW)).toEqual(['s-03']);
    // r-02 теперь в архиве, и s-02 осталась без открытой комнаты, когда уходит и r-01.
    expect(archiveRoom(map, 'r-01', NOW)).toEqual(['s-01', 's-02']);
  });

  it('повторный вызов ничего не меняет, не пишет вторую строку и отдаёт пустой список', () => {
    const map = twoRooms();
    expect(archiveRoom(map, 'r-01', NOW)).toEqual(['s-01', 's-02']);
    const after = JSON.stringify(map);

    expect(archiveRoom(map, 'r-01', LATER)).toEqual([]);
    expect(JSON.stringify(map)).toBe(after);
    expect(map.messages.filter((message) => message.text === 'Room archived by the human.')).toHaveLength(1);
  });

  it('нет комнаты — RoomRuleError, карта не тронута', () => {
    const map = twoRooms();
    const before = JSON.stringify(map);
    expect(() => archiveRoom(map, 'r-09', NOW)).toThrow(RoomRuleError);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('карта с архивной комнатой читается, а archivedAt переживает круг запись → чтение', () => {
    const map = planRoomMap();
    archiveRoom(map, 'r-01', NOW);
    expect(parseMap(JSON.stringify(map), 'map.json').rooms[0]?.archivedAt).toBe(NOW);
  });

  describe('писать в архивную комнату нельзя, читать и убирать можно', () => {
    const REFUSAL = /room r-01 is archived: only the human can reopen it/;

    function archived(): WorkMap {
      const map = twoRooms();
      addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'позиция' });
      archiveRoom(map, 'r-01', NOW);
      return map;
    }

    it('входы в комнату, ведущий, решение, режим и завершение плана отказывают RoomRuleError', () => {
      const map = archived();
      const writes: [string, () => unknown][] = [
        ['addMember', () => addMember(map, 'r-01', 's-04')],
        ['addMemberByLead', () => addMemberByLead(map, 'r-01', 's-01', 's-04')],
        ['setRoomLead', () => setRoomLead(map, 'r-01', 's-02')],
        ['setProposal', () => setProposal(map, 'r-01', 's-01', 'решение')],
        ['resolveProposal', () => resolveProposal(map, 'r-01', 'p-01', 'accept')],
        ['setRoomMode', () => setRoomMode(map, 'r-01', HUMAN, 'checklist', 'причина')],
        ['proposeCompletion', () => proposeCompletion(map, 'r-01', 's-01', 'pl-01', 0, 'итог')],
      ];
      const before = JSON.stringify(map);
      for (const [name, write] of writes) {
        expect(write, name).toThrow(RoomRuleError);
        expect(write, name).toThrow(REFUSAL);
      }
      expect(JSON.stringify(map)).toBe(before);
    });

    it('шаги плана архивной комнаты отказывают причиной архива, а не «план изменился»', () => {
      const map = planRoomMap();
      archiveRoom(map, 'r-01', NOW);
      const plan = map.plans![0]!;
      expect(() => updatePlanItem(map, plan.id, plan.rev, 1, 's-02', 'in_progress')).toThrow(REFUSAL);
      expect(() => cancelRoomPlan(map, plan.id, plan.rev, HUMAN)).toThrow(REFUSAL);
    });

    it('переименование, удаление и служебные строки проходят', () => {
      const map = archived();
      renameRoom(map, 'r-01', 'Новое имя');
      expect(map.rooms[0]?.title).toBe('Новое имя');

      const line = addSystemMessage(map, 'r-01', 'служебная строка', LATER);
      expect(line).toMatchObject({ roomId: 'r-01', text: 'служебная строка' });
      const letter = addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'от человека' });
      expect(letter.roomId).toBe('r-01');

      deleteRoom(map, 'r-01', LATER);
      expect(map.rooms.map((room) => room.id)).toEqual(['r-02']);
    });

    it('правило одной комнаты не меняется: вошедшая в новую комнату сессия молча уходит из архивной', () => {
      const map = archived();
      const feed = map.messages.filter((message) => message.roomId === 'r-01').map((message) => message.id);

      addMember(map, 'r-02', 's-01', LATER);

      expect(map.rooms[0]?.members).toEqual(['s-02']);
      expect(map.rooms[0]?.archivedAt).toBe(NOW);
      expect(map.messages.filter((message) => message.roomId === 'r-01').map((message) => message.id)).toEqual(feed);
    });
  });
});

describe('reopenRoom', () => {
  const NOW = '2026-10-08T12:00:00.000Z';
  const LATER = '2026-10-08T13:00:00.000Z';

  it('снимает архив, пишет строку человеку; сессии не поднимаются, участники остаются; писать снова можно', () => {
    const map = twoRooms();
    archiveRoom(map, 'r-01', NOW);
    const lifecycles = map.sessions.map((session) => session.lifecycle);

    reopenRoom(map, 'r-01', LATER);

    expect(map.rooms[0]).toMatchObject({ archivedAt: null, members: ['s-01', 's-02'] });
    expect(map.messages.at(-1)).toMatchObject({
      roomId: 'r-01',
      from: SYSTEM,
      to: [HUMAN],
      text: 'Room reopened by the human.',
      at: LATER,
    });
    expect(map.messages.at(-1)?.readBy[HUMAN]).toBe(LATER);
    expect(map.sessions.map((session) => session.lifecycle)).toEqual(lifecycles);
    expect(requireOpenRoom(map, 'r-01')).toBe(map.rooms[0]);
    expect(addMember(map, 'r-01', 's-04', LATER).roomId).toBe('r-01');
  });

  it('письма, не прочитанные до архивации, после возврата непрочитанными не становятся — спящих не будят', () => {
    const map = twoRooms();
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'рассылка' }, NOW);
    expect(unreadFor(map, 's-02')).toHaveLength(1);
    archiveRoom(map, 'r-01', NOW);
    reopenRoom(map, 'r-01', LATER);
    expect(unreadFor(map, 's-02')).toEqual([]);
    expect(unreadFor(map, 's-01')).toEqual([]);
    // Новое письмо после возврата — снова обычное непрочитанное.
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'после возврата' }, LATER);
    expect(unreadFor(map, 's-02').map((message) => message.text)).toEqual(['после возврата']);
  });

  it('открытая комната — ничего не меняет и строки не пишет', () => {
    const map = twoRooms();
    const before = JSON.stringify(map);
    reopenRoom(map, 'r-01', LATER);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('нет комнаты — RoomRuleError', () => {
    expect(() => reopenRoom(twoRooms(), 'r-09', LATER)).toThrow(RoomRuleError);
  });

  it('план, отменённый архивацией, не воскресает', () => {
    const map = planRoomMap();
    archiveRoom(map, 'r-01', NOW);
    reopenRoom(map, 'r-01', LATER);

    expect(activeRoomPlan(map, 'r-01')).toBeUndefined();
    expect(map.plans![0]?.status).toBe('cancelled');
  });

  it('после возврата комнату можно архивировать снова: вторая строка в ленте', () => {
    const map = twoRooms();
    archiveRoom(map, 'r-01', NOW);
    reopenRoom(map, 'r-01', LATER);

    expect(archiveRoom(map, 'r-01', LATER)).toEqual(['s-01', 's-02']);
    expect(map.messages.filter((message) => message.text === 'Room archived by the human.')).toHaveLength(2);
  });
});

describe('addRoomArchivedLetters', () => {
  const NOW = '2026-10-08T12:00:00.000Z';
  const LATER = '2026-10-08T13:00:00.000Z';
  const TEXT = 'Room "Возвраты" was archived by the human. You are no longer in an open room.';

  /** Комната «Возвраты» {s-01, s-02} в архиве: s-01 работает, s-02 спит. */
  function archived(): { map: WorkMap; orphans: string[] } {
    const map = twoRooms();
    transitionSession(map, 's-01', 'active');
    transitionSession(map, 's-02', 'active');
    transitionSession(map, 's-02', 'sleeping');
    return { map, orphans: archiveRoom(map, 'r-01', NOW) };
  }

  it('живой сессии — прямое письмо parley без комнаты; спящей письма нет', () => {
    const { map, orphans } = archived();
    const before = map.messages.length;

    const letters = addRoomArchivedLetters(map, 'r-01', orphans, LATER);

    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: PARLEY, to: ['s-01'], roomId: null, kind: 'note', text: TEXT, at: LATER });
    expect(map.messages).toHaveLength(before + 1);
    // Письмо вне комнаты: будильник поднимет бы спящего, так что спящему его и не пишем.
    expect(unreadFor(map, 's-01')).toHaveLength(1);
    expect(unreadFor(map, 's-02')).toEqual([]);
  });

  it('закрытой и ещё не запущенной сессии письма нет; повтор id не удваивает письмо', () => {
    const { map } = archived();
    transitionSession(map, 's-03', 'closed');

    // s-04 не запущена (pending), s-03 закрыта.
    expect(addRoomArchivedLetters(map, 'r-01', ['s-03', 's-04'], LATER)).toEqual([]);
    expect(addRoomArchivedLetters(map, 'r-01', ['s-01', 's-01'], LATER)).toHaveLength(1);
  });

  it('сессия, которая успела войти в другую открытую комнату, письма не получает', () => {
    const { map, orphans } = archived();
    addMember(map, 'r-02', 's-01', NOW);

    expect(addRoomArchivedLetters(map, 'r-01', orphans, LATER)).toEqual([]);
  });

  it('пустой список и неизвестные id ничего не пишут; нет комнаты — RoomRuleError', () => {
    const { map } = archived();
    const before = JSON.stringify(map);

    expect(addRoomArchivedLetters(map, 'r-01', [], LATER)).toEqual([]);
    expect(addRoomArchivedLetters(map, 'r-01', ['s-99', HUMAN], LATER)).toEqual([]);
    expect(JSON.stringify(map)).toBe(before);
    expect(() => addRoomArchivedLetters(map, 'r-09', ['s-01'], LATER)).toThrow(RoomRuleError);
  });
});
