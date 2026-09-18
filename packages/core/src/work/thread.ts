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
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);

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
    map.messages.filter(
      (message) =>
        here(message.from) &&
        here(message.to) &&
        (inside.has(message.from) || inside.has(message.to)),
    ),
  );
  return { owner, members, messages };
}

/** Решения треда — его письма с `kind: decision`, по времени. */
export const decisionsOf = (thread: Thread): Message[] =>
  thread.messages.filter((message) => message.kind === 'decision');

/**
 * Единственное место, где id сессии становится подписью (решение D9 ревью):
 * ярлык у живой записи, «(удалена)» у следа в `deletedSessions`, голый id у
 * чужого. Ярлыка у удалённой в карте не остаётся, поэтому подпись — её id.
 */
export function participantLabel(map: WorkMap, id: string): string {
  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session !== undefined) return session.label;
  return (map.work.deletedSessions ?? []).includes(id) ? `${id} (удалена)` : id;
}
