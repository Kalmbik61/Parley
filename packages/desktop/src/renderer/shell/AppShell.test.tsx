/**
 * Тесты 6, 9 куска 2.3: `AppShell` без работ показывает `Landing` в центре
 * (заголовок и строка статуса остаются), с работой — сайдбар и центр; меню и
 * кнопки заголовка/`Landing` открывают нужные диалоги. Тесты кусков 2.4–2.5 —
 * центр из раскладок работ; с куска 2.7 он единственный: меню `work-2` делает
 * активной вторую по порядку создания работу (тест 7), `history-back` и
 * `history-forward` ходят по истории.
 *
 * xterm подменён фейком — реальный xterm рисует в канву, которой в jsdom нет.
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
import { REQUIRED_METHODS } from '../lib/capabilities.js';

// Тесты 10, 13, 14, 15 куска 2.4 зовут `toast` и из `AppShell.tsx`
// (отказ сплита), и из `layout/Tab.tsx` (закрытие вкладки) — без смонтированного
// `ui/sonner.tsx#Toaster` (тот живёт в `App.tsx`, не в `AppShell.tsx`) настоящий
// `sonner` просто не рисует ничего; здесь он подменён, чтобы проверить сам вызов.
vi.mock('sonner', () => ({ toast: vi.fn() }));

const state = vi.hoisted(() => ({ terminals: [] as unknown[], disposed: 0 }));

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
      dispose: () => {
        state.disposed += 1;
      },
      resize: () => {},
      focus: () => {},
      scrollToBottom: () => {},
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
  state.disposed = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));

  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
    visibleSessionRefs: {},
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
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const STATUS = { state: 'connected' as const, hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] };

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

describe('AppShell — activeWorkKey ещё не выбран (тест 15 куска 2.4)', () => {
  it('LayoutView не смонтирован, #titlebar-tabs пуст, пока работы есть, а активная работа ещё не выбрана', () => {
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

describe('AppShell — сплит и палитра (тест 13 куска 2.4)', () => {
  it('split-right без уже открытых; выбор — вторая группа; «+» открывает палитру', async () => {
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
    // Две группы (тест 1: «слот заголовка пуст», когда групп несколько;
    // отдельная строка на каждую группу — `[data-group-id]` их обеих).
    expect(document.querySelectorAll('[data-group-id]')).toHaveLength(2);
    expect(document.getElementById('titlebar-tabs')?.childElementCount ?? 0).toBe(0);

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

describe('AppShell — разделение из меню вкладки неактивной группы (тест 14 куска 2.4)', () => {
  it('«Разделить вправо» на вкладке неактивной группы делит ЕЁ группу; прежняя активная группа не тронута', async () => {
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

describe('AppShell — отказ сплита при 8 группах (тест 10 куска 2.4)', () => {
  it('9-я группа — тост «No more than 8 groups per workspace», раскладка не меняется', async () => {
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

// ---------------------------------------------------------------------------
// Кусок 2.5: контейнеры работ LRU, слой поверхностей, ⌘F и входы сайдбара.
// ---------------------------------------------------------------------------

function keyOf(id: string): string {
  return `/tmp/${id} ${id}`;
}

function container(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-work-container="${key}"]`);
}

function attachCalls(sessionId: string): number {
  return bridge.calls.filter(
    (call) => call.method === 'pty.attach' && (call.params as { ref: { sessionId: string } }).ref.sessionId === sessionId,
  ).length;
}

/** Делает работу активной, ждёт её гидрации и открывает в ней терминал сессии. */
async function activateWithTerminal(key: string, sessionId: string): Promise<void> {
  act(() => useLayoutStore.getState().setActiveWork(key));
  await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
  act(() => {
    useLayoutStore.getState().apply(key, (layout) => openTab(layout, term(sessionId)));
  });
  await flush();
}

function fourWorks(): WorkEntry[] {
  return [
    work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]),
    work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]),
    work('w-03', '2026-01-03', 'Третья', [session('s-03', 'три')]),
    work('w-04', '2026-01-04', 'Четвёртая', [session('s-04', 'четыре')]),
  ];
}

