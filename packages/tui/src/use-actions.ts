/**
 * Действия харнесса: клавиши после префикса и режим навигации по сайдбару
 * (дизайн TUI v2, 3.1–3.2, макеты 1.5 и §8).
 *
 * Байты разбирает `use-prefix-input.ts`, оверлеи держит `use-overlays.ts`;
 * здесь — только маршрут «клавиша → действие». Всё, что не префикс, уходит гостю.
 */

import type { WorkSession } from '@harnas/core';
import { useInput } from 'ink';
import { useCallback, useMemo, useState } from 'react';
import {
  sameTarget,
  sidebarCursorRows,
  sidebarTargets,
  stepCursor,
  type SidebarProps,
  type SidebarTarget,
  type SidebarWork,
} from './components/sidebar.js';
import type { PanelState } from './use-panel.js';
import type { OverlaysState } from './use-overlays.js';
import { usePrefixInput, withoutMouse, type MouseEvent } from './use-prefix-input.js';
import type { SelectionState } from './use-selection.js';

/** Клавиша префикса → оверлей, который она открывает (таблица 3.2). */
const OVERLAYS: Readonly<Record<string, Parameters<OverlaysState['open']>[0]>> = {
  w: 'works',
  g: 'history',
  i: 'details',
  r: 'resume',
  R: 'summary',
  '?': 'help',
  x: 'close',
  q: 'exit',
};

export interface ActionsOptions {
  /** Байт префикса и его имя для подсказок (`ctrl+q`). */
  prefixByte: number;
  /** Работы сайдбара по порядку: `prefix 1..9` выбирает работу по номеру. */
  workRows: readonly SidebarWork[];
  selection: SelectionState;
  /** Сессии выбранной работы в порядке дерева: по ним ходят `j` и `k`. */
  order: readonly string[];
  /** Выбранная работа: в неё ложится новая сессия (5.1). */
  workId: string | null;
  session: WorkSession | null;
  panel: PanelState;
  overlays: OverlaysState;
  /** Сайдбар, как он нарисован: из его раскладки берутся цели клика (3.3). */
  sidebar: SidebarProps | null;
  /** Колонок слева от панели: клик не правее — сайдбару. */
  panelLeft: number;
  /** `config.mouseCapture`: выключен — харнесс мышь не ловит вовсе (3.3). */
  mouseCapture: boolean;
  /**
   * Нажатие, не ушедшее гостю: после префикса, в списках, в оверлее. По нему
   * гаснет событие строки статуса без источника (дизайн координации, раздел 5).
   */
  onKey: () => void;
  /**
   * `prefix b`: сайдбар прячется и показывается. `false` — сайдбара на этой
   * ширине нет вовсе, и `b` открывает его оверлеем (2.1, решение №9).
   */
  toggleSidebar: () => boolean;
}

export interface ActionsState {
  /** Фокус в сайдбаре: ввод не идёт гостю, разделитель cyan (макет 1.5). */
  navigating: boolean;
  /** Ждём вторую клавишу префикса: строка статуса показывает действия (§3). */
  awaiting: boolean;
  /**
   * Строка сайдбара под курсором: она подсвечена, и от неё зависит `c` — на
   * строке `new` он заводит новую работу, а не сессию в выбранной (5.1).
   */
  cursor: SidebarTarget | null;
}

