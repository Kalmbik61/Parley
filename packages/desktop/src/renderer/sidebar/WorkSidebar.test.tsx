/** Тесты 5, 6, 8, 15, 16 куска 3.3: сайдбар карточек (спека 6.1, 6.2). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { workKey } from '../lib/tree-order.js';
import { useActivityStore } from '../store/activity.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useSidebarSectionsStore, useSidebarSectionsSync } from './use-sidebar-sections.js';
import { Palette } from '../palette/Palette.js';
import { usePaletteStore } from '../palette/store.js';
import { WorkSidebar, type WorkSidebarProps } from './WorkSidebar.js';

/**
 * Отрисовки карточек (раунд исправлений 1 куска 3.3): Profiler ставится ВНУТРИ `memo`
 * настоящей карточки — подменяется только её внутренняя функция, сравнение пропсов
 * остаётся настоящим. Не `memo` — `type` нет, подсчёт пуст, и тест ниже падает.
 */
const cardRenders = vi.hoisted(() => ({ ids: [] as string[], props: [] as Array<import('./WorkCard.js').WorkCardProps> }));
vi.mock('./WorkCard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorkCard.js')>();
  const { Profiler, createElement } = await import('react');
  const real = actual.WorkCard as unknown as { type?: (props: import('./WorkCard.js').WorkCardProps) => JSX.Element };
  const inner = real.type;
  if (typeof inner !== 'function') return actual;
  return {
    ...actual,
    WorkCard: {
      ...actual.WorkCard,
      type: (props: import('./WorkCard.js').WorkCardProps) => {
        cardRenders.props.push(props);
        return createElement(
          Profiler,
          { id: props.entry.map.work.id, onRender: (id: string) => cardRenders.ids.push(id) },
          inner(props),
        );
      },
    },
  };
});

const keyOf = (entry: WorkEntry): string => workKey(entry.projectPath, entry.map.work.id);

let setShown: (shown: boolean) => void = () => {};
let bridge: FakeBridge;
let disposeHost: () => void = () => {};

/** Как в окне: писатель секций — снаружи сайдбара (в `AppShell`), сайдбар можно спрятать (⌘B). */
function Harness(props: Partial<WorkSidebarProps>): JSX.Element {
  useSidebarSectionsSync();
  const [shown, set] = useState(true);
  setShown = set;
  return shown ? (
    <WorkSidebar
      bridge={bridge}
      onActivateWork={props.onActivateWork ?? (() => {})}
      onOpenSession={props.onOpenSession ?? (() => {})}
      onOpenMail={props.onOpenMail ?? (() => {})}
      onOpenRoom={props.onOpenRoom ?? (() => {})}
    />
  ) : (
    <></>
  );
}

function setWorks(entries: WorkEntry[]): void {
  useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
}

const cardKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-work-key]')].map((element) => element.getAttribute('data-work-key') ?? '');

const list = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[data-sidebar-list]');
  if (element === null) throw new Error('списка нет');
  return element;
};

beforeEach(() => {
  bridge = createFakeBridge();
  disposeHost = useHostStore.getState().init(bridge);
  setWorks([]);
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    ui: DEFAULT_UI,
    sidebarHovering: false,
    sidebarHolds: {},
    dialogs: { newWork: { open: false, projectPath: null, title: '' }, newSession: { open: false, parentSessionId: null, work: null }, settings: false, createRoom: null },
  });
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  useSidebarSectionsStore.setState({ sections: [], attention: {} });
});

