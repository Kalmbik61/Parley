import { describe, expect, it } from 'vitest';
import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { earlierCursor, earlierRemaining, heldRanges, messageSeq, retainSeen, withFreshMessages, withMail, withMessages } from './window-merge.js';

const note = (id: string, patch: Partial<Message> = {}): Message =>
  makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' }, ...patch });

function compact(total: number, tailFrom: number | null, extra: Partial<MapCompact> = {}): MapCompact {
  return {
    version: 1,
    messages: { total, included: 0, latestId: `m-${total}`, rooms: { 'r-01': { total, included: 0, tailFrom } } },
    unread: { letters: 0, rooms: {} },
    cut: [],
    omitted: {},
    ...extra,
  };
}

function entry(messages: Message[], meta?: MapCompact): WindowWorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'Комната')], messages });
  return meta === undefined ? base : { ...base, map: { ...base.map, compact: meta } };
}

const ids = (value: WindowWorkEntry): string[] => value.map.messages.map((message) => message.id);

describe('retainSeen: хвост сдвинулся, а окно держало больше', () => {
  it('прочитанные письма прежнего снимка, которых нет в новом, остаются; порядок — по номеру', () => {
    const prev = entry([note('m-01'), note('m-02'), note('m-03')], compact(3, 1));
    const next = entry([note('m-03'), note('m-04')], compact(4, 3));
    expect(ids(retainSeen(prev, next))).toEqual(['m-01', 'm-02', 'm-03', 'm-04']);
  });

  it('письмо в обоих снимках берётся из нового (свежие отметки прочтения)', () => {
    const prev = entry([note('m-03', { readBy: {} })], compact(3, 3));
    const next = entry([note('m-03', { readBy: { human: 'now' } })], compact(3, 3));
    expect(retainSeen(prev, next).map.messages[0]?.readBy).toEqual({ human: 'now' });
  });

  it('непрочитанное человеком в прежней копии не переносится: стухшая копия горела бы счётчиком вечно', () => {
    const unread = note('m-01', { from: 's-02', readBy: {} });
    const prev = entry([unread, note('m-02')], compact(2, 1));
    const next = entry([note('m-03')], compact(3, 3));
    expect(ids(retainSeen(prev, next))).toEqual(['m-02', 'm-03']);
  });

  it('письма комнаты, которой в новой карте нет, не переносятся; полная карта прежнего хоста — как есть', () => {
    const prev = entry([note('m-01', { roomId: 'r-09' }), note('m-02')], compact(2, 1));
    const next = entry([note('m-03')], compact(3, 3));
    expect(ids(retainSeen(prev, next))).toEqual(['m-02', 'm-03']);
    const full = entry([note('m-03')]);
    expect(retainSeen(prev, full)).toBe(full);
    expect(retainSeen(undefined, next)).toBe(next);
  });
});

describe('страницы старых писем', () => {
  it('withMessages: письма страницы встают по номеру, письма снимка не заменяются', () => {
    const current = entry([note('m-08', { text: 'свежее' }), note('m-09')], compact(9, 8));
    const merged = withMessages(current, [note('m-06'), note('m-07'), note('m-08', { text: 'со страницы' })]);
    expect(ids(merged)).toEqual(['m-06', 'm-07', 'm-08', 'm-09']);
    expect(merged.map.messages.find((message) => message.id === 'm-08')?.text).toBe('свежее');
    expect(withMessages(current, [])).toBe(current);
  });

  it('earlierRemaining: всего в комнате минус то, что держит окно; без compact — 0', () => {
    expect(earlierRemaining(entry([note('m-08'), note('m-09')], compact(9, 8)), 'r-01')).toBe(7);
    expect(earlierRemaining(entry([note('m-08')], compact(1, 8)), 'r-01')).toBe(0);
    expect(earlierRemaining(entry([note('m-08')]), 'r-01')).toBe(0);
    expect(earlierRemaining(entry([note('m-08')], compact(9, 8)), 'r-77')).toBe(0);
    // Письма других комнат не считаются.
    expect(earlierRemaining(entry([note('m-08'), note('m-09', { roomId: null })], compact(9, 8)), 'r-01')).toBe(8);
  });

  it('earlierCursor: перед хвостом без дыр; хвоста нет — самые новые', () => {
    expect(earlierCursor(entry([], compact(9, 8)), 'r-01')).toBe('before:8');
    expect(earlierCursor(entry([], compact(9, null)), 'r-01')).toBeUndefined();
    expect(earlierCursor(entry([]), 'r-01')).toBeUndefined();
    expect(messageSeq({ id: 'm-12' })).toBe(12);
  });
});

