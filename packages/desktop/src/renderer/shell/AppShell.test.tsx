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
import { xtermMock } from '../test-utils/xterm-mock.js';
import type { LayoutNode, TabSpec } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { bufferKey } from '../files/buffer.js';
import { useFilesStore } from '../files/store.js';
import { closeTab, focusTab, groups, moveTab, openTab, splitGroup } from '../layout/tree.js';
import { useReviewStore } from '../review/store.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { refKey } from '@harnas/protocol';
import { workKey } from '../lib/tree-order.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { AppShell } from './AppShell.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { usePaletteStore } from '../palette/store.js';
import { useBrowserStore } from '../browser/store.js';
import { Profiler } from 'react';

// Тесты 10, 13, 14, 15 куска 2.4 зовут `toast` и из `AppShell.tsx`
// (отказ сплита), и из `layout/Tab.tsx` (закрытие вкладки) — без смонтированного
// `ui/sonner.tsx#Toaster` (тот живёт в `App.tsx`, не в `AppShell.tsx`) настоящий
// `sonner` просто не рисует ничего; здесь он подменён, чтобы проверить сам вызов.
vi.mock('sonner', () => ({ toast: vi.fn() }));

vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
// Вкладка файла — Monaco (кусок 7.3b): в jsdom — подставной.
vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', async () => (await import('../test-utils/xterm-mock.js')).searchModule);
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

// Раунд исправлений 1 куска 3.3 (ревью A): отрисовки `AppShell` считаются по его
// незащищённому ребёнку — `StatusBar` рисуется ровно тогда, когда рисуется оболочка.
const shellRenders = vi.hoisted(() => ({ statusBar: 0 }));
vi.mock('./StatusBar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./StatusBar.js')>();
  return {
    ...actual,
    StatusBar: (props: Parameters<typeof actual.StatusBar>[0]) => {
      shellRenders.statusBar += 1;
      return actual.StatusBar(props);
    },
  };
});

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
    worktree: null,
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
  xtermMock.reset();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));

  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  // ⌘⇧F (7.4) оставляет «Файлы» в режиме поиска — поле поиска не должно доставаться следующим тестам.
  useFilesStore.setState({ modeByWork: {}, focusSearch: null });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: { open: false, projectPath: null, title: '' }, newSession: { open: false, parentSessionId: null, work: null }, settings: false, createRoom: null, restartHost: false },
    visibleSessionRefs: {},
    ui: DEFAULT_UI,
    uiLoaded: true,
  });
  usePaletteStore.setState({ open: false, mode: 'default', query: '' });
  // cmdk палитры прокручивает выделенную строку — в jsdom `scrollIntoView` нет.
  Element.prototype.scrollIntoView = vi.fn();
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

  // Геометрия Organic (спека окна 2026-09-29, 1.1): центр — лист `--sheet` с радиусом 28 и `shadow-sm`,
  // отступ `0 8 8 0`; сайдбар скрыт — слева тоже 8. Контейнеры работ лежат внутри листа.
  it('центр — лист: --sheet, радиус 28, shadow-sm, отступ 0 8 8 0; левый сайдбар скрыт — слева 8', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    const sheet = screen.getByTestId('center-sheet');
    expect(sheet.className).toMatch(/\bbg-sheet\b/);
    expect(sheet.className).toMatch(/\brounded-lg\b/);
    expect(sheet.className).toMatch(/\bshadow-sm\b/);
    expect(sheet.className).toMatch(/\boverflow-hidden\b/);
    const frame = sheet.parentElement as HTMLElement;
    expect(frame.className).toMatch(/\bpr-2\b/);
    expect(frame.className).toMatch(/\bpb-2\b/);
    expect(frame.className).not.toMatch(/\bpl-2\b/);

    act(() => useUiStore.getState().setSidebar('left', { open: false }));
    expect((screen.getByTestId('center-sheet').parentElement as HTMLElement).className).toMatch(/\bpl-2\b/);
  });

  it('контейнер работы — внутри листа, у неактивной работы — тоже', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await waitFor(() => expect(document.querySelector('[data-work-container]')).not.toBeNull());

    const container = document.querySelector('[data-work-container]') as HTMLElement;
    expect(screen.getByTestId('center-sheet').contains(container)).toBe(true);
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
  it('на Landing: кнопка «Новая работа» и меню work.new открывают форму новой работы; меню palette.open — Palette', async () => {
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /New workspace/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New workspace')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();

    act(() => bridge.emitMenu('work.new'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await flush();

    act(() => bridge.emitMenu('palette.open'));
    expect(await screen.findByText('Command palette')).toBeTruthy();
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });
    expect(screen.getByPlaceholderText('Search workspaces, sessions, tabs and actions')).toBeTruthy();
  });

  it('подпись сочетания палитры — ⌘J и в заголовке, и на Landing; ⌘K нигде нет (тест 9 куска 6.1b)', async () => {
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    expect(screen.getAllByText('⌘J').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('⌘K')).toBeNull();
  });

  it('emitMenu(files.quickOpen) без активной работы — тост No active workspace, палитра закрыта (тест 3 куска 6.1b, тест 6 куска 7.4)', async () => {
    vi.mocked(toast).mockClear();
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();

    act(() => bridge.emitMenu('files.quickOpen'));
    await flush();

    expect(vi.mocked(toast)).toHaveBeenCalledWith('No active workspace');
    expect(usePaletteStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('emitMenu(files.quickOpen) с работой — палитра в режиме files; files.search — сайдбар на Files в режиме поиска (тест 6 куска 7.4)', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);

    act(() => bridge.emitMenu('files.quickOpen'));
    await flush();
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'files' });
    act(() => usePaletteStore.getState().close());
    await flush();

    useFilesStore.setState({ modeByWork: {}, focusSearch: null });
    act(() => bridge.emitMenu('files.search'));
    await flush();
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'files' });
    expect(useFilesStore.getState().modeByWork['/tmp/w-01 w-01']).toBe('search');
    expect(await screen.findByPlaceholderText('Search in files')).toBeTruthy();
  });

  it('с работой: меню sidebar.left.toggle сворачивает сайдбар, «Поиск ⌘J» открывает палитру', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    expect(screen.getByText('Первая')).toBeTruthy();
    // «Search» — одна кнопка, вверху сайдбара карточек (кусок 3.3): в заголовке при открытом сайдбаре её нет.
    expect(screen.getAllByText('Search')).toHaveLength(1);

    act(() => bridge.emitMenu('sidebar.left.toggle'));
    expect(screen.queryByText('Первая')).toBeNull();
    expect(useUiStore.getState().ui.leftSidebar.open).toBe(false);

    // Сайдбара нет — поиск переехал в заголовок.
    fireEvent.click(screen.getByText('Search'));
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });
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

describe('AppShell — сплит и палитра (тест 13 куска 2.4, тест 9 куска 6.2)', () => {
  it('split-right: палитра «Open in new group», сессия с вкладкой — только вкладкой; выбор строки — вторая группа', async () => {
    mockNonZeroRects();

    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план'), session('s-02', 'бэкенд')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    const workKey1 = '/tmp/w-01 w-01';

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey1]).toBe(true));

    // Первая сессия уже открыта — как если бы её открыл сайдбар.
    useLayoutStore.getState().apply(workKey1, (layout) => openTab(layout, term('s-01')));
    await flush();
    // Одна группа — тест 1: её строка вкладок стоит в заголовке, не в теле.
    expect(document.getElementById('titlebar-tabs')?.querySelector('[data-tab-id]')).not.toBeNull();

    act(() => bridge.emitMenu('group.splitRight'));
    await flush();

    const dialog = await screen.findByRole('dialog');
    expect(usePaletteStore.getState().mode).toBe('splitRight');
    expect(within(dialog).getByText('Open in new group')).toBeTruthy();
    // s-01 открыта — в палитре она вкладкой, а не второй строкой сессии.
    expect(within(dialog).getAllByRole('option', { name: /S01 план/ })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('option', { name: /S02 бэкенд/ }));
    await flush();

    expect(usePaletteStore.getState().open).toBe(false);
    const layout = useLayoutStore.getState().layouts[workKey1];
    if (layout === undefined) throw new Error('раскладка не гидрирована');
    expect(groups(layout).map((group) => group.tabs.map((tab) => tab.id))).toEqual([[tabId.terminal('s-01')], [tabId.terminal('s-02')]]);
    expect(document.querySelectorAll('[data-group-id]')).toHaveLength(2);
    expect(document.getElementById('titlebar-tabs')?.childElementCount ?? 0).toBe(0);
  });

  it('«+» строки вкладок неактивной группы — палитра в режиме open, выбор открывается в этой группе', async () => {
    mockNonZeroRects();
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'ревью')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    const workKey1 = '/tmp/w-01 w-01';

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey1]).toBe(true));
    useLayoutStore.getState().apply(workKey1, (layout) => openTab(layout, term('s-01')));
    const g1Id = useLayoutStore.getState().layouts[workKey1]?.activeGroupId;
    if (g1Id === undefined) throw new Error('нет активной группы');
    useLayoutStore.getState().apply(workKey1, (layout) => splitGroup(layout, g1Id, 'row', term('s-02'), { [g1Id]: { width: 800, height: 600 } }));
    await flush();
    expect(useLayoutStore.getState().layouts[workKey1]?.activeGroupId).not.toBe(g1Id);

    const strip = document.querySelector(`[data-group-id="${g1Id}"]`);
    if (strip === null) throw new Error('нет группы g1');
    fireEvent.click(within(strip as HTMLElement).getByLabelText('Open…'));
    await flush();

    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'open' });
    expect(useLayoutStore.getState().layouts[workKey1]?.activeGroupId).toBe(g1Id);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'S03' } });
    await flush();
    fireEvent.click(screen.getAllByRole('option', { name: /S03 ревью/ })[0]!);
    await flush();

    const layout = useLayoutStore.getState().layouts[workKey1];
    if (layout === undefined) throw new Error('раскладка пропала');
    const g1 = groups(layout).find((group) => group.id === g1Id);
    expect(g1?.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-01'), tabId.terminal('s-03')]);
    expect(groups(layout)).toHaveLength(2);
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

describe('AppShell — разделение из меню вкладки неактивной группы (тест 14 куска 2.4, тест 9 куска 6.2)', () => {
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

    // Группа вкладки стала активной, палитра — в режиме разделения.
    expect(useLayoutStore.getState().layouts[workKey1]?.activeGroupId).toBe(g1Id);
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'splitRight' });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('option', { name: /S03 ревью/ }));
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

    act(() => bridge.emitMenu('group.splitRight'));
    await flush();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('option', { name: /S09 session 9/ }));
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