async function renderShell(entries: WorkEntry[]): Promise<void> {
  useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
  render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
  await flush();
  // Первую активную работу выбирает `layout/persistence.ts` — дождаться, чтобы
  // он не перебил выбор теста.
  await waitFor(() => expect(useLayoutStore.getState().activeWorkKey).not.toBeNull());
}

describe('AppShell — LRU контейнеров работ (тест 4 куска 2.5)', () => {
  it('четыре работы подряд: контейнер первой размонтирован (dispose), возврат создаёт терминал заново и подключает', async () => {
    await renderShell(fourWorks());
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-03'), 's-03');
    expect(container(keyOf('w-01'))).not.toBeNull();
    expect(state.disposed).toBe(0);

    await activateWithTerminal(keyOf('w-04'), 's-04');
    expect(container(keyOf('w-01'))).toBeNull();
    expect(state.disposed).toBe(1);
    expect(document.querySelectorAll('[data-work-container]')).toHaveLength(3);

    const created = state.terminals.length;
    const attaches = attachCalls('s-01');
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await flush();
    expect(container(keyOf('w-01'))?.querySelector('[data-tab-id="terminal:s-01"]')).not.toBeNull();
    expect(state.terminals.length).toBe(created + 1);
    expect(attachCalls('s-01')).toBe(attaches + 1);
  });
});

describe('AppShell — контейнеры работ (тесты 7, 8 куска 2.5)', () => {
  it('тест 7: у каждой из трёх работ свой контейнер, LayoutView раньше SurfaceLayer, у слоя нет классов и стилей', async () => {
    await renderShell(fourWorks().slice(0, 3));
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-03'), 's-03');

    for (const id of ['w-01', 'w-02', 'w-03']) {
      const box = container(keyOf(id));
      if (box === null) throw new Error(`нет контейнера ${id}`);
      const group = box.querySelector('[data-group-id]');
      const layer = box.querySelector<HTMLElement>('[data-surface-layer]');
      if (group === null || layer === null) throw new Error(`в контейнере ${id} нет LayoutView или SurfaceLayer`);
      expect(group.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(layer.getAttribute('class')).toBeNull();
      expect(layer.getAttribute('style')).toBeNull();
      expect(box.className).toContain('absolute');
      expect(box.className).toContain('inset-0');
    }
  });

  it('тест 8: тела групп неактивной работы в DOM, контейнер скрыт и inert; в заголовке — строка только активной', async () => {
    await renderShell(fourWorks().slice(0, 2));
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');

    const inactive = container(keyOf('w-01'));
    const active = container(keyOf('w-02'));
    if (inactive === null || active === null) throw new Error('нет контейнеров');
    expect(inactive.querySelector('[data-group-body]')).not.toBeNull();
    expect(inactive.style.visibility).toBe('hidden');
    expect(inactive.hasAttribute('inert')).toBe(true);
    expect(active.style.visibility).not.toBe('hidden');
    expect(active.hasAttribute('inert')).toBe(false);

    const titlebarTabs = document.getElementById('titlebar-tabs');
    expect(titlebarTabs?.querySelector('[data-tab-id="terminal:s-02"]')).not.toBeNull();
    expect(titlebarTabs?.querySelector('[data-tab-id="terminal:s-01"]')).toBeNull();
    expect(titlebarTabs?.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });
});

describe('AppShell — работа LRU без раскладки и drop (тест 16 куска 2.5)', () => {
  it('контейнер пуст до hydrate, после — LayoutView и поверхности; drop — контейнер размонтирован, dispose', async () => {
    await renderShell(fourWorks().slice(0, 2));
    await activateWithTerminal(keyOf('w-01'), 's-01');

    // Раскладка второй работы с диска ещё не пришла.
    let resolveLoad: ((value: null) => void) | null = null;
    vi.spyOn(bridge.app, 'loadLayout').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-02')));
    await flush();
    const box = container(keyOf('w-02'));
    expect(box).not.toBeNull();
    expect(box?.childElementCount).toBe(0);
    // Открытие вкладки до гидрации ждёт в очереди `pending` и применится в `hydrate`.
    act(() => {
      useLayoutStore.getState().apply(keyOf('w-02'), (layout) => openTab(layout, term('s-02')));
    });

    await act(async () => {
      resolveLoad?.(null);
      await Promise.resolve();
    });
    await waitFor(() => expect(container(keyOf('w-02'))?.querySelector('[data-group-id]')).not.toBeNull());
    await flush();
    expect(container(keyOf('w-02'))?.querySelector('[data-surface-layer] [data-tab-id="terminal:s-02"]')).not.toBeNull();

    const disposed = state.disposed;
    act(() => useLayoutStore.getState().drop(keyOf('w-02')));
    await flush();
    expect(container(keyOf('w-02'))).toBeNull();
    expect(state.disposed).toBe(disposed + 1);
  });
});

describe('AppShell — вход «Почта» сайдбара (тест 10 куска 2.5)', () => {
  it('клик по «Почта» работы B, пока активна A: активна B, вкладка mail в раскладке B', async () => {
    const letter = { id: 'm-1', roomId: null, from: 's-02', to: ['s-01'], at: '2026-01-02T10:00:00.000Z', text: 'т', kind: 'note' as const, readBy: {} };
    const a = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]);
    const bBase = work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]);
    const b: WorkEntry = { ...bBase, map: { ...bBase.map, messages: [letter] } };
    await renderShell([a, b]);
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-01')]).toBe(true));

    fireEvent.click(screen.getByText('All workspace mail'));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    const layoutB = useLayoutStore.getState().layouts[keyOf('w-02')];
    if (layoutB === undefined) throw new Error('раскладка B не гидрирована');
    expect(groups(layoutB).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual(['mail']);
    const layoutA = useLayoutStore.getState().layouts[keyOf('w-01')];
    expect(layoutA === undefined ? [] : groups(layoutA).flatMap((group) => group.tabs)).toEqual([]);
  });
});

