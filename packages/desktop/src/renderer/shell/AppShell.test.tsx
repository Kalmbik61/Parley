/**
 * Тесты 6, 9, 10, 13 куска 2.3: `AppShell` без работ показывает `Landing` в
 * центре (заголовок и строка статуса остаются), с работой — сайдбар и центр;
 * меню и кнопки заголовка/`Landing` открывают нужные диалоги; выбор в
 * `SessionPicker` зовёт `Workspace#openBeside`; меню `work-2` открывает
 * последнюю сессию второй по порядку работы.
 *
 * xterm подменён фейком, как в `Workspace.test.tsx` — реальный xterm рисует
 * в канву, которой в jsdom нет.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { AppShell } from './AppShell.js';

const state = vi.hoisted(() => ({ terminals: [] as unknown[] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((initialOptions: Record<string, unknown>) => {
    const instance = {};
    state.terminals.push(instance);
    return {
      cols: 80,
      rows: 24,
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
    };
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn().mockImplementation(() => ({ findNext: () => true })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function work(id: string, createdAt: string, title: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

let bridge: FakeBridge;

beforeEach(() => {
  state.terminals = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));

  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
    lastSessionByWork: {},
    activePanelId: null,
    visibleSessionRefs: {},
    recentSessionRefs: [],
    ui: DEFAULT_UI,
    uiLoaded: true,
    paletteOpen: false,
    picker: null,
  });
  useUiStore.getState().init(bridge);
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
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const STATUS = { state: 'connected' as const, hostVersion: '0.0.0-test' };

describe('AppShell — Landing и оболочка с работой (тест 6)', () => {
  it('без работ: Landing в центре, Titlebar и StatusBar на месте, баннер сразу после заголовка', async () => {
    bridge.setHandler('sessions.interrupted', () => ({
      refs: [{ projectPath: '/tmp/p', workId: 'w', sessionId: 's-09' }],
    }));

    const { container } = render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(screen.getByTestId('landing')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.getByTestId('titlebar')).toBeTruthy();
    expect(screen.getByText('Host 0.0.0-test')).toBeTruthy();

    const titlebar = screen.getByTestId('titlebar');
    expect(titlebar.parentElement).toBe(container.firstElementChild);
    expect(titlebar.nextElementSibling?.textContent).toContain('Interrupted');
  });

  it('с работой: сайдбар и центр вместо Landing', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(screen.queryByTestId('landing')).toBeNull();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.getByText('Первая')).toBeTruthy();
  });
});

describe('AppShell — меню и диалоги (тест 9)', () => {
  it('на Landing: кнопка «Новая работа» и меню new-work открывают NewWorkDialog; меню palette — CommandPalette', async () => {
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /New workspace/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New workspace')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();

    act(() => bridge.emitMenu('new-work'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await flush();

    act(() => bridge.emitMenu('palette'));
    expect(await screen.findByText('Command palette')).toBeTruthy();
  });

  it('подпись сочетания палитры — ⌘K и в заголовке, и на Landing; ⌘J нигде нет (до 6.2)', async () => {
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(screen.getAllByText('⌘K').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('⌘J')).toBeNull();
  });

  it('с работой: меню toggle-left-sidebar сворачивает сайдбар, «Поиск ⌘K» открывает палитру', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    expect(screen.getByText('Первая')).toBeTruthy();

    act(() => bridge.emitMenu('toggle-left-sidebar'));
    expect(screen.queryByText('Первая')).toBeNull();
    expect(useUiStore.getState().ui.leftSidebar.open).toBe(false);

    fireEvent.click(screen.getByText('Search'));
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });
});

describe('AppShell — SessionPicker (тест 10)', () => {
  it('выбор кандидата в SessionPicker зовёт Workspace#openBeside — открывает вторую сессию', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план'), session('s-02', 'бэкенд')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    const { container } = render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    const row = container.querySelector('[data-session-id="s-01"]');
    if (row === null) throw new Error('строка сессии s-01 не найдена');
    fireEvent.click(row);
    await flush();

    act(() => bridge.emitMenu('split-right'));
    await flush();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('S02 бэкенд'));
    await flush();

    expect(state.terminals).toHaveLength(2);
  });
});

describe('AppShell — меню work-2 (тест 13)', () => {
  it('открывает последнюю сессию второй по порядку создания работы', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'бэк'), session('s-03', 'фронт')]);
    useWorksStore.setState({ entries: [w2, w1], branches: {}, loading: false, error: null });
    useUiStore.setState({ lastSessionByWork: { '/tmp/w-02 w-02': 's-03' } });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    act(() => bridge.emitMenu('work-2'));
    await flush();

    expect(
      bridge.calls.some(
        (call) => call.method === 'pty.attach' && (call.params as { ref: { sessionId: string } }).ref.sessionId === 's-03',
      ),
    ).toBe(true);
  });
});
