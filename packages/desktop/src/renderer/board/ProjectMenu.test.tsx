import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { boardProjects } from './board-model.js';
import type { BoardProject } from './board-model.js';
import type { BoardSlot } from './board-store.js';
import { useBoardStore } from './board-store.js';
import { ProjectMenu } from './ProjectMenu.js';

const snap = (file: Partial<BacklogSnapshot['file']> = {}): BacklogSnapshot => ({
  projectPath: '/p', sharedProjectPath: '/p', version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true, ...file }, rule: 'ask',
  diagnostics: [], suggestions: [], items: [],
});
const call = vi.fn();
const bridge = { call, on: vi.fn() };
const project = (snapshot: BacklogSnapshot): BoardProject => boardProjects(new Map<string, BoardSlot>([['/p', { snapshot, live: true }]]), null)[0]!;
const openMenu = (): void => { fireEvent.keyDown(screen.getByRole('button', { name: S.board.projectMenu }), { key: 'Enter' }); };

beforeEach(() => {
  useBoardStore.setState({ supported: true, slots: new Map([['/p', { snapshot: snap(), live: true }]]), inboxPath: null, filter: { kind: 'all' } });
  call.mockReset();
  call.mockResolvedValue(snap());
});
afterEach(() => cleanup());

describe('ProjectMenu', () => {
  it('смена правила — backlog.preferences.set', async () => {
    render(<ProjectMenu bridge={bridge} project={project(snap())} onOpenFile={vi.fn()} />);
    openMenu();
    fireEvent.click(await screen.findByText(S.backlog.everything));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.preferences.set', { projectPath: '/p', rule: 'everything' });
  });

  it('выбор файла скрыт у старого снимка и виден с choice', async () => {
    const { unmount } = render(<ProjectMenu bridge={bridge} project={project(snap())} onOpenFile={vi.fn()} />);
    openMenu();
    await screen.findByText(S.backlog.openFile);
    expect(screen.queryByText(S.backlog.stateFile)).toBeNull();
    unmount();
    cleanup();
    render(<ProjectMenu bridge={bridge} project={project(snap({ choice: null, todos: 'TODOS.md' }))} onOpenFile={vi.fn()} />);
    openMenu();
    fireEvent.click(await screen.findByText('TODOS.md'));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.file.set', { projectPath: '/p', file: 'todos' });
  });

  it('Open file — onOpenFile с путём проекта; без файла пункт выключен', async () => {
    const onOpenFile = vi.fn();
    const { unmount } = render(<ProjectMenu bridge={bridge} project={project(snap())} onOpenFile={onOpenFile} />);
    openMenu();
    fireEvent.click(await screen.findByText(S.backlog.openFile));
    expect(onOpenFile).toHaveBeenCalledWith('/p');
    unmount();
    cleanup();
    render(<ProjectMenu bridge={bridge} project={project(snap({ exists: false }))} onOpenFile={onOpenFile} />);
    openMenu();
    const item = await screen.findByText(S.backlog.openFile);
    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')).not.toBeNull();
  });
});
