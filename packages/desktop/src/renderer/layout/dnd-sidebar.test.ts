/**
 * Бросок сессии на строки сайдбара (кусок 7 плана «Organic», спека окна 2026-09-29, 2.5): что бросок значит для
 * карты работы — диалог 1.6 (`merge`) или `rooms.addMember` (`join`) — и что нельзя: на себя, в свою комнату, закрытую
 * сессию, на закрытую, на то, чего в карте нет.
 */

import { describe, expect, it } from 'vitest';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import type { WindowWorkEntry } from '@parley/core';
import type { BacklogSnapshot } from '@parley/protocol';
import type { BoardCard, BoardProject } from '../board/board-model.js';
import { workKey } from '../lib/tree-order.js';
import { resolveCardDrop, resolveSidebarDrop } from './dnd-sidebar.js';

const map = () =>
  makeWork('w-01', {
    sessions: [
      makeSession('s-01', 'один'),
      makeSession('s-02', 'два'),
      makeSession('s-03', 'три'),
      makeSession('s-04', 'четыре', { lifecycle: 'closed' }),
      makeSession('s-05', 'пять'),
    ],
    rooms: [
      { ...makeRoom('r-01', 'Возвраты'), members: ['s-02', 's-03'], lead: 's-02', createdAt: '2026-09-29T08:00:00.000Z' },
      { ...makeRoom('r-02', 'Отчёты'), members: ['s-05'], lead: 's-05', createdAt: '2026-09-29T09:00:00.000Z' },
    ],
  }).map;

describe('resolveSidebarDrop — сессия на сессию (диалог 1.6)', () => {
  it('другая живая сессия — merge: брошенная и цель', () => {
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'session-row', sessionId: 's-05' })).toEqual({ kind: 'merge', dragged: 's-01', target: 's-05' });
  });

  it('на себя — нельзя', () => {
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'session-row', sessionId: 's-01' })).toBeNull();
  });

  it('закрытая брошенная или закрытая цель — нельзя', () => {
    expect(resolveSidebarDrop(map(), 's-04', { kind: 'session-row', sessionId: 's-01' })).toBeNull();
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'session-row', sessionId: 's-04' })).toBeNull();
  });

  it('две сессии одной комнаты — нельзя: они и так в ней', () => {
    expect(resolveSidebarDrop(map(), 's-02', { kind: 'session-row', sessionId: 's-03' })).toBeNull();
  });

  it('участник одной комнаты на сессию вне комнат или из другой комнаты — merge: обе уйдут из прежних (правило хоста)', () => {
    expect(resolveSidebarDrop(map(), 's-02', { kind: 'session-row', sessionId: 's-01' })).toEqual({ kind: 'merge', dragged: 's-02', target: 's-01' });
    expect(resolveSidebarDrop(map(), 's-02', { kind: 'session-row', sessionId: 's-05' })).toEqual({ kind: 'merge', dragged: 's-02', target: 's-05' });
  });

  it('сессии или цели нет в карте — нельзя', () => {
    expect(resolveSidebarDrop(map(), 's-99', { kind: 'session-row', sessionId: 's-01' })).toBeNull();
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'session-row', sessionId: 's-99' })).toBeNull();
  });
});

