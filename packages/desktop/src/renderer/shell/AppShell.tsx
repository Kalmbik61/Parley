/**
 * Оболочка окна (куски 2.3–2.7, спека 4.4, 5.1, 5.3, 5.6, 5.9, 5.10):
 * заголовок, сайдбар работ, центр и строка статуса. Центр — раскладка
 * активной работы (`LayoutView`); с куска 2.7 он единственный: прежний центр и
 * его флаг ушли.
 *
 * Палитра ⌘J (`palette/Palette.tsx`, кусок 6.2), `NewWorkComposer` и `CreateRoomDialog`
 * монтируются здесь же (а не в сайдбаре) — они нужны и над `Landing`, где
 * сайдбара вовсе нет. На историю переходов оболочка не подписана: её читает сама
 * открытая палитра.
 *
 * `AppShell` — единственная точка действий реестра клавиш (`run(id)`, кусок 6.1b,
 * спека 9.6): её зовут обработчик окна (`keys/handler.ts`) и клик по пункту меню
 * (`menu:action`), а строки действий палитры — через тот же `run`. Там же входы
 * сайдбара: они идут в `layout/store.ts` раскладки активной работы. Сессия,
 * почта или комната могут принадлежать не активной сейчас работе — сначала
 * `setActiveWork`, потом `apply` в её раскладке.
 *
 * Кусок 2.5 (спека 5.5): центр — контейнеры трёх последних активных
 * работ (LRU). Контейнер — `position: absolute; inset: 0`, в нём `LayoutView`
 * работы и следом её `SurfaceLayer`; контейнер — containing block поверхностей,
 * а тела групп — его потомки, поэтому `anchor()` действительны. Неактивные
 * контейнеры скрыты (`visibility: hidden`, `inert`), но смонтированы — терминалы
 * живы.
 *
 * Кусок 3.3 (спека 6.1–6.4): слева — сайдбар карточек `WorkSidebar`. Секции и
 * внимание для него (и для ⌘1–9, строки статуса в 3.4) считает `SidebarSectionsWriter`,
 * смонтированный здесь, а не в сайдбаре: ⌘B прячет сайдбар, а порядок должен жить. Прежний
 * сайдбар и его флаг сравнения ушли в 3.5.
 *
 * Кусок 7.2 (спека 5.1, 10.1): справа — `RightSidebar` активной работы; файл из его дерева,
 * брошенный на терминал, уходит агенту путём через `sendWithToast`, в раскладку — вкладкой.
 *
 * Кусок 2.6 (спека 5.4): один `DndContext` на всё окно — строка сессии живёт
 * в сайдбаре, строка вкладок одной группы — в заголовке, зоны броска — в
 * центре, а `useDraggable` вне провайдера молча не тащит. `PointerSensor` — с
 * порогом 4 px: без него @dnd-kit начинает перетаскивание уже на
 * `pointerdown` и глушит следующий `click`, и строка сессии перестала бы
 * открываться по клику, а крестик — закрывать вкладку.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import type { WorkSession } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';
import type { ActionId } from '../../shared/keybindings.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, noticeText, S } from '../../shared/strings.js';
import { fitRightSidebar, LEFT_SIDEBAR } from '../../shared/ui-types.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { openNextAttention } from '../attention/next.js';
import { useAttentionTotals } from '../attention/store.js';
import { InterruptedBanner } from '../components/InterruptedBanner.js';
import { CreateRoomDialog, type RoomCandidate } from '../components/rooms/CreateRoomDialog.js';
import { visibleWorkOrder } from '../sidebar/sort.js';
import { SidebarSectionsWriter, useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { NewWorkComposer } from '../sidebar/NewWorkComposer.js';
import { WorkSidebar } from '../sidebar/WorkSidebar.js';
import { sessionLabelFor, sessionRowLabel } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { bufferKey, isBufferDirty } from '../files/buffer.js';
import { createCloseGuard } from '../files/close-guard.js';
import { askSaveChanges, WindowCloseQuestion } from '../files/SaveChangesDialog.js';
import { absPathOf, bindBuffersToLayouts, bufferName, useFilesStore } from '../files/store.js';
import { acceptsTerminal, applyDrop, centerOverlayOnCursor, dragItemOf, dropFromDragEnd, layoutCollision, type DragItem } from '../layout/dnd.js';
import { setDropPreview } from '../layout/DropIndicator.js';
import { tabId } from '../layout/ids.js';
import { tabMeta } from '../layout/tab-meta.js';
import { LayoutView } from '../layout/LayoutView.js';
import { createLru, type Lru } from '../layout/lru.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { measureGroupSizes } from '../layout/measure.js';
import { findTab, focusTab, groups, openTab } from '../layout/tree.js';
import { openBrowserTabFrom, useBrowserStore } from '../browser/store.js';
import { focusContext } from '../keys/focus-context.js';
import { installKeyHandler, isActionAvailable } from '../keys/handler.js';
import { createMruCycle, type MruCycle } from '../keys/mru-cycle.js';
import { hostMethods, useHostSupports } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { runAction, type ActionContext, type ActionSource } from '../palette/actions.js';
import { Palette } from '../palette/Palette.js';
import { usePaletteStore } from '../palette/store.js';
import { pathsToInput } from '../terminal/drop.js';
import { sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { terminalSurfaces } from '../terminal/surface-registry.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { orderedWorks, useWorksStore } from '../store/works.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Landing } from './Landing.js';
import { Resizer } from './Resizer.js';
import { RightSidebar, rightSidebarHasRoom, useWindowWidth } from './RightSidebar.js';
import { StatusBar } from './StatusBar.js';
import { Titlebar } from './Titlebar.js';

/**
 * Ярлык предмета в `DragOverlay`: заголовок вкладки или строка сессии активной
 * работы — тот же текст, что человек видел под курсором.
 */
