import { addMessage, maxNumber } from './map.js';
import { sessionMention, sessionTag } from './thread.js';
import { HUMAN, SYSTEM, type Message, type Room, type WorkMap } from './types.js';

/**
 * Нарушено правило комнаты: не участник, не ведущий, комната закрыта, ведущий вне круга.
 * Отдельный класс, как `WorkNotFoundError`: хост отвечает на него `bad_request` — ошибся
 * запрос, а не хост, — а не общим `internal`.
 */
export class RoomRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomRuleError';
  }
}

/**
 * Следующий id комнаты внутри работы: `r-01`, `r-02`, … Счётчик — `work.roomSeq`,
 * а не длина списка: комнаты этот кусок не удаляет, но номер не должен уехать
 * назад, если карту когда-нибудь начнут чистить (тот же приём, что у сессий в
 * `nextSessionId`).
 */
export function nextRoomId(map: WorkMap): string {
  const next =
    Math.max(
      map.work.roomSeq ?? 0,
      maxNumber(
        map.rooms.map((room) => room.id),
        'r-',
      ),
    ) + 1;
  map.work.roomSeq = next;
  return `r-${String(next).padStart(2, '0')}`;
}

export interface NewRoom {
  title: string;
  /** Id сессии-создателя или `human`; создатель — участник, в `members` не пишется. */
  creator: string;
  members: string[];
  /**
   * Ведущий: участник комнаты (создатель-сессия тоже); человек им быть не может. Без него
   * `lead: null` — ведущим считается первый из `members` (`roomLead`).
   */
  lead?: string | null;
}

/** Заводит комнату в карте. */
export function addRoom(map: WorkMap, init: NewRoom, at = new Date().toISOString()): Room {
  const lead = init.lead ?? null;
  // Проверка до `nextRoomId`: отказ не должен тратить номер комнаты.
  if (lead !== null && (lead === HUMAN || !(lead === init.creator || init.members.includes(lead)))) {
    throw new RoomRuleError(`ведущий ${lead} не участник комнаты «${init.title}»`);
  }
  const room: Room = {
    id: nextRoomId(map),
    title: init.title,
    creator: init.creator,
    members: [...init.members],
    createdAt: at,
    lead,
    proposal: null,
  };
  map.rooms.push(room);
  return room;
}

/**
 * Ведущий комнаты: явный `lead`, а у комнат без него — первый из `members`. Так читаются
 * карты до 2026-09-29, и так же считается ведущий, когда назначенный ушёл из комнаты
 * (`leaveOtherRooms` сбрасывает `lead` в `null`). Ни одного участника — ведущего нет.
 */
export function roomLead(room: Room): string | null {
  return room.lead ?? room.members[0] ?? null;
}

/**
 * Закрыта ли комната: в ней не осталось живых участников — каждая сессия создателя и
 * `members` закрыта или уже удалена из карты (человек не сессия и комнату не держит).
 * Отдельного признака «закрыта» у комнаты в карте нет: она закрывается вместе со своими
 * сессиями, и решение в такую комнату приносить некому.
 */
export function isRoomClosed(map: WorkMap, room: Room): boolean {
  const alive = (id: string): boolean =>
    map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
  return ![room.creator, ...room.members].some(alive);
}

/**
 * Правило одной комнаты на сессию (решение 4 дизайна комнат): убирает сессию из всех
 * комнат карты, кроме `exceptRoomId`. Ушедший ведущий оставляет `lead: null`, а создатель-
 * сессия уступает комнату человеку: иначе `isMember` продолжил бы считать её участницей, а
 * `recipientsOf` — адресатом рассылок, то есть она осталась бы в двух комнатах сразу.
 * Ждущее решение ушедшего ведущего остаётся в слоте: человек ответит на него как на любое,
 * а письмо о принятии или возврате пойдёт нынешнему ведущему (`resolveProposal`).
 */
export function leaveOtherRooms(map: WorkMap, sessionId: string, exceptRoomId: string): void {
  for (const room of map.rooms) {
    if (room.id === exceptRoomId) continue;
    room.members = room.members.filter((id) => id !== sessionId);
    if (room.creator === sessionId) room.creator = HUMAN;
    if (room.lead === sessionId) room.lead = null;
  }
}