afterEach(() => {
  cleanup();
  disposeHost();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WorkSidebar — состав (тест 5)', () => {
  it('Pinned наверху, свёрнутый проект без карточек, архивных нет', () => {
    const pinned = makeWork('w-pin', { projectPath: '/p/zeta', title: 'Закреплённая' });
    const open = makeWork('w-open', { projectPath: '/p/alpha', title: 'Открытая' });
    const hidden = makeWork('w-hidden', { projectPath: '/p/beta', title: 'В свёрнутом' });
    const archived = makeWork('w-arch', { projectPath: '/p/alpha', title: 'Архивная', status: 'archived' });
    setWorks([pinned, open, hidden, archived]);
    useUiStore.setState({ ui: { ...DEFAULT_UI, pinnedWorks: [keyOf(pinned)], collapsedProjects: ['/p/beta'] } });

    render(<Harness />);

    const headers = [...document.querySelectorAll<HTMLElement>('[data-section-key]')].map((element) => element.getAttribute('data-section-key'));
    expect(headers[0]).toBe('pinned');
    expect(screen.getByText(S.sidebar.pinned)).toBeTruthy();
    expect(cardKeys()).toEqual([keyOf(pinned), keyOf(open)]);
    // Свёрнутый проект — только заголовок.
    expect(headers).toContain('/p/beta');
    expect(screen.queryByText('В свёрнутом')).toBeNull();
    expect(screen.queryByText('Архивная')).toBeNull();
  });

  it('заголовок проекта: имя папки, число работ, полный путь в тултипе; клик сворачивает и разворачивает', () => {
    setWorks([makeWork('w-1', { projectPath: '/Users/me/VoiceStudio' }), makeWork('w-2', { projectPath: '/Users/me/VoiceStudio' })]);
    render(<Harness />);
    const header = document.querySelector<HTMLElement>('[data-section-key="/Users/me/VoiceStudio"]');
    if (header === null) throw new Error('заголовка нет');
    expect(header.textContent).toContain('VoiceStudio');
    expect(header.textContent).toContain('2');
    expect(header.getAttribute('title')).toBe('/Users/me/VoiceStudio');

    fireEvent.click(header);
    expect(useUiStore.getState().ui.collapsedProjects).toEqual(['/Users/me/VoiceStudio']);
    expect(cardKeys()).toEqual([]);
    fireEvent.click(header);
    expect(useUiStore.getState().ui.collapsedProjects).toEqual([]);
    expect(cardKeys()).toHaveLength(2);
  });

  it('при 60 работах в DOM больше нуля и меньше 60 карточек (виртуализация)', () => {
    const works = Array.from({ length: 60 }, (_, index) =>
      makeWork(`w-${String(index).padStart(2, '0')}`, { projectPath: '/p/many', sessions: [makeSession('s-01', 'a')] }),
    );
    setWorks(works);
    // У jsdom раскладки нет: первый рендер берёт высоту из `initialRect`, но сразу после
    // монтирования virtual-core замеряет `offsetHeight` списка (в jsdom — 0) и оставил бы
    // ноль карточек. Списку даём высоту окна — иначе тест ничего не доказывает.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-sidebar-list') ? 800 : 0;
      },
    });
    try {
      render(<Harness />);
      const count = cardKeys().length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(60);
    } finally {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
    }
  });

  it('при 50 работах виртуализации нет — все карточки в DOM', () => {
    setWorks(Array.from({ length: 50 }, (_, index) => makeWork(`w-${String(index).padStart(2, '0')}`, { projectPath: '/p/many' })));
    render(<Harness />);
    expect(cardKeys()).toHaveLength(50);
  });

  // Раунд исправлений 1 куска 3.3: переход через порог 50 под указателем не меняет узел
  // списка — `pointerleave` приходит на тот же узел, флаг не залипает.
  it('переход через 50 карточек под указателем: узел списка тот же, уход указателя снимает флаг', () => {
    const many = (n: number): WorkEntry[] =>
      Array.from({ length: n }, (_, index) => makeWork(`w-${String(index).padStart(2, '0')}`, { projectPath: '/p/many' }));
    setWorks(many(50));
    render(<Harness />);
    const before = list();
    fireEvent.pointerEnter(before);
    expect(useUiStore.getState().sidebarHovering).toBe(true);

    act(() => setWorks(many(51)));
    expect(list()).toBe(before);
    fireEvent.pointerLeave(list());
    expect(useUiStore.getState().sidebarHovering).toBe(false);

    fireEvent.pointerEnter(list());
    act(() => setWorks(many(50)));
    expect(list()).toBe(before);
    expect(cardKeys()).toHaveLength(50);
  });

  it('клики: карточка — onActivateWork, строка сессии — onOpenSession, ✉N — onOpenMail', () => {
    const onActivateWork = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenMail = vi.fn();
    const entry = makeWork('w-1', {
      sessions: [makeSession('s-01', 'a')],
      messages: [{ id: 'm-1', roomId: null, from: 's-01', to: ['human'], at: '2026-09-27T09:00:00.000Z', text: 't', kind: 'note', readBy: {} }],
    });
    setWorks([entry]);
    render(<Harness onActivateWork={onActivateWork} onOpenSession={onOpenSession} onOpenMail={onOpenMail} />);

    fireEvent.click(document.querySelector('[data-work-key]') as HTMLElement);
    expect(onActivateWork).toHaveBeenCalledWith(keyOf(entry));
    fireEvent.click(document.querySelector('[data-session-id="s-01"]') as HTMLElement);
    expect(onOpenSession).toHaveBeenCalledWith(keyOf(entry), 's-01');
    fireEvent.click(screen.getByRole('button', { name: '1 unread message to you' }));
    expect(onOpenMail).toHaveBeenCalledWith(keyOf(entry));
  });
});

