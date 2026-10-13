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
import type { Room, WorkEntry, WorkSession } from '@parley/core';
import type { BrowserTarget, GroupNode, TabSpec } from '../../shared/layout-types.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeRoom, makeSession } from '../test-utils/work-fixtures.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { LayoutView } from '../layout/LayoutView.js';
import { useLayoutStore } from '../layout/store.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { findTab, updateTab } from '../layout/tree.js';
import { requestAddressFocus, useBrowserStore, wantsAddressFocus } from './store.js';
import { toast } from 'sonner';
import type { AnnotationPick, AnnotationPosition, PickResult } from '../../shared/browser-types.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { consoleEntry, devtoolsBatch, networkEntry } from '../test-utils/devtools-fixtures.js';
import { useDevtoolsStore } from './devtools/store.js';
import { useAnnotateStore } from './annotate/store.js';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { roomKey } from '../lib/room-view.js';
import { resetDeliveryForTests } from './context/deliver.js';
import { TOAST_INSET_VAR } from '../ui/toast-inset.js';

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

function setBrowserTab(url: string, target?: BrowserTarget): void {
  const tab: TabSpec = target === undefined ? { kind: 'browser', id: TAB, url } : { kind: 'browser', id: TAB, url, target };
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
  useAnnotateStore.setState({ tabs: {} });
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
  imagePath: '/h/drops/a.png',
  point: { x: 10, y: 10 },
  shift: false,
  viewport: { width: 800, height: 600, dpr: 2 },
};

function modeOf(): unknown {
  return useBrowserStore.getState().tabs[TAB]?.mode;
}

