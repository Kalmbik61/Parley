/**
 * Тест 3 куска 3.6 плана окна: `▤` в ленте комнаты снимается только после
 * того, как письмо прочли все адресаты, а не после первого прочтения. Заодно
 * проверяет фильтр по `roomId` и заголовок/участников (спека 6.3).
 */

import { describe, expect, it } from 'vitest';
import type { Message, Room, WorkEntry, WorkSession } from '@harnas/core';
import type { WorkLayout } from '../../shared/layout-types.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { roomKey, roomLastAt, roomSessions, roomTabState, roomView } from './room-view.js';

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function message(partial: Partial<Message> & Pick<Message, 'id' | 'from' | 'to' | 'at' | 'roomId'>): Message {
  return { text: 'текст', kind: 'note', readBy: {}, ...partial };
}

function room(id: string, title: string, creator: string, members: string[]): Room {
  return { id, title, creator, members, createdAt: '2026-01-01T00:00:00.000Z' };
}

function entryWith(sessions: WorkSession[], rooms: Room[], messages: Message[]): WorkEntry {
  return {
    projectPath: '/tmp/w-01',
    map: {
      schemaVersion: 2,
      rooms,
      work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages,
    },
  };
}

const providers = [{ id: 'claude', label: 'Claude' }];