describe('AppShell — меню find (тест 15 куска 2.5)', () => {
  it('полоса поиска открывается только у видимой поверхности активной группы', async () => {
    mockNonZeroRects();
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один'), session('s-02', 'два'), session('s-03', 'три')])]);
    const key = keyOf('w-01');
    act(() => useLayoutStore.getState().setActiveWork(key));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
    // Группа 1 — s-01; группа 2 (активная) — s-02 и s-03, видна s-03.
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-01')));
      const layout = useLayoutStore.getState().layouts[key];
      if (layout === undefined) throw new Error('нет раскладки');
      useLayoutStore.getState().apply(key, (l) => splitGroup(l, layout.activeGroupId, 'row', term('s-02'), { [layout.activeGroupId]: { width: 800, height: 600 } }));
      useLayoutStore.getState().apply(key, (l) => openTab(l, term('s-03')));
    });
    await flush();

    act(() => bridge.emitMenu('find'));
    await flush();

    const bars = screen.getAllByPlaceholderText('Find…');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest('[data-tab-id]')?.getAttribute('data-tab-id')).toBe('terminal:s-03');
  });
});

describe('AppShell — фокус группы из поверхности терминала (раунд исправлений 1 куска 2.5)', () => {
  // Поверхность живёт в слое, а не внутри `GroupView`, — его
  // `onPointerDownCapture` до неё не доходит; группу фокусирует сама поверхность.
  async function twoGroupsFocusedOnSecond(): Promise<string> {
    mockNonZeroRects();
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один'), session('s-02', 'два')])]);
    const key = keyOf('w-01');
    act(() => useLayoutStore.getState().setActiveWork(key));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-01')));
      const layout = useLayoutStore.getState().layouts[key];
      if (layout === undefined) throw new Error('нет раскладки');
      useLayoutStore.getState().apply(key, (l) => splitGroup(l, layout.activeGroupId, 'row', term('s-02'), { [layout.activeGroupId]: { width: 800, height: 600 } }));
    });
    await flush();
    return key;
  }

  function groupOf(key: string, tab: string): string | undefined {
    const layout = useLayoutStore.getState().layouts[key];
    return layout === undefined ? undefined : groups(layout).find((group) => group.tabs.some((t) => t.id === tab))?.id;
  }

  function pad(tab: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-surface-layer] [data-tab-id="${tab}"] [data-testid="terminal-surface-pad"]`);
    if (el === null) throw new Error(`нет поверхности ${tab}`);
    return el;
  }

  it('pointerdown в поверхность неактивной группы: группа активна, ⌘F открывает полосу в ней', async () => {
    const key = await twoGroupsFocusedOnSecond();
    expect(useLayoutStore.getState().layouts[key]?.activeGroupId).toBe(groupOf(key, 'terminal:s-02'));

    fireEvent.pointerDown(pad('terminal:s-01'));
    expect(useLayoutStore.getState().layouts[key]?.activeGroupId).toBe(groupOf(key, 'terminal:s-01'));

    act(() => bridge.emitMenu('find'));
    await flush();
    const bars = screen.getAllByPlaceholderText('Find…');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest('[data-tab-id]')?.getAttribute('data-tab-id')).toBe('terminal:s-01');
  });

  it('focusin внутри поверхности неактивной группы: группа активна, ⌘F открывает полосу в ней', async () => {
    const key = await twoGroupsFocusedOnSecond();

    fireEvent.focusIn(pad('terminal:s-01'));
    expect(useLayoutStore.getState().layouts[key]?.activeGroupId).toBe(groupOf(key, 'terminal:s-01'));

    act(() => bridge.emitMenu('find'));
    await flush();
    const bars = screen.getAllByPlaceholderText('Find…');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest('[data-tab-id]')?.getAttribute('data-tab-id')).toBe('terminal:s-01');
  });

  it('pointerdown и focusin в поверхность активной группы: раскладка той же ссылкой', async () => {
    const key = await twoGroupsFocusedOnSecond();
    const before = useLayoutStore.getState().layouts[key];

    fireEvent.pointerDown(pad('terminal:s-02'));
    fireEvent.focusIn(pad('terminal:s-02'));
    expect(useLayoutStore.getState().layouts[key]).toBe(before);
  });
});

describe('AppShell — меню work-2 (тест 7 куска 2.7)', () => {
  it('делает активной вторую по порядку создания работу, в центре — её раскладка', async () => {
    // Снимок нарочно не в порядке создания: ⌘2 считает по `createdAt`, а не по массиву.
    const [w1, w2, w3] = fourWorks();
    await renderShell([w3!, w1!, w2!]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-01'), 's-01');
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    act(() => bridge.emitMenu('work-2'));
    await flush();

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    const active = container(keyOf('w-02'));
    expect(active?.style.visibility).not.toBe('hidden');
    expect(active?.querySelector('[data-group-id]')).not.toBeNull();
    expect(active?.querySelector('[data-surface-layer] [data-tab-id="terminal:s-02"]')).not.toBeNull();
    expect(document.getElementById('titlebar-tabs')?.querySelector('[data-tab-id="terminal:s-02"]')).not.toBeNull();
  });
});

describe('AppShell — меню history-back / history-forward (кусок 2.7)', () => {
  it('назад возвращает прежнюю работу, вперёд — снова вторую', async () => {
    await renderShell(fourWorks().slice(0, 2));
    await activateWithTerminal(keyOf('w-01'), 's-01');
    // Как клик по строке сессии ещё не показанной работы: вкладка ждёт в
    // `pending` и вливается в `hydrate` — в истории одна запись на переход.
    act(() => {
      useLayoutStore.getState().setActiveWork(keyOf('w-02'));
      useLayoutStore.getState().apply(keyOf('w-02'), (layout) => openTab(layout, term('s-02')));
    });
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));
    await flush();

    act(() => bridge.emitMenu('history-back'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    act(() => bridge.emitMenu('history-forward'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });
});
