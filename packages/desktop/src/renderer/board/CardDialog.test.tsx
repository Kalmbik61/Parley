import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { CardDialog } from './CardDialog.js';
import type { BoardCard, BoardProject, BacklogRow } from './board-model.js';
import { useBoardStore } from './board-store.js';

const actions = vi.hoisted(() => ({ editCard: vi.fn(async () => undefined), deleteCard: vi.fn(async () => undefined), moveCardToProject: vi.fn(async () => undefined) }));
vi.mock('./board-actions.js', () => actions);
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const bridge = { call: vi.fn(), on: vi.fn() };
const snap = (path: string, items: Partial<BacklogRow>[]): BacklogSnapshot => ({
  projectPath: path, sharedProjectPath: path, version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: items.map((item, i) => ({ id: `b-00${i + 1}`, title: `Item ${i + 1}`, details: 'Old details', checked: false, section: null, ...item })),
});
function card(index = 0): BoardCard {
  const snapshot = snap('/p', [{}, {}]);
  const project: BoardProject = { key: '/p', projectPath: '/p', paths: ['/p'], title: 'p', inbox: false, snapshot, live: true };
  return { project, item: snapshot.items[index]!, state: 'backlog', index };
}
const titleField = (): Element | null => document.querySelector('[data-card-field="title"]');

beforeEach(() => {
  Object.values(actions).forEach(fn => fn.mockClear());
  toast.mockClear();
  bridge.call.mockReset();
  useBoardStore.setState({ supported: true, inboxPath: '/inbox', filter: { kind: 'all' },
    slots: new Map([['/p', { snapshot: snap('/p', [{}]), live: true }], ['/q', { snapshot: snap('/q', []), live: true }], ['/inbox', { snapshot: snap('/inbox', []), live: true }]]) });
});
afterEach(cleanup);

describe('CardDialog', () => {
  it('Edit сохраняет заголовок и детали', () => {
    render(<CardDialog bridge={bridge} card={card()} target={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(S.board.edit));
    fireEvent.change(document.querySelector('[data-card-field="title"]')!, { target: { value: 'New title' } });
    fireEvent.click(screen.getByText(S.board.save));
    expect(actions.editCard).toHaveBeenCalledWith(bridge, expect.anything(), { title: 'New title' });
  });

  it('Delete спрашивает подтверждение и удаляет', () => {
    const onClose = vi.fn();
    render(<CardDialog bridge={bridge} card={card()} target={null} onClose={onClose} />);
    fireEvent.click(screen.getByText(S.board.delete));
    expect(screen.getByText(S.board.deleteConfirm)).toBeTruthy();
    expect(actions.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-card-action="delete-confirm"]')!);
    expect(actions.deleteCard).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Move to project: другие проекты и No project, без своего', () => {
    render(<CardDialog bridge={bridge} card={card()} target={null} onClose={vi.fn()} />);
    const select = document.querySelector('[data-card-field="project"]') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['', '/q', '/inbox']);
    fireEvent.change(select, { target: { value: '/q' } });
    expect(actions.moveCardToProject).toHaveBeenCalledWith(bridge, expect.anything(), '/q');
  });

  it('перенос только из Backlog', () => {
    render(<CardDialog bridge={bridge} card={{ ...card(), state: 'review' }} target={null} onClose={vi.fn()} />);
    expect(document.querySelector('[data-card-field="project"]')).toBeNull();
  });

  it('Edit → Delete → открыть другую карточку — формы правки нет', () => {
    const onClose = vi.fn();
    const view = render(<CardDialog bridge={bridge} card={card(0)} target={null} onClose={onClose} />);
    fireEvent.click(screen.getByText(S.board.edit));
    expect(titleField()).toBeTruthy();
    fireEvent.click(screen.getByText(S.board.delete));
    fireEvent.click(document.querySelector('[data-card-action="delete-confirm"]')!);
    expect(onClose).toHaveBeenCalled();
    // Владелец закрыл диалог и открыл другую карточку.
    view.rerender(<CardDialog bridge={bridge} card={null} target={null} onClose={onClose} />);
    view.rerender(<CardDialog bridge={bridge} card={card(1)} target={null} onClose={onClose} />);
    expect(screen.getByText('Item 2')).toBeTruthy();
    expect(titleField()).toBeNull();
    expect(document.querySelector('[data-card-action="edit"]')!.hasAttribute('disabled')).toBe(false);
  });

  it('Edit → Move to project → открыть другую карточку — формы правки нет', () => {
    const onClose = vi.fn();
    const view = render(<CardDialog bridge={bridge} card={card(0)} target={null} onClose={onClose} />);
    fireEvent.click(screen.getByText(S.board.edit));
    expect(titleField()).toBeTruthy();
    fireEvent.change(document.querySelector('[data-card-field="project"]')!, { target: { value: '/q' } });
    expect(onClose).toHaveBeenCalled();
    view.rerender(<CardDialog bridge={bridge} card={null} target={null} onClose={onClose} />);
    view.rerender(<CardDialog bridge={bridge} card={card(1)} target={null} onClose={onClose} />);
    expect(titleField()).toBeNull();
  });

  it('другая карточка без закрытия не наследует правку', () => {
    const view = render(<CardDialog bridge={bridge} card={card(0)} target={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(S.board.edit));
    expect(titleField()).toBeTruthy();
    view.rerender(<CardDialog bridge={bridge} card={card(1)} target={null} onClose={vi.fn()} />);
    expect(titleField()).toBeNull();
  });

  it('перенос отклонён — cantMove', async () => {
    // Настоящее действие вместо подставного: тост ставит оно, диалог только зовёт его.
    const real = await vi.importActual<typeof import('./board-actions.js')>('./board-actions.js');
    actions.moveCardToProject.mockImplementationOnce(real.moveCardToProject);
    bridge.call.mockRejectedValue({ code: 'conflict', message: 'backlog-conflict' });
    render(<CardDialog bridge={bridge} card={card()} target={null} onClose={vi.fn()} />);
    fireEvent.change(document.querySelector('[data-card-field="project"]')!, { target: { value: '/q' } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(S.board.cantMove));
    expect(toast).not.toHaveBeenCalledWith(S.board.changed);
    expect(bridge.call).toHaveBeenCalledWith('backlog.transfer', { projectPath: '/p', id: 'b-001', version: 'v1', toProjectPath: '/q' });
  });
});
