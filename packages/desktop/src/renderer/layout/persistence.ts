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

/**
 * Замена пропавшей активной работы, когда из снимка ОДНИМ разом могло уйти
 * сразу несколько работ (массовое удаление/архивация, переподключение к
 * хосту после простоя) — раунд исправлений 1, Critical A+B. Просто
 * `neighborWork(prevOrder, key)` тут не годится: он считает по статичному
 * старому порядку и не знает, что вычисленный сосед сам тоже мог пропасть в
 * этом же снимке — старый цикл по каждому пропавшему ключу переприсваивал
 * `activeWorkKey` на такого «соседа», и если цепочка соседей замыкалась сама
 * на себя, в итоге получался ключ, которого уже нет ни в `order`, ни в
 * `layouts` (полностью удалённый `drop`).
 *
 * Поэтому здесь ищем по прежнему `order`, но проверяем каждого кандидата на
 * то, что он ДЕЙСТВИТЕЛЬНО остался в новом `order` — сначала вперёд от места
 * удалённой работы, потом назад; если и там, и там все соседи тоже пропали в
 * этом же снимке — первая работа нового `order`; нет вовсе ни одной — `null`.
 */
function survivingNeighbor(prevOrder: readonly string[], removedKey: string, order: readonly string[]): string | null {
  const index = prevOrder.indexOf(removedKey);
  for (let i = index + 1; i < prevOrder.length; i += 1) {
    const candidate = prevOrder[i];
    if (candidate !== undefined && order.includes(candidate)) return candidate;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = prevOrder[i];
    if (candidate !== undefined && order.includes(candidate)) return candidate;
  }
  return order[0] ?? null;
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

  // Работы, чья САМАЯ ПЕРВАЯ гидрация принесла что-то сверх диска — очередь
  // `pending`, применённая внутри `hydrate` (раунд исправлений 1, Important
  // A): сама по себе первая гидрация не «изменение» (см. эффект сохранения
  // ниже), но если в неё влилась очередь `pending`, результат уже ОТЛИЧАЕТСЯ
  // от того, что на диске, и должен уйти в `saveLayout`, иначе не уйдёт
  // никогда. Общий `Set`, а не состояние стора — это внутренняя бухгалтерия
  // между двумя эффектами этого хука, не часть публичного `LayoutState`.
  const dirtyFirstHydrateRef = useRef<Set<string>>(new Set());

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

    // Все пропавшие разом (раунд исправлений 1, Critical): сначала снимаем
    // ВСЕ дропы, и только потом, зная окончательный новый `order`, решаем,
    // кем заменить активную работу, если пропала именно она — `drop()` сам
    // обнуляет `activeWorkKey`, когда дропает текущую активную, поэтому
    // исходное значение читаем ДО цикла, а не полагаемся на него после.
    const activeBeforeDrops = useLayoutStore.getState().activeWorkKey;
    const missingKeys = prevOrder.filter((key) => !order.includes(key));

    for (const key of missingKeys) {
      useLayoutStore.getState().drop(key);
      bridge.app.removeLayout(key).catch(() => {});
    }

    if (activeBeforeDrops !== null && missingKeys.includes(activeBeforeDrops)) {
      useLayoutStore.getState().setActiveWork(survivingNeighbor(prevOrder, activeBeforeDrops, order));
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

    // Помечает «грязным» ДО вызова `hydrate` — сама очередь `pending`
    // проверяется прямо здесь, а не внутри стора: `hydrate` её тут же
    // потребляет (см. `store.ts`), и это последний момент, когда её видно.
    const hydrateWork = (layout: WorkLayout): void => {
      if ((useLayoutStore.getState().pending[key]?.length ?? 0) > 0) {
        dirtyFirstHydrateRef.current.add(key);
      }
      useLayoutStore.getState().hydrate(key, layout);
    };

    restoreLayout(bridge, entry, key)
      .then((layout) => {
        if (!cancelled) hydrateWork(layout);
      })
      .catch(() => {
        // План требует здесь только не уронить окно — раскладка просто
        // откроется пустой, как если бы сохранённой не было вовсе.
        if (!cancelled) hydrateWork(emptyLayout());
      });

    return () => {
      cancelled = true;
    };
  }, [worksLoaded, activeWorkKey, activeHydrated, bridge]);

  // Сохранение раскладки — 500 мс тишины, свой таймер на каждую работу (спека
  // 5.8). Самую первую гидрацию работы (переход `undefined → раскладка`) не
  // сохраняем: это чтение с диска, а не изменение человеком — кроме случая,
  // когда в неё влилась очередь `pending` (раунд исправлений 1, Important A,
  // `dirtyFirstHydrateRef` выше) — тогда результат уже не то, что на диске.
  //
  // Раунд исправлений 1, Important B: размонтирование хука (в реальном окне —
  // закрытие) или `pagehide`/`beforeunload` до истечения тишины не должны
  // тихо терять последнюю правку — недописанные таймеры флашатся немедленно.
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pendingLayouts = new Map<string, WorkLayout>();

    const flush = (key: string): void => {
      const timer = timers.get(key);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(key);
      const layout = pendingLayouts.get(key);
      pendingLayouts.delete(key);
      if (layout !== undefined) {
        bridge.app.saveLayout(key, layout).catch(() => {
          // Отказ (например, `LayoutTooLargeError`) main уже погасил
          // предупреждением в свою консоль — рендереру тут делать нечего.
        });
      }
    };
    const flushAll = (): void => {
      for (const key of [...timers.keys()]) flush(key);
    };

    const unsubscribe = useLayoutStore.subscribe((state, prevState) => {
      if (state.layouts === prevState.layouts) return;
      for (const [key, layout] of Object.entries(state.layouts)) {
        const prevLayout = prevState.layouts[key];
        if (prevLayout === layout) continue;
        if (prevLayout === undefined && !dirtyFirstHydrateRef.current.delete(key)) continue;

        const timer = timers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        pendingLayouts.set(key, layout);
        timers.set(key, setTimeout(() => flush(key), SAVE_SILENCE_MS));
      }
    });

    window.addEventListener('pagehide', flushAll);
    window.addEventListener('beforeunload', flushAll);

    return () => {
      unsubscribe();
      flushAll();
      window.removeEventListener('pagehide', flushAll);
      window.removeEventListener('beforeunload', flushAll);
    };
  }, [bridge]);

  // `activeWorkKey` — владелец стора, но его копию в `ui.json` пишет только
  // persistence (спека 5.6), с той же тишиной 300 мс, что и раньше у `ui.ts`.
  // Тот же флаш при размонтировании/закрытии окна, что и у раскладки выше
  // (раунд исправлений 1, Important B).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingKey: string | null | undefined;

    const flush = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      const key = pendingKey;
      pendingKey = undefined;
      if (key !== undefined) bridge.app.saveUi({ activeWorkKey: key }).catch(() => {});
    };

    const unsubscribe = useLayoutStore.subscribe((state, prevState) => {
      if (state.activeWorkKey === prevState.activeWorkKey) return;
      if (timer !== null) clearTimeout(timer);
      pendingKey = state.activeWorkKey;
      timer = setTimeout(flush, ACTIVE_WORK_SILENCE_MS);
    });

    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);

    return () => {
      unsubscribe();
      flush();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [bridge]);
}
