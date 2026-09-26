/**
 * Лента одной комнаты (кусок 3.6 плана окна, спека 5.1, 6.3): та же лента,
 * что и «вся почта работы» (`lib/mail-view.ts`), только по письмам одной
 * комнаты, с постоянным составом участников (`Room.creator` + `Room.members`,
 * человек — всегда, `Вы`, спецификация 6.1) и заголовком — названием комнаты,
 * а не счётом писем.
 *
 * Построена поверх `mail-view.ts`: `toLetterView`/`recipientsOf`/
 * `isUnreadFor`/`DECISIONS_SHOWN` оттуда же — разбор письма в адресатов и
 * отметку «непрочитано» (`▤`, тест 3 куска) незачем повторять, разница только
 * в фильтре письма по `roomId`.
 */

import type { Room, WorkEntry, WorkMap } from '@harnas/core';
import { participantTag } from './participant-tag.js';
import { DECISIONS_SHOWN, toLetterView, type LetterView } from './mail-view.js';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts` — импортировать можно
// только тип (см. комментарий в `mail-view.ts`/`participant-tag.ts`).
const HUMAN = 'human';

export interface RoomView {
  title: string;
  /** `S01 (Opus 5.5) · S03 (Codex) · Вы` — создатель и участники, человек всегда последним (спека 6.3). */
  participants: string[];
  /** Id сессий-участников (создатель + `members`, без человека) — для поля ввода и приглашения новых. */
  memberIds: string[];
  decisions: { shown: LetterView[]; earlier: number };
  letters: LetterView[];
}

/** `null` — комнаты с таким id в карте нет (например, работа уже другая). */
export function roomView(
  entry: WorkEntry,
  roomId: string,
  providers: Array<{ id: string; label: string }>,
  models: Record<string, string | null>,
): RoomView | null {
  const map: WorkMap = entry.map;
  const room = map.rooms.find((candidate: Room) => candidate.id === roomId);
  if (room === undefined) return null;

  const tag = (id: string): string => participantTag(map, id, models[id] ?? null, providers);

  const messages = map.messages
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => a.at.localeCompare(b.at));
  const letters = messages.map((message) => toLetterView(message, map, tag));

  const memberIds = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  // Человек — участник всегда и в `members` не пишется (спека 6.1) — в шапке
  // он всё равно виден, последним, как в примере спеки 6.3.
  const participants = [...memberIds.map(tag), tag(HUMAN)];

  const decisionLetters = letters.filter((letter) => letter.kind === 'decision');
  const shown = decisionLetters.slice(-DECISIONS_SHOWN);
  const earlier = Math.max(0, decisionLetters.length - DECISIONS_SHOWN);

  return { title: room.title, participants, memberIds, decisions: { shown, earlier }, letters };
}
