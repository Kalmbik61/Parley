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

export type SheetMode = 'decide' | 'confirm_on_mac';

/**
 * Режим листа карточки: без `cards.decide` в `hello.methods` (на Mac выключен запуск с телефона) решить карточку
 * с телефона нельзя, лист показывает «Confirm on Mac» вместо Send/Cancel.
 */
export const sheetMode = (methods: readonly string[] | null): SheetMode => (methods?.includes('cards.decide') === true ? 'decide' : 'confirm_on_mac');

export type CardOutcome =
  | { kind: 'applied' }
  /** Решить уже нельзя: карточку решили, срок вышел, её нет или хост отказал. Карточка убирается. */
  | { kind: 'stale'; message: string }
  /** Face ID отменён или недоступен: ничего не отправлено, карточка осталась. */
  | { kind: 'not_confirmed'; message: string }
  /** Хост не смог выполнить (`failed`): карточка остаётся, можно повторить. */
  | { kind: 'failed'; message: string }
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
  if (result.applied) return { kind: 'applied' };
  return result.reason === 'failed' ? { kind: 'failed', message: 'Could not send — try again' } : { kind: 'stale', message: STALE_CARD_MESSAGE };
}

export interface SheetContext {
  /** Активные карточки в порядке срока. */
  cards: readonly PhoneCard[];
  /** Обложка замка приложения (`useCovered`). */
  covered: boolean;
  /** Вкладка Voice в фокусе. */
  focused: boolean;
  /** Карточки, которые человек отложил («Later»), по `cardId`. */
  dismissed: ReadonlySet<string>;
}

/** Карточка для листа: первая не отложенная. Новая карточка (другой `cardId`) не прячется за отложенной. */
export const sheetCard = (c: Pick<SheetContext, 'cards' | 'dismissed'>): PhoneCard | null => c.cards.find((card) => !c.dismissed.has(card.cardId)) ?? null;

/** B1/M4: лист показывается только открытым приложением, на вкладке Voice и если есть не отложенная карточка. */
export const sheetVisible = (c: SheetContext): boolean => sheetCard(c) !== null && !c.covered && c.focused;

/** Сколько карточек отложено и ждут: значок «N cards waiting». */
export const waitingCount = (c: SheetContext): number => (c.covered ? 0 : c.cards.filter((card) => c.dismissed.has(card.cardId)).length);

export const waitingLabel = (count: number): string => `${count} ${count === 1 ? 'card' : 'cards'} waiting · Open`;

/** B1: под обложкой замка решение не принимается, как и при занятом вызове. */
export const canDecide = (c: { card: PhoneCard | null; covered: boolean; busy: boolean }): boolean => c.card !== null && !c.covered && !c.busy;
