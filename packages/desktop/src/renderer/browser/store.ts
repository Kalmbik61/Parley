/**
 * Состояние вкладок браузера (кусок 9.2a, спека 12.1, 12.4): то, что знает только живая страница, —
 * заголовок, favicon, загрузка, «назад / вперёд», падение и id гостя. Адрес здесь не хранится: он
 * живёт в раскладке (`TabSpec.url`) и сохраняется с ней (2.2). Пишет сюда `BrowserSurface`, читают
 * хром вкладки и `tabMeta` через `useTabMetaExtras` (4.2).
 *
 * Здесь же предел вкладок браузера на работу и их открытие: счёт — до `apply`, чтобы одиннадцатая
 * вкладка не появилась и на миг.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { WorkLayout } from '../../shared/layout-types.js';
import { toast } from 'sonner';
import type { BrowserOpenTab } from '../../shared/browser-types.js';
import { S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore, type LayoutState } from '../layout/store.js';
import { findTab, groups, openTab } from '../layout/tree.js';
import { layoutUrl } from './url.js';

export interface BrowserTabState {
  title: string | null;
  favicon: string | null; // favicon — data: из main
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  webContentsId: number | null; // с dom-ready: раньше getWebContentsId() бросает
  findOpen: boolean; // полоса поиска по странице (⌘F, 9.2b)
} // адрес — только в раскладке (TabSpec.url); pick — 9.3b

export interface BrowserState {
  tabs: Record<string /* tabId */, BrowserTabState>;
  /** Открыватели window.open, которым тост предела уже показан (9.2b): страница с таймером дала бы тост на каждый вызов. */
  limitToasted: Record<number /* webContentsId */, true>;
  update(tabId: string, patch: Partial<BrowserTabState>): void;
  remove(tabId: string): void;
}

const INITIAL: BrowserTabState = {
  title: null,
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
  webContentsId: null,
  findOpen: false,
};

export const useBrowserStore: UseBoundStore<StoreApi<BrowserState>> = create<BrowserState>((set) => ({
  tabs: {},
  limitToasted: {},
  update: (id, patch) =>
    set((state) => ({ tabs: { ...state.tabs, [id]: { ...(state.tabs[id] ?? INITIAL), ...patch } } })),
  remove: (id) =>
    set((state) => {
      if (!(id in state.tabs)) return state;
      const rest = { ...state.tabs };
      delete rest[id];
      return { tabs: rest };
    }),
}));

export const BROWSER_LIMITS = { tabsPerWork: 10 } as const; // спека 12.4

/**
 * Вкладки, которые человек открыл только что: их адресная строка берёт фокус (спека 12.1). Пустая
 * вкладка из раскладки, восстановленной на старте окна, фокус не забирает — его просит только
 * действие человека (перенос 9.2a). Просьбу снимает смонтированная поверхность.
 */
const addressFocus = new Set<string>();

export function requestAddressFocus(tabId: string): void {
  addressFocus.add(tabId);
}

export function wantsAddressFocus(tabId: string): boolean {
  return addressFocus.has(tabId);
}

export function clearAddressFocus(tabId: string): void {
  addressFocus.delete(tabId);
}

/** Открытые вкладки браузера работы; закрытые (стек ⌘⇧T) в счёт не идут. */
export function browserTabCount(layout: WorkLayout): number {
  return groups(layout).reduce((count, group) => count + group.tabs.filter((tab) => tab.kind === 'browser').length, 0);
}

export type OpenBrowserTabResult = 'opened' | 'limit' | 'no-work';

/**
 * Открыть адрес ('' — новая вкладка без страницы) в активной группе активной работы. Считает вкладки browser
 * раскладки до apply: десятая есть — тост S.browser.tooManyTabs и 'limit'; активной работы нет — тост
 * S.errors.noActiveWorkspace (6.3) и 'no-work'. OpError для этого не нужен.
 */