describe('withMail: событие rooms.mail в карте окна (спека rooms.mail 6.3-6.4)', () => {
  const unreadNote = (id: string, patch: Partial<Message> = {}): Message => note(id, { from: 's-02', readBy: {}, ...patch });
  /** Карта с двумя письмами комнаты и «старыми» счётчиками, чтобы присвоение из события было заметно. */
  const held = (): WindowWorkEntry =>
    entry([unreadNote('m-08'), unreadNote('m-09')], compact(9, 8, { unread: { letters: 7, rooms: { 'r-01': 7 } } }));
  const batch = (roomPatch: Parameters<typeof makeMailRoom>[1], eventPatch: Partial<Parameters<typeof makeMailEvent>[0]> = {}) =>
    makeMailEvent({ version: 6, prevVersion: 5, ...eventPatch, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, ...roomPatch })] });

  it('письма встают по номеру; копия события заменяет держимую, но отметки прочтения только прибавляются', () => {
    const current = entry([unreadNote('m-08', { readBy: { human: 't1' } }), unreadNote('m-09')], compact(9, 8));
    const next = withMail(current, batch({ letters: [unreadNote('m-09', { readBy: { human: 't2' } }), unreadNote('m-10')] }));
    expect(ids(next)).toEqual(['m-08', 'm-09', 'm-10']);
    expect(next.map.messages[1]?.readBy).toEqual({ human: 't2' });
    // Запоздалое событие со старой копией письма не стирает отметку, которую окно уже держит.
    const stale = withMail(next, batch({ letters: [unreadNote('m-09', { readBy: {} }), unreadNote('m-10')] }));
    expect(stale.map.messages[1]?.readBy).toEqual({ human: 't2' });
  });

  it('reads: отметка читателя встаёт на держимое письмо; чужого письма и повторной отметки это не касается', () => {
    const current = entry([unreadNote('m-08'), unreadNote('m-09', { readBy: { human: 'first' } })], compact(9, 8));
    const next = withMail(
      current,
      batch({
        reads: [
          { id: 'm-08', reader: 'human', at: 't9' },
          { id: 'm-09', reader: 'human', at: 'second' },
          { id: 'm-77', reader: 'human', at: 't9' },
        ],
      }),
    );
    expect(next.map.messages.map((message) => message.readBy)).toEqual([{ human: 't9' }, { human: 'first' }]);
    expect(ids(next)).toEqual(['m-08', 'm-09']);
  });

  it('deleted: письмо остаётся в ленте с пометкой, как в снимке хоста', () => {
    const next = withMail(held(), batch({ deleted: ['m-09', 'm-77'] }));
    expect(ids(next)).toEqual(['m-08', 'm-09']);
    expect(next.map.messages.map((message) => message.deleted)).toEqual([undefined, true]);
  });

  it('числа присваиваются из события: непрочитанное по работе (без ключа прямых писем), итог комнаты и работы, updatedAt', () => {
    const next = withMail(
      held(),
      batch(
        { letters: [unreadNote('m-10')], lastAt: 'x' },
        { updatedAt: '2026-09-27T11:00:00.000Z', unread: { letters: 5, rooms: { '': 2, 'r-01': 3 } } },
      ),
    );
    const meta = next.map.compact!;
    // `event.unread.letters` — всего по работе; в снимке `unread.letters` — только прямые письма: ключ `''`.
    expect(meta.unread).toEqual({ letters: 2, rooms: { 'r-01': 3 } });
    expect(meta.messages.rooms['r-01']).toMatchObject({ total: 10, included: 3 });
    expect(meta.messages.total).toBe(10);
    expect(meta.messages.included).toBe(3);
    expect(meta.messages.latestId).toBe('m-10');
    expect(next.map.work.updatedAt).toBe('2026-09-27T11:00:00.000Z');
    // Те же числа от повторного применения: прибавок нет.
    const again = withMail(next, batch({ letters: [unreadNote('m-10')] }, { updatedAt: '2026-09-27T11:00:00.000Z', unread: { letters: 5, rooms: { '': 2, 'r-01': 3 } } }));
    expect(again.map.compact).toEqual(meta);
    expect(ids(again)).toEqual(['m-08', 'm-09', 'm-10']);
  });

  it('прямые письма: ключ direct в итогах, хвост берётся с первого письма события, если его не было', () => {
    const base = entry([], {
      ...compact(0, null),
      messages: { total: 0, included: 0, latestId: null, rooms: { direct: { total: 0, included: 0, tailFrom: null } } },
    });
    const next = withMail(
      base,
      makeMailEvent({
        version: 2,
        prevVersion: 1,
        rooms: [makeMailRoom(null, { prevTop: 0, top: 2, total: 2, letters: [note('m-01', { roomId: null, to: ['human'] }), note('m-02', { roomId: null, to: ['human'] })] })],
        unread: { letters: 2, rooms: { '': 2 } },
      }),
    );
    expect(next.map.compact?.messages.rooms['direct']).toEqual({ total: 2, included: 2, tailFrom: 1 });
    expect(next.map.compact?.messages.total).toBe(2);
    expect(next.map.compact?.unread).toEqual({ letters: 2, rooms: {} });
  });

  it('droppedRooms: письма и итоги комнаты уходят, итог работы убывает на её счёт', () => {
    const two = entry([unreadNote('m-08'), unreadNote('m-09', { roomId: 'r-02' })], {
      ...compact(9, 8),
      messages: {
        total: 12,
        included: 2,
        latestId: 'm-12',
        rooms: { 'r-01': { total: 9, included: 1, tailFrom: 8 }, 'r-02': { total: 3, included: 1, tailFrom: 9 } },
      },
    });
    const next = withMail(two, makeMailEvent({ version: 6, prevVersion: 5, droppedRooms: ['r-02'], unread: { letters: 0, rooms: {} } }));
    expect(ids(next)).toEqual(['m-08']);
    expect(Object.keys(next.map.compact!.messages.rooms)).toEqual(['r-01']);
    expect(next.map.compact?.messages.total).toBe(9);
  });

  it('письма комнаты, которой в карте нет, не встают в ленту и не заводят итогов', () => {
    const next = withMail(held(), makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-09', { prevTop: 0, top: 1, total: 1, letters: [unreadNote('m-10', { roomId: 'r-09' })] })] }));
    expect(ids(next)).toEqual(['m-08', 'm-09']);
    expect(Object.keys(next.map.compact!.messages.rooms)).toEqual(['r-01']);
  });

  it('устаревшее событие (stale): письма и отметки сливаются, числа, updatedAt и droppedRooms не трогаются', () => {
    const before = held();
    const next = withMail(
      before,
      batch({ letters: [unreadNote('m-10')], reads: [{ id: 'm-08', reader: 'human', at: 't9' }] }, { updatedAt: '2030-01-01T00:00:00.000Z', droppedRooms: ['r-01'], unread: { letters: 0, rooms: { 'r-01': 0 } } }),
      true,
    );
    expect(ids(next)).toEqual(['m-08', 'm-09', 'm-10']);
    expect(next.map.messages[0]?.readBy).toEqual({ human: 't9' });
    expect(next.map.compact).toEqual(before.map.compact);
    expect(next.map.work.updatedAt).toBe(before.map.work.updatedAt);
  });

  it('карта прежнего хоста без compact: письма сливаются, итогов не заводится', () => {
    const full = entry([unreadNote('m-08')]);
    const next = withMail(full, batch({ letters: [unreadNote('m-09')], total: 9 }));
    expect(ids(next)).toEqual(['m-08', 'm-09']);
    expect(next.map.compact).toBeUndefined();
  });
});

