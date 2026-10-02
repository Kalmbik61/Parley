/**
 * Хуки ленты вида «Chat» (план 2026-10-01, Task 3). Подписку держит слой поверхностей работы
 * (`layout/SurfaceLayer.tsx`) на каждую вкладку сессии в виде «Chat» — открытую, а не только
 * активную в группе: переход между вкладками ленту не переподписывает. Читает ленту `ChatView`.
 */

import { useEffect } from 'react';
import { refKey, type SessionRef } from '@parley/protocol';
import { useFeedStore, type FeedEntry } from './store.js';

/** Лента сессии открыта, пока смонтирован вызвавший компонент. */
export function useFeedSubscription(ref: SessionRef): void {
  const key = refKey(ref);
  useEffect(() => {
    const { open, close } = useFeedStore.getState();
    open(ref);
    return () => close(ref);
    // `ref` по значению — его ключ; новый литерал с теми же полями ленту не переоткрывает.
  }, [key]);
}

/** Лента сессии; `null` — ещё не открыта или хост ленты не знает. */
export function useFeed(ref: SessionRef): FeedEntry | null {
  const key = refKey(ref);
  return useFeedStore((state) => state.feeds[key] ?? null);
}

/** Пустой компонент подписки — по одному на вкладку в виде «Chat» в слое поверхностей. */
export function FeedSubscription({ sessionRef }: { sessionRef: SessionRef }): null {
  useFeedSubscription(sessionRef);
  return null;
}
