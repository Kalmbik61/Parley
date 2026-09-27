/**
 * Восстановление и сохранение раскладок работ (спека 5.6–5.8, кусок 2.2 плана
 * каркаса). В отличие от `components/layout/use-layout-persistence.ts` (общая
 * сетка dockview под ключом `window`, живёт до 2.7), здесь у каждой работы
 * своя раскладка в `layout/store.ts` — хук ведёт себя как сторож между этим
 * стором и мостом: гидрирует по требованию (когда работа впервые становится
 * активной), пишет изменения на диск с тишиной и следит за составом снимка
 * работ (пропала работа — `drop` и `removeLayout`; пришли первые работы —
 * выбирает активную и зовёт `retainLayouts`).
 */

import { useEffect, useRef } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import type { HarnasBridge } from '../../shared/bridge.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { emptyLayout, parseWorkLayout, pruneLayout } from './tree.js';
import { useLayoutStore } from './store.js';

/** Тишина сохранения раскладки — своя на каждую работу (спека 5.8). */
const SAVE_SILENCE_MS = 500;
/** Тишина записи `activeWorkKey` в `ui.json` (план куска 2.2). */
const ACTIVE_WORK_SILENCE_MS = 300;

/**
 * Жива ли вкладка по картам работ (спека 5.8): используется при восстановлении
 * раскладки — `pruneLayout` выбрасывает вкладки, для которых здесь `false`.
 */
export function isTabAlive(entry: WorkEntry, tab: TabSpec): boolean {
  switch (tab.kind) {
    case 'terminal':
    case 'diff':
      return entry.map.sessions.some((session) => session.id === tab.sessionId);
    case 'room':
      return entry.map.rooms.some((room) => room.id === tab.roomId);
    case 'mail':
    case 'browser':
      return true;
    case 'file': {
      // `root` — своя переменная, а не повторный `tab.root` внутри колбэка
      // `find`: TS не удерживает сужение вложенного свойства через границу
      // замыкания, только простого локального связывания.
      const root = tab.root;
      if (root.kind === 'project') return true;
      const session = entry.map.sessions.find((candidate) => candidate.id === root.sessionId);
      if (session === undefined || session.worktree === null) return false;
      return session.worktree.createdAt !== null;
    }
  }
}

/** Соседняя работа в прежнем порядке: следующая, у последней — предыдущая, иначе `null`. */
export function neighborWork(order: string[], workKey: string): string | null {
  const index = order.indexOf(workKey);
  if (index === -1) return null;
  const next = order[index + 1];
  if (next !== undefined) return next;
  return order[index - 1] ?? null;
}

/** `loadLayout` → `parseWorkLayout` → `pruneLayout(isTabAlive)`; `null` на любом шаге → `emptyLayout()`. */
async function restoreLayout(bridge: HarnasBridge, entry: WorkEntry | undefined, key: string): Promise<WorkLayout> {
  const raw = await bridge.app.loadLayout(key);
  const parsed = raw === null ? null : parseWorkLayout(raw);
  const base = parsed ?? emptyLayout();
  return entry === undefined ? base : pruneLayout(base, (tab) => isTabAlive(entry, tab));
}

export interface UseLayoutPersistenceInput {
  bridge: HarnasBridge;
  works: WorkEntry[];
  worksLoaded: boolean;
  /** `workKey` в порядке сайдбара: до 3.4 — `orderedWorks`, с 3.4 — `visibleWorkOrder`. */
  order: string[];
}

