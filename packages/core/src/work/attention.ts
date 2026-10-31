/**
 * Внимание сессий и работ: где нужен человек. Чистые предикаты, которые окно и хост считают одинаково
 * (хост по ним решает, когда писать в Telegram). Раньше они жили в `desktop/renderer/attention/derive.ts`.
 *
 * Модуль чистый: ни Node-импортов, ни значений из других файлов core (только типы). Поэтому его берёт и окно через
 * подпуть `@parley/core/attention`, как `@parley/core/session-state`. Разбор `@human` по Markdown остался в окне:
 * упоминание распознаёт функция, которую передаёт вызывающий (`hasMention`); хосту без Markdown годится `plainHumanMention`.
 */

import type { SessionActivity } from './activity.js';
import type { SessionNeed } from './stuck.js';
import type { Message, Room, WindowWorkMap, WorkSession } from './types.js';

// Те же литералы, что `HUMAN` и `SYSTEM` в `types.ts`: значения не импортируем, чтобы модуль остался чистым.
const HUMAN = 'human';
const SYSTEM = 'system';
// Те же слова письма человека ведущему, что `ACCEPTED_LETTER` и `RETURNED_LETTER` в `proposals.ts` (тот модуль тянет карту, а
// этот должен остаться чистым). Сходство держит тест `attention.test.ts`.
const ACCEPTED_LETTER = 'Decision accepted.';
const RETURNED_LETTER = 'Returned for rework';

export type Attention = 'needs-you' | 'unseen' | 'working' | 'idle' | 'off';

export const ATTENTION_RANK: Record<Attention, 4 | 3 | 2 | 1 | 0> = {
  'needs-you': 4,
  unseen: 3,
  working: 2,
  idle: 1,
  off: 0,
};

// Копия `isRoomArchived` из `rooms.ts`: тот модуль тянет диск. Проверка по строке: комната без `archivedAt` открыта.
const isArchived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';

/**
 * Ждёт ли комната решения человека: в слоте `Room.proposal` лежит решение ведущего. У комнаты карты без поля
 * `proposal` это «не ждёт». Архивная комната решения не ждёт: хост очищает слот при архивации, а правило страхует
 * карту, где слот всё же остался.
 */
export function roomAwaitsDecision(room: Room): boolean {
  return !isArchived(room) && (room.proposal ?? null) !== null;
}

/**
 * Чего живая сессия ждёт от человека (`SessionActivity.need`, спека застрявших 3.1). У спящей, ожидающей запуска и
 * закрытой — `null`: процесса нет, ждать человека в терминале некому, а запись активности могла остаться от прошлого
 * процесса. У хоста прежней версии поля нет — тоже `null` (спека застрявших 8, п. 10).
 */
export function sessionNeed(session: Pick<WorkSession, 'lifecycle'>, live: SessionActivity | null): SessionNeed | null {
  return session.lifecycle === 'active' ? (live?.need ?? null) : null;
}

/** Таблица спеки 7.1. */
export function sessionAttention(session: Pick<WorkSession, 'lifecycle'>, live: SessionActivity | null): Attention {
  if (session.lifecycle === 'closed') return 'off';
  // pending и sleeping: процесса нет, но сессия не закрыта.
  if (session.lifecycle !== 'active') return 'idle';
  // `need` — «нужен ты» до разбора activity: лимит и вход оставляют ход законченным (`unseen`/`idle`), но человеку
  // всё равно пора вмешаться (спека застрявших 7.3; `!= null` — у хоста прежней версии поля нет).
  if (live?.need != null) return 'needs-you';
  switch (live?.activity ?? 'idle') {
    case 'blocked':
      return 'needs-you';
    case 'unseen':
      return 'unseen';
    case 'working':
      return 'working';
    default:
      return 'idle';
  }
}

/**
 * Не прочитано человеком по правилам 3.2: письмо ему или сообщение комнаты, не от него, без
 * readBy.human. То же правило, что `unreadForHuman` в `letters.ts` (`mail.markRead` хоста).
 */
export function isHumanUnread(message: Message): boolean {
  return (
    message.from !== HUMAN &&
    message.readBy[HUMAN] === undefined &&
    (message.roomId !== null || message.to.includes(HUMAN))
  );
}

/**
 * Сообщение комнаты, где человека назвали: не от него и не от хоста, а в тексте `@human` по правилу `hasMention`.
 * Окно передаёт разбор Markdown, которым лента рисует чип «@you»; хост — `plainHumanMention`. Прочитано оно или нет,
 * решает `isHumanUnread`.
 */
export function isHumanMention(message: Message, hasMention: (text: string) => boolean): boolean {
  return (
    message.roomId !== null &&
    message.from !== HUMAN &&
    message.from !== SYSTEM &&
    hasMention(message.text)
  );
}

/**
 * Прямые письма человеку (roomId === null) с isHumanUnread. Упоминания в комнатах сюда не входят — их берёт
 * `humanUnreadMentions`.
 */
export function humanUnreadLetters(map: Pick<WindowWorkMap, 'messages'>): Message[] {
  return map.messages.filter((message) => message.roomId === null && isHumanUnread(message));
}

/**
 * Упоминания человека в комнатах с isHumanUnread, в порядке карты: последнее — самое позднее. Архивная комната
 * не источник внимания: её старые упоминания не считаются.
 */
