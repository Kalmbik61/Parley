import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { SEND_DELAY_MS, cardText, liveTargets, openCardInDialog, scheduleSend, sendCardNow } from './board-send.js';
import type { SendTarget } from './board-send.js';
import type { BacklogRow, BoardCard, BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const snap = (projectPath: string, version: string, items: Partial<BacklogRow>[] = [{}]): BacklogSnapshot => ({
  projectPath, sharedProjectPath: projectPath, version, file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: items.map((item, i) => ({ id: `b-${String(i + 1).padStart(3, '0')}`, title: 'Fix typo', details: 'More', checked: false, section: null, ...item })),
});
const projectOf = (snapshot: BacklogSnapshot, inbox = false): BoardProject =>
  ({ key: snapshot.projectPath, projectPath: snapshot.projectPath, paths: [snapshot.projectPath], title: 'p', inbox, snapshot, live: true });
const cardOf = (project: BoardProject): BoardCard => ({ project, item: project.snapshot.items[0]!, state: 'backlog', index: 0 });

const session = makeSession('s-01', 'Claude');
const room = { ...makeRoom('r-01', 'Room'), members: ['s-01'] };
const entry = makeWork('w-01', { projectPath: '/p', sessions: [session], rooms: [room] });
const sessionTarget: SendTarget = { entry, kind: 'session', id: 's-01', label: 'S01' };
const roomTarget: SendTarget = { entry, kind: 'room', id: 'r-01', label: 'Room' };

const call = vi.fn();
const bridge = { call, on: vi.fn() };
const methods = (): string[] => call.mock.calls.map(row => row[0] as string);

function seed(...snapshots: BacklogSnapshot[]): void {
  useBoardStore.setState({ slots: new Map(snapshots.map(s => [s.projectPath, { snapshot: s, live: true }])) });
}
function happy(): void {
  call.mockImplementation(async (method: string, params: { projectPath: string }) => {
    if (method === 'rooms.send') return { messageId: 'm' };
    if (method === 'backlog.transfer') return { id: 'b-009', snapshot: snap('/p', 'vt', [{ id: 'b-009' }]) };
    if (method === 'backlog.take' || method === 'backlog.move') return snap(params.projectPath, 'v2');
    return snap(params.projectPath, 'v1');
  });
}
/** Как `happy()`, но `backlog.take` отвечает конфликтом версии. */
function takeConflicts(): void {
  happy();
  const base = call.getMockImplementation()!;
  call.mockImplementation(async (method: string, params: { projectPath: string }) => {
    if (method === 'backlog.take') throw { code: 'conflict', message: 'backlog-conflict' };
    return base(method, params);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  call.mockReset();
  toast.mockClear();
  useBoardStore.setState({ supported: true, slots: new Map(), inboxPath: '/inbox', filter: { kind: 'all' }, sending: new Map() });
  useUiStore.getState().closeNewSessionDialog();
});
afterEach(() => { vi.useRealTimers(); });

describe('board-send', () => {
  it('Undo в течение 5 с — ни одного вызова хоста', async () => {
    const s = snap('/p', 'v1');
    seed(s);
    scheduleSend(bridge, cardOf(projectOf(s)), sessionTarget);
    expect(useBoardStore.getState().sending.get('/p#b-001')).toBe('S01');
    const options = toast.mock.calls[0]![1] as { duration: number; cancel: { label: string; onClick(): void } };
    expect(options.duration).toBe(SEND_DELAY_MS);
    expect(options.cancel.label).toBe(S.board.undo);
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS - 1000);
    options.cancel.onClick();
    options.cancel.onClick();
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS * 2);
    expect(call).not.toHaveBeenCalled();
    expect(useBoardStore.getState().sending.size).toBe(0);
  });

  it('через 5 с: take, затем письмо сессии без комнаты', async () => {
    const s = snap('/p', 'v1');
    seed(s);
    happy();
    scheduleSend(bridge, cardOf(projectOf(s)), sessionTarget);
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS - 1);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(methods()).toEqual(['backlog.take', 'rooms.send']);
    expect(call.mock.calls[0]![1]).toEqual({ projectPath: '/p', id: 'b-001', version: 'v1', target: { projectPath: '/p', workId: 'w-01', sessionId: 's-01' } });
    expect(call.mock.calls[1]![1]).toMatchObject({ projectPath: '/p', workId: 'w-01', roomId: null, to: ['s-01'], kind: 'note' });
    expect(toast).toHaveBeenCalledWith(S.board.sent('S01'));
    expect(useBoardStore.getState().sending.size).toBe(0);
  });

  it('комната — письмо всей комнате', async () => {
    const s = snap('/p', 'v1');
    seed(s);
    happy();
    await sendCardNow(bridge, cardOf(projectOf(s)), roomTarget);
    expect(call.mock.calls[0]![1]).toMatchObject({ target: { projectPath: '/p', workId: 'w-01', roomId: 'r-01' } });
    expect(call.mock.calls[1]![1]).toMatchObject({ roomId: 'r-01', to: [], kind: 'note' });
  });

  it('карточка из Входящих сначала переезжает в проект цели, источник перечитывается', async () => {
    const inbox = snap('/inbox', 'vi');
    seed(inbox, snap('/p', 'v0', []));
    happy();
    await sendCardNow(bridge, cardOf(projectOf(inbox, true)), sessionTarget);
    expect(methods()).toEqual(['backlog.transfer', 'backlog.get', 'backlog.take', 'rooms.send']);
    expect(call.mock.calls[0]![1]).toEqual({ projectPath: '/inbox', id: 'b-001', version: 'vi', toProjectPath: '/p' });
    expect(call.mock.calls[1]![1]).toEqual({ projectPath: '/inbox' });
    expect(call.mock.calls[2]![1]).toMatchObject({ projectPath: '/p', id: 'b-009', version: 'vt' });
    expect(call.mock.calls[3]![1].text).toContain('Board card b-009 (p)');
  });

  it('карточка из Входящих: New session… сначала переносит её в проект работы, затем открывает диалог', async () => {
    const inbox = snap('/inbox', 'vi');
    seed(inbox, snap('/p', 'v0', []));
    happy();
    await openCardInDialog(bridge, cardOf(projectOf(inbox, true)), entry, 'session');
    expect(methods()).toEqual(['backlog.transfer', 'backlog.get']);
    expect(call.mock.calls[0]![1]).toEqual({ projectPath: '/inbox', id: 'b-001', version: 'vi', toProjectPath: '/p' });
    // Номер и версия в диалоге — из ответа переноса: диалог открылся после него и уже на проекте работы.
    const dialog = useUiStore.getState().dialogs.newSession;
    expect(dialog.open).toBe(true);
    expect(dialog.room).toBe(false);
    expect(dialog.work).toEqual({ projectPath: '/p', workId: 'w-01' });
    expect(dialog.backlog).toMatchObject({ projectPath: '/p', id: 'b-009', version: 'vt', itemText: 'Fix typo\n\nMore' });
    expect(dialog.backlog?.task).toContain('Board card b-009 (p)');
  });

  it('письмо не ушло — откат в Backlog и sendFailed', async () => {
    const s = snap('/p', 'v1');
    seed(s);
    happy();
    const base = call.getMockImplementation()!;
    call.mockImplementation(async (method: string, params: { projectPath: string }) => {
      if (method === 'rooms.send') throw new Error('offline');
      return base(method, params);
    });
    await sendCardNow(bridge, cardOf(projectOf(s)), sessionTarget);
    expect(methods()).toEqual(['backlog.take', 'rooms.send', 'backlog.move']);
    expect(call.mock.calls[2]![1]).toEqual({ projectPath: '/p', id: 'b-001', version: 'v2', to: 'backlog' });
    expect(toast).toHaveBeenCalledWith(S.board.sendFailed);
    expect(useBoardStore.getState().sending.size).toBe(0);
  });

  it('карточка уже не в Backlog — changed и ни одного вызова', async () => {
    const s = snap('/p', 'v1');
    const card = cardOf(projectOf(s));
    seed(snap('/p', 'v2', [{ taken: 'w-01/s-01' }]));
    await sendCardNow(bridge, card, sessionTarget);
    expect(call).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(S.board.changed);
  });

  it('конфликт при отправке — S.board.changed и перечитывание', async () => {
    const s = snap('/p', 'v1');
    seed(s);
    takeConflicts();
    await sendCardNow(bridge, cardOf(projectOf(s)), sessionTarget);
    expect(methods()).toEqual(['backlog.take', 'backlog.get']);
    expect(call).toHaveBeenLastCalledWith('backlog.get', { projectPath: '/p' });
    expect(toast).toHaveBeenCalledWith(S.board.changed);
    expect(toast).not.toHaveBeenCalledWith(S.board.sendFailed);
    expect(useBoardStore.getState().sending.size).toBe(0);
  });

  it('конфликт take у карточки из Входящих — перечитываются и источник, и проект цели', async () => {
    const inbox = snap('/inbox', 'vi');
    seed(inbox, snap('/p', 'v0', []));
    takeConflicts();
    await sendCardNow(bridge, cardOf(projectOf(inbox, true)), sessionTarget);
    // Источник перечитан уже после переноса; отказ take добавляет ещё чтение источника и проекта цели.
    expect(methods()).toEqual(['backlog.transfer', 'backlog.get', 'backlog.take', 'backlog.get', 'backlog.get']);
    expect(call.mock.calls.slice(3).map(row => row[1].projectPath).sort()).toEqual(['/inbox', '/p']);
    expect(toast).toHaveBeenCalledWith(S.board.changed);
    expect(useBoardStore.getState().sending.size).toBe(0);
  });

  it('текст письма — boardCardMessage с номером карточки', () => {
    const card = cardOf(projectOf(snap('/work/proj', 'v1')));
    const text = cardText(card, 'b-001');
    expect(text).toContain('Board card b-001 (proj): Fix typo');
    expect(text).toContain('More');
    expect(text).toContain('backlog ["b-001"]');
  });

  it('liveTargets: закрытые сессии, архивные комнаты и неактивные работы не предлагаются', () => {
    const closed = makeSession('s-02', 'Old', { lifecycle: 'closed' });
    const archived = { ...makeRoom('r-02', 'Gone'), members: ['s-01'], archivedAt: '2026-09-27T08:00:00.000Z' };
    const live = makeWork('w-01', { projectPath: '/p', sessions: [session, closed], rooms: [room, archived] });
    const idle = makeWork('w-02', { projectPath: '/p', status: 'archived', sessions: [makeSession('s-01', 'X')] });
    const targets = liveTargets(projectOf(snap('/p', 'v1')), [live, idle]);
    expect(targets.map(t => `${t.kind}:${t.id}`)).toEqual(['room:r-01', 'session:s-01']);
  });
});
