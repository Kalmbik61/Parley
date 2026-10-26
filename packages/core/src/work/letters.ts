import { cancelledPlanLetter } from './plan-effects.js';
import { isRoomArchived } from './rooms.js';
import { HUMAN, type Message, type WorkMap } from './types.js';

/**
 * Адресаты письма: `to`, а у рассылки комнаты (пустой `to`) — все участники,
 * кроме отправителя (спецификация 6.1). Создатель комнаты тоже участник, даже
 * если в `members` его не записали. Человек в адресаты не попадает: он не
 * сессия и читает всё, отметка прочтения ему не нужна. Письма архивной комнаты
 * адресатов не имеют, и с явным `to` тоже: старая лента непрочитанной не считается
 * и сессий не будит (архив комнат, 3.4).
 */
export function recipientsOf(message: Message, map: WorkMap): string[] {
  if (message.roomId === null) return message.to;
  const room = map.rooms.find((candidate) => candidate.id === message.roomId);
  if (room !== undefined && isRoomArchived(room)) return [];
  if (message.to.length > 0) return message.to;
  if (room === undefined) return [];
  const members = new Set(room.members);
  members.delete(HUMAN);
  members.delete(message.from);
  return [...members];
}

/** Письмо адресовано сессии, и она его ещё не прочла — отметка у каждого своя. */
export const isUnreadFor = (message: Message, sessionId: string, map: WorkMap): boolean =>
  message.readBy[sessionId] === undefined && !cancelledPlanLetter(map, message) && recipientsOf(message, map).includes(sessionId);

/** Непрочитанные письма сессии в порядке карты. */
export const unreadFor = (map: WorkMap, sessionId: string): Message[] =>
  map.messages.filter((message) => isUnreadFor(message, sessionId, map));

/**
 * Письмо, которое человек видит и ещё не прочёл: прямое письмо ему или сообщение
 * комнаты (человек — участник любой комнаты), не от него самого. То же правило, что
 * `humanUnreadLetters` и `roomUnreadForHuman` окна (`attention/derive.ts`): иначе
 * отметка гасила бы не то, что окно считает непрочитанным.
 */
export const unreadForHuman = (message: Message): boolean =>
  message.from !== HUMAN &&
  message.readBy[HUMAN] === undefined &&
  (message.roomId !== null || message.to.includes(HUMAN));
