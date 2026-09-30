/**
 * Уведомление в окне (кусок 8 «Organic», спека окна 2026-09-29, 1.10): карточка справа снизу с `Open` и `Later`,
 * скрытие через 8 с, замена карточки той же комнаты, `Open` открывает вкладку комнаты. Настоящие сторы работ и
 * раскладки; таймеры — поддельные, `sonner` — заглушка (тост «цели больше нет»).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@harnas/core';
import type { FocusTarget } from '../../shared/bridge.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { WindowNotes } from './WindowNotes.js';
import { useWindowNotesStore, WINDOW_NOTE_MS, type WindowNote } from './window-notes.js';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

const KEY = workKey('/tmp/p', 'w-01');

function target(roomId: string): FocusTarget {
  return { kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId };
}

function note(roomId: string, body = 'Возвраты · S01 collected positions'): WindowNote {
  return { tag: `proposal:${KEY}:${roomId}`, title: 'Decision waiting for you', body, target: target(roomId) };
}

function workWithRooms(roomIds: string[]): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms: roomIds.map((id) => ({ id, title: id, creator: 'human', members: [], createdAt: '2026-01-01', lead: null, proposal: null })),
      work: { id: 'w-01', title: 'Redesign', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions: [],
      messages: [],
    },
  };
}

function show(...notes: WindowNote[]): void {
  act(() => {
    for (const item of notes) useWindowNotesStore.getState().show(item);
  });
}

const cards = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('[data-window-note]');

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockClear();
  useWindowNotesStore.setState({ notes: [] });
  useWorksStore.setState({ entries: [workWithRooms(['r-01', 'r-02'])], branches: {}, loading: false, error: null });
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: { [KEY]: emptyLayout() },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WindowNotes — вид', () => {
  it('без карточек не рисует ничего', () => {
    const { container } = render(<WindowNotes />);
    expect(container.innerHTML).toBe('');
  });

  it('карточка: заголовок, текст, кнопки Open и Later; справа снизу над строкой статуса, 320px', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    const card = screen.getByRole('status');
    expect(card.textContent).toContain('Decision waiting for you');
    expect(card.textContent).toContain('Возвраты · S01 collected positions');
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
    // right 16, bottom 40, ширина 320 — спека 1.10; ниже диалогов и палитры (z-50).
    const column = document.querySelector('[data-window-notes]');
    expect(column?.className).toContain('right-4');
    expect(column?.className).toContain('bottom-10');
    expect(column?.className).toContain('w-80');
    expect(column?.className).toContain('z-40');
    // Карточка на фоне меню и палитры (`neutral-100`), с тенью и радиусом 16.
    expect(card.className).toContain('bg-popover');
    expect(card.className).toContain('shadow-lg');
    expect(card.className).toContain('rounded-md');
  });

  it('длинный текст переносится, а не выталкивает кнопки за край', () => {
    render(<WindowNotes />);
    show(note('r-01', `${'Очень-длинное-название-комнаты-без-пробелов '.repeat(4)}· S01 collected positions`));
    expect(screen.getByText(/Очень-длинное/).className).toContain('[overflow-wrap:anywhere]');
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
  });
});

describe('WindowNotes — Later и таймер 8 с', () => {
  it('Later скрывает карточку сразу', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(cards()).toHaveLength(0);
    expect(useWindowNotesStore.getState().notes).toEqual([]);
  });

  it('карточка скрывается сама ровно через 8 с: за миллисекунду до — на месте', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    act(() => {
      vi.advanceTimersByTime(WINDOW_NOTE_MS - 1);
    });
    expect(cards()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cards()).toHaveLength(0);
    expect(WINDOW_NOTE_MS).toBe(8000);
  });

  it('замена карточки той же комнаты: текст новый, отсчёт 8 с — заново', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    show(note('r-01', 'Возвраты · S01 revised the decision'));
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('revised the decision');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // С первого показа прошло 10 с, со второго — 5: карточка на месте.
    expect(cards()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(cards()).toHaveLength(0);
  });

  it('таймер прежней карточки не скрывает новую: dismiss с чужим номером показа — пустой ход', () => {
    show(note('r-01'));
    const first = useWindowNotesStore.getState().notes[0];
    show(note('r-01', 'новый текст'));
    act(() => {
      useWindowNotesStore.getState().dismiss(note('r-01').tag, first?.seq);
    });
    expect(useWindowNotesStore.getState().notes).toHaveLength(1);
    act(() => {
      useWindowNotesStore.getState().dismiss(note('r-01').tag);
    });
    expect(useWindowNotesStore.getState().notes).toEqual([]);
  });
});

describe('WindowNotes — несколько комнат', () => {
  it('по карточке на комнату, новые ниже; больше трёх — самая старая уходит', () => {
    render(<WindowNotes />);
    show(note('r-01'), note('r-02'));
    expect([...cards()].map((card) => card.dataset.windowNote)).toEqual([`proposal:${KEY}:r-01`, `proposal:${KEY}:r-02`]);
    show(note('r-03'), note('r-04'));
    expect([...cards()].map((card) => card.dataset.windowNote)).toEqual([
      `proposal:${KEY}:r-02`,
      `proposal:${KEY}:r-03`,
      `proposal:${KEY}:r-04`,
    ]);
  });

  it('карточка одной комнаты гаснет по своему таймеру, соседняя стоит своё', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    show(note('r-02'));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect([...cards()].map((card) => card.dataset.windowNote)).toEqual([`proposal:${KEY}:r-02`]);
  });
});

describe('WindowNotes — Open', () => {
  it('открывает вкладку комнаты в её работе и уносит карточку', () => {
    render(<WindowNotes />);
    show(note('r-01'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const state = useLayoutStore.getState();
    expect(state.activeWorkKey).toBe(KEY);
    expect(groups(state.layouts[KEY] ?? emptyLayout()).some((group) => group.activeTabId === 'room:r-01')).toBe(true);
    expect(cards()).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it('комнату успели закрыть или удалить — тост «no longer exists», вкладки нет', () => {
    render(<WindowNotes />);
    show(note('r-77'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(toast).toHaveBeenCalledWith('Workspace or session no longer exists');
    expect(groups(useLayoutStore.getState().layouts[KEY] ?? emptyLayout()).flatMap((group) => group.tabs)).toEqual([]);
    expect(cards()).toHaveLength(0);
  });
});
