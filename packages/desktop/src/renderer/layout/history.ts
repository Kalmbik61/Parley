/**
 * История «назад / вперёд» и MRU вкладок (спека 5.7, кусок 2.2 плана каркаса).
 * Чистые функции над неизменяемыми значениями, как и `layout/tree.ts`: состояние
 * самого стора (`layout/store.ts`) только держит `History`/`Mru`, а шаг,
 * дедупликация и лимиты живут здесь — их проще проверить в отрыве от zustand.
 */

export interface HistoryEntry {
  workKey: string;
  /** `null` — раскладка работы ещё не гидрирована на момент записи. */
  tabId: string | null;
  /** `Date.now()` записи — по нему палитра считает свежесть (спека 6.2). */
  at: number;
}

export interface History {
  entries: readonly HistoryEntry[];
  /** Текущая запись; `-1` — история пуста. */
  index: number;
}

export const EMPTY_HISTORY: History = { entries: [], index: -1 };

/** Предел записей истории (спека, «Числа»: 50). */
const HISTORY_LIMIT = 50;

/**
 * Добавляет запись. Подряд одинаковые (`workKey` и `tabId` совпадают с текущей
 * записью) не пишутся — та же ссылка на `history`. Иначе хвост «вперёд» (всё
 * после текущей позиции — шаги `forward()`, которые новый переход делает
 * недостижимыми) обрезается новой записью, и история держит не больше `limit`
 * последних записей.
 */
export function pushHistory(history: History, entry: HistoryEntry, limit: number = HISTORY_LIMIT): History {
  const current = history.entries[history.index];
  if (current !== undefined && current.workKey === entry.workKey && current.tabId === entry.tabId) {
    return history;
  }
  const withoutForward = history.entries.slice(0, history.index + 1);
  const entries = [...withoutForward, entry].slice(-limit);
  return { entries, index: entries.length - 1 };
}

/**
 * Шаг назад (`-1`) или вперёд (`1`), мимо записей, для которых `isAlive` ложно
 * (спека 5.7: «запись пропускается, если раскладки её работы нет в `layouts`
 * или вкладка закрыта») — `back()`/`forward()` стора не должны приводить на
 * запись, которую уже нечем показать. `null` — в эту сторону шагать некуда.
 */
export function stepHistory(
  history: History,
  step: -1 | 1,
  isAlive: (entry: HistoryEntry) => boolean,
): { history: History; entry: HistoryEntry } | null {
  let index = history.index + step;
  while (index >= 0 && index < history.entries.length) {
    const entry = history.entries[index];
    if (entry !== undefined && isAlive(entry)) {
      return { history: { ...history, index }, entry };
    }
    index += step;
  }
  return null;
}

/** `tabId` вкладок работы, свежие первыми — не больше лимита на работу (спека, «Числа»: 20). */
export type Mru = Readonly<Record<string, readonly string[]>>;

const MRU_LIMIT = 20;

/** Переносит `tabId` в начало списка своей работы (или добавляет), обрезая до `limit`. */
export function touchMru(mru: Mru, workKey: string, tabId: string, limit: number = MRU_LIMIT): Mru {
  const current = mru[workKey] ?? [];
  const withoutTab = current.filter((id) => id !== tabId);
  return { ...mru, [workKey]: [tabId, ...withoutTab].slice(0, limit) };
}

/** Убирает `tabId` из MRU работы; нет такого — та же ссылка. */
export function removeMru(mru: Mru, workKey: string, tabId: string): Mru {
  const current = mru[workKey];
  if (current === undefined) return mru;
  const next = current.filter((id) => id !== tabId);
  if (next.length === current.length) return mru;
  return { ...mru, [workKey]: next };
}
