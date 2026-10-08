/**
 * Правила будильника (план, куски 1.8 и 3.4): печатать ли в терминал
 * простаивающего агента текст-указатель на непрочитанные письма и каким его
 * текстом, а спящую — поднимать ли письмом. Функция чистая — PTY, таймеры,
 * лимит подъёмов и подписки на события живут в `host/wake/`, здесь только
 * решение по снимку состояния.
 */

import { HUMAN, type Message, type Room, type WorkSession } from './types.js';
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
  /**
   * Провайдер принимает письмо занятому агенту в очередь на следующий ход (Codex: Tab, а не Enter,
   * который вмешался бы в идущий ход — спека комнат, 3.6): тогда `working` не мешает указателю, а
   * `blocked` мешает по-прежнему. Не задан — как у Claude Code: указатель ждёт конца хода.
   */
  queueWhileBusy?: boolean;
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
  | {
      kind: 'type-pointer';
      text: string;
      letterIds: string[];
      /** Агент занят: указатель уходит в очередь (`queueWhileBusy`), а не Enter-ом в его ход. */
      queue?: true;
    }
  | { kind: 'resume'; text: string; letterIds: string[] };

/**
 * Текст указателя (план, кусок 3.5): сколько писем и откуда — прямые, одна
 * комната с названием, несколько комнат списком, комнаты вместе с прямыми.
 * Названия у нескольких комнат нет: строка набирается в чужой терминал и
 * должна оставаться короткой, подробности отдаст `check_inbox`. Среди писем задача человека всем
 * (от человека, в комнату, без адресата) — голова получает пометку: агент узнаёт о ней ещё до `check_inbox`.
 */
export function pointerText(letters: readonly Message[], rooms: readonly Room[]): string {
  const tail = 'Call check_inbox.';
  const head = `New messages (${letters.length})`;
  const roomIds = [
    ...new Set(letters.flatMap((message) => (message.roomId === null ? [] : [message.roomId]))),
  ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const direct = letters.some((message) => message.roomId === null);
  const task = letters.some((message) => message.from === HUMAN && message.roomId !== null && message.to.length === 0)
    ? ' (a task for everyone)'
    : '';

  if (roomIds.length === 0) return `${head}. ${tail}`;
  if (direct) return `${head} in ${roomIds.join(', ')} and direct${task}. ${tail}`;
  if (roomIds.length > 1) return `${head} in ${roomIds.join(', ')}${task}. ${tail}`;

  const id = roomIds[0] as string;
  const room = rooms.find((candidate) => candidate.id === id);
  // Комнаты в карте нет (письмо пережило её) — хватит и id.
  return room === undefined ? `${head} in ${id}${task}. ${tail}` : `${head} in ${id} "${room.title}"${task}. ${tail}`;
}

/** Указатель целиком (`pointerText`): голова со счётом, необязательное «in r-…», хвост `Call check_inbox.`. */
const POINTER_TEXT = /^\s*New messages \(\d+\)(?: in r-[\s\S]*)?\. Call check_inbox\.\s*$/;
/**
 * Он же, обрезанный `oneLine` (заголовок из реплики — 200 знаков и `…`): длинное название комнаты съело хвост.
 * Так его записывал в ярлык автозаголовок сборок до 0.7.0 включительно.
 */
const CUT_POINTER_TEXT = /^\s*New messages \(\d+\) in r-[\s\S]*…$/;

/**
 * Текст — указатель Parley на письма (`pointerText`), а не реплика человека: хост набирает его в терминал
 * агента сам. Ни заголовком сессии, ни её ярлыком он быть не может — автозаголовок (`autoTitleOf`) его не берёт.
 * Формат живёт здесь, рядом с `pointerText`: поменялся текст — меняется и распознавание (delivery.test.ts).
 */
export function isPointerText(text: string): boolean {
  return POINTER_TEXT.test(text) || CUT_POINTER_TEXT.test(text);
}

/**
 * Правила по порядку, первое сработавшее решает (план, куски 1.8 и 3.4). Письма
 * к уже удалённой сессии (`deleted`) в счёт не идут — сама доставка их не читает.
 */
export function deliveryAction(input: DeliveryInput): DeliveryAction {
  const {
    session,
    activity,
    hasDraft,
    paused,
    unread,
    rooms,
    pointed,
    inFlight,
    resumeAllowed,
    hooked,
    queueWhileBusy,
  } = input;

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
  // Лид закончил ход и ждёт фоновых субагентов: активность `working`, но удерживают её только они
  // (`heldByBackground`), а сам он стоит у приглашения и ввод принимает — указатель печатается
  // Enter-ом, как простаивающему. Агент внутри `wait_for`, как и работающий сам, по-прежнему busy.
  const parked = activity?.activity === 'working' && activity.heldByBackground;
  // Занятому агенту Codex письмо ставится в очередь; `blocked` (вопрос человеку) и неизвестное — по-прежнему busy.
  const queue = queueWhileBusy === true && activity?.activity === 'working' && !parked;
  if (
    activity === null ||
    (activity.activity !== 'unseen' && activity.activity !== 'idle' && !queue && !parked)
  ) {
    return { kind: 'none', reason: 'busy' };
  }
  if (hasDraft) return { kind: 'none', reason: 'draft' };
  if (inFlight) return { kind: 'none', reason: 'in-flight' };

  return {
    kind: 'type-pointer',
    text: pointerText(letters, rooms),
    letterIds: letters.map((message) => message.id),
    ...(queue ? { queue: true as const } : {}),
  };
}
