/**
 * Уведомление в окне (кусок 8 «Organic», спека окна 2026-09-29, 1.10): карточка справа снизу с `Open` и `Later`,
 * скрытие через 8 с, замена карточки той же комнаты, `Open` открывает вкладку комнаты. Настоящие сторы работ и
 * раскладки; таймеры — поддельные, `sonner` — заглушка (тост «цели больше нет»).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@parley/core';
import type { FocusTarget } from '../../shared/bridge.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { TOAST_INSET_VAR } from '../ui/sonner.js';
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
  const tags = (): Array<string | undefined> => [...cards()].map((card) => card.dataset.windowNote);

  it('по карточке на комнату, новая сверху; больше двух — самая старая уходит', () => {
    render(<WindowNotes />);
    show(note('r-01'), note('r-02'));
    expect(tags()).toEqual([`proposal:${KEY}:r-02`, `proposal:${KEY}:r-01`]);
    show(note('r-03'));
    expect(tags()).toEqual([`proposal:${KEY}:r-03`, `proposal:${KEY}:r-02`]);
    show(note('r-04'), note('r-05'));
    expect(tags()).toEqual([`proposal:${KEY}:r-05`, `proposal:${KEY}:r-04`]);
  });

  it('карточек не больше двух — иначе три с длинным названием комнаты выходят за верх окна 800×500', () => {
    render(<WindowNotes />);
    show(note('r-01'), note('r-02'), note('r-03'), note('r-04'));
    expect(cards()).toHaveLength(2);
    // Кнопки обеих на месте: столбец не вырос сверх двух карточек.
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Later' })).toHaveLength(2);
  });

  it('замена карточки той же комнаты ставит её наверх и не занимает второго места', () => {
    render(<WindowNotes />);
    show(note('r-01'), note('r-02'));
    show(note('r-01', 'Возвраты · S01 revised the decision'));
    expect(tags()).toEqual([`proposal:${KEY}:r-01`, `proposal:${KEY}:r-02`]);
    expect(cards()[0]?.textContent).toContain('revised the decision');
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

/**
 * Место для тостов sonner: столбец карточек и тосты делят правый нижний угол, и тост закрывал `Open` и `Later`. Пока
 * столбец стоит, его высота с зазором лежит в `--toast-inset-bottom` на `<html>`; `Toaster` поднимает тосты на эту
 * величину (`ui/ui.test.tsx`). Раскладки в jsdom нет — высоту и наблюдателя подставляет тест.
 */
describe('WindowNotes — высота столбца для тостов (--toast-inset-bottom)', () => {
  const inset = (): string => document.documentElement.style.getPropertyValue(TOAST_INSET_VAR);
  const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
  let columnHeight = 0;
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => {
    observers.length = 0;
    columnHeight = 0;
    class ResizeObserverStub {
      readonly entry = { callback: (): void => {}, disconnected: false };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observers.push(this.entry);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        this.entry.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-window-notes') ? columnHeight : 0;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
    document.documentElement.style.removeProperty(TOAST_INSET_VAR);
  });

  it('карточек нет — переменной нет: тосты стоят на обычном месте', () => {
    render(<WindowNotes />);
    expect(inset()).toBe('');
  });

  it('карточка встала — переменная равна высоте столбца и зазору 8px; следит наблюдатель', () => {
    render(<WindowNotes />);
    columnHeight = 172;
    show(note('r-01'));
    expect(inset()).toBe('180px');
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnected).toBe(false);
  });

  it('столбец вырос или уменьшился — наблюдатель обновляет переменную без новых карточек', () => {
    render(<WindowNotes />);
    columnHeight = 172;
    show(note('r-01'));
    columnHeight = 358;
    act(() => observers[0]?.callback());
    expect(inset()).toBe('366px');
    columnHeight = 172;
    act(() => observers[0]?.callback());
    expect(inset()).toBe('180px');
  });

  it('последняя карточка ушла — переменная снята, наблюдатель отключён; следующая ставит её заново', () => {
    render(<WindowNotes />);
    columnHeight = 172;
    show(note('r-01'));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(inset()).toBe('');
    expect(observers[0]?.disconnected).toBe(true);
    columnHeight = 190;
    show(note('r-02'));
    expect(inset()).toBe('198px');
  });

  it('окно закрыли, пока карточка стояла — переменная не остаётся на <html>', () => {
    const { unmount } = render(<WindowNotes />);
    columnHeight = 172;
    show(note('r-01'));
    expect(inset()).toBe('180px');
    unmount();
    expect(inset()).toBe('');
  });
});
