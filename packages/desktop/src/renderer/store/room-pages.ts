/**
 * История выбранной комнаты (P35): снимок работ несёт письма комнаты хвостом, а старше хвоста окно берёт страницами
 * `context.messages`. Хранилище помнит, докуда комната уже прочитана, и не даёт гнать два запроса сразу.
 *
 * Курсор цепочки — `next` последней страницы; цепочка сброшена, когда она дочитана, а окно всё ещё не держит всех
 * писем комнаты (хвост успел сдвинуться или в промежутке дыра): тогда следующий запрос начинается заново с курсора перед
 * хвостом из снимка (`earlierCursor`), а счётчик на кнопке остаётся честным (`earlierRemaining`: всего минус то, что держит окно).
 *
 * Здесь же — чтение страниц после разрыва `rooms.mail` (спека rooms.mail 6.5): `repairWork` перечитывает держимое окном
 * по всем комнатам и Mail, `followRoom` дочитывает комнату после её верха, `rereadRoom` — весь держимый диапазон комнаты.
 * Страницы встают в карту через `addPage`: свежими копиями и со срезом потолка (`withFreshMessages`), как письма событий;
 * сам разрыв находит стор работ (`works.ts`).
 *
 * Окно с признаком `rooms-mail` получает снимок без писем (спека rooms.mail 6.8-6.9): последнюю страницу комнаты и Mail оно
 * читает при открытии (`openRoom`, `openMail`), дальше письма приходят событиями, а «загрузить раньше» идёт от наименьшего
 * держимого номера. Здесь же — что окно помнит о комнатах, чтобы письма не пропадали и не копились: какие открывались
 * (`opened`: у неоткрытых событие обновляет одни числа) и докуда человек подгрузил историю (цепочка: `keepHeld` её не срежет).
 * Оригинал цитаты, которого окно не держит, берётся письмом по id (`loadQuote`, метод `context.letter`): не больше 200 на работу,
 * отключение от хоста их забывает.
 *
 * Открытие, которое хост отклонил, повторяется само: с отступом 1 с, вдвое дольше после каждого сбоя подряд, до 30 с
 * (`openRoom`, как у починки разрыва в `works.ts`). Повтор останавливают: письма комнаты встали (событие, починка), работы
 * больше нет, комната уже не открыта, успешное открытие и отключение от хоста (`stopOpenRetries`): сбой чтения, дошедший
 * после отключения, нового повтора не заводит. Пока страница открытия читается или ждёт повтора, комната «ждёт»
 * (`pending`, `awaitsOpen`): лента в это время не показывает пустую подсказку.
 */