describe('BrowserSurface — Select (этап B, спека браузера 4.6)', () => {
  beforeEach(() => {
    resetDeliveryForTests();
    useUiStore.setState({ composerAttachments: {} });
    vi.mocked(toast).mockClear();
  });

  it('⌖ неактивна до dom-ready; клик — pickStart, элемент — файл-контекст в цель, режим снят, агенту ничего', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    const button = screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fire(view, 'dom-ready');
    bridge.setPickResult(PICK);
    await act(async () => {
      fireEvent.click(button);
    });
    await vi.waitFor(() => expect(roomPaths()).toEqual(['/fake/drops/context/element-button.save-0001.md']));
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
    expect(modeOf()).toBe('off');
    expect(bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0]).toMatchObject({ kind: 'element', label: 'button.save', imagePath: '/h/drops/a.png' });
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
  });

  it('Фокус ревью 5: ⇧-клик держит режим — второй выбор; два файла в порядке кликов, один тост «2 elements»', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    const answers: Array<PickResult | null> = [{ ...PICK, shift: true }, { ...PICK, selector: 'body > button.cancel' }];
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return answers.shift() ?? null;
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(roomPaths()).toHaveLength(2));
    expect(roomPaths()).toEqual(['/fake/drops/context/element-button.save-0001.md', '/fake/drops/context/element-button.cancel-0002.md']);
    expect(bridge.pickCalls.filter((call) => call.method === 'pickStart')).toHaveLength(2);
    expect(modeOf()).toBe('off');
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]).toBe('2 elements added to review');
  });

  it('⇧-клик, затем отказ повторного pickStart — тост, режим снят и pickCancel уходит безусловно: сторож ⇧-клика не остаётся на странице (ревью задачи 16, I2)', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    const answers: Array<PickResult | { code: string; message: string }> = [{ ...PICK, shift: true }, { code: 'failed', message: 'boom' }];
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      const answer = answers.shift();
      if (answer !== undefined && 'code' in answer) throw answer;
      return answer ?? null;
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(modeOf()).toBe('off'));
    expect(roomPaths()).toEqual(['/fake/drops/context/element-button.save-0001.md']);
    expect(toast).toHaveBeenCalledWith("Couldn't pick element: failed.");
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickStart', 'pickCancel']);
  });

  it('размер вьюпорта вкладки — пометка в файле элемента: Mobile M, emulated', async () => {
    roomWork();
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setPickResult(PICK);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(roomPaths()).toHaveLength(1));
    const saved = bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0] as { markdown: string } | undefined;
    expect(saved?.markdown).toContain('Mobile M, emulated');
  });

  it('режим annotate выбор не запускает; ⌖ в этом режиме заменяет annotate на select — тогда pickStart', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    act(() => useBrowserStore.getState().update(TAB, { mode: 'annotate' }));
    expect(bridge.pickCalls).toEqual([]);
    const button = screen.getByRole('button', { name: 'Select' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(modeOf()).toBe('select');
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart']);
  });

  it('pickStart ответил null (Esc в странице) — режим снят, файла нет', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(modeOf()).toBe('off'));
    expect(bridge.browserCalls.filter((call) => call.method === 'saveContext')).toEqual([]);
  });

  it('повторный ⌖ и Esc в окне во время выбора — pickCancel, режим снят; кнопка подсвечена только в режиме', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    // Настоящий выбор ждёт клика человека: промис не разрешается сам.
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    const button = screen.getByRole('button', { name: 'Select' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(modeOf()).toBe('select');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
    expect(modeOf()).toBe('off');

    await act(async () => {
      fireEvent.click(button);
    });
    expect(modeOf()).toBe('select');
    await act(async () => {
      fireEvent.keyDown(button, { key: 'Escape' });
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel', 'pickStart', 'pickCancel']);
    expect(modeOf()).toBe('off');
  });

  it('Esc, закрывший меню «To», Select не выключает: меню закрыто, режим прежний, pickCancel не уходит; следующий Esc вне меню — выключает', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    expect(modeOf()).toBe('select');

    const to = screen.getByRole('button', { name: /^To:/ });
    fireEvent.keyDown(to, { key: 'Enter' });
    const menu = screen.getByRole('menu');
    // Меню Radix лежит в портале, но по дереву React его события доходят до корня поверхности: Esc закрывает меню и
    // помечен preventDefault — на режим он не действует.
    await act(async () => {
      fireEvent.keyDown(within(menu).getAllByRole('menuitem')[0] as HTMLElement, { key: 'Escape' });
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(modeOf()).toBe('select');
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart']);

    // Esc вне меню по-прежнему выключает режим.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Select' }), { key: 'Escape' });
    });
    expect(modeOf()).toBe('off');
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
  });

  it('Esc в полосе поиска закрывает только её: Select остаётся включённым, pickCancel не уходит', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    act(() => useBrowserStore.getState().update(TAB, { findOpen: true }));
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText('Find…'), { key: 'Escape' });
    });
    expect(useBrowserStore.getState().tabs[TAB]?.findOpen).toBe(false);
    expect(modeOf()).toBe('select');
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart']);
  });

  it("отказ { code: failed } — тост Couldn't pick element: failed. и режим снят", async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setPickResult({ code: 'failed', message: 'boom' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(modeOf()).toBe('off'));
    expect(toast).toHaveBeenCalledWith("Couldn't pick element: failed.");
  });

  it('did-navigate во время выбора — режим снят; поздний ответ файла не добавляет', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    fire(view, 'dom-ready');
    let answer: (value: PickResult | null) => void = () => {};
    bridge.browser.pickStart = () => new Promise<PickResult | null>((resolve) => (answer = resolve));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    expect(modeOf()).toBe('select');
    fire(view, 'did-navigate', { url: 'http://localhost:5173/other' });
    expect(modeOf()).toBe('off');
    await act(async () => answer(PICK));
    expect(bridge.browserCalls.filter((call) => call.method === 'saveContext')).toEqual([]);
    expect(roomPaths()).toEqual([]);
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
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    expect(modeOf()).toBe('select');
    await act(async () => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => ({
        ...layout,
        root: { ...(layout.root as GroupNode), activeTabId: 'browser:other' },
      }));
    });
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart', 'pickCancel']);
    expect(modeOf()).toBe('off');
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

  it('⌘⇧C и ⌘⌥A с фокусом в адресной строке — Select и Annotate, как ⌘⌥I у панели (спека 4.9)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('select');
    fireEvent.keyDown(address, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('annotate');
  });

  it('удержанные ⌘⇧C и ⌘⌥A (автоповтор, event.repeat) режим не переключают: считается только первое нажатие', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('select');
    // Клавишу держат: система шлёт повторы, режим не мигает.
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, repeat: true });
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, repeat: true });
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, repeat: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('select');
    // Новое нажатие (не повтор) снимает режим, как раньше.
    fireEvent.keyDown(address, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('off');

    fireEvent.keyDown(address, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('annotate');
    fireEvent.keyDown(address, { key: 'å', code: 'KeyA', metaKey: true, altKey: true, repeat: true });
    fireEvent.keyDown(address, { key: 'å', code: 'KeyA', metaKey: true, altKey: true, repeat: true });
    fireEvent.keyDown(address, { key: 'å', code: 'KeyA', metaKey: true, altKey: true, repeat: true });
    expect(useBrowserStore.getState().tabs[TAB]?.mode).toBe('annotate');
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

  it('m4: setViewport отказал → выбор Fit в меню всё равно шлёт сброс setViewport(id, null, поле)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    const setViewport = vi.spyOn(bridge.browser, 'setViewport').mockRejectedValue({ code: 'failed', message: 'boom' });
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    expect(setViewport).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[parley] setViewport failed', { code: 'failed', message: 'boom' });
    setViewport.mockClear();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fit' }));
    await act(async () => {});
    expect(setViewport).toHaveBeenCalledWith(7, null, { width: 768, height: 548 });
    error.mockRestore();
  });

  it('m4: setViewport отказал → повторный выбор того же пресета шлёт setViewport заново; после успеха повтор снова пропускается', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    const setViewport = vi.spyOn(bridge.browser, 'setViewport').mockRejectedValue({ code: 'failed', message: 'boom' });
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    setViewport.mockClear();
    setViewport.mockResolvedValue({ scale: 1 });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    await act(async () => {});
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(setViewport).toHaveBeenCalledWith(7, MOBILE_M, { width: 768, height: 548 });
    // Теперь размер стоит: тот же выбор снова ничего не шлёт.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    await act(async () => {});
    expect(setViewport).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('m5: захват пропал — сцена без ужатой коробки и подписи, страница во всё поле; вернулся — setViewport заново и сцена снова с размером', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    bridge.setViewportScale(0.5);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    const sent = (): number => bridge.browserCalls.filter((call) => call.method === 'setViewport').length;
    expect(view.style.width).toBe('187px');
    expect(screen.getByTestId('viewport-label')).toBeTruthy();
    const before = sent();
    act(() => useDevtoolsStore.getState().batch(TAB, devtoolsBatch({ webContentsId: 7, capture: 'unavailable' })));
    await act(async () => {});
    expect(view.style.width).toBe('');
    expect(screen.queryByTestId('viewport-label')).toBeNull();
    expect(sent()).toBe(before);
    act(() => useDevtoolsStore.getState().batch(TAB, devtoolsBatch({ webContentsId: 7, capture: 'on' })));
    await act(async () => {});
    expect(sent()).toBe(before + 1);
    expect(view.style.width).toBe('187px');
    expect(screen.getByTestId('viewport-label').textContent).toContain('50%');
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

function entryWith(sessions: WorkSession[], rooms: Room[]): WorkEntry {
  const base = entry();
  return { ...base, map: { ...base.map, sessions, rooms } };
}

function browserTabSpec(): Extract<TabSpec, { kind: 'browser' }> | undefined {
  const layout = useLayoutStore.getState().layouts[WORK_KEY];
  const found = layout === undefined ? null : findTab(layout, TAB);
  const tab = found?.group.tabs[found.index];
  return tab?.kind === 'browser' ? tab : undefined;
}

describe('BrowserSurface — цель «To» (этап B, спека браузера 4.5)', () => {
  it('без поля target — умолчание: первая живая сессия; выбор комнаты пишет target в раскладку', () => {
    useWorksStore.setState({ entries: [entryWith([makeSession('s-01', 'lead')], [makeRoom('r-01', 'review')])] });
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const button = screen.getByRole('button', { name: /^To:/ });
    expect(button.textContent).toBe('To: S01');
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /review/ }));
    expect(browserTabSpec()?.target).toEqual({ kind: 'room', roomId: 'r-01' });
    expect(screen.getByRole('button', { name: /^To:/ }).textContent).toBe('To: review');
  });

  it('цель пропала (сессию удалили) — поле снято, тост об откате один раз', () => {
    vi.mocked(toast).mockClear();
    useWorksStore.setState({ entries: [entryWith([makeSession('s-01', 'lead')], [])] });
    setBrowserTab('http://localhost:5173/', { kind: 'session', sessionId: 's-09' });
    renderWork();
    expect(browserTabSpec()).toBeDefined();
    expect(browserTabSpec()?.target).toBeUndefined();
    expect(vi.mocked(toast).mock.calls.filter(([text]) => String(text).startsWith('The chosen'))).toEqual([
      ['The chosen session or room is gone — page context now goes to S01'],
    ]);
  });
});

