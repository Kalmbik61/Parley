import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { SendToMenu } from './SendToMenu.js';
import type { BacklogRow, BoardCard, BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const bridge = { call: vi.fn(), on: vi.fn() };
const cardIn = (projectPath: string, inbox = false, patch: Partial<BacklogRow> = {}): BoardCard => {
  const item: BacklogRow = { id: 'b-001', title: 'Fix typo', details: 'More', checked: false, section: null, ...patch };
  const snapshot = { projectPath, sharedProjectPath: projectPath, version: 'v1', items: [item] } as unknown as BacklogSnapshot;
  const project: BoardProject = { key: projectPath, projectPath, paths: [projectPath], title: 'p', inbox, snapshot, live: true };
  return { project, item, state: 'backlog', index: 0 };
};
const open = (): void => { fireEvent.keyDown(screen.getByText(S.board.sendTo), { key: 'Enter' }); };
const targets = (): string[] => [...document.querySelectorAll('[data-send-target]')].map(el => el.getAttribute('data-send-target') ?? '');

beforeEach(() => {
  useBoardStore.setState({ sending: new Map() });
  useUiStore.getState().closeNewSessionDialog();
});
afterEach(cleanup);

describe('SendToMenu', () => {
  it('закрытые сессии и архивные комнаты не предлагаются', () => {
    const archived = { ...makeRoom('r-02', 'Gone'), members: ['s-01'], archivedAt: '2026-09-27T08:00:00.000Z' };
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/p', sessions: [makeSession('s-01', 'Claude'), makeSession('s-02', 'Old', { lifecycle: 'closed' })], rooms: [{ ...makeRoom('r-01', 'Room'), members: ['s-01'] }, archived] })] });
    render(<SendToMenu bridge={bridge} card={cardIn('/p')} />);
    open();
    expect(targets()).toEqual(['w-01/r-01', 'w-01/s-01']);
  });

  it('без целей — noTargets', () => {
    useWorksStore.setState({ entries: [] });
    render(<SendToMenu bridge={bridge} card={cardIn('/p')} />);
    open();
    expect(screen.getByText(S.board.noTargets)).toBeTruthy();
    expect(screen.getByText(S.board.newSession).closest('[role="menuitem"]')!.getAttribute('data-disabled')).not.toBeNull();
  });

  it('Входящие — цели по проектам', () => {
    useWorksStore.setState({ entries: [
      makeWork('w-01', { projectPath: '/x/alpha', sessions: [makeSession('s-01', 'A')] }),
      makeWork('w-01', { projectPath: '/x/beta', sessions: [makeSession('s-01', 'B')] }),
    ] });
    render(<SendToMenu bridge={bridge} card={cardIn('/inbox', true)} />);
    open();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(targets()).toEqual(['w-01/s-01', 'w-01/s-01']);
  });

  it('New room открывает диалог с письмом и itemText', async () => {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/work/proj', sessions: [makeSession('s-01', 'Claude')] })] });
    const card = cardIn('/work/proj');
    useBoardStore.setState({ slots: new Map([['/work/proj', { snapshot: card.project.snapshot, live: true }]]) });
    render(<SendToMenu bridge={bridge} card={card} />);
    open();
    await act(async () => { fireEvent.click(screen.getByText(S.board.newRoom)); });
    const dialog = useUiStore.getState().dialogs.newSession;
    expect(dialog.open).toBe(true);
    expect(dialog.room).toBe(true);
    expect(dialog.work).toEqual({ projectPath: '/work/proj', workId: 'w-01' });
    expect(dialog.backlog).toMatchObject({ projectPath: '/work/proj', id: 'b-001', version: 'v1', itemText: 'Fix typo\n\nMore' });
    expect(dialog.backlog?.task).toContain('Board card b-001 (proj): Fix typo');
  });

  it('worktree-работа раньше в entries — диалог открывается на основном пути', async () => {
    // Основная копия и worktree делят бэклог; `paths` отсортирован по алфавиту, и worktree стоит в нём раньше основного пути.
    useWorksStore.setState({ entries: [
      makeWork('w-02', { projectPath: '/a/wt', sessions: [makeSession('s-01', 'W')] }),
      makeWork('w-01', { projectPath: '/z/proj', sessions: [makeSession('s-01', 'Claude')] }),
    ] });
    const base = cardIn('/z/proj');
    const card: BoardCard = { ...base, project: { ...base.project, paths: ['/a/wt', '/z/proj'] } };
    useBoardStore.setState({ slots: new Map([['/z/proj', { snapshot: card.project.snapshot, live: true }]]) });
    render(<SendToMenu bridge={bridge} card={card} />);
    open();
    await act(async () => { fireEvent.click(screen.getByText(S.board.newSession)); });
    const dialog = useUiStore.getState().dialogs.newSession;
    expect(dialog.open).toBe(true);
    expect(dialog.work).toEqual({ projectPath: '/z/proj', workId: 'w-01' });
    expect(dialog.backlog).toMatchObject({ projectPath: '/z/proj', id: 'b-001', version: 'v1' });
  });
});
