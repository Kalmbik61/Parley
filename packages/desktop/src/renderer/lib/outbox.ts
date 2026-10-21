/**
 * Очередь отправки окна (спека 2026-10-16, 4.1): одна на Chat (по сессии) и на комнату (по комнате). Отправленное
 * сразу видно серым и уходит строго по одному в порядке постановки. Окончательный отказ (`failed`) останавливает
 * очередь, пока человек не нажмёт у этого элемента Retry или ×; новые встают за ним. Что значит «отправить» и как
 * разобрать исход — у владельца (`attempt`): ушло, не ушло или «подожди и попробуй тот же элемент снова».
 *
 * Драйвер живёт на уровне модуля, а не в эффекте компонента: вид Chat и вкладка комнаты размонтируются при смене
 * вкладки, а очередь от этого вставать не должна. Хранится в памяти окна; закрытие окна её теряет, как черновик.
 * Свободная очередь начинает попытку синхронно в `enqueue`: вызов моста уходит в том же такте, что и Enter.
 *
 * Владелец может держать очередь затвором (`options.ready`): пока он закрыт, голова остаётся `pending` и не уходит;
 * когда затвор мог открыться, владелец зовёт `kick`. Ждущий элемент (не в полёте) можно убрать (`remove`) или
 * пустить вперёд очереди (`prioritize`).
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

export type OutboxStatus = 'pending' | 'failed' | 'sent';

export interface OutboxItem<P> {
  id: string;
  payload: P;
  /** `pending` — ждёт или в полёте; `failed` — не ушло, очередь стоит; `sent` — ушло, владелец держит до появления в ленте. */
  status: OutboxStatus;
  /** Чем ушло (`sent`): у комнаты — `messageId` письма. */
  sentAs?: string;
}

/** Исход одной попытки. `retry` — подождать `wait()` и попробовать тот же элемент снова. */
export type AttemptResult =
  | { kind: 'sent'; keepAs?: string }
  | { kind: 'failed' }
  | { kind: 'retry'; wait: () => Promise<void> };

export interface OutboxState<P> {
  byKey: Record<string, readonly OutboxItem<P>[]>;
  /** Id элемента в полёте по ключу; нет ключа — очередь свободна. */
  flying: Record<string, string>;
}

export interface Outbox<P> {
  store: UseBoundStore<StoreApi<OutboxState<P>>>;
  /** Поставить в конец; возвращает id. */
  enqueue(key: string, payload: P): string;
  /**
   * `failed` → `pending`, и очередь снова идёт. У прочих статусов — ничего. `patch` сливается в payload элемента перед
   * повтором: так ручной Retry обновляет метку времени отправки (`{ ...payload, ...patch }`).
   */
  retry(key: string, id: string, patch?: Partial<P>): void;
  /** Убрать `failed`, `sent` или ждущий `pending`; элемент в полёте не убирается (спека, 5). */
  remove(key: string, id: string): void;
  /** Ждущий `pending` не в полёте: слить `patch` в payload и поставить следующим на отправку, затем `pump`. Прочее — ничего. */
  prioritize(key: string, id: string, patch?: Partial<P>): void;
  /** Ещё раз попробовать начать попытку: затвор `ready` мог открыться. Занятая или пустая очередь — ничего. */
  kick(key: string): void;
  items(key: string): readonly OutboxItem<P>[];
  /** Только для тестов: пустая очередь, исходы начатых попыток гасятся. */
  resetForTests(): void;
}

const NONE: readonly never[] = [];

export interface OutboxOptions<P> {
  /** Затвор: `false` — голова очереди ещё не может уходить, она остаётся `pending` до `kick`. */
  ready?: (key: string, item: OutboxItem<P>) => boolean;
}

