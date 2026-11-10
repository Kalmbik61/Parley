import { describe, expect, it } from 'vitest';
import { reportLetterText, isReportLetterAbout, isReportUpdateLetter, lastTaskGiver, reportRecipients } from './task-giver.js';
import { addSession } from './map.js';
import { addRoom, archiveRoom } from './rooms.js';
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

describe('reportRecipients', () => {
  const emptyMap = (): WindowWorkMap => ({ schemaVersion: 3,
    work: { id: 'w-0001', title: '', goal: '', status: 'active', createdAt: '', updatedAt: '' },
    sessions: [], rooms: [], messages: [],
  });
  /** Карта из n сессий s-01…s-0n; createdBy задаётся по индексу (1-based id → создатель). */
  const mapOf = (count: number, createdBy: Record<number, string> = {}): WindowWorkMap => {
    const map = emptyMap();
    for (let n = 1; n <= count; n += 1) {
      addSession(map, { provider: 'claude', label: `s${n}`, task: '', ...(createdBy[n] === undefined ? {} : { createdBy: createdBy[n] }) });
    }
    return map;
  };
  const recipients = (map: WindowWorkMap, sessionId: string) => reportRecipients(map, mapLetterTx(map).letters, sessionId);
  const send = (map: WindowWorkMap, from: string, to: string[], kind: 'note' | 'question' = 'note') =>
    mapLetterTx(map).letters.add({ roomId: null, from, to, text: 'task', kind });

  it('создатель — ведущий комнаты, докладчик — участник: одна запись, адресат lead', () => {
    const map = mapOf(2, { 2: 's-01' });
    addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
    expect(recipients(map, 's-02')).toEqual([{ id: 's-01', as: 'lead', roomId: 'r-01' }]);
  });

  it('создатель вне комнаты: сначала ведущий, потом создатель', () => {
    const map = mapOf(4, { 2: 's-04' });
    addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
    expect(recipients(map, 's-02')).toEqual([
      { id: 's-01', as: 'lead', roomId: 'r-01' },
      { id: 's-04', as: 'giver' },
    ]);
  });

  it('докладчик — ведущий: письмо владельцу; без владельца, закрытый или сам докладчик — владельца нет', () => {
    const map = mapOf(5);
    addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-05', members: ['s-01', 's-02'], lead: 's-01' });
    expect(recipients(map, 's-01')).toEqual([{ id: 's-05', as: 'owner', roomId: 'r-01' }]);
    map.rooms[0]!.ownerId = null;
    expect(recipients(map, 's-01')).toEqual([]);
    map.rooms[0]!.ownerId = 's-05';
    map.sessions[4]!.lifecycle = 'closed';
    expect(recipients(map, 's-01')).toEqual([]);
    map.sessions[4]!.lifecycle = 'active';
    map.rooms[0]!.ownerId = 's-01';
    expect(recipients(map, 's-01')).toEqual([]);
  });

  it('старая карта: lead null, первый из members закрыт — ведущий следующий живой; докладчик-ведущий отчитывается владельцу', () => {
    const map = mapOf(4);
    addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-04', members: ['s-01', 's-02', 's-03'] });
    map.sessions[0]!.lifecycle = 'closed';
    expect(recipients(map, 's-03')).toEqual([{ id: 's-02', as: 'lead', roomId: 'r-01' }]);
    expect(recipients(map, 's-02')).toEqual([{ id: 's-04', as: 'owner', roomId: 'r-01' }]);
  });

  it('архивная комната адресатов не даёт', () => {
    const map = mapOf(3);
    const room = addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-03', members: ['s-01', 's-02'], lead: 's-01' });
    archiveRoom(map, mapLetterTx(map).letters, room.id);
    expect(recipients(map, 's-02')).toEqual([]);
  });

  it('участник роя и королева — пустой список', () => {
    const map = mapOf(3, { 2: 's-01' });
    addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-03', members: ['s-01', 's-02'], lead: 's-01' });
    map.swarms = [{ id: 'sw-01', tag: 'Work', creator: { kind: 'human' }, objective: '', queen: 's-01',
      members: [{ sessionId: 's-02', role: 'drone', n: 1, addedAt: '', handedAt: null }],
      status: 'running', createdAt: '', endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null }];
    expect(recipients(map, 's-02')).toEqual([]);
    expect(recipients(map, 's-01')).toEqual([]);
  });

  it('автономная комната: исполнитель без ведущего, автономный ведущий — владельцу', () => {
    const map = mapOf(3);
    addRoom(map, { mode: 'autonomous', title: 'Room', creator: 's-01', ownerId: 's-03', members: ['s-01', 's-02'], lead: 's-01' });
    expect(recipients(map, 's-02')).toEqual([]);
    expect(recipients(map, 's-01')).toEqual([{ id: 's-03', as: 'owner', roomId: 'r-01' }]);
  });

  it('C2-7: создатель всегда, самый новый прямой отправитель вторым', () => {
    const map = mapOf(3, { 2: 's-01' });
    send(map, 's-03', ['s-02']);
    expect(recipients(map, 's-02')).toEqual([{ id: 's-01', as: 'giver' }, { id: 's-03', as: 'giver' }]);
  });

  it('вопрос и письмо человека второго адресата не дают и создателя не гасят', () => {
    const map = mapOf(3, { 2: 's-01' });
    send(map, 's-03', ['s-02'], 'question');
    expect(recipients(map, 's-02')).toEqual([{ id: 's-01', as: 'giver' }]);
    send(map, 'human', ['s-02']);
    expect(recipients(map, 's-02')).toEqual([{ id: 's-01', as: 'giver' }]);
  });

  it('создатель human без писем — пусто; закрытые и удалённые id отсеяны', () => {
    const map = mapOf(3, { 2: 'human' });
    expect(recipients(map, 's-02')).toEqual([]);
    map.sessions[1]!.createdBy = 's-01';
    send(map, 's-03', ['s-02']);
    map.sessions[2]!.lifecycle = 'closed';
    expect(recipients(map, 's-02')).toEqual([{ id: 's-01', as: 'giver' }]);
    map.sessions[1]!.createdBy = 's-77';
    expect(recipients(map, 's-02')).toEqual([]);
  });
});