describe('withFreshMessages: страницы после разрыва', () => {
  it('свежая копия заменяет держимую, отметки только прибавляются; письмо исчезнувшей комнаты не воскресает', () => {
    const current = entry([note('m-08', { readBy: { human: 'kept' } }), note('m-09', { readBy: {} })], compact(9, 8));
    const next = withFreshMessages(current, [
      note('m-08', { readBy: {} }),
      note('m-09', { readBy: { human: 'now' } }),
      note('m-10'),
      note('m-11', { roomId: 'r-09' }),
    ]);
    expect(ids(next)).toEqual(['m-08', 'm-09', 'm-10']);
    expect(next.map.messages.map((message) => message.readBy)).toEqual([{ human: 'kept' }, { human: 'now' }, { human: 'x' }]);
    expect(withFreshMessages(current, [])).toBe(current);
  });
});

describe('heldRanges: что окно держит по комнатам', () => {
  it('наименьший и наибольший номер на комнату; прямые письма — ключ null; пусто — ничего', () => {
    const current = entry([note('m-08'), note('m-05'), note('m-09'), note('m-02', { roomId: null }), note('m-04', { roomId: 'r-02' })]);
    expect([...heldRanges(current)]).toEqual([
      ['r-01', { min: 5, max: 9 }],
      [null, { min: 2, max: 2 }],
      ['r-02', { min: 4, max: 4 }],
    ]);
    expect(heldRanges(entry([])).size).toBe(0);
  });
});