describe('AppShell — выбор сессии «Изменений» (кусок 8.2b)', () => {
  it('смена активной работы стирает выбор той, с которой ушли; после размонтирования подписки нет', async () => {
    useReviewStore.setState({ changesSession: {} });
    await renderShell(fourWorks().slice(0, 2));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    act(() => useReviewStore.getState().selectChangesSession(keyOf('w-01'), 's-01'));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-02')));
    expect(useReviewStore.getState().changesSession).toEqual({});

    cleanup();
    act(() => useReviewStore.getState().selectChangesSession(keyOf('w-02'), 's-02'));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    expect(useReviewStore.getState().changesSession).toEqual({ [keyOf('w-02')]: 's-02' });
  });
});

describe('AppShell — LRU контейнеров работ (тест 4 куска 2.5)', () => {
  it('четыре работы подряд: контейнер первой размонтирован (dispose), возврат создаёт терминал заново и подключает', async () => {
    await renderShell(fourWorks());
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-03'), 's-03');
    expect(container(keyOf('w-01'))).not.toBeNull();
    expect(xtermMock.disposed).toBe(0);

    await activateWithTerminal(keyOf('w-04'), 's-04');
    expect(container(keyOf('w-01'))).toBeNull();
    expect(xtermMock.disposed).toBe(1);
    expect(document.querySelectorAll('[data-work-container]')).toHaveLength(3);

    const created = xtermMock.terminals.length;
    const attaches = attachCalls('s-01');
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await flush();
    expect(container(keyOf('w-01'))?.querySelector('[data-tab-id="terminal:s-01"]')).not.toBeNull();
    expect(xtermMock.terminals.length).toBe(created + 1);
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

    const disposed = xtermMock.disposed;
    act(() => useLayoutStore.getState().drop(keyOf('w-02')));
    await flush();
    expect(container(keyOf('w-02'))).toBeNull();
    expect(xtermMock.disposed).toBe(disposed + 1);
  });
});

describe('AppShell — вход «Почта» сайдбара (тест 10 куска 2.5)', () => {
  // С куска 3.3 строки «All workspace mail» в сайдбаре нет: почту открывает ✉N карточки,
  // поэтому письмо — человеку.
  it('клик по ✉1 работы B, пока активна A: активна B, вкладка mail в раскладке B', async () => {
    const letter = { id: 'm-1', roomId: null, from: 's-02', to: ['human'], at: '2026-01-02T10:00:00.000Z', text: 'т', kind: 'note' as const, readBy: {} };
    const a = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]);
    const bBase = work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]);
    const b: WorkEntry = { ...bBase, map: { ...bBase.map, messages: [letter] } };
    await renderShell([a, b]);
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-01')]).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '1 unread message to you' }));
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

describe('AppShell — ⌘K в терминале (тест 10 куска 5.3, тест 8 куска 6.1b)', () => {
  /** Фокус xterm — его помощник `textarea.xterm-helper-textarea` внутри `.xterm`, как у настоящего. */
  function focusTerminal(element: HTMLElement | null): HTMLTextAreaElement {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    xterm.appendChild(helper);
    (element ?? document.body).appendChild(xterm);
    helper.focus();
    return helper;
  }

  const cmdK = (target: EventTarget): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, cancelable: true, bubbles: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  async function withTerminal(): Promise<void> {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
  }

  it('⌘K в терминале: clear() его поверхности, pty.input нет, палитра закрыта', async () => {
    await withTerminal();
    const terminal = xtermMock.terminals.at(-1);
    const helper = focusTerminal(terminal?.element ?? null);

    const event = cmdK(helper);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(xtermMock.callsOf('clear', terminal?.index)).toHaveLength(1);
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([]);
    expect(usePaletteStore.getState().open).toBe(false);
    expect(screen.queryByText('Command palette')).toBeNull();
  });

  it('⌘F в терминале: полоса поиска его поверхности с фокусом в поле', async () => {
    await withTerminal();
    const helper = focusTerminal(xtermMock.terminals.at(-1)?.element ?? null);

    const event = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, cancelable: true, bubbles: true });
    act(() => {
      helper.dispatchEvent(event);
    });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Find…'));
  });

  it('⌘K при фокусе в сайдбаре — clear() не вызван, событие не погашено', async () => {
    await withTerminal();
    const terminal = xtermMock.terminals.at(-1);
    const card = document.querySelector<HTMLElement>('[data-work-key]');
    if (card === null) throw new Error('нет карточки');
    card.focus();

    const event = cmdK(card);
    await flush();

    expect(event.defaultPrevented).toBe(false);
    expect(xtermMock.callsOf('clear', terminal?.index)).toHaveLength(0);
    expect(usePaletteStore.getState().open).toBe(false);
  });
});

describe('AppShell — terminal.clear только у терминала в фокусе (раунд fix-main-r1, п.6)', () => {
  function focusTerminal(element: HTMLElement | null): HTMLTextAreaElement {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    xterm.appendChild(helper);
    (element ?? document.body).appendChild(xterm);
    helper.focus();
    return helper;
  }

  async function withTerminal(): Promise<void> {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
  }

  it('пункт меню при фокусе в сайдбаре — ничего (запасной ход к triggeredByAccelerator)', async () => {
    await withTerminal();
    const terminal = xtermMock.terminals.at(-1);
    const card = document.querySelector<HTMLElement>('[data-work-key]');
    if (card === null) throw new Error('нет карточки');
    card.focus();

    act(() => bridge.emitMenu('terminal.clear'));
    await flush();

    expect(xtermMock.callsOf('clear', terminal?.index)).toHaveLength(0);
  });

  it('пункт меню при фокусе в терминале — clear() его поверхности', async () => {
    await withTerminal();
    const terminal = xtermMock.terminals.at(-1);
    focusTerminal(terminal?.element ?? null);

    act(() => bridge.emitMenu('terminal.clear'));
    await flush();

    expect(xtermMock.callsOf('clear', terminal?.index)).toHaveLength(1);
  });

  it('строка палитры «Clear terminal» — активный терминал, даже без фокуса в нём', async () => {
    await withTerminal();
    const terminal = xtermMock.terminals.at(-1);
    act(() => bridge.emitMenu('palette.open'));
    const input = await screen.findByPlaceholderText(/./, { selector: '[cmdk-input]' });
    fireEvent.change(input, { target: { value: 'Clear terminal' } });
    const row = await screen.findByRole('option', { name: /Clear terminal/ });
    fireEvent.click(row);
    await flush();

    expect(xtermMock.callsOf('clear', terminal?.index)).toHaveLength(1);
  });
});