describe('roomView — тест 3: ▤ снимается только после прочтения всеми адресатами', () => {
  it('рассылка «всем»: пока хоть один участник не прочёл — unread: true', () => {
    const entry = entryWith(
      [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'фронт')],
      [room('r-01', 'Обсуждение', 's-01', ['s-02', 's-03'])],
      [
        message({
          id: 'm-1',
          roomId: 'r-01',
          from: 's-01',
          to: [],
          at: '2026-01-01T10:00:00.000Z',
          readBy: { 's-02': '2026-01-01T10:01:00.000Z' },
        }),
      ],
    );

    const view = roomView(entry, 'r-01', providers, {});
    expect(view?.letters).toHaveLength(1);
    // s-03 ещё не прочёл — письмо остаётся непрочитанным для ленты.
    expect(view?.letters[0]?.unread).toBe(true);
  });

  it('прочли все адресаты — unread: false', () => {
    const entry = entryWith(
      [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'фронт')],
      [room('r-01', 'Обсуждение', 's-01', ['s-02', 's-03'])],
      [
        message({
          id: 'm-1',
          roomId: 'r-01',
          from: 's-01',
          to: [],
          at: '2026-01-01T10:00:00.000Z',
          readBy: { 's-02': '2026-01-01T10:01:00.000Z', 's-03': '2026-01-01T10:02:00.000Z' },
        }),
      ],
    );

    const view = roomView(entry, 'r-01', providers, {});
    expect(view?.letters[0]?.unread).toBe(false);
  });

  it('письма другой комнаты и прямые письма в ленту не попадают; заголовок и участники — из комнаты', () => {
    const entry = entryWith(
      [session('s-01', 'план'), session('s-02', 'бэкенд')],
      [room('r-01', 'Обсуждение', 's-01', ['s-02'])],
      [
        message({ id: 'm-room', roomId: 'r-01', from: 's-01', to: [], at: '2026-01-01T10:00:00.000Z' }),
        message({ id: 'm-other-room', roomId: 'r-02', from: 's-01', to: [], at: '2026-01-01T10:01:00.000Z' }),
        message({ id: 'm-direct', roomId: null, from: 's-01', to: ['s-02'], at: '2026-01-01T10:02:00.000Z' }),
      ],
    );

    const view = roomView(entry, 'r-01', providers, {});
    expect(view?.letters.map((letter) => letter.id)).toEqual(['m-room']);
    expect(view?.title).toBe('Обсуждение');
    expect(view?.participants).toEqual(['S01 (Claude)', 'S02 (Claude)', 'You']);
  });

  it('комнаты с таким id нет — null', () => {
    const entry = entryWith([session('s-01', 'план')], [], []);
    expect(roomView(entry, 'r-01', providers, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Кусок 5 плана «Organic»: помощники строки комнаты в сайдбаре (спека окна 2026-09-29, 1.2, 2.6).
// ---------------------------------------------------------------------------

describe('roomSessions — участники-сессии комнаты по записи', () => {
  const map = (sessions: WorkSession[]) => makeWork('w-01', { sessions }).map;
  const live = (id: string, patch: Partial<WorkSession> = {}) => makeSession(id, id, patch);

  it('создатель-сессия первым, затем members; человек, повторы и сессии, которых нет в карте, не входят', () => {
    const room = { ...makeRoom('r-01', 'R'), creator: 's-01', members: ['s-03', 's-02', 's-03', 's-99', 'human'] };
    const found = roomSessions(map([live('s-01'), live('s-02'), live('s-03')]), room);
    expect(found.map((item) => item.id)).toEqual(['s-01', 's-03', 's-02']);
  });

  it('создатель — человек: только members, порядок записи, закрытые тоже входят', () => {
    const room = { ...makeRoom('r-01', 'R'), members: ['s-02', 's-01'] };
    const found = roomSessions(map([live('s-01', { lifecycle: 'closed' }), live('s-02')]), room);
    expect(found.map((item) => item.id)).toEqual(['s-02', 's-01']);
  });

  it('комната без участников — пусто', () => {
    expect(roomSessions(map([live('s-01')]), makeRoom('r-01', 'R'))).toEqual([]);
  });
});

describe('roomLastAt — время последнего события комнаты', () => {
  const message = (id: string, roomId: string | null, at: string): Message => ({
    id,
    roomId,
    from: 's-01',
    to: [],
    at,
    text: 'text',
    kind: 'note',
    readBy: {},
  });
  const room = { ...makeRoom('r-01', 'R'), createdAt: '2026-09-29T08:00:00.000Z' };
  const mapWith = (messages: Message[]) => makeWork('w-01', { messages, rooms: [room] }).map;

  it('позднее из сообщений этой комнаты; чужие комнаты и прямые письма не в счёт', () => {
    const map = mapWith([
      message('m-1', 'r-01', '2026-09-29T09:00:00.000Z'),
      message('m-2', 'r-01', '2026-09-29T11:00:00.000Z'),
      message('m-3', 'r-02', '2026-09-29T12:00:00.000Z'),
      message('m-4', null, '2026-09-29T13:00:00.000Z'),
    ]);
    expect(roomLastAt(map, room)).toBe('2026-09-29T11:00:00.000Z');
  });

  it('решение позднее последнего сообщения — время решения (оно не письмо, но событие комнаты)', () => {
    const waiting = { ...room, proposal: { id: 'p-01', from: 's-01', text: 'x', rev: 0, at: '2026-09-29T12:30:00.000Z' } };
    expect(roomLastAt(mapWith([message('m-1', 'r-01', '2026-09-29T09:00:00.000Z')]), waiting)).toBe('2026-09-29T12:30:00.000Z');
    const early = { ...waiting, proposal: { ...waiting.proposal, at: '2026-09-29T08:30:00.000Z' } };
    expect(roomLastAt(mapWith([message('m-1', 'r-01', '2026-09-29T09:00:00.000Z')]), early)).toBe('2026-09-29T09:00:00.000Z');
  });

  it('в пустой комнате — время создания; не-ISO время ничего не обгоняет', () => {
    expect(roomLastAt(mapWith([]), room)).toBe('2026-09-29T08:00:00.000Z');
    expect(roomLastAt(mapWith([message('m-1', 'r-01', 'garbage'), message('m-2', 'r-01', '2026-09-29T09:00:00.000Z')]), room)).toBe('2026-09-29T09:00:00.000Z');
    expect(roomLastAt(mapWith([message('m-1', 'r-01', 'garbage')]), room)).toBe('2026-09-29T08:00:00.000Z');
  });

  it('комната старой карты без поля proposal читается', () => {
    const old = { id: 'r-01', title: 'R', creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room;
    expect(roomLastAt(mapWith([]), old)).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('roomKey', () => {
  it('ключ работы и id комнаты — как у черновиков комнаты (`{workKey}/{roomId}`, спека 3.4)', () => {
    expect(roomKey('/tmp/p w-01', 'r-02')).toBe('/tmp/p w-01/r-02');
  });
});

describe('roomTabState — правило развёртывания 2.6', () => {
  const group = (id: string, tabs: WorkLayout['closedTabs'], activeTabId: string | null) => ({ type: 'group' as const, id, tabs, activeTabId });
  const single = (tabs: WorkLayout['closedTabs'], activeTabId: string | null): WorkLayout => ({ root: group('g-1', tabs, activeTabId), activeGroupId: 'g-1', closedTabs: [] });
  const roomTab = { kind: 'room' as const, id: 'room:r-01', roomId: 'r-01' };
  const otherRoomTab = { kind: 'room' as const, id: 'room:r-02', roomId: 'r-02' };
  const terminal = (sessionId: string) => ({ kind: 'terminal' as const, id: `terminal:${sessionId}`, sessionId });
  const members = ['s-01', 's-02'];

  it('активная вкладка группы — вкладка этой комнаты: selected', () => {
    expect(roomTabState(single([roomTab], roomTab.id), 'r-01', members)).toBe('selected');
  });

  it('активная вкладка — терминал или дифф участника: open; терминал чужой сессии и вкладка другой комнаты — нет', () => {
    expect(roomTabState(single([terminal('s-02')], 'terminal:s-02'), 'r-01', members)).toBe('open');
    expect(roomTabState(single([{ kind: 'diff', id: 'diff:s-01:all', sessionId: 's-01', commit: null }], 'diff:s-01:all'), 'r-01', members)).toBe('open');
    expect(roomTabState(single([terminal('s-09')], 'terminal:s-09'), 'r-01', members)).toBeNull();
    expect(roomTabState(single([otherRoomTab], otherRoomTab.id), 'r-01', members)).toBeNull();
  });

  it('вкладка открыта, но не активна в группе — не «открыта» для правила: иначе комната всегда была бы развёрнута', () => {
    expect(roomTabState(single([roomTab, terminal('s-09')], 'terminal:s-09'), 'r-01', members)).toBeNull();
    expect(roomTabState(single([terminal('s-01'), terminal('s-09')], 'terminal:s-09'), 'r-01', members)).toBeNull();
  });

  it('две группы рядом: видна вкладка комнаты в неактивной группе — open; selected — только у активной группы', () => {
    const layout: WorkLayout = {
      root: {
        type: 'split',
        id: 'sp-1',
        direction: 'row',
        ratio: 0.5,
        children: [group('g-1', [terminal('s-09')], 'terminal:s-09'), group('g-2', [roomTab], roomTab.id)],
      },
      activeGroupId: 'g-1',
      closedTabs: [],
    };
    expect(roomTabState(layout, 'r-01', members)).toBe('open');
    expect(roomTabState({ ...layout, activeGroupId: 'g-2' }, 'r-01', members)).toBe('selected');
  });

  it('раскладки нет (работа не гидрирована) или группа пуста — null', () => {
    expect(roomTabState(undefined, 'r-01', members)).toBeNull();
    expect(roomTabState(single([], null), 'r-01', members)).toBeNull();
  });
});
