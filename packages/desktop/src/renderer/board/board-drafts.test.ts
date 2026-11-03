import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@parley/protocol';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { roomKey } from '../lib/room-view.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { claimCardDraft, putCardDraft, useDraftInserts } from './board-drafts.js';
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
const cardOf = (project: BoardProject, index = 0): BoardCard => ({ project, item: project.snapshot.items[index]!, state: 'backlog', index });

const session = makeSession('s-01', 'Claude');
const room = { ...makeRoom('r-01', 'Room'), members: ['s-01'] };
const entry = makeWork('w-01', { projectPath: '/p', sessions: [session], rooms: [room] });
const sessionTarget: SendTarget = { entry, kind: 'session', id: 's-01', label: 'S01' };
const roomTarget: SendTarget = { entry, kind: 'room', id: 'r-01', label: 'Room' };
const SESSION_KEY = refKey({ projectPath: '/p', workId: 'w-01', sessionId: 's-01' });
const ROOM_KEY = roomKey(workKey('/p', 'w-01'), 'r-01');
const TAKE_ROOM = { projectPath: '/p', workId: 'w-01', roomId: 'r-01' };

const call = vi.fn();
const bridge = { call, on: vi.fn() };
const methods = (): string[] => call.mock.calls.map((row) => row[0] as string);

function seed(...snapshots: BacklogSnapshot[]): void {
  useBoardStore.setState({ slots: new Map(snapshots.map((s) => [s.projectPath, { snapshot: s, live: true }])) });
}
function happy(): void {
  call.mockImplementation(async (method: string, params: { projectPath: string }) => {
    if (method === 'backlog.transfer') return { id: 'b-009', snapshot: snap('/p', 'vt', [{ id: 'b-009' }]) };
    if (method === 'backlog.take' || method === 'backlog.move') return snap(params.projectPath, 'v2');
    return snap(params.projectPath, 'v1');
  });
}