describe('AppShell — фокус группы из поверхности терминала (раунд исправлений 1 куска 2.5)', () => {
  // Поверхность живёт в слое, а не внутри `GroupView`, — его
  // `onPointerDownCapture` до неё не доходит; группу фокусирует сама поверхность.
  async function twoGroupsFocusedOnSecond(): Promise<string> {
    vi.mocked(toast).mockClear();
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

describe('AppShell — меню work-N по видимому порядку (тест 7 куска 2.7, тест 7 куска 3.4)', () => {
  it('⌘1 — первая работа видимого порядка, включая Pinned; work-2 — вторая в нём, а не по созданию', async () => {
    // Снимок нарочно не в порядке создания, а третья работа закреплена: видимый порядок —
    // Pinned [w-03], затем проекты по имени папки [w-01], [w-02].
    const [w1, w2, w3] = fourWorks();
    await renderShell([w3!, w1!, w2!]);
    act(() => useUiStore.getState().patchUi({ pinnedWorks: [keyOf('w-03')] }));
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await activateWithTerminal(keyOf('w-02'), 's-02');

    act(() => bridge.emitMenu('work.goto.1'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-03'));

    act(() => bridge.emitMenu('work.goto.2'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
    const active = container(keyOf('w-01'));
    expect(active?.style.visibility).not.toBe('hidden');
    expect(active?.querySelector('[data-surface-layer] [data-tab-id="terminal:s-01"]')).not.toBeNull();
    expect(document.getElementById('titlebar-tabs')?.querySelector('[data-tab-id="terminal:s-01"]')).not.toBeNull();

    act(() => bridge.emitMenu('work.goto.9'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
  });
});

describe('AppShell — ⌘⇧↑↓ по видимому порядку (тесты 11, 20 куска 3.4; тест 7 куска 6.1b)', () => {
  const press = (target: EventTarget, key: 'ArrowUp' | 'ArrowDown'): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const activeTab = (key: string): string | null => {
    const layout = useLayoutStore.getState().layouts[key];
    const group = layout === undefined ? undefined : groups(layout).find((candidate) => candidate.id === layout.activeGroupId);
    return group?.activeTabId ?? null;
  };

  it('в поле ввода работу не меняет; в терминале и вне полей — соседняя, вкладки активной группы не листаются', async () => {
    await renderShell(fourWorks().slice(0, 3));
    await activateWithTerminal(keyOf('w-01'), 's-01');
    act(() => useLayoutStore.getState().apply(keyOf('w-01'), (layout) => openTab(layout, { kind: 'mail', id: tabId.mail() })));
    act(() => useLayoutStore.getState().apply(keyOf('w-01'), (layout) => openTab(layout, term('s-01'))));
    expect(activeTab(keyOf('w-01'))).toBe(tabId.terminal('s-01'));

    // Контекст фокуса обработчик окна берёт из `document.activeElement` (кусок 6.1b).
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const ignored = press(input, 'ArrowDown');
    expect(ignored.defaultPrevented).toBe(false);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
    input.remove();

    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    helper.focus();
    const fromTerminal = press(helper, 'ArrowDown');
    expect(fromTerminal.defaultPrevented).toBe(true);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    expect(activeTab(keyOf('w-01'))).toBe(tabId.terminal('s-01'));
    xterm.remove();

    press(document.body, 'ArrowUp');
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
    expect(activeTab(keyOf('w-01'))).toBe(tabId.terminal('s-01'));
  });

  it('проект активной работы свёрнут: ⌘⇧↓ — первая видимая работа, ⌘⇧↑ — последняя (тест 20)', async () => {
    await renderShell(fourWorks().slice(0, 3));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-02')));
    act(() => useUiStore.getState().patchUi({ collapsedProjects: ['/tmp/w-02'] }));
    await flush();

    press(document.body, 'ArrowDown');
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-02')));
    press(document.body, 'ArrowUp');
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-03'));
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

    act(() => bridge.emitMenu('history.back'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    act(() => bridge.emitMenu('history.forward'));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });
});

// ---------------------------------------------------------------------------
// Кусок 3.3: сайдбар карточек вместо прежнего.
// ---------------------------------------------------------------------------

describe('AppShell — сайдбар карточек (кусок 3.3)', () => {
  it('карточка работы с data-work-key; «New workspace» открывает форму новой работы (тест 8)', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    expect(document.querySelector(`[data-work-key="${keyOf('w-01')}"]`)).not.toBeNull();
    expect(document.querySelector('[data-work-sidebar]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^New workspace\s*⌘N$/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New workspace')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('кусок 3.5, тест 7: «+» заголовка проекта — форма с этим проектом; меню new-work — без проекта', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);

    fireEvent.click(screen.getByRole('button', { name: /^New workspace in / }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Project' }).getAttribute('title')).toBe('/tmp/w-01');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: false, projectPath: null, title: '' });

    act(() => bridge.emitMenu('work.new'));
    const again = await screen.findByRole('dialog');
    expect(within(again).getByRole('combobox', { name: 'Project' }).textContent).toBe('Choose a folder…');
  });

  it('клик по строке сессии неактивной работы: работа активна, вкладка её терминала открыта', async () => {
    await renderShell(fourWorks().slice(0, 2));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-01')]).toBe(true));

    fireEvent.click(document.querySelector(`[data-work-key="${keyOf('w-02')}"] [data-session-id="s-02"]`) as HTMLElement);
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    const layout = useLayoutStore.getState().layouts[keyOf('w-02')];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.terminal('s-02')]);
  });

  it('клик по карточке делает работу активной', async () => {
    await renderShell(fourWorks().slice(0, 2));
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    fireEvent.click(document.querySelector(`[data-work-key="${keyOf('w-02')}"]`) as HTMLElement);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });
});

describe('AppShell и палитра: подписки и клавиши (тест 8 и решение контролёра 2 куска 6.2)', () => {
  it('закрытая палитра: запись истории не перерисовывает AppShell; открытая — обновляет список', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план'), session('s-02', 'бэкенд')]);
    const key = keyOf('w-01');
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    let commits = 0;
    render(
      <Profiler id="shell" onRender={() => (commits += 1)}>
        <AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />
      </Profiler>,
    );
    await flush();
    await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(openTab(layout, term('s-01')), term('s-02')));
    });
    await flush();
    // История с двумя записями: ещё одна запись не меняет ни «назад», ни «вперёд» заголовка.
    const history = (at: number) => ({
      entries: [
        { workKey: key, tabId: tabId.terminal('s-01'), at: at - 2 },
        { workKey: key, tabId: tabId.terminal('s-02'), at: at - 1 },
        { workKey: key, tabId: tabId.terminal('s-01'), at },
      ],
      index: 2,
    });
    act(() => useLayoutStore.setState({ history: { entries: history(Date.now()).entries.slice(0, 2), index: 1 } }));
    await flush();

    const before = commits;
    act(() => useLayoutStore.setState({ history: history(Date.now()) }));
    await flush();
    expect(commits).toBe(before);

    act(() => usePaletteStore.getState().openWith('default'));
    await flush();
    const tabs = (): string[] =>
      within(screen.getByRole('dialog'))
        .getAllByRole('option')
        .map((option) => option.textContent ?? '');
    expect(tabs()[0]).toContain('S01 план');
    act(() =>
      useLayoutStore.setState({
        history: { entries: [...history(Date.now()).entries, { workKey: key, tabId: tabId.terminal('s-02'), at: Date.now() + 1000 }], index: 3 },
      }),
    );
    await flush();
    expect(tabs()[0]).toContain('S02 бэкенд');
  });

  it('при открытой палитре ⌘D, ⌘N, ⌘W, ⌘T за ней не выполняются; ⌘J закрывает', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
    act(() => usePaletteStore.getState().openWith('default'));
    await flush();
    const input = screen.getByRole('combobox');
    await waitFor(() => expect(document.activeElement).toBe(input));
    const layoutBefore = useLayoutStore.getState().layouts[keyOf('w-01')];

    for (const key of ['d', 'n', 'w', 't']) {
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, metaKey: true, bubbles: true, cancelable: true }));
      });
    }
    await flush();

    expect(useLayoutStore.getState().layouts[keyOf('w-01')]).toBe(layoutBefore);
    expect(useUiStore.getState().dialogs.newWork.open).toBe(false);
    expect(useUiStore.getState().dialogs.newSession.open).toBe(false);
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });

    const cmdJ = new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(cmdJ);
    });
    await flush();
    expect(cmdJ.defaultPrevented).toBe(true);
    expect(usePaletteStore.getState().open).toBe(false);
  });
});

