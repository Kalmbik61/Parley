/**
 * Ленты сессий вида «Chat» (план 2026-10-01, Task 3, решение контролёра З). Ключ — `refKey` сессии.
 *
 * Лента открыта, пока открыта хотя бы одна вкладка сессии в виде «Chat» (`open`/`close` со счётчиком:
 * две вкладки одной сессии — одна подписка). Открытие — `feed.subscribe`, затем `feed.snapshot`: в
 * этом порядке дельта между ними не теряется. Снимок даёт `revision` r; дельта `feed.changed` r+1
 * применяется (upsert по id: новые — в конец в порядке массива, известные — на месте; `removed`
 * удаляет), дельта ≤ r отбрасывается, дельта > r+1 — разрыв: снимок заново, а дельты до его прихода
 * отбрасываются. Закрытие последней вкладки — `feed.unsubscribe` (и после ошибки тоже).
 *
 * Мост — из `init`, который `App` зовёт на каждый статус `connected`: одна подписка на
 * `feed.changed` на стор, а открытые ленты после переподключения подписываются и берут снимок
 * заново (хост забыл подписки ушедшего клиента). Хост без `feed.snapshot` — стор ничего не зовёт.
 * Решений (`feed.decide`) кусок 3 не шлёт вовсе (решение контролёра И).
 *
 * Ошибка subscribe/snapshot оставляет ленту в `error`, пока человек не нажмёт «Retry» в ноте ленты
 * (`retry`: subscribe → snapshot заново) или окно не переподключится. Сам стор не повторяет: хост,
 * отказавший раз, скорее всего откажет и через секунду.
 */

import { create } from 'zustand';
import type { FeedItem } from '@parley/core';
import { refKey, type EventData, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { hostMethods } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';

export type FeedStatus = 'loading' | 'ready' | 'error';

export interface FeedEntry {
  items: FeedItem[];
  revision: number;
  status: FeedStatus;
  /** Сообщение отказа хоста — только для консоли и отладки; человеку — `S.chat.feedUnavailable`. */
  error?: string;
}

export interface FeedState {
  feeds: Record<string /* refKey */, FeedEntry>;
  /** Мост подключения и подписка на `feed.changed`; возвращает отписку. Зовётся на каждый `connected`. */
  init(bridge: ParleyBridge): () => void;
  /** Вкладка сессии открыла вид «Chat». */
  open(ref: SessionRef): void;
  /** Вкладка закрылась или ушла в терминал. */
  close(ref: SessionRef): void;
  /** Повторить subscribe → snapshot открытой ленты (кнопка «Retry» после ошибки). */
  retry(ref: SessionRef): void;
}

interface Opened {
  ref: SessionRef;
  count: number;
  /** Растёт на каждую загрузку и закрытие: ответ устаревшей загрузки отбрасывается. */
  generation: number;
  /** Снимок в пути — дельты отбрасываются. */
  loading: boolean;
}

let bridge: ParleyBridge | null = null;
const opened = new Map<string, Opened>();

function hostHasFeed(): boolean {
  return hostMethods(useHostStore.getState().status).has('feed.snapshot');
}

/** Дельта r+1 поверх элементов: upsert по id (новые — в конец, известные — на месте), затем `removed`. */
export function applyDelta(items: readonly FeedItem[], upsert: readonly FeedItem[], removed: readonly string[]): FeedItem[] {
  const next = [...items];
  const index = new Map(next.map((item, at) => [item.id, at]));
  for (const item of upsert) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
  }
  if (removed.length === 0) return next;
  const gone = new Set(removed);
  return next.filter((item) => !gone.has(item.id));
}

export const useFeedStore = create<FeedState>((set, get) => {
  const patch = (key: string, entry: FeedEntry | null): void =>
    set((state) => {
      if (entry === null) {
        if (!(key in state.feeds)) return state;
        return { feeds: Object.fromEntries(Object.entries(state.feeds).filter(([entryKey]) => entryKey !== key)) };
      }
      return { feeds: { ...state.feeds, [key]: entry } };
    });

  /** subscribe → snapshot; ответ устаревшего поколения или чужого моста не применяется. */
  const load = (key: string): void => {
    const feed = opened.get(key);
    const current = bridge;
    if (feed === undefined || current === null || !hostHasFeed()) return;
    feed.generation += 1;
    feed.loading = true;
    const generation = feed.generation;
    const stale = (): boolean => opened.get(key) !== feed || feed.generation !== generation || bridge !== current;
    const prev = get().feeds[key];
    patch(key, { items: prev?.items ?? [], revision: prev?.revision ?? 0, status: 'loading' });
    current
      .call('feed.subscribe', { ref: feed.ref })
      .then(() => (stale() ? null : current.call('feed.snapshot', { ref: feed.ref })))
      .then((snapshot) => {
        if (snapshot === null || stale()) return;
        feed.loading = false;
        patch(key, { items: snapshot.items, revision: snapshot.revision, status: 'ready' });
      })
      .catch((error: unknown) => {
        if (stale()) return;
        feed.loading = false;
        const { message } = decodeIpcError(error);
        console.warn('[parley] feed', message);
        const was = get().feeds[key];
        patch(key, { items: was?.items ?? [], revision: was?.revision ?? 0, status: 'error', error: message });
      });
  };

  const onChanged = (delta: EventData<'feed.changed'>): void => {
    const key = refKey(delta.ref);
    const feed = opened.get(key);
    const entry = get().feeds[key];
    if (feed === undefined || feed.loading || entry === undefined || entry.status !== 'ready') return;
    if (delta.revision <= entry.revision) return;
    if (delta.revision > entry.revision + 1) {
      load(key);
      return;
    }
    patch(key, { ...entry, items: applyDelta(entry.items, delta.upsert, delta.removed), revision: delta.revision });
  };

  return {
    feeds: {},
    init: (next) => {
      bridge = next;
      const off = next.on('feed.changed', onChanged);
      for (const key of opened.keys()) load(key);
      return () => {
        off();
        if (bridge === next) bridge = null;
      };
    },
    open: (ref) => {
      const key = refKey(ref);
      const feed = opened.get(key);
      if (feed !== undefined) {
        feed.count += 1;
        return;
      }
      opened.set(key, { ref, count: 1, generation: 0, loading: false });
      load(key);
    },
    close: (ref) => {
      const key = refKey(ref);
      const feed = opened.get(key);
      if (feed === undefined) return;
      feed.count -= 1;
      if (feed.count > 0) return;
      opened.delete(key);
      feed.generation += 1;
      patch(key, null);
      if (bridge !== null && hostHasFeed()) {
        bridge.call('feed.unsubscribe', { ref: feed.ref }).catch((error: unknown) => {
          console.warn('[parley] feed.unsubscribe', decodeIpcError(error).message);
        });
      }
    },
    retry: (ref) => load(refKey(ref)),
  };
});

/** Только для тестов: забыть мост и открытые ленты между тестами. */
export function resetFeedStoreForTests(): void {
  bridge = null;
  opened.clear();
  useFeedStore.setState({ feeds: {} });
}
