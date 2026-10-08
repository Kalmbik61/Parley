/**
 * Журнал консоли и сети вкладок браузера в окне (спека 2026-10-07-browser-devtools-agent-design.md, 3.5, 4.3, 4.4).
 *
 * Здесь — копия журнала main по вкладке и состояние её панели:
 * - журнал: снимок `devtoolsSnapshot`, потом пачки `browser:devtools`;
 * - панель: открыта ли, какой вид, фильтры, выбранный запрос.
 * Пределы — те же, что у колец main (`DEVTOOLS_LIMITS`). Журнал пишет `BrowserSurface`; вид — панель, кнопка строки и
 * действия `browser.devtools` и `browser.console` (клавиши, палитра).
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  DEVTOOLS_LIMITS,
  isFailed,
  type CaptureState,
  type ConsoleEntry,
  type ConsoleLevel,
  type DevtoolsBatch,
  type DevtoolsSnapshot,
  type NetworkEntry,
  type NetworkKind,
} from '../../../shared/browser-devtools.js';

export type DevtoolsView = 'console' | 'network';
/** Кнопки типов Network (спека 4.4): All, Fetch/XHR, Doc, JS, CSS, Img, Other. */
export type NetworkFilter = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'other';

export interface TabDevtools {
  epoch: number;
  capture: CaptureState;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  open: boolean;
  view: DevtoolsView;
  /** «Preserve log»: прежние эпохи остаются видны, между ними — разделитель (спека 4.3). */
  preserve: boolean;
  levels: Record<ConsoleLevel, boolean>;
  consoleText: string;
  networkFilter: NetworkFilter;
  failedOnly: boolean;
  urlText: string;
  /** requestId запроса в деталях (спека 4.4). */
  selected: string | null;
}

export type DevtoolsPatch = Partial<
  Pick<TabDevtools, 'view' | 'preserve' | 'levels' | 'consoleText' | 'networkFilter' | 'failedOnly' | 'urlText' | 'selected'>
>;

export const EMPTY_DEVTOOLS: TabDevtools = {
  epoch: 0,
  capture: 'on',
  console: [],
  network: [],
  open: false,
  view: 'console',
  preserve: false,
  // Debug по умолчанию выключен (спека 4.3).
  levels: { error: true, warning: true, info: true, debug: false },
  consoleText: '',
  networkFilter: 'all',
  failedOnly: false,
  urlText: '',
  selected: null,
};

export interface DevtoolsState {
  tabs: Record<string /* tabId */, TabDevtools>;
  snapshot(tabId: string, snapshot: DevtoolsSnapshot): void;
  batch(tabId: string, batch: DevtoolsBatch): void;
  clear(tabId: string): void;
  toggle(tabId: string): void;
  show(tabId: string, view: DevtoolsView): void;
  hide(tabId: string): void;
  patch(tabId: string, patch: DevtoolsPatch): void;
  remove(tabId: string): void;
}

const KINDS: Readonly<Record<Exclude<NetworkFilter, 'all'>, readonly NetworkKind[]>> = {
  fetch: ['fetch', 'xhr'],
  doc: ['document'],
  js: ['script'],
  css: ['stylesheet'],
  img: ['image'],
  other: ['font', 'media', 'websocket', 'other'],
};