describe('resolveSidebarDrop — сессия на строку комнаты (rooms.addMember)', () => {
  it('комната, где сессии нет, — join', () => {
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'room-row', roomId: 'r-01' })).toEqual({ kind: 'join', sessionId: 's-01', roomId: 'r-01' });
  });

  it('в свою комнату — нельзя; из одной комнаты в другую — join', () => {
    expect(resolveSidebarDrop(map(), 's-02', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
    expect(resolveSidebarDrop(map(), 's-02', { kind: 'room-row', roomId: 'r-02' })).toEqual({ kind: 'join', sessionId: 's-02', roomId: 'r-02' });
  });

  it('закрытая сессия — нельзя; комнаты нет в карте — нельзя', () => {
    expect(resolveSidebarDrop(map(), 's-04', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
    expect(resolveSidebarDrop(map(), 's-01', { kind: 'room-row', roomId: 'r-99' })).toBeNull();
  });

  it('старая карта: сессия числится в двух комнатах, стоит в самой ранней — в неё нельзя, в другую — join', () => {
    const old = makeWork('w-01', {
      sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два'), makeSession('s-03', 'три')],
      rooms: [
        { ...makeRoom('r-02', 'Поздняя'), members: ['s-02', 's-03'], lead: 's-03', createdAt: '2026-09-29T09:00:00.000Z' },
        { ...makeRoom('r-01', 'Ранняя'), members: ['s-01', 's-02'], lead: 's-01', createdAt: '2026-09-29T08:00:00.000Z' },
      ],
    }).map;
    expect(resolveSidebarDrop(old, 's-02', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
    expect(resolveSidebarDrop(old, 's-02', { kind: 'room-row', roomId: 'r-02' })).toEqual({ kind: 'join', sessionId: 's-02', roomId: 'r-02' });
  });

  it('архивная комната — не цель: ни join, ни из других комнат (архив комнат, 5.3)', () => {
    const state = map();
    state.rooms = state.rooms.map((room) => (room.id === 'r-01' ? { ...room, archivedAt: '2026-10-08T12:00:00.000Z' } : room));
    expect(resolveSidebarDrop(state, 's-01', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
    expect(resolveSidebarDrop(state, 's-05', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
    // Открытая соседка остаётся целью.
    expect(resolveSidebarDrop(state, 's-01', { kind: 'room-row', roomId: 'r-02' })).toEqual({ kind: 'join', sessionId: 's-01', roomId: 'r-02' });
  });

  it('карта v2 без lead и proposal читается', () => {
    const legacy = makeWork('w-01', { sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два')] });
    legacy.map.rooms = [{ id: 'r-01', title: 'Старая', creator: 'human', members: ['s-02'], createdAt: '2026-09-27T08:00:00.000Z' } as never];
    expect(resolveSidebarDrop(legacy.map, 's-01', { kind: 'room-row', roomId: 'r-01' })).toEqual({ kind: 'join', sessionId: 's-01', roomId: 'r-01' });
    expect(resolveSidebarDrop(legacy.map, 's-02', { kind: 'room-row', roomId: 'r-01' })).toBeNull();
  });
});

describe('resolveCardDrop — карточка Backlog на цель', () => {
  const cardOf = (paths: readonly string[], inbox = false): BoardCard => {
    const item = { id: 'b-001', title: 'Task', details: '', checked: false, section: null } as BacklogSnapshot['items'][number];
    const snapshot = { projectPath: paths[0], sharedProjectPath: paths[0], version: 'v1', items: [item] } as unknown as BacklogSnapshot;
    const project: BoardProject = { key: paths[0]!, projectPath: paths[0]!, paths, title: 'p', inbox, snapshot, live: true };
    return { project, item, state: 'backlog', index: 0 };
  };
  const entry = (projectPath: string, id: string, patch: Partial<WindowWorkEntry['map']['work']> = {}): WindowWorkEntry => {
    const base = makeWork(id, {
      projectPath,
      sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два', { lifecycle: 'closed' })],
      rooms: [
        { ...makeRoom('r-01', 'Живая'), members: ['s-01'], lead: 's-01', createdAt: '2026-09-29T08:00:00.000Z' },
        { ...makeRoom('r-02', 'Архив'), members: ['s-01'], lead: 's-01', createdAt: '2026-09-29T08:00:00.000Z', archivedAt: '2026-09-30T08:00:00.000Z' },
      ],
    });
    return { ...base, map: { ...base.map, work: { ...base.map.work, ...patch } } };
  };
  const entries = [entry('/p', 'w-01'), entry('/p', 'w-02'), entry('/other', 'w-01')];
  const key = (path: string, id: string): string => workKey(path, id);

  it('строка сессии другой работы того же проекта — цель', () => {
    const target = resolveCardDrop(cardOf(['/p']), { kind: 'session-row', sessionId: 's-01' }, key('/p', 'w-02'), entries);
    expect(target?.kind).toBe('session');
    expect(target?.entry.map.work.id).toBe('w-02');
  });

  it('лента и терминал — те же цели; комната — живая', () => {
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'feed', roomId: 'r-01' }, key('/p', 'w-01'), entries)?.kind).toBe('room');
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'feed', sessionId: 's-01' }, key('/p', 'w-01'), entries)?.kind).toBe('session');
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'terminal', sessionId: 's-01' }, key('/p', 'w-01'), entries)?.id).toBe('s-01');
  });

  it('закрытая сессия, архивная комната, чужой проект, нет в карте — null', () => {
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'session-row', sessionId: 's-02' }, key('/p', 'w-01'), entries)).toBeNull();
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'room-row', roomId: 'r-02' }, key('/p', 'w-01'), entries)).toBeNull();
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'session-row', sessionId: 's-01' }, key('/other', 'w-01'), entries)).toBeNull();
    expect(resolveCardDrop(cardOf(['/p']), { kind: 'room-row', roomId: 'r-99' }, key('/p', 'w-01'), entries)).toBeNull();
  });

  it('Входящие — любая живая цель любого проекта', () => {
    const inbox = cardOf(['/inbox'], true);
    expect(resolveCardDrop(inbox, { kind: 'session-row', sessionId: 's-01' }, key('/other', 'w-01'), entries)?.entry.projectPath).toBe('/other');
    expect(resolveCardDrop(inbox, { kind: 'room-row', roomId: 'r-01' }, key('/p', 'w-02'), entries)?.kind).toBe('room');
  });
});