describe('AppShell и активность (раунд исправлений 1 куска 3.3)', () => {
  // С куска 4.2 оболочка подписана на итоги внимания (строка статуса): `working` их не меняет,
  // а порядок сайдбара поднимает — оболочка по-прежнему не перерисовывается.
  it('activity.changed не перерисовывает оболочку, а порядок сайдбара обновляется', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', 'Вторая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });

    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    const cardOrder = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[data-work-key]')].map((element) => element.getAttribute('data-work-key') ?? '');
    // Внимания нет, даты не ISO — порядок по ключу работы.
    expect(cardOrder()).toEqual([workKey('/tmp/w-01', 'w-01'), workKey('/tmp/w-02', 'w-02')]);

    const before = shellRenders.statusBar;
    const ref = { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-01' };
    act(() => {
      useActivityStore.setState({
        byRef: {
          [refKey(ref)]: {
            ref,
            activity: {
              activity: 'working',
              subagents: 0,
              turnEndedAt: null,
              lastEventAt: '2026-01-03T00:00:00.000Z',
              source: 'hooks',
              exited: false,
              hooksMissing: false,
            },
            metrics: null,
          },
        },
      });
    });

    expect(shellRenders.statusBar).toBe(before);
    expect(cardOrder()[0]).toBe(workKey('/tmp/w-02', 'w-02'));
  });

  // Решение контролёра 1 куска 4.2: итоги берутся селектором с поверхностным сравнением —
  // метрики без смены итогов оболочку не трогают, смена итогов обновляет строку статуса.
  it('итоги внимания: метрики не перерисовывают оболочку, смена итогов — обновляет строку статуса (кусок 4.2)', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    const ref = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };
    const entry = (activity: 'working' | 'blocked', tokensIn: number) => ({
      ref,
      activity: { activity, subagents: 0, turnEndedAt: null, lastEventAt: '2026-01-03T00:00:00.000Z', source: 'hooks' as const, exited: false, hooksMissing: false },
      metrics: { tokensIn, tokensOut: 0, durationMs: 0, unread: 0, subagents: 0, model: 'opus' },
    });
    act(() => useActivityStore.setState({ byRef: { [refKey(ref)]: entry('working', 1) } }));
    const before = shellRenders.statusBar;
    act(() => useActivityStore.setState({ byRef: { [refKey(ref)]: entry('working', 2) } }));
    act(() => useActivityStore.setState({ byRef: { [refKey(ref)]: entry('working', 3) } }));
    expect(shellRenders.statusBar).toBe(before);
    expect(document.querySelector('[data-attention-segment]')).toBeNull();

    act(() => useActivityStore.setState({ byRef: { [refKey(ref)]: entry('blocked', 4) } }));
    expect(shellRenders.statusBar).toBeGreaterThan(before);
    expect(screen.getByRole('button', { name: '1 needs you' })).toBeTruthy();
  });

  it('клик по сегменту внимания открывает следующую сессию, где нужен человек (кусок 4.2, спека 7.6)', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', 'Вторая', [session('s-01', 'бэк'), session('s-02', 'фронт')]);
    await renderShell([w1, w2]);
    const ref = { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-02' };
    act(() =>
      useActivityStore.setState({
        byRef: {
          [refKey(ref)]: {
            ref,
            activity: { activity: 'blocked', subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
            metrics: null,
          },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '1 needs you' }));
    expect(useLayoutStore.getState().activeWorkKey).toBe(workKey('/tmp/w-02', 'w-02'));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[workKey('/tmp/w-02', 'w-02')]).toBe(true));
    const layout = useLayoutStore.getState().layouts[workKey('/tmp/w-02', 'w-02')];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toContain(tabId.terminal('s-02'));
  });
});

// ---------------------------------------------------------------------------
// Кусок 3.4: меню карточки и строки в оболочке.
// ---------------------------------------------------------------------------

describe('AppShell — меню сайдбара (кусок 3.4)', () => {
  // Пункты меню карточки прячутся без методов хоста — статус связи как в окне.
  let disposeHost: () => void = () => {};
  beforeEach(() => {
    disposeHost = useHostStore.getState().init(bridge);
  });
  afterEach(() => disposeHost());

  it('«Open to the side» (тест 12): размеры групп подставлены, у работы уже открыта вкладка — две группы, сессия справа', async () => {
    mockNonZeroRects();
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один'), session('s-02', 'два')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');

    fireEvent.contextMenu(document.querySelector(`[data-work-key="${keyOf('w-01')}"] [data-session-id="s-02"]`) as HTMLElement);
    fireEvent.click(screen.getByText('Open to the side'));

    const layout = useLayoutStore.getState().layouts[keyOf('w-01')];
    if (layout === undefined) throw new Error('раскладки нет');
    const all = groups(layout);
    expect(all.map((group) => group.tabs.map((tab) => tab.id))).toEqual([[tabId.terminal('s-01')], [tabId.terminal('s-02')]]);
    expect(toast).not.toHaveBeenCalledWith(S_TOO_SMALL);
  });

  it('«Open to the side» у строки работы, которую ни разу не открывали (раунд 1, находка 1): вкладка сессии в её раскладке', async () => {
    mockNonZeroRects();
    await renderShell([
      work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]),
      work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]),
    ]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
    expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBeUndefined();

    fireEvent.contextMenu(document.querySelector(`[data-work-key="${keyOf('w-02')}"] [data-session-id="s-02"]`) as HTMLElement);
    fireEvent.click(screen.getByText('Open to the side'));

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));
    await flush();
    const layout = useLayoutStore.getState().layouts[keyOf('w-02')];
    if (layout === undefined) throw new Error('раскладки нет');
    expect(groups(layout).map((group) => group.tabs.map((tab) => tab.id))).toEqual([[tabId.terminal('s-02')]]);
  });

  it('выбор комнаты в меню # (тест 4): работа активна, вкладка room в её раскладке', async () => {
    const withRoom = work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]);
    withRoom.map.rooms = [{ id: 'r-01', title: 'Design', creator: 'human', members: [], createdAt: '2026-01-02' }];
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]), withRoom]);
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));

    // Раунд исправлений 1, находка 2: фокус из портала меню всплывал по дереву React в
    // `onFocus` списка, тот уводил фокус на карточку, ловушка фокуса меню возвращала его —
    // и так до «Maximum call stack size exceeded» (jsdom отдаёт её в console.error).
    const errors = vi.spyOn(console, 'error');
    const card = document.querySelector(`[data-work-key="${keyOf('w-02')}"]`) as HTMLElement;
    fireEvent.keyDown(within(card).getByRole('button', { name: 'Rooms' }), { key: 'Enter' });
    // Название комнаты видно и строкой самой карточки (кусок 5): пункт ищем внутри меню.
    fireEvent.click(within(screen.getByRole('menu')).getByText('Design'));
    const overflow = errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes('Maximum call stack')));
    errors.mockRestore();
    expect(overflow).toEqual([]);

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));
    const layout = useLayoutStore.getState().layouts[keyOf('w-02')];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.room('r-01')]);
  });

  it('«New room» из меню карточки (тест 10): заголовок New room, кандидаты — все сессии работы, закрытая недоступна', async () => {
    const closed = { ...session('s-03', 'три'), lifecycle: 'closed' as const };
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один'), session('s-02', 'два'), closed])]);
    fireEvent.contextMenu(document.querySelector(`[data-work-key="${keyOf('w-01')}"]`) as HTMLElement);
    fireEvent.click(screen.getByText('New room'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New room' })).toBeTruthy();
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLButtonElement[];
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual(['S01 один', 'S02 два', 'S03 три']);
    expect(boxes.map((box) => box.disabled)).toEqual([false, false, true]);
  });
});

const S_TOO_SMALL = 'Not enough room for another group';

// ---------------------------------------------------------------------------
// Кусок 3.4, решение контролёра 1: сосед и работа на старте — по видимому порядку того же
// снимка, а не по устаревшему в рендере, где снимок только что пришёл.
// ---------------------------------------------------------------------------

describe('AppShell — видимый порядок для persistence (решение контролёра 1)', () => {
  const blocked = (id: string, sessionId: string) =>
    ({
      ref: { projectPath: `/tmp/${id}`, workId: id, sessionId },
      activity: {
        activity: 'blocked' as const,
        subagents: 0,
        turnEndedAt: null,
        lastEventAt: '2026-01-05T00:00:00.000Z',
        source: 'hooks' as const,
        exited: false,
        hooksMissing: false,
      },
      metrics: null,
    });

  it('старт: активна первая работа видимого порядка (где нужен ты), а не первая по созданию', async () => {
    const [w1, w2] = fourWorks();
    const entry = blocked('w-02', 's-02');
    useActivityStore.setState({ byRef: { [refKey(entry.ref)]: entry } });
    await renderShell([w1!, w2!]);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });

  it('активная удалена, а соседняя в том же снимке архивирована — сосед среди оставшихся, не архивная', async () => {
    const [w1, w2, w3] = fourWorks();
    await renderShell([w1!, w2!, w3!]);
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-02')));
    await flush();

    const archived3: WorkEntry = { ...w3!, map: { ...w3!.map, work: { ...w3!.map.work, status: 'archived' } } };
    act(() => useWorksStore.setState({ entries: [w1!, archived3] }));
    await flush();

    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
  });
});

// ---------------------------------------------------------------------------
// Кусок 6.1b: клавиши окна — один обработчик (`keys/handler.ts`) на активную работу.
// ---------------------------------------------------------------------------

function activeTabOf(key: string): string | null {
  const layout = useLayoutStore.getState().layouts[key];
  const group = layout === undefined ? undefined : groups(layout).find((candidate) => candidate.id === layout.activeGroupId);
  return group?.activeTabId ?? null;
}

