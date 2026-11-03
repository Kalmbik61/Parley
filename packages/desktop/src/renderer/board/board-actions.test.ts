import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { deleteCard, editCard, ensureId, moveCard, moveCardToProject, returnCard } from './board-actions.js';
import type { BoardCard, BoardProject, BacklogRow, TakenTarget } from './board-model.js';
import { useBoardStore } from './board-store.js';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const snap = (version: string, items: Partial<BacklogRow>[] = []): BacklogSnapshot => ({
  projectPath: '/p', sharedProjectPath: '/p', version, file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: items.map((item, i) => ({ id: `b-${String(i + 1).padStart(3, '0')}`, title: `Item ${i + 1}`, details: '', checked: false, section: null, ...item })),
});
const cardOf = (snapshot: BacklogSnapshot, index = 0): BoardCard => {
  const project: BoardProject = { key: '/p', projectPath: '/p', paths: ['/p'], title: 'p', inbox: false, snapshot, live: true };
  return { project, item: snapshot.items[index]!, state: 'review', index };
};
const call = vi.fn();
const bridge = { call, on: vi.fn() };

const session = makeSession('s-01', 'Claude');
const entry = makeWork('w-01', { projectPath: '/p', sessions: [session], rooms: [makeRoom('r-01', 'Room')] });
const sessionTarget: TakenTarget = { kind: 'session', entry, session };
const roomTarget: TakenTarget = { kind: 'room', entry, room: entry.map.rooms[0]! };

function seed(snapshot: BacklogSnapshot): void {
  useBoardStore.setState({ slots: new Map([['/p', { snapshot, live: true }]]) });
}

beforeEach(() => {
  call.mockReset();
  toast.mockClear();
  useBoardStore.setState({ supported: true, slots: new Map(), inboxPath: null, filter: { kind: 'all' } });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('board-actions', () => {
  it('Accept переводит в done', async () => {
    const s = snap('v1', [{ taken: 'w-01/s-01' }]);
    seed(s);
    call.mockResolvedValue(snap('v2', [{ taken: 'w-01/s-01', checked: true }]));
    await moveCard(bridge, cardOf(s), 'done');
    expect(call).toHaveBeenCalledWith('backlog.move', { projectPath: '/p', id: 'b-001', version: 'v1', to: 'done' });
    expect(useBoardStore.getState().slots.get('/p')!.snapshot!.version).toBe('v2');
  });

  it('Return шлёт письмо сессии без комнаты, затем move in-progress', async () => {
    const s = snap('v1', [{ taken: 'w-01/s-01' }]);
    seed(s);
    call.mockImplementation(async (method: string) => (method === 'rooms.send' ? { messageId: 'm' } : snap('v2', [{ taken: 'w-01/s-01' }])));
    await returnCard(bridge, cardOf(s), sessionTarget, 'fix it');
    expect(call.mock.calls[0]![0]).toBe('rooms.send');
    expect(call.mock.calls[0]![1]).toMatchObject({ projectPath: '/p', workId: 'w-01', roomId: null, to: ['s-01'], kind: 'note' });
    expect(call.mock.calls[0]![1].text).toContain('fix it');
    expect(call.mock.calls[1]).toEqual(['backlog.move', { projectPath: '/p', id: 'b-001', version: 'v1', to: 'in-progress' }]);
  });

  it('Return в комнату — письмо всей комнате', async () => {
    const s = snap('v1', [{ taken: 'w-01/r-01' }]);
    seed(s);
    call.mockImplementation(async (method: string) => (method === 'rooms.send' ? { messageId: 'm' } : s));
    await returnCard(bridge, cardOf(s), roomTarget, 'again');
    expect(call.mock.calls[0]![1]).toMatchObject({ roomId: 'r-01', to: [] });
  });

  it('письмо не ушло — карточка остаётся в Review', async () => {
    const s = snap('v1', [{ taken: 'w-01/s-01' }]);
    seed(s);
    call.mockRejectedValue(new Error('offline'));
    await returnCard(bridge, cardOf(s), sessionTarget, 'fix');
    expect(call.mock.calls.map(row => row[0])).toEqual(['rooms.send']);
    expect(toast).toHaveBeenCalledWith(S.board.failed);
  });

  it('карточка без номера сначала получает номер через prepareTake', async () => {
    const s = snap('v1', [{ id: null }]);
    seed(s);
    call.mockImplementation(async (method: string) => (method === 'backlog.prepareTake' ? { id: 'b-009', snapshot: snap('v2', [{ id: 'b-009' }]) } : snap('v3', [])));
    expect(await ensureId(bridge, cardOf(s))).toEqual({ id: 'b-009', version: 'v2' });
    await moveCard(bridge, cardOf(s), 'done');
    expect(call).toHaveBeenCalledWith('backlog.prepareTake', { projectPath: '/p', index: 0, version: 'v1' });
    expect(call).toHaveBeenLastCalledWith('backlog.move', { projectPath: '/p', id: 'b-009', version: 'v2', to: 'done' });
  });

  it('конфликт версии — тост changed и refresh', async () => {
    const s = snap('v1', [{}]);
    seed(s);
    const refresh = vi.spyOn(useBoardStore.getState(), 'refresh').mockResolvedValue();
    useBoardStore.setState({ refresh });
    call.mockRejectedValue({ code: 'conflict', message: 'backlog-conflict' });
    await moveCard(bridge, cardOf(s), 'done');
    expect(toast).toHaveBeenCalledWith(S.board.changed);
    expect(refresh).toHaveBeenCalledWith(bridge, '/p');
  });

  it('правка, удаление и перенос зовут нужные методы', async () => {
    const s = snap('v1', [{ id: null }, {}]);
    seed(s);
    // Каждый ответ приносит новую версию, и следующий вызов уходит уже с ней: v1 → v2 → v3.
    call.mockResolvedValue(snap('v2', []));
    await deleteCard(bridge, cardOf(s, 0));
    expect(call).toHaveBeenLastCalledWith('backlog.remove', { projectPath: '/p', index: 0, version: 'v1' });
    call.mockResolvedValue(snap('v3', []));
    await editCard(bridge, cardOf(s, 1), { title: 'New' });
    expect(call).toHaveBeenLastCalledWith('backlog.update', { projectPath: '/p', id: 'b-002', version: 'v2', patch: { title: 'New' } });
    call.mockResolvedValue({ id: 'b-002', snapshot: snap('v4', []) });
    await moveCardToProject(bridge, cardOf(s, 1), '/q');
    expect(call).toHaveBeenLastCalledWith('backlog.transfer', { projectPath: '/p', id: 'b-002', version: 'v3', toProjectPath: '/q' });
  });

  it('отказ переноса карточки из плана приходит конфликтом — cantMove, а не changed; проект перечитывается', async () => {
    const s = snap('v1', [{}]);
    seed(s);
    call.mockRejectedValue({ code: 'conflict', message: 'backlog-conflict' });
    await moveCardToProject(bridge, cardOf(s), '/q');
    expect(toast).toHaveBeenCalledWith(S.board.cantMove);
    expect(toast).not.toHaveBeenCalledWith(S.board.changed);
    expect(call).toHaveBeenCalledWith('backlog.get', { projectPath: '/p' });
  });

  it('прочая ошибка переноса — cantMove', async () => {
    const s = snap('v1', [{}]);
    seed(s);
    call.mockRejectedValue(new Error('offline'));
    await moveCardToProject(bridge, cardOf(s), '/q');
    expect(toast).toHaveBeenCalledWith(S.board.cantMove);
    expect(toast).not.toHaveBeenCalledWith(S.board.failed);
  });
});
