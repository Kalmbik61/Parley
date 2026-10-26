/**
 * Поводы для сообщений бота: что изменилось с прошлого снимка. Состояние (`NotifyMemory`) держит вызывающий; письма берутся
 * через `TriggerLetters` (по умолчанию — непрочитанное по карте снимка, последнее письмо человека из базы работы), остальное чистое.
 * Первый вызов только запоминает базу — после старта хоста бот не засыпает человека тем, что было до него.
 */

import path from 'node:path';
import { humanUnreadLetters, humanUnreadMentions, plainHumanMention, roomAwaitsDecision, sessionNeed } from '@parley/core/attention';
import { sessionDotState, type Activity } from '@parley/core/session-state';
import {
  ACCEPTED_LETTER,
  HUMAN,
  readLetters,
  RETURNED_LETTER,
  unreadLetters,
  WorkNotFoundError,
  type Message,
  type Room,
  type SessionActivity,
  type WorkEntry,
  type WorkSession,
} from '@parley/core';
import { refKey, type SessionRef, type WorksSnapshot } from '@parley/protocol';

export interface NotifyMemory {
  /** Уровень сессии по `refKey`; `closed` — точка не показывает activity (закрыта, спит, итог). */
  levels: Map<string, Activity | 'closed'>;
  /** Id писем и упоминаний, которые уже видели; `null` — снимка ещё не было. */
  letters: Set<string> | null;
  /** Решение в слоте комнаты по `проект\0работа\0комната`. */
  decisions: Map<string, { id: string; rev: number }>;
}

export function emptyMemory(): NotifyMemory {
  return { levels: new Map(), letters: null, decisions: new Map() };
}

/**
 * Переход сессии в «нужен ты» или «не просмотрено». Первое значение сессии — база, повтор того же уровня — не повод.
 * Живая сессия с `need` — «нужен ты», как в окне (`sessionAttention`, спека подписок К16): лимит и слетевший вход
 * оставляют ход законченным, но человеку пора вмешаться.
 */
export function activityTransition(memory: NotifyMemory, ref: SessionRef, session: WorkSession, live: SessionActivity | null): 'needs-you' | 'unseen' | null {
  const dot = sessionDotState(session, live?.activity ?? null);
  const level: Activity | 'closed' =
    sessionNeed(session, live) !== null ? 'blocked' : dot === 'working' || dot === 'blocked' || dot === 'unseen' || dot === 'idle' ? dot : 'closed';
  const key = refKey(ref);
  const previous = memory.levels.get(key);
  memory.levels.set(key, level);
  if (previous === undefined || previous === level) return null;
  if (level === 'blocked') return 'needs-you';
  if (level === 'unseen') return 'unseen';
  return null;
}

export interface WorksTriggers {
  /** Новые письма человеку (roomId === null) и упоминания в комнатах. */
  letters: Array<{ entry: WorkEntry; message: Message }>;
  decisions: Array<{ entry: WorkEntry; room: Room; change: 'new' | 'revised' }>;
  closed: Array<{ entry: WorkEntry; roomId: string; previous: { id: string; rev: number }; now: 'accepted' | 'returned' | 'revised' | 'gone' }>;
}

/** `Parley · my_harnas`: название работы и папка проекта. */
export function sessionWhere(entry: WorkEntry): string {
  return `${entry.map.work.title} · ${path.basename(entry.projectPath)}`;
}

const decisionKey = (entry: WorkEntry, roomId: string): string => `${entry.projectPath}\u0000${entry.map.work.id}\u0000${roomId}`;

/**
 * Письма для поводов: непрочитанное человеком и последнее письмо человека в комнате (спека хранилища 6.2). По умолчанию
 * непрочитанное считается по карте снимка (`worksTriggers` зовётся на каждое изменение работ, и карты из базы при числе
 * работ больше кэша каждый раз грузились бы заново), последнее письмо читается из базы работы — оно нужно редко.
 * Тесты подставляют чтение из карты в памяти.
 */
export interface TriggerLetters {
  humanUnread(entry: WorkEntry): Message[];
  lastHumanLetter(entry: WorkEntry, roomId: string): Message | undefined;
}

