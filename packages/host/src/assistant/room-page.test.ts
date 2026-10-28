import { describe, expect, it } from 'vitest';
import type { Message, WorkEntry, WorkMap } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { targetsOf, type AssistantTarget, type OverviewSource } from './overview.js';
import { LETTER_MAX, PAGE_BUDGET, ROOM_PAGE, ROOM_PAGE_MAX, roomPageText, type LetterPage } from './room-page.js';

function session(id: string, label: string) {
  return { id, label, provider: 'claude', task: `task of ${label}`, summary: null, lifecycle: 'active' };
}
function entry(projectPath: string, workId: string, title: string): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status: 'active' },
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera')],
      messages: [],
      rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05'], createdAt: '', lead: 's-03', proposal: null }],
    } as unknown as WorkMap,
  };
}
const live = (activity: string): SessionLive => ({ activity: { activity, waitingFor: null }, metrics: null }) as unknown as SessionLive;

const src: OverviewSource = {
  entries: [entry('/p/one', 'w-1', 'Parley')],
  live: () => live('idle'),
  roomTail: () => [],
};
const room = targetsOf(src).find((target): target is Extract<AssistantTarget, { kind: 'room' }> => target.kind === 'room')!;

/** Письмо комнаты r-1 с номером `n`; время растёт вместе с номером. */
function letter(n: number, text = `letter ${n}`): Message {
  return {
    id: `m-${n}`,
    roomId: 'r-1',
    from: n % 2 === 0 ? 's-05' : 's-03',
    to: [],
    at: new Date(Date.UTC(2026, 9, 28, 11, 0, n)).toISOString(),
    text,
    kind: 'note',
  } as Message;
}
/** Фейк `LetterPage` поверх массива: страница от новых к старым, как у хранилища. */
function readOf(letters: readonly Message[], calls: Array<{ beforeSeq?: number; limit: number }> = []): LetterPage {
  return (_entry, roomId, query) => {
    calls.push(query);
    return letters
      .filter((message) => message.roomId === roomId)
      .filter((message) => query.beforeSeq === undefined || Number(message.id.slice(2)) < query.beforeSeq)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))
      .slice(0, query.limit);
  };
}
const items45 = Array.from({ length: 45 }, (_, index) => letter(index + 1));
const read = readOf(items45);
const readLong = readOf(Array.from({ length: 30 }, (_, index) => letter(index + 1, 'x'.repeat(5000))));

describe('roomPageText', () => {
  it('по умолчанию 30 последних, старые — по курсору', () => {
    const text = roomPageText(src, room, {}, read);
    expect(text).toContain('[m-45 · ');
    expect(text).not.toContain('[m-15 · ');
    expect(text).toMatch(/Older messages: call parley_room with before=16$/);
    const older = roomPageText(src, room, { before: 16 }, read);
    expect(older).toContain('[m-1 · ');
    expect(older).toMatch(/This is the beginning of the room\.$/);
    expect(older).not.toContain('Older messages');
  });
  it('письма идут от старых к новым, строка письма — id, время, автор и вид', () => {
    const text = roomPageText(src, room, { limit: 3 }, read);
    expect(text).toContain('Messages, oldest first:\n[m-43 · 2026-10-28T11:00:43.000Z · S03 Ruslan · note]\nletter 43\n[m-44 · ');
    expect(text.indexOf('[m-43 · ')).toBeLessThan(text.indexOf('[m-45 · '));
    expect(text).toMatch(/\[m-45 · [^\]]+ · S03 Ruslan · note\]\nletter 45\nOlder messages: call parley_room with before=43$/);
  });
  it('письмо длиннее 4000 — с многоточием, бюджет страницы держится', () => {
    const text = roomPageText(src, room, {}, readLong);
    expect(text).toContain(`${'x'.repeat(LETTER_MAX - 1)}…`);
    expect(text).not.toContain('x'.repeat(LETTER_MAX));
    expect(text.length).toBeLessThanOrEqual(PAGE_BUDGET + 2000);
    expect(text).toMatch(/before=\d+$/);
  });
  it('комната без писем — начало ленты без курсора', () => {
    expect(roomPageText(src, room, {}, () => [])).toMatch(/No messages yet\.\nThis is the beginning of the room\.$/);
  });
  it('курсор «до» дошёл до начала — без «No messages yet», когда страница пуста', () => {
    const text = roomPageText(src, room, { before: 1 }, read);
    expect(text).not.toContain('No messages yet');
    expect(text).toMatch(/This is the beginning of the room\.$/);
  });
  it('шапка — участники, ведущий и решение', () => {
    expect(roomPageText(src, room, {}, read)).toMatch(/^Room "Auth" in Parley · one; members: S03 Ruslan, S05 Vera/);
  });
  it('limit зажат в 1…50, хост просит на одно письмо больше', () => {
    const calls: Array<{ beforeSeq?: number; limit: number }> = [];
    const spy = readOf(items45, calls);
    roomPageText(src, room, {}, spy);
    roomPageText(src, room, { limit: 500 }, spy);
    roomPageText(src, room, { limit: 0 }, spy);
    roomPageText(src, room, { limit: 5, before: 20 }, spy);
    expect(calls).toEqual([{ limit: ROOM_PAGE + 1 }, { limit: ROOM_PAGE_MAX + 1 }, { limit: 2 }, { beforeSeq: 20, limit: 6 }]);
  });
  it('limit меньше числа писем — есть курсор, ровно limit писем', () => {
    const text = roomPageText(src, room, { limit: 5 }, read);
    expect(text.match(/^\[m-\d+ · /gm)).toHaveLength(5);
    expect(text).toMatch(/before=41$/);
  });
  it('комнаты нет в снимке — сообщение, как у detailText', () => {
    const gone = { ...room, workId: 'w-404' };
    expect(roomPageText(src, gone, {}, read)).toBe('Auth is no longer in Parley.');
    expect(roomPageText(src, { ...room, roomId: 'r-404' }, {}, read)).toBe('Auth is no longer in Parley.');
  });
});
