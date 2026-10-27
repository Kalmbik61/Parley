import { describe, expect, it } from 'vitest';
import { HUMAN, WINDOW_MENTION_MAX_BYTES } from '@parley/core';
import type { Message } from '@parley/core';
import type { RoomsMailEvent, RoomsMailRoom } from '@parley/protocol';
import { MAIL_EVENT_MAX_BYTES, fitMailEvent, foreignJournal, gluedMailEvent, joinBatch, joinForeign, startBatch } from './mail.js';

/**
 * Потолок кадра события `rooms.mail` (спека rooms.mail 6.6, ревью задачи 4): кадр целиком — `{"event":"rooms.mail","data":…}`
 * и перевод строки — не больше `MAIL_EVENT_MAX_BYTES`, а кандидаты в упоминания не отнимают место у новых писем.
 */

const frame = (event: RoomsMailEvent): number => Buffer.byteLength(JSON.stringify({ event: 'rooms.mail', data: event })) + 1;

const letter = (n: number, bytes: number, text = 'x'): Message => ({
  id: `m-${String(n).padStart(4, '0')}`,
  roomId: 'r-01',
  from: 's-02',
  to: [],
  at: '2026-10-27T10:00:00.000Z',
  kind: 'note',
  text: text.repeat(bytes),
  readBy: {},
});

const room = (roomId: string, patch: Partial<RoomsMailRoom> = {}): RoomsMailRoom => ({
  roomId,
  prevTop: 1,
  top: 2,
  total: 2,
  lastAt: '2026-10-27T10:00:00.000Z',
  letters: [],
  reads: [],
  deleted: [],
  ...patch,
});

const eventOf = (rooms: RoomsMailRoom[], mentionCandidates: Message[] = []): RoomsMailEvent => ({
  projectPath: '/p',
  workId: 'w-0001',
  version: 12,
  prevVersion: 11,
  updatedAt: '2026-10-27T10:00:00.000Z',
  rooms,
  droppedRooms: [],
  unread: { letters: 0, rooms: {} },
  mentionCandidates,
});

