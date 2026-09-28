/**
 * Тест 1 куска 9.2a: `openBrowserTab` держит предел 10 вкладок браузера на работу (спека 12.4)
 * и без активной работы отвечает тостом, как действия 6.3. Плюс сам стор вкладок.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import type { LayoutOp } from '../layout/store.js';
import { emptyLayout, groups, openTab } from '../layout/tree.js';
import { BROWSER_LIMITS, browserTabCount, openBrowserTab, useBrowserStore, wantsAddressFocus } from './store.js';

const KEY = '/tmp/p\nw-01';

function browserTab(n: number): TabSpec {
  return { kind: 'browser', id: `browser:00000${n.toString(16)}`, url: `http://localhost:${5170 + n}` };
}

function withBrowserTabs(count: number): WorkLayout {
  let layout = openTab(emptyLayout(), { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' });
  for (let n = 0; n < count; n += 1) layout = openTab(layout, browserTab(n));
  return layout;
}

function deps(layout: WorkLayout | undefined, activeWorkKey: string | null = KEY) {
  const layouts: Record<string, WorkLayout> = layout === undefined ? {} : { [KEY]: layout };
  let current = layout;
  const apply = vi.fn((key: string, op: LayoutOp) => {
    if (key === KEY && current !== undefined) {
      const next = op(current);
      current = 'layout' in next ? next.layout : next;
    }
    return null;
  });
  return { deps: { apply, layouts, activeWorkKey, toast: vi.fn() }, current: () => current };
}

afterEach(() => {
  useBrowserStore.setState({ tabs: {} });
});

describe('openBrowserTab (тест 1)', () => {
  it('десятая вкладка открывается, одиннадцатая — тост и limit, раскладка без изменений', () => {
    const nine = deps(withBrowserTabs(9));
    expect(openBrowserTab('http://localhost:5173', nine.deps)).toBe('opened');
    expect(nine.deps.toast).not.toHaveBeenCalled();
    const after = nine.current();
    if (after === undefined) throw new Error('нет раскладки');
    expect(browserTabCount(after)).toBe(10);
    const opened = groups(after)[0]?.tabs.at(-1);
    expect(opened).toMatchObject({ kind: 'browser', url: 'http://localhost:5173' });
    expect(opened?.id).toMatch(/^browser:[0-9a-f]{6}$/);

    const ten = deps(withBrowserTabs(10));
    const before = ten.current();
    expect(openBrowserTab('', ten.deps)).toBe('limit');
    expect(ten.deps.toast).toHaveBeenCalledWith('No more than 10 browser tabs per workspace');
    expect(ten.deps.apply).not.toHaveBeenCalled();
    expect(ten.current()).toBe(before);
  });

  it('activeWorkKey: null — тост No active workspace и no-work', () => {
    const none = deps(withBrowserTabs(0), null);
    expect(openBrowserTab('', none.deps)).toBe('no-work');
    expect(none.deps.toast).toHaveBeenCalledWith('No active workspace');
    expect(none.deps.apply).not.toHaveBeenCalled();
  });

  it('новая вкладка без адреса — url пустой; закрытые вкладки в счёт не идут', () => {
    let layout = withBrowserTabs(10);
    layout = { ...layout, closedTabs: [browserTab(11)], root: layout.root };
    expect(browserTabCount(layout)).toBe(10);
    const one = deps(withBrowserTabs(0));
    expect(openBrowserTab('', one.deps)).toBe('opened');
    expect(groups(one.current() as WorkLayout)[0]?.tabs.at(-1)).toMatchObject({ kind: 'browser', url: '' });
  });

  it('открытая человеком вкладка просит фокус адресной строки (перенос 9.2a)', () => {
    const one = deps(withBrowserTabs(0));
    expect(openBrowserTab('', one.deps)).toBe('opened');
    const opened = groups(one.current() as WorkLayout)[0]?.tabs.at(-1);
    expect(opened?.kind).toBe('browser');
    expect(wantsAddressFocus(opened?.id ?? '')).toBe(true);
    expect(wantsAddressFocus('browser:ffffff')).toBe(false);
  });

  it('предел — 10', () => {
    expect(BROWSER_LIMITS).toEqual({ tabsPerWork: 10 });
  });
});

describe('useBrowserStore', () => {
  it('update сливает поля с состоянием по умолчанию, remove убирает вкладку', () => {
    useBrowserStore.getState().update('browser:a', { title: 'Page' });
    expect(useBrowserStore.getState().tabs['browser:a']).toEqual({
      title: 'Page',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      webContentsId: null,
    });
    useBrowserStore.getState().update('browser:a', { loading: true });
    expect(useBrowserStore.getState().tabs['browser:a']?.title).toBe('Page');
    useBrowserStore.getState().remove('browser:a');
    expect(useBrowserStore.getState().tabs['browser:a']).toBeUndefined();
  });
});
