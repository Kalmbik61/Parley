import type { CapabilitySnapshot } from './capability-snapshot.js';
import type { FeedItem, SessionActivity } from '@parley/core';
import type {
  HostNotice,
  LiveMetrics,
  ProviderLimits,
  SessionRef,
  WorksSnapshot,
} from './types.js';

/** Однонаправленные события хоста → клиенту, без ответа. */
export interface Events {
  'capabilities.changed': { projectPath: string; snapshot: CapabilitySnapshot };
  'works.changed': WorksSnapshot;
  'activity.changed': { ref: SessionRef; activity: SessionActivity; metrics: LiveMetrics | null };
  'pty.output': { ref: SessionRef; data: string };
  'pty.resync': { ref: SessionRef };
  'pty.exit': { ref: SessionRef; exitCode: number; signal: number | null };
  'host.notice': HostNotice;
  'wake.changed': { paused: boolean };
  /**
   * Лимиты подписки провайдера изменились (спека комнат Organic, 3.5): одно событие на
   * провайдера; `null` — данных больше нет или окна сбросились.
   */
  'providers.limitsChanged': { id: string; limits: ProviderLimits | null };
  /**
   * Дельта ленты сессии (план 2026-10-01, Task 2) — только подписчикам `feed.subscribe`. `upsert` —
   * новые и изменённые элементы, `removed` — `id` вытесненных из кольца; `revision` идёт подряд за
   * `revision` снимка. `mode` — текущий режим разрешений ленты (может прийти и без элементов).
   */
  'feed.changed': {
    ref: SessionRef;
    revision: number;
    upsert: FeedItem[];
    removed: string[];
    mode: string | null;
  };
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];
