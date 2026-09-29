/**
 * Тест 7 куска 2.3: кнопка «сайдбар» переключает `ui.leftSidebar.open` и
 * зовёт `app.saveUi` с целым `leftSidebar`; «назад» неактивна, пока
 * `canBack()` ложно, и активна после смены вкладки в `layout/store.ts`.
 *
 * Геометрия Organic (спека окна 2026-09-29, 1.1): высота 40, без подложки и линии, левая зона шириной
 * сайдбара, кнопки-пилюли 28×28 со значками 15.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, focusTab, openTab } from '../layout/tree.js';
import { usePaletteStore } from '../palette/store.js';
import { useUiStore } from '../store/ui.js';
import { Titlebar } from './Titlebar.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true });
  usePaletteStore.setState({ open: false, mode: 'default', query: '' });
  useUiStore.getState().init(bridge);
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(cleanup);

describe('Titlebar (тест 7)', () => {
  it('«сайдбар» переключает ui.leftSidebar.open и зовёт app.saveUi с целым leftSidebar', () => {
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    render(<Titlebar bridge={bridge} />);

    fireEvent.click(screen.getByLabelText('Workspace sidebar'));

    expect(useUiStore.getState().ui.leftSidebar).toEqual({ open: false, width: DEFAULT_UI.leftSidebar.width });
    expect(saveUiSpy).toHaveBeenCalledWith({
      leftSidebar: { open: false, width: DEFAULT_UI.leftSidebar.width },
    });
  });

  it('«назад» неактивна, пока canBack() ложно, и активна после смены вкладки', () => {
    render(<Titlebar bridge={bridge} />);
    const backButton = (): HTMLButtonElement => screen.getByLabelText('Back') as HTMLButtonElement;
    expect(backButton().disabled).toBe(true);

    let layout = emptyLayout();
    layout = openTab(layout, { kind: 'terminal', id: 't-1', sessionId: 's-01' });
    layout = openTab(layout, { kind: 'terminal', id: 't-2', sessionId: 's-02' });
    act(() => {
      useLayoutStore.getState().hydrate('w-01', layout);
      useLayoutStore.getState().setActiveWork('w-01');
      useLayoutStore.getState().apply('w-01', (current) => focusTab(current, 't-1'));
    });

    expect(useLayoutStore.getState().canBack()).toBe(true);
    expect(backButton().disabled).toBe(false);
  });

  it('поиск «⌘J» в заголовке открывает палитру, ⌘K нет (showSearch — сайдбара со строкой Search на экране нет)', () => {
    render(<Titlebar bridge={bridge} showSearch />);

    expect(screen.getByText('⌘J')).toBeTruthy();
    expect(screen.queryByText('⌘K')).toBeNull();
    fireEvent.click(screen.getByText('Search'));
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });
  });

  it('без showSearch поиска в заголовке нет: он в сайдбаре, а в заголовке дублировал бы его', () => {
    render(<Titlebar bridge={bridge} />);
    expect(screen.queryByText('Search')).toBeNull();
    expect(screen.queryByText('⌘J')).toBeNull();
  });

  it('«правый сайдбар» (7.2): без активной работы неактивен; с ней переключает ui.rightSidebar.open целым rightSidebar', () => {
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    render(<Titlebar bridge={bridge} />);
    const button = (): HTMLButtonElement => screen.getByLabelText('Right sidebar') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    act(() => {
      useLayoutStore.getState().hydrate('w-01', emptyLayout());
      useLayoutStore.getState().setActiveWork('w-01');
    });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(false);
    expect(saveUiSpy).toHaveBeenLastCalledWith({ rightSidebar: { ...DEFAULT_UI.rightSidebar, open: false } });
    fireEvent.click(button());
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(true);
  });

  it('«правый сайдбар» без места рядом с центром (800 px, левый открыт) — тост, open не меняется (раунд main-r2)', () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    try {
      render(<Titlebar bridge={bridge} />);
      act(() => {
        useLayoutStore.getState().hydrate('w-01', emptyLayout());
        useLayoutStore.getState().setActiveWork('w-01');
      });
      fireEvent.click(screen.getByLabelText('Right sidebar'));
      expect(vi.mocked(toast)).toHaveBeenCalledWith('Not enough room for the right sidebar');
      expect(useUiStore.getState().ui.rightSidebar.open).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('двойной клик по пустому месту заголовка зовёт app.titlebarDoubleClick', () => {
    render(<Titlebar bridge={bridge} />);
    fireEvent.doubleClick(screen.getByTestId('titlebar'));
    expect(bridge.titlebarDoubleClicks).toHaveLength(1);
  });

  it('двойной клик по кнопке не зовёт titlebarDoubleClick (не «пустое место»)', () => {
    render(<Titlebar bridge={bridge} />);
    fireEvent.doubleClick(screen.getByLabelText('Workspace sidebar'));
    expect(bridge.titlebarDoubleClicks).toHaveLength(0);
  });
});

describe('Titlebar — геометрия 1.1 (Organic)', () => {
  it('высота 40, на фоне окна: ни подложки карточки, ни нижней линии', () => {
    render(<Titlebar bridge={bridge} />);
    const titlebar = screen.getByTestId('titlebar');
    expect(titlebar.className).toMatch(/\bh-10\b/);
    expect(titlebar.className).not.toMatch(/\bh-9\b/);
    expect(titlebar.className).not.toMatch(/\bbg-card\b/);
    expect(titlebar.className).not.toMatch(/\bborder-b\b/);
    expect(titlebar.className).toContain('titlebar-drag');
  });

  it('левая зона — шириной сайдбара, пока он открыт, и по содержимому, когда скрыт; светофору — 80px слева', () => {
    render(<Titlebar bridge={bridge} />);
    const left = screen.getByTestId('titlebar-left');
    expect(left.style.width).toBe(`${DEFAULT_UI.leftSidebar.width}px`);
    expect(left.className).toMatch(/\bpl-20\b/);

    act(() => useUiStore.setState({ ui: { ...DEFAULT_UI, leftSidebar: { open: false, width: 300 } } }));
    expect(left.style.width).toBe('');

    act(() => useUiStore.setState({ ui: { ...DEFAULT_UI, leftSidebar: { open: true, width: 340 } } }));
    expect(left.style.width).toBe('340px');
  });

  it('левая зона тащит окно, а не кнопки: no-drag — на группе кнопок, не на всей зоне', () => {
    render(<Titlebar bridge={bridge} />);
    expect(screen.getByTestId('titlebar-left').className).not.toContain('titlebar-no-drag');
    expect(screen.getByLabelText('Workspace sidebar').closest('.titlebar-no-drag')).not.toBeNull();
  });

  it('кнопки — пилюли 28×28 со значками 15, hover text 8%, active text 14%', () => {
    render(<Titlebar bridge={bridge} />);
    for (const label of ['Workspace sidebar', 'Back', 'Forward', 'Right sidebar']) {
      const button = screen.getByLabelText(label);
      expect(button.className, label).toMatch(/\bsize-7\b/);
      expect(button.className, label).toMatch(/\brounded-full\b/);
      expect(button.className, label).toContain('hover:bg-foreground/8');
      expect(button.className, label).toContain('active:bg-foreground/14');
      expect(button.querySelector('svg')?.getAttribute('class'), label).toMatch(/\bsize-\[15px\]/);
    }
  });

  it('недоступная кнопка — прозрачность .45', () => {
    render(<Titlebar bridge={bridge} />);
    expect(screen.getByLabelText('Back').className).toContain('disabled:opacity-45');
    expect((screen.getByLabelText('Back') as HTMLButtonElement).disabled).toBe(true);
  });

  it('правый сайдбар включён — фон text 10% (aria-pressed), выключен — без него', () => {
    act(() => {
      useLayoutStore.getState().hydrate('w-01', emptyLayout());
      useLayoutStore.getState().setActiveWork('w-01');
    });
    render(<Titlebar bridge={bridge} />);
    const button = screen.getByLabelText('Right sidebar');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('aria-pressed:bg-foreground/10');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});
