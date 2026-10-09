import { readMap, updateMap, WorkNotFoundError, workPaths } from './store.js';
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
  const members = new Set([room.creator, ...room.members]);
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

/**
 * Ставит readBy.human = now письмам, которые человек видит: прямым письмам человеку
 * и сообщениям комнат, не от самого человека. Уже прочитанные и чужие id пропускаются.
 * Возвращает, сколько отметок поставлено. work.updatedAt не сдвигается.
 * Подходящих id нет — 0 без updateMap: карта, индекс и .bak не переписываются.
 * Карты нет — WorkNotFoundError, как у updateMap.
 */
export async function markHumanRead(
  projectPath: string,
  workId: string,
  messageIds: string[],
): Promise<number> {
  const wanted = new Set(messageIds);
  const pending = (map: WorkMap): Message[] =>
    map.messages.filter((message) => wanted.has(message.id) && unreadForHuman(message));

  // Сперва чтение без лока: updateMap пишет индекс, .bak и карту всегда, и повтор
  // пачки окна разослал бы works.changed всем клиентам впустую.
  let current: WorkMap;
  try {
    current = await readMap(projectPath, workId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkNotFoundError(`map ${workPaths(projectPath, workId).map} does not exist — workspace ${workId} does not exist`);
    }
    throw error;
  }
  if (pending(current).length === 0) return 0;

  // Под локом отбираем заново: другой клиент мог отметить часть писем между чтениями.
  let marked = 0;
  await updateMap(
    projectPath,
    workId,
    (map) => {
      const at = new Date().toISOString();
      const fresh = pending(map);
      for (const message of fresh) message.readBy[HUMAN] = at;
      marked = fresh.length;
    },
    { touch: false },
  );
  return marked;
}
