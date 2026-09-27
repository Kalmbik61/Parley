import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { TerminalPanel } from './TerminalPanel.js';

const state = vi.hoisted(() => ({
  findNext: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => ({
    cols: 80,
    rows: 24,
    // `use-terminal.ts` меняет тему на лету через `options.theme` — без этого
    // объекта то присвоение упало бы (`Cannot set properties of undefined`).
    options: { ...initialOptions },
    open: () => {},
    loadAddon: () => {},
    write: () => {},
    reset: () => {},
    dispose: () => {},
    resize: () => {},
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

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };

// В jsdom нет ResizeObserver — `use-terminal.ts` заводит его на монтировании
// панели, без стаба рендер падает раньше, чем дело доходит до строки поиска.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  state.findNext.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalPanel', () => {
  it('строка поиска скрыта, пока не пришло меню «find»', () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    render(<TerminalPanel bridge={bridge} sessionRef={ref} fontFamily="Menlo" fontSize={13} />);

    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
  });

  it('⌘F открывает строку, Enter зовёт findNext, Escape закрывает', () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    render(<TerminalPanel bridge={bridge} sessionRef={ref} fontFamily="Menlo" fontSize={13} />);

    act(() => bridge.emitMenu('find'));
    const input = screen.getByPlaceholderText('Find…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(state.findNext).toHaveBeenCalledWith('hello');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
  });
});
