/**
 * Восстановление и сохранение раскладок работ (спека 5.6–5.8, кусок 2.2 плана
 * каркаса). У каждой работы своя раскладка в `layout/store.ts` — хук ведёт
 * себя как сторож между этим стором и мостом: гидрирует по требованию (когда работа впервые становится
 * активной), пишет изменения на диск с тишиной и следит за снимком работ
 * (пропала работа — `drop` и `removeLayout`; пропала сессия или комната — вкладки,
 * на них ссылающиеся, закрываются в живых раскладках; пришли первые работы —
 * выбирает активную и зовёт `retainLayouts`).
 */

import { useEffect, useRef } from 'react';
import type { WorkEntry } from '@parley/core';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import type { ParleyBridge } from '../../shared/bridge.js';
import { settleVanishedWork } from '../files/SaveChangesDialog.js';
import { workTitleText } from '../lib/participant.js';
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
 *
 * С куска 3.4 оба порядка — видимые (`visibleOrder` до и после снимка): соседа человек
 * видел на экране, а архивная или скрытая работа кандидатом не бывает.
 */
function survivingNeighbor(
  prevOrder: readonly string[],
  removedKey: string,
  order: readonly string[],
  isArchived: (key: string) => boolean,
): string | null {
  // С куска 6.3 показанные архивные есть и в видимом порядке, но соседом не бывают (спека 6.7).
  const fits = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && order.includes(candidate) && !isArchived(candidate);
  const index = prevOrder.indexOf(removedKey);
  for (let i = index + 1; i < prevOrder.length; i += 1) {
    const candidate = prevOrder[i];
    if (fits(candidate)) return candidate;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = prevOrder[i];
    if (fits(candidate)) return candidate;
  }
  return order.find((key) => !isArchived(key)) ?? null;
}

/** `loadLayout` → `parseWorkLayout` → `pruneLayout(isTabAlive)`; `null` на любом шаге → `emptyLayout()`. */
async function restoreLayout(bridge: ParleyBridge, entry: WorkEntry | undefined, key: string): Promise<WorkLayout> {
  const raw = await bridge.app.loadLayout(key);
  const parsed = raw === null ? null : parseWorkLayout(raw);
  const base = parsed ?? emptyLayout();
  return entry === undefined ? base : pruneLayout(base, (tab) => isTabAlive(entry, tab));
}

/**
 * Работы, чья САМАЯ ПЕРВАЯ гидрация принесла что-то сверх диска — очередь
 * `pending`, применённая внутри `hydrate` (раунд исправлений 1, Important
 * A): сама по себе первая гидрация не «изменение» (см. эффект сохранения
 * в хуке), но если в неё влилась очередь `pending`, результат уже ОТЛИЧАЕТСЯ
 * от того, что на диске, и должен уйти в `saveLayout`, иначе не уйдёт
 * никогда.
 *
 * С куска 6.2 — общая на модуль, а не `useRef` хука: гидрирует и палитра
 * (`ensureHydrated`), и операция из очереди (клик по строке сессии), влитая в
 * такую гидрацию, иначе попала бы на диск только со следующей правкой.
 */
const dirtyFirstHydrate = new Set<string>();

/**
 * Первая гидрация работы — одна для первого показа и для палитры. Помечает
 * «грязной» ДО вызова `hydrate`: `hydrate` очередь `pending` тут же потребляет
 * (см. `store.ts`), и это последний момент, когда её видно.
 */
function hydrateWork(key: string, layout: WorkLayout): void {
  if ((useLayoutStore.getState().pending[key]?.length ?? 0) > 0) dirtyFirstHydrate.add(key);
  useLayoutStore.getState().hydrate(key, layout);
}

/** Работы, чью раскладку `ensureHydrated` уже читает: повторное открытие палитры не читает её второй раз. */
const hydrating = new Set<string>();

/**
 * Сколько раз работу снимали (`drop`) за запуск. `hydrate` после `drop` снова примет ключ
 * (`hydrated` уже не `true`), и поздний ответ чтения вернул бы в память раскладку удалённой
 * работы; счётчик, а не список работ, — ключ может вернуться, и старый ответ всё равно чужой.
 */
