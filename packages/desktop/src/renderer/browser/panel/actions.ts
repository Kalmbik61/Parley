/**
 * Действия окна над панелями браузера хозяев (спека браузера 3.10, 4.11; этап B2, часть 1). Тонкие обёртки над чистыми
 * операциями `layout/panels.ts`, которые идут через `useLayoutStore.apply`: до гидрации работы операция ждёт в очереди,
 * отказ предела страниц — тост «No more than 5 pages…».
 *
 * `openPageInPanel` — то, что зовёт и человек (кнопка «+», «Move to browser of…»), и агент (`browser_open`, этап B2, часть 2):
 * страница встаёт в панель хозяина и показывается; закрытая панель открывается, но клавиатурный фокус остаётся там, где был.
 *
 * Страницы панелей в событиях main (`browser:focus`, `browser:open-tab`) называет только их `webContentsId` → ключ записей окна
 * (`browser/store.ts`): `focusPanelPage` и `openPopupInPanel` разбирают то, что вкладкам раскладки (`openBrowserTabFrom`) не по
 * зубам, а `focusedPanelPage` отдаёт клавишам из страницы (⌘F, масштаб, Select, Annotate, консоль) ту, на которую кликнули.
 */

import { toast } from 'sonner';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { ownerKey, ownerTabId, panelPageId } from '../../layout/ids.js';
import { activatePanelPage, addPanelPage, closePanelPage, ownerOfPage, panelOf, setPanelOpen, setPanelWidth } from '../../layout/panels.js';
import { useLayoutStore, type LayoutOp, type LayoutState } from '../../layout/store.js';
import { closeTab, findTab, focusTab, type OpError } from '../../layout/tree.js';
import { requestAddressFocus, useBrowserStore } from '../store.js';
import { layoutUrl } from '../url.js';
import { panelRuntimeKey, usePanelRuntime } from './runtime.js';

/** Операция над раскладкой работы; отказ предела страниц человек узнаёт тостом. */
function run(workKey: string, op: LayoutOp): OpError | null {
  const error = useLayoutStore.getState().apply(workKey, op);
  if (error === 'too-many-pages') toast(S.browser.panel.tooManyPages);
  return error;
}

/**
 * Кнопка «Browser» у вида хозяина: открытая панель закрывается, закрытая открывается; панели ещё нет — создаётся с одной
 * пустой страницей, и адресная строка берёт фокус, как у новой вкладки браузера.
 */
export function togglePanel(workKey: string, owner: BrowserOwner): void {
  const pageId = panelPageId();
  run(workKey, (layout) => {
    const panel = panelOf(layout, owner);
    if (panel !== undefined) return setPanelOpen(layout, owner, !panel.open);
    requestAddressFocus(pageId);
    return addPanelPage(layout, owner, { id: pageId, url: '' });
  });
}

/** «Back to chat» узкого вида и × полоски: панель прячется, страницы остаются. */
export function closePanel(workKey: string, owner: BrowserOwner): void {
  run(workKey, (layout) => setPanelOpen(layout, owner, false));
}

/** «+» полоски страниц: пустая страница, адресная строка в фокусе. */
export function addBlankPage(workKey: string, owner: BrowserOwner): void {
  const pageId = panelPageId();
  run(workKey, (layout) => {
    requestAddressFocus(pageId);
    return addPanelPage(layout, owner, { id: pageId, url: '' });
  });
}

export function closePage(workKey: string, owner: BrowserOwner, pageId: string): void {
  run(workKey, (layout) => closePanelPage(layout, owner, pageId));
}

export function activatePage(workKey: string, owner: BrowserOwner, pageId: string): void {
  run(workKey, (layout) => activatePanelPage(layout, owner, pageId));
}

/** Ширина панели с ручки — один раз, на `pointerup` (`shell/Resizer.tsx`). */
export function resizePanel(workKey: string, owner: BrowserOwner, width: number): void {
  run(workKey, (layout) => setPanelWidth(layout, owner, width));
}

export type OpenPageResult =
  /** `opened` — панель была закрыта или её не было: человек получает её открытой впервые. */
  | { ok: true; pageId: string; opened: boolean }
  /** `no-work` — раскладка работы ещё не прочитана с диска (звавший гидрирует её сам); `bad-url` — не http(s); `limit` — в панели уже 5 страниц. */
  | { ok: false; reason: 'no-work' | 'bad-url' | 'limit' };

/**
 * Страница `url` в панель хозяина: активная, панель открыта. `focus: false` — открывается закрытая панель, а клавиатурный
 * фокус не трогается (страница агента, спека браузера 5.2); `focus: true` — страница без адреса берёт фокус в адресной
 * строке, как новая вкладка. Адрес в раскладку идёт как у вкладки (`layoutUrl`: http(s) без user:pass@), пустой — страница
 * без адреса. Активная вкладка, группа и работа окна не меняются ни при каком `focus`.
 */
export function openPageInPanel(workKey: string, owner: BrowserOwner, url: string, options: { focus: boolean }): OpenPageResult {
  const layout = useLayoutStore.getState().layouts[workKey];
  if (layout === undefined) return { ok: false, reason: 'no-work' };
  const safe = url === '' ? '' : layoutUrl(url);
  if (safe === null) return { ok: false, reason: 'bad-url' };
  const pageId = panelPageId();
  const opened = panelOf(layout, owner)?.open !== true;
  if (options.focus && safe === '') requestAddressFocus(pageId);
  const error = run(workKey, (current) => addPanelPage(current, owner, { id: pageId, url: safe }));
  return error === 'too-many-pages' ? { ok: false, reason: 'limit' } : { ok: true, pageId, opened };
}

