// Состояние телефона на одном хосте (спека §10.1): снимок-проекция, активность, ждущие карточки, письма.
// Только типы и пустое состояние; переходы — `reducer.ts`, производные — `inbox.ts` и `works-view.ts`.
import type { FeedCard, Message, RoleList, SessionActivity } from '@parley/core';
import type { Result, SessionRef } from '@parley/protocol';
import type { RemoteWorksSnapshot } from '@parley/protocol/remote';

export type { SessionRef };

export type HostStatus = 'starting' | 'online' | 'offline' | 'incompatible';

/** Ключ сессии для карт состояния (`\u0000` в путях и id не встречается). */
export const sessionKey = (ref: SessionRef): string => `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;
/** Ключ работы. */
export const workKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/** Запись кэша активности моста: `{ref, activity, metrics}` (§5.5). */
export interface ActivityEntry {
  ref: SessionRef;
  activity: SessionActivity;
  metrics: unknown;
}

/** Результат последнего чтения `feed.snapshot {scope:'attention'}` одной сессии. */
export interface CardsEntry {
  /** Ждущие карточки по порядку ленты. */
  cards: FeedCard[];
  /** Последний ответ модели в ответе хоста; `null` — его нет. */
  lastReply: { id: string; text: string; at: string; streaming: boolean } | null;
  /** Время чтения (мс, часы клиента): по нему круг Inbox берёт самых давних. */
  readAt: number;
  /** Последнее чтение не удалось: строка Inbox «Couldn't load the request». */
  error: boolean;
}

/** «Answered at your Mac»: карточка пропала из ответа хоста. UI показывает её 2 с и зовёт `gone.dismiss`. */
export interface GoneCard {
  sessionKey: string;
  cardId: string;
  card: FeedCard;
  at: number;
}

/** Каталог провайдеров запуска (`providers.list`). */
export type ProviderCatalog = Result<'providers.list'>;

/** Ссылка на комнату. */
export interface RoomRef {
  projectPath: string;
  workId: string;
  roomId: string;
}

/** Ключ комнаты для черновиков. */
export const roomKey = (r: RoomRef): string => `${r.projectPath}\u0000${r.workId}\u0000${r.roomId}`;

export interface RemoteState {
  /** Текущая эпоха моста; `null` — ещё не пришла или хост без эпохи. */
  epoch: string | null;
  /** `null` — `bridge.status` ещё не приходил. */
  hostStatus: HostStatus | null;
  snapshot: RemoteWorksSnapshot | null;
  activity: Record<string, ActivityEntry>;
  cards: Record<string, CardsEntry>;
  /** Прямые письма человеку по работам (`roomId === null`): `workKey` → `id` → письмо. */
  letters: Record<string, Record<string, Message>>;
  /** Непрочитанные прямые письма по работам: число из последнего применённого снимка или `rooms.mail`. */
  letterUnread: Record<string, number>;
  /** Ключ — `sessionKey` + `\u0000` + `cardId`. */
  gone: Record<string, GoneCard>;
  /**
   * Карточки, решённые с телефона: `goneKey` → время решения. Чтение, начатое не позже него, их не возвращает и в `gone`
   * не кладёт (устаревший ответ). Запись уходит с первым чтением, начатым позже решения.
   */
  resolved: Record<string, number>;
  /** Методы из hello моста (пересечение с хостом эпохи): по ним UI решает, показывать ли запуск и письмо. `null` — hello нет. */
  methods: string[] | null;
  /** `providers.list`; `null` — не загружен. Сбрасывается с эпохой. */
  providers: ProviderCatalog | null;
  /** `roles.list` по проектам. Сбрасывается с эпохой. */
  roles: Record<string, RoleList>;
  /** Черновики писем в комнату по `roomKey`: живут, пока письмо не принято хостом (и переживают эпоху). */
  drafts: Record<string, string>;
}

export const initialRemoteState = (): RemoteState => ({
  epoch: null,
  hostStatus: null,
  snapshot: null,
  activity: {},
  cards: {},
  letters: {},
  letterUnread: {},
  gone: {},
  resolved: {},
  methods: null,
  providers: null,
  roles: {},
  drafts: {},
});

export const goneKey = (sKey: string, cardId: string): string => `${sKey}\u0000${cardId}`;
