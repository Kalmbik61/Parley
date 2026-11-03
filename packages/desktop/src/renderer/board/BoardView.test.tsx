import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { fakeDictationDeps } from '../test-utils/dictation.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useDictationStore } from '../voice/dictation-store.js';
import type { BacklogRow } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardSlot } from './board-store.js';
import { BoardView } from './BoardView.js';

const focus = vi.hoisted(() => ({ applyFocusTarget: vi.fn(() => true), buildFocusTargetDeps: vi.fn(() => ({})) }));
vi.mock('../attention/focus-target.js', () => focus);

const snap = (projectPath: string, items: Partial<BacklogRow>[]): BacklogSnapshot => ({
  projectPath, sharedProjectPath: projectPath, version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: items.map((item, i) => ({ id: `b-${String(i + 1).padStart(3, '0')}`, title: `Item ${i + 1}`, details: '', checked: false, section: null, ...item })),
});
const slot = (snapshot: BacklogSnapshot, live = true): BoardSlot => ({ snapshot, live });
const call = vi.fn();
const bridge = { call, on: vi.fn() } as unknown as ParleyBridge;
const column = (name: string): HTMLElement => screen.getByRole('region', { name });
const today = (): string => new Date().toISOString().slice(0, 10);

function fill(slots: [string, BoardSlot][], inboxPath: string | null = null): void {
  useBoardStore.setState({ supported: true, slots: new Map(slots), inboxPath, filter: { kind: 'all' } });
}

/** Голос окна включён, диктовка подставная; снимается в `afterEach`, чтобы запись не пережила тест. */
let disposeDictation: (() => void) | null = null;
function startDictation(): void {
  useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
  disposeDictation = useDictationStore.getState().configure(fakeDictationDeps('spoken task'));
}
const taskField = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.board.taskField }) as HTMLTextAreaElement;

beforeEach(() => {
  useBoardStore.setState({ supported: true, slots: new Map(), inboxPath: null, filter: { kind: 'all' } });
  useWorksStore.setState({ entries: [] });
  useActivityStore.setState({ byRef: {} });
  focus.applyFocusTarget.mockClear();
  call.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  disposeDictation?.();
  disposeDictation = null;
});

