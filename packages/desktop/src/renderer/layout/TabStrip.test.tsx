/**
 * Тест 1 куска 2.4 (часть про саму строку): при `portal` строка вкладок рисуется
 * порталом в `#titlebar-tabs`, а не на своём обычном месте в дереве; без
 * `portal` — на своём месте.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@parley/core';
import type { GroupNode } from '../../shared/layout-types.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { activityMap as keyed, makeActivity } from '../test-utils/work-fixtures.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { keepActiveOnResize, revealScrollLeft, TabStrip } from './TabStrip.js';

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

function entry(sessions: WorkSession[], rooms: Room[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms,
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

const WORK_KEY = '/tmp/p w';

afterEach(() => {
  cleanup();
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
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

describe('TabStrip — тест 1', () => {
  it('portal: рисуется в #titlebar-tabs, не на своём обычном месте', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }], activeTabId: 'terminal:s-02' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([session('s-02', 'исполнитель')]);

    const host = document.createElement('div');
    host.id = 'titlebar-tabs';
    document.body.appendChild(host);

    const { container } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal active />);

    expect(container.querySelector('[data-tab-id]')).toBeNull();
    expect(host.querySelector('[data-tab-id]')).not.toBeNull();
    expect(screen.getByText('S02 исполнитель')).toBeTruthy();

    host.remove();
  });

  it('без portal: рисуется на своём месте', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'mail', id: 'mail' }], activeTabId: 'mail' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([]);

    const { container } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />);
    expect(container.querySelector('[data-tab-id="mail"]')).not.toBeNull();
  });
});

describe('TabStrip — раунд исправлений 1: доступность (ревью A, Important №2)', () => {
  it('role="tablist" с aria-label; стрелки ←/→ переводят фокус по кругу между вкладками строки', () => {
    const group: GroupNode = {
      type: 'group',
      id: 'g1',
      tabs: [
        { kind: 'terminal', id: 'terminal:a', sessionId: 'a' },
        { kind: 'terminal', id: 'terminal:b', sessionId: 'b' },
        { kind: 'terminal', id: 'terminal:c', sessionId: 'c' },
      ],
      activeTabId: 'terminal:a',
    };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([session('a', ''), session('b', ''), session('c', '')]);

    render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />);

    const tablist = screen.getByRole('tablist');
    expect(tablist.getAttribute('aria-label')).toBe('Tabs');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((el) => el.getAttribute('data-tab-id'))).toEqual(['terminal:a', 'terminal:b', 'terminal:c']);

    tabs[0]?.focus();
    expect(document.activeElement).toBe(tabs[0]);

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[2]);

    // По кругу — с последней вкладки вперёд снова на первую.
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);

    // Назад с первой — сразу на последнюю (тот же круг в обратную сторону).
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('колесо: preventDefault только когда строка реально переполнена (ревью A, Minor №4)', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'terminal', id: 'terminal:a', sessionId: 'a' }], activeTabId: 'terminal:a' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([session('a', '')]);

    render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />);
    const tablist = screen.getByRole('tablist');

    // Ничего не переполнено (вкладки помещаются целиком) — прокрутка не
    // случается, событие уходит дальше как обычно.
    Object.defineProperty(tablist, 'scrollWidth', { value: 100, configurable: true });
    Object.defineProperty(tablist, 'clientWidth', { value: 100, configurable: true });
    const before = tablist.scrollLeft;
    const notCancelledNoOverflow = fireEvent.wheel(tablist, { deltaY: 50 });
    expect(notCancelledNoOverflow).toBe(true);
    expect(tablist.scrollLeft).toBe(before);

    // Переполнение есть — колесо крутит строку и глотает событие.
    Object.defineProperty(tablist, 'scrollWidth', { value: 500, configurable: true });
    const notCancelledOverflow = fireEvent.wheel(tablist, { deltaY: 50 });
    expect(notCancelledOverflow).toBe(false);
    expect(tablist.scrollLeft).toBe(before + 50);
  });
});

// Тест 6 куска 4.2 и решение контролёра 2: отметки вкладки из внимания; метрики без смены
// внимания строку вкладок не перерисовывают.
describe('TabStrip — внимание (кусок 4.2)', () => {
  const ref = { projectPath: '/tmp/p', workId: 'w', sessionId: 's-02' };
  const group: GroupNode = {
    type: 'group',
    id: 'g1',
    tabs: [
      { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' },
      { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' },
    ],
    activeTabId: 'terminal:s-01',
  };

  function mount(e: WorkEntry, onRender?: () => void): void {
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    useWorksStore.setState({ entries: [e], branches: {}, loading: false, error: null });
    render(
      <Profiler id="strip" onRender={() => onRender?.()}>
        <TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />
      </Profiler>,
    );
  }

  const tabEl = (id: string): HTMLElement => document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;

  it('тест 6: сессия в needs-you с result: done — data-unread="true" и значок вопроса', () => {
    const done = { ...session('s-02', 'исполнитель'), result: 'done' as const };
    mount(entry([session('s-01', 'план'), done]));
    act(() => {
      useActivityStore.setState({ byRef: keyed([makeActivity(ref, 'blocked')]) });
    });
    const el = tabEl('terminal:s-02');
    expect(el.getAttribute('data-unread')).toBe('true');
    expect(el.querySelector('[data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('blocked');
    expect(tabEl('terminal:s-01').getAttribute('data-unread')).toBe('false');
  });

  it('решение 2: новые метрики без смены внимания — строка не перерисована; смена внимания — значок вопроса', () => {
    let renders = 0;
    useActivityStore.setState({ byRef: keyed([makeActivity(ref, 'working')]) });
    mount(entry([session('s-01', 'план'), session('s-02', 'исполнитель')]), () => {
      renders += 1;
    });
    const before = renders;

    act(() => {
      useActivityStore.setState({
        byRef: keyed([makeActivity(ref, 'working', { metrics: { tokensIn: 10, tokensOut: 5, durationMs: 1000, unread: 0, subagents: 0, model: 'opus' } })]),
      });
    });
    act(() => {
      useActivityStore.setState({
        byRef: keyed([makeActivity(ref, 'working', { lastEventAt: '2026-09-27T10:00:00.000Z' })]),
      });
    });
    expect(renders).toBe(before);
    expect(tabEl('terminal:s-02').getAttribute('data-unread')).toBe('false');

    act(() => {
      useActivityStore.setState({ byRef: keyed([makeActivity(ref, 'blocked')]) });
    });
    expect(renders).toBeGreaterThan(before);
    expect(tabEl('terminal:s-02').querySelector('[data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('blocked');
  });
});

// Раунд fix-7-accept, п. 3: активная вкладка — в видимую часть строки, к ближайшему краю, с полем
// под затухание краёв строки (24px с раунда fix-live, O1).
describe('revealScrollLeft', () => {
  const view = { scrollLeft: 0, width: 500 };
  it('вкладка уже видна целиком — сдвиг прежний', () => {
    expect(revealScrollLeft(view, { left: 100, width: 200 })).toBe(0);
    expect(revealScrollLeft({ scrollLeft: 50, width: 500 }, { left: 200, width: 200 })).toBe(50);
  });
  it('за правым краем — правый край вкладки у правого края строки', () => {
    expect(revealScrollLeft(view, { left: 430, width: 215 })).toBe(430 + 215 - 500 + 24);
  });
  it('за левым краем — левый край вкладки у левого края строки', () => {
    expect(revealScrollLeft({ scrollLeft: 400, width: 500 }, { left: 215, width: 215 })).toBe(215 - 24);
  });
  it('в зоне затухания края — тоже сдвиг', () => {
    expect(revealScrollLeft(view, { left: 280, width: 215 })).toBe(280 + 215 - 500 + 24);
  });
  it('вкладка шире строки — к её началу; сдвиг не меньше нуля', () => {
    expect(revealScrollLeft({ scrollLeft: 0, width: 100 }, { left: 300, width: 215 })).toBe(300 - 24);
    expect(revealScrollLeft({ scrollLeft: 40, width: 500 }, { left: 0, width: 215 })).toBe(0);
  });
});

describe('TabStrip — активная вкладка в видимой части строки (fix-7-accept п. 3)', () => {
  it('смена активной вкладки сдвигает строку к ней', () => {
    const tabs = ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'terminal' as const, id: `terminal:${id}`, sessionId: id }));
    const group: GroupNode = { type: 'group', id: 'g1', tabs, activeTabId: 'terminal:a' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry(['a', 'b', 'c', 'd'].map((id) => session(id, id)));
    const { rerender } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />);
    const tablist = screen.getByRole('tablist');
    // Раскладка jsdom — вручную: строка 500px с x=100, вкладки по 215px подряд.
    Object.defineProperty(tablist, 'clientWidth', { value: 500, configurable: true });
    tablist.getBoundingClientRect = () => ({ left: 100, width: 500 }) as DOMRect;
    screen.getAllByRole('tab').forEach((tab, index) => {
      tab.getBoundingClientRect = () => ({ left: 100 + index * 215 - tablist.scrollLeft, width: 215 }) as DOMRect;
    });
    rerender(<TabStrip workKey={WORK_KEY} group={{ ...group, activeTabId: 'terminal:d' }} entry={e} portal={false} active />);
    expect(tablist.scrollLeft).toBe(3 * 215 + 215 - 500 + 24);
    rerender(<TabStrip workKey={WORK_KEY} group={{ ...group, activeTabId: 'terminal:a' }} entry={e} portal={false} active />);
    expect(tablist.scrollLeft).toBe(0);
  });
});

describe('keepActiveOnResize (раунд 8, пункт 8)', () => {
  const tab = { left: 3 * 215, width: 215 };
  it('активная была видна — после сужения строки снова видна', () => {
    // 1000px: вкладка [645, 860] видна при сдвиге 0; сузили до 500 — правый край у правого края строки.
    expect(keepActiveOnResize(0, 1000, 500, tab)).toBe(645 + 215 - 500 + 24);
  });
  it('видна и после изменения — сдвиг прежний', () => {
    expect(keepActiveOnResize(0, 1000, 900, tab)).toBe(0);
  });
  it('человек сам увёл активную из вида колесом — изменение ширины её не возвращает', () => {
    expect(keepActiveOnResize(0, 500, 400, tab)).toBe(0);
    expect(keepActiveOnResize(900, 500, 300, { left: 0, width: 215 })).toBe(900);
  });
});

describe('TabStrip — изменение ширины строки (раунд 8, пункт 8)', () => {
  class FakeRO {
    static all: FakeRO[] = [];
    constructor(readonly callback: ResizeObserverCallback) {
      FakeRO.all.push(this);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      FakeRO.all = FakeRO.all.filter((ro) => ro !== this);
    }
  }

  function setup(): { tablist: HTMLElement; resize(width: number): void } {
    FakeRO.all = [];
    vi.stubGlobal('ResizeObserver', FakeRO);
    const tabs = ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'terminal' as const, id: `terminal:${id}`, sessionId: id }));
    const group: GroupNode = { type: 'group', id: 'g1', tabs, activeTabId: 'terminal:d' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry(['a', 'b', 'c', 'd'].map((id) => session(id, id)));
    const { rerender } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} active />);
    const tablist = screen.getByRole('tablist');
    let width = 1000;
    Object.defineProperty(tablist, 'clientWidth', { get: () => width, configurable: true });
    tablist.getBoundingClientRect = () => ({ left: 100, width }) as DOMRect;
    screen.getAllByRole('tab').forEach((tab, index) => {
      tab.getBoundingClientRect = () => ({ left: 100 + index * 215 - tablist.scrollLeft, width: 215 }) as DOMRect;
    });
    // Перерисовка с прежней шириной — наблюдатель запоминает 1000px как «до».
    rerender(<TabStrip workKey={WORK_KEY} group={{ ...group }} entry={e} portal={false} active />);
    act(() => {
      for (const ro of FakeRO.all) ro.callback([], ro as unknown as ResizeObserver);
    });
    return {
      tablist,
      resize(next: number) {
        width = next;
        act(() => {
          for (const ro of FakeRO.all) ro.callback([], ro as unknown as ResizeObserver);
        });
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('активная видна; строку сузили (открыли сайдбар) — она снова в видимой части', () => {
    const { tablist, resize } = setup();
    expect(tablist.scrollLeft).toBe(0);
    resize(500);
    expect(tablist.scrollLeft).toBe(3 * 215 + 215 - 500 + 24);
  });

  it('человек увёл активную из вида колесом — сужение её не возвращает', () => {
    const { tablist, resize } = setup();
    resize(500);
    tablist.scrollLeft = 0;
    resize(400);
    expect(tablist.scrollLeft).toBe(0);
  });
});

// Раунд fix-live, O1 (спека 5.3, «у краёв — затухание»): затухание — признак «есть ещё вкладки»,
// поэтому оно только у того края, за которым действительно есть скрытое, и нет без переполнения.
describe('TabStrip — затухание краёв только со стороны скрытых вкладок (fix-live O1)', () => {
  function setup(): { tablist: HTMLElement; layout(scrollWidth: number, clientWidth: number, scrollLeft: number): void } {
    const tabs = ['a', 'b', 'c'].map((id) => ({ kind: 'terminal' as const, id: `terminal:${id}`, sessionId: id }));
    const group: GroupNode = { type: 'group', id: 'g1', tabs, activeTabId: 'terminal:a' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    render(<TabStrip workKey={WORK_KEY} group={group} entry={entry(['a', 'b', 'c'].map((id) => session(id, id)))} portal={false} active />);
    const tablist = screen.getByRole('tablist');
    return {
      tablist,
      layout(scrollWidth, clientWidth, scrollLeft) {
        Object.defineProperty(tablist, 'scrollWidth', { value: scrollWidth, configurable: true });
        Object.defineProperty(tablist, 'clientWidth', { value: clientWidth, configurable: true });
        tablist.scrollLeft = scrollLeft;
        fireEvent.scroll(tablist);
      },
    };
  }
  const fades = (el: HTMLElement): [string | undefined, string | undefined] => [el.dataset['fadeStart'], el.dataset['fadeEnd']];

  it('без переполнения — затухания нет ни у одного края', () => {
    const { tablist, layout } = setup();
    layout(400, 500, 0);
    expect(fades(tablist)).toEqual([undefined, undefined]);
  });

  it('переполнение, строка в начале — затухание только справа', () => {
    const { tablist, layout } = setup();
    layout(1200, 500, 0);
    expect(fades(tablist)).toEqual([undefined, '']);
  });

  it('строка в середине — у обоих краёв; в конце — только слева', () => {
    const { tablist, layout } = setup();
    layout(1200, 500, 300);
    expect(fades(tablist)).toEqual(['', '']);
    layout(1200, 500, 700);
    expect(fades(tablist)).toEqual(['', undefined]);
  });
});

// Облик Organic (спека окна 2026-09-29, 1.1): вкладки делят строку — до 200px, не уже 72px — и сужаются,
// пока не упрутся в минимум; между пилюлями зазор 4; «+» — пилюля 28px.
describe('TabStrip — вкладки-пилюли (Organic, 1.1)', () => {
  const mail: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'mail', id: 'mail' }, { kind: 'terminal', id: 'terminal:a', sessionId: 'a' }], activeTabId: 'terminal:a' };

  function mountStrip(portal: boolean, group: GroupNode = mail, e: WorkEntry = entry([session('a', 'исполнитель')])) {
    useLayoutStore.setState({ layouts: { [WORK_KEY]: { root: group, activeGroupId: group.id, closedTabs: [] } }, hydrated: { [WORK_KEY]: true } });
    return render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={portal} active />);
  }

  it('обёртка вкладки держит flex 0 1 200px и минимум 72px; пилюля занимает её целиком', () => {
    mountStrip(false);
    for (const tab of screen.getAllByRole('tab')) {
      const wrapper = tab.parentElement as HTMLElement;
      expect(wrapper.className).toContain('flex-[0_1_200px]');
      expect(wrapper.className).toContain('min-w-[72px]');
      expect(wrapper.className).not.toContain('shrink-0');
      expect(tab.className).toContain('w-full');
    }
  });

  it('в заголовке: строка на фоне окна, зазор 4, без линии; над телом группы — h-9 с линией снизу на листе', () => {
    const inTitlebar = mountStrip(true);
    // Нет слота `#titlebar-tabs` — портал рисуется на месте.
    const bar = screen.getByRole('tablist');
    expect(bar.className).toContain('gap-1');
    expect(bar.className).toMatch(/\bh-full\b/);
    expect(bar.className).not.toMatch(/\bbg-card\b/);
    expect(bar.className).not.toMatch(/\bborder-b\b/);
    inTitlebar.unmount();

    mountStrip(false);
    const own = screen.getByRole('tablist');
    expect(own.className).toMatch(/\bh-9\b/);
    expect(own.className).toMatch(/\bborder-b\b/);
    expect(own.className).not.toMatch(/\bbg-card\b/);
  });

  it('«+» — пилюля 28px с hover text 8%', () => {
    mountStrip(false);
    const plus = screen.getByLabelText('Open…');
    expect(plus.className).toMatch(/\bsize-7\b/);
    expect(plus.className).toMatch(/\brounded-full\b/);
    expect(plus.className).toContain('hover:bg-foreground/8');
  });

  it('подкраска: почта с непрочитанным и комната с ждущим решением — accent-200', () => {
    const roomTab = { kind: 'room', id: 'room:r-01', roomId: 'r-01' } as const;
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'mail', id: 'mail' }, roomTab], activeTabId: 'mail' };
    const e = entry([], [{ id: 'r-01', title: 'Возвраты', creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z', lead: null, proposal: { id: 'p-1', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' } }]);
    const withLetter: WorkEntry = {
      ...e,
      map: { ...e.map, messages: [{ id: 'm-1', roomId: null, from: 's-01', to: ['human'], at: '2026-09-29T10:00:00.000Z', text: 'привет', kind: 'note', readBy: {} }] },
    };
    mountStrip(false, group, withLetter);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]?.className).toContain('bg-accent-200');
    expect(tabs[1]?.className).toContain('bg-accent-200');
  });
});
