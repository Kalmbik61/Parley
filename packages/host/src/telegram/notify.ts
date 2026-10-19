/**
 * Поводы для сообщений бота: что изменилось с прошлого снимка. Функции чистые, состояние (`NotifyMemory`) держит вызывающий.
 * Первый вызов только запоминает базу — после старта хоста бот не засыпает человека тем, что было до него.
 */

import path from 'node:path';
import { humanUnreadLetters, humanUnreadMentions, plainHumanMention, roomAwaitsDecision } from '@parley/core/attention';
import { sessionDotState, type Activity } from '@parley/core/session-state';
import { ACCEPTED_LETTER, RETURNED_LETTER, type Message, type Room, type SessionActivity, type WorkEntry, type WorkSession } from '@parley/core';
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

/** Переход сессии в «нужен ты» или «не просмотрено». Первое значение сессии — база, повтор того же уровня — не повод. */
export function activityTransition(memory: NotifyMemory, ref: SessionRef, session: WorkSession, live: SessionActivity | null): 'needs-you' | 'unseen' | null {
  const dot = sessionDotState(session, live?.activity ?? null);
  const level: Activity | 'closed' = dot === 'working' || dot === 'blocked' || dot === 'unseen' || dot === 'idle' ? dot : 'closed';
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

/** Чем кончилось решение, которого в слоте больше нет: по последнему письму человека в комнате. */
function closedAs(entry: WorkEntry, roomId: string): 'accepted' | 'returned' | 'gone' {
  const last = [...entry.map.messages].reverse().find((message) => message.roomId === roomId && message.from === 'human');
  if (last === undefined) return 'gone';
  if (last.text === ACCEPTED_LETTER || last.text === 'Completion accepted.') return 'accepted';
  return last.text.startsWith(RETURNED_LETTER) ? 'returned' : 'gone';
}

export function worksTriggers(memory: NotifyMemory, snapshot: WorksSnapshot, hasMention: (text: string) => boolean = plainHumanMention): WorksTriggers {
  const result: WorksTriggers = { letters: [], decisions: [], closed: [] };
  const first = memory.letters === null;
  const seenLetters = memory.letters ?? new Set<string>();
  const nextLetters = new Set<string>();
  const currentDecisions = new Map<string, { id: string; rev: number }>();
  const entries = new Map<string, WorkEntry>();

  for (const entry of snapshot.entries) {
    const { map } = entry;
    entries.set(`${entry.projectPath}\u0000${map.work.id}`, entry);

    for (const message of [...humanUnreadLetters(map), ...humanUnreadMentions(map, hasMention)]) {
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
        result.closed.push({ entry, roomId: room.id, previous, now: closedAs(entry, room.id) });
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
      if (entry !== undefined) result.closed.push({ entry, roomId, previous, now: closedAs(entry, roomId) });
    }
  }

  memory.letters = nextLetters;
  memory.decisions = currentDecisions;
  return result;
}
