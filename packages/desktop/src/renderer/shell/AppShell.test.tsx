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

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import type { LayoutNode, TabSpec } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups, openTab, splitGroup } from '../layout/tree.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { AppShell } from './AppShell.js';

// Тесты 10, 13, 14, 15 куска 2.4 (`?center=new`) зовут `toast` и из `AppShell.tsx`
// (отказ сплита), и из `layout/Tab.tsx` (закрытие вкладки) — без смонтированного
// `ui/sonner.tsx#Toaster` (тот живёт в `App.tsx`, не в `AppShell.tsx`) настоящий
// `sonner` просто не рисует ничего; здесь он подменён, чтобы проверить сам вызов.
vi.mock('sonner', () => ({ toast: vi.fn() }));

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

/** Вкладка терминала по id сессии — короче, чем писать `TabSpec` литералом на каждый вызов (тесты 10, 13, 14 куска 2.4). */
function term(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

/**
 * `getBoundingClientRect` без подмены в jsdom отдаёт нули — `splitGroup` тогда
 * всегда отказал бы «слишком мало места» (тесты 10, 13, 14 куска 2.4). Спай
 * запоминается в `rectSpy` и снимается точечно в `afterEach` — общий
 * `vi.restoreAllMocks()` тут не годится: он стёр бы и `.mockImplementation`
 * фабрики `vi.mock('@xterm/xterm', …)` выше (она вызывается один раз при
 * загрузке модуля), и следующий тест в файле получил бы `Terminal`, теряющий
 * свою реализацию.
 */
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockNonZeroRects(): void {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
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
  rectSpy?.mockRestore();
  rectSpy = null;
  // Тесты `?center=new` (куска 2.4) переставляют `location.search` — не должно
  // протечь в соседние тесты этого файла, которые проверяют старый центр.
  window.history.pushState(null, '', '/');
});

