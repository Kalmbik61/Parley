/**
 * Действия харнесса: клавиши после префикса и режим навигации по сайдбару
 * (дизайн TUI v2, 3.1–3.2, макеты 1.5 и §8).
 *
 * Байты разбирает `use-prefix-input.ts`, оверлеи держит `use-overlays.ts`;
 * здесь — только маршрут «клавиша → действие». Всё, что не префикс, уходит гостю.
 */

import type { WorkSession } from '@harnas/core';
import { useInput } from 'ink';
import { useCallback, useState } from 'react';
import type { SidebarWork } from './components/sidebar.js';
import type { PanelState } from './use-panel.js';
import type { OverlaysState } from './use-overlays.js';
import { usePrefixInput } from './use-prefix-input.js';
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
}

export function useActions(options: ActionsOptions): ActionsState {
  const { prefixByte, workRows, selection, order, panel, overlays } = options;
  const { workId, session, toggleSidebar } = options;

  const [navigating, setNavigating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);

  /** `j`/`k` и стрелки: соседняя сессия работы, с подключением или без (3.2). */
  const walk = useCallback(
    (delta: number, connect: boolean) => {
      const at = Math.max(0, order.indexOf(selection.session ?? ''));
      const next = order[(at + delta + order.length) % (order.length || 1)];
      if (next === undefined) return;
      if (connect) selection.attach(next);
      else selection.selectSession(next);
    },
    [order, selection],
  );

  const onAction = useCallback(
    (key: string) => {
      if (key === 'c') return panel.create(workId, selection.attach);
      if (key === 'j' || key === 'k') return walk(key === 'j' ? 1 : -1, true);
      if (key === 's') return setNavigating(true);
      // Сайдбара на этой ширине нет — `b` открывает его оверлеем (решение №9).
      if (key === 'b') return toggleSidebar() ? undefined : overlays.open('sidebar');
      if (key >= '1' && key <= '9') {
        const work = workRows[Number(key) - 1];
        if (work !== undefined) selection.selectWork(work.key);
        return;
      }
      const overlay = OVERLAYS[key];
      if (overlay !== undefined) overlays.open(overlay);
    },
    [panel, workId, selection, walk, workRows, overlays, toggleSidebar],
  );

  // Весь ввод — гостю, кроме префикса; пока открыт оверлей или сайдбар в режиме
  // навигации, гостю не уходит ничего (3.1).
  usePrefixInput(true, {
    prefixByte,
    onAction,
    onAwait: setAwaiting,
    toGuest: panel.write,
    capture: overlays.kind !== null || navigating,
  });

  // Режим навигации: стрелки и `j`/`k` по строкам, `Enter` подключает (3.2).
  useInput(
    (input, key) => {
      if (key.escape) return setNavigating(false);
      if (input === 'j' || key.downArrow) return walk(1, false);
      if (input === 'k' || key.upArrow) return walk(-1, false);
      if (key.return && selection.session !== null) {
        // Не живую сессию `Enter` запускает или возобновляет оверлеем (4.5, 4.6).
        if (session !== null && session.status !== 'active') {
          setNavigating(false);
          overlays.open(session.status === 'pending' ? 'launch' : 'resume');
          return;
        }
        selection.attach(selection.session);
        setNavigating(false);
      }
    },
    { isActive: navigating && overlays.kind === null },
  );

  return { navigating, awaiting };
}
