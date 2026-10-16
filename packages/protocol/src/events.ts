import type { BacklogChanged } from './backlog.js';
import type { CapabilitySnapshot } from './capability-snapshot.js';
import type { FeedItem, SessionActivity } from '@parley/core';
import type { FeedDecisions } from './feed.js';
import type {
  HostNotice,
  RoomMailLetter,
  LiveMetrics,
  ProviderLimits,
  SessionRef,
  WorksSnapshot,
} from './types.js';

/**
 * Признак `hello.features` ОКНА: оно понимает `rooms.mail` и само дочитывает письма. Окно без признака письма в журнал
 * видит прежним путём — хост шлёт ему `works.changed` (карта-журнал, спека 2026-10-16, B4). Хост сообщает об умении
 * слать событие тем же именем в своём `hello.features`.
 */
export const ROOMS_MAIL_FEATURE = 'rooms-mail';

/** Однонаправленные события хоста → клиенту, без ответа. */
export interface Events {
  'backlog.changed': BacklogChanged;
  'capabilities.changed': { projectPath: string; snapshot: CapabilitySnapshot };
  'works.changed': WorksSnapshot;
  /**
   * В журнал писем работы (карта-журнал) дописаны строки. Без `works.changed` и без перечитывания карты: окно дочитывает
   * хвост `context.messages` своей комнаты. `roomId: null` — прямые письма. Текстов в событии нет: будильнику и
   * активности нужны только отправитель и адресаты.
   */
  'rooms.mail': { projectPath: string; workId: string; roomId: string | null; appended: RoomMailLetter[] };
  'activity.changed': { ref: SessionRef; activity: SessionActivity; metrics: LiveMetrics | null };
  'pty.output': { ref: SessionRef; data: string };
  'pty.resync': { ref: SessionRef };
  'pty.exit': { ref: SessionRef; exitCode: number; signal: number | null };
  'host.notice': HostNotice;
  'wake.changed': { paused: boolean };
  /**
   * Изменилось то, что окна знают о провайдере: сохранённый ключ или исход его явной проверки
   * (`providers.list.check`). Каждое окно перечитывает `providers.list`.
   */
  'providers.changed': { provider: string };
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
    decisions?: FeedDecisions | null;
  };
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];