describe('BoardView', () => {
  it('четыре колонки с числами', () => {
    fill([['/p', slot(snap('/p', [{}, {}, { taken: 'w-01/s-01' }, { taken: 'w-01/s-01', review: '2026-11-01T00:00:00Z' }, { checked: true, done: today() }]))]]);
    render(<BoardView bridge={bridge} />);
    const count = (name: string): string | null => column(name).querySelector('[data-board-count]')!.textContent;
    expect(count(S.board.columns.backlog)).toBe('2');
    expect(count(S.board.columns.inProgress)).toBe('1');
    expect(count(S.board.columns.review)).toBe('1');
    expect(count(S.board.columns.done)).toBe('1');
  });

  it('фильтр по проекту и No project', () => {
    fill([['/a', slot(snap('/a', [{ title: 'From A' }]))], ['/b', slot(snap('/b', [{ title: 'From B' }]))], ['/inbox', slot(snap('/inbox', [{ title: 'Loose' }]))]], '/inbox');
    render(<BoardView bridge={bridge} />);
    const select = screen.getByLabelText(S.board.filter) as HTMLSelectElement;
    expect(screen.getByText('From A')).toBeTruthy();
    expect(screen.getByText('Loose')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'p:/a' } });
    expect(screen.getByText('From A')).toBeTruthy();
    expect(screen.queryByText('From B')).toBeNull();
    fireEvent.change(select, { target: { value: 'inbox' } });
    expect(screen.getByText('Loose')).toBeTruthy();
    expect(screen.queryByText('From A')).toBeNull();
  });

  it('Show older раскрывает старые Done', () => {
    fill([['/p', slot(snap('/p', [{ title: 'Fresh', checked: true, done: today() }, { title: 'Ancient', checked: true, done: '2020-01-01' }]))]]);
    render(<BoardView bridge={bridge} />);
    expect(screen.queryByText('Ancient')).toBeNull();
    fireEvent.click(screen.getByText(S.board.showOlder(1)));
    expect(screen.getByText('Ancient')).toBeTruthy();
    fireEvent.click(screen.getByText(S.board.hideOlder));
    expect(screen.queryByText('Ancient')).toBeNull();
  });

  it('In progress показывает цель и состояние, закрытая цель помечена', () => {
    const open = makeSession('s-01', 'backend');
    const closed = makeSession('s-02', 'old', { lifecycle: 'closed' });
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [open, closed] })] });
    fill([['/p', slot(snap('/p', [{ title: 'Live', taken: 'w-01/s-01' }, { title: 'Dead', taken: 'w-01/s-02' }]))]]);
    render(<BoardView bridge={bridge} />);
    const cards = within(column(S.board.columns.inProgress));
    expect(cards.getByText(/^S01/)).toBeTruthy();
    expect(cards.getAllByText(S.board.targetGone).length).toBe(1);
  });

  it('клик по цели открывает комнату', () => {
    const lead = makeSession('s-01', 'lead');
    const room = { ...makeRoom('r-01', 'Planning'), members: ['s-01'], lead: 's-01' };
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [lead], rooms: [room] })] });
    fill([['/p', slot(snap('/p', [{ taken: 'w-01/r-01' }]))]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText('Planning'));
    expect(focus.applyFocusTarget).toHaveBeenCalledWith({ kind: 'room', projectPath: '/p', workId: 'w-01', roomId: 'r-01' }, expect.anything());
  });

  it('пустая доска приглашает записать задачу', () => {
    fill([['/p', slot(snap('/p', []))]]);
    render(<BoardView bridge={bridge} />);
    expect(screen.getByText(S.board.empty)).toBeTruthy();
    expect(screen.getByText(S.board.emptyHint)).toBeTruthy();
  });

  it('старый хост — только unavailable', () => {
    useBoardStore.setState({ supported: false });
    render(<BoardView bridge={bridge} />);
    expect(screen.getByText(S.board.unavailable)).toBeTruthy();
    expect(screen.queryByLabelText(S.board.filter)).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('проект без live — Refresh и подсказка', () => {
    fill([['/p', slot(snap('/p', [{}]), false)]]);
    render(<BoardView bridge={bridge} />);
    expect(screen.getByText(S.board.liveUnavailable)).toBeTruthy();
    expect(screen.getByText(S.board.refresh)).toBeTruthy();
  });

  it('открытая карточка показывает историю', () => {
    const lead = makeSession('s-01', 'backend');
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [lead] })] });
    const stamp = new Date(Date.now() - 3 * 3600_000).toISOString();
    fill([['/p', slot(snap('/p', [{ title: 'Open me', details: 'Long details', by: 'S09', taken: 'w-01/s-01', created: stamp, sent: stamp, review: stamp }]))]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText('Open me'));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Long details')).toBeTruthy();
    expect(dialog.getByText(S.board.history)).toBeTruthy();
    expect(dialog.getByText(/^Created /)).toBeTruthy();
    expect(dialog.getByText(/^Sent to S01/)).toBeTruthy();
    expect(dialog.getByText(/^Reported done /)).toBeTruthy();
    expect(dialog.getByText(new RegExp(S.board.byAgent('S09')))).toBeTruthy();
  });

  it('taken указывает на несуществующую сессию — карточка помечена targetGone', () => {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [makeSession('s-01', 'backend')] })] });
    fill([['/p', slot(snap('/p', [{ title: 'Lost', taken: 'w-01/s-09' }]))]]);
    render(<BoardView bridge={bridge} />);
    expect(within(column(S.board.columns.inProgress)).getByText(S.board.targetGone)).toBeTruthy();
  });

  it('потерянная цель — в истории открытой карточки номер вместо подписи', () => {
    const stamp = new Date(Date.now() - 3 * 3600_000).toISOString();
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p' })] });
    fill([['/p', slot(snap('/p', [{ title: 'Lost', taken: 'w-01/s-09', sent: stamp }]))]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText('Lost'));
    expect(within(screen.getByRole('dialog')).getByText(/^Sent to w-01\/s-09/)).toBeTruthy();
  });

  it('фильтр по проекту без снимка — в списке его пункт', () => {
    fill([['/a', slot(snap('/a', [{ title: 'From A' }]))]]);
    useBoardStore.setState({ filter: { kind: 'project', path: '/gone/old-project' } });
    render(<BoardView bridge={bridge} />);
    const select = screen.getByLabelText(S.board.filter) as HTMLSelectElement;
    expect(select.value).toBe('p:/gone/old-project');
    expect(within(select).getByText('old-project')).toBeTruthy();
    expect(screen.queryByText('From A')).toBeNull();
  });

  it('карточка Review показывает, когда сообщили о готовности', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [makeSession('s-01', 'backend')] })] });
    fill([['/p', slot(snap('/p', [{ taken: 'w-01/s-01', review: '2026-11-03T09:00:00.000Z' }]))]]);
    render(<BoardView bridge={bridge} />);
    expect(within(column(S.board.columns.review)).getByText(S.board.reported('3h ago'))).toBeTruthy();
  });

  it('карточка Done показывает дату', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
    fill([['/p', slot(snap('/p', [{ checked: true, done: '2026-11-02' }]))]]);
    render(<BoardView bridge={bridge} />);
    expect(within(column(S.board.columns.done)).getByText(S.board.doneOn('2026-11-02'))).toBeTruthy();
  });

  it('Refresh подписывает проект без live заново', () => {
    fill([['/p', slot(snap('/p', [{}]), false)]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText(S.board.refresh));
    expect(call).toHaveBeenCalledWith('backlog.subscribe', { projectPath: '/p' });
  });

  it('New task при форме, открытой через Dictate, не стирает введённое и не трогает запись', async () => {
    startDictation();
    fill([['/p', slot(snap('/p', []))]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText(S.board.dictate));
    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'));
    fireEvent.change(taskField(), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByText(S.board.newTask));
    expect(taskField().value).toBe('Keep me');
    expect(useDictationStore.getState().phase).toBe('recording');
  });

  it('Dictate при форме, открытой через New task, включает диктовку в ней же и не стирает введённое', async () => {
    startDictation();
    fill([['/p', slot(snap('/p', []))]]);
    render(<BoardView bridge={bridge} />);
    fireEvent.click(screen.getByText(S.board.newTask));
    fireEvent.change(taskField(), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByText(S.board.dictate));
    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'));
    expect(useDictationStore.getState().targetId).toBe('board:new-task');
    expect(taskField().value).toBe('Keep me');
  });
});
