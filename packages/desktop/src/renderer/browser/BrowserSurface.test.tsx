/**
 * Тесты 3, 5, 6, 7 (раскладка), 8 и favicon куска 9.2a: поверхность вкладки браузера в слое
 * работы рядом с `LayoutView` — так её монтирует контейнер работы в `AppShell.tsx`.
 *
 * `<webview>` в jsdom — неизвестный элемент без методов: тест навешивает на него подставные
 * `getWebContentsId`, `loadURL`, `reload`… после монтирования и шлёт события руками, как их
 * прислал бы Electron (у событий `<webview>` поля лежат на самом событии).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkEntry } from '@harnas/core';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { LayoutView } from '../layout/LayoutView.js';
import { useLayoutStore } from '../layout/store.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { findTab } from '../layout/tree.js';
import { requestAddressFocus, useBrowserStore, wantsAddressFocus } from './store.js';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const WORK_KEY = '/tmp/p w';
const TAB = 'browser:abc123';

function entry(): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions: [],
      messages: [],
    },
  };
}

function setBrowserTab(url: string): void {
  const tab: TabSpec = { kind: 'browser', id: TAB, url };
  const root: GroupNode = { type: 'group', id: 'g1', tabs: [tab], activeTabId: TAB };
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root, activeGroupId: 'g1', closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

let bridge: FakeBridge;

function renderWork(): void {
  render(
    <div>
      <LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />
      <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} />
    </div>,
  );
}

interface FakeWebview extends HTMLElement {
  getWebContentsId: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
}

function webview(): FakeWebview | null {
  return document.querySelector<FakeWebview>(`[data-surface-layer] [data-tab-id="${TAB}"] webview`);
}

/** Методы `<webview>` Electron — на узел из DOM. */
function arm(view: FakeWebview | null, webContentsId = 7): FakeWebview {
  if (view === null) throw new Error('нет <webview>');
  Object.assign(view, {
    getWebContentsId: vi.fn(() => webContentsId),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
  });
  return view;
}

function fire(view: HTMLElement, type: string, fields: Record<string, unknown> = {}): void {
  act(() => {
    view.dispatchEvent(Object.assign(new Event(type), fields));
  });
}

function layoutUrlOfTab(): string | undefined {
  const layout = useLayoutStore.getState().layouts[WORK_KEY];
  const found = layout === undefined ? null : findTab(layout, TAB);
  const tab = found?.group.tabs[found.index];
  return tab?.kind === 'browser' ? tab.url : undefined;
}

function tabTitle(): string | null | undefined {
  return document.querySelector(`[role="tab"][data-tab-id="${TAB}"]`)?.textContent;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  useWorksStore.setState({ entries: [entry()], branches: {}, loading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useBrowserStore.setState({ tabs: {} });
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

describe('BrowserSurface (тест 3)', () => {
  it('page-title-updated меняет заголовок вкладки', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    expect(tabTitle()).toContain('http://localhost:5173/');
    fire(view, 'page-title-updated', { title: 'Dev server' });
    expect(useBrowserStore.getState().tabs[TAB]?.title).toBe('Dev server');
    expect(tabTitle()).toContain('Dev server');
  });

  it('render-process-gone — слой Page crashed поверх страницы, Reload зовёт reload()', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    fire(view, 'dom-ready');
    expect(screen.queryByText('Page crashed')).toBeNull();
    fire(view, 'render-process-gone', { details: { reason: 'crashed', exitCode: 1 } });
    expect(screen.getByText('Page crashed')).toBeTruthy();
    const layer = screen.getByTestId('browser-crashed');
    fireEvent.click(layer.querySelector('button') as HTMLButtonElement);
    expect(view.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Page crashed')).toBeNull();
    // Окно живо: поверхность и страница на месте.
    expect(webview()).toBe(view);
  });

  it('getWebContentsId до dom-ready не вызван, после — webContentsId в сторе', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 42);
    fire(view, 'did-start-loading');
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    expect(view.getWebContentsId).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().tabs[TAB]?.webContentsId ?? null).toBeNull();
    fire(view, 'dom-ready');
    expect(view.getWebContentsId).toHaveBeenCalled();
    expect(useBrowserStore.getState().tabs[TAB]?.webContentsId).toBe(42);
  });

  it('загрузка и «назад / вперёд»: полоса загрузки, Stop во время загрузки, кнопки — по canGoBack/canGoForward', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    fire(view, 'dom-ready');
    fire(view, 'did-start-loading');
    expect(screen.getByTestId('browser-loading')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(view.stop).toHaveBeenCalledTimes(1);
    fire(view, 'did-stop-loading');
    expect(screen.queryByTestId('browser-loading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(view.reload).toHaveBeenCalledTimes(1);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/b' });
    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    const forward = screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
    fireEvent.click(back);
    expect(view.goBack).toHaveBeenCalledTimes(1);
  });

  it('DevTools — browser.openDevTools(webContentsId); отказ — тост, окно живо', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 9);
    const devTools = screen.getByRole('button', { name: 'DevTools' }) as HTMLButtonElement;
    expect(devTools.disabled).toBe(true);
    fire(view, 'dom-ready');
    fireEvent.click(devTools);
    expect(bridge.browserCalls).toContainEqual({ method: 'openDevTools', args: [9] });
  });

  it('favicon — событие browser:favicon своего webContentsId; чужое не трогает', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 5);
    fire(view, 'dom-ready');
    act(() => bridge.emitFavicon({ webContentsId: 6, dataUrl: 'data:image/png;base64,BB==' }));
    expect(useBrowserStore.getState().tabs[TAB]?.favicon ?? null).toBeNull();
    act(() => bridge.emitFavicon({ webContentsId: 5, dataUrl: 'data:image/png;base64,AA==' }));
    expect(useBrowserStore.getState().tabs[TAB]?.favicon).toBe('data:image/png;base64,AA==');
    const img = document.querySelector<HTMLImageElement>(`[role="tab"][data-tab-id="${TAB}"] img`);
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  });

  it('размонтирование — remove(tabId)', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview()), 'dom-ready');
    expect(useBrowserStore.getState().tabs[TAB]).toBeDefined();
    cleanup();
    expect(useBrowserStore.getState().tabs[TAB]).toBeUndefined();
  });
});

