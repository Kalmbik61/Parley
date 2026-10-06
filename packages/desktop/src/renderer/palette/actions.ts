/**
 * Действия реестра (кусок 6.3, спека 9.4, 9.6): одна ветка на каждый `ActionId` с исполнителем.
 * Зовёт их `AppShell#run` — нажатие окна, клик пункта меню и строка действия палитры. Всё, что
 * действию нужно, приходит контекстом, собранным в момент действия: история, MRU и порядок
 * сайдбара — значения сторов, а не снимок при монтировании (решение по куску 3.3).
 *
 * Рамка (спека 9.4, 15.1): действия не создают работ и сессий — только открывают форму или
 * диалог; в терминал пишет лишь `terminal.clear` (`term.clear()` поверхности, агенту ничего не
 * уходит); хост перезапускается только после «Restart» в подтверждении.
 */

import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { ActionId } from '../../shared/keybindings.js';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { errorText, S } from '../../shared/strings.js';
import type { Appearance } from '../../shared/ui-types.js';
import type { AttentionTarget } from '../attention/next.js';
import type { MruCycle } from '../keys/mru-cycle.js';
import type { FilesState } from '../files/store.js';
import { BROWSER_LIMITS, browserTabCount, openBrowserTab, requestAddressFocus, useBrowserStore } from '../browser/store.js';
import type { LayoutState } from '../layout/store.js';
import { findTab, focusGroup, focusTab, groups, reopenClosed, updateTab } from '../layout/tree.js';
import { effectiveView, feedAvailableNow, sessionStartedOrUnknown } from '../lib/feed-view.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { neighborInOrder } from '../sidebar/sort.js';
import type { TerminalSurfaceHandle } from '../terminal/surface-registry.js';
import type { PaletteState } from './store.js';

/**
 * Откуда пришло действие. `terminal.clear` по клавише и пункту меню чистит только терминал в
 * фокусе (гарантия «⌘K в сайдбаре не чистит терминал» не держится на одном
 * `triggeredByAccelerator` main); строку палитры выбирают явно, а фокус в этот миг у палитры —
 * там цель активный терминал.
 */
export type ActionSource = 'key' | 'menu' | 'palette';

export interface ActionContext {
  source: ActionSource;
  bridge: ParleyBridge;
  /**
   * useLayoutStore.getState() на момент действия. История и MRU — значения стора (2.2):
   * entries() и mru[activeWorkKey]; переходы — его действия back и forward.
   */
  layout: Pick<
    LayoutState,
    'activeWorkKey' | 'layouts' | 'mru' | 'entries' | 'apply' | 'setActiveWork' | 'back' | 'forward' | 'requestCloseTabs'
  >;
  /** Цикл ⌃Tab окна (keys/mru-cycle.ts, 6.1a): tab.mruNext/Prev — его шаг; фиксирует endMruCycle (6.1b). */
  mruCycle: MruCycle;
  /** Видимый порядок работ в момент действия: visibleWorkOrder(useSidebarSectionsStore.getState().sections). */
  sidebar: { order(): string[] };
  ui: {
    toggleSidebar(side: 'left' | 'right'): void;
    /** Правый сайдбар на этой вкладке; открытый не прячет. */
    showRightTab(tab: 'files' | 'changes'): void; // setSidebar('right', { open: true, tab })
    openNewWork(title?: string): void; // openNewWorkDialog(null, title)
    openNewSession(): void; // диалог 1.5 активной работы одним агентом (⌘T)
    openNewRoom(): void; // тот же диалог, открытый комнатой (два агента)
    openSettings(): void;
    setAppearance(mode: Appearance): void; // store/ui.ts: app.setAppearance, ui.json пишет main
    toggleShowArchived(): void;
    toggleWake(): Promise<void>; // useUiStore.getState().toggleWake(bridge)
    confirmRestartHost(): void; // dialogs.restartHost: ConfirmDialog строки статуса → app.restartHost()
  };
  /**
   * `open` и `mode` — сверх брифа: ⌘J при открытой палитре закрывает её, а из режима разделения
   * переключает в обычный (6.2) — без них ветка не отличила бы эти случаи.
   */
  palette: Pick<PaletteState, 'open' | 'mode' | 'openWith' | 'close'>;
  terminals: {
    /** Терминал, в поверхности которого фокус ввода. */
    focused(): TerminalSurfaceHandle | null;
    /** Терминал активной вкладки активной группы. */
    active(): TerminalSurfaceHandle | null;
  };
  attention: { next(): AttentionTarget | null }; // openNextAttention (4.2): сессия или комната с решением (кусок 5)
  /** useFilesStore.getState() (7.4): ⌘⇧F переводит «Файлы» в режим поиска. */
  files: Pick<FilesState, 'openSearch'>;
  /** Диктовка (спека 3.4): цель с фокусом или последняя, идёт запись — её стоп. */
  voice: { toggle(): void };
  toast(text: string): void;
  /** Как terminals.active() (6.3): активная вкладка активной группы активной работы, если это браузер с webContentsId. */
  browser: { active(): { tabId: string; webContentsId: number } | null };
}

