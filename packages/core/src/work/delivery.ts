/**
 * Правила будильника (план, куски 1.8 и 3.4): печатать ли в терминал
 * простаивающего агента текст-указатель на непрочитанные письма и каким его
 * текстом, а спящую — поднимать ли письмом. Функция чистая — PTY, таймеры,
 * лимит подъёмов и подписки на события живут в `host/wake/`, здесь только
 * решение по снимку состояния.
 */

import type { Message, Room, WorkSession } from './types.js';
import type { SessionActivity } from './activity.js';

export interface DeliveryInput {
  session: WorkSession;
  activity: SessionActivity | null;
  hasDraft: boolean;
  paused: boolean;
  /** Непрочитанные письма сессии (`unreadFor`); удалённые отсеет сама доставка. */
  unread: readonly Message[];
  /** Комнаты работы — для названия комнаты в тексте указателя. */
  rooms: readonly Room[];
  /** Id писем, на которые указатель уже печатали — второй раз не набираем. */
  pointed: ReadonlySet<string>;
  inFlight: boolean;
  /** Лимит подъёмов (`resumeRate`) ещё позволяет поднять спящую сессию. */
  resumeAllowed: boolean;
  /**
   * С запуска процесса агента пришло хоть одно событие хуков (`hookedSince`). Нет — хост не
   * знает, что на экране: свежая сессия может стоять на вопросе доверия к папке (fix-final-b).
   */
  hooked: boolean;
}

export type DeliveryAction =
  | {
      kind: 'none';
      reason:
        | 'paused'
        | 'closed'
        | 'no-letters'
        | 'already-pointed'
        | 'resume-limit'
        | 'not-live'
        | 'busy'
        | 'draft'
        | 'in-flight'
        | 'no-hooks';
    }
  | { kind: 'type-pointer'; text: string; letterIds: string[] }
  | { kind: 'resume'; text: string; letterIds: string[] };

/**
 * Текст указателя (план, кусок 3.5): сколько писем и откуда — прямые, одна
 * комната с названием, несколько комнат списком, комнаты вместе с прямыми.
 * Названия у нескольких комнат нет: строка набирается в чужой терминал и
 * должна оставаться короткой, подробности отдаст `check_inbox`.
 */
export function pointerText(letters: readonly Message[], rooms: readonly Room[]): string {
  const tail = 'Вызови check_inbox.';
  const head = `Новые письма (${letters.length})`;
  const roomIds = [
    ...new Set(letters.flatMap((message) => (message.roomId === null ? [] : [message.roomId]))),
  ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const direct = letters.some((message) => message.roomId === null);

  if (roomIds.length === 0) return `${head}. ${tail}`;
  if (direct) return `${head} в ${roomIds.join(', ')} и лично. ${tail}`;
  if (roomIds.length > 1) return `${head} в ${roomIds.join(', ')}. ${tail}`;

  const id = roomIds[0] as string;
  const room = rooms.find((candidate) => candidate.id === id);
  // Комнаты в карте нет (письмо пережило её) — хватит и id.
  return room === undefined ? `${head} в ${id}. ${tail}` : `${head} в ${id} «${room.title}». ${tail}`;
}

/**
 * Правила по порядку, первое сработавшее решает (план, куски 1.8 и 3.4). Письма
 * к уже удалённой сессии (`deleted`) в счёт не идут — сама доставка их не читает.
 */
export function deliveryAction(input: DeliveryInput): DeliveryAction {
  const { session, activity, hasDraft, paused, unread, rooms, pointed, inFlight, resumeAllowed, hooked } =
    input;

  if (paused) return { kind: 'none', reason: 'paused' };
  // Закрытая писем не получает вовсе (спецификация 7.1) — сколько бы их ни было.
  if (session.lifecycle === 'closed') return { kind: 'none', reason: 'closed' };

  const letters = unread.filter((message) => message.deleted !== true);
  if (letters.length === 0) return { kind: 'none', reason: 'no-letters' };
  if (letters.every((message) => pointed.has(message.id))) {
    return { kind: 'none', reason: 'already-pointed' };
  }

  // Спящую письмо поднимает (спецификация 7.2), но не чаще `resumeRate` в час:
  // сверх лимита письма ждут, а не жгут подписку за ночь (7.4).
  if (session.lifecycle === 'sleeping') {
    if (!resumeAllowed) return { kind: 'none', reason: 'resume-limit' };
    return {
      kind: 'resume',
      text: pointerText(letters, rooms),
      letterIds: letters.map((message) => message.id),
    };
  }
  if (session.lifecycle !== 'active') return { kind: 'none', reason: 'not-live' };
  // Без единого хука с запуска `idle` ничего не значит: агент может ждать ответа на вопрос
  // доверия к папке, и Enter указателя его подтвердил бы (рамка 15.1).
  if (!hooked) return { kind: 'none', reason: 'no-hooks' };
  if (activity === null || (activity.activity !== 'unseen' && activity.activity !== 'idle')) {
    return { kind: 'none', reason: 'busy' };
  }
  if (hasDraft) return { kind: 'none', reason: 'draft' };
  if (inFlight) return { kind: 'none', reason: 'in-flight' };

  return {
    kind: 'type-pointer',
    text: pointerText(letters, rooms),
    letterIds: letters.map((message) => message.id),
  };
}