function dragLabel(item: DragItem, key: string | null): string {
  // Имя файла, а не путь: путь из глубины дерева не влез бы в ярлык.
  if (item.kind === 'file') return item.path.slice(item.path.lastIndexOf('/') + 1);
  const entry = useWorksStore.getState().entries.find((candidate) => workKey(candidate.projectPath, candidate.map.work.id) === key);
  if (item.kind === 'session') {
    const session = entry?.map.sessions.find((candidate) => candidate.id === item.sessionId);
    return sessionRowLabel(item.sessionId, session?.label ?? '');
  }
  const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
  const tab = layout === undefined ? undefined : groups(layout).flatMap((group) => group.tabs).find((candidate) => candidate.id === item.tabId);
  return tab === undefined ? item.tabId : tabMeta(tab, entry ?? null).title;
}

/** Сессия из снимка работ — для «Resume» тоста отправки; null — её уже нет. */
function sessionOf(ref: SessionRef): WorkSession | null {
  const entry = useWorksStore
    .getState()
    .entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
  return entry?.map.sessions.find((item) => item.id === ref.sessionId) ?? null;
}

/** «Open S02» тоста отправки: тот же переход, что клик по уведомлению (4.3), как у броска из Finder (5.4). */
function openSessionTab(ref: SessionRef): void {
  const applied = applyFocusTarget({ kind: 'session', ref }, buildFocusTargetDeps());
  if (!applied) toast(S.notifications.targetGone);
}

/** Доступность — одна для нажатия и для `menu:action` (кусок 6.1b): методы хоста в момент действия. */
function available(id: ActionId): boolean {
  return isActionAvailable(id, hostMethods(useHostStore.getState().status));
}

/** Вкладка браузера по id гостя (`webContentsId` из `dom-ready`, 9.2a); нет — null. */
function browserTabOf(webContentsId: number): string | null {
  const found = Object.entries(useBrowserStore.getState().tabs).find(([, state]) => state.webContentsId === webContentsId);
  return found === undefined ? null : found[0];
}

/** Слои поверхностей живут у трёх последних работ (план, «Числа»). */
const SURFACE_WORKS = 3;

/** Модификаторы оверлея — одна ссылка на всё время жизни окна. */
const OVERLAY_MODIFIERS = [centerOverlayOnCursor];

interface WorkContainerProps {
  workKey: string;
  active: boolean;
  bridge: HarnasBridge;
  fontFamily: string;
  fontSize: number;
  sendDeps: SendWithToastDeps; // карточке Design Mode через слой поверхностей (9.3b)
}

