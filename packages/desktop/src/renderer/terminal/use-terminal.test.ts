/**
 * `@xterm/xterm` и его аддоны подменены фейками: реальный xterm рисует в
 * канву, которой в jsdom нет, а нас интересует протокольная обвязка, а не
 * рендер (кусок 1.11 плана окна — «xterm в jsdom подменяется фейковым
 * Terminal, который пишет в массив»).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ILink } from '@xterm/xterm';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { lineFromText, xtermMock } from '../test-utils/xterm-mock.js';
import { useUiStore } from '../store/ui.js';
import { minimumContrastRatio, xtermTheme } from './xterm-themes.js';
import { useTerminal, type UseTerminalOptions } from './use-terminal.js';
import { webglPolicy } from './webgl-policy.js';

const state = vi.hoisted(() => ({
  fitCalls: 0,
  webglContextLoss: null as (() => void) | null,
  webglCreated: 0,
  webglDisposed: 0,
  /**
   * Раунд исправлений 1, находка B№2: подставной FitAddon подбирает этот
   * размер (если задан) на последнем созданном терминале при каждом вызове
   * `fit()` — имитирует то, что настоящий `FitAddon.proposeDimensions()`
   * считает по реальному размеру контейнера, независимо от того, что
   * ответил хост в `pty.attach`.
   */
  nextFitSize: null as { cols: number; rows: number } | null,
}));

vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-search', async () => (await import('../test-utils/xterm-mock.js')).searchModule);

vi.mock('@xterm/addon-fit', async () => {
  const { xtermMock: mock } = await import('../test-utils/xterm-mock.js');
  return {
    FitAddon: vi.fn().mockImplementation(() => ({
      fit: () => {
        state.fitCalls += 1;
        if (state.nextFitSize !== null) {
          const last = mock.terminals[mock.terminals.length - 1];
          if (last !== undefined) {
            last.cols = state.nextFitSize.cols;
            last.rows = state.nextFitSize.rows;
          }
        }
      },
    })),
  };
});

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => {
    state.webglCreated += 1;
    return {
      onContextLoss: (cb: () => void) => {
        state.webglContextLoss = cb;
      },
      dispose: () => {
        state.webglDisposed += 1;
      },
    };
  }),
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

/** Поля 5.3, которые даёт `TerminalSurface`: здесь — заглушки. */
const surfaceOptions = (): Pick<UseTerminalOptions, 'workKey' | 'cwd' | 'onLink'> => ({
  workKey: '/tmp/proj\u0000w-01',
  cwd: '/tmp/proj',
  onLink: () => {},
});

function renderTerminal(bridge: FakeBridge, sessionRef: SessionRef = ref, extra: Partial<UseTerminalOptions> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return renderHook(() =>
    useTerminal({ bridge, ref: sessionRef, container, fontFamily: 'Menlo', fontSize: 13, ...surfaceOptions(), ...extra }),
  );
}

beforeEach(() => {
  xtermMock.reset();
  state.fitCalls = 0;
  state.webglContextLoss = null;
  state.webglCreated = 0;
  state.webglDisposed = 0;
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
      expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК', 'ранний кусок']);
    });
  });

  it('вывод другой сессии не попадает на этот терминал', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: 'СНИМОК', cols: 80, rows: 24 }));
    renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК']));

    bridge.emit('pty.output', { ref: otherRef, data: 'чужой' });
    expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК']);
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

    expect(xtermMock.terminals[0]?.cols).toBe(100);
    expect(xtermMock.terminals[0]?.rows).toBe(30);
    expect(bridge.notified.filter((n) => n.method === 'pty.resize')).toEqual([
      { method: 'pty.resize', params: { ref, cols: 100, rows: 30 } },
    ]);
  });

  it('размер контейнера после fit() совпал с ответом attach — pty.resize не уходит', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    state.nextFitSize = { cols: 80, rows: 24 };

    renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['']));

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
    expect(xtermMock.terminals[0]?.resets).toBe(1);
    expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК-1', 'СНИМОК-2']);
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
    await waitFor(() => expect(xtermMock.terminals[0]?.keyHandler).not.toBeNull());

    const handler = xtermMock.terminals[0]?.keyHandler;
    expect(handler?.(new KeyboardEvent('keydown', { metaKey: true, key: 't' }))).toBe(false);
    expect(handler?.(new KeyboardEvent('keydown', { metaKey: false, key: 'a' }))).toBe(true);
  });
});

// Тест 10 куска 5.3 переехал в `keys/handler.test.ts` и `AppShell.test.tsx` (кусок 6.1b): ⌘K и ⌘F
// ловит обработчик окна в capture-фазе, до xterm они не доходят. Здесь — что своих веток у
// терминала больше нет: ⌘K сам не чистит экран и, как любое ⌘-сочетание, агенту не уходит.
describe('⌘K и ⌘F терминал себе не берёт (кусок 6.1b)', () => {
  it('⌘K — ни clear, ни preventDefault, pty.input нет', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals[0]?.keyHandler).not.toBeNull());
    const handler = xtermMock.terminals[0]?.keyHandler;

    const clearKey = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
    expect(handler?.(clearKey)).toBe(false);
    expect(clearKey.defaultPrevented).toBe(false);
    expect(xtermMock.callsOf('clear', 0)).toHaveLength(0);
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([]);
  });
});