describe('WorkSidebar — пересортировка под указателем (тест 6)', () => {
  it('pointerenter, событие blocked — порядок прежний; pointerleave — работа первая', () => {
    const older = makeWork('w-old', { createdAt: '2026-09-27T07:00:00.000Z', sessions: [makeSession('s-01', 'a')] });
    const newer = makeWork('w-new', { createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'b')] });
    setWorks([older, newer]);
    render(<Harness />);
    expect(cardKeys()).toEqual([keyOf(newer), keyOf(older)]);

    fireEvent.pointerEnter(list());
    expect(useUiStore.getState().sidebarHovering).toBe(true);
    act(() =>
      useActivityStore.setState({
        byRef: activityMap([makeActivity({ projectPath: older.projectPath, workId: 'w-old', sessionId: 's-01' }, 'blocked')]),
      }),
    );
    expect(cardKeys()).toEqual([keyOf(newer), keyOf(older)]);

    fireEvent.pointerLeave(list());
    expect(useUiStore.getState().sidebarHovering).toBe(false);
    expect(cardKeys()).toEqual([keyOf(older), keyOf(newer)]);
  });
});

describe('WorkSidebar — размонтирование под указателем (тест 15)', () => {
  it('сайдбар закрыт (⌘B) под указателем — sidebarHovering ложно, пересортировка не ждёт 3 с', () => {
    const older = makeWork('w-old', { createdAt: '2026-09-27T07:00:00.000Z', sessions: [makeSession('s-01', 'a')] });
    const newer = makeWork('w-new', { createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'b')] });
    setWorks([older, newer]);
    render(<Harness />);
    fireEvent.pointerEnter(list());
    expect(useUiStore.getState().sidebarHovering).toBe(true);

    act(() => setShown(false));
    expect(useUiStore.getState().sidebarHovering).toBe(false);

    act(() =>
      useActivityStore.setState({
        byRef: activityMap([makeActivity({ projectPath: older.projectPath, workId: 'w-old', sessionId: 's-01' }, 'blocked')]),
      }),
    );
    // Без таймеров: новый порядок в сторе сразу.
    const order = useSidebarSectionsStore.getState().sections.flatMap((section) => section.works.map(keyOf));
    expect(order).toEqual([keyOf(older), keyOf(newer)]);
  });
});

