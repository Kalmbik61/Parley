/**
 * Тесты 2, 3, 11 куска 2.4: активная вкладка (`data-active`, нижняя полоса),
 * крестик/средняя кнопка закрывают вкладку, «Закрыть остальные»/«Закрыть
 * справа» — одним вызовом `requestCloseTabs`, крестик неактивной вкладки
 * скрыт до hover.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { Tab } from './Tab.js';
import type { TabMeta } from './tab-meta.js';

const WORK_KEY = '/tmp/p w';

function tab(id: string): TabSpec {
  return { kind: 'terminal', id, sessionId: id };
}

function meta(title: string): TabMeta {
  return { title, icon: 'terminal', session: null, unread: false, dirty: false, favicon: null };
}

function setLayoutWithGroup(group: GroupNode): void {
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root: group, activeGroupId: group.id, closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

function remainingIds(): string[] {
  const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
  return root?.type === 'group' ? root.tabs.map((t) => t.id) : [];
}

afterEach(() => {
  cleanup();
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

describe('Tab — тест 2', () => {
  it('активная вкладка: data-active="true" и нижняя полоса', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive openSessionIds={[]} />);
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-active')).toBe('true');
    expect(el.style.borderBottom).toContain('color-mix');
  });

  it('неактивная вкладка: data-active="false", без нижней полосы', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} openSessionIds={[]} />);
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-active')).toBe('false');
    expect(el.style.borderBottom).toBe('');
  });

  it('крестик зовёт requestCloseTabs с id вкладки — она закрыта', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive openSessionIds={[]} />);
    fireEvent.click(screen.getByLabelText('Close'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
  });

  it('средняя кнопка (auxclick) тоже закрывает вкладку', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive openSessionIds={[]} />);
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
  });
});

describe('Tab — тест 3', () => {
  it('«Закрыть остальные» — один вызов requestCloseTabs, остаётся текущая', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b' };
    setLayoutWithGroup(group);
    const spy = vi.spyOn(useLayoutStore.getState(), 'requestCloseTabs');

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive openSessionIds={[]} />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByText('Close others'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WORK_KEY, ['a', 'c']);
  });

  it('«Закрыть справа» — остаются вкладки слева и текущая', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b' };
    setLayoutWithGroup(group);
    const spy = vi.spyOn(useLayoutStore.getState(), 'requestCloseTabs');

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive openSessionIds={[]} />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByText('Close to the right'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['a', 'b']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WORK_KEY, ['c']);
  });
});

describe('Tab — тест 11', () => {
  it('крестик неактивной вкладки скрыт до hover, у активной — виден', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    const { rerender } = render(
      <Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} openSessionIds={[]} />,
    );
    const inactiveClose = screen.getByLabelText('Close');
    expect(inactiveClose.className).toContain('opacity-0');
    expect(inactiveClose.className).toContain('group-hover:opacity-100');

    rerender(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive openSessionIds={[]} />);
    const activeClose = screen.getByLabelText('Close');
    expect(activeClose.className).toContain('opacity-100');
    expect(activeClose.className).not.toContain('opacity-0');
  });
});

describe('Tab — раунд исправлений 1: доступность (ревью A, Important №2)', () => {
  it('активная — aria-selected="true", tabIndex 0; неактивная — "false", -1 (roving tabindex)', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive openSessionIds={[]} />);
    const active = screen.getByRole('tab');
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.tabIndex).toBe(0);
    cleanup();

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} openSessionIds={[]} />);
    const inactive = screen.getByRole('tab');
    expect(inactive.getAttribute('aria-selected')).toBe('false');
    expect(inactive.tabIndex).toBe(-1);
  });

  it('Enter на неактивной вкладке фокусирует её (как клик)', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} openSessionIds={[]} />);
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Enter' });

    await vi.waitFor(() => expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'b' }));
  });

  it('Пробел на неактивной вкладке тоже фокусирует её', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} openSessionIds={[]} />);
    fireEvent.keyDown(screen.getByRole('tab'), { key: ' ' });

    await vi.waitFor(() => expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'b' }));
  });
});
