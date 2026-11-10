import { cancelledPlanLetter } from './plan-effects.js';
import { maxNumber } from './map.js';
import { isRoomArchived } from './rooms.js';
import { HUMAN, type Message, type WindowWorkMap, type WorkMap } from './types.js';

/** Письмо по номеру: правила непрочитанного ищут письмо, из-за которого эффект плана жив или отменён (письма не в карте). */
export type LetterLookup = (id: string) => Message | undefined;

/**
 * Адресаты письма: `to`, а у рассылки комнаты (пустой `to`) — все участники,
 * кроме отправителя (спецификация 6.1). Создатель комнаты тоже участник, даже
 * если в `members` его не записали. Человек в адресаты не попадает: он не
 * сессия и читает всё, отметка прочтения ему не нужна. Рассылка не адресована участнику, вошедшему не раньше неё
 * (`room.joinedSeq`: номер новейшего письма комнаты при входе); письма с явным `to` порог не трогает. Письма архивной комнаты
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
  const joinedSeq = room.joinedSeq;
  if (joinedSeq === undefined) return [...members];
  const seq = maxNumber([message.id], 'm-');
  return [...members].filter((id) => (joinedSeq[id] ?? 0) < seq);
}

/**
 * Письмо адресовано сессии, и она его ещё не прочла — отметка у каждого своя. `byId` — поиск письма по номеру для
 * `cancelledPlanLetter`: хранимая карта писем не содержит (спека хранилища 6.2).
 */
export const isUnreadFor = (message: Message, sessionId: string, map: WorkMap, byId: LetterLookup): boolean =>
  message.readBy[sessionId] === undefined && !cancelledPlanLetter(map, message, byId) && recipientsOf(message, map).includes(sessionId);

/** Поиск письма по номеру в самой карте с письмами; первое письмо с таким номером, как `find`. */
export function lookupIn(map: Pick<WindowWorkMap, 'messages'>): LetterLookup {
  let index: Map<string, Message> | undefined;
  return (id) => {
    if (index === undefined) {
      index = new Map();
      for (const message of map.messages) if (!index.has(message.id)) index.set(message.id, message);
    }
    return index.get(id);
  };
}

/**
 * Читатель — закрытая сессия карты. Возврата из `closed` нет (`TRANSITIONS`), поэтому у закрытого читателя нет непрочитанного
 * и кандидатов; `recipientsOf` его по-прежнему считает адресатом: на него опираются вид треда и бюджеты.
 */
export const isClosedReader = (map: WorkMap, id: string): boolean =>
  map.sessions.some((session) => session.id === id && session.lifecycle === 'closed');

/** Непрочитанные письма сессии в порядке карты — правила над картой с письмами (окно, сверка переезда, тесты). */
export function unreadFor(map: WindowWorkMap, sessionId: string): Message[] {
  if (isClosedReader(map, sessionId)) return [];
  const byId = lookupIn(map);
  return map.messages.filter((message) => isUnreadFor(message, sessionId, map, byId));
}

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
