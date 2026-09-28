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
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { minimumContrastRatio, xtermTheme } from './xterm-themes.js';
import { useTerminal, type UseTerminalOptions } from './use-terminal.js';
import { webglPolicy } from './webgl-policy.js';

const state = vi.hoisted(() => ({
  fitCalls: 0,
  webglContextLoss: null as (() => void) | null,
  webglCreated: 0,
  webglDisposed: 0,
  /** Раунд fix-main-r1: `dispose` аддона бросает, как 0.19 поверх xterm 5.5 (`_store` нет). */
  webglDisposeThrows: false,
  /** Созданные аддоны WebGL: чей он (по `loadAddon`) и освобождён ли. */
  webglAddons: [] as { disposed: boolean }[],
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
    const addon = {
      disposed: false,
      onContextLoss: (cb: () => void) => {
        state.webglContextLoss = cb;
      },
      dispose: () => {
        state.webglDisposed += 1;
        addon.disposed = true;
        if (state.webglDisposeThrows) throw new TypeError("Cannot read properties of undefined (reading '_isDisposed')");
      },
    };
    state.webglAddons.push(addon);
    return addon;
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
  state.webglDisposeThrows = false;
  state.webglAddons = [];
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

  it('два attach вразнобой: ответ прежнего, пришедший последним, экран не дописывает', async () => {
    // fix-tests2 (host-disconnect:127, «stub-echo готов» дважды): второй attach начался, пока
    // первый ждал ответа, и его ответ пришёл раньше. Прежний ответ, дописанный следом без
    // сброса, удваивал экран — поверх свежего снимка ложился тот же вывод ещё раз.
    const bridge = createFakeBridge();
    const pending: Array<(result: { snapshot: string; cols: number; rows: number }) => void> = [];
    bridge.setHandler(
      'pty.attach',
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    renderTerminal(bridge);
    await waitFor(() => expect(pending).toHaveLength(1));

    bridge.emit('pty.resync', { ref });
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]?.({ snapshot: 'СНИМОК-2', cols: 80, rows: 24 });
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК-2']));
    pending[0]?.({ snapshot: 'СНИМОК-1', cols: 80, rows: 24 });
    // Ответу прежнего дать дойти: микрозадачи промиса и эффекты.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(xtermMock.terminals[0]?.writes).toEqual(['СНИМОК-2']);
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

describe('раунд fix-main-r1: освобождение WebGL не роняет терминал', () => {
  /** Живой (не освобождённый) аддон WebGL, загруженный в этот xterm. */
  function liveWebgl(term: unknown): boolean {
    return xtermMock.terminals.some(
      (t, index) =>
        t === term &&
        xtermMock
          .callsOf('loadAddon', index)
          .some((call) => state.webglAddons.some((addon) => addon === call.args[0] && !addon.disposed)),
    );
  }

  it('dispose бросает — наружу ничего, xterm пересоздан на DOM и переподключён', async () => {
    const subscribe = vi.spyOn(webglPolicy, 'subscribe');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      state.webglDisposeThrows = true;
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: 'снимок', cols: 80, rows: 24 }));
      bridge.setHandler('pty.detach', () => ({ ok: true as const }));
      const sessionRef: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 'wg-throw' };
      const { result } = renderTerminal(bridge, sessionRef);
      await waitFor(() => expect(state.webglCreated).toBe(1));
      const listener = subscribe.mock.calls[0]?.[1];

      expect(() => act(() => listener?.(false))).not.toThrow();
      await waitFor(() => expect(xtermMock.terminals).toHaveLength(2));
      expect(xtermMock.terminals[0]?.disposed).toBe(true);
      const fresh = xtermMock.terminals[1];
      expect(fresh?.disposed).toBe(false);
      expect(result.current.terminal).toBe(fresh);
      // Новый xterm — на DOM-рендере: WebGL для этого ключа больше не просится.
      expect(state.webglCreated).toBe(1);
      await waitFor(() => expect(fresh?.writes).toContain('снимок'));
      expect(bridge.calls.filter((c) => c.method === 'pty.attach')).toHaveLength(2);
    } finally {
      subscribe.mockRestore();
      warn.mockRestore();
    }
  });

  it('повторное освобождение не зовёт dispose второй раз', async () => {
    const subscribe = vi.spyOn(webglPolicy, 'subscribe');
    try {
      const bridge = createFakeBridge();
      bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
      bridge.setHandler('pty.detach', () => ({ ok: true as const }));
      const { unmount } = renderTerminal(bridge, { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 'wg-twice' });
      await waitFor(() => expect(state.webglCreated).toBe(1));
      const listener = subscribe.mock.calls[0]?.[1];
      act(() => listener?.(false));
      act(() => listener?.(false));
      unmount();
      expect(state.webglDisposed).toBe(1);
    } finally {
      subscribe.mockRestore();
    }
  });

  /** Десять терминалов одной работы; клики по строкам сайдбара — следующий виден, прежний скрыт. */
  async function tenTerminals(prefix: string) {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    const hooks = Array.from({ length: 10 }, (_, i) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const sessionRef: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: `${prefix}-s${String(i + 1).padStart(2, '0')}` };
      return renderHook(
        ({ visible }: { visible: boolean }) =>
          useTerminal({ bridge, ref: sessionRef, container, fontFamily: 'Menlo', fontSize: 13, visible, ...surfaceOptions() }),
        { initialProps: { visible: i === 0 } },
      );
    });
    for (let i = 1; i < hooks.length; i += 1) {
      expect(() =>
        act(() => {
          hooks[i]?.rerender({ visible: true });
          hooks[i - 1]?.rerender({ visible: false });
        }),
      ).not.toThrow();
    }
    return hooks;
  }

  it('десять терминалов, скрываются s01…s09 по очереди: WebGL у s04…s09 и видимого', async () => {
    const hooks = await tenTerminals('wg-order');
    await waitFor(() => {
      const withWebgl = hooks.map((hook) => liveWebgl(hook.result.current.terminal));
      expect(withWebgl).toEqual([false, false, false, true, true, true, true, true, true, true]);
    });
  });

  it('то же, когда dispose бросает: наружу ничего, все десять xterm живы', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      state.webglDisposeThrows = true;
      const hooks = await tenTerminals('wg-throw10');
      await waitFor(() => {
        for (const hook of hooks) {
          const term = hook.result.current.terminal as unknown as { disposed: boolean } | null;
          expect(term?.disposed).toBe(false);
        }
      });
      // Сорванное освобождение — пересоздание на DOM: у вытесненного s01 WebGL больше нет.
      expect(liveWebgl(hooks[0]?.result.current.terminal)).toBe(false);
    } finally {
      warn.mockRestore();
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

describe('useTerminal — связь с хостом оборвалась (раунд lane-r3, п. 2)', () => {
  afterEach(() => {
    useHostStore.setState({ status: { state: 'connecting' } });
  });

  it('без связи ввод не уходит и не копится; после переподключения — новый снимок и ввод снова идёт', async () => {
    const bridge = createFakeBridge();
    let snapshot = 'ПЕРВЫЙ';
    bridge.setHandler('pty.attach', () => ({ snapshot, cols: 80, rows: 24 }));
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: null } });
    const { result } = renderTerminal(bridge);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['ПЕРВЫЙ']));
    const term = xtermMock.terminals[0]!;
    expect(result.current.offline).toBe(false);

    act(() => useHostStore.setState({ status: { state: 'disconnected', reason: 'Connection to host closed' } }));
    expect(result.current.offline).toBe(true);
    expect(term.options.disableStdin).toBe(true);
    act(() => term.onDataHandler?.('потеряно'));
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([]);

    snapshot = 'ВТОРОЙ';
    act(() => useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: null } }));
    await waitFor(() => expect(term.writes).toEqual(['ПЕРВЫЙ', 'ВТОРОЙ']));
    expect(bridge.calls.filter((c) => c.method === 'pty.attach')).toHaveLength(2);
    expect(result.current.offline).toBe(false);
    expect(term.options.disableStdin).toBe(false);

    act(() => term.onDataHandler?.('x'));
    // Набранное без связи не воспроизводится: уходит только новое нажатие.
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([{ method: 'pty.input', params: { ref, data: 'x' } }]);
  });

  it('невидимая вкладка после переподключения не цепляется к хосту', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: 'С', cols: 80, rows: 24 }));
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: null } });
    renderTerminal(bridge, ref, { visible: false });
    act(() => useHostStore.setState({ status: { state: 'disconnected', reason: 'closed' } }));
    act(() => useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods: null } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.calls.filter((c) => c.method === 'pty.attach')).toHaveLength(0);
  });
});

