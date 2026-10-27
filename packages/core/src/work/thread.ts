import type { LetterReads } from './letter-store.js';
import { recipientsOf } from './letters.js';
import { canReadRoom } from './rooms.js';
import { PARLEY } from './types.js';
import type { Message, WindowWorkMap, WorkMap, WorkSession } from './types.js';

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

/** Область треда сессии: владелец, участники и их множества — всё, что нужно, чтобы решить про одно письмо. */
interface ThreadScope {
  owner: string | null;
  members: string[];
  inside: ReadonlySet<string>;
  /** Удалённая сессия участником не считается, но письмо с её id из ленты не пропадает. */
  gone: ReadonlySet<string>;
}

function threadScope(map: WorkMap, sessionId: string): ThreadScope {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);

  const owner =
    session.parent !== null
      ? session.parent
      : childrenOf(map, sessionId).length > 0
        ? sessionId
        : null;
  const members = owner === null ? map.sessions.map((item) => item.id) : subtree(map, owner);
  return { owner, members, inside: new Set(members), gone: new Set(map.work.deletedSessions ?? []) };
}

/**
 * Лежит ли письмо в треде с владельцем (3.4): и отправитель, и получатели — в поддереве или следе удалённой сессии,
 * и хотя бы один конец живой в поддереве. Удалённая сессия участником не считается, но письмо с её id из ленты не
 * пропадает (3.4, 6.3): поддерева у следа в `deletedSessions` уже нет, и письмо остаётся в том треде, где живёт его
 * второй конец. У треда всей работы (`owner === null`) письма не делятся — вызывающий этот случай не спрашивает.
 */
function inThread(map: WorkMap, scope: ThreadScope): (message: Message) => boolean {
  const { inside, gone } = scope;
  const here = (id: string): boolean => inside.has(id) || gone.has(id);
  return (message) => {
    const to = recipientsOf(message, map);
    return (
      here(message.from) &&
      to.every(here) &&
      (inside.has(message.from) || to.some((id) => inside.has(id)))
    );
  };
}

export function threadOf(map: WindowWorkMap, sessionId: string): Thread {
  const scope = threadScope(map, sessionId);
  const { owner, members } = scope;
  // Одинокий корень видит всю работу целиком: делить письма не на кого (3.4).
  if (owner === null) return { owner, members, messages: byTime(map.messages) };

  return { owner, members, messages: byTime(map.messages.filter(inThread(map, scope))) };
}

function visibleTo(map: WorkMap, scope: ThreadScope, sessionId: string): (message: Message) => boolean {
  const historical = scope.owner === null ? (): boolean => false : inThread(map, scope);
  return (message) => {
    if (message.roomId !== null) {
      const room = map.rooms.find((candidate) => candidate.id === message.roomId);
      return room !== undefined && canReadRoom(room, sessionId);
    }
    return historical(message) || message.from === sessionId || message.to.includes(sessionId);
  };
}

/**
 * Видит ли агент `sessionId` письмо: предикат на одно письмо с тем же ответом, что членство письма в
 * `agentThreadOf(map, sessionId).messages`, но без сортировки и обхода всех писем (спека хранилища 6.2): письмо
 * комнаты — читателю комнаты (`canReadRoom`); прямое — если оно в историческом треде семьи, от агента или к нему.
 * Одинокий корень исторического треда не имеет: чужой личной почты он не читает.
 */
export function agentLetterVisible(map: WorkMap, sessionId: string): (message: Message) => boolean {
  return visibleTo(map, threadScope(map, sessionId), sessionId);
}

/**
 * Кто может быть концом прямого письма, видимого агенту (`agentLetterVisible`): сам агент и, если у него есть семья, её
 * участники. Видимое письмо всегда называет кого-то из них отправителем или адресатом, поэтому по этому списку прямые
 * письма отбираются запросом (`LetterQuery.involving`), а точное правило применяется уже к небольшому остатку.
 */
export function agentLetterAudience(map: WorkMap, sessionId: string): string[] {
  const scope = threadScope(map, sessionId);
  return scope.owner === null ? [sessionId] : [...new Set([sessionId, ...scope.members])];
}

/** Agent context keeps historical family access, but a lone root cannot read unrelated private mail. */
export function agentThreadOf(map: WindowWorkMap, sessionId: string): Thread {
  const scope = threadScope(map, sessionId);
  return {
    owner: scope.owner,
    members: scope.members,
    messages: byTime(map.messages.filter(visibleTo(map, scope, sessionId))),
  };
}

/** Участники треда сессии — те же, что в `threadOf(...).members`, без чтения писем. */
export const threadMembersOf = (map: WorkMap, sessionId: string): string[] => threadScope(map, sessionId).members;

/**
 * Решения, которые агент видит в своём треде (`agentThreadOf`), по времени. Берутся запросом `kind: decision`,
 * ограниченным числом решений в работе, и отбираются предикатом видимости одного письма (спека хранилища 6.2).
 */
export function agentDecisions(map: WorkMap, letters: LetterReads, sessionId: string): Message[] {
  const visible = agentLetterVisible(map, sessionId);
  const decisions = { kind: 'decision' as const };
  return byTime(letters.query({ ...decisions, limit: letters.count(decisions) }).filter(visible));
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
