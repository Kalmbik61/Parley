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
import { useUiStore } from '../store/ui.js';
import { Titlebar } from './Titlebar.js';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true, paletteOpen: false, picker: null });
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

  it('поиск «⌘K» открывает палитру, «правый сайдбар» неактивен (до 7.2)', () => {
    render(<Titlebar bridge={bridge} />);

    fireEvent.click(screen.getByText('Search'));
    expect(useUiStore.getState().paletteOpen).toBe(true);

    expect((screen.getByLabelText('Right sidebar') as HTMLButtonElement).disabled).toBe(true);
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
