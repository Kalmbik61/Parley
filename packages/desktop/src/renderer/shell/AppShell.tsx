/**
 * Оболочка окна (куски 2.3–2.7, спека 4.4, 5.1, 5.3, 5.6, 5.9, 5.10):
 * заголовок, сайдбар работ, центр и строка статуса. Центр — раскладка
 * активной работы (`LayoutView`); с куска 2.7 он единственный: прежний центр и
 * его флаг ушли.
 *
 * `CommandPalette`, `SessionPicker`, `NewWorkComposer` и `CreateRoomDialog`
 * монтируются здесь же (а не в сайдбаре) — они нужны и над `Landing`, где
 * сайдбара вовсе нет.
 *
 * `AppShell` — единственная точка действий реестра клавиш (`run(id)`, кусок 6.1b,
 * спека 9.6): её зовут обработчик окна (`keys/handler.ts`) и клик по пункту меню
 * (`menu:action`). Там же входы сайдбара и «открывающие» действия палитры: все
 * они идут в `layout/store.ts` раскладки активной работы. Сессия,
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
 * Кусок 2.6 (спека 5.4): один `DndContext` на всё окно — строка сессии живёт
 * в сайдбаре, строка вкладок одной группы — в заголовке, зоны броска — в
 * центре, а `useDraggable` вне провайдера молча не тащит. `PointerSensor` — с
 * порогом 4 px: без него @dnd-kit начинает перетаскивание уже на
 * `pointerdown` и глушит следующий `click`, и строка сессии перестала бы
 * открываться по клику, а крестик — закрывать вкладку.
 */

