/**
 * Тест 3 куска 3.6 плана окна: `▤` в ленте комнаты снимается только после
 * того, как письмо прочли все адресаты, а не после первого прочтения. Заодно
 * проверяет фильтр по `roomId` и заголовок/участников (спека 6.3).
 */

import { describe, expect, it } from 'vitest';
import type { Message, Room, WorkEntry, WorkSession } from '@harnas/core';
import { roomView } from './room-view.js';

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