describe('AppShell — цикл ⌃Tab в окне (тест 5 куска 6.1b, перенос тестов LayoutView 2.4)', () => {
  /** Три вкладки A, B, C открыты по порядку — MRU (свежая первой): C, B, A. */
  async function threeTabs(): Promise<string> {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('a', ''), session('b', ''), session('c', '')])]);
    const key = keyOf('w-01');
    await activateWithTerminal(key, 'a');
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('b')));
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('c')));
    });
    await flush();
    expect(useLayoutStore.getState().mru[key]).toEqual(['terminal:c', 'terminal:b', 'terminal:a']);
    return key;
  }

  it('⌃ удержан, Tab ×2 — активна A; keyup Control — mru [A, C, B]', async () => {
    const key = await threeTabs();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:a');

    fireEvent.keyUp(window, { key: 'Control' });
    expect(useLayoutStore.getState().mru[key]).toEqual(['terminal:a', 'terminal:c', 'terminal:b']);

    // Одиночный ⌃Tab после фиксации — снимок берётся заново, из нового порядка.
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Control' });
    expect(activeTabOf(key)).toBe('terminal:c');
  });

  it('то же с blur окна вместо keyup', async () => {
    const key = await threeTabs();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:a');

    fireEvent(window, new FocusEvent('blur'));
    expect(useLayoutStore.getState().mru[key]).toEqual(['terminal:a', 'terminal:c', 'terminal:b']);
  });

  it('вкладку закрыли посреди цикла — фиксация не возвращает её в mru (решение контролёра 2)', async () => {
    const key = await threeTabs();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:a');
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => closeTab(layout, 'terminal:a'));
    });
    const live = useLayoutStore.getState().mru[key];

    fireEvent.keyUp(window, { key: 'Control' });
    const mru = useLayoutStore.getState().mru[key] ?? [];
    expect(mru).not.toContain('terminal:a');
    expect(mru).toEqual(live);
    expect(mru[0]).toBe(activeTabOf(key));
  });

  it('шаг на закрытую посреди цикла вкладку снимка её пропускает', async () => {
    const key = await threeTabs();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:b');
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => closeTab(layout, 'terminal:a'));
    });
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => focusTab(layout, 'terminal:b'));
    });

    // Снимок [C, B, A]: следующий шаг — A, её нет — цикл идёт дальше, к C.
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:c');
    fireEvent.keyUp(window, { key: 'Control' });
    expect(useLayoutStore.getState().mru[key]).toEqual(['terminal:c', 'terminal:b']);
  });

  it('закрыта не снятая, а другая вкладка снимка — фиксация без неё, снятая первой', async () => {
    const key = await threeTabs();

    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(activeTabOf(key)).toBe('terminal:b');
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => closeTab(layout, 'terminal:a'));
    });

    fireEvent.keyUp(window, { key: 'Control' });
    expect(useLayoutStore.getState().mru[key]).toEqual(['terminal:b', 'terminal:c']);
  });
});

describe('AppShell — клавиши только у активной работы (тест 6 куска 6.1b)', () => {
  it('две работы в LRU: ⌃1 и ⌘⇧] меняют вкладку активной, раскладка скрытой — та же ссылка', async () => {
    await renderShell(fourWorks().slice(0, 2));
    const hidden = keyOf('w-01');
    const active = keyOf('w-02');
    await activateWithTerminal(hidden, 's-01');
    act(() => useLayoutStore.getState().apply(hidden, (layout) => openTab(layout, { kind: 'mail', id: tabId.mail() })));
    await activateWithTerminal(active, 's-02');
    act(() => useLayoutStore.getState().apply(active, (layout) => openTab(layout, { kind: 'mail', id: tabId.mail() })));
    await flush();
    expect(container(hidden)).not.toBeNull();
    const hiddenLayout = useLayoutStore.getState().layouts[hidden];
    expect(activeTabOf(active)).toBe(tabId.mail());

    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
    expect(activeTabOf(active)).toBe(tabId.terminal('s-02'));

    fireEvent.keyDown(window, { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(activeTabOf(active)).toBe(tabId.mail());

    expect(useLayoutStore.getState().layouts[hidden]).toBe(hiddenLayout);
  });
});

// ---------------------------------------------------------------------------
// Кусок 6.3: действия палитры через `runAction` и фокус после выбора строки.
// ---------------------------------------------------------------------------

/** ⌘J, запрос и клик по первой строке с этим текстом — так человек выбирает действие или сессию. */
async function pickInPalette(query: string, row: RegExp): Promise<void> {
  act(() => bridge.emitMenu('palette.open'));
  const input = await screen.findByPlaceholderText(/./, { selector: '[cmdk-input]' });
  fireEvent.change(input, { target: { value: query } });
  const [first] = await screen.findAllByRole('option', { name: row });
  if (first === undefined) throw new Error(`нет строки ${String(row)}`);
  fireEvent.click(first);
  await flush();
}

function archivedWork(id: string, projectPath: string, sessions: WorkSession[]): WorkEntry {
  const base = work(id, '2026-01-09', `Архивная ${id}`, sessions);
  return { projectPath, map: { ...base.map, work: { ...base.map.work, status: 'archived' } } };
}


/** Две работы; в первой комната r-01 {s-01, s-02} с решением, ждущим человека (кусок 5, спека окна 2026-09-29, 2.7). */
function waitingWorks(): WorkEntry[] {
  const waiting = work('w-01', '2026-01-01', 'Возвраты', [session('s-01', 'один'), session('s-02', 'два')]);
  waiting.map.rooms = [
    {
      id: 'r-01',
      title: 'Возвраты',
      creator: 'human',
      members: ['s-01', 's-02'],
      createdAt: '2026-01-01',
      lead: 's-01',
      proposal: { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-01-02T00:00:00.000Z' },
    },
  ];
  return [waiting, work('w-02', '2026-01-02', 'Вторая', [session('s-01', 'три')])];
}

describe('AppShell — показ архивных (тесты 6, 7 куска 6.3)', () => {
  beforeEach(() => useUiStore.setState({ showArchived: false }));
  afterEach(() => useUiStore.setState({ showArchived: false }));

  it('Show archived workspaces: архивная — в конце своей секции и приглушена; второй вызов прячет', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]);
    const arch = archivedWork('w-09', '/tmp/w-01', []);
    const archKey = workKey('/tmp/w-01', 'w-09');
    await renderShell([w1, arch]);
    const card = () => document.querySelector<HTMLElement>(`[data-work-key="${CSS.escape(archKey)}"]`);
    expect(card()).toBeNull();

    await pickInPalette('Show archived', /^Show archived workspaces/);
    expect(card()).not.toBeNull();
    // Приглушение — data-dimmed (styles/dimmed.css), не opacity-60 (ревью M12).
    expect(card()?.hasAttribute('data-dimmed')).toBe(true);
    const keys = [...document.querySelectorAll<HTMLElement>('[data-work-key]')].map((element) => element.dataset.workKey);
    expect(keys.at(-1)).toBe(archKey);

    await pickInPalette('Show archived', /^Show archived workspaces/);
    expect(card()).toBeNull();
  });

  it('архивная с сессией needs-you видна, но строка статуса её не считает, а attention.next её не выбирает', async () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]);
    const arch = archivedWork('w-09', '/tmp/w-09', [session('s-09', 'ждёт')]);
    const ref = { projectPath: '/tmp/w-09', workId: 'w-09', sessionId: 's-09' };
    useActivityStore.setState({
      byRef: {
        [refKey(ref)]: {
          ref,
          activity: { activity: 'blocked', subagents: 0, turnEndedAt: null, lastEventAt: '2026-01-05T00:00:00.000Z', source: 'hooks', exited: false, hooksMissing: false },
          metrics: null,
        },
      },
    });
    await renderShell([w1, arch]);
    act(() => useUiStore.getState().toggleShowArchived());
    await flush();

    expect(document.querySelector(`[data-work-key="${CSS.escape(workKey('/tmp/w-09', 'w-09'))}"]`)).not.toBeNull();
    expect(document.querySelector('[data-attention-segment]')).toBeNull();

    await pickInPalette('Next session', /^Next session that needs you/);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
  });

  // Кусок 5 плана «Organic», спека окна 2026-09-29, 2.7: комната с ждущим решением — «нужен ты», как blocked.
  it('комната с ждущим решением: строка статуса «1 needs you», карточка со значком вопроса и подкрашенной строкой комнаты', async () => {
    await renderShell(waitingWorks());

    expect(document.querySelector('[data-attention-segment]')?.textContent).toBe('1 needs you');
    const card = document.querySelector(`[data-work-key="${CSS.escape(keyOf('w-01'))}"]`) as HTMLElement;
    expect(card.querySelector('[data-work-glyph] [data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('blocked');
    // Участники комнаты отдельными строками не выводятся; строка комнаты подкрашена и подписана.
    expect(card.querySelector('[data-session-id="s-01"]')).toBeNull();
    const row = card.querySelector('[data-room-row="r-01"]') as HTMLElement;
    expect(row.textContent).toContain('decision');
    expect(row.className).toContain('bg-accent-200');
  });

  it('клик по счётчику строки статуса при ждущем решении открывает вкладку комнаты (яруса blocked нет)', async () => {
    await renderShell(waitingWorks());
    fireEvent.click(document.querySelector('[data-attention-segment]') as HTMLElement);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-01')]).toBe(true));
    const layout = useLayoutStore.getState().layouts[keyOf('w-01')];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.room('r-01')]);
  });

  // Цели «следующей» — один список blocked → комната с решением → unseen по кругу от текущей вкладки (2.7): пока в
  // работах есть blocked-сессия, клик не застревает на ней, а доходит до комнаты с решением (сцена dark-04).
  it('blocked-сессия и комната с решением: «2 need you»; клики по счётчику идут терминал → комната → снова терминал', async () => {
    const [waiting, other] = waitingWorks() as [WorkEntry, WorkEntry];
    const ref = { projectPath: other.projectPath, workId: 'w-02', sessionId: 's-01' };
    useActivityStore.setState({
      byRef: {
        [refKey(ref)]: {
          ref,
          activity: { activity: 'blocked', subagents: 0, turnEndedAt: null, lastEventAt: '2026-01-05T00:00:00.000Z', source: 'hooks', exited: false, hooksMissing: false },
          metrics: null,
        },
      },
    });
    await renderShell([waiting, other]);
    const segment = (): HTMLElement => document.querySelector('[data-attention-segment]') as HTMLElement;
    expect(segment().textContent).toBe('2 need you');

    fireEvent.click(segment());
    await waitFor(() => expect(useLayoutStore.getState().hydrated[keyOf('w-02')]).toBe(true));
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    expect(activeTabOf(keyOf('w-02'))).toBe(tabId.terminal('s-01'));

    fireEvent.click(segment());
    await waitFor(() => expect(activeTabOf(keyOf('w-01'))).toBe(tabId.room('r-01')));
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    fireEvent.click(segment());
    await waitFor(() => expect(activeTabOf(keyOf('w-02'))).toBe(tabId.terminal('s-01')));
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });
});

