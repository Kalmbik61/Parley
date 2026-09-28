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
import { S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import type { LayoutState } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';

export interface BrowserTabState {
  title: string | null;
  favicon: string | null; // favicon — data: из main
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  webContentsId: number | null; // с dom-ready: раньше getWebContentsId() бросает
} // адрес — только в раскладке (TabSpec.url); findOpen добавит 9.2b, pick — 9.3b

export interface BrowserState {
  tabs: Record<string /* tabId */, BrowserTabState>;
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
};

export const useBrowserStore: UseBoundStore<StoreApi<BrowserState>> = create<BrowserState>((set) => ({
  tabs: {},
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
  deps.apply(key, (current) =>
    browserTabCount(current) >= BROWSER_LIMITS.tabsPerWork ? current : openTab(current, { kind: 'browser', id: tabId.browser(), url }),
  );
  return 'opened';
}