/**
 * Контейнер одной работы LRU (кусок 2.5). Пока раскладки работы нет в
 * `layouts` (до `hydrate` после `setActiveWork`), контейнер пуст: ни
 * `LayoutView`, ни `SurfaceLayer`.
 *
 * `memo` (раунд исправлений 1 куска 2.6, ревью A): пропы — ключ, флаг, мост и
 * шрифт, стабильны; начало и конец перетаскивания (`dragging` в `AppShell`)
 * иначе перерисовывали бы все тела групп и поверхности трёх работ.
 */
const WorkContainer = memo(function WorkContainer({ workKey, active, bridge, fontFamily, fontSize, sendDeps }: WorkContainerProps): JSX.Element {
  const hasLayout = useLayoutStore((state) => state.layouts[workKey] !== undefined);
  const ref = useRef<HTMLDivElement>(null);
  // `inert` в React 18 — не булев проп, ставится руками.
  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !active);
  }, [active]);
  return (
    <div
      ref={ref}
      data-work-container={workKey}
      className="absolute inset-0 flex"
      style={active ? undefined : { visibility: 'hidden' }}
    >
      {hasLayout ? (
        <>
          <LayoutView workKey={workKey} active={active} bridge={bridge} fontFamily={fontFamily} fontSize={fontSize} />
          <SurfaceLayer workKey={workKey} active={active} bridge={bridge} fontFamily={fontFamily} fontSize={fontSize} sendDeps={sendDeps} />
        </>
      ) : null}
    </div>
  );
});

/**
 * Сторож раскладок (`layout/persistence.ts`) отдельным ребёнком оболочки (кусок 3.4): ему
 * нужен видимый порядок сайдбара, а тот меняется на каждую пересортировку по вниманию —
 * подписка в теле `AppShell` перерисовывала бы всю оболочку (раунд исправлений 1 куска 3.3).
 *
 * `visibleOrder` — только если секции посчитаны по этому же снимку (их пишет layout-эффект
 * `SidebarSectionsWriter`, он отстаёт на рендер) и `ui.json` загружен; иначе `null`, и
 * persistence ждёт: по устаревшему порядку сосед выбрался бы среди пропавших работ.
 * Подписка — на массив ключей с поверхностным сравнением.
 */
const LayoutPersistence = memo(function LayoutPersistence({ bridge }: { bridge: HarnasBridge }): null {
  const entries = useWorksStore((state) => state.entries);
  const worksLoaded = useWorksStore((state) => !state.loading);
  const uiLoaded = useUiStore((state) => state.uiLoaded);
  const visibleOrder = useSidebarSectionsStore(
    useShallow((state) => (uiLoaded && state.entries === entries ? visibleWorkOrder(state.sections) : null)),
  );
  // Состав снимка — все работы, с архивными и скрытыми; порядок создания — только для
  // устойчивости списка `retainLayouts`.
  const order = orderedWorks(entries).map((entry) => workKey(entry.projectPath, entry.map.work.id));
  useLayoutPersistence({ bridge, works: entries, worksLoaded, order, visibleOrder });
  return null;
});

export interface AppShellProps {
  bridge: HarnasBridge;
  /** Строка статуса; `App` рендерит `AppShell` только при `'connected'`. */
  status: HostStatus;
  /** Из `settings.get` в `App`, до ответа — запасные; идут в центр. */
  fontFamily: string;
  fontSize: number;
}