/** `?center=new` читается `AppShell` из `location.search` при монтировании (кусок 2.4) — переставить ДО `render`. */
function setCenterNewFlag(): void {
  window.history.pushState(null, '', '/?center=new');
}

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

  // Раунд исправлений 1 куска E.1 (ревью линза A, Critical): HostNotice.text
  // хост пишет по-русски и не переводит (сквозное правило) — строка статуса
  // обязана показывать noticeText(notice, label) по коду, а не notice.text.
  it('строка статуса переводит уведомление хоста по коду, не показывает русский notice.text', async () => {
    useNoticesStore.setState({
      notices: [
        {
          kind: 'trust-wait',
          ref: null,
          text: 'русский текст хоста, который никто не должен увидеть',
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(screen.getByText('Not responding since launch — may be waiting for folder trust.')).toBeTruthy();
    expect(screen.queryByText(/русский/)).toBeNull();
  });

  it('строка статуса подставляет ярлык сессии, когда находит её в снимке работ', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-03', 'бэкенд')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    useNoticesStore.setState({
      notices: [
        {
          kind: 'trust-wait',
          ref: { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
          text: 'русский',
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(
      screen.getByText('S03 бэкенд: not responding since launch — may be waiting for folder trust.'),
    ).toBeTruthy();
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

describe('AppShell — ?center=new, activeWorkKey ещё не выбран (тест 15 куска 2.4)', () => {
  it('LayoutView не смонтирован, #titlebar-tabs пуст, пока работы есть, а активная работа ещё не выбрана', () => {
    setCenterNewFlag();
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    const { container } = render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);

    // Синхронно сразу после рендера — до того, как `layout/persistence.ts`
    // успел разрешить свой `bridge.app.loadUi()` (микротаск) и сам выбрать
    // активную работу: ровно сценарий теста («работы есть, activeWorkKey: null»).
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(container.querySelector('[data-group-id]')).toBeNull();
    expect(document.getElementById('titlebar-tabs')?.childElementCount ?? 0).toBe(0);
  });
});

describe('AppShell — ?center=new: сплит и палитра (тест 13 куска 2.4)', () => {
  it('Workspace не смонтирован; split-right без уже открытых; выбор — вторая группа; «+» открывает палитру', async () => {
    setCenterNewFlag();
    mockNonZeroRects();

    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план'), session('s-02', 'бэкенд')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    const workKey1 = '/tmp/w-01 w-01';

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey1]).toBe(true));

    // Первая сессия уже открыта — как если бы её открыл сайдбар (вход подключит 2.5);
    // тут — напрямую в сторе, других путей открыть первую вкладку в этом куске нет.
    useLayoutStore.getState().apply(workKey1, (layout) => openTab(layout, term('s-01')));
    await flush();
    expect(useLayoutStore.getState().layouts[workKey1] && groups(useLayoutStore.getState().layouts[workKey1]!)).toHaveLength(1);
    // Одна группа — тест 1: её строка вкладок стоит в заголовке, не в теле.
    expect(document.getElementById('titlebar-tabs')?.querySelector('[data-tab-id]')).not.toBeNull();

    act(() => bridge.emitMenu('split-right'));
    await flush();

    const dialog = await screen.findByRole('dialog');
    // «без уже открытых» (спека 5.2): s-01 уже открыта — кандидат только s-02.
    expect(within(dialog).queryByText(/S01/)).toBeNull();
    fireEvent.click(within(dialog).getByText('S02 бэкенд'));
    await flush();

    const layout = useLayoutStore.getState().layouts[workKey1];
    if (layout === undefined) throw new Error('раскладка не гидрирована');
    expect(groups(layout)).toHaveLength(2);
    // Две группы — LayoutView отрисовал их сам, а не прежний Workspace/dockview
    // (тест 1: «слот заголовка пуст», когда групп несколько; отдельная строка на
    // каждую группу — `[data-group-id]` их обеих).
    expect(document.querySelectorAll('[data-group-id]')).toHaveLength(2);
    expect(document.getElementById('titlebar-tabs')?.childElementCount ?? 0).toBe(0);
    expect(document.querySelector('.dockview-theme-harnas')).toBeNull();

    // «+» строки вкладок (теперь их две — групп несколько) открывает палитру.
    fireEvent.click(screen.getAllByLabelText('Open…')[0]!);
    expect(await screen.findByText('Command palette')).toBeTruthy();
  });
});

/** Сосед узла `id` в дереве раскладки — та же идея, что и приватный `findSibling` в `layout/tree.ts`, но тут только для проверки теста. */
function siblingGroupId(root: LayoutNode, id: string): string | null {
  if (root.type === 'group') return null;
  const [a, b] = root.children;
  if (a.id === id) return b.type === 'group' ? b.id : null;
  if (b.id === id) return a.type === 'group' ? a.id : null;
  return siblingGroupId(a, id) ?? siblingGroupId(b, id);
}

describe('AppShell — ?center=new: разделение из меню вкладки неактивной группы (тест 14 куска 2.4)', () => {
  it('«Разделить вправо» на вкладке неактивной группы делит ЕЁ группу; прежняя активная группа не тронута', async () => {
    setCenterNewFlag();
    mockNonZeroRects();

    const w1 = work('w-01', '2026-01-01', 'Первая', [
      session('s-01', 'план'),
      session('s-02', 'бэкенд'),
      session('s-03', 'ревью'),
    ]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    const workKey1 = '/tmp/w-01 w-01';

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey1]).toBe(true));

    // G1 = [s-01], потом сплит на G2 = [s-02] — активная становится G2 (splitGroup
    // делает активной новую группу), G1 остаётся неактивной.
    useLayoutStore.getState().apply(workKey1, (layout) => openTab(layout, term('s-01')));
    await flush();
    const g1Id = useLayoutStore.getState().layouts[workKey1]?.activeGroupId;
    if (g1Id === undefined) throw new Error('нет активной группы после openTab');
    useLayoutStore.getState().apply(workKey1, (layout) => splitGroup(layout, g1Id, 'row', term('s-02'), { [g1Id]: { width: 800, height: 600 } }));
    await flush();

    const beforeLayout = useLayoutStore.getState().layouts[workKey1];
    if (beforeLayout === undefined) throw new Error('раскладка пропала');
    expect(beforeLayout.activeGroupId).not.toBe(g1Id);

    // Правый клик по ВКЛАДКЕ s-01 (в НЕАКТИВНОЙ G1), не по её строке в сайдбаре —
    // «S01 план» видно в обоих местах разом, вкладка отличается `data-tab-id`.
    const s01Tab = document.querySelector(`[data-tab-id="${tabId.terminal('s-01')}"]`);
    if (s01Tab === null) throw new Error('вкладка s-01 не найдена');
    fireEvent.contextMenu(s01Tab);
    fireEvent.click(screen.getByText('Split right'));
    await flush();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('S03 ревью'));
    await flush();

    const afterLayout = useLayoutStore.getState().layouts[workKey1];
    if (afterLayout === undefined) throw new Error('раскладка пропала');
    expect(groups(afterLayout)).toHaveLength(3);

    const g1After = groups(afterLayout).find((group) => group.tabs.some((t) => t.id === tabId.terminal('s-01')));
    const g2After = groups(afterLayout).find((group) => group.tabs.some((t) => t.id === tabId.terminal('s-02')));
    const g3After = groups(afterLayout).find((group) => group.tabs.some((t) => t.id === tabId.terminal('s-03')));

    // Прежняя активная группа (s-02) ровно та же самая и не тронута.
    expect(g2After?.id).toBe(beforeLayout.activeGroupId);
    expect(g2After?.tabs.map((t) => t.id)).toEqual([tabId.terminal('s-02')]);
    // g1 — та же группа, что и раньше (не пересоздана), рядом с ней теперь s-03.
    expect(g1After?.id).toBe(g1Id);
    expect(g1After?.tabs.map((t) => t.id)).toEqual([tabId.terminal('s-01')]);
    expect(g3After?.tabs.map((t) => t.id)).toEqual([tabId.terminal('s-03')]);
    expect(siblingGroupId(afterLayout.root, g1Id)).toBe(g3After?.id);
  });
});

describe('AppShell — ?center=new: отказ сплита при 8 группах (тест 10 куска 2.4)', () => {
  it('9-я группа — тост «No more than 8 groups per workspace», раскладка не меняется', async () => {
    setCenterNewFlag();
    mockNonZeroRects();

    const sessions = Array.from({ length: 9 }, (_, i) => session(`s-0${i + 1}`, `session ${i + 1}`));
    const w1 = work('w-01', '2026-01-01', 'Первая', sessions);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    const workKey1 = '/tmp/w-01 w-01';

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey1]).toBe(true));

    useLayoutStore.getState().apply(workKey1, (layout) => openTab(layout, term('s-01')));
    await flush();
    for (let i = 1; i < 8; i += 1) {
      const current = useLayoutStore.getState().layouts[workKey1];
      if (current === undefined) throw new Error('раскладка пропала');
      const sizes = Object.fromEntries(groups(current).map((group) => [group.id, { width: 800, height: 600 }]));
      useLayoutStore.getState().apply(workKey1, (layout) => splitGroup(layout, current.activeGroupId, 'row', term(`s-0${i + 1}`), sizes));
      await flush();
    }
    const eightGroups = useLayoutStore.getState().layouts[workKey1];
    if (eightGroups === undefined) throw new Error('раскладка пропала');
    expect(groups(eightGroups)).toHaveLength(8);

    act(() => bridge.emitMenu('split-right'));
    await flush();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('S09 session 9'));
    await flush();

    expect(vi.mocked(toast)).toHaveBeenCalledWith('No more than 8 groups per workspace');
    const afterLayout = useLayoutStore.getState().layouts[workKey1];
    expect(afterLayout && groups(afterLayout)).toHaveLength(8);
  });
});
