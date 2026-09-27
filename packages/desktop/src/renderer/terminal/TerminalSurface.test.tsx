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

const state = vi.hoisted(() => ({
  findNext: vi.fn(),
  focus: vi.fn(),
  scrollToBottom: vi.fn(),
  paste: vi.fn(),
  xtermPaste: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => ({
    cols: 80,
    rows: 24,
    options: { ...initialOptions },
    // Как у настоящего xterm: скрытое поле ввода внутри контейнера со своим обработчиком paste.
    open: (el: HTMLElement) => {
      const textarea = document.createElement('textarea');
      textarea.dataset.testid = 'xterm-textarea';
      textarea.addEventListener('paste', state.xtermPaste);
      el.appendChild(textarea);
    },
    paste: state.paste,
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
  state.paste.mockClear();
  state.xtermPaste.mockClear();
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

  describe('вставка в терминал (кусок 5.1, раунд исправлений 2)', () => {
    async function pasteText(text: string): Promise<void> {
      renderSurface();
      await act(async () => {
        await Promise.resolve();
      });
      const textarea = screen.getByTestId('xterm-textarea');
      fireEvent.paste(textarea, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [] } });
    }

    it('CSI (в т.ч. поддельный ESC[201~) и управляющие C0 вырезаются до xterm, сырой текст xterm не получает', async () => {
      await pasteText('a\x1b[201~\x03b');
      expect(state.paste).toHaveBeenCalledTimes(1);
      expect(state.paste).toHaveBeenCalledWith('ab');
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });

    it('обычный текст с \\t, \\n, \\r уходит без изменений', async () => {
      await pasteText('line 1\tx\r\nline 2\n');
      expect(state.paste).toHaveBeenCalledWith('line 1\tx\r\nline 2\n');
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });

    it('пустой после чистки текст — ничего не вставляется', async () => {
      await pasteText('\x1b\x07\x7f\x1b[200~');
      expect(state.paste).not.toHaveBeenCalled();
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });
  });
});