import { create } from 'zustand';
import type { Message, WindowWorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { earlierCursor, heldRanges, messageSeq, withFreshMessages, type HeldPolicy } from '../lib/window-merge.js';
import { useWorksStore } from './works.js';

interface Chain {
  next: string | null;
  done: boolean;
}

export interface RoomPagesState {
  chains: Record<string, Chain>;
  loading: Record<string, boolean>;
  /** Комнаты и Mail, которые окно открывало (ключ — `keyOf`): письма их событий окно держит. */
  opened: Record<string, true>;
  /** Комнаты и Mail, чья страница открытия читается или ждёт повтора после сбоя (ключ — `keyOf`); сняты, когда читать больше нечего. */
  pending: Record<string, true>;
  /**
   * Оригиналы цитат по работе (ключ — проект и работа, затем id письма): письмо или `null`, если его в работе нет.
   * Нет записи — ещё не спрашивали. Цитату показывает комната письма, поэтому сверка `roomId` — у читателя.
   */
  quotes: Record<string, Record<string, Message | null>>;
  /**
   * Подгружает страницу писем старше уже имеющихся. `apply` получает письма синхронно, сразу по ответу, — до смены
   * состояния цепочки: панель успевает запомнить положение ленты. Ошибку хоста бросает наружу (вызывающий решает, что
   * показать); при ошибке цепочка не двигается.
   */
  loadEarlier: (bridge: ParleyBridge, entry: WindowWorkEntry, roomId: string, apply: (messages: Message[]) => void) => Promise<void>;
  /**
   * Запрашивает оригинал цитаты `context.letter` один раз на id: повтор и запрос, что уже в пути, ничего не шлют. Ошибку
   * хоста бросает наружу и записи не оставляет — следующая попытка пойдёт заново.
   */
  loadQuote: (bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, id: string) => Promise<void>;
}

/** Ключ комнаты в состоянии окна; `null` — Mail (прямые письма). */
const roomKeyOf = (projectPath: string, workId: string, roomId: string | null): string => `${projectPath}\u0000${workId}\u0000${roomId ?? ''}`;
const keyOf = (entry: WindowWorkEntry, roomId: string | null): string => roomKeyOf(entry.projectPath, entry.map.work.id, roomId);
const quoteKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/** Оригиналов цитат на работу: набор растёт только от прокрутки человека, а ушедший оригинал просится заново, когда цитата снова нужна. */
const QUOTES_MAX = 200;

/** Запросы, что уже в пути: открытие комнаты и цитаты. Одно и то же дважды (повторная отрисовка, StrictMode) не шлётся. */
const opening = new Map<string, Promise<void>>();
const quoting = new Set<string>();

/** Отступ повтора открытия после сбоя: первый, удвоение за каждый сбой подряд, потолок. Успешное открытие счёт обнуляет. */
const OPEN_BACKOFF_MS = 1000;
const OPEN_BACKOFF_MAX_MS = 30_000;

/** Повтор открытия одной комнаты: сколько сбоев подряд и таймер, что ждёт следующей попытки. */
interface OpenRetry {
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const openRetries = new Map<string, OpenRetry>();
/**
 * Поколение повторов: растёт при `stopOpenRetries`. Чтение, начатое до отключения, а упавшее после него, видит чужое
 * поколение и повтора не заводит — иначе таймер пережил бы отключение.
 */
let retryEpoch = 0;

/** Снимает повтор комнаты вместе со счётом сбоев. */
function forgetRetry(key: string): void {
  const retry = openRetries.get(key);
  if (retry?.timer != null) clearTimeout(retry.timer);
  openRetries.delete(key);
}

/**
 * Приводит состояние комнаты в сторе к тому, что есть: `pending` — чтение идёт или повтор в очереди; `opened` ставится,
 * когда `markOpened`. Одно изменение стора на вызов, и только если что-то изменилось: панели не перерисовываются зря.
 */
function syncOpen(key: string, markOpened: boolean): void {
  const pending = opening.has(key) || openRetries.get(key)?.timer != null;
  const state = useRoomPagesStore.getState();
  const needsOpened = markOpened && state.opened[key] !== true;
  if (!needsOpened && pending === (state.pending[key] === true)) return;
  useRoomPagesStore.setState((current) => {
    const patch: Partial<RoomPagesState> = {};
    if (needsOpened) patch.opened = { ...current.opened, [key]: true };
    if (pending !== (current.pending[key] === true)) {
      const next = { ...current.pending };
      if (pending) next[key] = true;
      else Reflect.deleteProperty(next, key);
      patch.pending = next;
    }
    return patch;
  });
}

/**
 * Снимает все повторы открытия: связи с хостом нет, а открытые панели начнут заново, когда она вернётся. Оригиналы цитат
 * тоже забываются: хост после возврата мог быть другим, а нужные цитаты панель спросит заново.
 */
export function stopOpenRetries(): void {
  retryEpoch += 1;
  if (Object.keys(useRoomPagesStore.getState().quotes).length > 0) useRoomPagesStore.setState({ quotes: {} });
  for (const key of [...openRetries.keys()]) {
    forgetRetry(key);
    syncOpen(key, false);
  }
}

/**
 * Следующая попытка открыть комнату после сбоя. Читает карту работы на тот момент и ничего не делает, если письма комнаты
 * уже встали (событие или починка принесли их сами), работы больше нет или комната не открыта.
 */
function scheduleReopen(bridge: Pick<ParleyBridge, 'call'>, projectPath: string, workId: string, roomId: string | null): void {
  const key = roomKeyOf(projectPath, workId, roomId);
  const retry = openRetries.get(key) ?? { failures: 0, timer: null };
  retry.failures += 1;
  if (retry.timer !== null) clearTimeout(retry.timer);
  const delay = Math.min(OPEN_BACKOFF_MS * 2 ** (retry.failures - 1), OPEN_BACKOFF_MAX_MS);
  retry.timer = setTimeout(() => {
    retry.timer = null;
    const current = useWorksStore.getState().entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId);
    if (current === undefined || useRoomPagesStore.getState().opened[key] !== true || heldRanges(current).has(roomId)) {
      forgetRetry(key);
      syncOpen(key, false);
      return;
    }
    openRoom(bridge, current, roomId).catch((error: unknown) => console.warn('[parley] open room retry', error));
  }, delay);
  openRetries.set(key, retry);
  syncOpen(key, false);
}

/**
 * Страниц одной комнаты за одно дочитывание не больше. Страница — до сотни писем и 64 КиБ, поэтому потолок — не способ
 * «дочитать часть», а защита от бесконечного чтения: диапазон, не уложившийся в него, — сбой (`readDown` бросает).
 */
export const MAIL_PAGES_MAX = 20;

/**
 * Страница писем встаёт в карту работы свежими копиями (отметки прочтения только прибавляются) и проходит срез потолка с
 * границей подгруженного раньше (`withFreshMessages`, `heldPolicy().floor`): перечитывание после обрыва не поднимает
 * комнату выше `WINDOW_ROOM_KEEP`. Тот же путь у страницы открытия.
 */
function addPage(projectPath: string, workId: string, messages: readonly Message[]): void {
  const { floor } = heldPolicy(projectPath, workId);
  useWorksStore.setState((state) => ({
    entries: state.entries.map((entry) =>
      entry.projectPath === projectPath && entry.map.work.id === workId ? withFreshMessages(entry, messages, floor) : entry,
    ),
  }));
}

/** Одна страница `context.messages`; `null` — комнату или работу удалили, пока шли страницы: читать больше нечего, это не сбой. */
function readPage(
  bridge: Pick<ParleyBridge, 'call'>,
  entry: WindowWorkEntry,
  roomId: string | null,
  cursor: string | null,
): Promise<{ messages: Message[]; page: { complete: boolean; next: string | null } } | null> {
  return bridge
    .call('context.messages', { projectPath: entry.projectPath, workId: entry.map.work.id, roomId, ...(cursor === null ? {} : { cursor }) })
    .catch((error: unknown) => {
      if (decodeIpcError(error).code === 'not_found') return null;
      throw error;
    });
}

/**
 * Читает письма комнаты (или Mail при `roomId: null`) от вершины вниз, пока страница не дойдёт до номера `reach`: сначала без
 * курсора (самая новая страница), затем `before:` по `next`. Потолок страниц обрезает старый конец диапазона, а не вершину:
 * письма вершины и отметки на них доходят первыми. Каждая страница встаёт в карту свежими копиями; последняя может зацепить
 * письма ниже `reach` — они встают тоже. Не дошли за `MAIL_PAGES_MAX` страниц — бросает: вызывающий не должен считать окно
 * починенным (спека rooms.mail 6.5).
 */
async function readDown(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null, reach: number): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAIL_PAGES_MAX; page += 1) {
    const answer = await readPage(bridge, entry, roomId, cursor);
    if (answer === null) return;
    addPage(entry.projectPath, entry.map.work.id, answer.messages);
    const oldest = Math.min(...answer.messages.map(messageSeq));
    if (answer.page.complete || answer.page.next === null || oldest <= reach) return;
    cursor = answer.page.next;
  }
  throw new Error(`rooms.mail: ${roomId ?? 'direct letters'} not read down to m-${reach} within ${MAIL_PAGES_MAX} pages`);
}