describe('тест 11: опции xterm, ссылки и WebGL (кусок 5.3)', () => {
  it('allowProposedApi и linkHandler в конструкторе; registerLinkProvider; web-links не импортируется', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals).toHaveLength(1));
    const options = xtermMock.terminals[0]?.initialOptions;
    expect(options?.allowProposedApi).toBe(true);
    expect(options?.linkHandler).toBeTruthy();
    expect(xtermMock.callsOf('registerLinkProvider', 0)).toHaveLength(1);
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'use-terminal.ts'), 'utf8');
    expect(source).not.toContain('@xterm/addon-web-links');
  });

  it('linkHandler (OSC 8): https — onLink с kind url; file:///etc/passwd — ничего', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    const onLink = vi.fn();
    renderTerminal(bridge, ref, { onLink });
    await waitFor(() => expect(xtermMock.terminals).toHaveLength(1));
    const handler = xtermMock.terminals[0]?.initialOptions.linkHandler as { activate: (event: MouseEvent, text: string) => void };
    const event = new MouseEvent('click');
    handler.activate(event, 'https://example.com');
    handler.activate(event, 'file:///etc/passwd');
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith({ kind: 'url', url: 'https://example.com' }, event);
  });

  it('провайдер ссылок: files.locate с workKey терминала, клик — onLink', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    const located = { root: { workKey: 'wk', spec: { kind: 'project' as const } }, relPath: 'src/a.ts', stat: { kind: 'file' as const, size: 1, mtimeMs: 0 } };
    bridge.setLocated('wk', '/tmp/proj/src/a.ts', located);
    const onLink = vi.fn();
    renderTerminal(bridge, ref, { workKey: 'wk', onLink });
    await waitFor(() => expect(xtermMock.terminals[0]?.linkProviders).toHaveLength(1));
    const term = xtermMock.terminals[0];
    term?.setLines([lineFromText('see src/a.ts:12')]);
    const links = await new Promise<ILink[] | undefined>((resolve) => term?.linkProviders[0]?.provideLinks(1, resolve));
    expect(bridge.locateCalls).toEqual([{ workKey: 'wk', absPaths: ['/tmp/proj/src/a.ts'] }]);
    links?.[0]?.activate(new MouseEvent('click'), 'src/a.ts:12');
    expect(onLink).toHaveBeenCalledWith({ kind: 'path', absPath: '/tmp/proj/src/a.ts', located, line: 12 }, expect.any(MouseEvent));
  });

  it('want: false от webglPolicy — dispose аддона WebGL; размонтирование — forget', async () => {
    const subscribe = vi.spyOn(webglPolicy, 'subscribe');
    const forget = vi.spyOn(webglPolicy, 'forget');
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      bridge.setHandler('pty.detach', () => ({ ok: true as const }));
      const { unmount } = renderTerminal(bridge);
      await waitFor(() => expect(state.webglCreated).toBe(1));
      const listener = subscribe.mock.calls[0]?.[1];
      expect(subscribe.mock.calls[0]?.[0]).toBe(refKey(ref));

      act(() => listener?.(false));
      expect(state.webglDisposed).toBe(1);
      act(() => listener?.(true));
      expect(state.webglCreated).toBe(2);

      unmount();
      expect(forget).toHaveBeenCalledWith(refKey(ref));
    } finally {
      subscribe.mockRestore();
      forget.mockRestore();
    }
  });

  it('потеря контекста: dispose и через 1 с новая попытка', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      bridge.setHandler('pty.detach', () => ({ ok: true as const }));
      renderTerminal(bridge, otherRef);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.webglCreated).toBe(1);
      state.webglContextLoss?.();
      expect(state.webglDisposed).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(state.webglCreated).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.webglCreated).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useTerminal — размонтирование', () => {
  it('зовёт pty.detach', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    const { unmount } = renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['']));

    unmount();

    expect(bridge.calls.filter((c) => c.method === 'pty.detach')).toEqual([
      { method: 'pty.detach', params: { ref } },
    ]);
    expect(xtermMock.terminals[0]?.disposed).toBe(true);
  });
});

describe('useTerminal — тема на лету (тест 2 куска 1.3)', () => {
  it('setDark меняет options.theme и options.minimumContrastRatio без пересоздания терминала', async () => {
    act(() => useUiStore.getState().setDark(false));
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      renderTerminal(bridge);
      await waitFor(() => expect(xtermMock.terminals).toHaveLength(1));
      const term = xtermMock.terminals[0];
      expect(term?.options.theme).toEqual(xtermTheme(false));

      act(() => useUiStore.getState().setDark(true));

      expect(term?.options.theme).toEqual(xtermTheme(true));
      expect(term?.options.minimumContrastRatio).toBe(minimumContrastRatio(true));
      // Ни dispose, ни новый Terminal не звались — тот же самый объект.
      expect(term?.disposed).toBe(false);
      expect(xtermMock.terminals).toHaveLength(1);
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
        useTerminal({ bridge, ref, container, fontFamily: 'Menlo', fontSize: 13, visible: props.visible, ...surfaceOptions() }),
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
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['S']));
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
