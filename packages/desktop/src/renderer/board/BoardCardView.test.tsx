import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { BoardCardView } from './BoardCardView.js';
import type { BoardCard, BoardProject, BacklogRow } from './board-model.js';
import type { BacklogState } from '@parley/protocol';
import type { TargetInfo } from './target-info.js';

const actions = vi.hoisted(() => ({ moveCard: vi.fn(async () => undefined), returnCard: vi.fn(async () => undefined) }));
vi.mock('./board-actions.js', () => actions);
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('../attention/focus-target.js', () => ({ applyFocusTarget: vi.fn(), buildFocusTargetDeps: vi.fn(() => ({})) }));

const bridge = { call: vi.fn(), on: vi.fn() };
const make = (state: BacklogState, patch: Partial<BacklogRow> = {}): BoardCard => {
  const item: BacklogRow = { id: 'b-001', title: 'Task', details: '', checked: state === 'done', section: null, ...patch };
  const snapshot = { projectPath: '/p', sharedProjectPath: '/p', version: 'v1', items: [item] } as unknown as BacklogSnapshot;
  const project: BoardProject = { key: '/p', projectPath: '/p', paths: ['/p'], title: 'p', inbox: false, snapshot, live: true };
  return { project, item, state, index: 0 };
};
const live: TargetInfo = { label: 'S01', word: '', gone: false, focus: { kind: 'room', projectPath: '/p', workId: 'w-01', roomId: 'r-01' } };
const gone: TargetInfo = { ...live, gone: true };
const names = (): string[] => [...document.querySelectorAll('[data-card-action]')].map(el => el.getAttribute('data-card-action') ?? '');
const openMenu = (): void => { fireEvent.keyDown(screen.getByLabelText(S.board.cardMenu), { key: 'Enter' }); };

beforeEach(() => {
  useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [makeSession('s-01', 'Claude')] })] });
  actions.moveCard.mockClear();
  actions.returnCard.mockClear();
});
afterEach(cleanup);

describe('BoardCardView', () => {
  it('кнопки по колонкам', () => {
    render(<ul><BoardCardView bridge={bridge} card={make('review', { taken: 'w-01/s-01' })} target={live} onOpen={vi.fn()} /></ul>);
    expect(names()).toEqual(['accept', 'return']);
    cleanup();
    render(<ul><BoardCardView bridge={bridge} card={make('backlog')} target={null} onOpen={vi.fn()} /></ul>);
    expect(names()).toEqual([]);
    openMenu();
    expect(names()).toEqual(['done']);
  });

  it('Accept переводит в done, Return открывает поле и шлёт замечание', () => {
    render(<ul><BoardCardView bridge={bridge} card={make('review', { taken: 'w-01/s-01' })} target={live} onOpen={vi.fn()} /></ul>);
    fireEvent.click(screen.getByText(S.board.accept));
    expect(actions.moveCard).toHaveBeenCalledWith(bridge, expect.anything(), 'done');
    fireEvent.click(screen.getByText(S.board.return));
    fireEvent.change(screen.getByLabelText(S.board.returnNote), { target: { value: 'fix' } });
    fireEvent.click(screen.getByText(S.board.returnSend));
    expect(actions.returnCard).toHaveBeenCalledWith(bridge, expect.anything(), expect.objectContaining({ kind: 'session' }), 'fix');
  });

  it('закрытая цель — Back to backlog на виду, Return выключен', () => {
    render(<ul><BoardCardView bridge={bridge} card={make('in-progress', { taken: 'w-01/s-01' })} target={gone} onOpen={vi.fn()} /></ul>);
    expect(names()).toEqual(['back-visible']);
    fireEvent.click(screen.getByText(S.board.backToBacklog));
    expect(actions.moveCard).toHaveBeenCalledWith(bridge, expect.anything(), 'backlog');
    cleanup();
    render(<ul><BoardCardView bridge={bridge} card={make('review', { taken: 'w-01/s-01' })} target={gone} onOpen={vi.fn()} /></ul>);
    const button = screen.getByText(S.board.return).closest('button')!;
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe(S.board.targetGone);
  });

  it('цель пропала посреди Return… — поле уходит, Accept и Return… возвращаются', () => {
    const works = useWorksStore.getState().entries;
    render(<ul><BoardCardView bridge={bridge} card={make('review', { taken: 'w-01/s-01' })} target={live} onOpen={vi.fn()} /></ul>);
    fireEvent.click(screen.getByText(S.board.return));
    fireEvent.change(screen.getByLabelText(S.board.returnNote), { target: { value: 'half-typed' } });
    act(() => { useWorksStore.setState({ entries: [] }); });
    expect(screen.queryByLabelText(S.board.returnNote)).toBeNull();
    expect(names()).toEqual(['accept', 'return']);
    expect(screen.getByText(S.board.return).closest('button')!.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByText(S.board.accept));
    expect(actions.moveCard).toHaveBeenCalledWith(bridge, expect.anything(), 'done');
    // Цель вернулась: Return… открывает пустое поле, замечание прежней попытки не осталось.
    act(() => { useWorksStore.setState({ entries: works }); });
    fireEvent.click(screen.getByText(S.board.return));
    expect((screen.getByLabelText(S.board.returnNote) as HTMLTextAreaElement).value).toBe('');
  });
});
