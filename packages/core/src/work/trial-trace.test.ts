import { describe, expect, it } from 'vitest';
import { addSession, parseMap, removeSession, transitionSession } from './map.js';
import { mapLetterTx } from './letter-store.js';
import { roomMembership } from './room-membership.js';
import { addMember, addRoom, addSystemMessage, deleteRoom, joinedLine } from './rooms.js';
import { trialSegments, trialUnknownParticipation } from './trial-trace.js';
import { HUMAN, type AgentBinding, type SessionTrial, type TrialTrace, type WindowWorkMap, type WorkSession } from './types.js';

const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const T0 = '2026-11-17T10:00:00.000Z';
const T1 = '2026-11-17T11:00:00.000Z';
const T2 = '2026-11-17T12:00:00.000Z';
const DELETED = '2026-11-17T13:00:00.000Z';
const ROOM_DELETED = '2026-11-17T14:00:00.000Z';
const TAG_A = 'a'.repeat(32);
const TAG_B = 'b'.repeat(32);

const trialOf = (arm: SessionTrial['arm'], tag: string): SessionTrial => ({ name: 'exp-a', arm, at: T0, tag });

const emptyMap = (): WindowWorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'trace', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

/** s-01 «пакет» и s-02 «контроль» с назначением, s-03 без него. */
function world(): WindowWorkMap {
  const map = emptyMap();
  addSession(map, { provider: 'claude', label: 'a', task: 't', trial: trialOf('packet', TAG_A) });
  addSession(map, { provider: 'claude', label: 'b', task: 't', trial: trialOf('control', TAG_B) });
  addSession(map, { provider: 'claude', label: 'c', task: 't' });
  return map;
}

const roundTrip = (map: WindowWorkMap): WindowWorkMap => parseMap(JSON.stringify(map), 'map.json');

const binding = (n: number, over: Partial<AgentBinding> = {}): AgentBinding => ({
  provider: 'claude',
  model: null,
  effort: null,
  providerSessionId: `11111111-1111-4111-8111-11111111111${n}`.slice(0, 36),
  startedAt: T0,
  endedAt: T1,
  reason: 'manual',
  requestedBy: 'human',
  carried: 'handover',
  ...over,
});

