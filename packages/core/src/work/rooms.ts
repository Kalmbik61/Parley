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
    throw new RoomRuleError(`lead ${lead} is not a participant of room "${init.title}"`);
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
 * Ведущий комнаты по записи: явный `lead`, а у комнат без него — первый из `members`. Так читаются
 * карты до 2026-09-29, и так же считается ведущий, когда назначенный ушёл из комнаты
 * (`leaveOtherRooms` сбрасывает `lead` в `null`). Ни одного участника — ведущего нет. Это только
 * запись: кто может действовать, когда назначенный закрыт, решает `liveLead`.
 */
export function roomLead(room: Room): string | null {
  return room.lead ?? room.members[0] ?? null;
}

/** Жива ли сессия: есть в карте и не закрыта. Закрытая и удалённая из карты — нет; человек не сессия. */
function isAlive(map: WorkMap, id: string): boolean {
  return map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
}

/**
 * Закрыта ли комната: в ней не осталось живых участников — каждая сессия создателя и
 * `members` закрыта или уже удалена из карты (человек не сессия и комнату не держит).
 * Отдельного признака «закрыта» у комнаты в карте нет: она закрывается вместе со своими
 * сессиями, и решение в такую комнату приносить некому.
 */
export function isRoomClosed(map: WorkMap, room: Room): boolean {
  return ![room.creator, ...room.members].some((id) => isAlive(map, id));
}

/**
 * Ведущий, который может действовать: `roomLead`, если он жив, а иначе первый живой из `members`
 * и за ним создатель-сессия. `closed` из карты не откатывается, а `removeSession` не убирает id
 * из `members` — и сменить ведущего нечем. Без подмены комната с ушедшим ведущим осталась бы без
 * права на решение навсегда: `setProposal` не пустил бы никого. Ведущего нет ровно тогда, когда
 * комната закрыта (`isRoomClosed`): круг тот же — создатель и `members`. Запись комнаты
 * (`lead`, `members`) подмена не переписывает.
 */
export function liveLead(map: WorkMap, room: Room): string | null {
  const declared = roomLead(room);
  if (declared !== null && isAlive(map, declared)) return declared;
  return [...room.members, room.creator].find((id) => isAlive(map, id)) ?? null;
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
 * комнату не входит.
 *
 * Отказ «уже участник» — только если сессия состоит в этой комнате и больше нигде: окно такой
 * бросок не допускает. В старой карте (решение 4) она может состоять в нескольких комнатах, а
 * сайдбар ставит её в самую раннюю. Бросок на позднюю, где она по записи тоже участница, — как
 * раз лекарство: из прочих комнат она уходит, а в этой остаётся одной записью, не двумя
 * (создатель-сессия в `members` не пишется вовсе: он и так участник).
 */
export function addMember(
  map: WorkMap,
  roomId: string,
  sessionId: string,
  at = new Date().toISOString(),
): Message {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new RoomRuleError(`room ${roomId} is not in the map`);
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new RoomRuleError(`session ${sessionId} is not in the map`);
  if (session.lifecycle === 'closed') throw new RoomRuleError(`session ${sessionId} is closed`);

  const inRoom = isMember(room, sessionId);
  const elsewhere = map.rooms.some((other) => other.id !== roomId && isMember(other, sessionId));
  if (inRoom && !elsewhere) {
    throw new RoomRuleError(`session ${sessionId} is already a participant of room ${roomId}`);
  }

  leaveOtherRooms(map, sessionId, roomId);
  if (!inRoom) room.members.push(sessionId);
  return addSystemMessage(map, roomId, `${sessionMention(sessionId)} joined the room`, at);
}

/**
 * Ведущий вводит сессию в свою комнату (MCP `add_to_room`). Правила `addMember` те же — закрытая,
 * чужая (нет в карте этой работы) сессия, уже участник, одна комната на сессию, системная строка
 * «@s04 joined the room», — плюс два своих: комната живая и вводит тот, кто ведёт её сейчас
 * (`liveLead`: назначенный, пока жив, иначе первый живой участник). Порядок проверок как у
 * `setProposal`: у закрытой комнаты ведущего нет вовсе, и отказ «закрыта» точнее, чем «не ведущий».
 * Письма о добавлении новому участнику `addMember` не пишет — как и при `rooms.addMember` из окна.
 */
export function addMemberByLead(
  map: WorkMap,
  roomId: string,
  leadId: string,
  sessionId: string,
  at = new Date().toISOString(),
): Message {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new RoomRuleError(`room ${roomId} is not in the map`);
  if (isRoomClosed(map, room)) {
    throw new RoomRuleError(`room ${roomId} is closed: it has no live participants`);
  }
  if (liveLead(map, room) !== leadId) {
    throw new RoomRuleError(
      `session ${leadId} is not the lead of room ${roomId}: only the lead can bring a session into the room`,
    );
  }
  return addMember(map, roomId, sessionId, at);
}

/**
 * Системная строка «Room created from @s03 and @s02»: комнату собрали из двух сессий, уже
 * идущих в работе (дизайн комнат, 2.5, диалог 1.6). Писать её может только хост, поэтому окно
 * присылает пару в `rooms.create.origin`. Порядок пары — порядок в строке. Как и прочие системные
 * строки, никого не будит и человеку непрочитанной не значится (`addSystemMessage`).
 */
export function addRoomOriginMessage(
  map: WorkMap,
  roomId: string,
  origin: readonly [string, string],
  at = new Date().toISOString(),
): Message {
  const [first, second] = origin;
  const text = `Room created from ${sessionMention(first)} and ${sessionMention(second)}`;
  return addSystemMessage(map, roomId, text, at);
}

/**
 * Участник ли комнаты: создатель — всегда, человек — всегда (спецификация 6.1:
 * «человек — участник всегда и в список не пишется»), иначе — по списку `members`.
 */
export function isMember(room: Room, id: string): boolean {
  return id === HUMAN || id === room.creator || room.members.includes(id);
}

/** Список тегов через запятую, последний — через `and`: `S03`, `S03 and S05`. */
function joinTags(tags: readonly string[]): string {
  if (tags.length <= 1) return tags[0] ?? '';
  return `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

/**
 * Тег участника для письма-приглашения: короткий `S03`, а не ярлык роли — письмо
 * это не бриф, а быстрая пометка «кто ещё здесь» (спецификация 6.2).  Участника,
 * которого успели удалить между записями, помечаем отдельно: он есть в списке
 * комнаты навсегда (раздел 10), но откликнуться уже не может.
 */
function memberTag(map: WorkMap, id: string): string {
  const deleted = (map.work.deletedSessions ?? []).includes(id);
  return deleted ? `${sessionTag(id)} (deleted)` : sessionTag(id);
}

/** Текст письма-приглашения в комнату: `You were added to r-01 "<title>" with S03 and S05`. */
export function joinNotice(room: Room, map: WorkMap): string {
  const tags = room.members.map((id) => memberTag(map, id));
  return `You were added to ${room.id} "${room.title}" with ${joinTags(tags)}`;
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