const APPEARANCE: Partial<Record<ActionId, Appearance>> = {
  'appearance.system': 'system',
  'appearance.dark': 'dark',
  'appearance.light': 'light',
};

/** Раскладка активной работы; нет работы или её раскладка ещё не гидрирована — `null`. */
function activeLayout(ctx: ActionContext): { key: string; layout: WorkLayout } | null {
  const key = ctx.layout.activeWorkKey;
  const layout = key === null ? undefined : ctx.layout.layouts[key];
  return key === null || layout === undefined ? null : { key, layout };
}

/** Вкладка активной группы: соседняя по кругу или N-я. */
function focusTabInActiveGroup(
  ctx: ActionContext,
  key: string,
  layout: WorkLayout,
  pick: (tabs: readonly TabSpec[], activeIndex: number) => TabSpec | undefined,
): void {
  const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
  if (activeGroup === undefined || activeGroup.tabs.length === 0) return;
  const tab = pick(activeGroup.tabs, activeGroup.tabs.findIndex((candidate) => candidate.id === activeGroup.activeTabId));
  if (tab !== undefined) ctx.layout.apply(key, (l) => focusTab(l, tab.id));
}

function focusAdjacentGroup(ctx: ActionContext, key: string, layout: WorkLayout, delta: 1 | -1): void {
  const all = groups(layout);
  if (all.length === 0) return;
  const index = all.findIndex((group) => group.id === layout.activeGroupId);
  const target = all[(((index === -1 ? 0 : index + delta) % all.length) + all.length) % all.length];
  if (target !== undefined) ctx.layout.apply(key, (l) => focusGroup(l, target.id));
}

/**
 * Шаг цикла ⌃Tab по снимку MRU (2.4), а не сосед живого `mru`. Вкладку снимка могли закрыть
 * посреди цикла — она пропускается, а не глушит шаг; предел — размер снимка (MRU до 20 вкладок).
 */
function stepMru(ctx: ActionContext, key: string, layout: WorkLayout, step: 1 | -1): void {
  const mru = ctx.layout.mru[key] ?? [];
  let target = ctx.mruCycle.step(key, mru, step);
  for (let guard = 0; target !== null && findTab(layout, target) === null && guard < 20; guard += 1) {
    target = ctx.mruCycle.step(key, mru, step);
  }
  if (target !== null && findTab(layout, target) !== null) ctx.layout.apply(key, (l) => focusTab(l, target));
}

/** Отказ асинхронного действия — тостом по коду ошибки, без необработанного отказа промиса. */
function toastOnError(ctx: ActionContext, promise: Promise<unknown>, action: string): void {
  promise.catch((error: unknown) => {
    console.error('[parley] action failed', error);
    ctx.toast(errorText(decodeIpcError(error).code, action));
  });
}

const ZOOM_STEP: Partial<Record<ActionId, 1 | -1 | 0>> = {
  'browser.zoomIn': 1,
  'browser.zoomOut': -1,
  'browser.zoomReset': 0,
};

/** Действия, которым нужна активная работа (бриф 6.3): без неё — тост. Правого сайдбара без неё нет (7.2). */
function needsActiveWork(id: ActionId): boolean {
  return (
    id === 'session.new' ||
    id === 'room.new' ||
    id === 'sidebar.right.toggle' ||
    id === 'sidebar.files' ||
    id === 'sidebar.changes' ||
    id === 'files.quickOpen' ||
    id === 'files.search' ||
    id.startsWith('group.') ||
    id.startsWith('tab.')
  );
}