describe('след удаления сессии опыта (Э-1б, критерии 1 и 9)', () => {
  it('сессия с плечом: след в той же записи карты хранит плечо, идентификаторы, отрезки и времена; он переживает чтение и запись карты', () => {
    const map = world();
    const session = map.sessions[0]!;
    Object.assign(session, {
      providerSessionId: '22222222-2222-4222-8222-222222222222',
      startedAt: T1,
      endedAt: T2,
      closedAt: T2,
      previousAgents: [binding(1), binding(2, { provider: 'codex', providerSessionId: 'thread-1' })],
    });
    removeSession(map, lt(map), 's-01', DELETED);
    expect(map.work.deletedSessions).toEqual(['s-01']);
    expect(map.work.trialTrace).toEqual({
      sessions: [{
        session: 's-01',
        trial: trialOf('packet', TAG_A),
        provider: 'claude',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        startedAt: T1,
        endedAt: T2,
        closedAt: T2,
        previousAgents: [
          { provider: 'claude', providerSessionId: '11111111-1111-4111-8111-111111111111', startedAt: T0, endedAt: T1 },
          { provider: 'codex', providerSessionId: 'thread-1', startedAt: T0, endedAt: T1 },
        ],
        deletedAt: DELETED,
      }],
      rooms: [],
      unknownParticipation: [],
    });
    const again = roundTrip(map);
    expect(again.work.trialTrace).toEqual(map.work.trialTrace);
    // Повторная запись и чтение следа не меняют.
    expect(roundTrip(again).work.trialTrace).toEqual(map.work.trialTrace);
  });

  it('повреждённое назначение тоже оставляет след — как явное состояние «повреждено»', () => {
    const map = world();
    Object.assign(map.sessions[0]!, { trial: { damaged: true } });
    removeSession(map, lt(map), 's-01', DELETED);
    expect(roundTrip(map).work.trialTrace?.sessions[0]).toMatchObject({ session: 's-01', trial: { damaged: true } });
  });

  it('сессия без назначения следа не оставляет: поле работы не появляется, остальное как до задачи', () => {
    const map = world();
    removeSession(map, lt(map), 's-03', DELETED);
    expect(map.work).not.toHaveProperty('trialTrace');
    expect(Object.keys(map.work).sort()).toEqual(['createdAt', 'deletedSessions', 'goal', 'id', 'sessionSeq', 'status', 'title', 'updatedAt']);
    expect(JSON.stringify(map)).not.toContain('trialTrace');
  });

  it('критерий 9: отрезки живой записи и следа разбираются одной функцией и дают одно и то же', () => {
    const cases: Array<Partial<WorkSession>> = [
      { providerSessionId: '22222222-2222-4222-8222-222222222222', startedAt: T1, endedAt: T2, closedAt: T2, previousAgents: [binding(1), binding(2, { provider: 'codex', providerSessionId: 'x' })] },
      { providerSessionId: null, startedAt: T1, endedAt: null },
      { providerSessionId: null, startedAt: null, endedAt: null },
      { providerSessionId: 'z', startedAt: T1, previousAgents: Array.from({ length: 20 }, (_, index) => binding(index % 9)) },
      { providerSessionId: 'z', startedAt: T1, previousAgents: [binding(3, { providerSessionId: null })] },
    ];
    for (const [index, extra] of cases.entries()) {
      const map = world();
      Object.assign(map.sessions[0]!, extra);
      const live = trialSegments(map.sessions[0]!);
      removeSession(map, lt(map), 's-01', DELETED);
      const entry = roundTrip(map).work.trialTrace!.sessions[0]!;
      if ('damaged' in entry) throw new Error('trace is damaged');
      expect(trialSegments(entry), `case ${index}`).toEqual(live);
    }
    const truncated = world();
    Object.assign(truncated.sessions[0]!, { previousAgents: Array.from({ length: 20 }, (_, index) => binding(index % 9)) });
    expect(trialSegments(truncated.sessions[0]!).truncated).toBe(true);
    const missing = world();
    Object.assign(missing.sessions[0]!, { startedAt: T1, providerSessionId: null });
    expect(trialSegments(missing.sessions[0]!)).toMatchObject({ truncated: false, missingId: true });
    expect(trialSegments(world().sessions[0]!)).toMatchObject({ truncated: false, missingId: false });
  });
});

describe('след удаления комнаты опыта (Э-1б, критерий 2)', () => {
  it('строки участия живых и уже удалённых сессий опыта сохраняются, открытый выход закрыт временем удаления; сессия без назначения не попадает', () => {
    const map = world();
    addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01' }, T0);
    const room = map.rooms[0]!;
    room.memberLog = [
      { session: 's-01', from: T0, to: null },
      { session: 's-02', from: T0, to: T1 },
      { session: 's-03', from: T0, to: null },
    ];
    removeSession(map, lt(map), 's-02', DELETED);
    deleteRoom(map, lt(map), 'r-01', ROOM_DELETED);
    expect(map.work.trialTrace?.rooms).toEqual([
      { room: 'r-01', session: 's-01', from: T0, to: ROOM_DELETED },
      { room: 'r-01', session: 's-02', from: T0, to: T1 },
    ]);
    expect(map.work.trialTrace?.unknownParticipation).toEqual([]);
    expect(roundTrip(map).work.trialTrace).toEqual(map.work.trialTrace);
  });

  it('комната без сессий опыта следа не оставляет', () => {
    const map = world();
    addRoom(map, { title: 'R', creator: HUMAN, members: ['s-03'], lead: 's-03' }, T0);
    deleteRoom(map, lt(map), 'r-01', ROOM_DELETED);
    expect(map.work).not.toHaveProperty('trialTrace');
  });

  it('комната без журнала участия: живая сессия опыта, названная составом или строкой входа, оставляет отметку «участие неизвестно»', () => {
    const map = world();
    addRoom(map, { title: 'Old', creator: HUMAN, members: ['s-01', 's-03'], lead: 's-01' }, T0);
    delete map.rooms[0]!.memberLog;
    // s-02 числится только строкой входа в ленте (вышла из состава), s-03 — состав без назначения.
    addSystemMessage(map, lt(map), 'r-01', joinedLine('s-02'), T1);
    deleteRoom(map, lt(map), 'r-01', ROOM_DELETED);
    expect(map.work.trialTrace).toEqual({
      sessions: [],
      rooms: [],
      unknownParticipation: [{ room: 'r-01', session: 's-01' }, { room: 'r-01', session: 's-02' }],
    });
  });

  it('повреждённое назначение у живой сессии тоже считается назначением: строки участия сохраняются', () => {
    const map = world();
    Object.assign(map.sessions[2]!, { trial: { damaged: true } });
    addRoom(map, { title: 'R', creator: HUMAN, members: ['s-03'], lead: 's-03' }, T0);
    deleteRoom(map, lt(map), 'r-01', ROOM_DELETED);
    expect(map.work.trialTrace?.rooms).toEqual([{ room: 'r-01', session: 's-03', from: T0, to: ROOM_DELETED }]);
  });
});

