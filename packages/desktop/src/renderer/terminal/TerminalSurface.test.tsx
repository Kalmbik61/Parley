/**
 * `TerminalSurface` сама по себе (кусок 2.5): на меню `find` не подписана —
 * полосу открывает `openSearch()` ручки из `terminalSurfaces`; Enter —
 * `findNext`, Esc закрывает; корень несёт `data-tab-id`/`data-mount-id` и
 * якорь `--g-<groupId>`. Сценарии слоя (перенос, видимость, граница ошибки) —
 * в `layout/SurfaceLayer.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ILink } from '@xterm/xterm';
import { refKey, type SessionRef } from '@harnas/protocol';
import { toast } from 'sonner';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { lineFromText, xtermMock } from '../test-utils/xterm-mock.js';
import { TerminalSurface, terminalSurfaces } from './TerminalSurface.js';

const state = vi.hoisted(() => ({ xtermPaste: vi.fn() }));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', async () => (await import('../test-utils/xterm-mock.js')).searchModule);
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
let offHost: () => void = () => {};

beforeEach(() => {
  xtermMock.reset();
  useWorksStore.setState(useWorksStore.getInitialState(), true);
  state.xtermPaste.mockClear();
  // Как у настоящего xterm: скрытое поле ввода внутри контейнера со своим обработчиком paste.
  xtermMock.onOpen = (el) => {
    const textarea = document.createElement('textarea');
    textarea.dataset.testid = 'xterm-textarea';
    textarea.addEventListener('paste', state.xtermPaste);
    el.appendChild(textarea);
  };
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  // useHostSupports читает стор хоста: статус подставного моста — через init, как у App.
  offHost = useHostStore.getState().init(bridge);
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  offHost();
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

  it('тест 12: openSearch() ручки — SearchBar с фокусом в поле, Enter — findNext, Esc закрывает и фокус в терминал', async () => {
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
    expect(xtermMock.callsOf('findNext').map((call) => call.args[0])).toEqual(['hello']);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
    expect(xtermMock.callsOf('focus', 0)).toHaveLength(1);

    handle.focus();
    handle.scrollToBottom();
    expect(xtermMock.callsOf('focus', 0)).toHaveLength(2);
    expect(xtermMock.callsOf('scrollToBottom', 0)).toHaveLength(1);
    expect(handle.search).not.toBeNull();
  });

  it('тест 12: clear() ручки зовёт term.clear, pty.input нет', async () => {
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    terminalSurfaces.get(refKey(ref))?.clear();
    expect(xtermMock.callsOf('clear', 0)).toHaveLength(1);
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([]);
  });

  it('⌘F в терминале открывает полосу своей поверхности', async () => {
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    const handler = xtermMock.terminals[0]?.keyHandler;
    act(() => void handler?.(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })));
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Find…'));
  });

  describe('ссылки (кусок 5.3)', () => {
    const located = { root: { workKey: '', spec: { kind: 'project' as const } }, relPath: 'src/a.ts', stat: { kind: 'file' as const, size: 1, mtimeMs: 0 } };

    async function linkUnderPointer(text: string, key: string): Promise<ILink> {
      renderSurface();
      await act(async () => {
        await Promise.resolve();
      });
      const term = xtermMock.terminals[0];
      term?.setLines([lineFromText(text)]);
      const links = await new Promise<ILink[] | undefined>((resolve) => term?.linkProviders[0]?.provideLinks(1, resolve));
      const link = links?.[0];
      if (link === undefined) throw new Error(`нет ссылки в ${text} (${key})`);
      return link;
    }

    it('cwd — worktree сессии, workKey — работы терминала', async () => {
      const key = workKey(ref.projectPath, ref.workId);
      useWorksStore.setState({
        entries: [
          makeWork(ref.workId, {
            projectPath: ref.projectPath,
            sessions: [makeSession(ref.sessionId, 'a', { worktree: { path: '/wt/s-01', branch: 'b', base: 'main', createdAt: '2026-09-27T00:00:00Z' } })],
          }),
        ],
      });
      bridge.setLocated(key, '/wt/s-01/src/a.ts', { ...located, root: { workKey: key, spec: { kind: 'worktree', sessionId: ref.sessionId } } });
      const link = await linkUnderPointer('at src/a.ts:3', key);
      expect(bridge.locateCalls).toEqual([{ workKey: key, absPaths: ['/wt/s-01/src/a.ts'] }]);
      expect(link.text).toBe('src/a.ts:3');
    });

    it('клик — меню у курсора; ⌘-клик по пути — app.openPath, по адресу — openExternal', async () => {
      const key = workKey(ref.projectPath, ref.workId);
      bridge.setLocated(key, '/tmp/proj/src/a.ts', { ...located, root: { workKey: key, spec: { kind: 'project' } } });
      const link = await linkUnderPointer('at src/a.ts', key);

      act(() => link.activate(new MouseEvent('click', { clientX: 5, clientY: 6 }), link.text));
      expect(screen.getByRole('menuitem', { name: 'Open in default app' })).toBeTruthy();
      expect(bridge.openedPaths).toEqual([]);

      act(() => link.activate(new MouseEvent('click', { metaKey: true }), link.text));
      await waitFor(() => expect(bridge.openedPaths).toEqual(['/tmp/proj/src/a.ts']));

      cleanup();
      const url = await linkUnderPointer('go https://example.com/x', key);
      act(() => url.activate(new MouseEvent('click', { metaKey: true }), url.text));
      expect(bridge.externalOpened).toEqual(['https://example.com/x']);
    });
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
      expect(xtermMock.callsOf('paste').map((call) => call.args)).toEqual([['ab']]);
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });

    it('обычный текст с \\t, \\n, \\r уходит без изменений', async () => {
      await pasteText('line 1\tx\r\nline 2\n');
      expect(xtermMock.callsOf('paste').map((call) => call.args)).toEqual([['line 1\tx\r\nline 2\n']]);
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });

    it('пустой после чистки текст — ничего не вставляется', async () => {
      await pasteText('\x1b\x07\x7f\x1b[200~');
      expect(xtermMock.callsOf('paste')).toEqual([]);
      expect(state.xtermPaste).not.toHaveBeenCalled();
    });
  });

  describe('файлы и скриншоты (кусок 5.4)', () => {
    async function mounted(): Promise<HTMLElement> {
      renderSurface();
      await act(async () => {
        await Promise.resolve();
      });
      return screen.getByTestId('xterm-textarea');
    }

    function sends(): unknown[] {
      return bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params);
    }

    function inputs(): unknown[] {
      return bridge.notified.filter((call) => call.method === 'pty.input');
    }

    /** Вставка картинки без текста: как у ⌘V со скриншотом в буфере. */
    function pasteImage(target: HTMLElement): boolean {
      return fireEvent.paste(target, {
        clipboardData: { items: [{ kind: 'file', type: 'image/png' }], types: ['Files'], getData: () => '', files: [] },
      });
    }

    const files = (): { types: string[]; files: File[] } => ({
      types: ['Files'],
      files: [new File(['a'], 'a b.txt'), new File(['b'], "it's.png"), new File(['c'], '')],
    });

    it('тест 5: drop двух файлов → один pty.send с submit: false и экранированными путями; пустой путь пропущен', async () => {
      bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: null }));
      const target = await mounted();
      expect(fireEvent.dragOver(target, { dataTransfer: files() })).toBe(false);
      expect(fireEvent.drop(target, { dataTransfer: files() })).toBe(false);
      await waitFor(() => expect(sends()).toHaveLength(1));
      expect(sends()).toEqual([{ ref, text: "'/fake/a b.txt' '/fake/it'\\''s.png' ", submit: false }]);
      // Успех без Enter — тоста нет: путь и так виден в поле ввода.
      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('тест 5: dragover без Files в dataTransfer.types — бросок не принят', async () => {
      const target = await mounted();
      expect(fireEvent.dragOver(target, { dataTransfer: { types: ['text/plain', 'text/uri-list'], files: [] } })).toBe(true);
    });

    it('тест 5: хост без pty.send — бросок не принят, вставка картинки не перехвачена', async () => {
      const target = await mounted();
      act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'pty.send')));
      expect(fireEvent.dragOver(target, { dataTransfer: files() })).toBe(true);
      fireEvent.drop(target, { dataTransfer: files() });
      expect(pasteImage(target)).toBe(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(sends()).toEqual([]);
      expect(bridge.saveDropImageCalls).toEqual([]);
      expect(state.xtermPaste).toHaveBeenCalledTimes(1);
    });

    it('тест 6: картинка без текста → pty.send с путём в кавычках и пробелом, preventDefault; xterm и pty.input не видят вставки', async () => {
      bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: null }));
      bridge.setSaveDropImage('/h/drops/a b.png');
      const target = await mounted();
      expect(pasteImage(target)).toBe(false);
      await waitFor(() => expect(sends()).toHaveLength(1));
      expect(sends()).toEqual([{ ref, text: "'/h/drops/a b.png' ", submit: false }]);
      expect(bridge.saveDropImageCalls).toEqual(['clipboard']);
      expect(state.xtermPaste).not.toHaveBeenCalled();
      expect(xtermMock.callsOf('paste')).toEqual([]);
      expect(inputs()).toEqual([]);
    });

    it('тест 6: вставка с текстом — картинку не сохраняет, текст идёт в xterm как прежде (5.1)', async () => {
      const target = await mounted();
      fireEvent.paste(target, {
        clipboardData: {
          items: [
            { kind: 'string', type: 'text/plain' },
            { kind: 'file', type: 'image/png' },
          ],
          types: ['text/plain', 'Files'],
          getData: (type: string) => (type === 'text/plain' ? 'hello' : ''),
          files: [],
        },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(bridge.saveDropImageCalls).toEqual([]);
      expect(xtermMock.callsOf('paste').map((call) => call.args)).toEqual([['hello']]);
      expect(sends()).toEqual([]);
    });

    it('тест 6: картинки нет (saveDropImage → null) — ни отправки, ни тоста', async () => {
      bridge.setSaveDropImage(null);
      const target = await mounted();
      expect(pasteImage(target)).toBe(false);
      await waitFor(() => expect(bridge.saveDropImageCalls).toEqual(['clipboard']));
      await act(async () => {
        await Promise.resolve();
      });
      expect(sends()).toEqual([]);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("тест 6: saveDropImage отказал → тост Couldn't save screenshot: failed., pty.send нет", async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      bridge.setSaveDropImage({ code: 'failed', message: 'm' });
      const target = await mounted();
      expect(pasteImage(target)).toBe(false);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save screenshot: failed."));
      expect(sends()).toEqual([]);
      expect(inputs()).toEqual([]);
    });
  });
});
