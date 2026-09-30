/**
 * Вид «вся почта работы»: письма без комнаты одной лентой (спека 6.4: «письма
 * без комнаты показывает вид «вся почта работы» ... письма с комнатой —
 * уходят в её отдельную ленту»). Комнатную ленту строит
 * `components/rooms/feed-model.ts`; он берёт `recipientsOf`/`DECISIONS_SHOWN` отсюда,
 * чтобы разбор письма в адресатов не дублировать.
 *
 * Перенос `roomView` из `tui/src/room-view.ts` (дизайн комнаты §5) — тот же смысл, что
 * и у прежней «комнаты»: в отличие от треда (`threadOf`) лента не смотрит на
 * выбранную сессию, а берёт все письма и участников работы сразу. Отличия от
 * оригинала:
 *   - здесь нет терминальной ширины/высоты — лента рисуется и прокручивается
 *     в DOM (`MailPanel.tsx`), а не режется построчно под фиксированный экран;
 *   - до куска 3.6 сюда попадали вообще все письма, и с `roomId`, и без — тут
 *     это уже неверно: письма комнаты показывает `components/rooms/feed-model.ts`.
 *
 * `recipientsOf`/`isUnreadFor` перенесены из `core/work/letters.ts` значением:
 * рендерер тянет из `@parley/core` только типы (см. `lib/dot-state.ts`,
 * `lib/participant-tag.ts`) — рантайм модуля идёт через `work/mcp-config.ts`,
 * который трогает `node:fs`, а песочница окна такое не пропускает.
 */

import type { Message, MessageKind, Room, WorkEntry, WorkMap } from '@parley/core';
import { S } from '../../shared/strings.js';
import { participantTag } from './participant-tag.js';
import { treeOrder } from './tree-order.js';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts` (см. комментарий выше
// про `import type`).
const HUMAN = 'human';
const SYSTEM = 'system';

/** Сколько последних решений видно в шапке; старше — строкой «+N раньше» (используется и `components/rooms/feed-model.ts`). */
export const DECISIONS_SHOWN = 5;

/**
 * Адресаты письма: `to`, а у рассылки комнаты (пустой `to`) — все участники,
 * кроме отправителя (спецификация 6.1, перенос из `core/work/letters.ts`).
 */
export function recipientsOf(message: Message, map: WorkMap): string[] {
  if (message.roomId === null || message.to.length > 0) return message.to;
  const room = map.rooms.find((candidate: Room) => candidate.id === message.roomId);
  if (room === undefined) return [];
  const members = new Set([room.creator, ...room.members]);
  members.delete(HUMAN);
  members.delete(message.from);
  return [...members];
}

/** Письмо адресовано сессии, и она его ещё не прочла (перенос из `core/work/letters.ts`). */
export function isUnreadFor(message: Message, sessionId: string, map: WorkMap): boolean {
  return message.readBy[sessionId] === undefined && recipientsOf(message, map).includes(sessionId);
}

/** `ЧЧ:ММ`; битая дата — тире, как `formatClock` из `tui/src/format.ts`. */
function formatClock(timestamp: string): string {
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? '—' : at.toTimeString().slice(0, 5);
}

export interface LetterView {
  id: string;
  time: string;
  from: string;
  to: string;
  kind: MessageKind;
  text: string;
  /** Хотя бы один адресат ещё не прочёл (спецификация 6.3: `▤`). */
  unread: boolean;
}

export interface MailView {
  /** Участники в порядке сайдбара; человек и системные письма — следом, если писали. */
  participants: string[];
  decisions: { shown: LetterView[]; earlier: number };
  letters: LetterView[];
}

/**
 * Одно письмо в строку ленты «всей почты»: разбор адресатов и отметка
 * «непрочитано» — здесь, фильтр по `roomId` — у вызывающей стороны.
 */
export function toLetterView(message: Message, map: WorkMap, tag: (id: string) => string): LetterView {
  const recipients = recipientsOf(message, map);
  // Рассылка комнаты («всем»): пустой `to` у письма с `roomId` — иначе
  // адресат печатался бы поимённо и там, где письмо явно уходило «всем»
  // (дизайн окна 6.3, пример `→ всем`).
  const broadcast = message.roomId !== null && message.to.length === 0;
  return {
    id: message.id,
    time: formatClock(message.at),
    from: tag(message.from),
    to: broadcast ? S.rooms.everyone : recipients.map(tag).join(', '),
    kind: message.kind,
    text: message.text,
    unread: recipients.some((id) => isUnreadFor(message, id, map)),
  };
}

export function mailView(
  entry: WorkEntry,
  providers: Array<{ id: string; label: string }>,
  models: Record<string, string | null>,
): MailView {
  const map = entry.map;
  const tag = (id: string): string => participantTag(map, id, models[id] ?? null, providers);
  // Только письма без комнаты (спека 6.4) — письма комнаты показывает
  // `components/rooms/feed-model.ts`.
  const messages = map.messages.filter((message) => message.roomId === null).sort((a, b) => a.at.localeCompare(b.at));

  const letters = messages.map((message) => toLetterView(message, map, tag));

  // Участники: сессии, встреченные хотя бы в одном письме отправителем или
  // адресатом, в порядке сайдбара (`treeOrder`); человек и системные письма —
  // отдельно следом, раз `treeOrder` про сессии карты ничего про них не знает.
  const seen = new Set<string>();
  for (const message of messages) {
    seen.add(message.from);
    for (const id of recipientsOf(message, map)) seen.add(id);
  }
  const sessionParticipants = treeOrder(map.sessions)
    .map((item) => item.session.id)
    .filter((id) => seen.has(id));
  const participants = [
    ...sessionParticipants,
    ...(seen.has(HUMAN) ? [HUMAN] : []),
    ...(seen.has(SYSTEM) ? [SYSTEM] : []),
  ].map(tag);

  const decisionLetters = letters.filter((letter) => letter.kind === 'decision');
  const shown = decisionLetters.slice(-DECISIONS_SHOWN);
  const earlier = Math.max(0, decisionLetters.length - DECISIONS_SHOWN);

  return { participants, decisions: { shown, earlier }, letters };
}
