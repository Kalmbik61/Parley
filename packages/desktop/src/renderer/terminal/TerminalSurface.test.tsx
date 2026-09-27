/**
 * `TerminalSurface` сама по себе (кусок 2.5): на меню `find` не подписана —
 * полосу открывает `openSearch()` ручки из `terminalSurfaces`; Enter —
 * `findNext`, Esc закрывает; корень несёт `data-tab-id`/`data-mount-id` и
 * якорь `--g-<groupId>`. Сценарии слоя (перенос, видимость, граница ошибки) —
 * в `layout/SurfaceLayer.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { TerminalSurface, terminalSurfaces } from './TerminalSurface.js';

const state = vi.hoisted(() => ({ findNext: vi.fn(), focus: vi.fn(), scrollToBottom: vi.fn() }));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => ({
    cols: 80,
    rows: 24,
    options: { ...initialOptions },
    open: () => {},
    loadAddon: () => {},
    write: () => {},
    reset: () => {},
    dispose: () => {},
    resize: () => {},
    focus: state.focus,
    scrollToBottom: state.scrollToBottom,
    onData: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
    hasSelection: () => false,
    getSelection: () => '',
  })),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({ findNext: state.findNext })),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
let bridge: FakeBridge;

beforeEach(() => {
  state.findNext.mockClear();
  state.focus.mockClear();
  state.scrollToBottom.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSurface(): ReturnType<typeof render> {
  return render(
    <TerminalSurface bridge={bridge} sessionRef={ref} tabId="terminal:s-01" groupId="g-1" visible fontFamily="Menlo" fontSize={13} />,
  );
}

describe('TerminalSurface', () => {
  it('корень: data-tab-id, data-mount-id и якорь группы', () => {
    const { container } = renderSurface();
    const root = container.querySelector<HTMLElement>('[data-tab-id="terminal:s-01"]');
    expect(root?.dataset.mountId).toMatch(/.+/);
    expect(root?.style.getPropertyValue('position-anchor')).toBe('--g-g-1');
  });

  it('меню find само полосу не открывает', () => {
    renderSurface();
    act(() => bridge.emitMenu('find'));
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
  });

  it('openSearch() ручки: полоса с фокусом в поле, Enter — findNext, Esc закрывает', async () => {
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    const handle = terminalSurfaces.get(refKey(ref));
    if (handle === undefined) throw new Error('поверхности нет в реестре');

    act(() => handle.openSearch());
    const input = screen.getByPlaceholderText('Find…');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(state.findNext).toHaveBeenCalledWith('hello');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();

    handle.focus();
    handle.scrollToBottom();
    expect(state.focus).toHaveBeenCalledTimes(1);
    expect(state.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(handle.search).not.toBeNull();
  });
});