describe('AppShell — действия 6.3 из палитры (тесты 8, 9 куска 6.3)', () => {
  afterEach(() => useHostStore.setState({ status: { state: 'connecting' } }));

  it('Restart host…: подтверждение из стора; app.restartHost — только после Restart', async () => {
    const restartHost = vi.spyOn(bridge.app, 'restartHost');
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);

    await pickInPalette('Restart host', /^Restart host/);
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'Restart host?' })).toBeTruthy();
    expect(restartHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await flush();
    expect(restartHost).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().dialogs.restartHost).toBe(false);
  });

  it('Host is outdated — restart строки статуса открывает тот же диалог стора', async () => {
    useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
    render(<AppShell bridge={bridge} status={{ state: 'connected', hostVersion: '0.0.1', methods: null }} fontFamily="Menlo" fontSize={13} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Host is outdated — restart' }));
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
  });

  it('отказ app.restartHost — тост Couldn\'t restart host: …', async () => {
    vi.mocked(toast).mockClear();
    vi.spyOn(bridge.app, 'restartHost').mockRejectedValueOnce(encodeIpcError({ code: 'internal', message: 'сбой' }));
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    act(() => useUiStore.getState().confirmRestartHost());
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("Couldn't restart host: host error."));
  });

  it('New session — диалог с родителем, выбранной сессией (как ⌘T)', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
    await pickInPalette('New session', /^New session/);
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, parentSessionId: 's-01', work: null });
  });

  it('New room — «Создать комнату» активной работы без обязательного участника', async () => {
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await pickInPalette('New room', /^New room/);
    expect(useUiStore.getState().dialogs.createRoom).toEqual({ projectPath: '/tmp/w-01', workId: 'w-01', requiredMember: null });
  });

  it('Pause auto-wake — wake.pause; отказ — тост Couldn\'t toggle auto-wake: …', async () => {
    vi.mocked(toast).mockClear();
    bridge.setHandler('wake.state', () => ({ paused: false }));
    const pauses: unknown[] = [];
    bridge.setHandler('wake.pause', (params) => {
      pauses.push(params);
      return { paused: true };
    });
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    // wake.toggle доступен только с wake.pause и wake.resume хоста.
    act(() => useHostStore.setState({ status: STATUS }));
    act(() => useUiStore.setState({ wakePaused: false }));
    await pickInPalette('Pause auto-wake', /^Pause auto-wake/);
    await waitFor(() => expect(pauses).toHaveLength(1));
    expect(useUiStore.getState().wakePaused).toBe(true);

    bridge.setHandler('wake.resume', () => {
      throw encodeIpcError({ code: 'internal', message: 'сбой' });
    });
    await pickInPalette('Resume auto-wake', /^Resume auto-wake/);
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("Couldn't toggle auto-wake: host error."));
  });

  it('кнопка будильника строки статуса: отказ wake.pause — тот же тост, без необработанного отказа', async () => {
    vi.mocked(toast).mockClear();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      bridge.setHandler('wake.state', () => ({ paused: false }));
      bridge.setHandler('wake.pause', () => {
        throw encodeIpcError({ code: 'internal', message: 'сбой' });
      });
      await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
      act(() => useUiStore.setState({ wakePaused: false }));
      fireEvent.click(screen.getByRole('button', { name: 'Auto-wake on' }));
      await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("Couldn't toggle auto-wake: host error."));
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('Theme: dark — setAppearance, app.saveUi не зовётся', async () => {
    const setAppearance = vi.spyOn(bridge.app, 'setAppearance');
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    await pickInPalette('Theme: dark', /^Theme: dark/);
    expect(setAppearance).toHaveBeenCalledWith('dark');
    expect(saveUi).not.toHaveBeenCalled();
  });

  it('⌘T без активной работы — тост No active workspace, диалога нет', async () => {
    vi.mocked(toast).mockClear();
    render(<AppShell bridge={bridge} status={STATUS} fontFamily="Menlo" fontSize={13} />);
    await flush();
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', metaKey: true });
    expect(vi.mocked(toast)).toHaveBeenCalledWith('No active workspace');
    expect(useUiStore.getState().dialogs.newSession.open).toBe(false);
  });
});

describe('AppShell — фокус после выбора строки палитры (перенос ревью 6.2-B, Important 1)', () => {
  /** xterm-мок с помощником ввода, как у настоящего: focus() поверхности кладёт в него фокус. */
  function helperTextareas(): void {
    xtermMock.onOpen = (element, terminal) => {
      const xterm = document.createElement('div');
      xterm.className = 'xterm';
      const helper = document.createElement('textarea');
      helper.className = 'xterm-helper-textarea';
      xterm.appendChild(helper);
      element.appendChild(xterm);
      terminal.focus = () => helper.focus();
    };
  }

  it('сессия другой работы: вкладка открыта, фокус — в её терминале, а не body', async () => {
    helperTextareas();
    await renderShell([
      work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]),
      work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'исполнитель')]),
    ]);
    act(() => useLayoutStore.getState().setActiveWork(keyOf('w-01')));
    await flush();

    await pickInPalette('исполнитель', /исполнитель/);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
    await waitFor(() => {
      const active = document.activeElement;
      expect(active?.classList.contains('xterm-helper-textarea')).toBe(true);
      expect(active?.closest('[data-work-container]')?.getAttribute('data-work-container')).toBe(keyOf('w-02'));
    });
  });

  it('вкладка терминала уже открыта и активна — фокус всё равно в терминале', async () => {
    helperTextareas();
    await renderShell([work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')])]);
    await activateWithTerminal(keyOf('w-01'), 's-01');
    const card = document.querySelector<HTMLElement>('[data-work-key]');
    card?.focus();

    await pickInPalette('один', /один/);
    await waitFor(() => expect(document.activeElement?.classList.contains('xterm-helper-textarea')).toBe(true));
  });

  it('комната: фокус — в поле ввода её тела', async () => {
    const base = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]);
    const withRoom: WorkEntry = { ...base, map: { ...base.map, rooms: [{ id: 'r-01', title: 'Совещание', creator: 'human', members: ['s-01'], createdAt: '2026-01-01T00:00:00.000Z' }] } };
    await renderShell([withRoom]);

    await pickInPalette('Совещание', /Совещание/);
    await waitFor(() => {
      const active = document.activeElement;
      expect(active === null || active === document.body).toBe(false);
      expect(active?.closest('[data-group-body]') !== null || active?.getAttribute('role') === 'tab').toBe(true);
    });
  });
});