import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
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
import { refKey } from '@harnas/protocol';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';
import type { ActionId } from '../../shared/keybindings.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { noticeText, S } from '../../shared/strings.js';
import { LEFT_SIDEBAR } from '../../shared/ui-types.js';
import { openNextAttention } from '../attention/next.js';
import { useAttentionTotals } from '../attention/store.js';
import { InterruptedBanner } from '../components/InterruptedBanner.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { SessionPicker, sessionCandidates } from '../components/palette/SessionPicker.js';
import { CreateRoomDialog, type RoomCandidate } from '../components/rooms/CreateRoomDialog.js';
import { neighborInOrder, visibleWorkOrder } from '../sidebar/sort.js';
import { SidebarSectionsWriter, useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { NewWorkComposer } from '../sidebar/NewWorkComposer.js';
import { WorkSidebar } from '../sidebar/WorkSidebar.js';
import { buildCommands, recentSessionsFromHistory } from '../lib/commands.js';
import { sessionLabelFor, sessionRowLabel } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { applyDrop, centerOverlayOnCursor, dragItemOf, dropFromDragEnd, layoutCollision, onTerminalDrop, type DragItem } from '../layout/dnd.js';
import { setDropPreview } from '../layout/DropIndicator.js';
import { tabId } from '../layout/ids.js';
import { tabMeta } from '../layout/tab-meta.js';
import { LayoutView } from '../layout/LayoutView.js';
import { createLru, type Lru } from '../layout/lru.js';
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { measureGroupSizes } from '../layout/measure.js';
import { findTab, focusGroup, focusTab, groups, openTab, openTerminalSessionIds, reopenClosed, splitGroup } from '../layout/tree.js';
import { focusContext } from '../keys/focus-context.js';
import { installKeyHandler, isActionAvailable } from '../keys/handler.js';
import { createMruCycle, type MruCycle } from '../keys/mru-cycle.js';
import { hostMethods } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { terminalSurfaces } from '../terminal/TerminalSurface.js';
import { useNoticesStore } from '../store/notices.js';
import { useUiStore } from '../store/ui.js';
import { orderedWorks, useWorksStore } from '../store/works.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Landing } from './Landing.js';
import { Resizer } from './Resizer.js';
import { StatusBar } from './StatusBar.js';
import { Titlebar } from './Titlebar.js';

/**
 * Ярлык предмета в `DragOverlay`: заголовок вкладки или строка сессии активной
 * работы — тот же текст, что человек видел под курсором.
 */
function dragLabel(item: DragItem, key: string | null): string {
  const entry = useWorksStore.getState().entries.find((candidate) => workKey(candidate.projectPath, candidate.map.work.id) === key);
  if (item.kind === 'session') {
    const session = entry?.map.sessions.find((candidate) => candidate.id === item.sessionId);
    return sessionRowLabel(item.sessionId, session?.label ?? '');
  }
  const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
  const tab = layout === undefined ? undefined : groups(layout).flatMap((group) => group.tabs).find((candidate) => candidate.id === item.tabId);
  return tab === undefined ? item.tabId : tabMeta(tab, entry ?? null).title;
}

/** Доступность — одна для нажатия и для `menu:action` (кусок 6.1b): методы хоста в момент действия. */
function available(id: ActionId): boolean {
  return isActionAvailable(id, hostMethods(useHostStore.getState().status));
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
const WorkContainer = memo(function WorkContainer({ workKey, active, bridge, fontFamily, fontSize }: WorkContainerProps): JSX.Element {
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
          <SurfaceLayer workKey={workKey} active={active} bridge={bridge} fontFamily={fontFamily} fontSize={fontSize} />
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
  const ordered = orderedWorks(entries);
  // «Работ нет» — это ответ хоста, а не просто пустой начальный снимок:
  // до первого `works.list` показывать `Landing` рано (спека 5.10, «после загрузки»).
  const showLanding = worksLoaded && entries.length === 0;


  const ui = useUiStore((state) => state.ui);
  const setSidebar = useUiStore((state) => state.setSidebar);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const picker = useUiStore((state) => state.picker);
  const closePicker = useUiStore((state) => state.closePicker);
  const newWork = useUiStore((state) => state.dialogs.newWork);
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const closeNewWorkDialog = useUiStore((state) => state.closeNewWorkDialog);
  const createRoom = useUiStore((state) => state.dialogs.createRoom);
  const closeCreateRoomDialog = useUiStore((state) => state.closeCreateRoomDialog);
  const wakePaused = useUiStore((state) => state.wakePaused);
  // Недавние сессии палитры — из истории переходов (кусок 2.7); подписка на
  // `history`, чтобы список обновлялся вместе с ней.
  const history = useLayoutStore((state) => state.history);
  const recentSessionRefs = recentSessionsFromHistory(history.entries, entries);
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
      onTerminalDrop(item, zone.sessionId);
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

  // ⌘1…⌘9 — N-я работа видимого порядка сайдбара, «Pinned» первыми (кусок 3.4, спека 6.5).
  // Порядок — из стора секций в момент нажатия: оболочка на активность не подписана.
  const selectWorkByNumber = (n: number): void => {
    const key = visibleWorkOrder(useSidebarSectionsStore.getState().sections)[n - 1];
    if (key !== undefined) useLayoutStore.getState().setActiveWork(key);
  };

  // Меню раскладки работает прямо через `layout/store.ts` на раскладке
  // активной работы (спека 5.3, п. «Клавиши»).
  const closeActiveTab = (): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    const activeTabId = activeGroup?.activeTabId;
    if (activeTabId !== null && activeTabId !== undefined) void useLayoutStore.getState().requestCloseTabs(key, [activeTabId]);
  };

  const focusAdjacentGroup = (delta: 1 | -1): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const all = groups(layout);
    if (all.length === 0) return;
    const index = all.findIndex((group) => group.id === layout.activeGroupId);
    const nextIndex = (((index === -1 ? 0 : index + delta) % all.length) + all.length) % all.length;
    const target = all[nextIndex];
    if (target !== undefined) useLayoutStore.getState().apply(key, (l) => focusGroup(l, target.id));
  };

  const beginSplit = (direction: 'right' | 'down'): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    useUiStore.getState().openPicker({ workKey: key, direction, openSessionIds: openTerminalSessionIds(layout) });
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

  /** Вкладка активной группы активной работы: соседняя по кругу (`step`) или N-я (`index`). */
  const focusTabInActiveGroup = (pick: (tabs: readonly TabSpec[], activeIndex: number) => TabSpec | undefined): void => {
    const key = useLayoutStore.getState().activeWorkKey;
    const layout = key === null ? undefined : useLayoutStore.getState().layouts[key];
    if (key === null || layout === undefined) return;
    const activeGroup = groups(layout).find((group) => group.id === layout.activeGroupId);
    if (activeGroup === undefined || activeGroup.tabs.length === 0) return;
    const tab = pick(activeGroup.tabs, activeGroup.tabs.findIndex((candidate) => candidate.id === activeGroup.activeTabId));
    if (tab !== undefined) useLayoutStore.getState().apply(key, (l) => focusTab(l, tab.id));
  };

  // Цикл ⌃Tab (6.1a) — один на окно: клавиши больше не висят в `LayoutView` трёх работ LRU.
  const mruCycleRef = useRef<MruCycle | null>(null);
  if (mruCycleRef.current === null) mruCycleRef.current = createMruCycle();
  const mruCycle = mruCycleRef.current;

  const stepMru = (step: 1 | -1): void => {
    const state = useLayoutStore.getState();
    const key = state.activeWorkKey;
    if (key === null) return;
    const layout = state.layouts[key];
    if (layout === undefined) return;
    // Вкладку снимка могли закрыть посреди цикла — она пропускается, а не глушит шаг.
    // Предел — размер снимка: MRU хранит до 20 вкладок на работу.
    let target = mruCycle.step(key, state.mru[key] ?? [], step);
    for (let guard = 0; target !== null && findTab(layout, target) === null && guard < 20; guard += 1) {
      target = mruCycle.step(key, state.mru[key] ?? [], step);
    }
    if (target !== null && findTab(layout, target) !== null) state.apply(key, (l) => focusTab(l, target));
  };

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
   * Одна точка действий реестра (кусок 6.1b): нажатие окна и клик пункта меню. Ветки действуют
   * на раскладку активной работы; прочих действий реестра до 6.3 и этапов 7–9 здесь нет —
   * `isActionAvailable` их не пропускает.
   */
  const run = (id: ActionId): void => {
    const layoutStore = useLayoutStore.getState();
    if (id === 'palette.open') setPaletteOpen(true);
    else if (id === 'work.new') openNewWorkDialog();
    else if (id === 'session.new') {
      // Родитель — выбранная сессия, как у ⌘T в `App.tsx`.
      const selected = selectedSessionOf(layoutStore, useWorksStore.getState().entries);
      useUiStore.getState().openNewSessionDialog(selected?.ref.sessionId ?? null);
    } else if (id === 'settings.open') useUiStore.getState().openSettingsDialog();
    else if (id === 'sidebar.left.toggle') setSidebar('left', { open: !useUiStore.getState().ui.leftSidebar.open });
    else if (id.startsWith('work.goto.')) selectWorkByNumber(Number(id.slice('work.goto.'.length)));
    else if (id === 'work.prev' || id === 'work.next') {
      // Порядок — в момент нажатия (3.4): оболочка на активность не подписана.
      const order = visibleWorkOrder(useSidebarSectionsStore.getState().sections);
      const next = neighborInOrder(order, layoutStore.activeWorkKey, id === 'work.next' ? 1 : -1);
      if (next !== null) layoutStore.setActiveWork(next);
    } else if (id === 'history.back') layoutStore.back();
    else if (id === 'history.forward') layoutStore.forward();
    else if (id === 'group.splitRight') beginSplit('right');
    else if (id === 'group.splitDown') beginSplit('down');
    else if (id === 'group.prev') focusAdjacentGroup(-1);
    else if (id === 'group.next') focusAdjacentGroup(1);
    else if (id === 'tab.close') closeActiveTab();
    else if (id === 'tab.reopen') {
      const key = layoutStore.activeWorkKey;
      if (key !== null) layoutStore.apply(key, reopenClosed);
    } else if (id === 'tab.prev' || id === 'tab.next') {
      const step = id === 'tab.next' ? 1 : -1;
      focusTabInActiveGroup((tabs, index) => tabs[(((index + step) % tabs.length) + tabs.length) % tabs.length]);
    } else if (id.startsWith('tab.goto.')) {
      const n = Number(id.slice('tab.goto.'.length));
      focusTabInActiveGroup((tabs) => tabs[n - 1]);
    } else if (id === 'tab.mruNext') stepMru(1);
    else if (id === 'tab.mruPrev') stepMru(-1);
    else if (id === 'find') activeTerminalSurface()?.openSearch();
    // Только `term.clear()` поверхности: агенту в pty ничего не уходит.
    else if (id === 'terminal.clear') activeTerminalSurface()?.clear();
  };
  const runRef = useRef(run);
  runRef.current = run;
  const endMruCycleRef = useRef(endMruCycle);
  endMruCycleRef.current = endMruCycle;

  useEffect(
    () =>
      installKeyHandler({
        run: (id) => runRef.current(id),
        // Прежняя палитра строк по номеру не выбирает: `Palette` и её `pickRow` подключает 6.2.
        pickPaletteRow: () => {},
        context: () => focusContext(document.activeElement),
        paletteOpen: () => useUiStore.getState().paletteOpen,
        available,
        endMruCycle: () => endMruCycleRef.current(),
      }),
    [],
  );

  // Клик мышью по пункту меню; клик сочетанием main не шлёт (`main/menu.ts`).
  useEffect(
    () =>
      bridge.app.onMenu((id) => {
        if (available(id)) runRef.current(id);
      }),
    [bridge],
  );

  const pickerEntry = picker === null ? undefined : ordered.find((entry) => workKey(entry.projectPath, entry.map.work.id) === picker.workKey);
  const pickerCandidates = picker === null || pickerEntry === undefined ? [] : sessionCandidates(pickerEntry, new Set(picker.openSessionIds));

  // Открывающие действия палитры и сайдбара: сессия/почта/комната могут
  // принадлежать НЕ активной сейчас работе (у каждой работы своя раскладка) —
  // сначала переключить работу, потом открыть вкладку в НЕЙ.
  const openTabInWork = (key: string, tab: TabSpec): void => {
    useLayoutStore.getState().setActiveWork(key);
    useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
  };

  const commands = buildCommands({
    works: entries,
    wakePaused,
    recentSessionRefs,
    actions: {
      openWork: (key) => useLayoutStore.getState().setActiveWork(key),
      openSession: (ref, key) => openTabInWork(key, { kind: 'terminal', id: tabId.terminal(ref.sessionId), sessionId: ref.sessionId }),
      openMail: (key) => openTabInWork(key, { kind: 'mail', id: tabId.mail() }),
      openRoom: (key, roomId) => openTabInWork(key, { kind: 'room', id: tabId.room(roomId), roomId }),
      closeActivePanel: closeActiveTab,
      newSession: () => {
        const selected = selectedSessionOf(useLayoutStore.getState(), useWorksStore.getState().entries);
        useUiStore.getState().openNewSessionDialog(selected?.ref.sessionId ?? null);
      },
      newWork: () => useUiStore.getState().openNewWorkDialog(),
      settings: () => useUiStore.getState().openSettingsDialog(),
      toggleWake: () => void toggleWake(bridge),
    },
  });

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
                  />
                ))}
            </div>
          </ErrorBoundary>
        </div>
      )}
      <StatusBar
        status={status}
        noticeLine={noticeLine}
        wakePaused={wakePaused}
        onToggleWake={() => void toggleWake(bridge)}
        onRestartHost={() => void bridge.app.restartHost()}
        attention={attention}
        onNextAttention={openNextAttention}
      />
      <CommandPalette open={paletteOpen} commands={commands} onOpenChange={setPaletteOpen} />
      <SessionPicker
        open={picker !== null}
        candidates={pickerCandidates}
        onOpenChange={(open) => {
          if (!open) closePicker();
        }}
        onSelect={(sessionRef) => {
          if (picker === null) return;
          const layout = useLayoutStore.getState().layouts[picker.workKey];
          if (layout !== undefined) {
            const tab: TabSpec = { kind: 'terminal', id: tabId.terminal(sessionRef.sessionId), sessionId: sessionRef.sessionId };
            const direction = picker.direction === 'right' ? 'row' : 'column';
            const error = useLayoutStore
              .getState()
              .apply(picker.workKey, (l) => splitGroup(l, layout.activeGroupId, direction, tab, measureGroupSizes()));
            if (error === 'too-many-groups') toast(S.tabs.tooManyGroups);
            else if (error === 'too-small') toast(S.tabs.tooSmall);
          }
          closePicker();
        }}
      />
      <NewWorkComposer
        open={newWork.open}
        projectPath={newWork.projectPath}
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
      collisionDetection={layoutCollision(activeWorkKey)}
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
