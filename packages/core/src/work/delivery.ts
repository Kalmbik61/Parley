/**
 * Правила будильника (план, куски 1.8 и 3.4): печатать ли в терминал
 * простаивающего агента текст-указатель на непрочитанные письма и каким его
 * текстом, а спящую — поднимать ли письмом. Функция чистая — PTY, таймеры,
 * лимит подъёмов и подписки на события живут в `host/wake/`, здесь только
 * решение по снимку состояния.
 */

import { HUMAN, type Message, type Room, type WorkSession } from './types.js';
import type { SessionActivity } from './activity.js';
import { sessionMention } from './thread.js';

/**
 * Окно тишины (план «меньше ходов», C1.2): заметка всем без упоминания не будит простаивающего агента сразу —
 * указатель печатается, когда комната притихла на `SETTLE_MS` после самого нового такого письма, но не позже
 * `SETTLE_MAX_MS` от самого старого: болтовня раз в 20 с не откладывает доставку навсегда.
 */
export const SETTLE_MS = 30_000;
export const SETTLE_MAX_MS = 120_000;

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
  /** Часы вызова (мс): окно тишины считается от `at` писем до этого момента. */
  now: number;
  /** Окно тишины и его потолок для тестов; не заданы — `SETTLE_MS` и `SETTLE_MAX_MS`. */
  settleMs?: number;
  settleMaxMs?: number;
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
        | 'no-hooks'
        | 'stuck';
    }
  /** Письма несрочные: указатель ждёт тишины в комнате ещё `retryInMs` — пересчёт по этому сроку. */
  | { kind: 'none'; reason: 'settling'; retryInMs: number }
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
 * Просьба продолжить после сброса лимита (спека застрявших 6.3): хост набирает её в терминал сессии, когда лимит
 * сбросился, а сессия сама не продолжила. «Read your inbox first» — защита: если человек отдал часть задачи другому,
 * ведущий уже написал об этом.
 */
export const LIMIT_RETURN_TEXT =
  'Your usage limit has reset. Read your inbox first, then continue the task the limit interrupted.';

/**
 * Текст возврата после сброса лимита (6.3): просьба продолжить и, если письма ждут, через пробел указатель на них
 * (`pointerText`) — письма держались, пока шёл эпизод, и сессия узнаёт о них тем же ходом.
 */
export function limitReturnText(letters: readonly Message[], rooms: readonly Room[]): string {
  return letters.length === 0 ? LIMIT_RETURN_TEXT : `${LIMIT_RETURN_TEXT} ${pointerText(letters, rooms)}`;
}

const isBarePointer = (text: string): boolean => POINTER_TEXT.test(text) || CUT_POINTER_TEXT.test(text);

/**
 * Текст — указатель Parley на письма (`pointerText`) или возврат после сброса лимита (`limitReturnText`), а не реплика
 * человека: хост набирает его в терминал агента сам. Ни заголовком сессии, ни её ярлыком он быть не может —
 * автозаголовок (`autoTitleOf`) его не берёт. Формат живёт здесь, рядом с `pointerText`: поменялся текст — меняется и
 * распознавание (delivery.test.ts).
 */
export function isPointerText(text: string): boolean {
  if (isBarePointer(text)) return true;
  const head = text.trimStart();
  if (!head.startsWith(LIMIT_RETURN_TEXT)) return false;
  const rest = head.slice(LIMIT_RETURN_TEXT.length);
  // Просьба одна, либо за ней через пробел указатель — целый или обрезанный `oneLine`.
  return rest.trim() === '' || (/^\s/.test(rest) && isBarePointer(rest));
}

/**
 * Упоминание получателя в простом тексте: `@sNN` (`sessionMention`) и, для id вида `s-NN`, ещё `@s-NN` — модель
 * нередко копирует id как есть. Граница та же, что у `plainHumanMention` (`attention.ts`): не часть слова и не адрес,
 * так что `@s02` не находится ни в `@s020`, ни в `a@s02`, а `@s-02` — ни в `@s-020`. Без флага `g`, значит
 * без состояния: одно выражение годится на любое число писем.
 */