export function openBrowserTab(
  url: string,
  deps: { apply: LayoutState['apply']; layouts: LayoutState['layouts']; activeWorkKey: string | null; toast(text: string): void },
): OpenBrowserTabResult {
  const key = deps.activeWorkKey;
  if (key === null) {
    deps.toast(S.errors.noActiveWorkspace);
    return 'no-work';
  }
  const layout = deps.layouts[key];
  if (layout !== undefined && browserTabCount(layout) >= BROWSER_LIMITS.tabsPerWork) {
    deps.toast(S.browser.tooManyTabs);
    return 'limit';
  }
  // Раскладка ещё читается с диска — операция ждёт гидрации в очереди (2.2), и предел
  // проверяется уже на ней: без тоста, зато и без одиннадцатой вкладки.
  deps.apply(key, (current) => {
    if (browserTabCount(current) >= BROWSER_LIMITS.tabsPerWork) return current;
    const id = tabId.browser();
    requestAddressFocus(id);
    return openTab(current, { kind: 'browser', id, url });
  });
  return 'opened';
}

/** Работа и место вкладки-открывателя во всех раскладках; вкладки нет — null. */
function locateTab(layouts: LayoutState['layouts'], id: string): { key: string; layout: WorkLayout } | null {
  for (const [key, layout] of Object.entries(layouts)) {
    if (findTab(layout, id) !== null) return { key, layout };
  }
  return null;
}

/**
 * window.open страницы (browser:open-tab): вкладка — в работе и группе открывателя, сразу за ним. Открыватель
 * невидим (не активная вкладка своей группы или его работа не активна) — вкладка встаёт без смены активной.
 * Предел — счёт openBrowserTab, тост один на открыватель. Открывателя нет в раскладках — 'gone', ничего.
 */
export function openBrowserTabFrom(
  e: BrowserOpenTab,
  deps: {
    apply: LayoutState['apply'];
    layouts: LayoutState['layouts'];
    activeWorkKey: string | null;
    tabIdOf(webContentsId: number): string | null; // вкладка по webContentsId стора
    toast(text: string): void;
  },
): 'opened' | 'limit' | 'gone' {
  const openerId = deps.tabIdOf(e.openerWebContentsId);
  const url = layoutUrl(e.url);
  const place = openerId === null ? null : locateTab(deps.layouts, openerId);
  if (openerId === null || url === null || place === null) return 'gone';
  if (browserTabCount(place.layout) >= BROWSER_LIMITS.tabsPerWork) {
    const store = useBrowserStore.getState();
    if (!(e.openerWebContentsId in store.limitToasted)) {
      useBrowserStore.setState({ limitToasted: { ...store.limitToasted, [e.openerWebContentsId]: true } });
      deps.toast(S.browser.tooManyTabs);
    }
    return 'limit';
  }
  const activeWork = place.key === deps.activeWorkKey;
  deps.apply(place.key, (current) => {
    const found = findTab(current, openerId);
    if (found === null || browserTabCount(current) >= BROWSER_LIMITS.tabsPerWork) return current;
    // Страница скрытой вкладки или другой работы LRU зовёт window.open и без человека (по таймеру):
    // невидимый открыватель фокус не уводит.
    const visible = activeWork && found.group.activeTabId === openerId;
    return openTab(
      current,
      { kind: 'browser', id: tabId.browser(), url },
      { groupId: found.group.id, index: found.index + 1 },
      { focus: visible },
    );
  });
  return 'opened';
}

/** openBrowserTab с зависимостями на момент вызова — useLayoutStore.getState() и toast sonner: для ссылок. */
export function openInBrowserTab(url: string): OpenBrowserTabResult {
  const layout = useLayoutStore.getState();
  // Пароль из ссылки в раскладку и в src не идёт (спека 12.1).
  return openBrowserTab(layoutUrl(url) ?? url, {
    apply: layout.apply,
    layouts: layout.layouts,
    activeWorkKey: layout.activeWorkKey,
    toast: (text) => toast(text),
  });
}
