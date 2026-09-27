/**
 * Тест 7 куска 2.3: кнопка «сайдбар» переключает `ui.leftSidebar.open` и
 * зовёт `app.saveUi` с целым `leftSidebar`; «назад» неактивна, пока
 * `canBack()` ложно, и активна после смены вкладки в `layout/store.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, focusTab, openTab } from '../layout/tree.js';
import { usePaletteStore } from '../palette/store.js';
import { useUiStore } from '../store/ui.js';
import { Titlebar } from './Titlebar.js';

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

  it('поиск «⌘J» открывает палитру, ⌘K нет', () => {
    render(<Titlebar bridge={bridge} />);

    expect(screen.getByText('⌘J')).toBeTruthy();
    expect(screen.queryByText('⌘K')).toBeNull();
    fireEvent.click(screen.getByText('Search'));
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });
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
