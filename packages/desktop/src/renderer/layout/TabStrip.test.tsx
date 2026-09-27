/**
 * Тест 1 куска 2.4 (часть про саму строку): при `portal` строка вкладок рисуется
 * порталом в `#titlebar-tabs`, а не на своём обычном месте в дереве; без
 * `portal` — на своём месте.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { GroupNode } from '../../shared/layout-types.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { activityMap as keyed, makeActivity } from '../test-utils/work-fixtures.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { TabStrip } from './TabStrip.js';

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
