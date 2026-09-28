/**
 * Кусок 7.2, тесты 9 и 6: правый сайдбар в оболочке — ⌘L и ⌘⇧E, ширина и вкладка через
 * `setSidebar`, без активной работы его нет; клик по файлу дерева открывает вкладку `file` с
 * текстом только для чтения, ⌘-клик — сплит справа.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@harnas/core';
import type { DirEntry, FileRoot, TextFile } from '../../shared/files-types.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useFilesStore } from '../files/store.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { AppShell } from './AppShell.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
// У jsdom раскладки нет: без размеров групп «Open to the side» отказал бы как «мало места».
vi.mock('../layout/measure.js', () => ({
  measureGroupSizes: () => new Proxy({}, { get: () => ({ width: 2000, height: 2000 }) }),
}));
vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);
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

const STATUS = { state: 'connected' as const, hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] };
const WORKTREE = { path: '/wt/s02', branch: 'harnas/w-0001/s02', base: 'main', createdAt: '2026-09-27T08:00:00.000Z' };
const KEY = '/tmp/proj w-01';
const DIFF = {
  patch: '',
  files: [],
  uncommitted: false,
  baseCheckout: '/tmp/proj',
  baseDirty: false,
  mergeBase: 'a'.repeat(40),
  stats: { additions: 0, deletions: 0 },
  commits: [],
  uncommittedPaths: [],
};
const ENTRY: WorkEntry = makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-02', 'two', { worktree: WORKTREE })] });

function dirEntry(name: string, kind: DirEntry['kind'] = 'file'): DirEntry {
  return { name, kind, size: 1, mtimeMs: 1, ignored: false, target: null };
}

function textFile(text: string): TextFile {
  return { text, mtimeMs: 1, size: text.length, binary: false, utf8: true, readOnlyReason: null };
}

let bridge: FakeBridge;

beforeEach(() => {
  xtermMock.reset();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useFilesStore.setState({ rootByWork: {}, expanded: {} });
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true, visibleSessionRefs: {} });
  useUiStore.getState().init(bridge);
  useHostStore.getState().init(bridge);
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useHostStore.setState({ status: { state: 'connecting' } });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderShell(entries: WorkEntry[]): Promise<void> {
  useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
  render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
  await flush();
  if (entries.length > 0) {
    await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).toBe(KEY));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[KEY]).toBe(true));
  }
  await flush();
}

function press(key: string, shift = false): void {
  fireEvent.keyDown(window, { key, code: `Key${key.toUpperCase()}`, metaKey: true, shiftKey: shift });
}

const sidebar = (): HTMLElement | null => document.querySelector('[data-testid="right-sidebar"]');

describe('RightSidebar (тест 9)', () => {
  it('⌘L открывает и закрывает; ⌘⇧E при закрытом открывает на Files, при открытом — не прячет', async () => {
    await renderShell([ENTRY]);
    expect(sidebar()).not.toBeNull();

    act(() => press('l'));
    expect(sidebar()).toBeNull();
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(false);
    act(() => press('l'));
    expect(sidebar()).not.toBeNull();

    act(() => press('l'));
    act(() => useUiStore.getState().setSidebar('right', { tab: 'changes' }));
    act(() => press('e', true));
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'files' });
    act(() => press('e', true));
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(true);
    expect(sidebar()).not.toBeNull();
  });

  it('ширина уходит на pointerup целым rightSidebar; вкладка — setSidebar(tab); tab: changes показывает Changes (8.2b)', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, rightSidebar: { open: true, width: 350, tab: 'changes' } } });
    bridge.setHandler('worktrees.diff', () => DIFF);
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    await renderShell([ENTRY]);

    expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('changes-panel')).toBeTruthy();
    const tab = screen.getByRole('tab', { name: 'Files' });
    fireEvent.click(tab);
    expect(saveUi).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 350, tab: 'files' } });
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('changes-panel')).toBeNull();

    const handle = sidebar()?.previousElementSibling?.querySelector('[role="separator"]');
    if (handle === null || handle === undefined) throw new Error('нет ручки');
    fireEvent.pointerDown(handle, { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 650, pointerId: 1 });
    expect(saveUi).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(handle, { clientX: 650, pointerId: 1 });
    expect(saveUi).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 400, tab: 'files' } });
  });

  it('⌘⇧G открывает правый сайдбар на Changes; открытый не прячет (тест 11 куска 8.2b)', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, rightSidebar: { open: false, width: 350, tab: 'files' } } });
    bridge.setHandler('worktrees.diff', () => DIFF);
    await renderShell([ENTRY]);
    act(() => {
      useLayoutStore.getState().apply(KEY, (layout) => openTab(layout, { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }));
    });
    expect(sidebar()).toBeNull();
    act(() => press('g', true));
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'changes' });
    expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
    act(() => press('g', true));
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(true);
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'worktrees.diff')).toBe(true));
  });

  it('без активной работы сайдбара нет, Right sidebar в заголовке неактивна', async () => {
    await renderShell([]);
    expect(screen.getByTestId('landing')).toBeTruthy();
    expect(sidebar()).toBeNull();
    expect((screen.getByLabelText('Right sidebar') as HTMLButtonElement).disabled).toBe(true);
  });
});

// Раунд main-r2, п. 7 (ревью 7.2-A, Important 3): окно 800 px с обоими сайдбарами оставляло
// центру ~170 px. Правый не оставляет центру меньше reserveCenter; не влезает — скрыт на время.
describe('правый сайдбар и ширина окна (раунд main-r2, п. 7)', () => {
  function resizeWindow(width: number): void {
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.dispatchEvent(new Event('resize'));
    });
  }

  afterEach(() => resizeWindow(1024));

  it('800 px, левый 280 — правый скрыт, open в ui.json прежний; окно шире — вернулся', async () => {
    resizeWindow(800);
    await renderShell([ENTRY]);
    expect(sidebar()).toBeNull();
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(true);

    resizeWindow(1400);
    expect(sidebar()).not.toBeNull();
    expect(sidebar()?.style.width).toBe('350px');
  });

  it('ширина ужимается до места: 900 px, сохранено 500 — показано 300', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, rightSidebar: { open: true, width: 500, tab: 'files' } } });
    resizeWindow(900);
    await renderShell([ENTRY]);
    expect(sidebar()?.style.width).toBe('300px');
    expect(useUiStore.getState().ui.rightSidebar.width).toBe(500);
  });

  it('⌘L и ⌘⇧E без места — тост, open не меняется', async () => {
    vi.mocked(toast).mockClear();
    useUiStore.setState({ ui: { ...DEFAULT_UI, rightSidebar: { open: false, width: 350, tab: 'files' } } });
    resizeWindow(800);
    await renderShell([ENTRY]);
    act(() => press('l'));
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Not enough room for the right sidebar');
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(false);
    act(() => press('e', true));
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().ui.rightSidebar.open).toBe(false);
    expect(sidebar()).toBeNull();
  });
});

describe('клик по файлу дерева (тест 6)', () => {
  const root: FileRoot = { workKey: KEY, spec: { kind: 'worktree', sessionId: 's-02' } };

  it('клик открывает вкладку file:w:s-02:src/a.ts с текстом только для чтения; ⌘-клик — сплит справа', async () => {
    // Корень по умолчанию — worktree сессии в фокусе: открыт её терминал.
    bridge.setDir(root, '', [dirEntry('src', 'dir')]);
    bridge.setDir(root, 'src', [dirEntry('a.ts'), dirEntry('b.ts')]);
    bridge.setFile(root, 'src/a.ts', textFile('export const a = 1;\n'));
    bridge.setFile(root, 'src/b.ts', textFile('export const b = 2;\n'));
    await renderShell([ENTRY]);
    act(() => {
      useLayoutStore.getState().apply(KEY, (layout) => openTab(layout, { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }));
    });

    fireEvent.click(await screen.findByText('src'));
    fireEvent.click(await screen.findByText('a.ts'));
    await waitFor(() => expect((screen.getByTestId('monaco-textarea') as HTMLTextAreaElement).value).toBe('export const a = 1;\n'));
    expect(screen.queryByText("Couldn't show layout")).toBeNull();
    const layout = useLayoutStore.getState().layouts[KEY];
    if (layout === undefined) throw new Error('нет раскладки');
    expect(groups(layout)).toHaveLength(1);
    expect(groups(layout)[0]?.activeTabId).toBe('file:w:s-02:src/a.ts');
    // Фокус на вкладке файла корень не сбрасывает: дерево то же.
    expect(screen.getByText('b.ts')).toBeTruthy();

    fireEvent.click(screen.getByText('b.ts'), { metaKey: true });
    await flush();
    const split = useLayoutStore.getState().layouts[KEY];
    if (split === undefined) throw new Error('нет раскладки');
    expect(groups(split)).toHaveLength(2);
    expect(groups(split)[1]?.tabs.map((tab) => tab.id)).toEqual(['file:w:s-02:src/b.ts']);
    expect(split.activeGroupId).toBe(groups(split)[1]?.id);
  });
});
