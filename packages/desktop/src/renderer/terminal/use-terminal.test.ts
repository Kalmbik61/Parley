/**
 * `@xterm/xterm` и его аддоны подменены фейками: реальный xterm рисует в
 * канву, которой в jsdom нет, а нас интересует протокольная обвязка, а не
 * рендер (кусок 1.11 плана окна — «xterm в jsdom подменяется фейковым
 * Terminal, который пишет в массив»).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { minimumContrastRatio, xtermTheme } from './xterm-themes.js';
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
  /** `use-terminal.ts` меняет тему на лету через `options.theme`/`options.minimumContrastRatio` (тест 2 куска 1.3). */
  options: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  terminals: [] as FakeTerminalInstance[],
  fitCalls: 0,
  linkHandler: null as ((event: unknown, uri: string) => void) | null,
  webglContextLoss: null as (() => void) | null,
  webglDisposed: false,
  /**
   * Раунд исправлений 1, находка B№2: подставной FitAddon подбирает этот
   * размер (если задан) на последнем созданном терминале при каждом вызове
   * `fit()` — имитирует то, что настоящий `FitAddon.proposeDimensions()`
   * считает по реальному размеру контейнера, независимо от того, что
   * ответил хост в `pty.attach`.
   */
  nextFitSize: null as { cols: number; rows: number } | null,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => {
    const instance: FakeTerminalInstance = {
      cols: 80,
      rows: 24,
      writes: [],
      resets: 0,
      disposed: false,
      selection: '',
      onDataHandler: null,
      keyHandler: null,
      options: { ...initialOptions },
    };
    state.terminals.push(instance);
    return {
      get cols() {
        return instance.cols;
      },
      get rows() {
        return instance.rows;
      },
      // Один и тот же объект, что и в `instance.options` — присвоение через
      // `term.options.theme = …` в хуке обязано быть видно в `state.terminals`.
      options: instance.options,
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
      if (state.nextFitSize !== null) {
        const last = state.terminals[state.terminals.length - 1];
        if (last !== undefined) {
          last.cols = state.nextFitSize.cols;
          last.rows = state.nextFitSize.rows;
        }
      }
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
    useTerminal({ bridge, ref: sessionRef, container, fontFamily: 'Menlo', fontSize: 13 }),
  );
}

beforeEach(() => {
  state.terminals = [];
  state.fitCalls = 0;
  state.linkHandler = null;
  state.webglContextLoss = null;
  state.webglDisposed = false;
  state.nextFitSize = null;
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

describe('useTerminal — attach() не должен перетирать fit() размером хоста (раунд исправлений 1, находка B№2)', () => {
  it('размер контейнера после fit() отличается от ответа attach — уходит pty.resize с размером контейнера', async () => {
    const bridge = createFakeBridge();
    // Свежий PTY хоста ещё не получал ни одного pty.resize и отвечает своим
    // DEFAULT_SIZE (packages/host/src/pty/pty-manager.ts) — здесь 120×40, а
    // реальный контейнер вмещает 100×30 (подставной FitAddon имитирует это).
    bridge.setHandler('pty.attach', () => ({ snapshot: 'СНИМОК', cols: 120, rows: 40 }));
    state.nextFitSize = { cols: 100, rows: 30 };

    renderTerminal(bridge);

    await waitFor(() => expect(bridge.notified.some((n) => n.method === 'pty.resize')).toBe(true));

    expect(state.terminals[0]?.cols).toBe(100);
    expect(state.terminals[0]?.rows).toBe(30);
    expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toEqual([
      { method: 'pty.resize', params: { ref, cols: 100, rows: 30 } },
    ]);
  });

  it('размер контейнера после fit() совпал с ответом attach — pty.resize не уходит', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    state.nextFitSize = { cols: 80, rows: 24 };

    renderTerminal(bridge);
    await waitFor(() => expect(state.terminals[0]?.writes).toEqual(['']));

    expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);
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

describe('useTerminal — тема на лету (тест 2 куска 1.3)', () => {
  it('setDark меняет options.theme и options.minimumContrastRatio без пересоздания терминала', async () => {
    act(() => useUiStore.getState().setDark(false));
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      renderTerminal(bridge);
      await waitFor(() => expect(state.terminals).toHaveLength(1));
      const term = state.terminals[0];
      expect(term?.options.theme).toEqual(xtermTheme(false));

      act(() => useUiStore.getState().setDark(true));

      expect(term?.options.theme).toEqual(xtermTheme(true));
      expect(term?.options.minimumContrastRatio).toBe(minimumContrastRatio(true));
      // Ни dispose, ни новый Terminal не звались — тот же самый объект.
      expect(term?.disposed).toBe(false);
      expect(state.terminals).toHaveLength(1);
    } finally {
      act(() => useUiStore.getState().setDark(false));
    }
  });
});

describe('useTerminal — видимость и размер (куски 2.5, тесты 9 и 11)', () => {
  function renderWithVisibility(bridge: FakeBridge, visible: boolean) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return renderHook(
      (props: { visible: boolean }) =>
        useTerminal({ bridge, ref, container, fontFamily: 'Menlo', fontSize: 13, visible: props.visible }),
      { initialProps: { visible } },
    );
  }

  it('тест 9: невидимая поверхность на ResizeObserver не шлёт pty.resize; видимая — шлёт через 50 мс', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      bridge.setHandler('pty.detach', () => ({ ok: true as const }));
      const { rerender } = renderWithVisibility(bridge, false);
      await vi.advanceTimersByTimeAsync(0);

      const observer = ResizeObserverStub.instances[0];
      observer?.trigger();
      await vi.advanceTimersByTimeAsync(100);
      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);

      rerender({ visible: true });
      await vi.advanceTimersByTimeAsync(0);
      // Появление само по себе resize не шлёт — размер совпал с ответом attach.
      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);

      observer?.trigger();
      await vi.advanceTimersByTimeAsync(49);
      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('тест 11: стала видимой, attach 80×24; fit 80×24 — resize нет; fit 100×30 — ровно один 100×30', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: 'S', cols: 80, rows: 24 }));
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    state.nextFitSize = { cols: 80, rows: 24 };
    const { rerender } = renderWithVisibility(bridge, false);
    expect(bridge.calls.filter((c) => c.method === 'pty.attach')).toHaveLength(0);

    rerender({ visible: true });
    await waitFor(() => expect(state.terminals[0]?.writes).toEqual(['S']));
    expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(0);

    rerender({ visible: false });
    state.nextFitSize = { cols: 100, rows: 30 };
    rerender({ visible: true });
    await waitFor(() => expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toHaveLength(1));
    expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toEqual([
      { method: 'pty.resize', params: { ref, cols: 100, rows: 30 } },
    ]);
  });
});