// Слияние lane-r3 и main-r2: у подключения вкладки три условия — видима, сессия жива (`running`)
// и связь с хостом есть. Экран неживой сессии держит последний вывод и после обрыва связи, и
// после «Restart host»: снимок пишется со сбросом, только когда он пришёл.
describe('useTerminal — связь и жизнь сессии вместе (слияние lane-r3 и main-r2)', () => {
  const online = { state: 'connected', hostVersion: '0.0.0-test', methods: null } as const;

  afterEach(() => {
    useHostStore.setState({ status: { state: 'connecting' } });
  });

  function renderWithRunning(bridge: FakeBridge, running: boolean) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return renderHook(
      (props: { running: boolean }) =>
        useTerminal({ bridge, ref, container, fontFamily: 'Menlo', fontSize: 13, running: props.running, ...surfaceOptions() }),
      { initialProps: { running } },
    );
  }

  const attaches = (bridge: FakeBridge): number => bridge.calls.filter((c) => c.method === 'pty.attach').length;
  const detaches = (bridge: FakeBridge): number => bridge.calls.filter((c) => c.method === 'pty.detach').length;

  it('агент вышел, потом связь оборвалась и вернулась — pty.attach нет, последний вывод на месте', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('pty.attach', () => ({ snapshot: 'ПОСЛЕДНИЙ ВЫВОД', cols: 80, rows: 24 }));
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    useHostStore.setState({ status: online });
    const { rerender } = renderWithRunning(bridge, true);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['ПОСЛЕДНИЙ ВЫВОД']));
    const term = xtermMock.terminals[0]!;

    rerender({ running: false });
    expect(detaches(bridge)).toBe(1);

    act(() => useHostStore.setState({ status: { state: 'disconnected', reason: 'Connection to host closed' } }));
    act(() => useHostStore.setState({ status: online }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attaches(bridge)).toBe(1);
    expect(term.resets).toBe(0);
    expect(term.writes).toEqual(['ПОСЛЕДНИЙ ВЫВОД']);
    expect(term.options.disableStdin).toBe(false);
  });

  it('новый хост после «Restart host»: снимок работ ещё прежний — not_found, экран цел; уснула — pty.detach; ожила — сброс и снимок нового процесса', async () => {
    const bridge = createFakeBridge();
    let ptyAlive = true;
    let snapshot = 'ДО РЕСТАРТА';
    bridge.setHandler('pty.attach', () => {
      if (!ptyAlive) throw { code: 'not_found', message: 'нет живого PTY для сессии s-01' };
      return { snapshot, cols: 80, rows: 24 };
    });
    bridge.setHandler('pty.detach', () => ({ ok: true as const }));
    useHostStore.setState({ status: online });
    const { rerender } = renderWithRunning(bridge, true);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['ДО РЕСТАРТА']));
    const term = xtermMock.terminals[0]!;

    act(() => useHostStore.setState({ status: { state: 'disconnected', reason: 'Connection to host closed' } }));
    ptyAlive = false;
    act(() => useHostStore.setState({ status: online }));
    await waitFor(() => expect(attaches(bridge)).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    // Отказ attach экран не трогает: последний вывод виден, пока не придёт свежий снимок работ.
    expect(term.resets).toBe(0);
    expect(term.writes).toEqual(['ДО РЕСТАРТА']);

    // Свежий снимок: сессия спит — отцепиться; Resume её оживил — новый процесс со сбросом экрана.
    rerender({ running: false });
    expect(detaches(bridge)).toBe(1);
    ptyAlive = true;
    snapshot = 'НОВЫЙ ПРОЦЕСС';
    rerender({ running: true });
    await waitFor(() => expect(term.writes).toEqual(['ДО РЕСТАРТА', 'НОВЫЙ ПРОЦЕСС']));
    expect(term.resets).toBe(1);
    expect(attaches(bridge)).toBe(3);
    expect(xtermMock.terminals).toHaveLength(1);
  });
});