describe('WorkSidebar — верх (тесты 8, 16)', () => {
  it('Search с подписью ⌘J открывает палитру; ⌘K нет (кусок 6.1b)', () => {
    setWorks([makeWork('w-1')]);
    render(<Harness />);
    const search = screen.getByRole('button', { name: /Search/ });
    expect(within(search).getByText('⌘J')).toBeTruthy();
    expect(screen.queryByText('⌘K')).toBeNull();
    fireEvent.click(search);
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'default' });
  });

  it('«New workspace» и «+» заголовка проекта открывают форму новой работы (openNewWorkDialog), без сворачивания группы', () => {
    setWorks([makeWork('w-1', { projectPath: '/p/one' })]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^New workspace\s*⌘N$/ }));
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null, title: '' });

    act(() => useUiStore.getState().closeNewWorkDialog());
    fireEvent.click(screen.getByRole('button', { name: S.sidebar.newWorkspaceInProject('one') }));
    // Кусок 3.5 (тест 7): «+» заголовка — с проектом этой группы.
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: '/p/one', title: '' });
    expect(useUiStore.getState().ui.collapsedProjects).toEqual([]);
  });

  it('навигация: строки Search и New workspace — пилюли 32px, значок 14, сочетание — пилюля 10px на neutral-200', () => {
    setWorks([makeWork('w-1')]);
    render(<Harness />);
    for (const name of [/Search/, /^New workspace\s*⌘N$/]) {
      const row = screen.getByRole('button', { name });
      expect(row.className).toMatch(/\bh-8\b/);
      expect(row.className).toMatch(/\brounded-full\b/);
      expect(row.className).toMatch(/\bgap-2\.5\b/);
      expect(row.className).toMatch(/\bpl-3\b/);
      expect(row.className).toMatch(/\bpr-2\b/);
      expect(row.className).toContain('text-[13px]');
      expect(row.className).toContain('hover:bg-foreground/7');
      expect(row.querySelector('svg')?.classList.contains('size-3.5')).toBe(true);
      const kbd = row.querySelector('kbd');
      expect(kbd?.className).toContain('rounded-full');
      expect(kbd?.className).toContain('bg-neutral-200');
      expect(kbd?.className).toContain('text-neutral-800');
      expect(kbd?.className).toContain('text-[10px]');
    }
  });

  it('список: отступ 0 10 14 10, между проектами 16, между карточками 6', () => {
    setWorks([makeWork('w-1', { projectPath: '/p/one' }), makeWork('w-2', { projectPath: '/p/two' })]);
    render(<Harness />);
    const listEl = list();
    expect(listEl.className).toMatch(/\bpx-2\.5\b/);
    expect(listEl.className).toMatch(/\bpb-3\.5\b/);
    expect(listEl.querySelector('[data-projects]')?.className).toMatch(/\bgap-4\b/);
    const nav = document.querySelector('[data-sidebar-nav]');
    expect(nav?.className).toMatch(/\bgap-0\.5\b/);
    expect(nav?.className).toMatch(/\bpx-2\.5\b/);
    expect(nav?.className).toMatch(/\bpt-1\b/);
    expect(nav?.className).toMatch(/\bpb-2\.5\b/);
  });

  it('у корня сайдбара нет своей правой границы — шов рисует Resizer', () => {
    render(<Harness />);
    const root = document.querySelector<HTMLElement>('[data-work-sidebar]');
    expect(root?.className).not.toMatch(/\bborder-r\b/);
  });
});

describe('перерисовки карточек (раунд исправлений 1 куска 3.3, ревью A)', () => {
  it('activity.changed сессии работы A перерисовывает карточку A и не трогает карточку B', () => {
    const a = makeWork('w-a', { projectPath: '/p/one', sessions: [makeSession('s-01', 'a')] });
    const b = makeWork('w-b', { projectPath: '/p/one', sessions: [makeSession('s-01', 'b')] });
    setWorks([a, b]);
    render(<Harness />);
    const refA = { projectPath: a.projectPath, workId: a.map.work.id, sessionId: 's-01' };

    cardRenders.ids = [];
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(refA, 'working')]) }));
    expect(cardRenders.ids).toContain('w-a');
    expect(cardRenders.ids).not.toContain('w-b');

    // Только метрики: порядок тот же, внимание то же — карточку B не трогает тоже.
    cardRenders.ids = [];
    act(() =>
      useActivityStore.setState({
        byRef: activityMap([
          makeActivity(refA, 'working', {
            metrics: { model: 'opus', contextTokens: 10, contextWindow: 100, costUsd: null, updatedAt: '2026-09-27T09:00:01.000Z' } as never,
          }),
        ]),
      }),
    );
    expect(cardRenders.ids).toContain('w-a');
    expect(cardRenders.ids).not.toContain('w-b');
  });
});

