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
import { bufferKey } from '../files/buffer.js';
import { useFilesStore } from '../files/store.js';
import { useLayoutStore } from '../layout/store.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { lineFromText, xtermMock } from '../test-utils/xterm-mock.js';
import { TerminalSurface } from './TerminalSurface.js';
import { terminalSurfaces } from './surface-registry.js';

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

  it('отступ терминала — как в прототипе (22 24 16 24): скругление листа 28 не срезает первые и последние ячейки', () => {
    renderSurface();
    // Отступ на обёртке, а не на контейнере xterm: FitAddon меряет родителя терминала.
    const pad = screen.getByTestId('terminal-surface-pad');
    for (const token of ['pt-[22px]', 'pr-6', 'pb-4', 'pl-6']) expect(pad.classList.contains(token), token).toBe(true);
    expect(pad.classList.contains('p-1')).toBe(false);
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

  // ⌘F ловит обработчик окна (кусок 6.1b): действие `find` в `AppShell` зовёт openSearch() ручки
  // (тест 12 ниже и `AppShell.test.tsx`), своей ветки у xterm нет.
  it('⌘F в xterm сам полосу не открывает', async () => {
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    const handler = xtermMock.terminals[0]?.keyHandler;
    act(() => void handler?.(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })));
    expect(screen.queryByPlaceholderText('Find…')).toBeNull();
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

    it('клик — меню у курсора; ⌘-клик по пути файла — вкладка на строке (кусок 7.3b), по адресу — вкладка браузера (9.2b)', async () => {
      const key = workKey(ref.projectPath, ref.workId);
      useLayoutStore.setState({ activeWorkKey: key, layouts: { [key]: { root: { type: 'group', id: 'g1', tabs: [], activeTabId: null }, activeGroupId: 'g1', closedTabs: [] } }, hydrated: { [key]: true } });
      useFilesStore.setState({ buffers: {}, reveals: {} });
      bridge.setLocated(key, '/tmp/proj/src/a.ts', { ...located, root: { workKey: key, spec: { kind: 'project' } } });
      const link = await linkUnderPointer('at src/a.ts:12:3', key);

      act(() => link.activate(new MouseEvent('click', { clientX: 5, clientY: 6 }), link.text));
      expect(screen.getByRole('menuitem', { name: 'Open in default app' })).toBeTruthy();
      expect(bridge.openedPaths).toEqual([]);

      act(() => link.activate(new MouseEvent('click', { metaKey: true }), link.text));
      const layout = useLayoutStore.getState().layouts[key];
      expect(layout?.root.type === 'group' ? layout.root.activeTabId : null).toBe('file:p:src/a.ts');
      expect(useFilesStore.getState().reveals[bufferKey(key, 'file:p:src/a.ts')]).toEqual({ line: 12, col: 3 });
      expect(bridge.openedPaths).toEqual([]);

      cleanup();
      const url = await linkUnderPointer('go http://localhost:5173', key);
      act(() => url.activate(new MouseEvent('click', { metaKey: true }), url.text));
      const after = useLayoutStore.getState().layouts[key];
      const tabs = after?.root.type === 'group' ? after.root.tabs : [];
      expect(tabs.at(-1)).toMatchObject({ kind: 'browser', url: 'http://localhost:5173' });
      expect(after?.root.type === 'group' ? after.root.activeTabId : null).toBe(tabs.at(-1)?.id);
      expect(bridge.externalOpened).toEqual([]);
    });

    it('⌘-клик по каталогу — как прежде, app.openPath', async () => {
      const key = workKey(ref.projectPath, ref.workId);
      bridge.setLocated(key, '/tmp/proj/src/lib', { root: { workKey: key, spec: { kind: 'project' } }, relPath: 'src/lib', stat: { kind: 'dir', size: 0, mtimeMs: 0 } });
      const link = await linkUnderPointer('see ./src/lib', key);
      act(() => link.activate(new MouseEvent('click', { metaKey: true }), link.text));
      await waitFor(() => expect(bridge.openedPaths).toEqual(['/tmp/proj/src/lib']));
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

    it('картинка больше 20 МБ (drops:too-large) → свой тост, pty.send нет (fix-main-r1)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      bridge.setSaveDropImage({ code: 'drops:too-large', message: 'm' });
      const target = await mounted();
      expect(pasteImage(target)).toBe(false);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Image is larger than 20 MB — not sent'));
      expect(sends()).toEqual([]);
    });
  });
});