/** Новые записи — в конец, изменённые — на своё место; сверх предела уходят старшие. */
function upsert<T extends { id: number | string }>(list: readonly T[], updates: readonly T[], limit: number): T[] {
  const next = [...list];
  const index = new Map<number | string, number>(next.map((item, at) => [item.id, at]));
  for (const item of updates) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
  }
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export const useDevtoolsStore: UseBoundStore<StoreApi<DevtoolsState>> = create<DevtoolsState>((set) => {
  const update = (tabId: string, change: (tab: TabDevtools) => Partial<TabDevtools>): void =>
    set((state) => {
      const tab = state.tabs[tabId] ?? EMPTY_DEVTOOLS;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, ...change(tab) } } };
    });
  return {
    tabs: {},
    snapshot: (tabId, snapshot) =>
      update(tabId, () => ({
        epoch: snapshot.epoch,
        capture: snapshot.capture,
        console: snapshot.console.slice(-DEVTOOLS_LIMITS.consoleEntries),
        network: snapshot.network.slice(-DEVTOOLS_LIMITS.networkEntries),
      })),
    batch: (tabId, batch) =>
      update(tabId, (tab) => ({
        epoch: batch.epoch,
        capture: batch.capture,
        console: upsert(batch.reset ? [] : tab.console, batch.console, DEVTOOLS_LIMITS.consoleEntries),
        network: upsert(batch.reset ? [] : tab.network, batch.network, DEVTOOLS_LIMITS.networkEntries),
        // Новая страница без «Preserve log» — прежний запрос из списка ушёл, деталям нечего показывать.
        selected: batch.reset || (batch.epoch !== tab.epoch && !tab.preserve) ? null : tab.selected,
      })),
    clear: (tabId) => update(tabId, () => ({ console: [], network: [], selected: null })),
    toggle: (tabId) => update(tabId, (tab) => ({ open: !tab.open })),
    show: (tabId, view) => update(tabId, () => ({ open: true, view })),
    hide: (tabId) => update(tabId, () => ({ open: false })),
    patch: (tabId, patch) => update(tabId, () => patch),
    remove: (tabId) =>
      set((state) => {
        if (!(tabId in state.tabs)) return state;
        const rest = { ...state.tabs };
        delete rest[tabId];
        return { tabs: rest };
      }),
  };
});

/** Записи Console по фильтрам: текущая эпоха (или все с «Preserve log»), уровни, подстрока без учёта регистра. */
export function visibleConsole(tab: TabDevtools): ConsoleEntry[] {
  const needle = tab.consoleText.trim().toLowerCase();
  return tab.console.filter(
    (entry) =>
      (tab.preserve || entry.epoch === tab.epoch) &&
      tab.levels[entry.level] &&
      (needle === '' || entry.text.toLowerCase().includes(needle)),
  );
}

/** Запросы Network по фильтрам: эпоха, тип, «Failed only» (`isFailed`), подстрока URL. */
export function visibleNetwork(tab: TabDevtools): NetworkEntry[] {
  const needle = tab.urlText.trim().toLowerCase();
  const kinds = tab.networkFilter === 'all' ? null : KINDS[tab.networkFilter];
  return tab.network.filter(
    (entry) =>
      (tab.preserve || entry.epoch === tab.epoch) &&
      (kinds === null || kinds.includes(entry.kind)) &&
      (!tab.failedOnly || isFailed(entry)) &&
      (needle === '' || entry.url.toLowerCase().includes(needle)),
  );
}

/** Адрес документа эпохи — для разделителя «Navigated to …» при «Preserve log». */
export function documentUrl(tab: TabDevtools, epoch: number): string | null {
  return tab.network.find((entry) => entry.epoch === epoch && entry.kind === 'document')?.url ?? null;
}

/**
 * Счётчики кнопки строки (спека 4.1), текущая эпоха.
 * - Красный — ошибки консоли с повторами, исключения и упавшие запросы.
 * - Жёлтый — предупреждения консоли.
 * Строки сети («Failed to load resource», CORS — у них есть `networkRequestId`) — про сам запрос: второй раз его не считают
 * (Фокус ревью 3). Ошибки браузера без запроса — нарушение CSP и прочее — считаются: пары в сети у них нет.
 */
export function devtoolsCounters(tab: TabDevtools): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const entry of tab.console) {
    if (entry.epoch !== tab.epoch) continue;
    if (entry.level === 'error' && entry.origin !== 'network') errors += entry.count;
    else if (entry.level === 'warning' && entry.origin === 'console') warnings += entry.count;
  }
  for (const entry of tab.network) if (entry.epoch === tab.epoch && isFailed(entry)) errors += 1;
  return { errors, warnings };
}