export function humanUnreadMentions(map: Pick<WindowWorkMap, 'messages' | 'rooms'>, hasMention: (text: string) => boolean): Message[] {
  const archived = new Set(map.rooms.filter(isArchived).map((room) => room.id));
  return map.messages.filter(
    (message) =>
      isHumanUnread(message) &&
      isHumanMention(message, hasMention) &&
      !(message.roomId !== null && archived.has(message.roomId)),
  );
}

/** `@human` в простом тексте, без Markdown: не часть слова и не адрес (`mail@humanity.org` не считается). */
export function plainHumanMention(text: string): boolean {
  return /(^|[^\w@])@human\b/i.test(text);
}

/**
 * Чем человек ответил на решение комнаты, по тексту его письма ведущему (`resolveProposal`): `accepted` — письмо
 * `Decision accepted.` целиком, `returned` — любое, что начинается с `Returned for rework` (дальше заметка), прочее —
 * `null`. Решение, которого слова нет в письме, ответом не считается. Окно (`derive.ts`) и хост (снимок без писем,
 * спека rooms.mail 6.8) берут слова отсюда.
 */
export function humanDecisionOutcome(text: string): 'accepted' | 'returned' | null {
  if (text === ACCEPTED_LETTER) return 'accepted';
  return text.startsWith(RETURNED_LETTER) ? 'returned' : null;
}

// ---- «Нужен ты» для телефона: бейдж приложения и повод push (спека мобильного приложения 9.2) ----

/**
 * Вход счётчика «нужен ты»: поля работы, одинаковые у карты хоста (`needsYouWorkOfMap`) и у проекции для телефона
 * (`RemoteWork`: `id` → `workId`, `archived`, `proposal`, число непрочитанных прямых писем). Окну счётчик не нужен: его
 * бейдж считает упоминания и `unseen` иначе.
 */
export interface NeedsYouWork {
  projectPath: string;
  workId: string;
  /** Архивная работа в счёт не входит (как в бейдже окна, `attentionTotals`). */
  archived: boolean;
  sessions: ReadonlyArray<{ id: string; lifecycle: WorkSession['lifecycle'] }>;
  rooms: ReadonlyArray<{ id: string; archived: boolean; proposal: { id: string; rev: number } | null }>;
  /** Непрочитанные человеком прямые письма работы (`rooms[''].unread` карты v2; у v1 — `unread.letters`). */
  unreadLetters: number;
}

/** Последняя активность сессии: `null` — записи нет. */
export type NeedsYouActivity = (projectPath: string, workId: string, sessionId: string) => SessionActivity | null;

/** Пункт счётчика. Ключи без номера входа: его ведёт тот, кто шлёт push (мост помнит, сколько раз сессия входила в `needs-you`). */
export type NeedsYouItem =
  | { kind: 'session'; key: string; projectPath: string; workId: string; sessionId: string }
  | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; proposalId: string; rev: number }
  | { kind: 'letters'; key: string; projectPath: string; workId: string; unread: number };

/**
 * Ждущие человека пункты: сессии с `sessionAttention === 'needs-you'` (`blocked` или `need`), открытые комнаты с решением
 * (`roomAwaitsDecision`) и, по одному пункту на работу, непрочитанные прямые письма. Упоминания `@human` в комнатах не входят.
 */
export function needsYouItems(works: readonly NeedsYouWork[], activityOf: NeedsYouActivity): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const work of works) {
    if (work.archived) continue;
    const { projectPath, workId } = work;
    for (const session of work.sessions) {
      if (sessionAttention(session, activityOf(projectPath, workId, session.id)) === 'needs-you') {
        items.push({ kind: 'session', key: `session:${projectPath}\u0000${workId}\u0000${session.id}`, projectPath, workId, sessionId: session.id });
      }
    }
    for (const room of work.rooms) {
      if (room.archived || room.proposal === null) continue;
      items.push({
        kind: 'room',
        key: `room:${projectPath}\u0000${workId}\u0000${room.id}:${room.proposal.id}:${room.proposal.rev}`,
        projectPath,
        workId,
        roomId: room.id,
        proposalId: room.proposal.id,
        rev: room.proposal.rev,
      });
    }
    if (work.unreadLetters > 0) items.push({ kind: 'letters', key: `letters:${projectPath}\u0000${workId}`, projectPath, workId, unread: work.unreadLetters });
  }
  return items;
}

/** Число в push и на бейдже: сессии и решения по одному, письма — их число. */
export function needsYouCount(works: readonly NeedsYouWork[], activityOf: NeedsYouActivity): number {
  return needsYouItems(works, activityOf).reduce((sum, item) => sum + (item.kind === 'letters' ? item.unread : 1), 0);
}

/** Карта хоста → вход счётчика. Непрочитанные письма — как в проекции: счётчик компактной карты, без неё — по письмам. */
export function needsYouWorkOfMap(projectPath: string, map: WindowWorkMap): NeedsYouWork {
  const compact = map.compact;
  const unreadLetters =
    compact === undefined
      ? humanUnreadLetters(map).length
      : compact.version === 2
        ? (compact.rooms['']?.unread ?? 0)
        : compact.messages.rooms[''] === undefined
          ? 0
          : compact.unread.letters;
  return {
    projectPath,
    workId: map.work.id,
    archived: map.work.status === 'archived',
    sessions: map.sessions,
    rooms: map.rooms.map((room) => ({
      id: room.id,
      archived: isArchived(room),
      proposal: room.proposal ? { id: room.proposal.id, rev: room.proposal.rev } : null,
    })),
    unreadLetters,
  };
}