// ---------------------------------------------------------------------------
// Кусок 3.4: меню, переименование и кеши сайдбара.
// ---------------------------------------------------------------------------

describe('WorkSidebar — SectionMenu (тест 8)', () => {
  it('«⋯» заголовка секции: Show done зовёт patchUi({ showDoneWorks: false }), работы done пропадают', () => {
    const open = makeWork('w-open', { projectPath: '/p/alpha', title: 'Open one' });
    const done = makeWork('w-done', { projectPath: '/p/alpha', title: 'Done one', status: 'done' });
    setWorks([open, done]);
    useUiStore.getState().init(bridge);
    // patchUi уходит в app.saveUi сырым патчем — по нему и видно, что позвали.
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    render(<Harness />);
    expect(cardKeys()).toEqual([keyOf(open), keyOf(done)]);

    const header = document.querySelector<HTMLElement>('[data-section-key="/p/alpha"]');
    if (header === null) throw new Error('заголовка нет');
    fireEvent.keyDown(within(header).getByRole('button', { name: S.sidebar.sectionMenu }), { key: 'Enter' });
    const item = screen.getByRole('menuitemcheckbox', { name: 'Show done' });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);

    expect(saveUi).toHaveBeenCalledWith({ showDoneWorks: false });
    expect(useUiStore.getState().ui.showDoneWorks).toBe(false);
    expect(cardKeys()).toEqual([keyOf(open)]);
    // Меню не сворачивало группу.
    expect(useUiStore.getState().ui.collapsedProjects).toEqual([]);
  });
});

describe('WorkSidebar — меню и переименование держат порядок (тест 18)', () => {
  const older = makeWork('w-old', { createdAt: '2026-09-27T07:00:00.000Z', title: 'Older', sessions: [makeSession('s-01', 'a')] });
  const newer = makeWork('w-new', { createdAt: '2026-09-27T08:00:00.000Z', title: 'Newer', sessions: [makeSession('s-01', 'b')] });
  const blockOlder = (): void =>
    act(() =>
      useActivityStore.setState({
        byRef: activityMap([makeActivity({ projectPath: older.projectPath, workId: 'w-old', sessionId: 's-01' }, 'blocked')]),
      }),
    );

  it('меню карточки открыто, указатель ушёл со списка — blocked порядок не меняет; меню закрыто — новый порядок', () => {
    setWorks([older, newer]);
    render(<Harness />);
    expect(cardKeys()).toEqual([keyOf(newer), keyOf(older)]);

    fireEvent.pointerEnter(list());
    fireEvent.contextMenu(document.querySelector(`[data-work-key="${keyOf(newer)}"]`) as HTMLElement);
    fireEvent.pointerLeave(list());
    expect(useUiStore.getState().sidebarHovering).toBe(true);
    blockOlder();
    expect(cardKeys()).toEqual([keyOf(newer), keyOf(older)]);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(useUiStore.getState().sidebarHovering).toBe(false);
    expect(cardKeys()).toEqual([keyOf(older), keyOf(newer)]);
  });

  it('во время InlineRename — так же', () => {
    setWorks([older, newer]);
    render(<Harness />);
    fireEvent.pointerEnter(list());
    fireEvent.doubleClick(screen.getByText('Newer'));
    const input = screen.getByRole('textbox');
    fireEvent.pointerLeave(list());
    blockOlder();
    expect(cardKeys()).toEqual([keyOf(newer), keyOf(older)]);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cardKeys()).toEqual([keyOf(older), keyOf(newer)]);
  });
});

