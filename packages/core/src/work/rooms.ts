import { maxNumber } from './map.js';
import { sessionTag } from './thread.js';
import { HUMAN, type Room, type WorkMap } from './types.js';

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
}

/** Заводит комнату в карте. */
export function addRoom(map: WorkMap, init: NewRoom, at = new Date().toISOString()): Room {
  const room: Room = {
    id: nextRoomId(map),
    title: init.title,
    creator: init.creator,
    members: [...init.members],
    createdAt: at,
  };
  map.rooms.push(room);
  return room;
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
