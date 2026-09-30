import type { SessionActivity } from '@parley/core';
import type {
  HostNotice,
  LiveMetrics,
  ProviderLimits,
  SessionRef,
  WorksSnapshot,
} from './types.js';

/** Однонаправленные события хоста → клиенту, без ответа. */
export interface Events {
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
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];
