import { describe, expect, it } from 'vitest';
import type { Message } from '@parley/core';
import type { RoomsMailEvent, RoomsMailRoom } from '@parley/protocol';
import { MAIL_CANDIDATES_MAX_BYTES, MAIL_EVENT_MAX_BYTES, fitMailEvent } from './mail.js';

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
    expect(Buffer.byteLength(JSON.stringify(fitted.mentionCandidates))).toBeLessThanOrEqual(MAIL_CANDIDATES_MAX_BYTES + 2);
    // Остались самые новые, и порядок прежний.
    expect(fitted.mentionCandidates.at(-1)).toEqual(fresh);
    const ids = fitted.mentionCandidates.map((candidate) => candidate.id);
    expect(ids).toEqual([...ids].sort());
    expect(fitted.mentionCandidates.slice(0, -1).at(-1)?.id).toBe(candidates.at(-1)?.id);
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

  it('комната с reread от записи (массовая отметка) не платит за него дважды', () => {
    const event = eventOf([room('r-01', { reread: true, letters: [letter(1, 100)] })]);

    const fitted = fitMailEvent(event);

    expect(fitted.rooms[0]).toMatchObject({ reread: true, letters: [letter(1, 100)] });
  });
});
