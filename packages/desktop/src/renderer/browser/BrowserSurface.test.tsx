/**
 * Тесты 3, 5, 6, 7 (раскладка), 8 и favicon куска 9.2a: поверхность вкладки браузера в слое
 * работы рядом с `LayoutView` — так её монтирует контейнер работы в `AppShell.tsx`.
 *
 * `<webview>` в jsdom — неизвестный элемент без методов: тест навешивает на него подставные
 * `getWebContentsId`, `loadURL`, `reload`… после монтирования и шлёт события руками, как их
 * прислал бы Electron (у событий `<webview>` поля лежат на самом событии).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkEntry } from '@parley/core';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { LayoutView } from '../layout/LayoutView.js';
import { useLayoutStore } from '../layout/store.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { findTab, updateTab } from '../layout/tree.js';
import { requestAddressFocus, useBrowserStore, wantsAddressFocus } from './store.js';
import { toast } from 'sonner';
import type { PickResult } from '../../shared/browser-types.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { consoleEntry, devtoolsBatch, networkEntry } from '../test-utils/devtools-fixtures.js';
import { useDevtoolsStore } from './devtools/store.js';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

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

function sendDeps(): SendWithToastDeps {
  return { bridge, session: () => null, openSession: vi.fn() };
}

function renderWork(): void {
  render(
    <div>
      <LayoutView workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: () => {} }} />
      <SurfaceLayer workKey={WORK_KEY} active bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={sendDeps()} />
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

function tabOfLayout(): TabSpec | undefined {
  const layout = useLayoutStore.getState().layouts[WORK_KEY];
  const found = layout === undefined ? null : findTab(layout, TAB);
  return found?.group.tabs[found.index];
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
  useBrowserStore.setState({ tabs: {}, limitToasted: {} });
  useDevtoolsStore.setState({ tabs: {} });
  useUiStore.setState({ ui: DEFAULT_UI });
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

  it('⋯ → Open full DevTools — browser.openDevTools(webContentsId); до dom-ready ⋯ неактивна', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 9);
    const more = screen.getByRole('button', { name: 'More browser actions' }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    fire(view, 'dom-ready');
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open full DevTools' }));
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
  it('без адреса: webview нет, фокус в адресной строке; Enter с localhost:5173 — updateTab и webview (src about:blank) для этого адреса', () => {
    setBrowserTab('');
    requestAddressFocus(TAB);
    renderWork();
    expect(webview()).toBeNull();
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173');
    expect(webview()?.getAttribute('src')).toBe('about:blank');
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
  it('did-navigate-in-page — новый url в раскладке, id прежний, src и loadURL не тронуты; Enter живой страницы — loadURL', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    const setAttribute = vi.spyOn(view, 'setAttribute');
    fire(view, 'dom-ready');
    // Единственный loadURL до адресной строки — первая загрузка после захвата (вариант D).
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    view.loadURL.mockClear();

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
    expect(view.getAttribute('src')).toBe('about:blank');
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

describe('BrowserSurface — поиск по странице (тест 3 куска 9.2b)', () => {
  it('findOpen — FindBar поверх страницы с id гостя; Esc — stopFind и findOpen снят', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 11), 'dom-ready');
    expect(screen.queryByRole('search', { name: 'Find in page' })).toBeNull();
    act(() => useBrowserStore.getState().update(TAB, { findOpen: true }));
    const field = screen.getByPlaceholderText('Find…');
    fireEvent.change(field, { target: { value: 'abc' } });
    expect(bridge.browserCalls).toContainEqual({ method: 'find', args: [11, 'abc', true] });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'stopFind', args: [11] });
    expect(useBrowserStore.getState().tabs[TAB]?.findOpen).toBe(false);
    expect(screen.queryByRole('search', { name: 'Find in page' })).toBeNull();
  });
});

describe('BrowserSurface — мелочи fix-9', () => {
  it('падение страницы закрывает FindBar', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 11);
    fire(view, 'dom-ready');
    act(() => useBrowserStore.getState().update(TAB, { findOpen: true }));
    expect(screen.getByRole('search', { name: 'Find in page' })).toBeTruthy();
    fire(view, 'render-process-gone', { details: { reason: 'crashed', exitCode: 1 } });
    expect(screen.queryByRole('search', { name: 'Find in page' })).toBeNull();
    expect(useBrowserStore.getState().tabs[TAB]?.findOpen).toBe(false);
  });

  it('Esc в FindBar возвращает фокус странице', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 11);
    const focus = vi.spyOn(view, 'focus');
    fire(view, 'dom-ready');
    act(() => useBrowserStore.getState().update(TAB, { findOpen: true }));
    fireEvent.keyDown(screen.getByPlaceholderText('Find…'), { key: 'Escape' });
    expect(focus).toHaveBeenCalled();
  });

  it("did-fail-load главного фрейма — Couldn't load page и Reload; отмена (-3) и подфрейм — нет", () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    fire(view, 'dom-ready');
    fire(view, 'did-fail-load', { errorCode: -3, isMainFrame: true, validatedURL: 'http://localhost:5173/' });
    fire(view, 'did-fail-load', { errorCode: -105, isMainFrame: false, validatedURL: 'http://ads.test/' });
    expect(screen.queryByText("Couldn't load page")).toBeNull();
    fire(view, 'did-fail-load', { errorCode: -102, isMainFrame: true, validatedURL: 'http://localhost:5173/' });
    const layer = screen.getByTestId('browser-load-failed');
    expect(layer.textContent).toContain("Couldn't load page");
    fireEvent.click(layer.querySelector('button') as HTMLButtonElement);
    expect(view.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('browser-load-failed')).toBeNull();
    // Новая загрузка (адресная строка, ссылка) слой тоже снимает.
    fire(view, 'did-fail-load', { errorCode: -102, isMainFrame: true, validatedURL: 'http://localhost:5173/' });
    fire(view, 'did-start-loading');
    expect(screen.queryByTestId('browser-load-failed')).toBeNull();
  });
});

const PICK: PickResult = {
  url: 'http://localhost:5173/',
  selector: 'body > button.save',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: { display: 'block' },
  imagePath: null,
  thumbnail: 'data:image/png;base64,AAAA',
};

function pickOf(): unknown {
  return useBrowserStore.getState().tabs[TAB]?.pick;
}

describe('BrowserSurface — Design Mode (тест 3 куска 9.3b)', () => {
  it('⌖ неактивна до dom-ready; результат pickStart — карточка поверх страницы', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    const button = screen.getByRole('button', { name: 'Design Mode' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fire(view, 'dom-ready');
    bridge.setPickResult(PICK);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(bridge.pickCalls).toEqual([{ method: 'pickStart', webContentsId: 12 }]);
    expect(pickOf()).toEqual({ result: PICK });
    expect(screen.getByTestId('design-mode-card').textContent).toContain('body > button.save');
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
  });

  it('pickStart ответил null — режим снят, карточки нет', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }));
    });
    expect(pickOf()).toBe('off');
    expect(screen.queryByTestId('design-mode-card')).toBeNull();
  });

  it('повторный ⌖ и Esc во время выбора — pickCancel, режим снят; кнопка подсвечена только в режиме', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    // Настоящий выбор ждёт клика человека: промис не разрешается сам.
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    const button = screen.getByRole('button', { name: 'Design Mode' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(pickOf()).toBe('picking');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
    expect(pickOf()).toBe('off');

    await act(async () => {
      fireEvent.click(button);
    });
    expect(pickOf()).toBe('picking');
    await act(async () => {
      fireEvent.keyDown(button, { key: 'Escape' });
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel', 'pickStart', 'pickCancel']);
    expect(pickOf()).toBe('off');
  });

  it('отказ { code: failed } — тост Couldn\'t pick element: failed. и режим снят', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setPickResult({ code: 'failed', message: 'boom' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }));
    });
    expect(toast).toHaveBeenCalledWith("Couldn't pick element: failed.");
    expect(pickOf()).toBe('off');
  });

  it('did-navigate во время выбора — pick снова off; поздний ответ прежнего выбора карточку не ставит', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    fire(view, 'dom-ready');
    let answer: (value: PickResult | null) => void = () => {};
    bridge.browser.pickStart = () => new Promise<PickResult | null>((resolve) => (answer = resolve));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }));
    });
    expect(pickOf()).toBe('picking');
    fire(view, 'did-navigate', { url: 'http://localhost:5173/other' });
    expect(pickOf()).toBe('off');
    await act(async () => answer(PICK));
    expect(pickOf()).toBe('off');
    expect(screen.queryByTestId('design-mode-card')).toBeNull();
  });

  it('вкладка скрыта во время выбора — pickCancel, режим снят (fix-9)', async () => {
    setBrowserTab('http://localhost:5173/');
    // Вторая вкладка той же группы: её активация скрывает страницу.
    act(() =>
      useLayoutStore.getState().apply(WORK_KEY, (layout) => {
        const root = layout.root as GroupNode;
        return { ...layout, root: { ...root, tabs: [...root.tabs, { kind: 'browser', id: 'browser:other', url: '' }] } };
      }),
    );
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }));
    });
    expect(pickOf()).toBe('picking');
    await act(async () => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => ({
        ...layout,
        root: { ...(layout.root as GroupNode), activeTabId: 'browser:other' },
      }));
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
    expect(pickOf()).toBe('off');
  });

  it('карточка: Pick again зовёт pickStart заново; did-navigate снимает карточку', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    fire(view, 'dom-ready');
    bridge.setPickResult(PICK);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Design Mode' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pick again' }));
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickStart']);
    expect(screen.getByTestId('design-mode-card')).toBeTruthy();
    fire(view, 'did-navigate', { url: 'http://localhost:5173/other' });
    expect(screen.queryByTestId('design-mode-card')).toBeNull();
  });
});

describe('BrowserSurface — строка вкладки (спека 2026-10-07, 4.1, 4.2)', () => {
  it('счётчики — из журнала вкладки; ⋯ → Clear console and network — devtoolsClear(id), журнал пуст', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 9), 'dom-ready');
    act(() => useDevtoolsStore.getState().batch(TAB, devtoolsBatch({ webContentsId: 9, network: [networkEntry('fail', { status: 500 })] })));
    expect(screen.getByTestId('devtools-errors').textContent).toBe('1');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear console and network' }));
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsClear', args: [9] });
    expect(useDevtoolsStore.getState().tabs[TAB]?.network).toEqual([]);
    expect(screen.queryByTestId('devtools-errors')).toBeNull();
  });

  it('размер из меню — в раскладку вкладки (TabSpec.viewport); Fit — поля нет', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 9), 'dom-ready');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    expect(tabOfLayout()).toEqual({ kind: 'browser', id: TAB, url: 'http://localhost:5173/', viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fit' }));
    expect(tabOfLayout()).toEqual({ kind: 'browser', id: TAB, url: 'http://localhost:5173/' });
  });
});

const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };

/** RO с размерами: поле страницы — 800×600, вкладка целиком и прочее — 800×700. */
class SizedResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const rect = target.matches('[data-testid="browser-field"]') ? { width: 800, height: 600 } : { width: 800, height: 700 };
    this.callback([{ target, contentRect: rect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function setBrowserTabSized(url: string, viewport: ViewportSpec): void {
  setBrowserTab(url);
  useLayoutStore.getState().apply(WORK_KEY, (layout) => updateTab(layout, TAB, { viewport }));
}

describe('BrowserSurface — журнал (спека 2026-10-07, 3.5; Фокус ревью 4)', () => {
  it('пачка до dom-ready не применяется; на dom-ready — снимок своего гостя; дальше — только его пачки', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 7);
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 7, console: [consoleEntry(1, { text: 'early' })] })));
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [consoleEntry(1, { text: 'early' })], network: [] });
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsSnapshot', args: [7] });
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['early']);
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 7, console: [consoleEntry(2, { level: 'error', text: 'late' })] })));
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 8, console: [consoleEntry(3, { text: 'foreign' })] })));
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['early', 'late']);
    expect(screen.getByTestId('devtools-errors').textContent).toBe('1');
  });

  it('кнопка строки — панель; ⌘⌥I в адресной строке — спрятать; ⌘⌥J — сразу Console; закрытие вкладки — журнал убран', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Console and network' }));
    expect(screen.getByTestId('devtools-panel')).toBeTruthy();
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.keyDown(address, { key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true });
    expect(screen.queryByTestId('devtools-panel')).toBeNull();
    act(() => useDevtoolsStore.getState().patch(TAB, { view: 'network' }));
    fireEvent.keyDown(address, { key: '∆', code: 'KeyJ', metaKey: true, altKey: true });
    expect(useDevtoolsStore.getState().tabs[TAB]).toMatchObject({ open: true, view: 'console' });
    cleanup();
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
  });

  it('⌘⌥I и ⌘⌥J с фокусом внутри панели вкладки — тоже ловит поверхность (ревью задачи 10)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'network'));
    const panel = screen.getByTestId('devtools-panel');
    fireEvent.keyDown(panel, { key: '∆', code: 'KeyJ', metaKey: true, altKey: true });
    expect(useDevtoolsStore.getState().tabs[TAB]).toMatchObject({ open: true, view: 'console' });
    fireEvent.keyDown(screen.getByTestId('devtools-panel'), { key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true });
    expect(screen.queryByTestId('devtools-panel')).toBeNull();
  });

  it('открытие панели снимает журнал заново: в болтливой консоли пачки отдают только свежее', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    const snapshots = (): number => bridge.browserCalls.filter((call) => call.method === 'devtoolsSnapshot').length;
    const before = snapshots();
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [consoleEntry(1), consoleEntry(2)], network: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Console and network' }));
    });
    expect(snapshots()).toBe(before + 1);
    expect(useDevtoolsStore.getState().tabs[TAB]?.console).toHaveLength(2);
  });

  it('late — в панели «Reload to capture earlier requests», Reload — reload() страницы', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 7);
    bridge.setDevtoolsSnapshot({ epoch: 1, capture: 'late', console: [], network: [] });
    fire(view, 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    const panel = screen.getByTestId('devtools-panel');
    expect(within(panel).getByRole('status').textContent).toContain('Reload to capture earlier requests');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reload' }));
    expect(view.reload).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserSurface — размер вьюпорта (спека 2026-10-07, 4.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  });

  it('Mobile M: setViewport(id, размер, место под страницу); тот же webview — по scale и по центру; подпись с процентом', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    bridge.setViewportScale(0.5);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'setViewport', args: [7, MOBILE_M, { width: 768, height: 548 }] });
    expect(webview()).toBe(view);
    expect([view.style.left, view.style.top, view.style.width, view.style.height]).toEqual(['307px', '107px', '187px', '406px']);
    expect(screen.getByTestId('viewport-label').textContent).toContain('375 × 812 · 2x · 50%');
  });

  it('Fit после размера — setViewport(id, null), webview во всё поле, подписи нет; Fit сразу — main не зовётся', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    await act(async () => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => updateTab(layout, TAB, { viewport: null }));
    });
    expect(bridge.browserCalls.filter((call) => call.method === 'setViewport').at(-1)?.args.slice(0, 2)).toEqual([7, null]);
    expect(view.style.width).toBe('');
    expect(screen.queryByTestId('viewport-label')).toBeNull();
    cleanup();
    bridge = createFakeBridge();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls.some((call) => call.method === 'setViewport')).toBe(false);
  });

  it('мобильный размер на документе без касаний — «Reload to apply touch»; после перезагрузки подсказки нет (спайк 0.3)', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    fire(view, 'dom-ready');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reload to apply touch' }));
    expect(view.reload).toHaveBeenCalledTimes(1);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    expect(screen.queryByRole('button', { name: 'Reload to apply touch' })).toBeNull();
  });

  it('перезапуск вкладки с Mobile (вариант D): about:blank → devtoolsReady → setViewport → loadURL → did-navigate — ложной подсказки «Reload to apply touch» нет ни до, ни после', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    const view = arm(webview(), 7);
    // Пустая страница документ вкладки не заменяет: касания у неё не спрашивают.
    fire(view, 'did-navigate', { url: 'about:blank' });
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    expect(screen.getByTestId('viewport-label')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload to apply touch' })).toBeNull();
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    expect(screen.queryByRole('button', { name: 'Reload to apply touch' })).toBeNull();
  });

  it('высота панели — из ui.json; ручка пишет новую в настройки окна', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, browser: { devtoolsHeight: 300 } } });
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    expect(screen.getByTestId('devtools-panel').style.height).toBe('300px');
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 450 });
    expect(useUiStore.getState().ui.browser.devtoolsHeight).toBe(350);
    expect(screen.getByTestId('devtools-panel').style.height).toBe('350px');
  });

  it('клик по ручке без сдвига — высота 40 % по умолчанию в ui.json не замораживается (ревью задачи 13)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    expect(screen.getByTestId('devtools-panel').style.height).toBe('280px');
    const original = useUiStore.getState().patchUi;
    const patchUi = vi.fn();
    useUiStore.setState({ patchUi });
    try {
      const handle = screen.getByRole('separator', { name: 'Resize panel' });
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 500 });
    } finally {
      useUiStore.setState({ patchUi: original });
    }
    expect(patchUi).not.toHaveBeenCalled();
    expect(useUiStore.getState().ui.browser.devtoolsHeight).toBeNull();
  });

  it('тот же размер из меню (повторный выбор пресета) — раскладка и main не трогаются (ревью задачи 14)', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    const tabBefore = tabOfLayout();
    const applied = (): number => bridge.browserCalls.filter((call) => call.method === 'setViewport').length;
    const before = applied();
    expect(before).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    await act(async () => {});
    expect(tabOfLayout()).toBe(tabBefore);
    expect(applied()).toBe(before);
    // Другой размер по-прежнему доходит и до раскладки, и до main.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile L/ }));
    await act(async () => {});
    expect(tabOfLayout()).toMatchObject({ viewport: { preset: 'mobile-l', rotated: false, dpr: 2 } });
    expect(applied()).toBe(before + 1);
  });
});