describe('fitMailEvent: потолок кадра', () => {
  it('событие, которое влезает, не меняется', () => {
    const event = eventOf([room('r-01', { letters: [letter(1, 100)] })], [letter(2, 100)]);

    expect(fitMailEvent(event)).toEqual(event);
  });

  it('кандидаты в упоминания имеют свой потолок: новейшие, подряд, а письмо комнаты едет письмом без reread', () => {
    // 70 писем по 4 КиБ вместе давали бы больше кадра: прежний код оставлял комнате `reread` и кадр выше потолка.
    const candidates = Array.from({ length: 70 }, (_, at) => letter(at + 1, 4096));
    const fresh = letter(100, 200);
    const event = eventOf([room('r-01', { letters: [fresh] })], [...candidates, fresh]);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]?.letters).toEqual([fresh]);
    expect(fitted.rooms[0]?.reread).toBeUndefined();
    expect(fitted.mentionCandidates.length).toBeGreaterThan(0);
    expect(fitted.mentionCandidates.length).toBeLessThan(candidates.length);
    expect(Buffer.byteLength(JSON.stringify(fitted.mentionCandidates))).toBeLessThanOrEqual(WINDOW_MENTION_MAX_BYTES + 2);
    // Остались самые новые, и порядок прежний.
    expect(fitted.mentionCandidates.at(-1)).toEqual(fresh);
    const ids = fitted.mentionCandidates.map((candidate) => candidate.id);
    expect(ids).toEqual([...ids].sort());
    expect(fitted.mentionCandidates.slice(0, -1).at(-1)?.id).toBe(candidates.at(-1)?.id);
  });

  it('кандидаты, которые влезают, не трогаются; каркас, съевший почти кадр, урезает их до остатка: самые новые', () => {
    // Каркас в ~220 КиБ (отметки), остаток кадра меньше потолка кандидатов: событие урезает набор ещё, а не вылезает за кадр.
    const reads = Array.from({ length: 3500 }, (_, at) => ({ id: `m-${at + 1}`, reader: 's-01', at: '2026-10-27T10:00:00.000Z' }));
    const candidates = Array.from({ length: 10 }, (_, at) => letter(at + 1, 4096));
    const event = eventOf([room('r-01', { reads })], candidates);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]?.reads).toEqual(reads);
    expect(fitted.mentionCandidates.length).toBeGreaterThan(0);
    expect(fitted.mentionCandidates.length).toBeLessThan(candidates.length);
    expect(fitted.mentionCandidates.at(-1)).toEqual(candidates.at(-1));
  });

  it('кандидатов нет, а письма комнат берут всё место: потолок кандидатов не отнимает его у писем', () => {
    const letters = Array.from({ length: 40 }, (_, at) => letter(at + 1, 5000));
    const event = eventOf([room('r-01', { letters })]);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]?.letters).toEqual(letters);
  });

  it('письма комнаты, которой не хватило, не едут, комната получает reread; влезшие комнаты остаются с письмами', () => {
    const big = Array.from({ length: 80 }, (_, at) => letter(at + 1, 4000));
    const small = [letter(500, 100)];
    const event = eventOf([room('r-01', { letters: small }), room('r-02', { letters: big }), room('r-03', { letters: [letter(600, 50)] })]);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]).toMatchObject({ roomId: 'r-01', letters: small });
    expect(fitted.rooms[0]?.reread).toBeUndefined();
    expect(fitted.rooms[1]).toMatchObject({ roomId: 'r-02', letters: [], reread: true });
    // Числа комнаты, которой не хватило, остаются: окно ставит их из события.
    expect(fitted.rooms[1]).toMatchObject({ prevTop: 1, top: 2, total: 2 });
    expect(fitted.rooms[2]?.letters).toHaveLength(1);
  });

  it('байты признака reread у обрезанных комнат отложены: кадр не вылезает за потолок, когда письма первой комнаты заняли остаток почти вплотную', () => {
    const ids = ['r-01', 'r-02', 'r-03', 'r-04'];
    const bare = eventOf(ids.map((id) => room(id)));
    // Остаток кадра без писем; письма первой комнаты занимают его, оставляя пять байт: прежний код оставлял их ей, а три остальные
    // комнаты обрезал, прибавляя к каждой `,"reread":true` сверх потолка. Теперь эти байты отложены, и первой комнате не хватает.
    const remainder = MAIL_EVENT_MAX_BYTES - frame(bare);
    const overhead = Buffer.byteLength(JSON.stringify([letter(1, 0)])) - 2;
    const first = letter(1, remainder - 5 - overhead);
    expect(Buffer.byteLength(JSON.stringify([first])) - 2).toBe(remainder - 5);
    const event = eventOf(ids.map((id, at) => room(id, { letters: [at === 0 ? first : letter(at + 1, 20_000)] })));

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    // Каждая комната либо с письмами, либо с reread: письма не пропали молча.
    expect(fitted.rooms.every((item) => item.letters.length > 0 || item.reread === true)).toBe(true);
  });

  it('отметки и удаления, которые не влезли в каркас, уходят в reread самых тяжёлых комнат', () => {
    const reads = Array.from({ length: 6000 }, (_, at) => ({ id: `m-${String(at).padStart(4, '0')}`, reader: 's-01', at: '2026-10-27T10:00:00.000Z' }));
    const event = eventOf([room('r-01', { reads }), room('r-02', { reads: reads.slice(0, 3) }), room('r-03', { deleted: ['m-0001'] })]);
    expect(frame(event)).toBeGreaterThan(MAIL_EVENT_MAX_BYTES);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]).toMatchObject({ roomId: 'r-01', reads: [], deleted: [], reread: true });
    // Лёгкие комнаты остались с отметками: режут самых тяжёлых и только пока не влезло.
    expect(fitted.rooms[1]?.reads).toHaveLength(3);
    expect(fitted.rooms[1]?.reread).toBeUndefined();
    expect(fitted.rooms[2]?.deleted).toEqual(['m-0001']);
  });

  it('первый проход режет сначала комнату с самыми тяжёлыми отметками других читателей: отметки человека порядка не решают', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const readOf = (n: number, reader: string) => ({ id: `m-${String(n).padStart(4, '0')}`, reader, at });
    // r-01 тяжелее всего целиком, но почти всё в ней — отметки человека: их проход не снимает. В r-02 отметки других читателей.
    const humanHeavy = [...Array.from({ length: 3000 }, (_, n) => readOf(n, HUMAN)), ...Array.from({ length: 100 }, (_, n) => readOf(3000 + n, 's-01'))];
    const othersHeavy = Array.from({ length: 2000 }, (_, n) => readOf(n, 's-01'));
    const event = eventOf([room('r-01', { reads: humanHeavy }), room('r-02', { reads: othersHeavy })]);
    expect(frame(event)).toBeGreaterThan(MAIL_EVENT_MAX_BYTES);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    // Хватило одной комнаты: r-02 теряет отметки, а r-01 остаётся нетронутой и без reread.
    expect(fitted.rooms[1]).toMatchObject({ roomId: 'r-02', reads: [], reread: true });
    expect(fitted.rooms[0]?.reads).toHaveLength(3100);
    expect(fitted.rooms[0]?.reread).toBeUndefined();
  });

  it('урезанная комната сохраняет отметки человека и удаления: уходят только отметки других читателей', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const others = Array.from({ length: 6000 }, (_, n) => ({ id: `m-${String(n).padStart(4, '0')}`, reader: 's-01', at }));
    const first = { id: 'm-9001', reader: HUMAN, at };
    const second = { id: 'm-9002', reader: HUMAN, at };
    // Отметки человека лежат среди чужих: порядок не должен решать, какие остаются.
    const reads = [...others.slice(0, 3000), first, ...others.slice(3000), second];
    const event = eventOf([room('r-01', { reads, deleted: ['m-9003'] })]);
    expect(frame(event)).toBeGreaterThan(MAIL_EVENT_MAX_BYTES);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    // Окно убирает кандидатов в упоминания только по этим отметкам и удалениям, а комнаты, которой оно не держит, ему не дочитать.
    expect(fitted.rooms[0]).toMatchObject({ roomId: 'r-01', reads: [first, second], deleted: ['m-9003'], reread: true });
  });

  it('когда и отметок человека с удалениями слишком много, они уходят тоже: кадр держит потолок', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const reads = Array.from({ length: 6000 }, (_, n) => ({ id: `m-${String(n).padStart(4, '0')}`, reader: HUMAN, at }));
    const event = eventOf([room('r-01', { reads, deleted: ['m-9003'] }), room('r-02', { deleted: ['m-0001'] })]);
    expect(frame(event)).toBeGreaterThan(MAIL_EVENT_MAX_BYTES);

    const fitted = fitMailEvent(event);

    expect(frame(fitted)).toBeLessThanOrEqual(MAIL_EVENT_MAX_BYTES);
    expect(fitted.rooms[0]).toMatchObject({ roomId: 'r-01', reads: [], deleted: [], reread: true });
    // Лёгкая комната режется лишь пока не влезло.
    expect(fitted.rooms[1]).toMatchObject({ roomId: 'r-02', deleted: ['m-0001'] });
    expect(fitted.rooms[1]?.reread).toBeUndefined();
  });

  it('комната с reread от записи (массовая отметка) не платит за него дважды', () => {
    const event = eventOf([room('r-01', { reread: true, letters: [letter(1, 100)] })]);

    const fitted = fitMailEvent(event);

    expect(fitted.rooms[0]).toMatchObject({ reread: true, letters: [letter(1, 100)] });
  });
});

