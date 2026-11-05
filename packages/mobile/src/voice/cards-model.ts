/**
 * Карточки помощника на телефоне (R06, план T4b): список активных карточек и решение «Send»/«Cancel». Чистая логика:
 * вызовы хоста и Face ID внедряются. Голос в этот модуль не заходит: карточку решает только человек на экране.
 */
import type { PhoneCard } from '@parley/protocol/remote';
import type { CardDecideResult } from '@parley/protocol';
import type { OwnerConfirm } from '../auth/confirm-owner.js';

export type CardChoice = 'send' | 'cancel';

const active = (card: PhoneCard): boolean => card.state === 'needs_confirmation';

/** Снимок `cards.list`: только карточки, ждущие решения. */
export function cardsFromSnapshot(cards: readonly PhoneCard[]): PhoneCard[] {
  return cards.filter(active);
}

/** `cards.changed`: ждущая карточка добавляется или заменяется более новой ревизией; терминальная убирается. */
export function applyCardChanged(list: readonly PhoneCard[], card: PhoneCard): PhoneCard[] {
  const rest = list.filter((c) => c.cardId !== card.cardId);
  if (!active(card)) return rest;
  const previous = list.find((c) => c.cardId === card.cardId);
  if (previous !== undefined && previous.revision > card.revision) return [...list];
  return [...rest, card].sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Убрать карточку после решения. */
export const dropCard = (list: readonly PhoneCard[], cardId: string): PhoneCard[] => list.filter((c) => c.cardId !== cardId);

/** Карточка над экраном: та, чей срок выходит раньше. */
export const currentCard = (list: readonly PhoneCard[]): PhoneCard | null => list[0] ?? null;

export type CardOutcome =
  | { kind: 'applied' }
  /** Решить уже нельзя: карточку решили, срок вышел, её нет или хост отказал. Карточка убирается. */
  | { kind: 'stale'; message: string }
  /** Face ID отменён или недоступен: ничего не отправлено, карточка осталась. */
  | { kind: 'not_confirmed'; message: string }
  /** Вызов не дошёл до Mac: карточка осталась, можно повторить. */
  | { kind: 'unreachable'; message: string };

export const STALE_CARD_MESSAGE = 'This card is no longer current';

export interface DecideDeps {
  call(method: 'cards.decide', params: { cardId: string; revision: number; choice: CardChoice }): Promise<CardDecideResult>;
  confirmOwner(prompt: string): Promise<OwnerConfirm>;
}

/**
 * Решение по карточке. Опасную карточку «Send» сначала подтверждает владелец (Face ID); отказ или отсутствие Face ID —
 * вызова нет вообще. «Cancel» ничего не запускает и Face ID не просит. Не применённый результат — «карточка не актуальна».
 */
export async function decideCard(deps: DecideDeps, card: PhoneCard, choice: CardChoice): Promise<CardOutcome> {
  if (card.dangerous && choice === 'send') {
    const confirmed = await deps.confirmOwner('Confirm this action');
    if (confirmed !== 'ok') {
      return { kind: 'not_confirmed', message: confirmed === 'unavailable' ? 'Set up Face ID or a passcode to confirm this action' : 'Not confirmed. Nothing was sent' };
    }
  }
  let result: CardDecideResult;
  try {
    result = await deps.call('cards.decide', { cardId: card.cardId, revision: card.revision, choice });
  } catch {
    return { kind: 'unreachable', message: 'Could not reach the Mac. Try again' };
  }
  return result.applied ? { kind: 'applied' } : { kind: 'stale', message: STALE_CARD_MESSAGE };
}
