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
 * Решения человека (`decide`, кусок 4a, решение П): пока запрос в пути, повторный клик по той же
 * карточке игнорируется (`deciding`); `applied: true` — ждём дельту, карточка сменит состояние сама (снимок
 * забывает `deciding`, пометки и черновики только у карточек, что в нём не `pending` или пропали);
 * `applied: false` при `pending` — хук ещё не удержан, строка «попробуй ещё раз» (`notes`); ошибка —
 * строка «не отправилось». Ни повторов, ни умолчаний по таймеру: ответ хуку — только кликом человека.
 *
 * Ошибка subscribe/snapshot оставляет ленту в `error`, пока человек не нажмёт «Retry» в ноте ленты
 * (`retry`: subscribe → snapshot заново) или окно не переподключится. Сам стор не повторяет: хост,
 * отказавший раз, скорее всего откажет и через секунду.
 */

import { create } from 'zustand';
import type { FeedDecision, FeedItem } from '@parley/core';
import { refKey, type EventData, type FeedDecisions, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { hostMethods } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { cardKey, useChatUiStore } from './ui-store.js';

export type FeedStatus = 'loading' | 'ready' | 'error';

export interface FeedEntry {
  items: FeedItem[];
  revision: number;
  /** Режим разрешений сессии (сырая строка CLI) из снимка и дельт; `null` — не известен (кусок 4a, решение К). */
  mode: string | null;
  /** Кто ответит на одобрения: `window`, `terminal` (Codex без одобренных хуков); `null` — хост не сказал (спека 2026-10-07, 5.7). */
  decisions: FeedDecisions | null;
  status: FeedStatus;
  /** Сообщение отказа хоста — только для консоли и отладки; человеку — `S.chat.feedUnavailable`. */
  error?: string;
}

/** Пометка под кнопками карточки после неудачного решения. */
export type CardNote = 'not-applied' | 'failed';

export interface FeedState {
  feeds: Record<string /* refKey */, FeedEntry>;
  /** Карточки, чьё решение в пути (по `cardKey`). */
  deciding: Record<string, true>;
  /** Пометки карточек (по `cardKey`). */
  notes: Record<string, CardNote>;
  /** Мост подключения и подписка на `feed.changed`; возвращает отписку. Зовётся на каждый `connected`. */
  init(bridge: ParleyBridge): () => void;
  /** Вкладка сессии открыла вид «Chat». */
  open(ref: SessionRef): void;
  /** Вкладка закрылась или ушла в терминал. */
  close(ref: SessionRef): void;
  /** Повторить subscribe → snapshot открытой ленты (кнопка «Retry» после ошибки). */
  retry(ref: SessionRef): void;
  /** Решение человека по карточке (`feed.decide`); ждёт ответа хоста, но не дельты. */
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Promise<void>;
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

  /** Забыть решения в пути и пометки карточек; `only` — только эти `cardId` сессии, иначе всей сессии. */
  const forgetCards = (sessionKey: string, only?: readonly string[]): void =>
    set((state) => {
      const prefix = `${sessionKey}\n`;
      const drop = (key: string): boolean => (only === undefined ? key.startsWith(prefix) : only.some((id) => key === cardKey(sessionKey, id)));
      const deciding = Object.keys(state.deciding).some(drop)
        ? Object.fromEntries(Object.entries(state.deciding).filter(([key]) => !drop(key)))
        : state.deciding;
      const notes = Object.keys(state.notes).some(drop)
        ? Object.fromEntries(Object.entries(state.notes).filter(([key]) => !drop(key)))
        : state.notes;
      return deciding === state.deciding && notes === state.notes ? state : { deciding, notes };
    });

  /** Карточка перестала быть `pending` (дельта, снимок): забыть её решение, пометку и черновик. */
  const settleCards = (sessionKey: string, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    forgetCards(sessionKey, ids);
    useChatUiStore.getState().clearCardDrafts(sessionKey, ids);
  };

  /**
   * Снимок применён: забыть состояние карточек, которых в снимке нет или которые больше не `pending`.
   * Решение в пути у карточки, всё ещё ждущей человека, остаётся — иначе кнопки вернулись бы под
   * идущий запрос.
   */
  const settleAfterSnapshot = (sessionKey: string, items: readonly FeedItem[]): void => {
    const prefix = `${sessionKey}\n`;
    const pending = new Set(items.filter((item) => 'cardId' in item && item.state === 'pending').map((item) => item.id));
    const known = [
      ...Object.keys(get().deciding),
      ...Object.keys(get().notes),
      ...Object.keys(useChatUiStore.getState().cardDrafts),
    ]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    settleCards(sessionKey, [...new Set(known)].filter((id) => !pending.has(id)));
  };

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
    patch(key, { items: prev?.items ?? [], revision: prev?.revision ?? 0, mode: prev?.mode ?? null, decisions: prev?.decisions ?? null, status: 'loading' });
    current
      .call('feed.subscribe', { ref: feed.ref })
      .then(() => (stale() ? null : current.call('feed.snapshot', { ref: feed.ref })))
      .then((snapshot) => {
        if (snapshot === null || stale()) return;
        feed.loading = false;
        patch(key, { items: snapshot.items, revision: snapshot.revision, mode: snapshot.mode, decisions: snapshot.decisions ?? null, status: 'ready' });
        settleAfterSnapshot(key, snapshot.items);
      })
      .catch((error: unknown) => {
        if (stale()) return;
        feed.loading = false;
        const { message } = decodeIpcError(error);
        console.warn('[parley] feed', message);
        const was = get().feeds[key];
        patch(key, { items: was?.items ?? [], revision: was?.revision ?? 0, mode: was?.mode ?? null, decisions: was?.decisions ?? null, status: 'error', error: message });
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
    patch(key, {
      ...entry,
      items: applyDelta(entry.items, delta.upsert, delta.removed),
      revision: delta.revision,
      mode: delta.mode,
      decisions: delta.decisions === undefined ? entry.decisions : delta.decisions,
    });
    // Карточка сменила состояние или ушла — её решение, пометка и черновик своё отслужили.
    const settled = delta.upsert.filter((item) => 'cardId' in item && item.state !== 'pending').map((item) => item.id);
    settleCards(key, [...settled, ...delta.removed]);
  };

  return {
    feeds: {},
    deciding: {},
    notes: {},
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
      forgetCards(key);
      useChatUiStore.getState().clearCardDrafts(key);
      if (bridge !== null && hostHasFeed()) {
        bridge.call('feed.unsubscribe', { ref: feed.ref }).catch((error: unknown) => {
          console.warn('[parley] feed.unsubscribe', decodeIpcError(error).message);
        });
      }
    },
    retry: (ref) => load(refKey(ref)),
    decide: async (ref, cardId, decision) => {
      const current = bridge;
      if (current === null || !hostMethods(useHostStore.getState().status).has('feed.decide')) return;
      const sessionKey = refKey(ref);
      const key = cardKey(sessionKey, cardId);
      if (get().deciding[key] === true) return;
      set((state) => ({
        deciding: { ...state.deciding, [key]: true },
        notes: Object.fromEntries(Object.entries(state.notes).filter(([noted]) => noted !== key)),
      }));
      const release = (note: CardNote | null): void =>
        set((state) => ({
          deciding: Object.fromEntries(Object.entries(state.deciding).filter(([busy]) => busy !== key)),
          notes: note === null ? state.notes : { ...state.notes, [key]: note },
        }));
      try {
        const result = await current.call('feed.decide', { ref, cardId, decision });
        // Применено — карточка сменит состояние дельтой, она же снимет `deciding`.
        if (result.applied) return;
        release(result.state === 'pending' ? 'not-applied' : null);
      } catch (error: unknown) {
        console.warn('[parley] feed.decide', decodeIpcError(error).message);
        release('failed');
      }
    },
  };
});

/** Только для тестов: забыть мост и открытые ленты между тестами. */
export function resetFeedStoreForTests(): void {
  bridge = null;
  opened.clear();
  useFeedStore.setState({ feeds: {}, deciding: {}, notes: {} });
}
