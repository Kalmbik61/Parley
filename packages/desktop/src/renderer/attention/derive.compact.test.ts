import { describe, expect, it } from 'vitest';
import type { MapCompact, Message } from '@parley/core';
import { makeCompactMail, makeRoomNumbers, withCompactMail } from '../test-utils/compact-mail-fixtures.js';
import { makeLetter, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { forYouTarget, humanUnreadMentions, roomDecisionReturned, roomUnreadForHuman, workAttention } from './derive.js';

const compact = (unread: MapCompact['unread']): MapCompact => ({
  version: 1,
  messages: { total: 500, included: 1, latestId: 'm-500', rooms: {} },
  unread,
  cut: [],
  omitted: {},
});

describe('внимание по компактной карте (P35)', () => {
  it('непрочитанное в комнатах и прямые письма — точные счётчики хоста, а не письма окна', () => {
    const entry = makeWork('w-01', {
      sessions: [makeSession('s-01', 'план')],
      rooms: [makeRoom('r-01', 'К'), makeRoom('r-02', 'Д')],
      // В окне одно непрочитанное письмо, на деле их 250 в комнате и 3 прямых.
      messages: [makeLetter('m-500', { roomId: 'r-01', to: [], from: 's-01', readBy: {} })],
    });
    const map = { ...entry.map, compact: compact({ letters: 3, rooms: { 'r-01': 250 } }) };
    expect(roomUnreadForHuman(map, 'r-01')).toBe(250);
    expect(roomUnreadForHuman(map, 'r-02')).toBe(0);
    const attention = workAttention({ ...entry, map }, {});
    expect(attention.roomsUnread).toEqual({ 'r-01': 250 });
    expect(attention.humanUnread).toBe(3);
  });

  it('карта без compact (хост до P35) считается по письмам, как прежде', () => {
    const entry = makeWork('w-01', {
      sessions: [makeSession('s-01', 'план')],
      rooms: [makeRoom('r-01', 'К')],
      messages: [
        makeLetter('m-01', { roomId: 'r-01', to: [], from: 's-01', readBy: {} }),
        makeLetter('m-02', { roomId: 'r-01', to: [], from: 's-01', readBy: {} }),
        makeLetter('m-03', { roomId: null, to: ['human'], from: 's-01', readBy: {} }),
      ],
    });
    expect(roomUnreadForHuman(entry.map, 'r-01')).toBe(2);
    expect(workAttention(entry, {}).humanUnread).toBe(1);
  });
});

describe('внимание по снимку без писем (compact версии 2, спека rooms.mail 6.9)', () => {
  const mention = (id: string, patch: Partial<Message> = {}): Message =>
    makeLetter(id, { roomId: 'r-01', from: 's-02', to: [], text: 'Your call, @human', readBy: {}, ...patch });
  /** Работа без держимых писем: всё, что окно знает, лежит в `compact`. */
  const v2 = (patch: Parameters<typeof makeCompactMail>[0] = {}, rooms = [makeRoom('r-01', 'К'), makeRoom('r-02', 'Д')]) =>
    withCompactMail(
      makeWork('w-01', { sessions: [makeSession('s-01', 'план')], rooms }),
      makeCompactMail({
        rooms: {
          '': makeRoomNumbers({ total: 4, top: 4, unread: 0 }),
          'r-01': makeRoomNumbers({ total: 90, top: 90, lastAt: '2026-09-27T12:00:00.000Z', unread: 30 }),
          'r-02': makeRoomNumbers({ total: 10, top: 94, lastAt: '2026-09-27T13:00:00.000Z', unread: 10 }),
        },
        unread: { letters: 40, rooms: { 'r-01': 30, 'r-02': 10 } },
        ...patch,
      }),
    );

  it('карточка решения: decision returned из снимка; accepted, null и комнаты без записи — нет', () => {
    const e = v2({ rooms: { 'r-01': makeRoomNumbers({ decision: 'returned' }), 'r-02': makeRoomNumbers({ decision: 'accepted' }) } });
    expect(roomDecisionReturned(e.map, 'r-01')).toBe(true);
    expect(roomDecisionReturned(e.map, 'r-02')).toBe(false);
    expect(roomDecisionReturned(e.map, 'r-03')).toBe(false);
  });

  it('значок упоминаний считает только кандидатов, прошедших hasHumanMention: @human внутри кода не считается', () => {
    const e = v2({
      mentionCandidates: [
        mention('m-1'),
        mention('m-2', { text: 'run `@human` in a shell' }),
        mention('m-3', { text: '```\n@human\n```' }),
        mention('m-4', { roomId: 'r-02', text: '**@human**' }),
        mention('m-5', { text: 'mail user@human.dev' }),
        mention('m-6', { readBy: { human: 't' } }),
        mention('m-7', { from: 'human' }),
      ],
    });
    expect(humanUnreadMentions(e.map).map((message) => message.id)).toEqual(['m-1', 'm-4']);
    const attention = workAttention(e, {});
    expect(attention.roomMentions).toEqual({ 'r-01': 1, 'r-02': 1 });
    // Значок `✉N` — прямые письма (0) и упоминания (2), а не 40 непрочитанных по всем комнатам: те сообщения — фон.
    expect(attention.humanUnread).toBe(2);
    expect(attention.level).toBe('unseen');
    // Счётчики комнат — точные числа снимка.
    expect(attention.roomsUnread).toEqual({ 'r-01': 30, 'r-02': 10 });
  });

  it('прямые письма в значке — число снимка по ключу прямых писем, упоминания добавляются к нему без повтора', () => {
    const e = v2({ unread: { letters: 43, rooms: { '': 3, 'r-01': 30, 'r-02': 10 } }, mentionCandidates: [mention('m-1')] });
    expect(workAttention(e, {}).humanUnread).toBe(4);
    expect(workAttention(v2(), {}).humanUnread).toBe(0);
  });

  it('архивная комната упоминаний и непрочитанного не даёт', () => {
    const archived = { ...makeRoom('r-01', 'К'), archivedAt: '2026-09-27T14:00:00.000Z' };
    const e = v2({ mentionCandidates: [mention('m-1'), mention('m-2', { roomId: 'r-02' })] }, [archived, makeRoom('r-02', 'Д')]);
    expect(humanUnreadMentions(e.map).map((message) => message.id)).toEqual(['m-2']);
    expect(workAttention(e, {}).roomMentions).toEqual({ 'r-02': 1 });
  });

  it('«для вас»: есть непрочитанные прямые — Mail; иначе комната последнего упоминания из кандидатов; ничего — null', () => {
    const candidates = [mention('m-1'), mention('m-2', { roomId: 'r-02' }), mention('m-3', { roomId: 'r-01', text: '`@human`' })];
    expect(forYouTarget(v2({ mentionCandidates: candidates }).map)).toEqual({ kind: 'room', roomId: 'r-02' });
    expect(forYouTarget(v2({ unread: { letters: 41, rooms: { '': 1, 'r-01': 30, 'r-02': 10 } }, mentionCandidates: candidates }).map)).toEqual({ kind: 'mail' });
    expect(forYouTarget(v2().map)).toBeNull();
  });

  it('время последнего события — позднее из работы, сессий и lastAt комнат и прямых писем; архивная комната не поднимает', () => {
    const e = v2({ rooms: { '': makeRoomNumbers({ lastAt: '2026-09-27T15:00:00.000Z' }), 'r-01': makeRoomNumbers({ lastAt: '2026-09-27T16:00:00.000Z' }), 'r-02': makeRoomNumbers({ lastAt: null }) } });
    expect(workAttention(e, {}).lastEventAt).toBe('2026-09-27T16:00:00.000Z');
    const archived = { ...makeRoom('r-01', 'К'), archivedAt: '2026-09-27T14:00:00.000Z' };
    const withArchive = v2({ rooms: { '': makeRoomNumbers({ lastAt: '2026-09-27T15:00:00.000Z' }), 'r-01': makeRoomNumbers({ lastAt: '2026-09-27T16:00:00.000Z' }) } }, [archived]);
    expect(workAttention(withArchive, {}).lastEventAt).toBe('2026-09-27T15:00:00.000Z');
  });
});

describe('старый хост (compact версии 1): потребители работают по письмам снимка', () => {
  const entry = makeWork('w-01', {
    sessions: [makeSession('s-01', 'план')],
    rooms: [makeRoom('r-01', 'К'), makeRoom('r-02', 'Д')],
    messages: [
      makeLetter('m-1', { roomId: 'r-01', from: 's-02', to: [], text: 'Your call, @human', readBy: {} }),
      makeLetter('m-2', { roomId: 'r-02', from: 's-02', to: [], text: 'plain', at: '2026-09-27T18:00:00.000Z', readBy: {} }),
      makeLetter('m-3', { roomId: 'r-02', from: 'human', to: ['s-02'], text: 'Returned for rework: no', readBy: {} }),
    ],
  });
  const map = { ...entry.map, compact: compact({ letters: 3, rooms: { 'r-01': 1, 'r-02': 1 } }) };

  it('решение — по письмам, упоминания и «для вас» — по письмам, время — по письмам, значок — число хоста плюс упоминания', () => {
    expect(roomDecisionReturned(map, 'r-02')).toBe(true);
    expect(humanUnreadMentions(map).map((message) => message.id)).toEqual(['m-1']);
    expect(forYouTarget({ ...map, compact: compact({ letters: 0, rooms: {} }) })).toEqual({ kind: 'room', roomId: 'r-01' });
    const attention = workAttention({ ...entry, map }, {});
    expect(attention.lastEventAt).toBe('2026-09-27T18:00:00.000Z');
    expect(attention.humanUnread).toBe(4);
    expect(attention.roomMentions).toEqual({ 'r-01': 1 });
  });
});
