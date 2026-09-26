/**
 * Правила будильника (план, куски 1.8 и 3.4): печатать ли в терминал
 * простаивающего агента текст-указатель на непрочитанные письма и каким его
 * текстом, а спящую — поднимать ли письмом. Функция чистая — PTY, таймеры,
 * лимит подъёмов и подписки на события живут в `host/wake/`, здесь только
 * решение по снимку состояния.
 */

import type { Message, WorkSession } from './types.js';
import type { SessionActivity } from './activity.js';

export interface DeliveryInput {
  session: WorkSession;
  activity: SessionActivity | null;
  hasDraft: boolean;
  paused: boolean;
  /** Непрочитанные письма сессии (`unreadFor`); удалённые отсеет сама доставка. */
  unread: readonly Message[];
  /** Id писем, на которые указатель уже печатали — второй раз не набираем. */
  pointed: ReadonlySet<string>;
  inFlight: boolean;
  /** Лимит подъёмов (`resumeRate`) ещё позволяет поднять спящую сессию. */
  resumeAllowed: boolean;
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
        | 'in-flight';
    }
  | { kind: 'type-pointer'; text: string; letterIds: string[] }
  | { kind: 'resume'; text: string; letterIds: string[] };

/** 'Новые письма (N). Вызови check_inbox.' — этап 3 добавит комнаты. */
export function pointerText(count: number): string {
  return `Новые письма (${count}). Вызови check_inbox.`;
}

/**
 * Правила по порядку, первое сработавшее решает (план, куски 1.8 и 3.4). Письма
 * к уже удалённой сессии (`deleted`) в счёт не идут — сама доставка их не читает.
 */
export function deliveryAction(input: DeliveryInput): DeliveryAction {
  const { session, activity, hasDraft, paused, unread, pointed, inFlight, resumeAllowed } = input;

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
      text: pointerText(letters.length),
      letterIds: letters.map((message) => message.id),
    };
  }
  if (session.lifecycle !== 'active') return { kind: 'none', reason: 'not-live' };
  if (activity === null || (activity.activity !== 'unseen' && activity.activity !== 'idle')) {
    return { kind: 'none', reason: 'busy' };
  }
  if (hasDraft) return { kind: 'none', reason: 'draft' };
  if (inFlight) return { kind: 'none', reason: 'in-flight' };

  return {
    kind: 'type-pointer',
    text: pointerText(letters.length),
    letterIds: letters.map((message) => message.id),
  };
}
