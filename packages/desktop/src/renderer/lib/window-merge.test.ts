import { describe, expect, it } from 'vitest';
import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { makeCompactMail, makeRoomNumbers, withCompactMail } from '../test-utils/compact-mail-fixtures.js';
import { WINDOW_ROOM_KEEP, earlierCursor, earlierRemaining, heldRanges, keepHeld, messageSeq, retainSeen, withFreshMessages, withMail, withMessages } from './window-merge.js';

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
/** Компактная карта версии 1 (хвосты писем): тесты ниже читают её поля. */
const v1 = (value: WindowWorkEntry): MapCompact => value.map.compact as MapCompact;

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
    const meta = v1(next);
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
    expect(v1(next).messages.rooms['direct']).toEqual({ total: 2, included: 2, tailFrom: 1 });
    expect(v1(next).messages.total).toBe(2);
    expect(v1(next).unread).toEqual({ letters: 2, rooms: {} });
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
    expect(Object.keys(v1(next).messages.rooms)).toEqual(['r-01']);
    expect(v1(next).messages.total).toBe(9);
  });

  it('письма комнаты, которой в карте нет, не встают в ленту и не заводят итогов', () => {
    const next = withMail(held(), makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-09', { prevTop: 0, top: 1, total: 1, letters: [unreadNote('m-10', { roomId: 'r-09' })] })] }));
    expect(ids(next)).toEqual(['m-08', 'm-09']);
    expect(Object.keys(v1(next).messages.rooms)).toEqual(['r-01']);
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

describe('снимок без писем (compact версии 2, спека rooms.mail 6.8-6.9)', () => {
  const unreadNote = (id: string, patch: Partial<Message> = {}): Message => note(id, { from: 's-02', readBy: {}, ...patch });
  /** Работа с двумя комнатами и прямыми письмами; окно держит письма `held`. */
  const v2 = (held: Message[], patch: Parameters<typeof makeCompactMail>[0] = {}): WindowWorkEntry => {
    const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'Комната'), makeRoom('r-02', 'Другая')] });
    return withCompactMail(
      base,
      makeCompactMail({
        rooms: {
          '': makeRoomNumbers({ total: 2, top: 2, lastAt: 'a2', unread: 1 }),
          'r-01': makeRoomNumbers({ total: 9, top: 9, lastAt: 'a9', unread: 4 }),
          'r-02': makeRoomNumbers({ total: 3, top: 3, lastAt: 'a3', unread: 0 }),
        },
        unread: { letters: 5, rooms: { '': 1, 'r-01': 4 } },
        ...patch,
      }),
      held,
    );
  };
  const meta = (value: WindowWorkEntry) => value.map.compact as ReturnType<typeof makeCompactMail>;
  const letters = (room: string | null, from: number, to: number): Message[] =>
    Array.from({ length: to - from + 1 }, (_, index) => note(`m-${String(from + index).padStart(3, '0')}`, { roomId: room }));
  const batch = (roomPatch: Parameters<typeof makeMailRoom>[1], eventPatch: Partial<Parameters<typeof makeMailEvent>[0]> = {}) =>
    makeMailEvent({ version: 6, prevVersion: 5, ...eventPatch, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, lastAt: 'a10', ...roomPatch })] });

  describe('withMail', () => {
    it('числа берутся из события как есть: итоги комнат, непрочитанное по работе и по комнатам (в том числе у нетронутых), без перевода ключей', () => {
      const next = withMail(
        v2([unreadNote('m-09')]),
        batch({ letters: [unreadNote('m-10')] }, { unread: { letters: 3, rooms: { '': 0, 'r-02': 3 } } }),
        false,
        () => true,
      );
      expect(meta(next).rooms).toEqual({
        '': makeRoomNumbers({ total: 2, top: 2, lastAt: 'a2', unread: 0 }),
        'r-01': makeRoomNumbers({ total: 10, top: 10, lastAt: 'a10', unread: 0 }),
        'r-02': makeRoomNumbers({ total: 3, top: 3, lastAt: 'a3', unread: 3 }),
      });
      expect(meta(next).unread).toEqual({ letters: 3, rooms: { '': 0, 'r-02': 3 } });
      expect(next.map.work.updatedAt).toBe('2026-09-27T10:00:00.000Z');
      // Повтор того же события ставит те же числа: прибавок нет.
      const again = withMail(next, batch({ letters: [unreadNote('m-10')] }, { unread: { letters: 3, rooms: { '': 0, 'r-02': 3 } } }), false, () => true);
      expect(again.map.compact).toEqual(next.map.compact);
    });

    it('письма встают только в открытые комнаты: неоткрытая получает числа, но не письма; отметки встают на держимое', () => {
      const current = v2([unreadNote('m-09')]);
      const open = (roomId: string | null): boolean => roomId === 'r-01';
      const next = withMail(
        current,
        makeMailEvent({
          version: 6,
          prevVersion: 5,
          rooms: [
            makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [unreadNote('m-10')], reads: [{ id: 'm-09', reader: 'human', at: 't1' }] }),
            makeMailRoom('r-02', { prevTop: 3, top: 4, total: 4, letters: [unreadNote('m-11', { roomId: 'r-02' })] }),
            makeMailRoom(null, { prevTop: 2, top: 3, total: 3, letters: [unreadNote('m-12', { roomId: null, to: ['human'] })] }),
          ],
        }),
        false,
        open,
      );
      expect(ids(next)).toEqual(['m-09', 'm-10']);
      expect(next.map.messages[0]?.readBy).toEqual({ human: 't1' });
      expect(meta(next).rooms['r-02']).toMatchObject({ total: 4, top: 4 });
      expect(meta(next).rooms['']).toMatchObject({ total: 3, top: 3 });
    });

    it('итог последнего решения: письмо человека с ответом меняет decision, newest wins; чужие слова и чужое письмо — нет', () => {
      const decided = (id: string, text: string, from = 'human'): Message => note(id, { from, to: ['s-01'], text, readBy: { human: 'x' } });
      const base = v2([], { rooms: { 'r-01': makeRoomNumbers({ total: 9, top: 9, decision: 'returned' }) } });
      const accepted = withMail(base, batch({ letters: [decided('m-10', 'Decision accepted.')] }), false, () => true);
      expect(meta(accepted).rooms['r-01']?.decision).toBe('accepted');
      const reworked = withMail(base, batch({ letters: [decided('m-10', 'Decision accepted.'), decided('m-11', 'Returned for rework: нет')], top: 11, total: 11 }), false, () => true);
      expect(meta(reworked).rooms['r-01']?.decision).toBe('returned');
      // Реплика человека без слов решения и письмо агента с теми же словами итога не меняют.
      const chatter = withMail(base, batch({ letters: [decided('m-10', 'ok, thanks'), decided('m-11', 'Decision accepted.', 's-02')], top: 11, total: 11 }), false, () => true);
      expect(meta(chatter).rooms['r-01']?.decision).toBe('returned');
      // Событие без писем комнаты итог не трогает.
      expect(meta(withMail(base, batch({}), false, () => true)).rooms['r-01']?.decision).toBe('returned');
    });

    describe('кандидаты в упоминания', () => {
      const candidate = (id: string, patch: Partial<Message> = {}): Message => unreadNote(id, { text: 'hi @human', ...patch });
      const ofSet = (value: WindowWorkEntry): string[] => meta(value).mentionCandidates.map((message) => message.id);

      it('снимок заменяет набор, событие дописывает свои новые, без повторов; порядок по номеру', () => {
        const current = v2([], { mentionCandidates: [candidate('m-03'), candidate('m-05')] });
        const next = withMail(current, batch({}, { mentionCandidates: [candidate('m-05', { text: 'fresh @human' }), candidate('m-07')] }), false, () => true);
        expect(ofSet(next)).toEqual(['m-03', 'm-05', 'm-07']);
        expect(meta(next).mentionCandidates[1]?.text).toBe('fresh @human');
      });

      it('уходят id, прочитанные человеком (в том числе в комнате, которой окно не держит), удалённые и письма снятых комнат; чужое чтение — нет', () => {
        const current = v2([], {
          mentionCandidates: [candidate('m-03'), candidate('m-04'), candidate('m-05'), candidate('m-06', { roomId: 'r-02' }), candidate('m-07')],
        });
        const next = withMail(
          current,
          makeMailEvent({
            version: 6,
            prevVersion: 5,
            droppedRooms: ['r-02'],
            rooms: [
              makeMailRoom('r-01', { prevTop: 9, top: 9, total: 9, reads: [{ id: 'm-03', reader: 'human', at: 't' }, { id: 'm-07', reader: 's-02', at: 't' }], deleted: ['m-04'] }),
            ],
          }),
          false,
          () => false,
        );
        expect(ofSet(next)).toEqual(['m-05', 'm-07']);
      });

      it('не больше 200 новейших; кандидаты комнаты, которой нет в карте, не входят', () => {
        const many = Array.from({ length: 205 }, (_, index) => candidate(`m-${index + 1}`));
        const next = withMail(v2([], { mentionCandidates: many.slice(0, 150) }), batch({}, { mentionCandidates: [...many.slice(150), candidate('m-300', { roomId: 'r-99' })] }), false, () => true);
        expect(ofSet(next)).toHaveLength(200);
        expect(ofSet(next)[0]).toBe('m-6');
        expect(ofSet(next).at(-1)).toBe('m-205');
      });

      it('устаревшее событие набор и числа не трогает', () => {
        const current = v2([], { mentionCandidates: [candidate('m-03')] });
        const next = withMail(current, batch({}, { mentionCandidates: [candidate('m-07')], unread: { letters: 0, rooms: {} } }), true, () => true);
        expect(next.map.compact).toEqual(current.map.compact);
      });
    });

    it('droppedRooms: письма и числа комнаты уходят; устаревшее событие их не трогает', () => {
      const current = v2([unreadNote('m-09', { roomId: 'r-02' }), unreadNote('m-08')]);
      const dropped = withMail(current, makeMailEvent({ version: 6, prevVersion: 5, droppedRooms: ['r-02'] }), false, () => true);
      expect(ids(dropped)).toEqual(['m-08']);
      expect(Object.keys(meta(dropped).rooms)).toEqual(['', 'r-01']);
    });
  });

  describe('keepHeld: письма, которые окно держит, переходят в новый снимок', () => {
    it('держимые письма встают в снимок без писем; комнаты, которых больше нет, и первый снимок — как есть', () => {
      const prev = v2([unreadNote('m-08'), unreadNote('m-09', { roomId: 'r-09' }), unreadNote('m-10', { roomId: null })]);
      const next = v2([]);
      expect(ids(keepHeld(prev, next))).toEqual(['m-08', 'm-10']);
      expect(keepHeld(undefined, next)).toBe(next);
      // Остальное берётся из нового снимка.
      expect(keepHeld(prev, next).map.compact).toBe(next.map.compact);
    });

    it('держится не больше 300 новейших писем на комнату (Mail — тоже); подгруженное «раньше» не отбрасывается', () => {
      const prev = v2([...letters('r-01', 1, 450), ...letters('r-02', 1, 40), ...letters(null, 1, 320)]);
      const next = v2([]);
      const kept = keepHeld(prev, next).map.messages;
      const of = (room: string | null): Message[] => kept.filter((message) => message.roomId === room);
      expect(WINDOW_ROOM_KEEP).toBe(300);
      expect(of('r-01')).toHaveLength(300);
      expect(of('r-01')[0]?.id).toBe('m-151');
      expect(of('r-01').at(-1)?.id).toBe('m-450');
      expect(of('r-02')).toHaveLength(40);
      expect(of(null)).toHaveLength(300);
      // Человек подгрузил историю r-01 до m-101: всё, начиная с неё, остаётся.
      const floors = (room: string | null): number | undefined => (room === 'r-01' ? 101 : undefined);
      expect(keepHeld(prev, next, floors).map.messages.filter((message) => message.roomId === 'r-01')).toHaveLength(350);
      // Подгружено всё (`0`): остаётся всё.
      expect(keepHeld(prev, next, (room) => (room === 'r-01' ? 0 : undefined)).map.messages.filter((message) => message.roomId === 'r-01')).toHaveLength(450);
    });

    it('снимок прежнего хоста (compact версии 1 или без compact): письма снимка, а ушедшие из хвоста прочитанные остаются', () => {
      const prev = entry([note('m-01'), note('m-02'), note('m-03')], compact(3, 1));
      const next = entry([note('m-03'), note('m-04')], compact(4, 3));
      expect(ids(keepHeld(prev, next))).toEqual(['m-01', 'm-02', 'm-03', 'm-04']);
      const full = entry([note('m-03')]);
      expect(keepHeld(prev, full)).toBe(full);
    });
  });

  describe('«загрузить раньше» по снимку без писем', () => {
    it('earlierRemaining: total комнаты из compact минус держимое; комнаты нет в снимке — 0', () => {
      const current = v2([note('m-08'), note('m-09'), note('m-02', { roomId: null })]);
      expect(earlierRemaining(current, 'r-01')).toBe(7);
      expect(earlierRemaining(current, 'r-02')).toBe(3);
      expect(earlierRemaining(current, 'r-77')).toBe(0);
      expect(earlierRemaining(v2(letters('r-01', 1, 9)), 'r-01')).toBe(0);
    });

    it('earlierCursor: перед наименьшим держимым номером комнаты; ничего не держится — самые новые', () => {
      const current = v2([note('m-08'), note('m-09'), note('m-02', { roomId: null })]);
      expect(earlierCursor(current, 'r-01')).toBe('before:8');
      expect(earlierCursor(current, 'r-02')).toBeUndefined();
    });
  });
});