/** Работа с одной комнатой и без сессий: цель по умолчанию — комната, вложения видны в её поле. */
function roomWork(): void {
  useWorksStore.setState({ entries: [entryWith([], [makeRoom('r-01', 'review')])] });
}

const roomPaths = (): readonly string[] => useUiStore.getState().composerAttachments[roomKey(WORK_KEY, 'r-01')] ?? [];

describe('BrowserSurface — «Add to chat» из панели (этап B, спека браузера 4.3–4.5)', () => {
  beforeEach(() => {
    resetDeliveryForTests();
    useUiStore.setState({ composerAttachments: {} });
  });

  it('строка консоли — файл console в цель «To»; «Add errors to chat» — файл errors; агенту ничего', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [consoleEntry(1, { level: 'error', text: 'boom' })], network: [] });
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    await vi.waitFor(() => expect(roomPaths()).toEqual(['/fake/drops/context/console-error-boom-0001.md']));
    fireEvent.click(screen.getByRole('button', { name: 'Add errors to chat' }));
    await vi.waitFor(() => expect(roomPaths()).toEqual(['/fake/drops/context/console-error-boom-0001.md', '/fake/drops/context/errors-page-0002.md']));
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
  });

  it('запрос в деталях Network — файл request в цель «To»; тело ответа читается у гостя своей вкладки в момент клика', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/settings');
    renderWork();
    bridge.setResponseBody({ text: '{"ok":false}', base64: false, truncated: false });
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [], network: [networkEntry('r1', { status: 500, statusText: 'Internal Server Error' })] });
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => {
      useDevtoolsStore.getState().show(TAB, 'network');
      useDevtoolsStore.getState().patch(TAB, { selected: 'r1' });
    });
    // Детали открыты, а тело ещё не читалось: оно читается по клику «Add to chat», а не заранее.
    expect(bridge.browserCalls.filter((call) => call.method === 'responseBody')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    await vi.waitFor(() => expect(roomPaths()).toEqual(['/fake/drops/context/request-get-api-r1-500-0001.md']));
    expect(bridge.browserCalls.filter((call) => call.method === 'responseBody')).toEqual([{ method: 'responseBody', args: [7, 'r1'] }]);
    // В файле — адрес страницы вкладки на момент клика и тело ответа, прочитанное у её гостя.
    const saved = bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0] as { markdown: string } | undefined;
    expect(saved?.markdown).toContain('URL: http://localhost:5173/settings');
    expect(saved?.markdown).toContain('"ok": false');
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
  });
});