describe('AppShell — несохранённые файлы при закрытии вкладок и окна (тесты 6 и 11 куска 7.3a)', () => {
  const W = keyOf('w-01');
  const root = { workKey: W, spec: { kind: 'project' as const } };
  const fileTab = (path: string): TabSpec => ({ kind: 'file', id: tabId.file({ kind: 'project' }, path), root: { kind: 'project' }, path });
  const A = fileTab('src/a.ts');
  const B = fileTab('src/b.ts');
  const text = (value: string) => ({ text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null });

  // Буферы — модульный стор: предыдущий тест оставил бы свои (с его мостом).
  beforeEach(() => useFilesStore.setState({ buffers: {}, reveals: {} }));

  /** Открывает A и B (активна B), делает A грязной — её тело уже размонтировано. */
  async function openDirtyA(extra: WorkEntry[] = []): Promise<void> {
    bridge.setFile(root, 'src/a.ts', text('a'));
    bridge.setFile(root, 'src/b.ts', text('b'));
    await renderShell([work('w-01', '2026-01-01', 'One', [session('s-01', 'one')]), ...extra]);
    act(() => useLayoutStore.getState().setActiveWork(W));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[W]).toBe(true));
    act(() => {
      useLayoutStore.getState().apply(W, (layout) => openTab(layout, A));
    });
    const editor = await screen.findByTestId('monaco-textarea');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('a'));
    fireEvent.change(editor, { target: { value: 'a2' } });
    act(() => {
      useLayoutStore.getState().apply(W, (layout) => openTab(layout, B));
    });
    await waitFor(() => expect((screen.getByTestId('monaco-textarea') as HTMLTextAreaElement).value).toBe('b'));
  }

  const tabEl = (tab: TabSpec): HTMLElement => document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${tab.id}"]`) as HTMLElement;
  const openIds = (): string[] => {
    const layout = useLayoutStore.getState().layouts[W];
    return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
  };

  it('точка «не сохранён» на грязной вкладке; крестик — вопрос, Cancel оставляет вкладку', async () => {
    await openDirtyA();
    expect(tabEl(A).querySelector('[data-dirty-dot]')).not.toBeNull();
    expect(tabEl(B).querySelector('[data-dirty-dot]')).toBeNull();
    // Крестик — только у активной вкладки (Organic, 1.1): фоновую A сначала активируем, а её закрытие
    // без активации — средней кнопкой, тест ниже.
    expect(within(tabEl(A)).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(tabEl(A));
    fireEvent.click(within(tabEl(A)).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(openIds()).toEqual([A.id, B.id]);
    expect(bridge.writes).toEqual([]);
  });

  it("средняя кнопка — вопрос, Don't save закрывает без write", async () => {
    await openDirtyA();
    fireEvent(tabEl(A), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(openIds()).toEqual([B.id]));
    expect(bridge.writes).toEqual([]);
    // Буфер A отпущен вместе со своим слежением; прочие подписки — дерева «Файлов».
    const watchA = bridge.watchCalls.find((call) => call.path === 'src/a.ts')?.id;
    await waitFor(() => expect(bridge.unwatchCalls).toContain(watchA));
    expect(bridge.unwatchCalls).not.toContain(bridge.watchCalls.find((call) => call.path === 'src/b.ts')?.id);
  });

  it('Close others с активной B — вопрос про неактивную грязную A; Save пишет и закрывает', async () => {
    await openDirtyA();
    fireEvent.contextMenu(tabEl(B));
    fireEvent.click(screen.getByText('Close others'));
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(openIds()).toEqual([B.id]));
    expect(bridge.writes).toEqual([{ root, path: 'src/a.ts', text: 'a2', expectedMtimeMs: 1 }]);
  });

  it('app:confirm-close: вопрос по всем грязным буферам; Save all пишет и отвечает close; без грязных — close сразу', async () => {
    await openDirtyA();
    await waitFor(() => expect(bridge.dirtyBufferCounts.at(-1)).toBe(1));
    act(() => bridge.emitConfirmClose());
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['close']));
    expect(bridge.writes).toHaveLength(1);
    await waitFor(() => expect(bridge.dirtyBufferCounts.at(-1)).toBe(0));

    act(() => bridge.emitConfirmClose());
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['close', 'close']));
  });

  it('вопрос вкладки и вопрос окна на один файл: Save вкладки, затем ответ окна — close без ложной ошибки (fix-7.3 п. 3)', async () => {
    await openDirtyA();
    fireEvent.click(tabEl(A));
    fireEvent.click(within(tabEl(A)).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    // ⌘Q, пока открыт вопрос вкладки: вопрос окна встаёт в очередь вторым.
    act(() => bridge.emitConfirmClose());
    vi.mocked(toast).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(openIds()).toEqual([B.id]));
    // Вопрос окна по уже сохранённому и отпущенному буферу: «Save» не ошибка, окно закрывается.
    fireEvent.click(await screen.findByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['close']));
    expect(toast).not.toHaveBeenCalledWith("Couldn't save all files — the window stays open");
    expect(bridge.writes).toHaveLength(1);
  });

  it('beforeunload: грязные буферы — страница отменяет выгрузку (main спросит), без них — нет (fix-7.3 п. 4б)', async () => {
    await openDirtyA();
    const unload = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(true);
    // Ответ «Don't save» на вопрос окна: main закроет или повторит перезагрузку — страница не мешает.
    act(() => bridge.emitConfirmClose());
    fireEvent.click(await screen.findByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['close']));
    expect(unload()).toBe(false);
    // Новая правка после ответа — снова отмена.
    act(() => useFilesStore.getState().dispatch(bufferKey(W, A.id), { type: 'edited', text: 'a3' }));
    expect(unload()).toBe(true);
    useFilesStore.setState({ buffers: {} });
    expect(unload()).toBe(false);
  });

  describe('работа исчезла из снимка не через меню окна (fix-7.3 п. 1)', () => {
    const other = (): WorkEntry => work('w-02', '2026-01-02', 'Two', [session('s-02', 'two')]);
    const vanish = (): void => act(() => useWorksStore.setState({ entries: [other()] }));
    const question = 'Workspace “One” was deleted — unsaved changes in 1 file';

    it('грязный буфер — вопрос; раскладка ждёт ответа; Save пишет файл, затем раскладка уходит', async () => {
      await openDirtyA([other()]);
      vanish();
      expect(await screen.findByText(question)).toBeTruthy();
      expect(useLayoutStore.getState().layouts[W]).toBeDefined();
      // Отменить удаление нельзя: Esc не отбрасывает правки молча.
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await flush();
      expect(screen.getByText(question)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(useLayoutStore.getState().layouts[W]).toBeUndefined());
      expect(bridge.writes).toEqual([{ root, path: 'src/a.ts', text: 'a2', expectedMtimeMs: 1 }]);
      expect(useFilesStore.getState().buffers).toEqual({});
    });

    it('Discard — без записи, буфер отпущен, раскладка ушла', async () => {
      await openDirtyA([other()]);
      vanish();
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(useLayoutStore.getState().layouts[W]).toBeUndefined());
      expect(bridge.writes).toEqual([]);
      expect(useFilesStore.getState().buffers).toEqual({});
    });

    it('запись не удалась (папки больше нет) — тост с именами несохранённых', async () => {
      await openDirtyA([other()]);
      bridge.files.write = async () => Promise.reject({ code: 'not_found', message: 'gone' });
      vi.mocked(toast).mockClear();
      vanish();
      fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
      await waitFor(() => expect(useLayoutStore.getState().layouts[W]).toBeUndefined());
      expect(toast).toHaveBeenCalledWith("Couldn't save: a.ts");
    });

    it('без грязных буферов — раскладка уходит сразу, без вопроса', async () => {
      await renderShell([work('w-01', '2026-01-01', 'One', [session('s-01', 'one')]), other()]);
      act(() => useLayoutStore.getState().setActiveWork(W));
      await waitFor(() => expect(useLayoutStore.getState().hydrated[W]).toBe(true));
      vanish();
      expect(useLayoutStore.getState().layouts[W]).toBeUndefined();
      expect(screen.queryByTestId('save-changes-dialog')).toBeNull();
    });
  });

  it("app:confirm-close: Cancel — cancel; ошибка записи Save all — cancel и тост", async () => {
    await openDirtyA();
    act(() => bridge.emitConfirmClose());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['cancel']));

    bridge.setWriteConflict(root, 'src/a.ts', 99);
    vi.mocked(toast).mockClear();
    act(() => bridge.emitConfirmClose());
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.closeAnswers).toEqual(['cancel', 'cancel']));
    expect(toast).toHaveBeenCalledWith("Couldn't save all files — the window stays open");
  });
});