/** Одна ветка на каждый реализованный `ActionId`; действия будущих этапов — без ветки. */
export function runAction(id: ActionId, ctx: ActionContext): void {
  // Без активной работы — тост; активная есть, но её раскладка ещё читается с диска — ветки
  // вкладок и групп ниже просто ничего не делают.
  if (needsActiveWork(id) && ctx.layout.activeWorkKey === null) {
    ctx.toast(S.errors.noActiveWorkspace);
    return;
  }
  const active = activeLayout(ctx);

  const appearance = APPEARANCE[id];
  if (appearance !== undefined) {
    ctx.ui.setAppearance(appearance);
    return;
  }
  if (id.startsWith('work.goto.')) {
    const key = ctx.sidebar.order()[Number(id.slice('work.goto.'.length)) - 1];
    if (key !== undefined) ctx.layout.setActiveWork(key);
    return;
  }
  // ⌘F, ⌘+, ⌘−, ⌘0 из страницы (9.2b): вкладку делает активной browser:focus. Отказ — в консоль, без
  // тоста: вкладка могла закрыться между нажатием и ответом. Вкладки браузера нет — ничего.
  const zoom = ZOOM_STEP[id];
  if (zoom !== undefined || id === 'browser.find') {
    const page = ctx.browser.active();
    if (page === null) return;
    if (zoom === undefined) useBrowserStore.getState().update(page.tabId, { findOpen: true });
    else ctx.bridge.browser.zoom(page.webContentsId, zoom).catch((error: unknown) => console.warn('[parley] browser zoom', error));
    return;
  }
  if (id.startsWith('tab.goto.') && active !== null) {
    const n = Number(id.slice('tab.goto.'.length));
    focusTabInActiveGroup(ctx, active.key, active.layout, (tabs) => tabs[n - 1]);
    return;
  }

  switch (id) {
    case 'palette.open':
      // ⌘J при открытой палитре: обычная — закрыть, режим разделения или «+» — переключить в обычный.
      if (ctx.palette.open && ctx.palette.mode === 'default') ctx.palette.close();
      else ctx.palette.openWith('default');
      return;
    case 'work.new':
      ctx.ui.openNewWork();
      return;
    case 'session.new':
      ctx.ui.openNewSession();
      return;
    case 'room.new':
      ctx.ui.openNewRoom();
      return;
    case 'settings.open':
      ctx.ui.openSettings();
      return;
    case 'sidebar.left.toggle':
      ctx.ui.toggleSidebar('left');
      return;
    case 'sidebar.right.toggle':
      ctx.ui.toggleSidebar('right');
      return;
    case 'sidebar.files':
      ctx.ui.showRightTab('files');
      return;
    case 'sidebar.changes':
      ctx.ui.showRightTab('changes');
      return;
    // Корень ⌘P и поиска — корень «Файлов» активной работы (`filesRootSpec`): его берут палитра и панель.
    case 'files.quickOpen':
      ctx.palette.openWith('files');
      return;
    case 'files.search':
      ctx.ui.showRightTab('files');
      // null сюда не доходит (needsActiveWork выше), но TS этого не видит: проверка сужает тип
      // вместо `!`, который промолчал бы, если действие уберут из needsActiveWork (fix-lane-post, п. 5).
      if (ctx.layout.activeWorkKey !== null) ctx.files.openSearch(ctx.layout.activeWorkKey);
      return;
    case 'works.showArchived':
      ctx.ui.toggleShowArchived();
      return;
    case 'work.prev':
    case 'work.next': {
      const next = neighborInOrder(ctx.sidebar.order(), ctx.layout.activeWorkKey, id === 'work.next' ? 1 : -1);
      if (next !== null) ctx.layout.setActiveWork(next);
      return;
    }
    case 'history.back':
      ctx.layout.back();
      return;
    case 'history.forward':
      ctx.layout.forward();
      return;
    case 'attention.next':
      ctx.attention.next();
      return;
    case 'wake.toggle':
      toastOnError(ctx, ctx.ui.toggleWake(), S.errors.actions.toggleAutoWake);
      return;
    case 'host.restart':
      ctx.ui.confirmRestartHost();
      return;
    case 'find':
      (ctx.terminals.focused() ?? ctx.terminals.active())?.openSearch();
      return;
    case 'voice.toggle':
      ctx.voice.toggle();
      return;
    case 'terminal.clear':
      (ctx.source === 'palette' ? ctx.terminals.active() : ctx.terminals.focused())?.clear();
      return;
    case 'browser.newTab':
      // Без активной работы тост даёт сам openBrowserTab — как у действий 6.3.
      openBrowserTab('', {
        apply: ctx.layout.apply,
        layouts: ctx.layout.layouts,
        activeWorkKey: ctx.layout.activeWorkKey,
        toast: ctx.toast,
      });
      return;
    default:
      break;
  }

  if (active === null) return;
  const { key, layout } = active;
  switch (id) {
    // Содержимое новой группы выбирает палитра в режиме разделения (спека 9.5).
    case 'group.splitRight':
      ctx.palette.openWith('splitRight');
      return;
    case 'group.splitDown':
      ctx.palette.openWith('splitDown');
      return;
    case 'group.prev':
      focusAdjacentGroup(ctx, key, layout, -1);
      return;
    case 'group.next':
      focusAdjacentGroup(ctx, key, layout, 1);
      return;
    case 'tab.close': {
      const activeTabId = groups(layout).find((group) => group.id === layout.activeGroupId)?.activeTabId ?? null;
      // С 7.3 requestCloseTabs спросит про несохранённый файл.
      if (activeTabId !== null) toastOnError(ctx, ctx.layout.requestCloseTabs(key, [activeTabId]), S.errors.actions.closeTab);
      return;
    }
    case 'tab.reopen':
      // ⌘⇧T предел вкладок браузера не обходит (спека 12.4).
      if (layout.closedTabs[0]?.kind === 'browser' && browserTabCount(layout) >= BROWSER_LIMITS.tabsPerWork) {
        ctx.toast(S.browser.tooManyTabs);
        return;
      }
      // Вернул человек — адресная строка пустой вкладки снова берёт фокус (перенос 9.2a).
      if (layout.closedTabs[0]?.kind === 'browser') requestAddressFocus(layout.closedTabs[0].id);
      ctx.layout.apply(key, reopenClosed);
      return;
    case 'tab.prev':
    case 'tab.next': {
      const step = id === 'tab.next' ? 1 : -1;
      focusTabInActiveGroup(ctx, key, layout, (tabs, index) => tabs[(((index + step) % tabs.length) + tabs.length) % tabs.length]);
      return;
    }
    case 'tab.mruNext':
      stepMru(ctx, key, layout, 1);
      return;
    case 'tab.mruPrev':
      stepMru(ctx, key, layout, -1);
      return;
    case 'chat.toggleView':
      toggleChatView(ctx, key, layout);
      return;
    default:
      return;
  }
}

