/**
 * Вид хозяина с участком под панель браузера (спека браузера 4.11; этап B2, часть 1): широкий вид — участок рядом с видом
 * и ручка ширины; вид уже 560 px — участок поверх вида; вид сообщает о себе стору окна.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { BrowserOwner, WorkLayout } from '../../../shared/layout-types.js';
import { wireSessionVisibility } from '../../attention/session-visibility.js';
import { useUiStore } from '../../store/ui.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { addPanelPage, panelOf, setPanelOpen } from '../../layout/panels.js';
import { useLayoutStore } from '../../layout/store.js';
import { emptyLayout, PANEL_LIMITS } from '../../layout/tree.js';
import { panelAnchor } from './anchor.js';
import { PanelHost } from './PanelHost.js';
import { panelRuntimeKey, usePanelRuntime } from './runtime.js';

const KEY = '/tmp/p w';
const OWNER: BrowserOwner = { kind: 'session', sessionId: 's-01' };

/** Подставной `ResizeObserver`: тест сам сообщает ширину вида. */
class ResizeObserverStub {
  static all = new Set<ResizeObserverStub>();
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.all.add(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    ResizeObserverStub.all.delete(this);
  }
  emit(width: number): void {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function setViewWidth(width: number): void {
  act(() => {
    for (const observer of ResizeObserverStub.all) observer.emit(width);
  });
}

function setLayout(layout: WorkLayout): void {
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: layout },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

/** Раскладка с открытой (`open: true`) или закрытой панелью хозяина `OWNER` из одной страницы; шириной `width`. */
function layoutWithPanel(open: boolean, width?: number): WorkLayout {
  const added = addPanelPage(emptyLayout(), OWNER, { id: 'bp-000001', url: 'http://localhost:3000/' }).layout;
  const layout = open ? added : setPanelOpen(added, OWNER, false);
  const panel = panelOf(layout, OWNER);
  return width === undefined || panel === undefined ? layout : { ...layout, panels: { 'session:s-01': { ...panel, width } } };
}

function renderHost(): ReturnType<typeof render> {
  return render(
    <PanelHost workKey={KEY} owner={OWNER}>
      <div data-testid="view">вид хозяина</div>
    </PanelHost>,
  );
}

const area = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-panel-area]');

beforeEach(() => {
  ResizeObserverStub.all.clear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  usePanelRuntime.setState({ hosts: {}, usedAt: {}, published: {}, live: new Set() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
});

describe('PanelHost — участок панели', () => {
  it('панели нет или она закрыта — только вид, участка и ручки нет', () => {
    setLayout(emptyLayout());
    renderHost();
    expect(screen.getByTestId('view')).toBeTruthy();
    expect(area()).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    cleanup();
    setLayout(layoutWithPanel(false));
    renderHost();
    expect(area()).toBeNull();
  });

  it('открытая панель, вид широкий: участок рядом шириной панели, ручка между ним и видом; якоря area и reserve', () => {
    setLayout(layoutWithPanel(true, 500));
    renderHost();
    setViewWidth(1200);
    const node = area() as HTMLElement;
    expect(node.dataset.panelMode).toBe('beside');
    expect(node.style.width).toBe('500px');
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(node.style.getPropertyValue('anchor-name')).toBe(`${panelAnchor(KEY, OWNER, 'area')}, ${panelAnchor(KEY, OWNER, 'reserve')}`);
    // Вид не под inert: человек им пользуется.
    expect(screen.getByTestId('view').parentElement?.hasAttribute('inert')).toBe(false);
  });

  it('ширина участка: не меньше 320, не больше 70 % вида; сохранённая в раскладке больше или меньше — приводится', () => {
    setLayout(layoutWithPanel(true, 900));
    renderHost();
    setViewWidth(1000);
    expect(area()?.style.width).toBe('700px');
    cleanup();
    setLayout(layoutWithPanel(true, PANEL_LIMITS.minWidth));
    renderHost();
    setViewWidth(2000);
    expect(area()?.style.width).toBe('320px');
  });

  it('виду остаётся не меньше 240 px: на 610 px участок 370 при сохранённых 400, на narrowBelow — минимальные 320', () => {
    setLayout(layoutWithPanel(true, 400));
    renderHost();
    setViewWidth(610);
    expect(area()?.style.width).toBe(`${610 - PANEL_LIMITS.minView}px`);
    setViewWidth(PANEL_LIMITS.narrowBelow);
    expect(area()?.style.width).toBe(`${PANEL_LIMITS.minWidth}px`);
  });

  it('вид уже 560 px: участок поверх вида целиком, якорь только area, ручки нет, вид под inert; шире — снова рядом', () => {
    setLayout(layoutWithPanel(true, 400));
    renderHost();
    setViewWidth(PANEL_LIMITS.narrowBelow - 1);
    const node = area() as HTMLElement;
    expect(node.dataset.panelMode).toBe('covering');
    expect(node.className).toContain('inset-0');
    expect(node.style.getPropertyValue('anchor-name')).toBe(panelAnchor(KEY, OWNER, 'area'));
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByTestId('view').parentElement?.hasAttribute('inert')).toBe(true);

    setViewWidth(PANEL_LIMITS.narrowBelow);
    expect(area()?.dataset.panelMode).toBe('beside');
    expect(screen.getByTestId('view').parentElement?.hasAttribute('inert')).toBe(false);
  });

  it('ручка: pointerup пишет ширину в раскладку один раз, влево — шире', () => {
    setLayout(layoutWithPanel(true, 400));
    renderHost();
    setViewWidth(1200);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    expect(panelOf(useLayoutStore.getState().layouts[KEY] as WorkLayout, OWNER)?.width).toBe(400);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 });
    expect(panelOf(useLayoutStore.getState().layouts[KEY] as WorkLayout, OWNER)?.width).toBe(500);
  });

  it('ручка не вытянет участок за 70 % вида и не сожмёт его меньше 320', () => {
    setLayout(layoutWithPanel(true, 400));
    renderHost();
    setViewWidth(1000);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0 });
    expect(panelOf(useLayoutStore.getState().layouts[KEY] as WorkLayout, OWNER)?.width).toBe(700);
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 5000 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 5000 });
    expect(panelOf(useLayoutStore.getState().layouts[KEY] as WorkLayout, OWNER)?.width).toBe(PANEL_LIMITS.minWidth);
  });
});

