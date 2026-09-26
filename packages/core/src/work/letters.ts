import { HUMAN, type Message, type WorkMap } from './types.js';

/**
 * Адресаты письма: `to`, а у рассылки комнаты (пустой `to`) — все участники,
 * кроме отправителя (спецификация 6.1). Создатель комнаты тоже участник, даже
 * если в `members` его не записали. Человек в адресаты не попадает: он не
 * сессия и читает всё, отметка прочтения ему не нужна.
 */
export function recipientsOf(message: Message, map: WorkMap): string[] {
  if (message.roomId === null || message.to.length > 0) return message.to;
  const room = map.rooms.find((candidate) => candidate.id === message.roomId);
  if (room === undefined) return [];
  const members = new Set([room.creator, ...room.members]);
  members.delete(HUMAN);
  members.delete(message.from);
  return [...members];
}

/** Письмо адресовано сессии, и она его ещё не прочла — отметка у каждого своя. */
export const isUnreadFor = (message: Message, sessionId: string, map: WorkMap): boolean =>
  message.readBy[sessionId] === undefined && recipientsOf(message, map).includes(sessionId);

/** Непрочитанные письма сессии в порядке карты. */
export const unreadFor = (map: WorkMap, sessionId: string): Message[] =>
  map.messages.filter((message) => isUnreadFor(message, sessionId, map));