function mentionPattern(recipientId: string): RegExp {
  const forms = [sessionMention(recipientId)];
  if (/^s-\d+$/.test(recipientId)) forms.push(`@${recipientId}`);
  const alternatives = forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(^|[^\\w@])(?:${alternatives})(?!\\w)`, 'i');
}

/**
 * Срочность письма для одного получателя: от человека, адресное (`to` не пусто), не заметка (`question`, `decision`)
 * или с упоминанием получателя `@sNN` (или `@s-NN`, `mentionPattern`). Выражение упоминания строится один раз —
 * предикат годится на любое число писем.
 */
function urgencyOf(recipientId: string): (message: Message) => boolean {
  const mention = mentionPattern(recipientId);
  return (message) => message.from === HUMAN || message.to.length > 0 || message.kind !== 'note' || mention.test(message.text);
}

/** Письмо будит получателя сразу, без окна тишины (`urgencyOf`). */
export function wakesAtOnce(message: Message, recipientId: string): boolean {
  return urgencyOf(recipientId)(message);
}

/**
 * Сколько ещё ждать тишины, мс; 0 — доставлять сейчас. Есть срочное письмо (`wakesAtOnce`), писем нет или у
 * какого-то нечитаемый `at` или `at` из будущего дальше `settleMs` — 0: сломанная метка не должна задерживать
 * доставку. Иначе срок — через `settleMs` после самого нового письма, но не позже `settleMaxMs` от самого старого
 * и никогда не выше `settleMaxMs`.
 */
export function settleDelayMs(
  letters: readonly Message[],
  recipientId: string,
  now: number,
  settleMs = SETTLE_MS,
  settleMaxMs = SETTLE_MAX_MS,
): number {
  if (letters.length === 0) return 0;
  if (letters.some(urgencyOf(recipientId))) return 0;
  const times = letters.map((message) => Date.parse(message.at));
  if (times.some((time) => Number.isNaN(time))) return 0;
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  // Метка дальше окна тишины вперёд — скачок часов или битые данные, а не «письмо только что»: тишины от такой
  // метки не дождаться, и далёкое будущее дало бы срок за 2^31−1 мс, который Node урезает до 1 мс (пересчёт в цикле).
  // Поэтому доставляем сразу. К `now` метку не прижимаем: письмо из будущего тогда никогда бы не успокоилось.
  if (newest - now > settleMs) return 0;
  // Вторая страховка: срок не выше потолка, как бы ни сложились метки.
  return Math.max(0, Math.min(Math.min(newest + settleMs, oldest + settleMaxMs) - now, settleMaxMs));
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
    now,
    settleMs,
    settleMaxMs,
  } = input;

  if (paused) return { kind: 'none', reason: 'paused' };
  // Закрытая писем не получает вовсе (спецификация 7.1) — сколько бы их ни было.
  if (session.lifecycle === 'closed') return { kind: 'none', reason: 'closed' };

  const letters = unread.filter((message) => message.deleted !== true);
  if (letters.length === 0) return { kind: 'none', reason: 'no-letters' };
  // Сессия ждёт человека или сброса лимита (`need`, спека «Застрявшие сессии», 6.1): указатель в её терминал не
  // печатается, пока эпизод не кончится. Правило раньше `already-pointed`, `no-hooks` и `busy`: человек должен видеть,
  // что сессия застряла, и когда указатель напечатан до этого, а у экрана старта причина «застрял» точнее «нет хуков».
  // Только у активной сессии: старый снимок с `need` не мешает письму поднять спящую (7.2) и не меняет `not-live`
  // у остальных. `!= null`: после `?.` у отсутствующей активности `undefined`, а не `null`.
  if (session.lifecycle === 'active' && activity?.need != null) return { kind: 'none', reason: 'stuck' };
  if (letters.every((message) => pointed.has(message.id))) {
    return { kind: 'none', reason: 'already-pointed' };
  }

  // Окно тишины — только там, где иначе получился бы подъём или указатель, и по ещё не указанным письмам:
  // срочное письмо забирает пачку с собой, а текст указателя считает все непрочитанные.
  const settleIn = (): number =>
    settleDelayMs(
      letters.filter((message) => !pointed.has(message.id)),
      session.id,
      now,
      settleMs,
      settleMaxMs,
    );

  // Спящую письмо поднимает (спецификация 7.2), но не чаще `resumeRate` в час:
  // сверх лимита письма ждут, а не жгут подписку за ночь (7.4).
  if (session.lifecycle === 'sleeping') {
    if (!resumeAllowed) return { kind: 'none', reason: 'resume-limit' };
    const retryInMs = settleIn();
    if (retryInMs > 0) return { kind: 'none', reason: 'settling', retryInMs };
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
  const retryInMs = settleIn();
  if (retryInMs > 0) return { kind: 'none', reason: 'settling', retryInMs };

  return {
    kind: 'type-pointer',
    text: pointerText(letters, rooms),
    letterIds: letters.map((message) => message.id),
    ...(queue ? { queue: true as const } : {}),
  };
}