describe('BrowserSurface — новая вкладка (тест 5)', () => {
  it('без адреса: webview нет, фокус в адресной строке; Enter с localhost:5173 — updateTab и webview с этим src', () => {
    setBrowserTab('');
    requestAddressFocus(TAB);
    renderWork();
    expect(webview()).toBeNull();
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173');
    expect(webview()?.getAttribute('src')).toBe('http://localhost:5173');
  });

  it('пустая вкладка из восстановленной раскладки фокус не забирает (перенос 9.2a)', () => {
    setBrowserTab('');
    renderWork();
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(document.activeElement).not.toBe(field);
  });

  it('фокус адресной строки — один раз: после монтирования просьба снята', () => {
    setBrowserTab('');
    requestAddressFocus(TAB);
    renderWork();
    expect(wantsAddressFocus(TAB)).toBe(false);
  });

  it('восстановленная вкладка с about:blank — заглушка, webview нет', () => {
    setBrowserTab('about:blank');
    renderWork();
    expect(webview()).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Address' })).toBeTruthy();
    expect(screen.queryByText("Couldn't show layout")).toBeNull();
  });
});

describe('BrowserSurface — src один раз (тесты 6, 7)', () => {
  it('did-navigate-in-page — новый url в раскладке, id прежний, src и loadURL не тронуты; Enter живой страницы — loadURL', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    const setAttribute = vi.spyOn(view, 'setAttribute');
    fire(view, 'dom-ready');

    fire(view, 'did-navigate-in-page', { url: 'http://localhost:5173/#/next', isMainFrame: true });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/#/next');
    expect(webview()).toBe(view);
    fire(view, 'did-navigate-in-page', { url: 'http://localhost:5173/frame', isMainFrame: false });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/#/next');
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toEqual([]);
    expect(view.loadURL).not.toHaveBeenCalled();

    const field = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(field, { target: { value: 'localhost:5173/other' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(view.loadURL).toHaveBeenCalledWith('http://localhost:5173/other');
    expect(view.getAttribute('src')).toBe('http://localhost:5173/');
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toEqual([]);
  });

  it('did-navigate на about:blank раскладку не меняет; адрес с user:pass@ пишется без них', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    fire(view, 'did-navigate', { url: 'about:blank' });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/');
    fire(view, 'did-navigate', { url: 'http://u:p@localhost:5173/x' });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/x');
  });
});

describe('BrowserSurface — атрибуты (тест 8)', () => {
  it('webview несёт allowpopups, partition и webpreferences в DOM', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = webview();
    expect(view?.hasAttribute('allowpopups')).toBe(true);
    expect(view?.getAttribute('partition')).toBe(BROWSER_PARTITION);
    expect(view?.getAttribute('webpreferences')).toBe('contextIsolation=yes, sandbox=yes');
  });
});