export function createOutbox<P>(
  attempt: (key: string, item: OutboxItem<P>) => Promise<AttemptResult>,
  options: OutboxOptions<P> = {},
): Outbox<P> {
  const store = create<OutboxState<P>>(() => ({ byKey: {}, flying: {} }));
  let nextId = 0;
  /** Поколение: `resetForTests` гасит попытки, начатые до сброса. */
  let epoch = 0;

  const items = (key: string): readonly OutboxItem<P>[] => store.getState().byKey[key] ?? NONE;
  const setItems = (key: string, update: (was: readonly OutboxItem<P>[]) => readonly OutboxItem<P>[]): void =>
    store.setState((state) => ({ byKey: { ...state.byKey, [key]: update(state.byKey[key] ?? NONE) } }));
  const patch = (key: string, id: string, next: Partial<OutboxItem<P>> | null): void =>
    setItems(key, (was) =>
      next === null ? was.filter((item) => item.id !== id) : was.map((item) => (item.id === id ? { ...item, ...next } : item)),
    );
  const setFlying = (key: string, id: string | null): void =>
    store.setState((state) => {
      const flying = { ...state.flying };
      if (id === null) delete flying[key];
      else flying[key] = id;
      return { flying };
    });

  const settle = (key: string, id: string, outcome: AttemptResult): void => {
    if (outcome.kind === 'failed') patch(key, id, { status: 'failed' });
    else if (outcome.kind === 'sent') patch(key, id, outcome.keepAs === undefined ? null : { status: 'sent', sentAs: outcome.keepAs });
    setFlying(key, null);
    pump(key);
  };

  const run = (key: string, id: string, started: number): void => {
    const item = items(key).find((entry) => entry.id === id);
    if (item === undefined) {
      setFlying(key, null);
      pump(key);
      return;
    }
    let result: Promise<AttemptResult>;
    try {
      result = attempt(key, item);
    } catch {
      result = Promise.resolve({ kind: 'failed' });
    }
    void result
      .catch((): AttemptResult => ({ kind: 'failed' }))
      .then(async (outcome) => {
        if (started !== epoch) return;
        if (outcome.kind !== 'retry') {
          settle(key, id, outcome);
          return;
        }
        await outcome.wait().catch(() => undefined);
        if (started === epoch) run(key, id, started);
      });
  };

  function pump(key: string): void {
    if (store.getState().flying[key] !== undefined) return;
    const next = items(key).find((item) => item.status !== 'sent');
    if (next === undefined || next.status === 'failed') return;
    if (options.ready !== undefined && !options.ready(key, next)) return;
    setFlying(key, next.id);
    run(key, next.id, epoch);
  }

  return {
    store,
    enqueue(key, payload) {
      nextId += 1;
      const id = `o${nextId}`;
      setItems(key, (was) => [...was, { id, payload, status: 'pending' }]);
      pump(key);
      return id;
    },
    retry(key, id, payloadPatch) {
      const item = items(key).find((entry) => entry.id === id);
      if (item?.status !== 'failed') return;
      patch(key, id, payloadPatch === undefined ? { status: 'pending' } : { status: 'pending', payload: { ...item.payload, ...payloadPatch } });
      pump(key);
    },
    remove(key, id) {
      const item = items(key).find((entry) => entry.id === id);
      if (item === undefined || (item.status === 'pending' && store.getState().flying[key] === id)) return;
      patch(key, id, null);
      pump(key);
    },
    prioritize(key, id, payloadPatch) {
      const item = items(key).find((entry) => entry.id === id);
      if (item?.status !== 'pending' || store.getState().flying[key] === id) return;
      const moved = payloadPatch === undefined ? item : { ...item, payload: { ...item.payload, ...payloadPatch } };
      const flyingId = store.getState().flying[key];
      setItems(key, (was) => {
        const rest = was.filter((entry) => entry.id !== id);
        // Следующим идёт первый не `sent` после элемента в полёте; при свободной очереди — первый не `sent`.
        const after = flyingId === undefined ? -1 : rest.findIndex((entry) => entry.id === flyingId);
        let at = after + 1;
        while (at < rest.length && rest[at]?.status === 'sent') at += 1;
        return [...rest.slice(0, at), moved, ...rest.slice(at)];
      });
      pump(key);
    },
    kick(key) {
      pump(key);
    },
    items,
    resetForTests() {
      epoch += 1;
      store.setState({ byKey: {}, flying: {} });
    },
  };
}

/** Элементы очереди по ключу для React; пустая — один и тот же массив. */
export function useOutboxItems<P>(outbox: Outbox<P>, key: string): readonly OutboxItem<P>[] {
  return outbox.store((state) => state.byKey[key] ?? NONE);
}

/** Id элемента в полёте по ключу; `null` — очередь свободна. */
export function useOutboxFlying<P>(outbox: Outbox<P>, key: string): string | null {
  return outbox.store((state) => state.flying[key] ?? null);
}
