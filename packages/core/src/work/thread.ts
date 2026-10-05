import { recipientsOf } from './letters.js';
import { PARLEY } from './types.js';
import type { Message, WorkMap, WorkSession } from './types.js';

/**
 * Тред выводится из карты, а не хранится (спецификация 2026-09-08, 3.4):
 * письма, у которых и отправитель, и получатель лежат в поддереве владельца.
 * Группа сессии S — поддерево её родителя; корень с детьми — своё поддерево;
 * одинокий корень — вся работа (`owner === null`).
 */
export interface Thread {
  /** Владелец поддерева; `null` — тред всей работы. */
  owner: string | null;
  /** Участники: id сессий поддерева, живые записи карты. */
  members: string[];
  /** Письма треда по времени `at`. */
  messages: Message[];
}

const childrenOf = (map: WorkMap, id: string): WorkSession[] =>
  map.sessions.filter((session) => session.parent === id);

function subtree(map: WorkMap, root: string): string[] {
  const ids: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    ids.push(id);
    for (const child of childrenOf(map, id)) queue.push(child.id);
  }
  return ids;
}

const byTime = (messages: readonly Message[]): Message[] =>
  [...messages].sort((a, b) => a.at.localeCompare(b.at));

export function threadOf(map: WorkMap, sessionId: string): Thread {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);

  const owner =
    session.parent !== null
      ? session.parent
      : childrenOf(map, sessionId).length > 0
        ? sessionId
        : null;
  const members = owner === null ? map.sessions.map((item) => item.id) : subtree(map, owner);
  // Одинокий корень видит всю работу целиком: делить письма не на кого (3.4).
  if (owner === null) return { owner, members, messages: byTime(map.messages) };

  const inside = new Set(members);
  const gone = new Set(map.work.deletedSessions ?? []);
  // Удалённая сессия участником не считается, но письмо с её id из ленты не
  // пропадает (3.4, 6.3): поддерева у следа в `deletedSessions` уже нет, и
  // письмо остаётся в том треде, где живёт его второй конец.
  const here = (id: string): boolean => inside.has(id) || gone.has(id);
  const messages = byTime(
    map.messages.filter((message) => {
      const to = recipientsOf(message, map);
      return (
        here(message.from) &&
        to.every(here) &&
        (inside.has(message.from) || to.some((id) => inside.has(id)))
      );
    }),
  );
  return { owner, members, messages };
}

/** Решения треда — его письма с `kind: decision`, по времени. */
export const decisionsOf = (thread: Thread): Message[] =>
  thread.messages.filter((message) => message.kind === 'decision');

/**
 * Последние `limit` решений треда по порядку и сколько их всего: старт агента получает текущий срез со ссылками
 * на сообщения, а не всю историю (P34).
 */
export function recentDecisions(thread: Thread, limit: number): { shown: Message[]; total: number } {
  const all = decisionsOf(thread);
  return { shown: all.slice(-limit), total: all.length };
}

/**
 * Единственное место, где id сессии становится подписью (решение D9 ревью):
 * ярлык у живой записи, «(deleted)» у следа в `deletedSessions`, голый id у
 * чужого. Ярлыка у удалённой в карте не остаётся, поэтому подпись — её id.
 */
export function participantLabel(map: WorkMap, id: string): string {
  if (id === PARLEY) return 'Parley';
  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session !== undefined) return session.label;
  return (map.work.deletedSessions ?? []).includes(id) ? `${id} (deleted)` : id;
}

/** Номер в id вида `s-01`, `s-12`; чужая форма id не трогается (дизайн комнаты, 4). */
const SESSION_ID = /^s-(\d+)$/;

/**
 * Короткий номер сессии для комнаты: `s-01` → `S01`. Форма id вне `s-<цифры>` —
 * ручной запуск или чужая сессия — печатается как есть: выдуманный номер хуже
 * сырого id.
 */
export function sessionTag(id: string): string {
  const match = SESSION_ID.exec(id);
  return match === null ? id : `S${match[1]}`;
}

/**
 * Токен упоминания сессии в тексте комнаты: `s-04` → `@s04`. Лента окна рисует такой токен
 * чипом с ярлыком участника (дизайн окна комнат, 2.2); чужая форма id печатается как есть.
 */
export function sessionMention(id: string): string {
  const match = SESSION_ID.exec(id);
  return match === null ? `@${id}` : `@s${match[1]}`;
}