describe('WorkSidebar — кеши колбэков и срезов (решение контролёра 3)', () => {
  it('работа удалена из снимка — её записей в кешах нет: вернувшаяся получает новые колбэки и срез', () => {
    const a = makeWork('w-a', { sessions: [makeSession('s-01', 'a')] });
    const b = makeWork('w-b', { sessions: [makeSession('s-01', 'b')] });
    useActivityStore.setState({
      byRef: activityMap([makeActivity({ projectPath: a.projectPath, workId: 'w-a', sessionId: 's-01' }, 'working')]),
    });
    setWorks([a, b]);
    cardRenders.props = [];
    render(<Harness />);
    const lastProps = (id: string): import('./WorkCard.js').WorkCardProps | undefined =>
      cardRenders.props.filter((props) => props.entry.map.work.id === id).at(-1);
    const before = lastProps('w-a');

    act(() => setWorks([b]));
    act(() => setWorks([a, b]));
    const after = lastProps('w-a');

    expect(after?.onActivate).not.toBe(before?.onActivate);
    expect(after?.onOpenRoom).not.toBe(before?.onOpenRoom);
    expect(after?.activity).not.toBe(before?.activity);
    expect(after?.activity).toEqual(before?.activity);
    // Колбэки уцелевшей работы — прежние.
    const bProps = cardRenders.props.filter((props) => props.entry.map.work.id === 'w-b');
    expect(bProps.at(-1)?.onActivate).toBe(bProps[0]?.onActivate);
  });
});

describe('WorkSidebar — клавиатура (спека 6.5, кусок 3.4)', () => {
  it('фокус в список — курсор на активной карточке; ↑↓ по карточкам и строкам; Enter открывает', () => {
    const onActivateWork = vi.fn();
    const onOpenSession = vi.fn();
    const a = makeWork('w-a', { createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'a')] });
    const b = makeWork('w-b', { createdAt: '2026-09-27T07:00:00.000Z', sessions: [makeSession('s-01', 'b')] });
    setWorks([a, b]);
    useLayoutStore.setState({ activeWorkKey: keyOf(b) });
    render(<Harness onActivateWork={onActivateWork} onOpenSession={onOpenSession} />);
    expect(cardKeys()).toEqual([keyOf(a), keyOf(b)]);

    // Tab из «New workspace» попадает в первый доступный элемент списка — курсор на активной.
    const firstRow = document.querySelector<HTMLElement>(`[data-work-key="${keyOf(a)}"] [data-session-id="s-01"]`);
    act(() => screen.getByText(S.sidebar.addWorkspace).closest('button')?.focus());
    act(() => firstRow?.focus());
    const cardB = document.querySelector<HTMLElement>(`[data-work-key="${keyOf(b)}"]`);
    expect(document.activeElement).toBe(cardB);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(firstRow);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-work-key')).toBe(keyOf(a));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onActivateWork).toHaveBeenCalledWith(keyOf(a));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onOpenSession).toHaveBeenCalledWith(keyOf(a), 's-01');
  });

  it('→ разворачивает закрытые сессии карточки, ← сворачивает; Shift+F10 — меню под курсором', () => {
    const entry = makeWork('w-k', { sessions: [makeSession('s-01', 'open'), makeSession('s-02', 'old', { lifecycle: 'closed' })] });
    setWorks([entry]);
    useLayoutStore.setState({ activeWorkKey: keyOf(entry) });
    render(<Harness />);
    const card = document.querySelector<HTMLElement>(`[data-work-key="${keyOf(entry)}"]`) as HTMLElement;
    act(() => card.focus());
    expect(card.querySelector('[data-session-id="s-02"]')).toBeNull();

    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(card.querySelector('[data-session-id="s-02"]')).not.toBeNull();
    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    expect(card.querySelector('[data-session-id="s-02"]')).toBeNull();

    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('Pin')).toBeTruthy();
  });
});