const drops = new Map<string, number>();

/** Гидрирует раскладки работ, ещё не показанных за этот запуск: тот же hydrateWork, что у первого показа. */
export async function ensureHydrated(input: { bridge: ParleyBridge; works: WorkEntry[] }): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  for (const entry of input.works) {
    const key = workKeyOf(entry.projectPath, entry.map.work.id);
    if (useLayoutStore.getState().hydrated[key] === true || hydrating.has(key)) continue;
    hydrating.add(key);
    const dropsBefore = drops.get(key) ?? 0;
    jobs.push(
      restoreLayout(input.bridge, entry, key)
        .catch(() => emptyLayout())
        .then((layout) => {
          hydrating.delete(key);
          // Работу удалили, пока читали, — ответ устарел.
          if ((drops.get(key) ?? 0) !== dropsBefore) return;
          // Первый показ мог успеть раньше — живую раскладку не перечитываем.
          if (useLayoutStore.getState().hydrated[key] !== true) hydrateWork(key, layout);
        }),
    );
  }
  await Promise.all(jobs);
}

export interface UseLayoutPersistenceInput {
  bridge: ParleyBridge;
  works: WorkEntry[];
  worksLoaded: boolean;
  /**
   * Состав снимка (кусок 3.4): все работы — с архивными, свёрнутыми и скрытыми `done`,
   * синхронно из `works`. По нему `retainLayouts` первого снимка, `drop` и `removeLayout`.
   */
  order: string[];
  /**
   * Видимый порядок сайдбара того же снимка (`visibleWorkOrder`); `null` — ещё не посчитан:
   * до загрузки `ui.json` или пока секции отстают от снимка. Нужен только для выбора соседа
   * и выбора на старте — эти решения ждут, пока он придёт.
   */
  visibleOrder: string[] | null;
}

/** Решение об активной работе, которое ждёт видимого порядка (или ответа `ui.json`). */
type PendingChoice =
  /** Первый непустой снимок: `ui.activeWorkKey`, иначе первая видимая. */
  | { kind: 'start' }
  /** Активная пропала или архивирована: соседняя по прежнему видимому порядку. */
  | { kind: 'replace'; removed: string; prevVisible: readonly string[] };