/**
 * «Toggle chat / terminal» (план 2026-10-01, решение 6): то же, что сегмент тулбара, для активной
 * вкладки активной группы. Не вкладка сессии — ничего; вид «Chat» сессии недоступен — тост с подсказкой
 * выключенного сегмента.
 */
function toggleChatView(ctx: ActionContext, key: string, layout: WorkLayout): void {
  const group = groups(layout).find((candidate) => candidate.id === layout.activeGroupId);
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId);
  if (tab?.kind !== 'terminal') return;
  const entry = useWorksStore.getState().entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === key);
  const session = entry?.map.sessions.find((candidate) => candidate.id === tab.sessionId);
  if (session === undefined) return;
  const available = feedAvailableNow(session.provider);
  if (!available) {
    ctx.toast(S.chat.terminalOnly);
    return;
  }
  const ref = { projectPath: entry?.projectPath ?? '', workId: entry?.map.work.id ?? '', sessionId: tab.sessionId };
  const { byRef, loaded } = useActivityStore.getState();
  const started = sessionStartedOrUnknown(loaded, activityFor(byRef, ref));
  const view = effectiveView(tab, available, started) === 'chat' ? 'terminal' : 'chat';
  ctx.layout.apply(key, (l) => updateTab(l, tab.id, { view }));
}
