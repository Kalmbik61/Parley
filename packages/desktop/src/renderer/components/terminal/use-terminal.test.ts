/**
 * `@xterm/xterm` и его аддоны подменены фейками: реальный xterm рисует в
 * канву, которой в jsdom нет, а нас интересует протокольная обвязка, а не
 * рендер (кусок 1.11 плана окна — «xterm в jsdom подменяется фейковым
 * Terminal, который пишет в массив»).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { useTerminal } from './use-terminal.js';

interface FakeTerminalInstance {
  cols: number;
  rows: number;
  writes: string[];
  resets: number;
  disposed: boolean;
  selection: string;
  onDataHandler: ((data: string) => void) | null;
  keyHandler: ((event: { type: string; metaKey: boolean; key: string }) => boolean) | null;
}

const state = vi.hoisted(() => ({
  terminals: [] as FakeTerminalInstance[],
  fitCalls: 0,
  linkHandler: null as ((event: unknown, uri: string) => void) | null,
  webglContextLoss: null as (() => void) | null,
  webglDisposed: false,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => {
    const instance: FakeTerminalInstance = {
      cols: 80,
      rows: 24,
      writes: [],
      resets: 0,
      disposed: false,
      selection: '',
      onDataHandler: null,
      keyHandler: null,
    };
    state.terminals.push(instance);
    return {
      get cols() {
        return instance.cols;
      },
      get rows() {
        return instance.rows;
      },
      open: () => {},
      loadAddon: () => {},
      write: (data: string) => instance.writes.push(data),
      reset: () => {
        instance.resets += 1;
      },
      dispose: () => {
        instance.disposed = true;
      },
      resize: (cols: number, rows: number) => {
        instance.cols = cols;
        instance.rows = rows;
      },
      onData: (handler: (data: string) => void) => {
        instance.onDataHandler = handler;
        return { dispose: () => {} };
      },
      attachCustomKeyEventHandler: (handler: FakeTerminalInstance['keyHandler']) => {
        instance.keyHandler = handler;
      },
      hasSelection: () => instance.selection !== '',
      getSelection: () => instance.selection,
    };
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: () => {
      state.fitCalls += 1;
    },
  })),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({ findNext: () => true })),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation((handler: (event: unknown, uri: string) => void) => {
    state.linkHandler = handler;
    return {};
  }),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: (cb: () => void) => {
      state.webglContextLoss = cb;
    },
    dispose: () => {
      state.webglDisposed = true;
    },
  })),
}));

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
const otherRef: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-02' };

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function renderTerminal(bridge: FakeBridge, sessionRef: SessionRef = ref) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return renderHook(() =>
    useTerminal({ bridge, ref: sessionRef, container, theme: 'mocha', fontFamily: 'Menlo', fontSize: 13 }),
  );
}

beforeEach(() => {
  state.terminals = [];
  state.fitCalls = 0;
  state.linkHandler = null;
  state.webglContextLoss = null;
  state.webglDisposed = false;
  ResizeObserverStub.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTerminal — подключение', () => {
  it('снимок пишется первым, вывод — следом, даже если пришёл раньше ответа attach', async () => {
    const bridge = createFakeBridge();
    let resolveAttach: ((result: { snapshot: string; cols: number; rows: number }) => void) | null = null;
    bridge.setHandler(
      'pty.attach',
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve;
        }),
    );

    renderTerminal(bridge);
    // Вывод дошёл раньше ответа на attach — должен подождать снимок, а не
    // обогнать его на экране.
    bridge.emit('pty.output', { ref, data: 'ранний кусок' });

    resolveAttach?.({ snapshot: 'СНИМОК', cols: 80, rows: 24 });

    await waitFor(() => {
      expect(state.terminals[0]?.writes).toEqual(['СНИМОК', 'ранний кусок']);
    });
  });

  it('вывод другой сессии не попадает на этот терминал', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: 'СНИМОК', cols: 80, rows: 24 }));
    renderTerminal(bridge);
    await waitFor(() => expect(state.terminals[0]?.writes).toEqual(['СНИМОК']));

    bridge.emit('pty.output', { ref: otherRef, data: 'чужой' });
    expect(state.terminals[0]?.writes).toEqual(['СНИМОК']);
  });
});

describe('useTerminal — pty.resync', () => {
  it('сбрасывает экран и подключается заново', async () => {
    const bridge = createFakeBridge();
    let attachCalls = 0;
    bridge.setHandler('pty.attach', () => {
      attachCalls += 1;
      return { snapshot: `СНИМОК-${attachCalls}`, cols: 80, rows: 24 };
    });
    renderTerminal(bridge);
    await waitFor(() => expect(attachCalls).toBe(1));

    bridge.emit('pty.resync', { ref });

    await waitFor(() => expect(attachCalls).toBe(2));
    expect(state.terminals[0]?.resets).toBe(1);
    expect(state.terminals[0]?.writes).toEqual(['СНИМОК-1', 'СНИМОК-2']);
  });
});

describe('useTerminal — ресайз', () => {
  it('три ресайза подряд — один pty.resize после тишины', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      renderTerminal(bridge);
      await vi.advanceTimersByTimeAsync(0);

      const observer = ResizeObserverStub.instances[0];
      observer?.trigger();
      await vi.advanceTimersByTimeAsync(10);
      observer?.trigger();
      await vi.advanceTimersByTimeAsync(10);
      observer?.trigger();
      await vi.advanceTimersByTimeAsync(10);

      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(50);
      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useTerminal — клавиши', () => {
  it('нажатие с metaKey не пропускается xterm-у', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    renderTerminal(bridge);
    await waitFor(() => expect(state.terminals[0]?.keyHandler).not.toBeNull());

    const handler = state.terminals[0]?.keyHandler;
    expect(handler?.({ type: 'keydown', metaKey: true, key: 't' })).toBe(false);
    expect(handler?.({ type: 'keydown', metaKey: false, key: 'a' })).toBe(true);
  });
});

describe('useTerminal — ссылки', () => {
  it('https открывается наружу, file — нет', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    const openExternal = vi.spyOn(bridge.app, 'openExternal').mockResolvedValue(undefined);
    renderTerminal(bridge);
    await waitFor(() => expect(state.linkHandler).not.toBeNull());

    state.linkHandler?.({} as MouseEvent, 'https://example.com');
    state.linkHandler?.({} as MouseEvent, 'file:///etc/passwd');

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });
});

describe('useTerminal — размонтирование', () => {
  it('зовёт pty.detach', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    const { unmount } = renderTerminal(bridge);
    await waitFor(() => expect(state.terminals[0]?.writes).toEqual(['']));

    unmount();

    expect(bridge.calls.filter((c) => c.method === 'pty.detach')).toEqual([
      { method: 'pty.detach', params: { ref } },
    ]);
    expect(state.terminals[0]?.disposed).toBe(true);
  });
});