/**
 * Окно держит комнату, но верх, до которого оно дошло, ниже `prevTop` события при совпавшей версии: письма между ними
 * потерялись. Читает от вершины вниз до наибольшего держимого номера (спека rooms.mail 6.5). Комнату без держимых писем не читает:
 * её письма окно возьмёт страницей при открытии. `entry` — карта до применения события, иначе верх уже сдвинут.
 */
export async function followRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readDown(bridge, entry, roomId, range.max);
}

/**
 * Перечитывает весь держимый диапазон комнаты — от вершины до наименьшего держимого номера, — чтобы обновить `readBy`
 * у каждого письма, а не только у новых: событие с признаком `reread` (потолок кадра, медленное окно, массовая отметка)
 * отметок не несёт.
 */
export async function rereadRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const range = heldRanges(entry).get(roomId);
  if (range !== undefined) await readDown(bridge, entry, roomId, range.min);
}

/**
 * Починка разрыва по версии работы (спека rooms.mail 6.5): держимый диапазон каждой держимой комнаты и Mail читается
 * от вершины вниз страницами `context.messages`. Сбой одной комнаты остальных не останавливает; первая ошибка уходит
 * вызывающему, и тот не считает окно починенным.
 */
export async function repairWork(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry): Promise<void> {
  let failure: { error: unknown } | null = null;
  for (const roomId of heldRanges(entry).keys()) {
    try {
      await rereadRoom(bridge, entry, roomId);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
}

/**
 * Комната (или Mail при `roomId: null`) открывается в окне: она помечается открытой, и если окно не держит ни одного её
 * письма, читается последняя страница `context.messages` (спека rooms.mail 6.9). Держимые письма заново не читаются: события
 * и починки разрыва поддерживают их сами. Открытие, что уже в пути, не повторяется; комната или работа, удалённые за это
 * время, — не сбой, другой отказ хоста бросается наружу, а открытие повторяется само (отступ — в описании файла): открытие
 * заново читает сразу и отменяет ожидающий повтор. `entry` — карта на момент открытия.
 */
export function openRoom(bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry, roomId: string | null): Promise<void> {
  const key = keyOf(entry, roomId);
  if (heldRanges(entry).has(roomId)) {
    forgetRetry(key);
    syncOpen(key, true);
    return Promise.resolve();
  }
  const running = opening.get(key);
  if (running !== undefined) {
    syncOpen(key, true);
    return running;
  }
  const retry = openRetries.get(key);
  if (retry?.timer != null) {
    clearTimeout(retry.timer);
    retry.timer = null;
  }
  const epoch = retryEpoch;
  const read = readPage(bridge, entry, roomId, null)
    .then(
      (answer) => {
        forgetRetry(key);
        if (answer !== null) addPage(entry.projectPath, entry.map.work.id, answer.messages);
      },
      (error: unknown) => {
        // Связь оборвалась, пока страница была в пути (`stopOpenRetries`): открытые панели начнут заново сами.
        if (epoch === retryEpoch) scheduleReopen(bridge, entry.projectPath, entry.map.work.id, roomId);
        throw error;
      },
    )
    .finally(() => {
      opening.delete(key);
      syncOpen(key, false);
    });
  opening.set(key, read);
  syncOpen(key, true);
  return read;
}

/**
 * Страница открытия комнаты ещё придёт: чтение не начиналось (панель начнёт его эффектом), идёт или ждёт повтора после
 * сбоя. Пока так, лента комнаты с письмами в снимке не показывает пустую подсказку; когда читать больше нечего (страница
 * встала, комнаты нет, связь оборвалась), — `false`.
 */
export const awaitsOpen = (state: RoomPagesState, entry: WindowWorkEntry, roomId: string | null): boolean => {
  const key = keyOf(entry, roomId);
  return state.opened[key] !== true || state.pending[key] === true;
};

/** Подгруженные оригиналы цитат работы (`RoomModelInput.quoted`); ничего не спрашивали — `undefined`. */
export const quotesOf = (state: RoomPagesState, entry: WindowWorkEntry): Record<string, Message | null> | undefined =>
  state.quotes[quoteKeyOf(entry.projectPath, entry.map.work.id)];

/** Mail открывается так же, как комната: прямые письма — это `roomId: null`. */
export const openMail = (bridge: Pick<ParleyBridge, 'call'>, entry: WindowWorkEntry): Promise<void> => openRoom(bridge, entry, null);

/** Номер из курсора `before:N` цепочки: письма от него и новее окно держит. */
const cursorSeq = (cursor: string | null): number | undefined => {
  const seq = cursor === null ? Number.NaN : Number(cursor.slice('before:'.length));
  return Number.isInteger(seq) ? seq : undefined;
};

/**
 * Что окно помнит о комнатах работы для `withMail`, `keepHeld` (`works.ts`) и `withFreshMessages` (`addPage`): открывалась
 * ли комната и докуда человек подгрузил её историю — цепочка, которую ведёт `loadEarlier` (дочитанная — до самого начала,
 * `0`). Пока страница «раньше» в пути, граница — наименьший номер, который окно держит сейчас: срез потолка не уберёт
 * письмо, к которому страница вот-вот примкнёт, и между ними не останется дыры.
 */
export function heldPolicy(projectPath: string, workId: string): HeldPolicy {
  const { opened, chains, loading } = useRoomPagesStore.getState();
  return {
    isOpen: (roomId) => opened[roomKeyOf(projectPath, workId, roomId)] === true,
    floor: (roomId) => {
      const key = roomKeyOf(projectPath, workId, roomId);
      const chain = chains[key];
      const chained = chain === undefined ? undefined : chain.done ? 0 : cursorSeq(chain.next);
      if (loading[key] !== true) return chained;
      const current = useWorksStore.getState().entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId);
      const lowest = current === undefined ? undefined : heldRanges(current).get(roomId)?.min;
      if (lowest === undefined) return chained;
      return chained === undefined ? lowest : Math.min(chained, lowest);
    },
  };
}

export const useRoomPagesStore = create<RoomPagesState>((set, get) => ({
  chains: {},
  loading: {},
  opened: {},
  pending: {},
  quotes: {},
  loadQuote: async (bridge, entry, id) => {
    const workKey = quoteKeyOf(entry.projectPath, entry.map.work.id);
    const key = `${workKey}\u0000${id}`;
    if (get().quotes[workKey]?.[id] !== undefined || quoting.has(key)) return;
    quoting.add(key);
    try {
      const { message } = await bridge.call('context.letter', { projectPath: entry.projectPath, workId: entry.map.work.id, id });
      set((state) => {
        // Ключи идут в порядке загрузки (`m-N` — не целое число): уходят загруженные раньше всех, только что пришедший остаётся.
        const kept = { ...state.quotes[workKey], [id]: message };
        const ids = Object.keys(kept);
        for (const stale of ids.slice(0, Math.max(0, ids.length - QUOTES_MAX))) Reflect.deleteProperty(kept, stale);
        return { quotes: { ...state.quotes, [workKey]: kept } };
      });
    } finally {
      quoting.delete(key);
    }
  },
  loadEarlier: async (bridge, entry, roomId, apply) => {
    const key = keyOf(entry, roomId);
    if (get().loading[key] === true) return;
    const chain = get().chains[key];
    const cursor = chain !== undefined && !chain.done ? chain.next : earlierCursor(entry, roomId);
    set((state) => ({ loading: { ...state.loading, [key]: true } }));
    try {
      const answer = await bridge.call('context.messages', {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId,
        ...(cursor === null || cursor === undefined ? {} : { cursor }),
      });
      apply(answer.messages);
      const next: Chain = answer.page.complete ? { next: null, done: true } : { next: answer.page.next, done: false };
      set((state) => ({ chains: { ...state.chains, [key]: next } }));
    } finally {
      set((state) => ({ loading: { ...state.loading, [key]: false } }));
    }
  },
}));