describe('BrowserSurface — первая загрузка после захвата (спайк 0.1, вариант D; Фокус ревью 6)', () => {
  it('webview стартует с about:blank; адрес вкладки — на первом dom-ready и только после devtoolsReady; дальше не повторяется', async () => {
    setBrowserTab('http://localhost:5173/app');
    let release: () => void = () => {};
    bridge.setDevtoolsReady(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    renderWork();
    const view = arm(webview(), 7);
    expect(view.getAttribute('src')).toBe('about:blank');
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsReady', args: [7] });
    expect(view.loadURL).not.toHaveBeenCalled();
    await act(async () => release());
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/app']]);
    // dom-ready открытой страницы ничего не открывает: ни ожидания захвата, ни повторной загрузки.
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(bridge.browserCalls.filter((call) => call.method === 'devtoolsReady')).toHaveLength(1);
  });

  it('devtoolsReady отказал — страница всё равно открывается', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowserTab('http://localhost:5173/');
    bridge.setDevtoolsReady({ code: 'failed', message: 'boom' });
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    warn.mockRestore();
  });

  it('dom-ready чистого гостя пропущен (слушатели встали позже события) — страница открывается без события, по готовности гостя (F3)', async () => {
    // До dom-ready `getWebContentsId()` бросает; здесь гость уже готов — метод есть на любом элементе.
    const methods = { getWebContentsId: () => 7, loadURL: vi.fn(async () => {}), canGoBack: () => false, canGoForward: () => false };
    for (const [name, value] of Object.entries(methods)) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
    try {
      setBrowserTab('http://localhost:5173/app');
      renderWork();
      await act(async () => {});
      expect(useBrowserStore.getState().tabs[TAB]?.webContentsId).toBe(7);
      expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsReady', args: [7] });
      expect(methods.loadURL.mock.calls).toEqual([['http://localhost:5173/app']]);
    } finally {
      for (const name of Object.keys(methods)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it('размер вкладки ставится до первой загрузки: loadURL ждёт ответа setViewport, касания не опоздают к документу (F4)', async () => {
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    const answers: Array<() => void> = [];
    const setViewport = vi.spyOn(bridge.browser, 'setViewport').mockImplementation(
      () => new Promise((resolve) => answers.push(() => resolve({ scale: 1 }))),
    );
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsReady', args: [7] });
    expect(setViewport).toHaveBeenCalledWith(7, MOBILE_M, { width: 768, height: 548 });
    expect(view.loadURL).not.toHaveBeenCalled();
    await act(async () => answers.forEach((answer) => answer()));
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    expect(Math.min(...setViewport.mock.invocationCallOrder)).toBeLessThan(view.loadURL.mock.invocationCallOrder[0] ?? 0);
  });

  it('setViewport перед первой загрузкой отказал — страница всё равно открывается', async () => {
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    vi.spyOn(bridge.browser, 'setViewport').mockRejectedValue({ code: 'failed', message: 'boom' });
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    expect(warn).toHaveBeenCalledWith('[parley] viewport is not set before the first page', { code: 'failed', message: 'boom' });
    error.mockRestore();
    warn.mockRestore();
  });
});
