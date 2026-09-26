/**
 * Правила будильника живых сессий (план, кусок 1.8): печатать ли в терминал
 * простаивающего агента текст-указатель на непрочитанные письма и каким его
 * текстом. Функция чистая — PTY, таймеры и подписки на события живут в
 * `host/wake/wake-service.ts`, здесь только решение по снимку состояния.
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
}

export type DeliveryAction =
  | {
      kind: 'none';
      reason: 'paused' | 'no-letters' | 'already-pointed' | 'not-live' | 'busy' | 'draft' | 'in-flight';
    }
  | { kind: 'type-pointer'; text: string; letterIds: string[] };

/** 'Новые письма (N). Вызови check_inbox.' — этап 3 добавит комнаты. */
export function pointerText(count: number): string {
  return `Новые письма (${count}). Вызови check_inbox.`;
}

/**
 * Правила по порядку, первое сработавшее решает (план, кусок 1.8). Письма к
 * уже удалённой сессии (`deleted`) в счёт не идут — сама доставка их не читает.
 */
export function deliveryAction(input: DeliveryInput): DeliveryAction {
  const { session, activity, hasDraft, paused, unread, pointed, inFlight } = input;

  if (paused) return { kind: 'none', reason: 'paused' };

  const letters = unread.filter((message) => message.deleted !== true);
  if (letters.length === 0) return { kind: 'none', reason: 'no-letters' };
  if (letters.every((message) => pointed.has(message.id))) {
    return { kind: 'none', reason: 'already-pointed' };
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