const ELEMENT_PICK: AnnotationPick = {
  kind: 'element',
  key: 'a1',
  selector: 'body > button.save',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  anchor: { fx: 0.1, fy: 0.2 },
  viewport: { width: 800, height: 600, dpr: 2 },
};

describe('BrowserSurface — Annotate (этап B, спека браузера 4.7)', () => {
  beforeEach(() => {
    resetDeliveryForTests();
    useUiStore.setState({ composerAttachments: {} });
    useAnnotateStore.setState({ tabs: {} });
  });

  /** ✎, первая метка и комментарий в редакторе окна. */
  async function firstPin(comment: string): Promise<HTMLElement> {
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setAnnotatePicks([ELEMENT_PICK]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    const field = await screen.findByRole('textbox', { name: 'Comment for annotation 1' });
    fireEvent.change(field, { target: { value: comment } });
    return field;
  }

  it('✎ — метка: редактор в окне, Save — пункт в лотке, метки страницы перерисованы; режим держится', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await firstPin('make it green');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
    const tray = screen.getByTestId('annotation-tray');
    expect(tray.textContent).toContain('1 annotation');
    expect(tray.textContent).toContain('make it green');
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateSync').at(-1)?.args).toEqual([12, [{ n: 1, key: 'a1' }]]);
    expect(modeOf()).toBe('annotate');
    await vi.waitFor(() => expect(bridge.browserCalls.filter((call) => call.method === 'annotateStart')).toHaveLength(2));
  });

  it('Esc в редакторе новой метки — метки и лотка нет, режим держится', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await firstPin('');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    expect(screen.queryByTestId('annotation-tray')).toBeNull();
    expect(modeOf()).toBe('annotate');
  });

  it('Select и Annotate взаимоисключающие: ⌖ во время ✎ — annotateCancel и pickStart', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.browser.pickStart = async (webContentsId) => {
      bridge.pickCalls.push({ method: 'pickStart', webContentsId });
      return new Promise<PickResult | null>(() => {});
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    expect(modeOf()).toBe('annotate');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    expect(modeOf()).toBe('select');
    expect(bridge.browserCalls.some((call) => call.method === 'annotateCancel')).toBe(true);
    expect(bridge.pickCalls.map((call) => call.method)).toEqual(['pickStart']);
  });

  it('«Add to chat» в лотке — файл annotations со снимком в цель «To»; лоток пуст', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await firstPin('make it green');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Add to chat' }));
    });
    await vi.waitFor(() => expect(roomPaths()).toEqual(['/fake/drops/context/annotations-page-0001.md']));
    expect(bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0]).toMatchObject({ kind: 'annotations', imagePath: '/fake/drops/annotate.png' });
    expect(screen.queryByTestId('annotation-tray')).toBeNull();
  });

  it('новый документ — пункты лотка «element gone», данные на месте', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await firstPin('make it green');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    const view = webview();
    if (view === null) throw new Error('нет <webview>');
    fire(view, 'did-navigate', { url: 'http://localhost:5173/other' });
    expect(modeOf()).toBe('off');
    expect(screen.getByTestId('annotation-tray').textContent).toContain('element gone');
  });

  it('метка, новый документ, ещё метка, «Add to chat»: файл называет страницу первой метки, её пункт не оживает, на страницу уходит только новая метка', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/settings');
    renderWork();
    const first = await firstPin('make it green');
    await act(async () => {
      fireEvent.keyDown(first, { key: 'Enter' });
    });
    const view = webview();
    if (view === null) throw new Error('нет <webview>');
    fire(view, 'did-navigate', { url: 'http://localhost:5173/profile' });
    expect(modeOf()).toBe('off');
    // Скрипт меток нового документа нумерует с a1 заново — ключ тот же, что у первой метки.
    bridge.setAnnotatePicks([{ ...ELEMENT_PICK, selector: 'body > a.next' }]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    const second = await screen.findByRole('textbox', { name: 'Comment for annotation 2' });
    fireEvent.change(second, { target: { value: 'and this link' } });
    await act(async () => {
      fireEvent.keyDown(second, { key: 'Enter' });
    });
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateSync').at(-1)?.args).toEqual([12, [{ n: 2, key: 'a1' }]]);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Add to chat' }));
    });
    await vi.waitFor(() => expect(roomPaths()).toHaveLength(1));
    const { markdown } = bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0] as { markdown: string };
    expect(markdown).toContain('URL: http://localhost:5173/profile\n');
    expect(markdown).toContain(
      '## 1. button.save\n> make it green\n(The element is gone from the page; it is not on the screenshot.)\n\n```text\nMarked on: http://localhost:5173/settings\nSelector: body > button.save\n',
    );
    expect(markdown).toContain('## 2. a.next\n> and this link\n\n```text\nSelector: body > a.next\n');
  });
});