export function useLayoutPersistence({ bridge, works, worksLoaded, order, visibleOrder }: UseLayoutPersistenceInput): void {
  // `works` меняется на каждое событие хоста — эффекты ниже заведены на
  // подписи состава и порядка и не должны пересоздавать подписку из-за этого;
  // свежий список читается через ref в момент восстановления.
  const worksRef = useRef(works);
  worksRef.current = works;

  // Архивные — часть состава, но не кандидаты в активные (спека 6.1).
  const archived = new Set(
    works.filter((entry) => entry.map.work.status === 'archived').map((entry) => workKeyOf(entry.projectPath, entry.map.work.id)),
  );
  // Входы — свежие массивы на каждый рендер `AppShell`; эффект перезапускают только подписи.
  const orderRef = useRef(order);
  orderRef.current = order;
  const visibleRef = useRef(visibleOrder);
  visibleRef.current = visibleOrder;
  const archivedRef = useRef<ReadonlySet<string>>(archived);
  archivedRef.current = archived;
  const orderSig = JSON.stringify(order);
  const visibleSig = visibleOrder === null ? null : JSON.stringify(visibleOrder);
  const archivedSig = JSON.stringify([...archived]);

  // `null` — снимок ещё не приходил: следующий эффект отличает первый снимок
  // (retainLayouts — ровно один раз) от последующих (диф пропавших работ).
  const prevOrderRef = useRef<string[] | null>(null);
  const prevArchivedRef = useRef<ReadonlySet<string>>(new Set());
  /** Последний посчитанный видимый порядок — «прежний» для выбора соседа. */
  const lastVisibleRef = useRef<string[] | null>(null);
  const pendingRef = useRef<PendingChoice | null>(null);
  /**
   * Последние известные названия работ: вопрос об исчезнувшей работе называет её (fix-7.3 п. 1),
   * а в свежем снимке её уже нет. Только растёт — по строке на работу за запуск.
   */
  const titlesRef = useRef(new Map<string, string>());
  for (const entry of works) titlesRef.current.set(workKeyOf(entry.projectPath, entry.map.work.id), workTitleText(entry.map.work.title));
  /** `activeWorkKey` из `ui.json`; `undefined` — ответа ещё нет. */
  const fromDiskRef = useRef<string | null | undefined>(undefined);
  // Отменяет выбор по `ui.json` только размонтирование, а не перезапуск эффекта
  // (раунд исправлений куска 2.7): входы — новые массивы на каждый рендер.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  /**
   * Выбирает активную работу, когда для решения всё есть (спека 5.6, кусок 3.4). Других
   * поводов менять активную у persistence нет: свернуть проект, скрыть `done`, закрепить —
   * это видимый порядок, а не состав, раскладки и активная работа от них не меняются.
   */
  const resolveActive = useRef((): void => {
    const store = useLayoutStore.getState;
    const current = orderRef.current;
    const visible = visibleRef.current;
    const isArchived = (key: string): boolean => archivedRef.current.has(key);
    // «Первая видимая» — неархивная: показанные архивные (6.3) стоят в visibleOrder.
    const firstLive = (): string | null =>
      visible?.find((key) => !isArchived(key)) ?? current.find((key) => !isArchived(key)) ?? null;
    const fromDisk = (): string | null => {
      const disk = fromDiskRef.current;
      return disk !== null && disk !== undefined && current.includes(disk) && !isArchived(disk) ? disk : null;
    };

    const pending = pendingRef.current;
    if (pending?.kind === 'start') {
      if (fromDiskRef.current === undefined || visible === null) return;
      pendingRef.current = null;
      // Пока ждали, человек мог уже выбрать работу сам — не затираем.
      if (store().activeWorkKey === null) store().setActiveWork(fromDisk() ?? firstLive());
      return;
    }
    if (pending?.kind === 'replace') {
      if (visible === null) return;
      pendingRef.current = null;
      const active = store().activeWorkKey;
      if (active === null || active === pending.removed) {
        store().setActiveWork(survivingNeighbor(pending.prevVisible, pending.removed, visible, isArchived) ?? firstLive());
      }
      return;
    }
    // Пустой старт (тест 16) или все работы пропадали: как только снимок принёс работу,
    // показывать нужно её, а не Landing, — по тому же правилу, что и на старте.
    if (store().activeWorkKey === null && visible !== null) {
      const next = fromDisk() ?? firstLive();
      if (next !== null) store().setActiveWork(next);
    }
  });

  useEffect(() => {
    if (!worksLoaded) return;
    const current = orderRef.current;
    const prevOrder = prevOrderRef.current;
    const prevVisible = lastVisibleRef.current;

    if (prevOrder === null) {
      // Работы, удалённые при закрытом окне, не должны копиться в файле вечно —
      // первый снимок оставляет раскладки только тех работ, что в нём есть.
      bridge.app.retainLayouts(current).catch(() => {});
      if (current.length > 0) pendingRef.current = { kind: 'start' };
      const applyDisk = (key: string | null): void => {
        if (disposedRef.current) return;
        fromDiskRef.current = key;
        resolveActive.current();
      };
      bridge.app
        .loadUi()
        .then((ui) => applyDisk(ui.activeWorkKey))
        .catch(() => applyDisk(null));
    } else {
      // Все пропавшие разом (раунд исправлений 1, Critical): сначала снимаем ВСЕ дропы,
      // а замену активной решаем по окончательному составу. `drop()` сам обнуляет
      // `activeWorkKey`, поэтому исходное значение читаем ДО цикла.
      const activeBefore = useLayoutStore.getState().activeWorkKey;
      const missingKeys = prevOrder.filter((key) => !current.includes(key));
      for (const key of missingKeys) {
        drops.set(key, (drops.get(key) ?? 0) + 1);
        const remove = (): void => {
          useLayoutStore.getState().drop(key);
          bridge.app.removeLayout(key).catch(() => {});
        };
        // Работу удалили не из этого окна (fix-7.3 п. 1): `drop` отпустил бы грязные буферы её
        // вкладок мимо вопроса. Есть такие — сначала вопрос, раскладка уходит после ответа; работа
        // за это время вернулась в снимок — раскладка остаётся.
        const settling = settleVanishedWork(bridge, key, titlesRef.current.get(key) ?? key);
        if (settling === null) remove();
        else
          void settling.then(() => {
            if (!orderRef.current.includes(key)) remove();
          });
      }
      // Архивная остаётся в составе и с раскладкой, но активной быть перестаёт (спека 6.7).
      const becameArchived =
        activeBefore !== null && archivedRef.current.has(activeBefore) && !prevArchivedRef.current.has(activeBefore);
      if (activeBefore !== null && (missingKeys.includes(activeBefore) || becameArchived)) {
        pendingRef.current = { kind: 'replace', removed: activeBefore, prevVisible: prevVisible ?? prevOrder };
      }
    }
    prevOrderRef.current = current;
    prevArchivedRef.current = archivedRef.current;

    resolveActive.current();
    if (visibleRef.current !== null) lastVisibleRef.current = visibleRef.current;
  }, [worksLoaded, orderSig, visibleSig, archivedSig, bridge]);

  // Из снимка пропала сессия или комната — ссылающиеся на неё вкладки закрываются и в ЖИВОЙ
  // раскладке, а не только при следующем чтении с диска (`restoreLayout` выше): до этого вкладка
  // удалённой сессии висела в строке вкладок телом «Session deleted» до перезапуска окна. Сами
  // правила жизни — те же `isTabAlive`, что у восстановления; вопрос о правках не спрашивается:
  // из этого окна `SessionRowMenu` спрашивает ДО `sessions.delete`, а снаружи (другое окно)
  // worktree сессии уже удалён вместе с ней. Подпись — только состав (id сессий, наличие их
  // worktree, id комнат): прочие события `works.changed` не должны перебирать все раскладки.
  const aliveSig = JSON.stringify(
    works.map((entry) => [
      workKeyOf(entry.projectPath, entry.map.work.id),
      entry.map.sessions.map((candidate) => [candidate.id, candidate.worktree !== null]),
      entry.map.rooms.map((room) => room.id),
    ]),
  );
  useEffect(() => {
    if (!worksLoaded) return;
    const store = useLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) {
      const entry = worksRef.current.find((candidate) => workKeyOf(candidate.projectPath, candidate.map.work.id) === key);
      // Пропавшая работа — дело эффекта состава выше (drop); здесь только живые.
      if (entry === undefined) continue;
      // `pruneLayout` без мёртвых вкладок возвращает ту же ссылку — `apply` не трогает стор,
      // и сохранение на диск не дёргается.
      store.apply(key, (layout) => pruneLayout(layout, (tab) => isTabAlive(entry, tab)));
    }
  }, [worksLoaded, aliveSig]);

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
        if (!cancelled) hydrateWork(key, layout);
      })
      .catch(() => {
        // План требует здесь только не уронить окно — раскладка просто
        // откроется пустой, как если бы сохранённой не было вовсе.
        if (!cancelled) hydrateWork(key, emptyLayout());
      });

    return () => {
      cancelled = true;
    };
  }, [worksLoaded, activeWorkKey, activeHydrated, bridge]);

  // Сохранение раскладки — 500 мс тишины, свой таймер на каждую работу (спека
  // 5.8). Самую первую гидрацию работы (переход `undefined → раскладка`) не
  // сохраняем: это чтение с диска, а не изменение человеком — кроме случая,
  // когда в неё влилась очередь `pending` (раунд исправлений 1, Important A,
  // `dirtyFirstHydrate` выше) — тогда результат уже не то, что на диске.
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
        if (prevLayout === undefined && !dirtyFirstHydrate.delete(key)) continue;

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