/**
 * «Move to browser of…» у вкладки человека: адрес и размер переезжают в новую страницу панели хозяина, вкладка закрывается.
 * Вкладка не уходит в стек ⌘⇧T: страница переехала, а не закрыта, и возврат дал бы двойника. Предел страниц панели —
 * вкладка остаётся на месте.
 */
export function moveTabToPanel(workKey: string, tabId: string, owner: BrowserOwner): OpError | null {
  const pageId = panelPageId();
  return run(workKey, (layout) => {
    const found = findTab(layout, tabId);
    const tab = found?.group.tabs[found.index];
    if (tab?.kind !== 'browser') return { layout, error: 'not-found' };
    const added = addPanelPage(layout, owner, { id: pageId, url: tab.url, ...(tab.viewport === undefined ? {} : { viewport: tab.viewport }) });
    if (added.error !== null) return added;
    const closed = closeTab(added.layout, tabId);
    return { layout: { ...closed, closedTabs: closed.closedTabs.filter((closedTab) => closedTab.id !== tabId) }, error: null };
  });
}

/** Работа и хозяин панели, в которой стоит страница `pageId`, среди всех гидрированных раскладок; нет — `null`. */
function locatePanelPage(layouts: LayoutState['layouts'], pageId: string): { workKey: string; owner: BrowserOwner } | null {
  for (const [workKey, layout] of Object.entries(layouts)) {
    const owner = ownerOfPage(layout, pageId);
    if (owner !== null) return { workKey, owner };
  }
  return null;
}

/** Страница панели, получившая фокус последней (`browser:focus`): цель ⌘F, масштаба, Select, Annotate и консоли из страницы. */
let focusedPage: string | null = null;

/**
 * Клик в страницу панели (событие `browser:focus` от main: DOM окна клик в госте не видит): панель освежается, а вкладка её
 * хозяина становится активной в своей группе — как у клика в страницу вкладки. `true` — это страница панели (событие её), даже
 * если менять нечего: страница другой работы LRU или хозяин не на экране — клик пришёл не от человека, раскладка прежняя.
 */
export function focusPanelPage(pageId: string): boolean {
  const state = useLayoutStore.getState();
  const located = locatePanelPage(state.layouts, pageId);
  if (located === null) return false;
  const layout = state.layouts[located.workKey];
  const tabId = ownerTabId(located.owner);
  const found = layout === undefined ? null : findTab(layout, tabId);
  if (layout === undefined || located.workKey !== state.activeWorkKey || found === null || found.group.activeTabId !== tabId) return true;
  focusedPage = pageId;
  usePanelRuntime.getState().touch(panelRuntimeKey(located.workKey, located.owner));
  if (layout.activeGroupId !== found.group.id) state.apply(located.workKey, (current) => focusTab(current, tabId));
  return true;
}

/** Фокус ушёл на страницу вкладки: её клавиши принадлежат вкладке, а не панели. */
export function forgetFocusedPanelPage(): void {
  focusedPage = null;
}

/**
 * Страница панели для клавиш из страницы, когда активной вкладки браузера нет (`AppShell#activeBrowserPage`): та, что получила
 * фокус последней, пока она по-прежнему на экране — работа активна, панель открыта, вид хозяина в своей группе активен, страница
 * активна в панели; иначе — ничего. `tabId` — ключ записей окна (`browser/store.ts`), как у вкладки.
 */
export function focusedPanelPage(): { tabId: string; webContentsId: number } | null {
  if (focusedPage === null) return null;
  const state = useLayoutStore.getState();
  const workKey = state.activeWorkKey;
  const layout = workKey === null ? undefined : state.layouts[workKey];
  const owner = layout === undefined ? null : ownerOfPage(layout, focusedPage);
  if (layout === undefined || owner === null) return null;
  const panel = panelOf(layout, owner);
  const found = findTab(layout, ownerTabId(owner));
  if (panel?.open !== true || panel.active !== focusedPage || found === null || found.group.activeTabId !== ownerTabId(owner)) return null;
  const webContentsId = useBrowserStore.getState().tabs[focusedPage]?.webContentsId ?? null;
  return webContentsId === null ? null : { tabId: focusedPage, webContentsId };
}

/**
 * `window.open` страницы панели (`browser:open-tab`): новая страница встаёт в ту же панель, а не вкладкой работы. Только пока
 * панель на экране: страница скрытой панели зовёт `window.open` и по таймеру, и открывать из-за этого панель человеку нельзя.
 * `true` — открыватель — страница панели (событие её), что бы с ним ни стало.
 */
export function openPopupInPanel(openerPageId: string, url: string): boolean {
  const state = useLayoutStore.getState();
  const located = locatePanelPage(state.layouts, openerPageId);
  if (located === null) return false;
  const shown =
    located.workKey === state.activeWorkKey &&
    state.layouts[located.workKey]?.panels?.[ownerKey(located.owner)]?.open === true &&
    usePanelRuntime.getState().hosts[panelRuntimeKey(located.workKey, located.owner)] !== undefined;
  if (shown) openPageInPanel(located.workKey, located.owner, url, { focus: false });
  return true;
}