describe('BrowserSurface — Annotate: заметки отчётов задач 20-22 (этап B, задача 23)', () => {
  beforeEach(() => {
    resetDeliveryForTests();
    useUiStore.setState({ composerAttachments: {} });
    useAnnotateStore.setState({ tabs: {} });
  });

  /** ✎ и первая метка: редактор открыт, в поле набрано `comment` (Enter не нажат). */
  async function markWith(comment: string, picks: AnnotationPick[] = [ELEMENT_PICK]): Promise<HTMLElement> {
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setAnnotatePicks(picks);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    const field = await screen.findByRole('textbox', { name: 'Comment for annotation 1' });
    fireEvent.change(field, { target: { value: comment } });
    return field;
  }

  const cancels = (): number => bridge.browserCalls.filter((call) => call.method === 'annotateCancel').length;

  it('редактор и лоток — внутри поля страницы (browser-field): редактор рисуется в его слое, а не в body', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    await markWith('x');
    const fieldBox = screen.getByTestId('browser-field');
    expect(fieldBox.contains(screen.getByTestId('annotation-editor'))).toBe(true);
    expect(fieldBox.contains(screen.getByTestId('annotation-tray'))).toBe(true);
    expect(fieldBox.contains(screen.getByTestId('annotation-anchor'))).toBe(true);
  });

  it('Esc вне открытого редактора (на заголовке лотка) ничего не отменяет: редактор владеет Esc, режим держится; Esc в самом поле — отмена новой метки', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await markWith('typed');
    const header = within(screen.getByTestId('annotation-tray')).getAllByRole('button')[0] as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(header, { key: 'Escape' });
    });
    expect(screen.getByTestId('annotation-editor')).toBeTruthy();
    expect(modeOf()).toBe('annotate');
    expect(cancels()).toBe(0);
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
    expect(screen.queryByTestId('annotation-tray')).toBeNull();
    expect(modeOf()).toBe('annotate');
  });

  it('редактор закрыт (Save): фокус упавшего поля возвращается странице — ⌘⌥A и Esc продолжают приходить', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = webview();
    if (view === null) throw new Error('нет <webview>');
    const focus = vi.spyOn(view, 'focus');
    const field = await markWith('x');
    expect(document.activeElement).toBe(field);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(document.activeElement).toBe(document.body);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('лоток исчез вместе с кнопкой, державшей фокус («Add to chat»): фокус падает на body — страница получает его назад', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = webview();
    if (view === null) throw new Error('нет <webview>');
    const focus = vi.spyOn(view, 'focus');
    const field = await markWith('x');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    focus.mockClear();
    const add = within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Add to chat' });
    act(() => add.focus());
    expect(document.activeElement).toBe(add);
    await act(async () => {
      fireEvent.click(add);
    });
    await vi.waitFor(() => expect(screen.queryByTestId('annotation-tray')).toBeNull());
    expect(document.activeElement).toBe(document.body);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('редактор закрыт, а фокус уже у адресной строки — страница фокус не забирает', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = webview();
    if (view === null) throw new Error('нет <webview>');
    const focus = vi.spyOn(view, 'focus');
    await markWith('x');
    const address = screen.getByRole('textbox', { name: 'Address' });
    act(() => address.focus());
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-editor')).getByRole('button', { name: 'Save' }));
    });
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
    expect(document.activeElement).toBe(address);
    expect(focus).not.toHaveBeenCalled();
  });

  it('✎ в лотке: положение метки обновляется до редактора — он открывается у свежего места (N1 задачи 21)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await markWith('first');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(useAnnotateStore.getState().tabs[TAB]?.items[0]?.rect).toMatchObject({ x: 0.1, y: 0.1 });
    // Страницу прокрутили, пока человек читал лоток: метка теперь в другом месте.
    bridge.setAnnotatePositions([{ n: 1, rect: { x: 0.5, y: 0.6, width: 0.2, height: 0.05 } }]);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Edit annotation 1' }));
    });
    await screen.findByTestId('annotation-editor');
    expect(useAnnotateStore.getState().tabs[TAB]?.editing?.anchor).toEqual({ fx: 0.5, fy: 0.6 });
  });

  it('набранное в редакторе не теряется, что бы человек ни нажал в лотке: ✎ и корзина другого пункта сохраняют его (N3 задачи 21)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    // Обе метки в очереди сразу: цикл просит вторую, как только закрыт редактор первой.
    const first = await markWith('one', [ELEMENT_PICK, { ...ELEMENT_PICK, key: 'a2', selector: 'body > a.next' }]);
    await act(async () => {
      fireEvent.keyDown(first, { key: 'Enter' });
    });
    const second = await screen.findByRole('textbox', { name: 'Comment for annotation 2' });
    fireEvent.change(second, { target: { value: 'two, typed' } });
    const tray = screen.getByTestId('annotation-tray');
    await act(async () => {
      fireEvent.click(within(tray).getByRole('button', { name: 'Edit annotation 1' }));
    });
    await screen.findByRole('textbox', { name: 'Comment for annotation 1' });
    expect(useAnnotateStore.getState().tabs[TAB]?.items.map((item) => item.comment)).toEqual(['one', 'two, typed']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment for annotation 1' }), { target: { value: 'one, retyped' } });
    await act(async () => {
      fireEvent.click(within(tray).getByRole('button', { name: 'Delete annotation 2' }));
    });
    expect(useAnnotateStore.getState().tabs[TAB]?.items.map((item) => item.comment)).toEqual(['one, retyped']);
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
  });

  it('«Add to chat» с набранным, но не сохранённым комментарием: он в файле, «(no comment)» нет (N3 задачи 21)', async () => {
    roomWork();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    await markWith('typed, not saved');
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Add to chat' }));
    });
    await vi.waitFor(() => expect(roomPaths()).toHaveLength(1));
    const { markdown } = bridge.browserCalls.find((call) => call.method === 'saveContext')?.args[0] as { markdown: string };
    expect(markdown).toContain('> typed, not saved');
    expect(markdown).not.toContain('(no comment)');
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
  });

  it('did-navigate во время Annotate: режим снят и странице уходит annotateCancel (заметка задачи 20)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 12);
    fire(view, 'dom-ready');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    expect(modeOf()).toBe('annotate');
    expect(cancels()).toBe(0);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/other' });
    expect(modeOf()).toBe('off');
    expect(cancels()).toBe(1);
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateCancel').at(-1)?.args).toEqual([12]);
  });

  it('страница ответила null (Esc в странице, начатый переход): режим снят и annotateCancel уходит — страница не остаётся взведённой (заметка задачи 20)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    bridge.setAnnotatePicks([null]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    });
    await vi.waitFor(() => expect(modeOf()).toBe('off'));
    expect(cancels()).toBe(1);
  });

  it('фокус страницы не трогается, пока редактора не было: монтирование, dom-ready, метка в лотке', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      setBrowserTab('http://localhost:5173/');
      renderWork();
      const field = await markWith('x');
      const onPage = (): boolean => focus.mock.contexts.some((element) => (element as HTMLElement).tagName === 'WEBVIEW');
      expect(onPage()).toBe(false);
      await act(async () => {
        fireEvent.keyDown(field, { key: 'Enter' });
      });
      // Редактор закрыт — вот теперь страница получает фокус назад.
      expect(onPage()).toBe(true);
    } finally {
      focus.mockRestore();
    }
  });

  /** Перерисовки меток страницы с отметкой «редактор ещё на экране»: так видно, кто их попросил — обработчик или эффект после рендера. */
  function watchSyncs(): Array<{ pins: unknown[]; editorMounted: boolean }> {
    const seen: Array<{ pins: unknown[]; editorMounted: boolean }> = [];
    const original = bridge.browser.annotateSync;
    bridge.browser.annotateSync = async (webContentsId, pins) => {
      seen.push({ pins, editorMounted: document.querySelector('[data-testid="annotation-editor"]') !== null });
      return original(webContentsId, pins);
    };
    return seen;
  }

  it('Esc новой метки: страницу просят перерисоваться сразу, из обработчика, а не только после рендера (замечание 1 задачи 21)', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await markWith('');
    const seen = watchSyncs();
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    expect(seen.some((call) => call.pins.length === 0 && call.editorMounted)).toBe(true);
    expect(seen.at(-1)?.pins).toEqual([]);
  });

  it('Delete в редакторе новой метки — та же отмена: перерисовка из обработчика', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    await markWith('typed');
    const seen = watchSyncs();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-editor')).getByRole('button', { name: 'Delete' }));
    });
    expect(screen.queryByTestId('annotation-tray')).toBeNull();
    expect(seen.some((call) => call.pins.length === 0 && call.editorMounted)).toBe(true);
  });

  it('✎ в лотке, а вкладку закрыли, пока шла перерисовка: редактор не открывается и записи лотка не появляется', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await markWith('x');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    let answer: (positions: AnnotationPosition[]) => void = () => {};
    bridge.browser.annotateSync = () => new Promise<AnnotationPosition[]>((resolve) => (answer = resolve));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('annotation-tray')).getByRole('button', { name: 'Edit annotation 1' }));
    });
    cleanup();
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
    await act(async () => answer([{ n: 1, rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }]));
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });

  it('закрытие вкладки — лоток убран', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const field = await markWith('x');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(useAnnotateStore.getState().tabs[TAB]).toBeDefined();
    cleanup();
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });
});