export function useLayoutPersistence({ bridge, works, worksLoaded, order }: UseLayoutPersistenceInput): void {
  // `works` меняется на каждое событие хоста — эффекты ниже заведены на
  // `worksLoaded`/`order` и не должны пересоздавать подписку из-за этого;
  // свежий список читается через ref в момент восстановления.
  const worksRef = useRef(works);
  worksRef.current = works;

  // `null` — снимок ещё не приходил: следующий эффект отличает первый снимок
  // (выбор activeWorkKey и retainLayouts — ровно один раз) от последующих
  // (диф пропавших работ).
  const prevOrderRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!worksLoaded) return;
    const prevOrder = prevOrderRef.current;
    prevOrderRef.current = order;

    if (prevOrder === null) {
      let cancelled = false;
      // Работы, удалённые при закрытом окне, не должны копиться в файле вечно —
      // первый снимок оставляет раскладки только тех работ, что в нём есть.
      bridge.app.retainLayouts(order).catch(() => {});

      const applyInitial = (initial: string | null): void => {
        if (cancelled) return;
        // Пока ждали диск, снимок мог обновиться и уже выбрать активную работу
        // сам (пустой старт → пришли работы, см. ветку ниже) — не затираем её.
        if (useLayoutStore.getState().activeWorkKey !== null) return;
        useLayoutStore.getState().setActiveWork(initial);
      };

      bridge.app
        .loadUi()
        .then((ui) => {
          const fromDisk = ui.activeWorkKey;
          applyInitial(fromDisk !== null && order.includes(fromDisk) ? fromDisk : (order[0] ?? null));
        })
        .catch(() => applyInitial(order[0] ?? null));

      return () => {
        cancelled = true;
      };
    }

    for (const key of prevOrder) {
      if (order.includes(key)) continue;
      const wasActive = useLayoutStore.getState().activeWorkKey === key;
      useLayoutStore.getState().drop(key);
      bridge.app.removeLayout(key).catch(() => {});
      if (wasActive) useLayoutStore.getState().setActiveWork(neighborWork(prevOrder, key));
    }

    // Пустой старт (тест 16): работ не было, activeWorkKey — null; как только
    // снимок принёс хоть одну работу, показывать нужно её, а не Landing.
    if (useLayoutStore.getState().activeWorkKey === null && order.length > 0) {
      useLayoutStore.getState().setActiveWork(order[0] ?? null);
    }
    return undefined;
  }, [worksLoaded, order, bridge]);

  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const activeHydrated = useLayoutStore((state) =>
    state.activeWorkKey === null ? true : state.hydrated[state.activeWorkKey] === true,
  );

  // Гидрирует работу при её первом показе (спека 5.8, «Восстановление»): до
  // `worksLoaded` не запускается вовсе, а после — ровно один `loadLayout` на
  // каждую работу, когда-либо ставшую активной (дальше `hydrated` не даёт эффекту повториться).
  useEffect(() => {
    if (!worksLoaded || activeWorkKey === null || activeHydrated) return;
    let cancelled = false;
    const key = activeWorkKey;
    const entry = worksRef.current.find((candidate) => workKeyOf(candidate.projectPath, candidate.map.work.id) === key);

    restoreLayout(bridge, entry, key)
      .then((layout) => {
        if (!cancelled) useLayoutStore.getState().hydrate(key, layout);
      })
      .catch(() => {
        // План требует здесь только не уронить окно — раскладка просто
        // откроется пустой, как если бы сохранённой не было вовсе.
        if (!cancelled) useLayoutStore.getState().hydrate(key, emptyLayout());
      });

    return () => {
      cancelled = true;
    };
  }, [worksLoaded, activeWorkKey, activeHydrated, bridge]);

  // Сохранение раскладки — 500 мс тишины, свой таймер на каждую работу (спека
  // 5.8). Самую первую гидрацию работы (переход `undefined → раскладка`) не
  // сохраняем: это чтение с диска, а не изменение человеком.
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const unsubscribe = useLayoutStore.subscribe((state, prevState) => {
      if (state.layouts === prevState.layouts) return;
      for (const [key, layout] of Object.entries(state.layouts)) {
        const prevLayout = prevState.layouts[key];
        if (prevLayout === undefined || prevLayout === layout) continue;

        const timer = timers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            bridge.app.saveLayout(key, layout).catch(() => {
              // Отказ (например, `LayoutTooLargeError`) main уже погасил
              // предупреждением в свою консоль — рендереру тут делать нечего.
            });
          }, SAVE_SILENCE_MS),
        );
      }
    });

    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [bridge]);

  // `activeWorkKey` — владелец стора, но его копию в `ui.json` пишет только
  // persistence (спека 5.6), с той же тишиной 300 мс, что и раньше у `ui.ts`.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useLayoutStore.subscribe((state, prevState) => {
      if (state.activeWorkKey === prevState.activeWorkKey) return;
      const next = state.activeWorkKey;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        bridge.app.saveUi({ activeWorkKey: next }).catch(() => {});
      }, ACTIVE_WORK_SILENCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [bridge]);
}