export function useActions(options: ActionsOptions): ActionsState {
  const { prefixByte, workRows, selection, order, panel, overlays } = options;
  const { workId, session, sidebar, panelLeft, mouseCapture, onKey, toggleSidebar } = options;

  const [navigating, setNavigating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [cursor, setCursor] = useState<SidebarTarget | null>(null);

  /** Строки сайдбара сверху вниз: по ним ходит курсор режима навигации (3.2). */
  const rows = useMemo(() => sidebarCursorRows(workRows, order), [workRows, order]);

  /** `prefix j`/`k`: соседняя сессия работы с подключением к панели (3.2). */
  const walk = useCallback(
    (delta: number) => {
      const at = Math.max(0, order.indexOf(selection.session ?? ''));
      const next = order[(at + delta + order.length) % (order.length || 1)];
      if (next === undefined) return;
      setCursor({ kind: 'session', key: next });
      selection.attach(next);
    },
    [order, selection],
  );

  /**
   * Новая сессия: в выбранную работу, а на строке `new` — в новую работу «без
   * названия» (5.1). Выбор переезжает за панелью: работа могла родиться сейчас.
   */
  const create = useCallback(
    (target: SidebarTarget | null) => {
      panel.create(target?.kind === 'new' ? null : workId, (sessionId, key) => {
        selection.selectWork(key);
        selection.attach(sessionId);
      });
    },
    [panel, workId, selection],
  );

  /** Ходьба курсора: сессия под ним выбирается сразу, работа — только `Enter`. */
  const moveCursor = useCallback(
    (delta: number) => {
      const next = stepCursor(rows, cursor, delta);
      setCursor(next);
      if (next?.kind === 'session') selection.selectSession(next.key);
    },
    [rows, cursor, selection],
  );

  const onAction = useCallback(
    (key: string) => {
      onKey();
      if (key === 'c') return create(cursor);
      if (key === 'j' || key === 'k') return walk(key === 'j' ? 1 : -1);
      if (key === 's') {
        // Курсор входит в сайдбар там, где стоит выбор (макет 1.5).
        const at: SidebarTarget | null =
          selection.session !== null
            ? { kind: 'session', key: selection.session }
            : selection.work !== null
              ? { kind: 'work', key: selection.work }
              : null;
        setCursor(stepCursor(rows, at, 0));
        return setNavigating(true);
      }
      // Сайдбара на этой ширине нет — `b` открывает его оверлеем (решение №9).
      if (key === 'b') return toggleSidebar() ? undefined : overlays.open('sidebar');
      if (key >= '1' && key <= '9') {
        const work = workRows[Number(key) - 1];
        if (work === undefined) return;
        setCursor({ kind: 'work', key: work.key });
        selection.selectWork(work.key);
        return;
      }
      const overlay = OVERLAYS[key];
      if (overlay !== undefined) overlays.open(overlay);
    },
    [create, cursor, rows, selection, walk, workRows, overlays, onKey, toggleSidebar],
  );

  /**
   * Клик в сайдбаре: по работе — выбор, по сессии — выбор с подключением, по
   * `new` — новая сессия, а по `new` под курсором — новая работа (3.3, 5.1).
   * Колесо и отпускание кнопки строк не трогают. Раскладка считается на сам
   * клик: каждый кадр она была бы напрасной работой.
   */
  const onMouse = (event: MouseEvent): void => {
    if (event.kind !== 'press' || event.button !== 0 || sidebar === null) return;
    const target = sidebarTargets(sidebar)[event.y - 1];
    if (target === undefined || target === null) return;
    const wasHere = sameTarget(cursor, target);
    setCursor(target);
    if (target.kind === 'work') return selection.selectWork(target.key);
    if (target.kind === 'new') return create(wasHere ? target : null);
    selection.attach(target.key);
  };

  // Весь ввод — гостю, кроме префикса; пока открыт оверлей или сайдбар в режиме
  // навигации, гостю не уходит ничего (3.1).
  usePrefixInput(true, {
    prefixByte,
    onAction,
    onAwait: setAwaiting,
    toGuest: panel.write,
    capture: overlays.kind !== null || navigating,
    // Ввод оверлея и списков — тоже нажатия харнесса; события мыши ими не
    // считаются: они гостю не уходят, но и клавишами не являются.
    onCapture: (data) => {
      if (withoutMouse(data) !== '') onKey();
    },
    mouseCapture,
    panelLeft,
    mouseTracking: panel.snapshot?.mouseTracking ?? 'none',
    onMouse,
    onScroll: panel.scroll,
  });

  // Режим навигации: стрелки и `j`/`k` по всем строкам сайдбара сверху вниз,
  // `Enter` выбирает работу, заводит сессию на `new` или подключает (3.2, §8).
  useInput(
    (input, key) => {
      if (key.escape) return setNavigating(false);
      if (input === 'j' || key.downArrow) return moveCursor(1);
      if (input === 'k' || key.upArrow) return moveCursor(-1);
      if (!key.return) return;

      // Работа выбирается на месте: её сессии появляются внизу сайдбара, и
      // курсор идёт к ним дальше, не выходя из режима.
      if (cursor?.kind === 'work') return selection.selectWork(cursor.key);

      setNavigating(false);
      // `Enter` по `new` кладёт сессию в выбранную работу; новую работу заводит
      // `prefix c` на этой же строке (5.1).
      if (cursor?.kind === 'new') return create(null);

      const id = cursor?.key ?? selection.session;
      if (id === null) return;
      // Не живую сессию `Enter` запускает или возобновляет оверлеем (4.5, 4.6).
      if (session !== null && session.status !== 'active') {
        overlays.open(session.status === 'pending' ? 'launch' : 'resume');
        return;
      }
      selection.attach(id);
    },
    { isActive: navigating && overlays.kind === null },
  );

  return { navigating, awaiting, cursor };
}