describe('PanelHost — стор окна', () => {
  it('смонтированный вид хозяина зарегистрирован, узость обновляется, размонтированный — снят', () => {
    setLayout(layoutWithPanel(true));
    const { unmount } = renderHost();
    const key = panelRuntimeKey(KEY, OWNER);
    expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: false, measured: false });
    setViewWidth(500);
    expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: true, measured: true });
    unmount();
    expect(usePanelRuntime.getState().hosts[key]).toBeUndefined();
  });

  it('закрытая панель вид не прячет: он зарегистрирован и без панели', () => {
    setLayout(emptyLayout());
    renderHost();
    expect(usePanelRuntime.getState().hosts[panelRuntimeKey(KEY, OWNER)]).toEqual({ narrow: false, measured: false });
  });

  it('width0 -> 600 publishes measurement with unchanged narrow=false; 559/560 retains UI boundary', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 0 } as DOMRect);
    setLayout(layoutWithPanel(true));
    renderHost();
    const ref = { projectPath: '/tmp/p', workId: 'w', sessionId: 's-01' };
    useUiStore.setState({ visibleSessionRefs: { [refKey(ref)]: true }, documentVisible: true });
    const reportSessionVisibility = vi.fn();
    const dispose = wireSessionVisibility({ app: { reportSessionVisibility, onWindowFocus: () => () => {} } } as unknown as ParleyBridge);
    const key = panelRuntimeKey(KEY, OWNER);
    try {
      expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: false, measured: false });
      expect(reportSessionVisibility.mock.calls.at(-1)![0].refs).toEqual([]);
      setViewWidth(600);
      expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: false, measured: true });
      expect(reportSessionVisibility.mock.calls.at(-1)![0].refs).toEqual([ref]);
      expect(area()?.getAttribute('data-panel-mode')).toBe('beside');
      setViewWidth(559);
      expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: true, measured: true });
      expect(reportSessionVisibility.mock.calls.at(-1)![0].refs).toEqual([]);
      expect(area()?.getAttribute('data-panel-mode')).toBe('covering');
      setViewWidth(560);
      expect(usePanelRuntime.getState().hosts[key]).toEqual({ narrow: false, measured: true });
      expect(reportSessionVisibility.mock.calls.at(-1)![0].refs).toEqual([ref]);
      expect(area()?.getAttribute('data-panel-mode')).toBe('beside');
    } finally {
      dispose();
    }
  });
});