// Раунд main-r2, п. 2 (ревью 6.3-B, Important 2): после «Restart host» агент мёртв, а вкладка
// молчала пустым экраном. Неживая сессия — карточка «asleep» с Resume; ввод — тост.
describe('TerminalSurface — неживая сессия (раунд main-r2, п. 2)', () => {
  function withSession(patch: Parameters<typeof makeSession>[2], title = 'w-01', label = 'один'): void {
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/proj', title, sessions: [makeSession('s-01', label, patch)] })],
      branches: {},
      loading: false,
      error: null,
    });
  }

  it('sleeping — карточка asleep «S01 один · w-01» и Resume: sessions.resume с ref сессии', async () => {
    withSession({ lifecycle: 'sleeping' });
    const resumes: unknown[] = [];
    bridge.setHandler('sessions.resume', (params) => {
      resumes.push(params);
      return { ok: true as const };
    });
    renderSurface();
    const bar = screen.getByTestId('terminal-not-running');
    expect(bar.querySelector('[data-kicker]')?.textContent).toBe('asleep');
    expect(bar.textContent).toContain('S01 один · w-01');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resumes).toEqual([{ ref }]));
  });

  // Облик Organic (спека окна 2026-09-29, 1.8): неживая сессия — карточка на фоне окна с кикером
  // (`asleep`, `closed`, `not started` — капсом), названием, текстом, метой и главной кнопкой Resume.
  it('sleeping и closed: кикер asleep / closed (10px капсом, neutral-700), карточка на фоне окна, Resume — главная кнопка', () => {
    withSession({ lifecycle: 'sleeping' });
    const view = renderSurface();
    const bar = screen.getByTestId('terminal-not-running');
    const kicker = bar.querySelector('[data-kicker]');
    expect(kicker?.textContent).toBe('asleep');
    expect(kicker?.className).toContain('uppercase');
    expect(kicker?.className).toContain('text-neutral-700');
    expect(kicker?.className).not.toContain('text-accent-700');
    expect(bar.className).toContain('bg-background');
    expect(bar.className).toMatch(/\brounded-xl\b/);
    expect(bar.className).not.toMatch(/\brounded-md\b/);
    expect(bar.className).not.toMatch(/\bborder-b\b/);
    expect(bar.className).not.toMatch(/\bbg-card\b/);
    expect(screen.getByRole('button', { name: 'Resume' }).className).toContain('bg-primary');
    view.unmount();
    withSession({ lifecycle: 'closed' });
    renderSurface();
    expect(screen.getByTestId('terminal-not-running').querySelector('[data-kicker]')?.textContent).toBe('closed');
  });

  // Правки ревью куска 2 (находка 2): полоса с кикером и «S01 isn't running» — не карточка из 1.8. Карточка:
  // до 520px, padding 24, gap 12; кикер, название Caprasimo 20px `S04 тесты · Платежи`, задача 14px, мета.
  describe('карточка 1.8 — состав и геометрия', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-27T10:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('геометрия: до 520px, padding 24, gap 12, radius 32 (Card), не сжимается', () => {
      withSession({ lifecycle: 'pending', task: 'Написать тесты' }, 'Платежи', 'тесты');
      renderSurface();
      const bar = screen.getByTestId('terminal-not-running');
      for (const token of ['max-w-[520px]', 'p-6', 'gap-3', 'shrink-0', 'rounded-xl']) expect(bar.classList.contains(token), token).toBe(true);
    });

    it('название — Caprasimo 20px «S01 тесты · Платежи»; задача — 14px', () => {
      withSession({ lifecycle: 'pending', task: 'Написать тесты для платежей' }, 'Платежи', 'тесты');
      renderSurface();
      const title = screen.getByText('S01 тесты · Платежи');
      expect(title.className).toContain('font-heading');
      expect(title.className).toContain('text-xl');
      const task = screen.getByText('Написать тесты для платежей');
      expect(task.className).toContain('text-sm');
    });

    it('not started: кикер accent-700, мета — провайдер и путь брифа моноширинным, кнопки нет (метода запуска в протоколе нет)', () => {
      withSession({ lifecycle: 'pending', task: 'Написать тесты' }, 'Платежи', 'тесты');
      renderSurface();
      const bar = screen.getByTestId('terminal-not-running');
      expect(bar.querySelector('[data-kicker]')?.textContent).toBe('not started');
      expect(bar.querySelector('[data-kicker]')?.className).toContain('text-accent-700');
      const meta = screen.getByText('Claude Code · .harnas/works/w-01/briefs/s-01.md');
      expect(meta.className).toContain('font-mono');
      expect(meta.className).toContain('text-neutral-700');
      expect(screen.queryByRole('button')).toBeNull();
      expect(bar.textContent).not.toContain("isn't running");
    });

    it('asleep: текст — резюме агента, а не задача; мета «Claude Code · last event 3h ago» по последнему событию', () => {
      withSession({ lifecycle: 'sleeping', task: 'Написать тесты', summary: 'Готово: тесты зелёные', startedAt: '2026-09-27T07:00:00.000Z' }, 'Платежи', 'тесты');
      renderSurface();
      const bar = screen.getByTestId('terminal-not-running');
      expect(screen.getByText('Готово: тесты зелёные').className).toContain('text-sm');
      expect(bar.textContent).not.toContain('Написать тесты');
      const meta = screen.getByText('Claude Code · last event 3h ago');
      expect(meta.className).toContain('text-neutral-700');
      expect(meta.className).not.toContain('font-mono');
    });

    it('asleep без резюме — задача; событие только что — «now» без «ago»; провайдер из списка хоста — по его метке', () => {
      withSession({ lifecycle: 'sleeping', task: 'Написать тесты', resultAt: '2026-09-27T10:00:00.000Z', provider: 'gemini' }, 'Платежи', 'тесты');
      useProvidersStore.setState({ providers: [{ id: 'gemini', label: 'Gemini CLI', available: true, version: null }] });
      renderSurface();
      expect(screen.getByText('Написать тесты')).toBeTruthy();
      expect(screen.getByText('Gemini CLI · last event now')).toBeTruthy();
      useProvidersStore.setState({ providers: [] });
    });

    it('closed: кикер closed, текст и мета последнего события, без Resume', () => {
      withSession({ lifecycle: 'closed', task: 'Написать тесты', resultAt: '2026-09-27T09:57:00.000Z' }, 'Платежи', 'тесты');
      renderSurface();
      const bar = screen.getByTestId('terminal-not-running');
      expect(bar.querySelector('[data-kicker]')?.textContent).toBe('closed');
      expect(screen.getByText('Claude Code · last event 3m ago')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    });

    it('нет ни задачи, ни времени — только название и провайдер: пустого абзаца нет', () => {
      withSession({ lifecycle: 'sleeping' }, 'Платежи', 'тесты');
      renderSurface();
      const bar = screen.getByTestId('terminal-not-running');
      expect(bar.querySelectorAll('p')).toHaveLength(0);
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });

    // Review Focus 1: длинные значения не выталкивают карточку и кнопку за край.
    it('длинные название работы (120), метка (40) и задача: название переносится по словам, задача обрезается по строкам, Resume не сжимается', () => {
      const work = 'р'.repeat(120);
      const label = 'я'.repeat(40);
      withSession({ lifecycle: 'sleeping', task: 'т'.repeat(2000) }, work, label);
      renderSurface();
      const title = screen.getByText(`S01 ${label} · ${work}`);
      expect(title.className).toContain('break-words');
      expect(title.className).toContain('line-clamp-3');
      const task = screen.getByText('т'.repeat(2000));
      expect(task.className).toContain('line-clamp-4');
      expect(task.className).toContain('break-words');
      expect(task.getAttribute('title')).toBe('т'.repeat(2000));
      expect(screen.getByRole('button', { name: 'Resume' }).className).toContain('shrink-0');
    });
  });

  it('отказ sessions.resume — тост Couldn\'t resume session: …', async () => {
    withSession({ lifecycle: 'sleeping' });
    bridge.setHandler('sessions.resume', () => {
      throw { code: 'internal', message: 'сбой' };
    });
    renderSurface();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Couldn't resume session: host error."));
  });

  it('active — карточки нет; closed — карточка без Resume', () => {
    withSession({ lifecycle: 'active' });
    const view = renderSurface();
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();
    view.unmount();
    withSession({ lifecycle: 'closed' });
    renderSurface();
    expect(screen.getByTestId('terminal-not-running').querySelector('[data-kicker]')?.textContent).toBe('closed');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('ввод в неживую вкладку — тост с Resume одним экземпляром; в живую — без тоста', async () => {
    withSession({ lifecycle: 'sleeping' });
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    const terminal = xtermMock.terminals[0];
    act(() => terminal?.onDataHandler?.('x'));
    act(() => terminal?.onDataHandler?.('y'));
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith(
      "S01 isn't running",
      expect.objectContaining({ id: `not-running:${refKey(ref)}`, action: expect.objectContaining({ label: 'Resume' }) }),
    );

    vi.mocked(toast.error).mockClear();
    act(() => withSession({ lifecycle: 'active' }));
    act(() => terminal?.onDataHandler?.('z'));
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

describe('TerminalSurface — оживление сессии (раунд main-r2, п. 2)', () => {
  it('sleeping — pty.attach не зовётся; стала active — подключение без переключения вкладок', async () => {
    const put = (lifecycle: 'sleeping' | 'active'): void =>
      useWorksStore.setState({
        entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-01', 'один', { lifecycle })] })],
        branches: {},
        loading: false,
        error: null,
      });
    put('sleeping');
    renderSurface();
    await act(async () => {
      await Promise.resolve();
    });
    const attaches = (): number => bridge.calls.filter((entry) => entry.method === 'pty.attach').length;
    expect(attaches()).toBe(0);

    act(() => put('active'));
    await waitFor(() => expect(attaches()).toBe(1));
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();
  });
});

describe('TerminalSurface — без связи с хостом (раунд lane-r3, п. 2)', () => {
  it('обрыв — «Disconnected — reconnecting…» поверх терминала; связь вернулась — надпись ушла', async () => {
    renderSurface();
    await waitFor(() => expect(xtermMock.terminals[0]).toBeDefined());
    expect(screen.queryByTestId('terminal-offline')).toBeNull();

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    expect(screen.getByTestId('terminal-offline').textContent).toBe('Disconnected — reconnecting…');
    expect(screen.getByRole('status').textContent).toBe('Disconnected — reconnecting…');

    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
    expect(screen.queryByTestId('terminal-offline')).toBeNull();
  });
});

// Слияние lane-r3 и main-r2: «Restart host» — это обрыв связи и новый хост, у которого агента нет.
// Вкладка говорит одно за раз: без связи — «Disconnected — reconnecting…», со связью и неживой
// сессией — карточка «asleep» с Resume над последним выводом.
describe('TerminalSurface — связь и неживая сессия вместе (слияние lane-r3 и main-r2)', () => {
  const put = (lifecycle: 'sleeping' | 'active'): void =>
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-01', 'один', { lifecycle })] })],
      branches: {},
      loading: false,
      error: null,
    });
  const online = (): void => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] });
  const offline = (): void => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' });
  const inputs = (): unknown[] => bridge.notified.filter((call) => call.method === 'pty.input');
  const attaches = (): number => bridge.calls.filter((call) => call.method === 'pty.attach').length;
  const mountIdOf = (container: HTMLElement): string | undefined =>
    container.querySelector<HTMLElement>('[data-tab-id="terminal:s-01"]')?.dataset.mountId;

  it('Restart host: без связи — только «Disconnected», ввод никуда; новый хост — «isn\'t running» над последним выводом, ввод — тост; Resume — новый процесс в той же поверхности', async () => {
    let ptyAlive = true;
    let snapshot = 'ДО РЕСТАРТА';
    bridge.setHandler('pty.attach', () => {
      if (!ptyAlive) throw { code: 'not_found', message: 'нет живого PTY для сессии s-01' };
      return { snapshot, cols: 80, rows: 24 };
    });
    const resumes: unknown[] = [];
    bridge.setHandler('sessions.resume', (params) => {
      resumes.push(params);
      return { ok: true as const };
    });
    put('active');
    const { container } = renderSurface();
    const mountId = mountIdOf(container);
    await waitFor(() => expect(xtermMock.terminals[0]?.writes).toEqual(['ДО РЕСТАРТА']));
    const term = xtermMock.terminals[0]!;

    // Связь пропала: одна надпись, ввод не уходит и тоста нет.
    act(() => offline());
    expect(screen.getByTestId('terminal-offline').textContent).toBe('Disconnected — reconnecting…');
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();
    act(() => term.onDataHandler?.('x'));
    expect(inputs()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();

    // Новый хост без агента; снимок работ в первый миг прежний — attach отказал, экран цел.
    ptyAlive = false;
    act(() => online());
    expect(screen.queryByTestId('terminal-offline')).toBeNull();
    await waitFor(() => expect(attaches()).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.resets).toBe(0);
    expect(term.writes).toEqual(['ДО РЕСТАРТА']);

    // Свежий снимок работ: сессия спит — полоса с Resume, «Disconnected» нет; ввод — тост.
    act(() => put('sleeping'));
    expect(screen.getByTestId('terminal-not-running').querySelector('[data-kicker]')?.textContent).toBe('asleep');
    expect(screen.queryByTestId('terminal-offline')).toBeNull();
    act(() => term.onDataHandler?.('y'));
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "S01 isn't running",
      expect.objectContaining({ id: `not-running:${refKey(ref)}`, action: expect.objectContaining({ label: 'Resume' }) }),
    );

    // Resume → хост поднял агента → works.changed active → снимок нового процесса там же.
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resumes).toEqual([{ ref }]));
    ptyAlive = true;
    snapshot = 'НОВЫЙ ПРОЦЕСС';
    act(() => put('active'));
    await waitFor(() => expect(term.writes).toEqual(['ДО РЕСТАРТА', 'НОВЫЙ ПРОЦЕСС']));
    expect(term.resets).toBe(1);
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();
    expect(xtermMock.terminals).toHaveLength(1);
    expect(mountIdOf(container)).toBe(mountId);
  });

  it('сессия спала ещё до обрыва: без связи — только «Disconnected»; связь вернулась — снова полоса, pty.attach нет', async () => {
    put('sleeping');
    renderSurface();
    await waitFor(() => expect(xtermMock.terminals[0]).toBeDefined());
    expect(screen.getByTestId('terminal-not-running')).toBeTruthy();

    act(() => offline());
    expect(screen.getByTestId('terminal-offline')).toBeTruthy();
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();

    act(() => online());
    expect(screen.queryByTestId('terminal-offline')).toBeNull();
    expect(screen.getByTestId('terminal-not-running').querySelector('[data-kicker]')?.textContent).toBe('asleep');
    await act(async () => {
      await Promise.resolve();
    });
    expect(attaches()).toBe(0);
  });
});
