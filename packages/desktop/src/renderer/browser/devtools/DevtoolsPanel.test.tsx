import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { DevtoolsPanel, type DevtoolsPanelProps } from './DevtoolsPanel.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
let bridge: FakeBridge;

function seed(patch: Partial<TabDevtools> = {}): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, open: true, ...patch } } });
}

function renderPanel(extra: Partial<DevtoolsPanelProps> = {}): DevtoolsPanelProps {
  const props: DevtoolsPanelProps = {
    tabId: TAB,
    webContentsId: 7,
    pageUrl: 'http://localhost:5173/',
    bridge,
    height: 200,
    maxHeight: 400,
    onResize: vi.fn(),
    onReload: vi.fn(),
    onClear: vi.fn(),
    ...extra,
  };
  render(<DevtoolsPanel {...props} />);
  return props;
}

beforeEach(() => {
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDevtoolsStore.setState({ tabs: {} });
});

/** ResizeObserver, которым тест сам сообщает ширину панели; прочие наблюдатели (список запросов) молчат. */
function stubPanelWidth(): (width: number) => void {
  const observers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];
  class FakeResizeObserver {
    private readonly slot: { callback: ResizeObserverCallback; target: Element | null };
    constructor(callback: ResizeObserverCallback) {
      this.slot = { callback, target: null };
      observers.push(this.slot);
    }
    observe(target: Element): void {
      this.slot.target = target;
    }
    unobserve(): void {}
    disconnect(): void {
      this.slot.target = null;
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return (width) =>
    act(() => {
      for (const slot of observers) {
        if (slot.target?.getAttribute('data-testid') !== 'devtools-panel') continue;
        slot.callback(
          [{ contentRect: { width } } as ResizeObserverEntry],
          slot as unknown as ResizeObserver,
        );
      }
    });
}

describe('DevtoolsPanel (спека 4.3, 4.4)', () => {
  it('вкладки Console и Network — вид в сторе вкладки; высота — из пропса', () => {
    seed();
    renderPanel();
    expect(screen.getByTestId('devtools-panel').style.height).toBe('200px');
    expect(screen.getByTestId('console-view')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Network' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.view).toBe('network');
    expect(screen.getByTestId('network-view')).toBeTruthy();
  });

  it('late — «Reload to capture earlier requests», unavailable — «Capture unavailable…»; Reload — onReload', () => {
    seed({ capture: 'late' });
    const props = renderPanel();
    expect(screen.getByRole('status').textContent).toContain('Reload to capture earlier requests');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(props.onReload).toHaveBeenCalledTimes(1);
    cleanup();
    seed({ capture: 'unavailable' });
    renderPanel();
    expect(screen.getByRole('status').textContent).toContain(
      'Capture unavailable — reload the page',
    );
    cleanup();
    seed();
    renderPanel();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Preserve log — в стор; Clear — onClear; Close panel — панель спрятана', () => {
    seed();
    const props = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Preserve log' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.preserve).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.open).toBe(false);
  });

  it('Add errors to chat — только при ошибках и с колбэком этапа B', () => {
    const onAddErrorsToChat = vi.fn();
    seed({ network: [networkEntry('fail', { status: 500 })] });
    renderPanel({ onAddErrorsToChat });
    fireEvent.click(screen.getByRole('button', { name: 'Add errors to chat' }));
    expect(onAddErrorsToChat).toHaveBeenCalledTimes(1);
    cleanup();
    seed({ console: [consoleEntry(1)] });
    renderPanel({ onAddErrorsToChat });
    expect(screen.queryByRole('button', { name: 'Add errors to chat' })).toBeNull();
    cleanup();
    seed({ network: [networkEntry('fail', { status: 500 })] });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Add errors to chat' })).toBeNull();
  });

  it('ручка: вверх на 100 px — onResize(300); не выше maxHeight; оверлей — только во время перетаскивания', () => {
    seed();
    const props = renderPanel();
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    expect(screen.getByTestId('devtools-panel').style.height).toBe('300px');
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 400 });
    expect(props.onResize).toHaveBeenCalledWith(300);
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 0 });
    expect(props.onResize).toHaveBeenLastCalledWith(400);
  });

  it('перетаскивание прервано (потеря захвата, уход фокуса окна): прежняя высота в DOM, onResize не зовётся', () => {
    seed();
    const props = renderPanel();
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    expect(screen.getByTestId('devtools-panel').style.height).toBe('300px');
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(screen.getByTestId('devtools-panel').style.height).toBe('200px');
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.getByTestId('devtools-panel').style.height).toBe('200px');
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    // После прерывания отпускание кнопки ничего не пишет.
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 450 });
    expect(props.onResize).not.toHaveBeenCalled();
  });

  it('ширина панели уже 640 px — детали запроса поверх списка; от 640 — рядом', () => {
    const resizeTo = stubPanelWidth();
    seed({ view: 'network', network: [networkEntry('fail', { status: 500 })], selected: 'fail' });
    renderPanel();
    const overlay = (): string | null =>
      screen.getByTestId('request-details-pane').getAttribute('data-overlay');
    expect(overlay()).toBe('false');
    resizeTo(639);
    expect(overlay()).toBe('true');
    resizeTo(640);
    expect(overlay()).toBe('false');
  });
});