/**
 * Строка ленты от самого харнесса: «@s04 joined the room», «You accepted the decision».
 * Это существующий механизм системных писем (`from: SYSTEM`, его пишут и `wake-service`, и
 * `sessions-service`), но адресат у строки — человек. Пустой `to` в комнате означал бы
 * рассылку всем участникам: строка легла бы каждому агенту непрочитанной письмом и подняла
 * бы спящих. А человек про действие, которое сам сделал, «непрочитанного» иметь не должен —
 * его отметка стоит с самой записи.
 */
export function addSystemMessage(
  map: WorkMap,
  roomId: string,
  text: string,
  at = new Date().toISOString(),
): Message {
  const message = addMessage(map, { from: SYSTEM, to: [HUMAN], roomId, kind: 'note', text }, at);
  message.readBy[HUMAN] = at;
  return message;
}

/**
 * Человек вводит сессию в комнату (`rooms.addMember`): она уходит из прочих комнат работы
 * (`leaveOtherRooms`), встаёт последней в `members`, а в ленту ложится системная строка
 * «@s04 joined the room». Возвращает эту строку. Закрытая сессия писем не получает и в
 * комнату не входит; уже участник — отказ: окно такой бросок не допускает.
 */
export function addMember(
  map: WorkMap,
  roomId: string,
  sessionId: string,
  at = new Date().toISOString(),
): Message {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new RoomRuleError(`комнаты ${roomId} нет в карте`);
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new RoomRuleError(`сессии ${sessionId} нет в карте`);
  if (session.lifecycle === 'closed') throw new RoomRuleError(`сессия ${sessionId} закрыта`);
  if (isMember(room, sessionId)) {
    throw new RoomRuleError(`сессия ${sessionId} уже участник комнаты ${roomId}`);
  }

  leaveOtherRooms(map, sessionId, roomId);
  room.members.push(sessionId);
  return addSystemMessage(map, roomId, `${sessionMention(sessionId)} joined the room`, at);
}

/**
 * Участник ли комнаты: создатель — всегда, человек — всегда (спецификация 6.1:
 * «человек — участник всегда и в список не пишется»), иначе — по списку `members`.
 */
export function isMember(room: Room, id: string): boolean {
  return id === HUMAN || id === room.creator || room.members.includes(id);
}

/** Список тегов через запятую, последний — через «и»: `S03`, `S03 и S05`. */
function joinTags(tags: readonly string[]): string {
  if (tags.length <= 1) return tags[0] ?? '';
  return `${tags.slice(0, -1).join(', ')} и ${tags[tags.length - 1]}`;
}

/**
 * Тег участника для письма-приглашения: короткий `S03`, а не ярлык роли — письмо
 * это не бриф, а быстрая пометка «кто ещё здесь» (спецификация 6.2).  Участника,
 * которого успели удалить между записями, помечаем отдельно: он есть в списке
 * комнаты навсегда (раздел 10), но откликнуться уже не может.
 */
function memberTag(map: WorkMap, id: string): string {
  const deleted = (map.work.deletedSessions ?? []).includes(id);
  return deleted ? `${sessionTag(id)} (удалена)` : sessionTag(id);
}

/** Текст письма-приглашения в комнату: «Вас добавили в r-01 «<title>» с S03 и S05». */
export function joinNotice(room: Room, map: WorkMap): string {
  const tags = room.members.map((id) => memberTag(map, id));
  return `Вас добавили в ${room.id} «${room.title}» с ${joinTags(tags)}`;
}

/**
 * Потомок ли сессия `id` по цепочке `parent` от `ancestor`. Сессия себе не
 * потомок: `close_session` разрешает цель либо равенством себе, либо этой
 * проверкой — смешивать их незачем.
 */
export function isDescendant(map: WorkMap, ancestor: string, id: string): boolean {
  const byId = new Map(map.sessions.map((session) => [session.id, session]));
  let current = byId.get(id);
  while (current !== undefined && current.parent !== null) {
    if (current.parent === ancestor) return true;
    current = byId.get(current.parent);
  }
  return false;
}