/** Работу могли удалить, пока её запись ещё в снимке: последнего письма тогда нет, а не сбой рассылки. */
function orGone<T>(read: () => T, gone: T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof WorkNotFoundError) return gone;
    throw error;
  }
}

export const storeTriggerLetters: TriggerLetters = {
  humanUnread: (entry) => unreadLetters(entry.projectPath, entry.map.work.id, HUMAN, { map: entry.map }),
  lastHumanLetter: (entry, roomId) =>
    orGone(() => readLetters(entry.projectPath, entry.map.work.id, { roomId, from: HUMAN, limit: 1, newestFirst: true })[0], undefined),
};

/** Чем кончилось решение, которого в слоте больше нет: по последнему письму человека в комнате. */
function closedAs(entry: WorkEntry, roomId: string, letters: TriggerLetters): 'accepted' | 'returned' | 'gone' {
  const last = letters.lastHumanLetter(entry, roomId);
  if (last === undefined) return 'gone';
  // 'Completion accepted.' — литерал из core/src/work/proposals.ts (acceptProposal): константы для него в core нет.
  if (last.text === ACCEPTED_LETTER || last.text === 'Completion accepted.') return 'accepted';
  return last.text.startsWith(RETURNED_LETTER) ? 'returned' : 'gone';
}

export function worksTriggers(
  memory: NotifyMemory,
  snapshot: WorksSnapshot,
  hasMention: (text: string) => boolean = plainHumanMention,
  letters: TriggerLetters = storeTriggerLetters,
): WorksTriggers {
  const result: WorksTriggers = { letters: [], decisions: [], closed: [] };
  const first = memory.letters === null;
  const seenLetters = memory.letters ?? new Set<string>();
  const nextLetters = new Set<string>();
  const currentDecisions = new Map<string, { id: string; rev: number }>();
  const entries = new Map<string, WorkEntry>();

  for (const entry of snapshot.entries) {
    const { map } = entry;
    entries.set(`${entry.projectPath}\u0000${map.work.id}`, entry);

    // Правила внимания — core по карте с непрочитанным человеком: письма в снимке работ могли быть сжаты или отсутствовать.
    const unread = { ...map, messages: letters.humanUnread(entry) };
    for (const message of [...humanUnreadLetters(unread), ...humanUnreadMentions(unread, hasMention)]) {
      const key = `${entry.projectPath}\u0000${map.work.id}\u0000${message.id}`;
      if (nextLetters.has(key)) continue;
      nextLetters.add(key);
      if (!first && !seenLetters.has(key)) result.letters.push({ entry, message });
    }

    for (const room of map.rooms) {
      const proposal = room.proposal;
      if (!roomAwaitsDecision(room) || proposal === null) continue;
      const key = decisionKey(entry, room.id);
      const slot = { id: proposal.id, rev: proposal.rev };
      currentDecisions.set(key, slot);
      const previous = memory.decisions.get(key);
      if (first || (previous !== undefined && previous.id === slot.id && previous.rev >= slot.rev)) continue;
      if (previous === undefined) {
        result.decisions.push({ entry, room, change: 'new' });
      } else if (previous.id === slot.id) {
        result.decisions.push({ entry, room, change: 'revised' });
        result.closed.push({ entry, roomId: room.id, previous, now: 'revised' });
      } else {
        result.closed.push({ entry, roomId: room.id, previous, now: closedAs(entry, room.id, letters) });
        result.decisions.push({ entry, room, change: 'new' });
      }
    }
  }

  // Слот опустел: карточка в Telegram закрывается итогом. Работа, пропавшая из снимка целиком, закрыть нечем — её забываем.
  if (!first) {
    for (const [key, previous] of memory.decisions) {
      if (currentDecisions.has(key)) continue;
      const [projectPath, workId, roomId] = key.split('\u0000') as [string, string, string];
      const entry = entries.get(`${projectPath}\u0000${workId}`);
      if (entry !== undefined) result.closed.push({ entry, roomId, previous, now: closedAs(entry, roomId, letters) });
    }
  }

  memory.letters = nextLetters;
  memory.decisions = currentDecisions;
  return result;
}
