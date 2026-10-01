/**
 * Раунд исправлений 1 куска 1.3, находка B№3 (линза B, живой рендер): фон
 * старой палитры темы окна на корневом `<div>` заменили на `bg-background`,
 * пару `text-foreground` рядом — забыли (спека 4.9: старая палитра уходит
 * целиком). С куска 1.4 старой палитры в кодовой базе больше нет вовсе (её
 * файлы удалены) — тест переживает это как общую проверку: на корневом
 * `<div>` нет произвольного `var(...)`, только именованные токены.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkEntry, WorkSession } from '@parley/core';
import { App } from './App.js';
import { createFakeBridge, type FakeBridge } from './test-utils/fake-bridge.js';
import { bufferKey, initialBuffer } from './files/buffer.js';
import { useFilesStore } from './files/store.js';
import { EMPTY_HISTORY } from './layout/history.js';
import { tabId } from './layout/ids.js';
import { useLayoutStore } from './layout/store.js';
import { emptyLayout, openTab } from './layout/tree.js';
import { useActivityStore } from './store/activity.js';
import { useHostStore } from './store/host.js';
import { useNoticesStore } from './store/notices.js';
import { useProvidersStore } from './store/providers.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';
import { refKey, type SessionRef } from '@parley/protocol';
import { DEFAULT_UI } from '../shared/ui-types.js';
import type { Activity } from '@parley/core';
import { REQUIRED_METHODS } from './lib/capabilities.js';
import { useSidebarSectionsStore } from './sidebar/use-sidebar-sections.js';
import { toast } from 'sonner';
import { groups } from './layout/tree.js';
import { S } from '../shared/strings.js';
import type { TabSpec } from '../shared/layout-types.js';
import { workKey } from '../shared/work-keys.js';

// Тест 4 куска 4.3 проверяет вызов тоста, а не его разметку; `Toaster` остаётся настоящим.
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

// Тест 6 открывает вкладку-терминал; настоящий xterm в jsdom падает на
// `matchMedia` — поверхности тут не нужны, раскладка и диалог от них не зависят.
vi.mock('./layout/SurfaceLayer.js', () => ({ SurfaceLayer: () => null }));

// jsdom не знает ResizeObserver — группы раскладки и поверхности терминала
// заводят его при монтировании.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let bridge: FakeBridge;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useProvidersStore.setState({ providers: [] });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, work: null, room: false }, settings: false, mergeRoom: null, restartHost: false },
    visibleSessionRefs: {},
  });
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  useSidebarSectionsStore.setState({ sections: [], attention: {}, entries: null });
  // Стор связи общий на файл: `everConnected` прошлого теста убрал бы экран «No connection»
  // у теста, где связи ещё не было (слияние lane-r3).
  useHostStore.setState({ status: { state: 'connecting' }, everConnected: false });
  // `getHostClient()` читает `window.parley` лениво — подставляем вручную,
  // как и задумано (комментарий в `host-client.ts`).
  bridge = createFakeBridge();
  window.parley = bridge;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App — корневая обёртка окна (раунд исправлений 1, находка B№3)', () => {
  it('text-foreground рядом с bg-background, без произвольного var(--…) старой палитры', () => {
    const { container } = render(<App />);
    const root = container.querySelector('.bg-background');
    expect(root).not.toBeNull();
    expect(root?.className).toContain('text-foreground');
    expect(root?.className ?? '').not.toMatch(/var\(--/);
  });
});

// Спека окна 2026-09-29, 1.1: провайдеры строки статуса — `providers.list` при подключении к хосту и
// после переподключения, а не на каждый рендер.
describe('App — провайдеры строки статуса (Organic, 1.1)', () => {
  const answer = { providers: [{ id: 'claude', label: 'Claude', available: true, version: '2.1.276' }] };
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('providers.list зовётся один раз при подключении; событие работ и перерисовка его не повторяют', async () => {
    const handler = vi.fn(() => answer);
    bridge.setHandler('providers.list', handler);
    render(<App />);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    act(() => bridge.emit('works.changed', { entries: [], branches: {} }));
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('2.1.276')).toBeTruthy();
  });

  it('после переподключения — снова один вызов, свежая версия на месте', async () => {
    let version = '2.1.276';
    const handler = vi.fn(() => ({ providers: [{ id: 'claude', label: 'Claude', available: true, version }] }));
    bridge.setHandler('providers.list', handler);
    render(<App />);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    version = '2.2.0';
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
    await settle();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2.2.0')).toBeTruthy();
  });

  it('отказ providers.list — окно живёт, сегментов провайдеров нет', async () => {
    bridge.setHandler('providers.list', () => {
      throw new Error('нет метода');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<App />);
    await settle();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.getByText('Host 0.0.0-test')).toBeTruthy();
  });
});

// Раунд исправлений 1 куска E.1: русский `notice.text` хоста в уведомление не идёт. Тесты
// самого текста переехали в `attention/notify.test.ts` (тест 11 куска 4.3); здесь — сквозная
// регрессия через подставной мост.
describe('App — русский notice.text до уведомления не доходит (тест 11 куска 4.3)', () => {
  it('host.notice trust-wait с русским text — в appNotified этого text нет', async () => {
    useWorksStore.setState({ entries: [work('w-01', '2026-01-01', [session('s-03', 'backend')])], branches: {}, loading: false, error: null });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      bridge.emit('host.notice', {
        kind: 'trust-wait',
        ref: { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
        text: 'русский текст хоста, который никто не должен увидеть',
        at: '2026-01-01T00:00:00.000Z',
      });
    });

    expect(bridge.appNotified).toHaveLength(1);
    expect(JSON.stringify(bridge.appNotified)).not.toContain('русский текст хоста');
    expect(bridge.appNotified[0]).toMatchObject({
      title: 'w-01 · S03 backend — waiting for folder trust',
      body: 'Not responding since launch — may be waiting for folder trust.',
    });
  });
});

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

function work(id: string, createdAt: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

// Кусок 2.7: выбор сессии больше не хранится в `store/ui.ts` (его выводит `selectedSessionOf`). С куска 7 плана
// «Organic» ⌘T родителя не берёт вовсе: диалог 1.5 открывается на `activeWorkKey`.
describe('App — меню session.new (тест 6 куска 2.7, тест 4 куска 6.1b)', () => {
  it('settings.open открывает настройки — ветка run в AppShell, у App своего onMenu нет', async () => {
    useWorksStore.setState({ entries: [work('w-01', '2026-01-01', [session('s-01', 'план')])], branches: {}, loading: false, error: null });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => bridge.emitMenu('settings.open'));
    expect(useUiStore.getState().dialogs.settings).toBe(true);
  });

  it('⌘T — диалог 1.5 открывается на активной работе одним агентом (кусок 7: родителя больше нет)', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', [session('s-01', 'бэк'), session('s-02', 'фронт')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    const key2 = '/tmp/w-02 w-02';
    const layout = openTab(openTab(emptyLayout(), { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' }), {
      kind: 'terminal',
      id: tabId.terminal('s-02'),
      sessionId: 's-02',
    });
    useLayoutStore.setState({ activeWorkKey: key2, layouts: { [key2]: layout }, hydrated: { [key2]: true } });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => bridge.emitMenu('session.new'));

    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, work: null, room: false });
    // Диалог берёт активную работу сам: в его поле «Workspace» — она.
    expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveProperty('textContent', 'w-02 · w-02');
  });
});

// Тест 15 куска 3.4: «New session» из меню карточки открывает диалог её работы, даже если
// она не активна; ⌘T после этого — снова диалог активной работы.
describe('App — «New session» из меню карточки (тест 15 куска 3.4)', () => {
  it('диалог получает работу карточки; ⌘T после закрытия — активную работу', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', [session('s-02', 'бэк')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    const key1 = '/tmp/w-01 w-01';
    useLayoutStore.setState({ activeWorkKey: key1, layouts: { [key1]: emptyLayout() }, hydrated: { [key1]: true } });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.contextMenu(document.querySelector('[data-work-key="/tmp/w-02 w-02"]') as HTMLElement);
    fireEvent.click(screen.getByText('New session'));
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, work: { projectPath: '/tmp/w-02', workId: 'w-02' }, room: false });
    expect(useLayoutStore.getState().activeWorkKey).toBe(key1);
    expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveProperty('textContent', 'w-02 · w-02');

    act(() => useUiStore.getState().closeNewSessionDialog());
    act(() => bridge.emitMenu('session.new'));
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, work: null, room: false });
    expect(await screen.findByRole('combobox', { name: 'Workspace' })).toHaveProperty('textContent', 'w-01 · w-01');
  });
});

// Кусок 4.2: бейдж Dock и трекер «просмотрено» живут в эффекте App.
describe('App — бейдж и «просмотрено» (тесты 8 и 13 куска 4.2)', () => {
  const ref: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };

  function emitActivity(activity: Activity, tokensIn = 0): void {
    act(() => {
      bridge.emit('activity.changed', {
        ref,
        activity: { activity, subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
        metrics: { tokensIn, tokensOut: 0, durationMs: 0, unread: 0, subagents: 0, model: 'opus' },
      });
    });
  }

  function seenNotifications(): unknown[] {
    return bridge.notified.filter((note) => note.method === 'activity.seen').map((note) => note.params);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('тест 8: бейдж — badgeCount при каждом его изменении и только тогда', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    w1.map.messages = [
      { id: 'm-1', roomId: null, from: 's-01', to: ['human'], at: '2026-01-01T00:00:00.000Z', text: 'вопрос', kind: 'question', readBy: {} },
    ];
    useWorksStore.setState({ entries: [w1], branches: {}, loading: false, error: null });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.badges).toEqual([1]);

    emitActivity('blocked');
    expect(bridge.badges).toEqual([1, 2]);
    emitActivity('blocked', 5);
    expect(bridge.badges).toEqual([1, 2]);
    // unseen в бейдж не входит.
    emitActivity('unseen');
    expect(bridge.badges).toEqual([1, 2, 1]);
    emitActivity('idle');
    expect(bridge.badges).toEqual([1, 2, 1]);
  });

  it('видимая сессия в unseen 1 с — activity.seen; окно без фокуса — нет', async () => {
    vi.useFakeTimers();
    useWorksStore.setState({ entries: [work('w-01', '2026-01-01', [session('s-01', 'план')])], branches: {}, loading: false, error: null });
    useUiStore.setState({ visibleSessionRefs: { [refKey(ref)]: true }, windowFocused: false });
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    emitActivity('unseen');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(seenNotifications()).toEqual([]);

    act(() => useUiStore.setState({ windowFocused: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(seenNotifications()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(seenNotifications()).toEqual([{ ref }]);
  });

  it('тест 13: хост без activity.seen — bridge.notify не зовётся; после setHostMethods(REQUIRED_METHODS) уходит', async () => {
    vi.useFakeTimers();
    bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'activity.seen'));
    useWorksStore.setState({ entries: [work('w-01', '2026-01-01', [session('s-01', 'план')])], branches: {}, loading: false, error: null });
    useUiStore.setState({ visibleSessionRefs: { [refKey(ref)]: true }, windowFocused: true });
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    emitActivity('unseen');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(seenNotifications()).toEqual([]);

    act(() => bridge.setHostMethods([...REQUIRED_METHODS]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(seenNotifications()).toEqual([{ ref }]);
  });
});

// Кусок 4.3: клик по уведомлению приходит событием `app:focus-target` (`onFocusTarget`).
describe('App — переход по цели уведомления (тесты 4 и 15 куска 4.3)', () => {
  const key = '/tmp/w-02 w-02';
  const target = { kind: 'session', ref: { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-02' } } as const;

  afterEach(() => {
    vi.mocked(toast).mockClear();
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const terminalTabs = (): string[] => {
    const layout = useLayoutStore.getState().layouts[key];
    return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
  };

  it('тест 4: цель удалённой сессии — тост «Workspace or session no longer exists», ничего не открыто', async () => {
    useWorksStore.setState({ entries: [work('w-01', '2026-01-01', [session('s-01', 'план')])], branches: {}, loading: false, error: null });
    render(<App />);
    await flush();

    act(() => bridge.emitFocusTarget(target));
    expect(toast).toHaveBeenCalledWith('Workspace or session no longer exists');
    expect(useLayoutStore.getState().activeWorkKey).not.toBe(key);
  });

  it('тест 4: живая цель — работа активна, вкладка её терминала открыта, тоста нет', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', [session('s-02', 'бэк')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    render(<App />);
    await flush();

    act(() => bridge.emitFocusTarget(target));
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(key);
    expect(terminalTabs()).toContain('terminal:s-02');
    expect(toast).not.toHaveBeenCalled();
  });

  // Раунд fix-tests, п. 3: опрос ожидания показа вкладки переживал размонтирование App и
  // срабатывал уже без jsdom — «document is not defined» после конца файла тестов.
  it('размонтирование App снимает ожидание показа вкладки: опрос DOM больше не срабатывает', async () => {
    vi.useFakeTimers();
    try {
      const w2 = work('w-02', '2026-01-02', [session('s-02', 'бэк')]);
      useWorksStore.setState({ entries: [w2], branches: {}, loading: false, error: null });
      const { unmount } = render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const query = vi.spyOn(document, 'querySelectorAll');
      act(() => bridge.emitFocusTarget(target));
      // Поверхностей в этом файле нет (SurfaceLayer заглушён) — вкладка «не показана», идёт опрос.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(query).toHaveBeenCalled();

      unmount();
      query.mockClear();
      await vi.advanceTimersByTimeAsync(3000);
      expect(query).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('тест 15: отложенная цель до ответа works.list ждёт его — без тоста; после ответа применена', async () => {
    const w2 = work('w-02', '2026-01-02', [session('s-02', 'бэк')]);
    let answer: (value: { entries: WorkEntry[]; branches: Record<string, string | null> }) => void = () => {};
    bridge.setHandler('works.list', () => new Promise((resolve) => (answer = resolve)));
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    bridge.setPendingFocusTarget(target);

    render(<App />);
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).not.toBe(key);
    expect(toast).not.toHaveBeenCalled();

    answer({ entries: [w2], branches: {} });
    await flush();
    expect(useLayoutStore.getState().activeWorkKey).toBe(key);
    expect(terminalTabs()).toContain('terminal:s-02');
    expect(toast).not.toHaveBeenCalled();
  });
});

// V6 плана релиза 0.1.0: тост о новой версии заводится вместе с прочими подписками окна — на подключении к хосту
// (рядом с `Toaster`, который живёт в той же ветке). Кнопки тоста и его правила — `update/update-notice.test.ts`.
describe('App — тост о новой версии (V6 плана релиза 0.1.0)', () => {
  const update = { version: '0.2.0', url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.2.0' };

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  beforeEach(() => {
    useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
    vi.mocked(toast).mockClear();
    vi.mocked(toast.dismiss).mockClear();
  });
  afterEach(() => {
    useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
    vi.mocked(toast).mockClear();
    vi.mocked(toast.dismiss).mockClear();
  });

  it('main нашёл релиз новее — тост «Parley 0.2.0 is available»', async () => {
    render(<App />);
    await settle();

    act(() => bridge.emitUpdate(update));

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Parley 0.2.0 is available', expect.objectContaining({ id: 'update-available' }));
  });

  it('релиз, найденный до подключения, показывается после него — а пока хост не подключён, подписки нет', async () => {
    bridge.setPendingUpdate(update);
    bridge.emitStatus({ state: 'connecting' });
    render(<App />);
    await settle();
    expect(toast).not.toHaveBeenCalled();

    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
    await settle();

    expect(toast).toHaveBeenCalledWith('Parley 0.2.0 is available', expect.anything());
  });

  it('переключатель «Check for updates» выключен в ui.json — тоста нет', async () => {
    await bridge.app.saveUi({ checkForUpdates: false });
    render(<App />);
    await settle();

    act(() => bridge.emitUpdate(update));

    expect(toast).not.toHaveBeenCalled();
  });

  it('смахнутый тост записывает версию в ui.json; новое подключение её уже не показывает', async () => {
    render(<App />);
    await settle();
    act(() => bridge.emitUpdate(update));
    const options = vi.mocked(toast).mock.calls[0]?.[1] as unknown as { onDismiss: () => void };

    act(() => options.onDismiss());
    await settle();
    expect((await bridge.app.loadUi()).dismissedUpdate).toBe('0.2.0');

    vi.mocked(toast).mockClear();
    bridge.setPendingUpdate(update);
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
    await settle();

    expect(toast).not.toHaveBeenCalled();
  });

  // «Later» — «позже», а не «никогда»: версия в ui.json не пишется, и на следующем подключении (как и при новом
  // запуске окна) тост на месте.
  it('«Later» версию в ui.json не записывает; новое подключение тост показывает снова', async () => {
    render(<App />);
    await settle();
    act(() => bridge.emitUpdate(update));
    const options = vi.mocked(toast).mock.calls[0]?.[1] as unknown as { cancel: { onClick: () => void } };

    act(() => options.cancel.onClick());
    await settle();
    expect((await bridge.app.loadUi()).dismissedUpdate).toBeNull();

    vi.mocked(toast).mockClear();
    bridge.setPendingUpdate(update);
    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));
    await settle();

    expect(toast).toHaveBeenCalledWith('Parley 0.2.0 is available', expect.anything());
  });
});

describe('App — вопрос при закрытии окна без связи с хостом (кусок 7.3a)', () => {
  it('экран «нет связи»: грязный буфер — вопрос Save all, Cancel → cancel; без грязных — close сразу', async () => {
    bridge.emitStatus({ state: 'disconnected', reason: 'gone' });
    render(<App />);
    await screen.findByText('No connection to host: gone');
    // Буфер — после экрана связи: правки пережили потерю связи, оболочки уже нет.
    const key = bufferKey('/tmp/p w', 'file:p:a.ts');
    useFilesStore.setState({
      buffers: {
        [key]: {
          root: { workKey: '/tmp/p w', spec: { kind: 'project' } },
          path: 'a.ts',
          watchId: null,
          model: { ...initialBuffer(), status: 'dirty', text: 'mine', savedText: 'disk', mtimeMs: 1, diskMtimeMs: 1 },
        },
      },
    });
    act(() => bridge.emitConfirmClose());
    expect(await screen.findByText('Save changes to a.ts?')).toBeTruthy();
    // Один файл — единственное число и у кнопки (fix-7.3 п. 5); «Save all» — от двух.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save all' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(bridge.closeAnswers).toEqual(['cancel']));

    const other = bufferKey('/tmp/p w', 'file:p:b.ts');
    useFilesStore.setState((state) => ({ buffers: { ...state.buffers, [other]: { ...state.buffers[key]!, path: 'b.ts' } } }));
    act(() => bridge.emitConfirmClose());
    fireEvent.click(await screen.findByRole('button', { name: 'Save all' }));
    await vi.waitFor(() => expect(bridge.closeAnswers).toHaveLength(2));

    useFilesStore.setState({ buffers: {} });
    act(() => bridge.emitConfirmClose());
    // Ответ идёт после сброса записей заметок (раунд fix-final-c, п. 2) — ждём сам третий ответ.
    await vi.waitFor(() => expect(bridge.closeAnswers).toHaveLength(3));
    expect(bridge.closeAnswers.at(-1)).toBe('close');
  });
});

describe('App — обрыв связи с хостом (раунд lane-r3, п. 2)', () => {
  beforeEach(() => {
    useHostStore.setState({ status: { state: 'connecting' }, everConnected: false });
  });
  afterEach(() => {
    useHostStore.setState({ status: { state: 'connecting' }, everConnected: false });
  });

  it('связь была и оборвалась — окно остаётся на месте (терминалы говорят «Disconnected — reconnecting…»)', () => {
    render(<App />);
    expect(screen.getByTestId('titlebar')).toBeTruthy();

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    expect(screen.getByTestId('titlebar')).toBeTruthy();
    expect(screen.queryByText('No connection to host: Connection to host closed')).toBeNull();
  });

  it('связи ещё не было — экран «No connection to host», как прежде', () => {
    bridge.emitStatus({ state: 'disconnected', reason: 'node not found in login-shell PATH' });
    render(<App />);
    expect(screen.getByText('No connection to host: node not found in login-shell PATH')).toBeTruthy();
    expect(screen.queryByTestId('titlebar')).toBeNull();
  });

  it('экран «No connection to host» — Retry зовёт app.reconnect, Restart host — app.restartHost (fix-final-b, M4)', async () => {
    bridge.emitStatus({ state: 'disconnected', reason: 'Host is not answering' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(bridge.hostActions).toEqual(['reconnect']));
    fireEvent.click(screen.getByRole('button', { name: 'Restart host' }));
    await vi.waitFor(() => expect(bridge.hostActions).toEqual(['reconnect', 'restartHost']));
  });
});

// Слияние lane-r3 и main-r2: «Restart host» и падение хоста — обрыв связи после неё. Оболочка
// остаётся той же (не перемонтируется), а баннер прерванных сессий спрашивает уже новый хост.
describe('App — связь вернулась (слияние lane-r3 и main-r2)', () => {
  it('обрыв и возврат связи: заголовок — тот же узел, sessions.interrupted перезапрошен — баннер Interrupted', async () => {
    let refs: SessionRef[] = [];
    bridge.setHandler('sessions.interrupted', () => ({ refs }));
    render(<App />);
    const titlebar = screen.getByTestId('titlebar');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Interrupted mid-turn/)).toBeNull();

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    refs = [{ projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' }];
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));

    expect(await screen.findByText('Interrupted mid-turn: S03')).toBeTruthy();
    expect(screen.getByTestId('titlebar')).toBe(titlebar);
  });
});

// Раунд lane-r5, п. 1: хост не прочитал работы на старте (битый works-index.json) — works.list
// отвечает internal с причиной works-unreadable. Пустой список не должен сойти за ответ хоста:
// сохранённые вкладки не стираются, человек видит сбой, а не Landing.
describe('App — works.list отказал на старте хоста (lane-r5)', () => {
  // Причина — в `data.reason`, как у ошибок git 8.2a (одна форма ветки после слияния).
  const unreadable = { code: 'internal', message: 'работы не прочитаны на старте хоста', data: { reason: 'works-unreadable' } };

  it('первое подключение: раскладки не отсеиваются, Landing нет, видна причина по-английски', async () => {
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    bridge.setHandler('works.list', () => {
      throw unreadable;
    });
    render(<App />);
    expect(await screen.findByText(S.works.unreadable)).toBeTruthy();
    expect(screen.queryByTestId('landing')).toBeNull();
    expect(bridge.layoutRetains).toEqual([]);
    expect(screen.queryByText(/работы не прочитаны/)).toBeNull();
  });

  it('переподключение к хосту с отказом: работы и вкладки остаются, видна причина', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    bridge.setHandler('works.list', () => ({ entries: [w1], branches: {} }));
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    render(<App />);
    await screen.findAllByText('w-01');

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    bridge.setHandler('works.list', () => {
      throw unreadable;
    });
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));

    expect(await screen.findByText(S.works.unreadable)).toBeTruthy();
    expect(useWorksStore.getState().entries).toEqual([w1]);
    expect(bridge.layoutRemovals).toEqual([]);
    expect(screen.getAllByText('w-01').length).toBeGreaterThan(0);
  });

  // Слияние с fix-7.3 (`settleVanishedWork`): работа, пропавшая из снимка, спрашивает Save/Discard о
  // грязных буферах своих вкладок. Отказ works.list — не пропажа: вопроса нет, вкладки, буфер и
  // раскладка на месте, записей нет.
  it('переподключение с отказом при несохранённой правке файла работы: вопроса нет, вкладки и буфер целы (слияние с fix-7.3)', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    const W = workKey(w1.projectPath, 'w-01');
    const fileTab: TabSpec = { kind: 'file', id: tabId.file({ kind: 'project' }, 'src/a.ts'), root: { kind: 'project' }, path: 'src/a.ts' };
    const termTab: TabSpec = { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' };
    const dirtyKey = bufferKey(W, fileTab.id);
    const tabIds = (): string[] => {
      const layout = useLayoutStore.getState().layouts[W];
      return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
    };
    bridge.setHandler('works.list', () => ({ entries: [w1], branches: {} }));
    useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
    render(<App />);
    await screen.findAllByText('w-01');
    await vi.waitFor(() => expect(useLayoutStore.getState().hydrated[W]).toBe(true));
    // Вкладка файла — неактивная (активна терминальная): тело файла с Monaco тут не нужно, буферу
    // хватает вкладки в раскладке — без неё `bindBuffersToLayouts` отпустил бы буфер сам.
    act(() => {
      useLayoutStore.getState().apply(W, (layout) => openTab(openTab(layout, fileTab), termTab));
    });
    act(() => {
      useFilesStore.setState({
        buffers: {
          [dirtyKey]: {
            root: { workKey: W, spec: { kind: 'project' } },
            path: 'src/a.ts',
            watchId: null,
            model: { ...initialBuffer(), status: 'dirty', text: 'mine', savedText: 'disk', mtimeMs: 1, diskMtimeMs: 1 },
          },
        },
      });
    });
    const tabsBefore = tabIds();
    expect(tabsBefore).toEqual(expect.arrayContaining([fileTab.id, termTab.id]));

    act(() => bridge.emitStatus({ state: 'disconnected', reason: 'Connection to host closed' }));
    bridge.setHandler('works.list', () => {
      throw unreadable;
    });
    act(() => bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [...REQUIRED_METHODS] }));

    expect(await screen.findByText(S.works.unreadable)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('save-changes-dialog')).toBeNull();
    expect(screen.queryByText(/was deleted/)).toBeNull();
    expect(tabIds()).toEqual(tabsBefore);
    expect(useFilesStore.getState().buffers[dirtyKey]?.model.status).toBe('dirty');
    expect(bridge.layoutRemovals).toEqual([]);
    expect(bridge.writes).toEqual([]);
    useFilesStore.setState({ buffers: {}, reveals: {} });
  });
});
