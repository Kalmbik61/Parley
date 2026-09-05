/**
 * Действия харнесса: клавиши после префикса и режим навигации по сайдбару
 * (дизайн TUI v2, 3.1–3.2, макеты 1.5, 4.8 и 4.9).
 *
 * Байты разбирает `use-prefix-input.ts`; здесь — что делает каждая клавиша и
 * какое подтверждение она открывает. Всё, что не префикс, уходит гостю.
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import { useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import type { SidebarWork } from './components/sidebar.js';
import { glyphs } from './glyphs.js';
import type { PanelState } from './use-panel.js';
import { usePrefixInput } from './use-prefix-input.js';
import type { SelectionState } from './use-selection.js';
import type { StatusEventInit } from './use-status.js';
import { closeSessionDialog, exitDialog, type DialogSpec } from './work-dialogs.js';

/** Действия, чьи оверлеи подключаются отдельной задачей (2.4). */
const OVERLAYS = 'wgirR?';

/** Открытое подтверждение: его текст и что делать по `Enter` (макеты 4.8, 4.9). */
export interface OpenDialog {
  id: number;
  spec: DialogSpec;
  submit: () => void;
}

export interface ActionsOptions {
  /** Байт префикса и его имя для подсказок (`ctrl+q`). */
  prefixByte: number;
  prefixName: string;
  /** Все работы: по ним считаются живые сессии при выходе. */
  works: readonly WorkEntry[];
  /** Работы сайдбара по порядку: `prefix 1..9` выбирает работу по номеру. */
  workRows: readonly SidebarWork[];
  selection: SelectionState;
  /** Сессии выбранной работы в порядке дерева: по ним ходят `j` и `k`. */
  order: readonly string[];
  /** Выбранная работа: в неё ложится новая сессия (5.1). */
  workId: string | null;
  session: WorkSession | null;
  /** Ключ панели выбранной сессии; `null` — сессии нет. */
  runKey: string | null;
  panel: PanelState;
  /** `prefix b`: сайдбар прячется и показывается; ширину считает композиция (2.1). */
  toggleSidebar: () => void;
  push: (events: readonly StatusEventInit[]) => void;
  exit: () => void;
}

export interface ActionsState {
  dialog: OpenDialog | null;
  cancel: () => void;
  /** Фокус в сайдбаре: ввод не идёт гостю, разделитель cyan (макет 1.5). */
  navigating: boolean;
  /** Ждём вторую клавишу префикса: строка статуса показывает действия (§3). */
  awaiting: boolean;
}

export function useActions(options: ActionsOptions): ActionsState {
  const { prefixByte, prefixName, works, workRows, selection, order, panel, push, exit } = options;
  const { workId, session, runKey, toggleSidebar } = options;

  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const dialogId = useRef(0);

  const cancel = useCallback(() => setDialog(null), []);
  const openDialog = useCallback(
    (spec: DialogSpec, submit: () => void) => setDialog({ id: dialogId.current++, spec, submit }),
    [],
  );

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

  /** `x`: подтверждение, затем SIGHUP процессу панели (макет 4.8). */
  const closeSession = useCallback(() => {
    if (session === null || runKey === null) return;
    if (session.status !== 'active') {
      push([{ text: `«${session.label}» не запущена — закрывать нечего` }]);
      return;
    }
    if (!panel.alive(runKey)) {
      push([{ text: `«${session.label}» запущена вне харнесса — закрыть её нечем` }]);
      return;
    }
    openDialog(closeSessionDialog(session, glyphs()), () => {
      setDialog(null);
      panel.close(runKey);
    });
  }, [session, runKey, panel, openDialog, push]);

  /** `q`: выход с подтверждением, если есть живые сессии (макет 4.9). */
  const quit = useCallback(() => {
    const alive = works.flatMap((entry) =>
      entry.map.sessions.filter((item) => item.status === 'active').map((item) => item.label),
    );
    if (alive.length === 0) return exit();
    openDialog(exitDialog(alive), () => {
      setDialog(null);
      exit();
    });
  }, [works, exit, openDialog]);

  const onAction = useCallback(
    (key: string) => {
      if (key === 'c') return panel.create(workId, selection.attach);
      if (key === 'j' || key === 'k') return walk(key === 'j' ? 1 : -1, true);
      if (key === 's') return setNavigating(true);
      if (key === 'b') return toggleSidebar();
      if (key === 'x') return closeSession();
      if (key === 'q') return quit();
      if (key >= '1' && key <= '9') {
        const work = workRows[Number(key) - 1];
        if (work !== undefined) selection.selectWork(work.key);
        return;
      }
      if (OVERLAYS.includes(key)) {
        push([{ text: `${prefixName} ${key} — оверлей ещё не подключён` }]);
      }
    },
    [panel, workId, selection, walk, closeSession, quit, workRows, push, prefixName, toggleSidebar],
  );

  // Весь ввод — гостю, кроме префикса; пока открыто подтверждение или сайдбар в
  // режиме навигации, гостю не уходит ничего (3.1).
  usePrefixInput(true, {
    prefixByte,
    onAction,
    onAwait: setAwaiting,
    toGuest: panel.write,
    capture: dialog !== null || navigating,
  });

  // Режим навигации: стрелки и `j`/`k` по строкам, `Enter` подключает (3.2).
  useInput(
    (input, key) => {
      if (key.escape) return setNavigating(false);
      if (input === 'j' || key.downArrow) return walk(1, false);
      if (input === 'k' || key.upArrow) return walk(-1, false);
      if (key.return && selection.session !== null) {
        // Не живую сессию `Enter` запускает или возобновляет через оверлей (4.5,
        // 4.6); пока его нет, честнее сказать это, чем промолчать.
        if (session !== null && session.status !== 'active') {
          const what = session.status === 'pending' ? 'запуска' : 'возобновления';
          push([{ text: `«${session.label}»: оверлей ${what} ещё не подключён` }]);
          return;
        }
        selection.attach(selection.session);
        setNavigating(false);
      }
    },
    { isActive: navigating && dialog === null },
  );

  return { dialog, cancel, navigating, awaiting };
}