export function AppShell({ bridge, status, fontFamily, fontSize }: AppShellProps): JSX.Element {
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);

  // LRU контейнеров работ (кусок 2.5). Касание — прямо в рендере: контейнер
  // новой активной работы должен появиться в том же кадре, что и смена
  // `activeWorkKey`, а повторное касание того же ключа безвредно.
  const lruRef = useRef<Lru<string> | null>(null);
  if (lruRef.current === null) lruRef.current = createLru<string>(SURFACE_WORKS);
  const lru = lruRef.current;
  const touchedRef = useRef<string | null>(null);
  if (activeWorkKey !== null && touchedRef.current !== activeWorkKey) {
    lru.touch(activeWorkKey);
    touchedRef.current = activeWorkKey;
  }
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // `drop` (работа пропала из снимка) убирает работу и из LRU — её контейнер
  // размонтируется, xterm освобождаются. Раскладка исчезает из `layouts`
  // только в `drop`.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, prev) => {
        let changed = false;
        for (const key of Object.keys(prev.layouts)) {
          if (key in state.layouts || !lru.has(key)) continue;
          lru.remove(key);
          if (touchedRef.current === key) touchedRef.current = null;
          changed = true;
        }
        if (changed) rerender();
      }),
    [lru],
  );

  const entries = useWorksStore((state) => state.entries);
  const loading = useWorksStore((state) => state.loading);
  const worksLoaded = !loading;
  // «Работ нет» — это ответ хоста, а не просто пустой начальный снимок:
  // до первого `works.list` показывать `Landing` рано (спека 5.10, «после загрузки»).
  const showLanding = worksLoaded && entries.length === 0;


  const ui = useUiStore((state) => state.ui);
  // Правый сайдбар не оставляет центру меньше reserveCenter; не влезает — скрыт на время (раунд main-r2).
  const rightFit = fitRightSidebar(ui.rightSidebar.width, useWindowWidth(), ui.leftSidebar.open ? ui.leftSidebar.width : 0);
  const setSidebar = useUiStore((state) => state.setSidebar);
  const newWork = useUiStore((state) => state.dialogs.newWork);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const closeNewWorkDialog = useUiStore((state) => state.closeNewWorkDialog);
  const createRoom = useUiStore((state) => state.dialogs.createRoom);
  const closeCreateRoomDialog = useUiStore((state) => state.closeCreateRoomDialog);
  const restartHostOpen = useUiStore((state) => state.dialogs.restartHost);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const toggleWake = useUiStore((state) => state.toggleWake);
  const notices = useNoticesStore((state) => state.notices);
  // Раунд исправлений 1 куска E.1: `notice.text` хоста — русский свободный
  // текст (сквозное правило его не переводит), строка статуса показывает
  // `noticeText` по виду уведомления вместо него; сырой текст — только в
  // консоли (`store/notices.ts`).
  // Итоги внимания для строки статуса (кусок 4.2): селектор по стору секций с поверхностным
  // сравнением — оболочка перерисовывается, только когда меняются сами числа.
  const attention = useAttentionTotals();
  const lastNotice = notices[0] ?? null;
  const noticeLine = lastNotice === null ? '' : noticeText(lastNotice, sessionLabelFor(entries, lastNotice.ref));

  const leftSidebarRef = useRef<HTMLDivElement>(null);

  // Перетаскивание (кусок 2.6). `dragging` — ярлык в `DragOverlay`. Где сейчас
  // бросок, индикаторам сообщает `setDropPreview` — не состояние `AppShell`:
  // иначе каждая смена зоны перерисовывала бы всё окно (раунд исправлений 1).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Зона терминала для файла — только у хоста с `pty.send` (кусок 7.2, как бросок из Finder в
  // 5.4): старый хост ответил бы `unknown_method`, а без зоны файл падает в тело вкладкой.
  const canSend = useHostSupports('pty.send');
  // Один объект на мост: он уходит пропом в `memo`-контейнеры работ (9.3b), новый литерал на рендер их перерисовывал бы.
  const sendDeps: SendWithToastDeps = useMemo(() => ({ bridge, session: sessionOf, openSession: openSessionTab }), [bridge]);
  const [dragging, setDragging] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent): void => {
    const item = dragItemOf(event.active.data.current);
    setDragging(item === null ? null : dragLabel(item, useLayoutStore.getState().activeWorkKey));
  };

  const handleDragMove = (event: DragMoveEvent): void => {
    const zone = dropFromDragEnd(event)?.zone ?? null;
    setDropPreview(useLayoutStore.getState().activeWorkKey, zone);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    setDragging(null);
    setDropPreview(null, null);
    const drop = dropFromDragEnd(event);
    const key = useLayoutStore.getState().activeWorkKey;
    if (drop === null || key === null) return;
    // Зона чужой работы сюда не доходит (`layoutCollision`), но раскладку
    // меняем только у той работы, чья зона под указателем.
    const owner = (event.over?.data.current as { workKey?: unknown } | undefined)?.workKey;
    if (owner !== key) return;
    const { item, zone } = drop;
    if (zone.kind === 'terminal') {
      // Раскладка не меняется: абсолютный путь — агенту в поле ввода, без Enter, с тостом по
      // таблице 8.6 (`sendWithToast`); мимо `pty.send` в PTY ничего не пишется.
      if (item.kind !== 'file') return;
      const entry = useWorksStore.getState().entries.find((candidate) => workKey(candidate.projectPath, candidate.map.work.id) === key);
      const abs = entry === undefined ? null : absPathOf(entry, item.root.spec, item.path);
      if (entry === undefined || abs === null) return;
      const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: zone.sessionId };
      void sendWithToast(sendDeps, ref, pathsToInput([abs]), false);
      return;
    }
    const error = useLayoutStore.getState().apply(key, (layout) => applyDrop(layout, item, zone, measureGroupSizes()));
    if (error === 'too-many-groups') toast(S.tabs.tooManyGroups);
    else if (error === 'too-small') toast(S.tabs.tooSmall);
  };

  const handleDragCancel = (): void => {
    setDragging(null);
    setDropPreview(null, null);
  };

  // ⌘F и ⌘K: поверхность активной вкладки активной группы активной работы — сами
  // поверхности на действия не подписаны (их смонтировано много, и полоса открылась бы во
  // всех, включая скрытые). Клик и фокус в терминале делают его группу активной (2.5).
  const activeTerminalSurface = () => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return undefined;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const tab = activeGroup?.tabs.find((candidate) => candidate.id === activeGroup.activeTabId);
    if (tab?.kind !== 'terminal') return undefined;
    const entry = useWorksStore.getState().entries.find((item) => workKey(item.projectPath, item.map.work.id) === key);
    if (entry === undefined) return undefined;
    return terminalSurfaces.get(refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId }));
  };

  /** Страница активной вкладки активной группы активной работы — цель ⌘F, ⌘+, ⌘−, ⌘0 из страницы (9.2b). */
  const activeBrowserPage = (): { tabId: string; webContentsId: number } | null => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (layout === undefined) return null;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const tab = activeGroup?.tabs.find((candidate) => candidate.id === activeGroup.activeTabId);
    if (tab?.kind !== 'browser') return null;
    const webContentsId = useBrowserStore.getState().tabs[tab.id]?.webContentsId ?? null;
    return webContentsId === null ? null : { tabId: tab.id, webContentsId };
  };

  /**
   * Поверхность с фокусом ввода в xterm. `terminal.clear` по клавише и по пункту меню — только
   * сюда: гарантия «⌘K в сайдбаре не чистит терминал» не держится на одном `triggeredByAccelerator`
   * main, на macOS живьём не проверенном (раунд fix-main-r1). Фокуса в терминале нет — ничего.
   */
  const focusedTerminalSurface = () => [...terminalSurfaces.values()].find((surface) => surface.hasFocus());

  // Цикл ⌃Tab (6.1a) — один на окно: клавиши больше не висят в `LayoutView` трёх работ LRU.
  const mruCycleRef = useRef<MruCycle | null>(null);
  if (mruCycleRef.current === null) mruCycleRef.current = createMruCycle();
  const mruCycle = mruCycleRef.current;

  // Отпускание ⌃ или потеря фокуса окна — итог цикла в `mru` стора (`setState`, как в 2.4).
  // Снимок старше живого списка: вкладку, закрытую посреди цикла, он ещё помнит. Снятую
  // закрыли — итога нет, живой список уже верен; прочие закрытые из итога выпадают, а
  // открытые посреди цикла остаются следом.
  const endMruCycle = (): void => {
    const state = useLayoutStore.getState();
    const done = mruCycle.commit(state.activeWorkKey);
    if (done === null) return;
    const live = state.mru[done.workKey] ?? [];
    const target = done.mru[0];
    if (target === undefined || !live.includes(target)) return;
    const kept = done.mru.filter((id) => live.includes(id));
    const fresh = live.filter((id) => !kept.includes(id));
    useLayoutStore.setState((current) => ({ mru: { ...current.mru, [done.workKey]: [...kept, ...fresh] } }));
  };

  /**
   * Контекст действия на момент вызова (кусок 6.3): сторы читаются здесь, а не подпиской
   * оболочки — она на историю, MRU и порядок сайдбара не подписана (решение по куску 3.3).
   */
  const actionContext = (source: ActionSource): ActionContext => ({
    source,
    bridge,
    layout: useLayoutStore.getState(),
    mruCycle,
    sidebar: { order: () => visibleWorkOrder(useSidebarSectionsStore.getState().sections) },
    ui: {
      toggleSidebar: (side) => {
        const current = useUiStore.getState().ui;
        // Правому нет места рядом с центром — тост, а не переключение невидимого сайдбара.
        if (side === 'right' && !rightSidebarHasRoom()) {
          toast(S.errors.noRoomForRightSidebar);
          return;
        }
        setSidebar(side, { open: !(side === 'left' ? current.leftSidebar : current.rightSidebar).open });
      },
      showRightTab: (tab) => {
        if (!rightSidebarHasRoom()) {
          toast(S.errors.noRoomForRightSidebar);
          return;
        }
        setSidebar('right', { open: true, tab });
      },
      openNewWork: (title) => openNewWorkDialog(null, title),
      openNewSession: () => {
        // Родитель — выбранная сессия, как у ⌘T в `App.tsx`.
        const selected = selectedSessionOf(useLayoutStore.getState(), useWorksStore.getState().entries);
        useUiStore.getState().openNewSessionDialog(selected?.ref.sessionId ?? null);
      },
      openNewRoom: () => {
        // Как «New room» меню карточки (3.4): активная работа, обязательного участника нет.
        const key = useLayoutStore.getState().activeWorkKey;
        const entry = useWorksStore.getState().entries.find((item) => workKey(item.projectPath, item.map.work.id) === key);
        if (entry !== undefined) {
          useUiStore.getState().openCreateRoomDialog({ projectPath: entry.projectPath, workId: entry.map.work.id, requiredMember: null });
        }
      },
      openSettings: () => useUiStore.getState().openSettingsDialog(),
      setAppearance: (mode) => useUiStore.getState().setAppearance(mode),
      toggleShowArchived: () => useUiStore.getState().toggleShowArchived(),
      toggleWake: () => useUiStore.getState().toggleWake(bridge),
      confirmRestartHost: () => useUiStore.getState().confirmRestartHost(),
    },
    palette: usePaletteStore.getState(),
    terminals: {
      focused: () => focusedTerminalSurface() ?? null,
      active: () => activeTerminalSurface() ?? null,
    },
    attention: { next: openNextAttention },
    toast: (text) => toast(text),
    browser: { active: activeBrowserPage },
  });

  /**
   * Одна точка действий реестра (кусок 6.1b): нажатие окна, клик пункта меню и строка действия
   * палитры. Ветки — `runAction` (6.3); `source` решает цель `terminal.clear`.
   */
  const run = (id: ActionId, source: ActionSource): void => runAction(id, actionContext(source));
  const runRef = useRef(run);
  runRef.current = run;
  // Одна ссылка на всё время жизни: палитра пересобирает документы по своим подпискам, а не на
  // каждую отрисовку оболочки.
  const stableRun = useRef((id: ActionId): void => runRef.current(id, 'palette')).current;
  const endMruCycleRef = useRef(endMruCycle);
  endMruCycleRef.current = endMruCycle;

  useEffect(
    () =>
      installKeyHandler({
        run: (id) => runRef.current(id, 'key'),
        pickPaletteRow: (index) => usePaletteStore.getState().pickRow(index),
        context: () => focusContext(document.activeElement),
        paletteOpen: () => usePaletteStore.getState().open,
        available,
        endMruCycle: () => endMruCycleRef.current(),
      }),
    [],
  );

  // Буферы файлов (кусок 7.3a): живут, пока вкладка есть в раскладке; закрытие вкладки с правками
  // спрашивает «Save changes to …?». Вопрос закрытия окна и ⌘Q — `WindowCloseQuestion` ниже.
  useEffect(() => {
    const unbind = bindBuffersToLayouts(bridge);
    useLayoutStore.getState().setCloseGuard(
      createCloseGuard({
        isDirty: (key, tab) => {
          const buffer = useFilesStore.getState().buffers[bufferKey(key, tab)];
          return buffer !== undefined && isBufferDirty(buffer.model);
        },
        ask: (key, tab) => askSaveChanges('tab', [bufferName(bufferKey(key, tab))]),
        save: async (key, tab) => (await useFilesStore.getState().save(bridge, key, tab)) === 'saved',
      }),
    );
    return () => {
      unbind();
      useLayoutStore.getState().setCloseGuard(null);
    };
  }, [bridge]);

  // Клик мышью по пункту меню; клик сочетанием main не шлёт (`main/menu.ts`).
  useEffect(
    () =>
      bridge.app.onMenu((id) => {
        if (available(id)) runRef.current(id, 'menu');
      }),
    [bridge],
  );

  // Клик в страницу DOM окна не видит (9.2b, спека 7.2): группу делает активной фокус гостя из main.
  // Только вкладке активной работы, которая видна в своей группе: скрытую вкладку человек кликнуть
  // не мог, а вкладку скрытой работы LRU событие не трогает.
  useEffect(
    () =>
      bridge.browser.onFocus(({ webContentsId }) => {
        const id = browserTabOf(webContentsId);
        const state = useLayoutStore.getState();
        const key = state.activeWorkKey;
        const layout = key === null ? undefined : state.layouts[key];
        const found = id === null || layout === undefined ? null : findTab(layout, id);
        if (key === null || id === null || found === null || found.group.activeTabId !== id) return;
        if (layout?.activeGroupId === found.group.id) return;
        state.apply(key, (l) => focusTab(l, id));
      }),
    [bridge],
  );

  // window.open страницы (9.2b, спека 12.2): вкладка — рядом с открывателем, в его работе и группе.
  useEffect(
    () =>
      bridge.browser.onOpenTab((event) => {
        const state = useLayoutStore.getState();
        openBrowserTabFrom(event, {
          apply: state.apply,
          layouts: state.layouts,
          activeWorkKey: state.activeWorkKey,
          tabIdOf: browserTabOf,
          toast: (text) => toast(text),
        });
      }),
    [bridge],
  );

  // Открывающие действия сайдбара: сессия/почта/комната могут
  // принадлежать НЕ активной сейчас работе (у каждой работы своя раскладка) —
  // сначала переключить работу, потом открыть вкладку в НЕЙ.
  const openTabInWork = (key: string, tab: TabSpec): void => {
    useLayoutStore.getState().setActiveWork(key);
    useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
  };

  // Кандидаты «Создать комнату с…» — остальные сессии той же работы, кроме
  // обязательного участника (сессии, с которой открыли пункт меню в сайдбаре).
  // «New room» из меню карточки (кусок 3.4) обязательного не знает — кандидаты все.
  const requiredMemberId = createRoom?.requiredMember?.id ?? null;
  const roomCandidates: RoomCandidate[] =
    createRoom === null
      ? []
      : (entries
          .find((item) => item.projectPath === createRoom.projectPath && item.map.work.id === createRoom.workId)
          ?.map.sessions.filter((session) => session.id !== requiredMemberId)
          .map((session) => ({
            id: session.id,
            label: sessionRowLabel(session.id, session.label),
            closed: session.lifecycle === 'closed',
          })) ?? []);

  // Входы сайдбара (кусок 2.5): сначала работа, по которой кликнули,
  // становится активной (id `mail` общий на раскладку), затем вкладка
  // открывается в её раскладке.
  const handleOpenMail = (key: string): void => openTabInWork(key, { kind: 'mail', id: tabId.mail() });
  const handleOpenRoom = (key: string, roomId: string): void => openTabInWork(key, { kind: 'room', id: tabId.room(roomId), roomId });

  const shell = (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Titlebar bridge={bridge} />
      <InterruptedBanner bridge={bridge} />
      {showLanding ? (
        <Landing />
      ) : (
        <div data-testid="app-shell" className="flex min-h-0 flex-1">
          {ui.leftSidebar.open ? (
            <>
              <div ref={leftSidebarRef} style={{ width: ui.leftSidebar.width }} className="h-full shrink-0 overflow-hidden">
                <ErrorBoundary title={S.shell.sidebarError}>
                  <WorkSidebar
                    bridge={bridge}
                    onActivateWork={(key) => useLayoutStore.getState().setActiveWork(key)}
                    onOpenSession={(key, sessionId) =>
                      openTabInWork(key, { kind: 'terminal', id: tabId.terminal(sessionId), sessionId })
                    }
                    onOpenMail={handleOpenMail}
                    onOpenRoom={handleOpenRoom}
                  />
                </ErrorBoundary>
              </div>
              <Resizer
                side="left"
                width={ui.leftSidebar.width}
                min={LEFT_SIDEBAR.min}
                max={LEFT_SIDEBAR.max}
                target={leftSidebarRef}
                onCommit={(width) => setSidebar('left', { width })}
              />
            </>
          ) : null}
          <ErrorBoundary title={S.shell.layoutError}>
            {/* Активной работы ещё нет (`layout/persistence.ts` её не выбрал) —
                LRU пуст, центр пуст: ни групп, ни строки вкладок в
                `#titlebar-tabs` (спека 5.3, тест 15). Контейнеры — в порядке
                ключей, а не LRU: смена активной работы не должна переставлять
                узлы DOM с живыми xterm. */}
            <div className="relative min-h-0 min-w-0 flex-1">
              {lru
                .keys()
                .sort()
                .map((key) => (
                  <WorkContainer
                    key={key}
                    workKey={key}
                    active={key === activeWorkKey}
                    bridge={bridge}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    sendDeps={sendDeps}
                  />
                ))}
            </div>
          </ErrorBoundary>
          {/* Правый сайдбар — только при активной работе (кусок 7.2); свёрнутый не монтируется. */}
          {activeWorkKey !== null && ui.rightSidebar.open && rightFit !== null ? (
            <ErrorBoundary title={S.shell.rightSidebarError}>
              <RightSidebar bridge={bridge} workKey={activeWorkKey} width={rightFit.width} max={rightFit.max} />
            </ErrorBoundary>
          ) : null}
        </div>
      )}
      <StatusBar
        status={status}
        noticeLine={noticeLine}
        wakePaused={wakePaused}
        onToggleWake={() => {
          // Отказ — тостом, как у действия палитры wake.toggle, а не необработанным отказом промиса.
          toggleWake(bridge).catch((error: unknown) => {
            console.error('[harnas] toggle wake failed', error);
            toast(errorText(decodeIpcError(error).code, S.errors.actions.toggleAutoWake));
          });
        }}
        onRestartHost={() => {
          // app.restartHost — только после «Restart» подтверждения; отказ — тостом, не отказом промиса.
          bridge.app.restartHost().catch((error: unknown) => {
            console.error('[harnas] restart host failed', error);
            toast(errorText(decodeIpcError(error).code, S.errors.actions.restartHost));
          });
        }}
        restartHostOpen={restartHostOpen}
        onRestartHostOpenChange={(open) =>
          open ? useUiStore.getState().confirmRestartHost() : useUiStore.getState().closeRestartHostDialog()
        }
        attention={attention}
        onNextAttention={openNextAttention}
      />
      <Palette bridge={bridge} run={stableRun} />
      <WindowCloseQuestion bridge={bridge} />
      <NewWorkComposer
        open={newWork.open}
        projectPath={newWork.projectPath}
        title={newWork.title}
        bridge={bridge}
        onOpenChange={(open) => {
          if (!open) closeNewWorkDialog();
        }}
      />
      {createRoom !== null ? (
        <CreateRoomDialog
          open
          bridge={bridge}
          projectPath={createRoom.projectPath}
          workId={createRoom.workId}
          requiredMember={createRoom.requiredMember}
          candidates={roomCandidates}
          onOpenChange={(open) => {
            if (!open) closeCreateRoomDialog();
          }}
        />
      ) : null}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={layoutCollision(activeWorkKey, (item) => canSend && acceptsTerminal(item))}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* Единственный писатель порядка сайдбара — живёт и при свёрнутом сайдбаре. Дочерний
          компонент, а не хук в теле: на каждое `activity.changed` перерисовывается он, а не
          вся оболочка (раунд исправлений 1 куска 3.3). */}
      <SidebarSectionsWriter />
      <LayoutPersistence bridge={bridge} />
      {shell}
      {/* Над <webview> указатель до DOM окна не доходит, и зоны броска над группой со страницей молчали
          бы. Как оверлей ресайзеров: прозрачный щит на время перетаскивания, под DragOverlay (9.2b).
          layoutCollision считает зоны по прямоугольникам и точке указателя, щит ему не мешает. */}
      {dragging === null ? null : <div data-testid="drag-shield" className="fixed inset-0 z-[998]" />}
      {/* Обёртка оверлея — размером с источник, её центр модификатор ставит
          под указатель; ярлык — по центру обёртки (раунд исправлений 1, ревью B). */}
      <DragOverlay dropAnimation={null} modifiers={OVERLAY_MODIFIERS}>
        {dragging === null ? null : (
          <div className="flex h-full w-full items-center justify-center">
            <div
              data-drag-overlay
              className="inline-flex h-7 max-w-60 shrink-0 items-center truncate rounded border border-border bg-popover px-2 text-xs text-popover-foreground shadow"
            >
              {dragging}
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