describe('AppShell — буфер файла переживает тело (тест 2 куска 7.3b) и ⌘D в Monaco (тест 7)', () => {
  const fileTab = (path: string): TabSpec => ({ kind: 'file', id: tabId.file({ kind: 'project' }, path), root: { kind: 'project' }, path });
  const A = fileTab('src/a.ts');
  const text = (value: string) => ({ text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null });
  const W1 = keyOf('w-01');
  const root = { workKey: W1, spec: { kind: 'project' as const } };
  const textarea = (): HTMLTextAreaElement | null =>
    container(W1)?.querySelector<HTMLTextAreaElement>('[data-testid="monaco-textarea"]') ?? null;
  const readsOfA = (): number => bridge.readTextCalls.filter((call) => call.root.workKey === W1 && call.path === 'src/a.ts').length;

  beforeEach(() => useFilesStore.setState({ buffers: {}, reveals: {} }));

  async function editA(): Promise<void> {
    bridge.setFile(root, 'src/a.ts', text('a'));
    await renderShell(fourWorks());
    await activateWithTerminal(W1, 's-01');
    act(() => {
      useLayoutStore.getState().apply(W1, (layout) => openTab(layout, A));
    });
    await waitFor(() => expect(textarea()?.value).toBe('a'));
    fireEvent.change(textarea() as HTMLTextAreaElement, { target: { value: 'mine' } });
  }

  it('другая вкладка той же группы и обратно — текст прежний, readText один', async () => {
    await editA();
    act(() => {
      useLayoutStore.getState().apply(W1, (layout) => openTab(layout, term('s-01')));
    });
    await waitFor(() => expect(textarea()).toBeNull());
    act(() => {
      useLayoutStore.getState().apply(W1, (layout) => openTab(layout, A));
    });
    await waitFor(() => expect(textarea()?.value).toBe('mine'));
    expect(readsOfA()).toBe(1);
  });

  it('перенос вкладки в другую группу — текст прежний, readText один', async () => {
    await editA();
    const layout = useLayoutStore.getState().layouts[W1];
    if (layout === undefined) throw new Error('нет раскладки');
    act(() => {
      useLayoutStore.getState().apply(W1, (l) => splitGroup(l, layout.activeGroupId, 'row', term('s-01'), { [layout.activeGroupId]: { width: 800, height: 600 } }));
    });
    const [first, second] = groups(useLayoutStore.getState().layouts[W1] as NonNullable<typeof layout>);
    if (first === undefined || second === undefined) throw new Error('нет двух групп');
    act(() => {
      useLayoutStore.getState().apply(W1, (l) => moveTab(l, A.id, { groupId: second.id, index: 0 }));
    });
    await waitFor(() => expect(textarea()?.value).toBe('mine'));
    expect(groups(useLayoutStore.getState().layouts[W1] as NonNullable<typeof layout>).find((group) => group.id === second.id)?.activeTabId).toBe(A.id);
    expect(readsOfA()).toBe(1);
  });

  it('работа вытеснена из трёх последних LRU (четыре работы) и возвращена — текст прежний, readText один', async () => {
    await editA();
    await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-03'), 's-03');
    await activateWithTerminal(keyOf('w-04'), 's-04');
    expect(container(W1)).toBeNull();
    act(() => useLayoutStore.getState().setActiveWork(W1));
    await waitFor(() => expect(textarea()?.value).toBe('mine'));
    expect(readsOfA()).toBe(1);
  });

  it('⌘D внутри .monaco-editor группу не делит (тест 7)', async () => {
    await editA();
    const field = textarea() as HTMLTextAreaElement;
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'd', code: 'KeyD', metaKey: true });
    await flush();
    // ⌘D окна — выбор, что открыть справа (палитра в режиме splitRight): в редакторе его нет.
    expect(usePaletteStore.getState().open).toBe(false);
    // Положительный контроль: вне редактора то же ⌘D выбор открывает.
    field.blur();
    fireEvent.keyDown(document.body, { key: 'd', code: 'KeyD', metaKey: true });
    await flush();
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'splitRight' });
  });
});

describe('AppShell — страница в окне (тесты 1 и 3 куска 9.2b, window.open)', () => {
  const PAGE = 'browser:0000d1';

  afterEach(() => {
    useBrowserStore.setState({ tabs: {}, limitToasted: {} });
  });

  /** w-01: g1 — терминал s-01 (активная группа), g2 — терминал s-02 и страница PAGE (активная в g2) с id гостя 7. */
  async function pageInSecondGroup(): Promise<{ key: string; g1: string; g2: string }> {
    await renderShell([
      work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один'), session('s-02', 'два')]),
      work('w-02', '2026-01-02', 'Вторая', [session('s-03', 'три')]),
    ]);
    const key = keyOf('w-01');
    act(() => useLayoutStore.getState().setActiveWork(key));
    await waitFor(() => expect(useLayoutStore.getState().hydrated[key]).toBe(true));
    act(() => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, term('s-01')));
      const layout = useLayoutStore.getState().layouts[key];
      if (layout === undefined) throw new Error('нет раскладки');
      useLayoutStore.getState().apply(key, (l) => splitGroup(l, layout.activeGroupId, 'row', term('s-02'), { [layout.activeGroupId]: { width: 800, height: 600 } }));
      useLayoutStore.getState().apply(key, (l) => openTab(l, { kind: 'browser', id: PAGE, url: 'http://127.0.0.1:5173/' }));
    });
    await flush();
    act(() => useBrowserStore.getState().update(PAGE, { webContentsId: 7 }));
    const layout = useLayoutStore.getState().layouts[key];
    if (layout === undefined) throw new Error('нет раскладки');
    const [g1, g2] = groups(layout).map((group) => group.id);
    if (g1 === undefined || g2 === undefined) throw new Error('нет групп');
    act(() => useLayoutStore.getState().apply(key, (l) => focusTab(l, tabId.terminal('s-01'))));
    return { key, g1, g2 };
  }

  it('тест 1: browser:focus страницы неактивной группы активной работы — её группа и вкладка активны', async () => {
    const { key, g2 } = await pageInSecondGroup();
    act(() => bridge.emitBrowserFocus({ webContentsId: 7 }));
    const layout = useLayoutStore.getState().layouts[key];
    expect(layout?.activeGroupId).toBe(g2);
    expect(groups(layout!).find((group) => group.id === g2)?.activeTabId).toBe(PAGE);
  });

  it('тест 1: вкладка скрытой работы LRU и неактивная вкладка своей группы — раскладка не меняется', async () => {
    const { key } = await pageInSecondGroup();
    act(() => useLayoutStore.getState().apply(key, (l) => focusTab(l, tabId.terminal('s-02'))));
    act(() => useLayoutStore.getState().apply(key, (l) => focusTab(l, tabId.terminal('s-01'))));
    const hiddenInGroup = useLayoutStore.getState().layouts[key];
    act(() => bridge.emitBrowserFocus({ webContentsId: 7 }));
    expect(useLayoutStore.getState().layouts[key]).toBe(hiddenInGroup);

    act(() => useLayoutStore.getState().apply(key, (l) => focusTab(focusTab(l, PAGE), tabId.terminal('s-01'))));
    await activateWithTerminal(keyOf('w-02'), 's-03');
    const before = useLayoutStore.getState().layouts[key];
    act(() => bridge.emitBrowserFocus({ webContentsId: 7 }));
    expect(useLayoutStore.getState().layouts[key]).toBe(before);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-02'));
  });

  it('тест 3: пункты browser.find и browser.zoomIn — у страницы активной вкладки активной группы', async () => {
    const { key } = await pageInSecondGroup();
    act(() => bridge.emitMenu('browser.zoomIn'));
    expect(bridge.browserCalls).toEqual([]);
    act(() => bridge.emitBrowserFocus({ webContentsId: 7 }));
    act(() => bridge.emitMenu('browser.zoomIn'));
    act(() => bridge.emitMenu('browser.find'));
    await flush();
    expect(bridge.browserCalls).toEqual([{ method: 'zoom', args: [7, 1] }]);
    expect(useBrowserStore.getState().tabs[PAGE]?.findOpen).toBe(true);
    expect(useLayoutStore.getState().layouts[key]).toBeDefined();
  });

  it('window.open страницы — вкладка сразу за открывателем в его группе; неизвестный открыватель — ничего', async () => {
    const { key, g1, g2 } = await pageInSecondGroup();
    act(() => bridge.emitBrowserOpenTab({ url: 'http://127.0.0.1:5173/popup', openerWebContentsId: 7 }));
    await flush();
    const layout = useLayoutStore.getState().layouts[key]!;
    const group = groups(layout).find((candidate) => candidate.id === g2)!;
    const index = group.tabs.findIndex((tab) => tab.id === PAGE);
    expect(group.tabs[index + 1]).toMatchObject({ kind: 'browser', url: 'http://127.0.0.1:5173/popup' });
    // Открыватель виден (активная вкладка своей группы в активной работе): новая вкладка — активная в g2,
    // активная группа — его группа, как в браузере.
    expect(group.activeTabId).toBe(group.tabs[index + 1]?.id);
    expect(layout.activeGroupId).toBe(g2);
    expect(layout.activeGroupId).not.toBe(g1);

    const before = useLayoutStore.getState().layouts[key];
    act(() => bridge.emitBrowserOpenTab({ url: 'http://127.0.0.1:5173/x', openerWebContentsId: 99 }));
    expect(useLayoutStore.getState().layouts[key]).toBe(before);
  });
});
