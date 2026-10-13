/**
 * Очередь запросов острова (спека 2026-10-12, раздел 6). Сессия Claude или GLM перешла в «ждёт» — разовый
 * `feed.snapshot` и в очередь все её ждущие карточки; карточки ещё нет (хук ложится позже активности) — один повтор
 * через `ASK_RETRY_MS` и новый снимок при каждом следующем изменении активности этой сессии, пока она ждёт.
 * Сессия перестала ждать — её карточки уходят. Порядок — по времени перехода в «ждёт», внутри сессии — по ленте.
 *
 * На ленты остров не подписывается: подписки на хосте общие на клиента-main, и отписка острова оборвала бы ленту
 * главного окна. Поэтому и решение — свой `feed.decide`, а не `useFeedStore.decide`: тот держит «решается» до дельты
 * ленты, которой у острова нет. `applied: false` при `state: 'pending'` — хук ещё не удержан, запрос всё ещё ждёт
 * (как «not-applied» в `chat/store.ts`): пометка «failed», карточка остаётся, кнопки снова доступны. Прочее
 * `applied: false` и `not_found` — на карточку уже ответили в другом месте: пометка на `ELSEWHERE_MS` и уход;
 * прочая ошибка — пометка «failed», кнопки снова доступны.
 */

import { create } from 'zustand';
import type { FeedCard, FeedDecision, WorkEntry } from '@parley/core';
import { refKey, type Result, type SessionRef } from '@parley/protocol';
import { ISLAND_EXCLUDED_PROVIDERS, type IslandBridge } from '../../shared/island.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { askSummary, pendingCards } from '../attention/ask-summary.js';
import { sessionAttention } from '../attention/derive.js';
import type { ActivityEntry } from '../store/activity.js';

export const ASK_RETRY_MS = 500;
export const ELSEWHERE_MS = 1000;

export interface IslandRequest {
  /** `refKey` сессии и `cardId` через `\0`. */
  key: string;
  ref: SessionRef;
  card: FeedCard;
  summary: string;
  /** Ответить можно из Parley (Codex с одобрениями в терминале — нет). */
  inWindow: boolean;
  since: number;
  deciding: boolean;
  note: 'elsewhere' | 'failed' | null;
}

interface IslandRequestsState {
  items: IslandRequest[];
  index: number;
  waitingSince: Record<string, number>;
  bind(call: IslandBridge['call'] | null): void;
  select(index: number): void;
  sync(entries: readonly WorkEntry[], byRef: Readonly<Record<string, ActivityEntry>>): void;
  decide(key: string, decision: FeedDecision): Promise<void>;
  clear(): void;
}

let call: IslandBridge['call'] | null = null;
/** Последняя запись активности ждущей сессии: новая — повод снять снимок заново. */
const lastSeen = new Map<string, ActivityEntry | undefined>();

const clampIndex = (index: number, length: number): number => (length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1));

export const useIslandRequests = create<IslandRequestsState>((set, get) => {
  const patch = (key: string, change: Partial<IslandRequest>): void =>
    set((state) => ({ items: state.items.map((item) => (item.key === key ? { ...item, ...change } : item)) }));
  const remove = (key: string): void =>
    set((state) => {
      const items = state.items.filter((item) => item.key !== key);
      return { items, index: clampIndex(state.index, items.length) };
    });

  const fetchCards = async (ref: SessionRef, retry: boolean): Promise<void> => {
    const current = call;
    if (current === null) return;
    const sessionKey = refKey(ref);
    let snapshot: Result<'feed.snapshot'> | null;
    try {
      snapshot = await current('feed.snapshot', { ref });
    } catch {
      snapshot = null;
    }
    // Сессия за время запроса перестала ждать — снимок уже не нужен.
    const since = get().waitingSince[sessionKey];
    if (since === undefined) return;
    const cards = snapshot === null ? [] : pendingCards(snapshot.items);
    if (cards.length === 0) {
      if (retry) setTimeout(() => void fetchCards(ref, false), ASK_RETRY_MS);
      return;
    }
    const inWindow = snapshot?.decisions !== 'terminal';
    set((state) => {
      const known = new Map(state.items.map((item) => [item.key, item]));
      const mine = cards.map((card): IslandRequest => {
        const key = `${sessionKey}\u0000${card.cardId}`;
        return known.get(key) ?? { key, ref, card, summary: askSummary(card, ref.projectPath), inWindow, since, deciding: false, note: null };
      });
      const items = [...state.items.filter((item) => refKey(item.ref) !== sessionKey), ...mine].sort((a, b) => a.since - b.since);
      return { items, index: clampIndex(state.index, items.length) };
    });
  };

  return {
    items: [],
    index: 0,
    waitingSince: {},
    bind: (next) => {
      call = next;
    },
    select: (index) => set((state) => ({ index: clampIndex(index, state.items.length) })),
    sync: (entries, byRef) => {
      const now = Date.now();
      const before = get().waitingSince;
      const waitingSince: Record<string, number> = {};
      const toFetch: SessionRef[] = [];
      for (const entry of entries) {
        for (const session of entry.map.sessions) {
          if (ISLAND_EXCLUDED_PROVIDERS.has(session.provider)) continue;
          const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
          const key = refKey(ref);
          if (sessionAttention(session, byRef[key]?.activity ?? null) !== 'needs-you') continue;
          waitingSince[key] = before[key] ?? now;
          if (before[key] === undefined || lastSeen.get(key) !== byRef[key]) toFetch.push(ref);
          lastSeen.set(key, byRef[key]);
        }
      }
      for (const key of [...lastSeen.keys()]) if (waitingSince[key] === undefined) lastSeen.delete(key);
      set((state) => {
        const items = state.items.filter((item) => waitingSince[refKey(item.ref)] !== undefined);
        return { waitingSince, items, index: clampIndex(state.index, items.length) };
      });
      for (const ref of toFetch) void fetchCards(ref, true);
    },
    decide: async (key, decision) => {
      const item = get().items.find((candidate) => candidate.key === key);
      const current = call;
      if (item === undefined || current === null || item.deciding) return;
      patch(key, { deciding: true, note: null });
      try {
        const result = await current('feed.decide', { ref: item.ref, cardId: item.card.cardId, decision });
        if (result.applied) {
          remove(key);
          return;
        }
        if (result.state === 'pending') {
          patch(key, { deciding: false, note: 'failed' });
          return;
        }
        patch(key, { deciding: false, note: 'elsewhere' });
      } catch (error: unknown) {
        if (decodeIpcError(error).code !== 'not_found') {
          patch(key, { deciding: false, note: 'failed' });
          return;
        }
        patch(key, { deciding: false, note: 'elsewhere' });
      }
      setTimeout(() => remove(key), ELSEWHERE_MS);
    },
    clear: () => {
      lastSeen.clear();
      set({ items: [], index: 0, waitingSince: {} });
    },
  };
});
