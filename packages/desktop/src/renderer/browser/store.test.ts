/**
 * Тест 1 куска 9.2a: `openBrowserTab` держит предел 10 вкладок браузера на работу (спека 12.4)
 * и без активной работы отвечает тостом, как действия 6.3. Плюс сам стор вкладок.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import type { LayoutOp } from '../layout/store.js';
import { emptyLayout, findTab, focusTab, groups, openTab, splitGroup } from '../layout/tree.js';
import { BROWSER_LIMITS, browserTabCount, openBrowserTab, openBrowserTabFrom, useBrowserStore, wantsAddressFocus } from './store.js';

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
  useBrowserStore.setState({ tabs: {}, limitToasted: {} });
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

const OTHER = '/tmp/q\nw-02';
const OPENER = 'browser:0000a1';

/** Две работы: в KEY — группы g1 (терминал + открыватель) и g2 (терминал); OTHER — открыватель другой работы. */
function twoWorks() {
  let layout = openTab(emptyLayout(), { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' });
  layout = openTab(layout, { kind: 'browser', id: OPENER, url: 'http://127.0.0.1:5173/' });
  const g1 = layout.activeGroupId;
  layout = openTab(layout, { kind: 'terminal', id: tabId.terminal('s-03'), sessionId: 's-03' });
  layout = focusTab(layout, OPENER);
  const split = splitGroup(layout, g1, 'row', { kind: 'terminal', id: tabId.terminal('s-02'), sessionId: 's-02' });
  layout = split.layout;
  const g2 = layout.activeGroupId;
  const other = openTab(emptyLayout(), { kind: 'browser', id: 'browser:0000b1', url: 'http://127.0.0.1:5174/' });
  return { layout, g1, g2, other };
}

function multiDeps(initial: Record<string, WorkLayout>, activeWorkKey: string | null, ids: Record<number, string>) {
  const layouts: Record<string, WorkLayout> = { ...initial };
  const apply = vi.fn((key: string, op: LayoutOp) => {
    const current = layouts[key];
    if (current === undefined) return null;
    const next = op(current);
    layouts[key] = 'layout' in next ? next.layout : next;
    return null;
  });
  return { apply, layouts, activeWorkKey, tabIdOf: (id: number) => ids[id] ?? null, toast: vi.fn() };
}

describe('openBrowserTabFrom (тест 4 куска 9.2b)', () => {
  it('открыватель — активная вкладка активной группы → новая вкладка сразу за ним и активна', () => {
    const { layout, g1 } = twoWorks();
    const focused = focusTab(layout, OPENER);
    const d = multiDeps({ [KEY]: focused }, KEY, { 7: OPENER });
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5173/popup', openerWebContentsId: 7 }, d)).toBe('opened');
    const group = groups(d.layouts[KEY] as WorkLayout).find((g) => g.id === g1);
    const index = group?.tabs.findIndex((tab) => tab.id === OPENER) ?? -1;
    const opened = group?.tabs[index + 1];
    expect(opened).toMatchObject({ kind: 'browser', url: 'http://127.0.0.1:5173/popup' });
    expect(group?.activeTabId).toBe(opened?.id);
    expect(d.layouts[KEY]?.activeGroupId).toBe(g1);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('открыватель — неактивная вкладка своей группы → вкладка за ним, активные прежние', () => {
    const { layout, g1, g2 } = twoWorks();
    const hidden = focusTab(focusTab(layout, tabId.terminal('s-03')), tabId.terminal('s-02'));
    const d = multiDeps({ [KEY]: hidden }, KEY, { 7: OPENER });
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5173/popup', openerWebContentsId: 7 }, d)).toBe('opened');
    const after = d.layouts[KEY] as WorkLayout;
    const group = groups(after).find((g) => g.id === g1);
    const index = group?.tabs.findIndex((tab) => tab.id === OPENER) ?? -1;
    expect(group?.tabs[index + 1]).toMatchObject({ kind: 'browser', url: 'http://127.0.0.1:5173/popup' });
    expect(group?.activeTabId).toBe(tabId.terminal('s-03'));
    expect(after.activeGroupId).toBe(g2);
  });

  it('открыватель в неактивной работе LRU → вкладка в его работе без смены активной; активная работа не тронута', () => {
    const { layout, other } = twoWorks();
    const d = multiDeps({ [KEY]: layout, [OTHER]: other }, KEY, { 9: 'browser:0000b1' });
    const before = d.layouts[KEY];
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5174/x', openerWebContentsId: 9 }, d)).toBe('opened');
    expect(d.layouts[KEY]).toBe(before);
    const group = groups(d.layouts[OTHER] as WorkLayout)[0];
    expect(group?.tabs.map((tab) => tab.kind === 'browser' && tab.url)).toEqual(['http://127.0.0.1:5174/', 'http://127.0.0.1:5174/x']);
    expect(group?.activeTabId).toBe('browser:0000b1');
    expect(d.activeWorkKey).toBe(KEY);
  });

  it('неизвестный openerWebContentsId или вкладки нет в раскладках → gone, раскладки те же', () => {
    const { layout } = twoWorks();
    const d = multiDeps({ [KEY]: layout }, KEY, { 7: 'browser:0000ff' });
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5173/popup', openerWebContentsId: 8 }, d)).toBe('gone');
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5173/popup', openerWebContentsId: 7 }, d)).toBe('gone');
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.layouts[KEY]).toBe(layout);
  });

  it('адрес с user:pass@ в раскладку идёт без них', () => {
    const { layout } = twoWorks();
    const d = multiDeps({ [KEY]: focusTab(layout, OPENER) }, KEY, { 7: OPENER });
    openBrowserTabFrom({ url: 'http://u:p@127.0.0.1:5173/in', openerWebContentsId: 7 }, d);
    const found = findTab(d.layouts[KEY] as WorkLayout, OPENER);
    expect(found?.group.tabs[(found?.index ?? 0) + 1]).toMatchObject({ url: 'http://127.0.0.1:5173/in' });
  });
});

describe('openBrowserTabFrom — предел (тест 5 куска 9.2b)', () => {
  it('10 вкладок браузера: три вызова одного открывателя — один тост и три limit; другой открыватель — свой тост', () => {
    let layout = withBrowserTabs(10);
    layout = focusTab(layout, 'browser:000000');
    const d = multiDeps({ [KEY]: layout }, KEY, { 7: 'browser:000000', 8: 'browser:000001' });
    const results = [1, 2, 3].map(() => openBrowserTabFrom({ url: 'http://127.0.0.1:5173/', openerWebContentsId: 7 }, d));
    expect(results).toEqual(['limit', 'limit', 'limit']);
    expect(d.toast).toHaveBeenCalledTimes(1);
    expect(d.toast).toHaveBeenCalledWith('No more than 10 browser tabs per workspace');
    expect(openBrowserTabFrom({ url: 'http://127.0.0.1:5173/', openerWebContentsId: 8 }, d)).toBe('limit');
    expect(d.toast).toHaveBeenCalledTimes(2);
    expect(d.apply).not.toHaveBeenCalled();
    expect(browserTabCount(d.layouts[KEY] as WorkLayout)).toBe(10);
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
      findOpen: false,
      pick: 'off',
    });
    useBrowserStore.getState().update('browser:a', { loading: true });
    expect(useBrowserStore.getState().tabs['browser:a']?.title).toBe('Page');
    useBrowserStore.getState().remove('browser:a');
    expect(useBrowserStore.getState().tabs['browser:a']).toBeUndefined();
  });
});

describe('BrowserTabState.pick (кусок 9.3b)', () => {
  it('новая вкладка — off; update меняет pick, прочие поля не трогает', () => {
    useBrowserStore.getState().update('browser:1', { title: 'T' });
    expect(useBrowserStore.getState().tabs['browser:1']?.pick).toBe('off');
    useBrowserStore.getState().update('browser:1', { pick: 'picking' });
    expect(useBrowserStore.getState().tabs['browser:1']).toMatchObject({ title: 'T', pick: 'picking' });
  });
});