const OTHER = 'browser:other';

/** Поверхность вкладки целиком: у каждой своя строка, свои кнопки и своё поле страницы. */
function surfaceOf(tabId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-surface-layer] [data-tab-id="${tabId}"]`);
  if (node === null) throw new Error(`нет поверхности ${tabId}`);
  return node;
}

describe('BrowserSurface — Annotate: редактор скрытой вкладки (ревью задачи 23, I1)', () => {
  beforeEach(() => {
    resetDeliveryForTests();
    useUiStore.setState({ composerAttachments: {} });
    useAnnotateStore.setState({ tabs: {} });
  });

  /** Вторая вкладка браузера в группе первой: пока активна одна, поверхность другой смонтирована, но скрыта. */
  function renderTwoTabs(): void {
    setBrowserTab('http://localhost:5173/');
    act(() =>
      useLayoutStore.getState().apply(WORK_KEY, (layout) => {
        const root = layout.root as GroupNode;
        return { ...layout, root: { ...root, tabs: [...root.tabs, { kind: 'browser', id: OTHER, url: 'http://localhost:5173/other' }] } };
      }),
    );
    renderWork();
    fire(arm(webview(), 12), 'dom-ready');
    fire(arm(document.querySelector<FakeWebview>(`[data-surface-layer] [data-tab-id="${OTHER}"] webview`), 13), 'dom-ready');
  }

  const showTab = (tabId: string): Promise<void> =>
    act(async () => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => ({ ...layout, root: { ...(layout.root as GroupNode), activeTabId: tabId } }));
    });

  /** В первой вкладке открыт редактор с набранным, но не сохранённым комментарием; человек перешёл на вторую. */
  async function leaveDraftInFirstTab(): Promise<void> {
    renderTwoTabs();
    bridge.setAnnotatePicks([ELEMENT_PICK]);
    await act(async () => {
      fireEvent.click(within(surfaceOf(TAB)).getByRole('button', { name: 'Annotate' }));
    });
    const field = await screen.findByRole('textbox', { name: 'Comment for annotation 1' });
    fireEvent.change(field, { target: { value: 'half-typed' } });
    await showTab(OTHER);
  }

  it('черновик в скрытой вкладке не гасит Esc видимой: слой Radix скрытого редактора каждый Esc окна помечал бы preventDefault, и ✎ второй вкладки Esc не выключал бы', async () => {
    await leaveDraftInFirstTab();
    // Черновик первой вкладки открыт (в сторе), а видна вторая.
    expect(useAnnotateStore.getState().tabs[TAB]?.editing).not.toBeNull();
    const annotate = within(surfaceOf(OTHER)).getByRole('button', { name: 'Annotate' });
    await act(async () => {
      fireEvent.click(annotate);
    });
    expect(useBrowserStore.getState().tabs[OTHER]?.mode).toBe('annotate');
    await act(async () => {
      fireEvent.keyDown(annotate, { key: 'Escape' });
    });
    expect(useBrowserStore.getState().tabs[OTHER]?.mode).toBe('off');
  });

  it('P1: лоток скрытой вкладки не заявляет отступ тостам; вернулись — заявил над своим верхом; ушли — снял', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const own = this.dataset.testid === 'annotation-tray' ? { left: 1040, right: 1360, top: 700 } : { left: 0, right: 0, top: 0 };
      return { ...own, bottom: own.top + 188, width: own.right - own.left, height: 188, x: own.left, y: own.top, toJSON: () => ({}) } as DOMRect;
    });
    const inset = (): string => document.documentElement.style.getPropertyValue(TOAST_INSET_VAR);
    try {
      await leaveDraftInFirstTab();
      // Лоток первой вкладки в DOM (скрыт вместе с поверхностью), а тостам он не мешает.
      expect(useAnnotateStore.getState().tabs[TAB]?.items).toHaveLength(1);
      expect(inset()).toBe('');
      await showTab(TAB);
      // Верх лотка 700 при окне 900: 900 − 700 + зазор 8 − база 2.5rem (40) = 168.
      expect(inset()).toBe('168px');
      await showTab(OTHER);
      expect(inset()).toBe('');
    } finally {
      vi.restoreAllMocks();
      document.documentElement.style.removeProperty(TOAST_INSET_VAR);
    }
  });

  it('скрытая вкладка: редактора в окне нет, набранное в сторе; вернулись — редактор и набранное на месте, Save кладёт комментарий в лоток', async () => {
    await leaveDraftInFirstTab();
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
    expect(useAnnotateStore.getState().tabs[TAB]?.editing).toMatchObject({ n: 1, isNew: true, draft: 'half-typed' });
    await showTab(TAB);
    const field = (await screen.findByRole('textbox', { name: 'Comment for annotation 1' })) as HTMLTextAreaElement;
    expect(field.value).toBe('half-typed');
    expect(useAnnotateStore.getState().tabs[TAB]?.items).toHaveLength(1);
    fireEvent.change(field, { target: { value: 'half-typed, finished' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(screen.queryByTestId('annotation-editor')).toBeNull();
    expect(useAnnotateStore.getState().tabs[TAB]?.items.map((item) => item.comment)).toEqual(['half-typed, finished']);
  });
});