/** Следующий по порядку Tab элемент документа после `from` (tabIndex ≥ 0, как считает браузер). */
function nextTabbable(from: HTMLElement): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]')].filter(
    (element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled,
  );
  return all.find((element) => (from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !from.contains(element)) ?? null;
}

describe('WorkSidebar — клавиатура, раунд исправлений 1 (находки 2–5)', () => {
  const a = makeWork('w-a', { createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'a1'), makeSession('s-02', 'a2')] });
  const b = makeWork('w-b', { createdAt: '2026-09-27T07:00:00.000Z', sessions: [makeSession('s-01', 'b1')] });
  const cardOf = (entry: WorkEntry): HTMLElement => document.querySelector<HTMLElement>(`[data-work-key="${keyOf(entry)}"]`) as HTMLElement;
  const rowOf = (entry: WorkEntry, id: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-work-key="${keyOf(entry)}"] [data-session-id="${id}"]`) as HTMLElement;
  const stops = (): HTMLElement[] =>
    [...list().querySelectorAll<HTMLElement>('[data-work-key], [data-session-id]')].filter((element) => element.tabIndex === 0);

  function setup(): void {
    setWorks([a, b]);
    useLayoutStore.setState({ activeWorkKey: keyOf(b) });
    render(<Harness />);
  }

  it('находка 3: клик по пустому месту списка, когда фокус уже на строке в списке, — курсор на активной карточке', () => {
    setup();
    const row = rowOf(a, 's-02');
    fireEvent.pointerDown(row);
    act(() => row.focus());
    fireEvent.pointerUp(row);
    expect(document.activeElement).toBe(row);

    fireEvent.pointerDown(list());
    act(() => list().focus());
    fireEvent.pointerUp(list());
    expect(document.activeElement).toBe(cardOf(b));
  });

  it('находка 5: одна точка входа — tabIndex 0 только у элемента под курсором, роли дерева и aria-selected', () => {
    setup();
    expect(list().getAttribute('role')).toBe('tree');
    expect(cardOf(a).getAttribute('role')).toBe('treeitem');
    expect(rowOf(a, 's-01').getAttribute('role')).toBe('treeitem');
    // До курсора точка входа — активная карточка.
    expect(stops()).toEqual([cardOf(b)]);

    act(() => screen.getByText(S.sidebar.addWorkspace).closest('button')?.focus());
    act(() => rowOf(a, 's-01').focus());
    expect(document.activeElement).toBe(cardOf(b));
    expect(cardOf(b).getAttribute('aria-selected')).toBe('true');
    // Tab с курсора уходит из сайдбара одним нажатием: строк сессий в порядке Tab нет.
    const next = nextTabbable(cardOf(b));
    expect(next === null || !list().contains(next)).toBe(true);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowOf(b, 's-01'));
    expect(stops()).toEqual([rowOf(b, 's-01')]);
    expect(rowOf(b, 's-01').getAttribute('aria-selected')).toBe('true');
    expect(cardOf(b).getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(stops()).toEqual([rowOf(a, 's-02')]);
  });

  it('находка 4: →/← на карточке, затем Shift+F10 → Esc — фокус на той же карточке; у строки — на строке', async () => {
    const closed = makeWork('w-c', { sessions: [makeSession('s-01', 'open'), makeSession('s-02', 'old', { lifecycle: 'closed' })] });
    setWorks([closed, b]);
    useLayoutStore.setState({ activeWorkKey: keyOf(b) });
    render(<Harness />);
    const card = cardOf(closed);
    act(() => card.focus());
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    // Radix возвращает фокус таймером после размонтирования меню.
    await waitFor(() => expect(document.activeElement).toBe(cardOf(closed)));

    fireEvent.keyDown(cardOf(closed), { key: 'ArrowDown' });
    const row = rowOf(closed, 's-01');
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(rowOf(closed, 's-01')));
  });

  it('находка 2: меню и подтверждение открываются и закрываются — стек не переполняется, фокус не скачет', async () => {
    setup();
    const errors = vi.spyOn(console, 'error');
    act(() => rowOf(a, 's-01').focus());
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(rowOf(a, 's-01'), { key: 'F10', shiftKey: true });
      const item = screen.getByText('Stop');
      act(() => item.focus());
      fireEvent.click(item);
      fireEvent.click(screen.getByText('Cancel'));
      fireEvent.keyDown(cardOf(a), { key: 'F10', shiftKey: true });
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await waitFor(() => expect(document.activeElement).toBe(cardOf(a)));
    }
    const overflow = errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes('Maximum call stack')));
    errors.mockRestore();
    expect(overflow).toEqual([]);
  });
});

describe('WorkSidebar — возврат фокуса после подтверждений и палитры (кусок 3.4, раунд 2)', () => {
  const a = makeWork('w-a', { createdAt: '2026-09-27T08:00:00.000Z', sessions: [makeSession('s-01', 'a1')] });
  const b = makeWork('w-b', { createdAt: '2026-09-27T07:00:00.000Z', sessions: [makeSession('s-01', 'b1')] });
  const cardOf = (entry: WorkEntry): HTMLElement => document.querySelector<HTMLElement>(`[data-work-key="${keyOf(entry)}"]`) as HTMLElement;
  const rowOf = (entry: WorkEntry, id: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-work-key="${keyOf(entry)}"] [data-session-id="${id}"]`) as HTMLElement;

  /** Как мышью: правая кнопка фокусирует карточку и открывает её меню. */
  function rightClick(element: HTMLElement): void {
    fireEvent.pointerDown(element, { button: 2 });
    act(() => element.focus());
    fireEvent.pointerUp(element, { button: 2 });
    fireEvent.contextMenu(element);
  }

  function setup(): void {
    setWorks([a, b]);
    useLayoutStore.setState({ activeWorkKey: keyOf(b) });
    bridge.setHandler('works.setStatus', () => ({ ok: true as const }));
    render(<Harness />);
  }

  it('Archive подтверждён — фокус в списке, не на body; карточка ушла из снимка — фокус на активной карточке', async () => {
    setup();
    rightClick(cardOf(a));
    fireEvent.click(screen.getByText(S.cardMenu.archive));
    fireEvent.click(screen.getByRole('button', { name: S.cardMenu.archive }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(list().contains(document.activeElement)).toBe(true);

    // Хост архивировал работу — карточка с фокусом пропала из DOM.
    act(() => setWorks([b]));
    await waitFor(() => expect(document.activeElement).toBe(cardOf(b)));
  });

  it('Cancel — фокус на карточке, откуда открыли меню; у строки сессии — на строке', async () => {
    setup();
    rightClick(cardOf(a));
    fireEvent.click(screen.getByText(S.cardMenu.archive));
    fireEvent.click(screen.getByText(S.common.cancel));
    await waitFor(() => expect(document.activeElement).toBe(cardOf(a)));

    rightClick(rowOf(a, 's-01'));
    fireEvent.click(screen.getByText(S.sidebar.sessionMenu.stop));
    fireEvent.click(screen.getByText(S.common.cancel));
    await waitFor(() => expect(document.activeElement).toBe(rowOf(a, 's-01')));
  });

  it('палитра, открытая кнопкой Search, закрыта Esc — фокус на кнопке Search', async () => {
    function WithPalette(): JSX.Element {
      return (
        <>
          <Harness />
          <Palette bridge={bridge} run={() => {}} />
        </>
      );
    }
    usePaletteStore.setState({ open: false, mode: 'default', query: '' });
    // cmdk палитры меряет список и прокручивает выделенную строку — в jsdom этого нет.
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    setWorks([a]);
    render(<WithPalette />);
    const search = screen.getByRole('button', { name: /Search/ });
    act(() => search.focus());
    fireEvent.click(search);
    const input = await screen.findByPlaceholderText(S.palette.placeholder);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});
