/**
 * Панель браузера хозяина в слое поверхностей работы (спека браузера 3.10, 4.11; этап B2, часть 1): страницы живут в слое,
 * а видимость и место дают вид хозяина (участок панели) и раскладка. Слой монтируется отдельно от `LayoutView`: вид хозяина
 * здесь — запись в сторе окна (`mountHost`), как её делает `PanelHost`.
 *
 * `<webview>` в jsdom — неизвестный элемент без методов: тест навешивает на него подставные `getWebContentsId` и прочее и шлёт
 * события руками (как в `BrowserSurface.test.tsx`).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { AGENT_LIMITS } from '@parley/protocol';
import type { PickResult } from '../../../shared/browser-types.js';
import type { BrowserOwner, WorkLayout } from '../../../shared/layout-types.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { addPanelPage, closePanelPage, panelOf, setPanelOpen } from '../../layout/panels.js';
import { useLayoutStore } from '../../layout/store.js';
import { SurfaceLayer } from '../../layout/SurfaceLayer.js';
import { emptyLayout } from '../../layout/tree.js';
import { roomKey } from '../../lib/room-view.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { resetAgentActivity } from '../agent-activity.js';
import { useAnnotateStore } from '../annotate/store.js';
import { resetDeliveryForTests } from '../context/deliver.js';
import { useDevtoolsStore } from '../devtools/store.js';
import { requestAddressFocus, toggleBrowserMode, useBrowserStore } from '../store.js';
import { panelAnchor } from './anchor.js';
import { resetAgentRegistry } from './agent-registry.js';
import { panelRuntimeKey, usePanelRuntime } from './runtime.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const WORK_KEY = '/tmp/proj w-01';
const CHAT: BrowserOwner = { kind: 'session', sessionId: 's-01' };
const ROOM: BrowserOwner = { kind: 'room', roomId: 'r-02' };
const P1 = 'bp-000001';
const P2 = 'bp-000002';

let bridge: FakeBridge;

interface FakeWebview extends HTMLElement {
  getWebContentsId: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
}

/** Раскладка с панелью `owner` из страниц `urls` (id `bp-00000N`), открытая или закрытая; активна последняя. */
function setPanel(owner: BrowserOwner, urls: string[], open = true): void {
  let layout: WorkLayout = emptyLayout();
  urls.forEach((url, i) => {
    layout = addPanelPage(layout, owner, { id: `bp-00000${i + 1}`, url }).layout;
  });
  if (!open) layout = setPanelOpen(layout, owner, false);
  useLayoutStore.setState({ activeWorkKey: WORK_KEY, layouts: { [WORK_KEY]: layout }, hydrated: { [WORK_KEY]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
}

/** Вид хозяина на экране — запись, которую делает `PanelHost`. */
function showHost(owner: BrowserOwner, narrow = false): void {
  act(() => usePanelRuntime.getState().mountHost(panelRuntimeKey(WORK_KEY, owner), narrow));
}

function renderLayer(active = true): ReturnType<typeof render> {
  return render(<SurfaceLayer workKey={WORK_KEY} active={active} bridge={bridge} fontFamily="Menlo" fontSize={13} sendDeps={{ bridge, session: () => null, openSession: vi.fn() }} />);
}

const root = (): HTMLElement => screen.getByTestId('browser-panel');
const surface = (pageId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-surface-layer] [data-tab-id="${pageId}"]`);
const webview = (pageId: string): FakeWebview | null => document.querySelector<FakeWebview>(`[data-surface-layer] [data-tab-id="${pageId}"] webview`);

function arm(view: FakeWebview | null, webContentsId = 7): FakeWebview {
  if (view === null) throw new Error('нет <webview>');
  Object.assign(view, {
    getWebContentsId: vi.fn(() => webContentsId),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
  });
  return view;
}

function fire(view: HTMLElement, type: string, fields: Record<string, unknown> = {}): void {
  act(() => {
    view.dispatchEvent(Object.assign(new Event(type), fields));
  });
}

const panelNow = (owner: BrowserOwner = CHAT): ReturnType<typeof panelOf> => panelOf(useLayoutStore.getState().layouts[WORK_KEY] as WorkLayout, owner);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  resetAgentRegistry();
  resetAgentActivity();
  resetDeliveryForTests();
  vi.mocked(toast).mockClear();
  useWorksStore.setState({
    entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-01', 'lead')], rooms: [makeRoom('r-01', 'review'), makeRoom('r-02', 'other')] })],
    branches: {},
    loading: false,
    error: null,
  });
  usePanelRuntime.setState({ hosts: {}, usedAt: {}, published: {}, live: new Set() });
  useUiStore.setState({ composerAttachments: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useBrowserStore.setState({ tabs: {}, limitToasted: {} });
  useDevtoolsStore.setState({ tabs: {} });
  useAnnotateStore.setState({ tabs: {} });
  useUiStore.setState({ ui: DEFAULT_UI, composerAttachments: {} });
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
});

describe('PanelSurface — место и видимость', () => {
  it('открытая панель при виде хозяина на экране: полоска и страницы, видна только активная; остальные скрыты и inert', () => {
    setPanel(CHAT, ['http://localhost:3000/', 'http://localhost:3001/']);
    showHost(CHAT);
    renderLayer();
    expect(root().style.visibility).toBe('visible');
    expect(root().hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('browser-panel-owner').textContent).toBe('S01 lead');
    expect(surface(P2)?.style.visibility).toBe('visible');
    expect(surface(P2)?.hasAttribute('inert')).toBe(false);
    expect(surface(P1)?.style.visibility).toBe('hidden');
    expect(surface(P1)?.hasAttribute('inert')).toBe(true);
    // Обе `<webview>` живы: переключение страниц в полоске их не перезагружает.
    expect(webview(P1)).not.toBeNull();
    expect(webview(P2)).not.toBeNull();
  });

  it('корень встаёт якорем на участок панели своего хозяина', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    // Значения с `anchor()` и `anchor-size()` (запасные размеры скрытой панели) jsdom не принимает — их держит E2E.
    expect(root().style.getPropertyValue('position-anchor')).toBe(panelAnchor(WORK_KEY, CHAT, 'area'));
  });

  it('вид хозяина не на экране: панель скрыта и inert, но страницы живы и не выгружены', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    renderLayer();
    expect(root().style.visibility).toBe('hidden');
    expect(root().hasAttribute('inert')).toBe(true);
    expect(webview(P1)).not.toBeNull();
  });

  it('панель закрыта — скрыта, страница жива; работа неактивна — тоже скрыта', () => {
    setPanel(CHAT, ['http://localhost:3000/'], false);
    showHost(CHAT);
    renderLayer();
    expect(root().style.visibility).toBe('hidden');
    expect(webview(P1)).not.toBeNull();
    cleanup();
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer(false);
    expect(root().style.visibility).toBe('hidden');
    expect(webview(P1)).not.toBeNull();
  });

  it('узкий вид хозяина: в полоске «Back to chat»', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT, true);
    renderLayer();
    expect(screen.getByTestId('browser-panel-back').textContent).toBe('Back to chat');
  });

  it('слой работы публикует панели: видимая — живая; уход слоя снимает публикацию', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    const { unmount } = renderLayer();
    expect(usePanelRuntime.getState().live.has(panelRuntimeKey(WORK_KEY, CHAT))).toBe(true);
    unmount();
    expect(usePanelRuntime.getState().published[WORK_KEY]).toBeUndefined();
    expect(usePanelRuntime.getState().live.size).toBe(0);
  });
});

describe('PanelSurface — предел живых панелей (спека браузера 8)', () => {
  it('панель вне предела не монтирует страницу и помнит адрес; вернулось место — страница грузится заново', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setPanel(CHAT, ['http://localhost:3000/'], false);
    renderLayer();
    expect(webview(P1)).not.toBeNull();
    // Шесть других панелей окна появились позже и свежее: наша, закрытая и давняя, выгружается.
    vi.setSystemTime(2_000);
    act(() => usePanelRuntime.getState().publish('other', Array.from({ length: 6 }, (_, i) => ({ key: `other/${i}`, visible: false }))));
    expect(screen.queryByTestId('browser-panel')).toBeNull();
    expect(webview(P1)).toBeNull();
    // Раскладка адрес помнит.
    expect(panelNow()?.pages[0]?.url).toBe('http://localhost:3000/');
    act(() => usePanelRuntime.getState().retract('other'));
    expect(webview(P1)).not.toBeNull();
    vi.useRealTimers();
  });

  it('видимая панель живёт при любом числе других', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    vi.setSystemTime(2_000);
    act(() => usePanelRuntime.getState().publish('other', Array.from({ length: 9 }, (_, i) => ({ key: `other/${i}`, visible: false }))));
    expect(webview(P1)).not.toBeNull();
    expect(root().style.visibility).toBe('visible');
    vi.useRealTimers();
  });
});

/** Записи реестра без `hello`: поколение документа в тесте любое. */
const registrations = (): unknown[] => bridge.browserCalls.filter((call) => call.method === 'registerTab').map((call) => call.args[0]).filter((e) => (e as { kind: string }).kind !== 'hello');
const PAGE_REG = { kind: 'page', generation: expect.any(String) };

describe('PanelSurface — реестр страниц для агента (этап C)', () => {
  it('монтирование — без гостя, dom-ready — с id гостя, повтор не шлётся; уход вида хозяина с экрана — запись «невидима»', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    const view = arm(webview(P1), 7);
    expect(registrations()).toEqual([{ ...PAGE_REG, webContentsId: null, workKey: WORK_KEY, owner: CHAT, pageId: P1, visible: true }]);
    fire(view, 'dom-ready');
    expect(registrations().at(-1)).toEqual({ ...PAGE_REG, webContentsId: 7, workKey: WORK_KEY, owner: CHAT, pageId: P1, visible: true });
    expect(registrations()).toHaveLength(2);
    act(() => usePanelRuntime.getState().unmountHost(panelRuntimeKey(WORK_KEY, CHAT)));
    // Вид хозяина ушёл с экрана — страница невидима человеку (гость, если он ещё жив, main проверит сам).
    expect(registrations().at(-1)).toMatchObject({ pageId: P1, visible: false });
  });

  it('размонтирование, пока страница в раскладке, — запись без гостя; закрытую страницу размонтирование не воскрешает', () => {
    setPanel(CHAT, ['http://localhost:3000/', 'http://localhost:3001/']);
    showHost(CHAT);
    const { unmount } = renderLayer();
    fire(arm(webview(P1), 7), 'dom-ready');
    fire(arm(webview(P2), 8), 'dom-ready');
    act(() => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => closePanelPage(layout, CHAT, P2));
    });
    const before = registrations().length;
    unmount();
    const added = registrations().slice(before);
    expect(added).toEqual([{ ...PAGE_REG, webContentsId: null, workKey: WORK_KEY, owner: CHAT, pageId: P1, visible: false }]);
  });

  it('пауза панели: data-agents-paused на корне, «Pause agents» пишет её в раскладку, «Resume agents» снимает', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    fire(arm(webview(P1), 7), 'dom-ready');
    expect(root().getAttribute('data-agents-paused')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause agents' }));
    expect(panelNow()?.paused).toBe(true);
    expect(root().getAttribute('data-agents-paused')).toBe('true');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume agents' }));
    expect(panelNow()?.paused).toBeUndefined();
  });
});

describe('PanelSurface — снимок агента на странице (этап C, спека 4.8; спайк 0.2)', () => {
  const activity = (phase: 'start' | 'end', webContentsId: number, capture?: { width: number; height: number; id?: string }): void =>
    act(() => bridge.emitAgentActivity({ webContentsId, session: 'S02', op: 'screenshot', phase, ...(capture === undefined ? {} : { capture: { id: 'c1', ...capture } }) }));

  it('start с capture своей страницы — «Agent capture 375×812»; end — подписи нет; чужая страница и start без capture не трогают', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    fire(arm(webview(P1), 7), 'dom-ready');
    activity('start', 9, { width: 375, height: 812 });
    activity('start', 7);
    expect(screen.queryByTestId('agent-capture')).toBeNull();
    activity('start', 7, { width: 375, height: 812 });
    expect(screen.getByTestId('agent-capture').textContent).toBe('Agent capture 375×812');
    activity('end', 7);
    expect(screen.queryByTestId('agent-capture')).toBeNull();
  });

  it('невидимая страница на время start с capture: visibility: visible, opacity: 0, pointer-events: none; на end — снова hidden', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    renderLayer();
    fire(arm(webview(P1), 7), 'dom-ready');
    const page = surface(P1) as HTMLElement;
    expect(page.style.visibility).toBe('hidden');
    activity('start', 7, { width: 1280, height: 800 });
    expect([page.style.visibility, page.style.opacity, page.style.pointerEvents]).toEqual(['visible', '0', 'none']);
    expect(screen.queryByTestId('agent-capture')).toBeNull();
    activity('end', 7);
    expect(page.style.visibility).toBe('hidden');
  });

  /** Кадры окна под управлением теста: `frame()` исполняет все ждущие `requestAnimationFrame`. */
  function stubFrames(): { frame(): void } {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      next += 1;
      queue.set(next, callback);
      return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => void queue.delete(handle));
    return {
      frame: () =>
        act(() => {
          const due = [...queue.entries()];
          queue.clear();
          for (const [, callback] of due) callback(0);
        }),
    };
  }
  const readyCalls = (): unknown[][] => bridge.browserCalls.filter((call) => call.method === 'agentCaptureReady').map((call) => call.args);

  it('start с capture: <webview> получает left 0, top 0, width и height снимка; после двух кадров — agentCaptureReady(id); end возвращает прежний вид', () => {
    const frames = stubFrames();
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    const view = arm(webview(P1), 7);
    fire(view, 'dom-ready');
    expect(view.style.width).toBe('');
    expect(view.className).not.toContain('absolute');
    activity('start', 7, { width: 1440, height: 900, id: 'c-77' });
    expect([view.style.left, view.style.top, view.style.width, view.style.height]).toEqual(['0px', '0px', '1440px', '900px']);
    expect(view.className).toContain('absolute');
    // Узел тот же: гость не перезагружается.
    expect(webview(P1)).toBe(view);
    expect(readyCalls()).toEqual([]);
    frames.frame();
    expect(readyCalls()).toEqual([]);
    frames.frame();
    expect(readyCalls()).toEqual([['c-77']]);
    frames.frame();
    expect(readyCalls()).toEqual([['c-77']]);
    activity('end', 7);
    expect(view.style.width).toBe('');
    expect(view.className).not.toContain('absolute');
  });

  it('смена webContentsId сбрасывает capture: размер снимка снят, подтверждения нет', () => {
    const frames = stubFrames();
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    const view = arm(webview(P1), 7);
    fire(view, 'dom-ready');
    activity('start', 7, { width: 1440, height: 900, id: 'c-1' });
    expect(view.style.width).toBe('1440px');
    view.getWebContentsId.mockReturnValue(8);
    fire(view, 'dom-ready');
    expect(view.style.width).toBe('');
    frames.frame();
    frames.frame();
    expect(readyCalls()).toEqual([]);
  });

  it('без end capture снимается сторожем через AGENT_LIMITS.opMs', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      stubFrames();
      setPanel(CHAT, ['http://localhost:3000/']);
      showHost(CHAT);
      renderLayer();
      const view = arm(webview(P1), 7);
      fire(view, 'dom-ready');
      activity('start', 7, { width: 1440, height: 900, id: 'c-2' });
      act(() => void vi.advanceTimersByTime(AGENT_LIMITS.opMs - 1));
      expect(view.style.width).toBe('1440px');
      act(() => void vi.advanceTimersByTime(2));
      expect(view.style.width).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('окно в фоне кадров не рисует: подтверждение уходит по запасному таймеру', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      stubFrames();
      setPanel(CHAT, ['http://localhost:3000/']);
      showHost(CHAT);
      renderLayer();
      fire(arm(webview(P1), 7), 'dom-ready');
      activity('start', 7, { width: 1440, height: 900, id: 'c-3' });
      expect(readyCalls()).toEqual([]);
      act(() => void vi.advanceTimersByTime(300));
      expect(readyCalls()).toEqual([['c-3']]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PanelSurface — страница панели как браузер', () => {
  it('адрес перехода и размер из меню пишутся в страницу панели, а не во вкладку', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    const view = arm(webview(P1), 11);
    fire(view, 'dom-ready');
    fire(view, 'did-navigate', { url: 'http://localhost:3000/docs' });
    expect(panelNow()?.pages[0]?.url).toBe('http://localhost:3000/docs');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    expect(panelNow()?.pages[0]).toEqual({ id: P1, url: 'http://localhost:3000/docs', viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    // Адрес с паролем в раскладку не идёт: как у вкладки.
    fire(view, 'did-navigate', { url: 'http://user:secret@localhost:3000/p' });
    expect(panelNow()?.pages[0]?.url).toBe('http://localhost:3000/p');
    fire(view, 'did-navigate', { url: 'file:///etc/hosts' });
    expect(panelNow()?.pages[0]?.url).toBe('http://localhost:3000/p');
  });

  it('новая пустая страница: заглушка вместо `<webview>`, адресная строка в фокусе; адрес из строки встаёт в страницу панели', () => {
    setPanel(CHAT, ['']);
    requestAddressFocus(P1);
    showHost(CHAT);
    renderLayer();
    expect(webview(P1)).toBeNull();
    expect(screen.getByTestId('browser-placeholder')).toBeTruthy();
    const address = screen.getByRole('textbox', { name: 'Address' });
    expect(document.activeElement).toBe(address);
    fireEvent.change(address, { target: { value: 'localhost:5173/app' } });
    fireEvent.keyDown(address, { key: 'Enter' });
    expect(panelNow()?.pages[0]?.url).toBe('http://localhost:5173/app');
    expect(webview(P1)).not.toBeNull();
  });

  it('меню «To» в строке страницы панели нет; в «⋯» нет «Move to browser of…»', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    fire(arm(webview(P1)), 'dom-ready');
    expect(screen.queryByRole('button', { name: /^To:/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: 'Open full DevTools' })).toBeTruthy();
    expect(screen.queryByTestId('browser-move-to')).toBeNull();
  });

  it('Select: файл-контекст уходит хозяину панели, а не в умолчание вкладки (первая комната работы — r-01)', async () => {
    setPanel(ROOM, ['http://localhost:3000/']);
    showHost(ROOM);
    renderLayer();
    fire(arm(webview(P1), 12), 'dom-ready');
    const pick: PickResult = {
      url: 'http://localhost:3000/',
      selector: 'body > button.save',
      text: 'Save',
      html: '<button class="save">Save</button>',
      styles: { display: 'block' },
      imagePath: null,
      point: { x: 10, y: 10 },
      shift: false,
      viewport: { width: 800, height: 600, dpr: 1 },
    };
    bridge.setPickResult(pick);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    });
    await vi.waitFor(() => expect(useUiStore.getState().composerAttachments[roomKey(WORK_KEY, 'r-02')]).toHaveLength(1));
    expect(useUiStore.getState().composerAttachments[roomKey(WORK_KEY, 'r-01')] ?? []).toEqual([]);
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]).toBe('1 element added to other');
  });

  it('клик в панель освежает её: она последняя в очереди на выгрузку', () => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    renderLayer();
    vi.setSystemTime(5_000);
    fireEvent.pointerDown(screen.getByTestId('browser-panel-strip'));
    expect(usePanelRuntime.getState().usedAt[panelRuntimeKey(WORK_KEY, CHAT)]).toBe(5_000);
    vi.useRealTimers();
  });
});

describe('PanelSurface — управление агента в окне (этап D, задача 20)', () => {
  const act1 = (phase: 'start' | 'step' | 'end', extra: Record<string, unknown> = {}, webContentsId = 7): void =>
    act(() => bridge.emitAgentActivity({ webContentsId, session: 'S02', op: 'action', phase, ...extra }));
  const mount = (): FakeWebview => {
    setPanel(CHAT, ['http://localhost:3000/']);
    showHost(CHAT);
    renderLayer();
    const view = arm(webview(P1), 7);
    fire(view, 'dom-ready');
    return view;
  };
  const field = (): HTMLElement => surface(P1)?.querySelector('[data-testid="browser-field"]') as HTMLElement;

  it('страница сообщает humanBusy при Select и Annotate; выключили — запись без поля (false)', () => {
    mount();
    act(() => toggleBrowserMode(P1, 'select'));
    expect(registrations().at(-1)).toMatchObject({ pageId: P1, webContentsId: 7, humanBusy: true });
    act(() => toggleBrowserMode(P1, 'select'));
    const last = registrations().at(-1) as { humanBusy?: boolean; pageId: string };
    expect(last.pageId).toBe(P1);
    expect(last.humanBusy).toBeUndefined();
  });

  it('агент поставил размер — он ложится в раскладку страницы панели, как выбор человека; чужой гость не трогает', () => {
    mount();
    const spec = { preset: 'mobile-m', rotated: false, dpr: 2 } as const;
    act(() => bridge.emitAgentResize({ webContentsId: 9, viewport: spec }));
    expect(panelNow()?.pages[0]?.viewport).toBeUndefined();
    act(() => bridge.emitAgentResize({ webContentsId: 7, viewport: spec }));
    expect(panelNow()?.pages[0]?.viewport).toEqual(spec);
  });

  it('значок: start — ярлык сессии, Stop — пауза панели и agentStop(webContentsId)', () => {
    mount();
    expect(screen.queryByTestId('agent-badge')).toBeNull();
    act1('start');
    expect(screen.getByTestId('agent-badge').textContent).toContain('S02');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(panelNow()?.paused).toBe(true);
    expect(bridge.browserCalls.filter((call) => call.method === 'agentStop')).toEqual([{ method: 'agentStop', args: [7] }]);
  });

  it('рамка подсвечена, пока агент действует; точка клика — над <webview> в (x, y) без stage', () => {
    mount();
    expect(field().getAttribute('data-agent-acting')).toBeNull();
    act1('start');
    expect(field().getAttribute('data-agent-acting')).toBe('true');
    act1('step', { point: { x: 40, y: 25 } });
    const dot = screen.getByTestId('agent-dot');
    expect(dot.style.left).toBe('40px');
    expect(dot.style.top).toBe('25px');
  });

  it('просьба о фокусе: фокус на <webview>, agentFocusReady(id, true); end возвращает его человеку (Chat)', () => {
    const view = mount();
    view.tabIndex = 0;
    const chat = document.createElement('textarea');
    document.body.append(chat);
    chat.focus();
    act1('step', { focus: { id: 'f-1' } });
    expect(document.activeElement).toBe(view);
    expect(bridge.browserCalls.filter((call) => call.method === 'agentFocusReady')).toEqual([{ method: 'agentFocusReady', args: ['f-1', true] }]);
    act1('end');
    expect(document.activeElement).toBe(chat);
    chat.remove();
  });

  it('пока окно одалживает фокус, focusin на <webview> не делает вид хозяина активным (рецензия M1); клик человека делает', () => {
    const view = mount();
    view.tabIndex = 0;
    const focusSpy = vi.spyOn(useLayoutStore.getState(), 'apply');
    act1('step', { focus: { id: 'f-2' } });
    fireEvent.focusIn(view);
    expect(focusSpy).not.toHaveBeenCalled();
    act1('end');
    fireEvent.focusIn(view);
    expect(focusSpy).toHaveBeenCalled();
  });

  it('точка клика гаснет через clickDotMs', () => {
    vi.useFakeTimers();
    try {
      mount();
      act1('start');
      act1('step', { point: { x: 1, y: 2 } });
      expect(screen.getByTestId('agent-dot')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(AGENT_LIMITS.clickDotMs);
      });
      expect(screen.queryByTestId('agent-dot')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