describe('порядок удалений (Э-1б, критерии 3 и 8)', () => {
  it('комната с журналом: «сессию, потом комнату» и «комнату, потом сессию» дают один набор сведений', () => {
    const build = (): WindowWorkMap => {
      const map = world();
      addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' }, T0);
      return map;
    };
    const sessionFirst = build();
    removeSession(sessionFirst, lt(sessionFirst), 's-01', DELETED);
    deleteRoom(sessionFirst, lt(sessionFirst), 'r-01', DELETED);
    const roomFirst = build();
    deleteRoom(roomFirst, lt(roomFirst), 'r-01', DELETED);
    removeSession(roomFirst, lt(roomFirst), 's-01', DELETED);
    expect(sessionFirst.work.trialTrace?.rooms.length).toBe(2);
    // Список следов сессий в разном порядке: до комнаты в нём одна сессия, после неё — тоже одна; сравниваем содержимое.
    const sorted = (trace: TrialTrace | undefined) => ({
      sessions: [...(trace?.sessions ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      rooms: [...(trace?.rooms ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      unknownParticipation: trace?.unknownParticipation,
    });
    expect(sorted(roomFirst.work.trialTrace)).toEqual(sorted(sessionFirst.work.trialTrace));
  });

  it('комната без журнала: оба порядка дают одну и ту же пару «комната/сессия» как неизвестное участие', () => {
    const build = (): WindowWorkMap => {
      const map = world();
      addRoom(map, { title: 'Old', creator: HUMAN, members: [], lead: null }, T0);
      delete map.rooms[0]!.memberLog;
      addMember(map, lt(map), 'r-01', 's-01', T1);
      return map;
    };
    const sessionFirst = build();
    removeSession(sessionFirst, lt(sessionFirst), 's-01', DELETED);
    expect(sessionFirst.work.trialTrace?.sessions[0]).toMatchObject({ unjournaledRooms: ['r-01'] });
    deleteRoom(sessionFirst, lt(sessionFirst), 'r-01', ROOM_DELETED);

    const roomFirst = build();
    deleteRoom(roomFirst, lt(roomFirst), 'r-01', ROOM_DELETED);
    expect(roomFirst.work.trialTrace?.unknownParticipation).toEqual([{ room: 'r-01', session: 's-01' }]);
    removeSession(roomFirst, lt(roomFirst), 's-01', DELETED);

    expect(trialUnknownParticipation(sessionFirst.work.trialTrace)).toEqual(['r-01/s-01']);
    expect(trialUnknownParticipation(roomFirst.work.trialTrace)).toEqual(['r-01/s-01']);
  });

  it('критерий 8: вошла в комнату без журнала и удалена — участие остаётся помеченным; roomMembership сам удалённую не вернёт', () => {
    const map = world();
    addRoom(map, { title: 'Old', creator: HUMAN, members: [], lead: null }, T0);
    delete map.rooms[0]!.memberLog;
    addMember(map, lt(map), 'r-01', 's-02', T1);
    // Сессия ушла из состава (строка входа в ленте осталась), затем удалена.
    map.rooms[0]!.members = [];
    expect(roomMembership(map, 'r-01', lt(map)).members.map((member) => member.session)).toEqual(['s-02']);
    removeSession(map, lt(map), 's-02', DELETED);
    // Кандидаты — живые сессии и состав: удалённую участницу реконструкция сама по себе не вернёт…
    expect(roomMembership(map, 'r-01', lt(map)).members.map((member) => member.session)).toEqual([]);
    // …а след сессии её помнит и после удаления самой комнаты.
    expect(map.work.trialTrace?.sessions[0]).toMatchObject({ session: 's-02', unjournaledRooms: ['r-01'] });
    deleteRoom(map, lt(map), 'r-01', ROOM_DELETED);
    expect(trialUnknownParticipation(roundTrip(map).work.trialTrace)).toEqual(['r-01/s-02']);
  });
});

describe('проверка следа при чтении (Э-1б, критерий 6)', () => {
  const read = (trace: unknown): TrialTrace | undefined => {
    const map = world();
    Object.assign(map.work, { trialTrace: trace });
    return roundTrip(map).work.trialTrace;
  };
  const DAMAGED = { damaged: true };
  const validSession = {
    session: 's-09', trial: trialOf('control', TAG_A), provider: 'claude', providerSessionId: null,
    startedAt: null, endedAt: null, closedAt: null, deletedAt: DELETED,
  };

  it('верный след читается как есть; нет поля — нет и после чтения', () => {
    const trace = { sessions: [validSession], rooms: [{ room: 'r-01', session: 's-09', from: T0, to: T1 }], unknownParticipation: [{ room: 'r-02', session: 's-09' }] };
    expect(read(trace)).toEqual(trace);
    expect(read(undefined)).toBeUndefined();
  });

  it('запись неверной формы заменяется явным состоянием «повреждено» и переживает запись и чтение карты', () => {
    const bad = read({
      sessions: [{ ...validSession, deletedAt: 5 }, { ...validSession, session: 7 }, 'oops', { ...validSession, previousAgents: [{ provider: 1 }] }, { ...validSession, unjournaledRooms: [3] }],
      rooms: [{ room: 'r-01', session: 's-09', from: T0 }, null],
      unknownParticipation: [{ room: 1, session: 's-09' }],
    });
    expect(bad).toEqual({
      sessions: [DAMAGED, DAMAGED, DAMAGED, DAMAGED, DAMAGED],
      rooms: [DAMAGED, DAMAGED],
      unknownParticipation: [DAMAGED],
    });
    const map = world();
    Object.assign(map.work, { trialTrace: bad });
    expect(roundTrip(roundTrip(map)).work.trialTrace).toEqual(bad);
  });

  it('не запись и не список — тоже «повреждено», а не молчание', () => {
    expect(read('trace')).toEqual({ sessions: [DAMAGED], rooms: [], unknownParticipation: [] });
    expect(read({ sessions: 'x', rooms: {}, unknownParticipation: 4 })).toEqual({ sessions: [DAMAGED], rooms: [DAMAGED], unknownParticipation: [DAMAGED] });
    expect(read({})).toEqual({ sessions: [], rooms: [], unknownParticipation: [] });
  });

  it('назначение внутри следа проверяется как назначение сессии: без метки — «повреждено»', () => {
    const trace = read({ sessions: [{ ...validSession, trial: { ...trialOf('control', TAG_A), tag: 'short' } }], rooms: [], unknownParticipation: [] });
    expect(trace?.sessions[0]).toMatchObject({ session: 's-09', trial: { damaged: true } });
  });
});

describe('времена в следе проверяются (Э-1б, уточнение 13)', () => {
  const DAMAGED = { damaged: true };
  const read = (trace: Partial<TrialTrace> | Record<string, unknown>): TrialTrace | undefined => {
    const map = world();
    Object.assign(map.work, { trialTrace: { sessions: [], rooms: [], unknownParticipation: [], ...trace } });
    return roundTrip(map).work.trialTrace;
  };
  const session = {
    session: 's-09', trial: trialOf('control', TAG_A), provider: 'claude', providerSessionId: null,
    startedAt: T0, endedAt: T1, closedAt: T2, deletedAt: DELETED,
    previousAgents: [{ provider: 'claude', providerSessionId: 'x', startedAt: T0, endedAt: T1 }],
  };
  const row = { room: 'r-01', session: 's-09', from: T0, to: T1 };

  it('верные времена читаются как есть, null в необязательных временах допустим', () => {
    expect(read({ sessions: [session], rooms: [row] })).toMatchObject({ sessions: [session], rooms: [row] });
    const open = { ...session, startedAt: null, endedAt: null, closedAt: null, previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: null, endedAt: T1 }] };
    expect(read({ sessions: [open] })?.sessions).toEqual([open]);
  });

  it.each([
    ['startedAt', { startedAt: 'вчера' }],
    ['endedAt', { endedAt: 'not-a-time' }],
    ['closedAt', { closedAt: '' }],
    ['deletedAt', { deletedAt: 'yesterday' }],
    ['deletedAt не строка', { deletedAt: 5 }],
    ['startedAt прежнего отрезка', { previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: 'bad', endedAt: T1 }] }],
    ['endedAt прежнего отрезка', { previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: T0, endedAt: 'bad' }] }],
    ['прежний отрезок перевёрнут', { previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: T1, endedAt: T0 }] }],
  ])('след сессии: %s неверно — запись «повреждена»', (_name, patch) => {
    expect(read({ sessions: [{ ...session, ...patch }] })?.sessions).toEqual([DAMAGED]);
  });

  it('текущий отрезок: startedAt 12:00, endedAt 10:00 — след «повреждён»', () => {
    expect(read({ sessions: [{ ...session, startedAt: '2026-11-17T12:00:00.000Z', endedAt: '2026-11-17T10:00:00.000Z' }] })?.sessions).toEqual([DAMAGED]);
  });

  it('настоящий переход через функцию переходов: ожидает → активна 10:00 → спит 11:00 → активна 12:00, затем удаление — след целый, startedAt 10:00, endedAt пуст', () => {
    const map = world();
    transitionSession(map, 's-01', 'active', { at: '2026-11-17T10:00:00.000Z' });
    transitionSession(map, 's-01', 'sleeping', { at: '2026-11-17T11:00:00.000Z' });
    transitionSession(map, 's-01', 'active', { at: '2026-11-17T12:00:00.000Z' });
    removeSession(map, lt(map), 's-01', DELETED);
    const entry = roundTrip(map).work.trialTrace?.sessions[0];
    expect(entry).toMatchObject({ session: 's-01', startedAt: '2026-11-17T10:00:00.000Z', endedAt: null, trial: trialOf('packet', TAG_A) });
    expect(entry).not.toEqual(DAMAGED);
  });

  it.each([
    ['вход', { from: 'вчера' }],
    ['выход', { to: 'not-a-time' }],
    ['выход не строка', { to: null }],
    ['выход раньше входа', { from: T2, to: T0 }],
  ])('строка участия: %s неверно — запись «повреждена», а не свидетельство, что окно было вне комнаты', (_name, patch) => {
    expect(read({ rooms: [{ ...row, ...patch }] })?.rooms).toEqual([DAMAGED]);
  });

  it('выход, равный входу, допустим', () => {
    expect(read({ rooms: [{ ...row, to: T0 }] })?.rooms).toEqual([{ ...row, to: T0 }]);
  });
});
