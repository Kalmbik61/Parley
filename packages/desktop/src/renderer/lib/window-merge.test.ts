import { describe, expect, it } from 'vitest';
import type { MapCompact, Message, WorkEntry } from '@parley/core';
import { makeLetter, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { earlierCursor, earlierRemaining, messageSeq, retainSeen, withMessages } from './window-merge.js';

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

function entry(messages: Message[], meta?: MapCompact): WorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'Комната')], messages });
  return meta === undefined ? base : { ...base, map: { ...base.map, compact: meta } };
}

const ids = (value: WorkEntry): string[] => value.map.messages.map((message) => message.id);

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
