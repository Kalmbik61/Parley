/**
 * Переход по клику на уведомление (кусок 4.3, спека 7.4): работа становится активной, вкладка
 * открывается или получает фокус; когда вкладка показана — вспышка, а у терминала прокрутка
 * вниз и фокус ввода. Только переход: ни ввода в терминал, ни ответов агенту от имени человека.
 */

import type { WorkEntry } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { FocusTarget } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { terminalSurfaces, type TerminalSurfaceHandle } from '../terminal/surface-registry.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { flashTab } from './flash.js';

/** Сколько ждём вкладку и поверхность (план, «Числа»). */
const SHOWN_TIMEOUT_MS = 2000;
/**
 * Опрос в дополнение к подпискам: реестр поверхностей и DOM вкладки — не сторы, а вкладка
 * попадает в DOM коммитом React уже после записи в стор.
 */
const SHOWN_POLL_MS = 50;

export interface FocusTargetDeps {
  works: readonly WorkEntry[];
  setActiveWork(workKey: string): void;
  openTab(workKey: string, tab: TabSpec): void; // apply(workKey, l => openTab(l, tab)); до hydrate — очередь (2.2)
  /**
   * true, когда вкладка — активная в своей группе отрисованной раскладки активной работы, а у терминала
   * поверхность видима (visibleSessionRefs: inert уже снят) и есть в terminalSurfaces. Подписка на сторы,
   * не дольше 2 с; не дождалась — false.
   */
  whenShown(workKey: string, tab: TabSpec): Promise<boolean>;
  surface(ref: SessionRef): TerminalSurfaceHandle | undefined; // terminalSurfaces.get(refKey(ref))
  flash(workKey: string, tabId: string): void;
}

/** Вкладка цели; null — работы, сессии или комнаты уже нет. */
function targetTab(target: FocusTarget, works: readonly WorkEntry[]): { workKey: string; tab: TabSpec } | null {
  const projectPath = target.kind === 'session' ? target.ref.projectPath : target.projectPath;
  const workId = target.kind === 'session' ? target.ref.workId : target.workId;
  const entry = works.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
  if (entry === undefined) return null;
  const key = workKeyOf(projectPath, workId);
  switch (target.kind) {
    case 'session': {
      const { sessionId } = target.ref;
      if (!entry.map.sessions.some((session) => session.id === sessionId)) return null;
      return { workKey: key, tab: { kind: 'terminal', id: tabId.terminal(sessionId), sessionId } };
    }
    case 'mail':
      return { workKey: key, tab: { kind: 'mail', id: tabId.mail() } };
    case 'room':
      if (!entry.map.rooms.some((room) => room.id === target.roomId)) return null;
      return { workKey: key, tab: { kind: 'room', id: tabId.room(target.roomId), roomId: target.roomId } };
  }
}

/** Сразу — setActiveWork и openTab; после whenShown — flash, у терминала scrollToBottom и focus. false — цели больше нет. */
export function applyFocusTarget(target: FocusTarget, deps: FocusTargetDeps): boolean {
  const found = targetTab(target, deps.works);
  if (found === null) return false;
  const { workKey, tab } = found;
  deps.setActiveWork(workKey);
  // Работа ещё не показывалась — операция ждёт её `hydrate` в очереди (2.2).
  deps.openTab(workKey, tab);
  // Вспышка и фокус раньше, чем вкладка показана, бесполезны: работа могла быть вне LRU
  // (поверхностей нет), раскладка — не гидрирована, контейнер до коммита React — `inert`.
  void deps.whenShown(workKey, tab).then((shown) => {
    if (!shown) return;
    deps.flash(workKey, tab.id);
    if (target.kind !== 'session') return;
    const surface = deps.surface(target.ref);
    surface?.scrollToBottom();
    surface?.focus();
  });
  return true;
}

function tabElement(workKey: string, id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="tab"][data-work-key][data-tab-id]')].find(
    (element) => element.dataset.workKey === workKey && element.dataset.tabId === id,
  );
}

/** Условие `whenShown` по сторам, реестру поверхностей и DOM. */
function isShown(workKey: string, tab: TabSpec): boolean {
  const layoutState = useLayoutStore.getState();
  const layout = layoutState.layouts[workKey];
  if (layoutState.activeWorkKey !== workKey || layout === undefined) return false;
  if (!groups(layout).some((group) => group.activeTabId === tab.id)) return false;
  // Вкладка отрисована в контейнере, который уже не `inert`.
  const element = tabElement(workKey, tab.id);
  if (element === undefined || element.closest('[inert]') !== null) return false;
  if (tab.kind !== 'terminal') return true;
  const entry = useWorksStore.getState().entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey);
  if (entry === undefined) return false;
  const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId });
  return useUiStore.getState().visibleSessionRefs[key] === true && terminalSurfaces.has(key);
}

/**
 * `whenShown` для App: подписка на сторы раскладки и окна плюс опрос, не дольше 2 с.
 * `signal` — отмена при размонтировании App: иначе опрос DOM переживал окно (в тестах — среду
 * jsdom: «document is not defined» из таймера после конца файла).
 */
export function whenShown(workKey: string, tab: TabSpec, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (shown: boolean): void => {
      if (done) return;
      done = true;
      offLayout();
      offUi();
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve(shown);
    };
    const onAbort = (): void => finish(false);
    const check = (): void => {
      if (isShown(workKey, tab)) finish(true);
    };
    const offLayout = useLayoutStore.subscribe(check);
    const offUi = useUiStore.subscribe(check);
    const poll = setInterval(check, SHOWN_POLL_MS);
    const timeout = setTimeout(() => finish(false), SHOWN_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);
    check();
  });
}

/**
 * Зависимости перехода из сторов окна — одна сборка на клик по уведомлению (`App.tsx`) и на
 * «Open S02» тоста отправки (`TerminalSurface.tsx`): поле, добавленное в `FocusTargetDeps`,
 * меняется здесь, а не в двух литералах. `works` — снимок на момент вызова. `signal` — отмена
 * ожидания показа (`whenShown`): App снимает её при размонтировании.
 */
export function buildFocusTargetDeps(signal?: AbortSignal): FocusTargetDeps {
  return {
    works: useWorksStore.getState().entries,
    setActiveWork: (key) => useLayoutStore.getState().setActiveWork(key),
    openTab: (key, tab) => {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
    },
    whenShown: (key, tab) => whenShown(key, tab, signal),
    surface: (ref) => terminalSurfaces.get(refKey(ref)),
    flash: (key, id) => flashTab(key, id),
  };
}