describe('gluedMailEvent: склеенное событие для медленного клиента', () => {
  it('склеенное событие сохраняет отметки человека и удаления: письма и отметки других читателей не едут, reread у каждой комнаты', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const humanRead = { id: 'm-0002', reader: HUMAN, at };
    const event = eventOf(
      [
        room('r-01', { letters: [letter(3, 100)], reads: [{ id: 'm-0001', reader: 's-01', at }, humanRead], deleted: ['m-0001'] }),
        room('r-02', { reads: [{ id: 'm-0010', reader: 's-02', at }] }),
      ],
      [letter(3, 100, '@human')],
    );

    const glued = gluedMailEvent(event);

    expect(glued.rooms[0]).toMatchObject({ roomId: 'r-01', letters: [], reads: [humanRead], deleted: ['m-0001'], reread: true });
    expect(glued.rooms[1]).toMatchObject({ roomId: 'r-02', letters: [], reads: [], deleted: [], reread: true });
    // Числа и кандидаты прежние: окну они нужны и по комнатам, которых оно не держит.
    expect(glued.rooms[0]).toMatchObject({ prevTop: 1, top: 2, total: 2 });
    expect(glued.mentionCandidates).toEqual(event.mentionCandidates);
  });
});

describe('письма чужой записи в пачке (спека 6.11)', () => {
  const direct = (n: number): Message => ({ ...letter(n, 5), roomId: null });
  const other = (n: number): Message => ({ ...letter(n, 5), roomId: 'r-02' });

  it('журнал называет комнаты с письмами по разу; отметок, удалений и снесённых комнат в нём нет', () => {
    const journal = foreignJournal([letter(5, 5), letter(6, 5), other(7), direct(8)]);

    expect(journal.added.map((message) => message.id)).toEqual(['m-0005', 'm-0006', 'm-0007', 'm-0008']);
    expect(journal.rereadRooms).toEqual(['r-01', 'r-02']);
    expect(journal).toMatchObject({ reads: [], deleted: [], droppedRooms: [] });
  });

  it('чужие письма в начатую пачку: prevVersion не растёт, version не падает, письма по возрастанию номера, ожидание снимка — наибольшее', () => {
    const batch = startBatch('/p', 'w-0001', 20);
    joinBatch(batch, { version: 22, journal: { added: [letter(9, 5)], reads: [], deleted: [], droppedRooms: [], rereadRooms: [] }, structural: true });
    expect(batch).toMatchObject({ prevVersion: 20, version: 22, structuralVersion: 22 });

    joinForeign(batch, { prevVersion: 19, version: 21, structuralVersion: 21, journal: foreignJournal([letter(7, 5)]) });

    expect(batch).toMatchObject({ prevVersion: 19, version: 22, structuralVersion: 22, rereadDirect: false });
    expect(batch.journal.added.map((message) => message.id)).toEqual(['m-0007', 'm-0009']);
    expect(batch.journal.rereadRooms).toEqual(['r-01']);
  });

  it('прямые письма чужой записи ставят признак прямого канала: у него нет комнаты в журнале', () => {
    const batch = startBatch('/p', 'w-0001', 20);

    joinForeign(batch, { prevVersion: 20, version: 21, structuralVersion: 21, journal: foreignJournal([direct(3)]) });

    expect(batch).toMatchObject({ version: 21, structuralVersion: 21, rereadDirect: true });
    expect(batch.journal.rereadRooms).toEqual([]);
  });
});