describe('reportLetterText: комнаты и обновление', () => {
  const update = 's-41 reported done (update) in r-07: Ready. Full summary: get_map {session: "s-41", field: "summary"}';
  const plain = 's-41 reported done: Ready. Full summary: get_map {session: "s-41", field: "summary"}';

  it('собирает пометку обновления и комнаты', () => {
    expect(reportLetterText('s-41', 'done', 'Ready', { rooms: ['r-07'], update: true })).toBe(update);
    expect(reportLetterText('s-41', 'done', 'Ready', { rooms: ['r-07', 'r-09'] })).toContain('reported done in r-07, r-09: Ready');
    expect(reportLetterText('s-41', 'done', 'Ready', { rooms: [] })).toBe(plain);
  });

  it('обе формы узнаёт isReportLetterAbout, обновление — только isReportUpdateLetter', () => {
    const letter = (text: string, patch: Partial<{ from: string; roomId: string | null }> = {}) => ({ from: 'system', roomId: null, text, ...patch });
    expect(isReportLetterAbout(letter(update), 's-41')).toBe(true);
    expect(isReportLetterAbout(letter(plain), 's-41')).toBe(true);
    expect(isReportUpdateLetter(letter(update))).toBe(true);
    expect(isReportUpdateLetter(letter(plain))).toBe(false);
    expect(isReportUpdateLetter(letter(update, { from: 's-01' }))).toBe(false);
    expect(isReportUpdateLetter(letter(update, { roomId: 'r-01' }))).toBe(false);
  });
});