beforeEach(() => {
  call.mockReset();
  toast.mockClear();
  useBoardStore.setState({ supported: true, slots: new Map(), inboxPath: '/inbox', filter: { kind: 'all' }, sending: new Map() });
  useChatUiStore.setState({ drafts: {} });
  useUiStore.setState({ composerDrafts: {} });
  useDraftInserts.setState({ inserts: {}, mounted: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('board-drafts', () => {
  it('бросок в Chat дописывает черновик через пустую строку', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    useChatUiStore.getState().setDraft(SESSION_KEY, 'earlier');
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), sessionTarget);
    const draft = useChatUiStore.getState().drafts[SESSION_KEY]!;
    expect(draft.startsWith('earlier\n\nBoard card b-001')).toBe(true);
    expect(toast).toHaveBeenCalledWith(S.board.draftAdded('S01'));
    expect(call).not.toHaveBeenCalled();
  });

  it('бросок в смонтированную комнату — запрос вставки, а не запись в стор черновиков', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    const unregister = useDraftInserts.getState().register(ROOM_KEY);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    expect(useDraftInserts.getState().inserts[ROOM_KEY]?.startsWith('Board card b-001')).toBe(true);
    expect(useUiStore.getState().composerDrafts[ROOM_KEY]).toBeUndefined();
    expect(useDraftInserts.getState().take(ROOM_KEY)?.startsWith('Board card b-001')).toBe(true);
    expect(useDraftInserts.getState().take(ROOM_KEY)).toBeNull();
    unregister();
    expect(useDraftInserts.getState().mounted[ROOM_KEY]).toBeUndefined();
  });

  it('комнаты без поля — черновик комнаты в сторе окна', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    expect(useUiStore.getState().composerDrafts[ROOM_KEY]?.startsWith('Board card b-001')).toBe(true);
    expect(useDraftInserts.getState().inserts).toEqual({});
  });

  it('карточка без номера получает его через prepareTake до черновика', async () => {
    const snapshot = snap('/p', 'v1', [{ id: null }]);
    seed(snapshot);
    call.mockResolvedValueOnce({ id: 'b-007', snapshot: snap('/p', 'v2', [{ id: 'b-007' }]) });
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), sessionTarget);
    expect(methods()).toEqual(['backlog.prepareTake']);
    expect(useChatUiStore.getState().drafts[SESSION_KEY]?.startsWith('Board card b-007')).toBe(true);
  });

  it('Входящие — перенос в проект цели до черновика', async () => {
    const inbox = snap('/inbox', 'vi');
    seed(inbox, snap('/p', 'v1', []));
    happy();
    await putCardDraft(bridge, cardOf(projectOf(inbox, true)), sessionTarget);
    expect(methods()[0]).toBe('backlog.transfer');
    expect(call.mock.calls[0]![1]).toMatchObject({ projectPath: '/inbox', toProjectPath: '/p' });
    expect(useChatUiStore.getState().drafts[SESSION_KEY]?.startsWith('Board card b-009')).toBe(true);
  });

  it('отказ подготовки — тост failed и черновик не меняется', async () => {
    const snapshot = snap('/p', 'v1', [{ id: null }]);
    seed(snapshot);
    call.mockRejectedValue(new Error('boom'));
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), sessionTarget);
    expect(toast).toHaveBeenCalledWith(S.board.failed);
    expect(useChatUiStore.getState().drafts[SESSION_KEY]).toBeUndefined();
  });

  it('Send с номером карточки — take на эту цель', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    happy();
    await claimCardDraft(bridge, ROOM_KEY, useUiStore.getState().composerDrafts[ROOM_KEY]!, TAKE_ROOM);
    expect(call).toHaveBeenCalledWith('backlog.take', { projectPath: '/p', id: 'b-001', version: 'v1', target: TAKE_ROOM });
    expect(useBoardStore.getState().slots.get('/p')?.snapshot?.version).toBe('v2');
    // Связь снята: второй Send с тем же номером карточку уже не берёт.
    call.mockClear();
    await claimCardDraft(bridge, ROOM_KEY, 'b-001', TAKE_ROOM);
    expect(call).not.toHaveBeenCalled();
  });

  it('номер стёрт из текста — take нет, связь снята', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    await claimCardDraft(bridge, ROOM_KEY, 'something else, see b-0012', TAKE_ROOM);
    expect(call).not.toHaveBeenCalled();
    await claimCardDraft(bridge, ROOM_KEY, 'b-001', TAKE_ROOM);
    expect(call).not.toHaveBeenCalled();
  });

  it('take отказал — тост failed, связь снята', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), sessionTarget);
    call.mockRejectedValue({ code: 'conflict', message: 'backlog-conflict' });
    await claimCardDraft(bridge, SESSION_KEY, 'b-001', { projectPath: '/p', workId: 'w-01', sessionId: 's-01' });
    expect(toast).toHaveBeenLastCalledWith(S.board.failed);
    call.mockClear();
    await claimCardDraft(bridge, SESSION_KEY, 'b-001', { projectPath: '/p', workId: 'w-01', sessionId: 's-01' });
    expect(call).not.toHaveBeenCalled();
  });

  it('Входящие: take идёт в проект цели, где карточка теперь лежит', async () => {
    const inbox = snap('/inbox', 'vi');
    seed(inbox, snap('/p', 'v1', []));
    happy();
    await putCardDraft(bridge, cardOf(projectOf(inbox, true)), sessionTarget);
    call.mockClear();
    happy();
    await claimCardDraft(bridge, SESSION_KEY, 'Board card b-009', { projectPath: '/p', workId: 'w-01', sessionId: 's-01' });
    expect(call.mock.calls[0]![0]).toBe('backlog.take');
    expect(call.mock.calls[0]![1]).toMatchObject({ projectPath: '/p', id: 'b-009' });
  });

  it('две карточки в черновике — обе в работе', async () => {
    const snapshot = snap('/p', 'v1', [{}, {}]);
    seed(snapshot);
    const project = projectOf(snapshot);
    await putCardDraft(bridge, cardOf(project), roomTarget);
    await putCardDraft(bridge, cardOf(project, 1), roomTarget);
    const draft = useUiStore.getState().composerDrafts[ROOM_KEY]!;
    expect(draft.includes('Board card b-001')).toBe(true);
    expect(draft.includes('Board card b-002')).toBe(true);
    call.mockResolvedValueOnce(snap('/p', 'v2')).mockResolvedValueOnce(snap('/p', 'v3'));
    await claimCardDraft(bridge, ROOM_KEY, draft, TAKE_ROOM);
    // По очереди: второй take несёт версию, которую вернул первый.
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, 'backlog.take', { projectPath: '/p', id: 'b-001', version: 'v1', target: TAKE_ROOM });
    expect(call).toHaveBeenNthCalledWith(2, 'backlog.take', { projectPath: '/p', id: 'b-002', version: 'v2', target: TAKE_ROOM });
    expect(useBoardStore.getState().slots.get('/p')?.snapshot?.version).toBe('v3');
    // Связи сняты: следующий Send с теми же номерами ничего не берёт.
    call.mockClear();
    await claimCardDraft(bridge, ROOM_KEY, draft, TAKE_ROOM);
    expect(call).not.toHaveBeenCalled();
  });

  it('номер одной стёрт — в работе только другая', async () => {
    const snapshot = snap('/p', 'v1', [{}, {}]);
    seed(snapshot);
    const project = projectOf(snapshot);
    await putCardDraft(bridge, cardOf(project), roomTarget);
    await putCardDraft(bridge, cardOf(project, 1), roomTarget);
    happy();
    await claimCardDraft(bridge, ROOM_KEY, 'Board card b-002: Fix typo', TAKE_ROOM);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('backlog.take', { projectPath: '/p', id: 'b-002', version: 'v1', target: TAKE_ROOM });
    // Связь стёртой тоже снята: её номер в следующем тексте карточку уже не берёт.
    call.mockClear();
    await claimCardDraft(bridge, ROOM_KEY, 'b-001 b-002', TAKE_ROOM);
    expect(call).not.toHaveBeenCalled();
  });

  it('та же карточка брошена в поле дважды — в работу уходит один раз', async () => {
    const snapshot = snap('/p', 'v1');
    seed(snapshot);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    await putCardDraft(bridge, cardOf(projectOf(snapshot)), roomTarget);
    happy();
    await claimCardDraft(bridge, ROOM_KEY, useUiStore.getState().composerDrafts[ROOM_KEY]!, TAKE_ROOM);
    expect(methods()).toEqual(['backlog.take']);
  });
});
