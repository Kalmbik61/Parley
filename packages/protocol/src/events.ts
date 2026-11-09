import type { AssistantCardChanged, AssistantJobChanged, AssistantState } from './assistant.js';
import type { TelegramStatus } from './telegram.js';
import type { ConsentCard } from './consents.js';
import type { BacklogChanged } from './backlog.js';
import type { BrowserAgentOpEvent } from './browser-agent.js';
import type { CapabilitySnapshot } from './capability-snapshot.js';
import type { FeedItem, SessionActivity } from '@parley/core';
import type { FeedDecisions } from './feed.js';
import type { SessionProcessesSnapshot } from './processes.js';
import type {
  CapacitySnapshot,
  HostNotice,
  LiveMetrics,
  ProviderLimits,
  RoomsMailEvent,
  SessionRef,
  WorksSnapshot,
} from './types.js';
import type { WorksSyncInvalidated } from './works-sync.js';
import type { CardsEvents } from './remote/cards.js';
import type { VoiceEvents } from './remote/voice.js';

/** Однонаправленные события хоста → клиенту, без ответа. */
export interface Events {
  'backlog.changed': BacklogChanged;
  'capabilities.changed': { projectPath: string; snapshot: CapabilitySnapshot };
  'works.changed': WorksSnapshot;
  /**
   * Более новая структурная версия работ (спека 2026-11-01): только клиентам с признаком `works-sync`,
   * вместо подталкивания снимком. Почтовые изменения (mail-only) событие не порождают — им остаётся
   * `rooms.mail`. Клиент замечает wanted-ревизию и вытягивает `works.sync`.
   */
  'works.invalidated': WorksSyncInvalidated;
  /** Письма одной работы за пачку, только окнам с признаком `rooms-mail` (спека rooms.mail 6.3). */
  'rooms.mail': RoomsMailEvent;
  'activity.changed': { ref: SessionRef; activity: SessionActivity; metrics: LiveMetrics | null };
  'pty.output': { ref: SessionRef; data: string };
  'pty.resync': { ref: SessionRef };
  /** Заменяющий снимок процессов сессии — только подписчикам `processes.subscribe`. */
  'processes.changed': SessionProcessesSnapshot;
  'pty.exit': { ref: SessionRef; exitCode: number; signal: number | null };
  'host.notice': HostNotice;
  'wake.changed': { paused: boolean };
  /** Изменились числа ёмкости машины или очередь запусков (не чаще раза в `CAPACITY_PUBLISH_MS` хоста). */
  'capacity.changed': CapacitySnapshot;
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
   * Вывод процесса входа в аккаунт подписки (спека подписок 5.5): сырые данные PTY для xterm окна.
   * Отдельный путь от `pty.output`: у входа нет `SessionRef`.
   */
  'providers.signInOutput': { provider: string; data: string };
  /** Процесс входа завершился; `signedIn` — исход `providers.authStatus` сразу после выхода (спека подписок 5.5). */
  'providers.signInExit': { provider: string; exitCode: number; signedIn: boolean };
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
  /**
   * Операция агента над браузером окна (спека браузера 2026-10-07, 3.7): только клиенту с возможностью
   * `browser-agent` в `hello.features`, одному. Ответ — метод `browser.agentResult` с тем же `opId`.
   */
  'browser.agentOp': BrowserAgentOpEvent;
  'assistant.changed': AssistantState;
  'assistant.job.changed': AssistantJobChanged;
  'assistant.card.changed': AssistantCardChanged;
  /** Телефону: job помощника в проекции без логов и argv (план голоса, B3). */
  'jobs.changed': VoiceEvents['jobs.changed'];
  /** Телефону: карточка помощника в проекции без payload (T4a). */
  'cards.changed': CardsEvents['cards.changed'];
  /** Телефону: голосовая сессия закрыта (любая причина). */
  'voice.session.closed': VoiceEvents['voice.session.closed'];
  'telegram.changed': TelegramStatus;
  /**
   * Изменились карточки согласий (спека 2026-10-21, 4.4): `upsert` — новые и изменённые, `removed` — `id` решённых
   * и снятых. Окна, остров и Telegram по нему показывают и закрывают карточку «доверять ли папке».
   */
  'consents.changed': { upsert: ConsentCard[]; removed: string[] };
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];
