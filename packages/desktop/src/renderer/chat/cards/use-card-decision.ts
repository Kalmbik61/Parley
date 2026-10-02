/**
 * Решение по карточке из окна (план 2026-10-01, кусок 4a, решение П): состояние «в пути» и пометка
 * берутся из стора лент селекторами по ключу карточки — строки ленты виртуализированы и `memo`,
 * а перерисовать строку должно изменение именно этой карточки.
 */

import { useCallback } from 'react';
import type { FeedDecision } from '@parley/core';
import { refKey } from '@parley/protocol';
import { useChatEnv } from '../chat-env.js';
import { useFeedStore, type CardNote } from '../store.js';
import { cardKey } from '../ui-store.js';

export interface CardDecision {
  /** Ключ карточки в сторах (`cardKey`). */
  key: string;
  /** Запрос уже в пути — кнопки выключены. */
  deciding: boolean;
  note: CardNote | null;
  decide: (decision: FeedDecision) => void;
}

export function useCardDecision(cardId: string): CardDecision {
  const { sessionRef } = useChatEnv();
  const key = cardKey(refKey(sessionRef), cardId);
  const deciding = useFeedStore((state) => state.deciding[key] === true);
  const note = useFeedStore((state) => state.notes[key] ?? null);
  const decide = useCallback(
    (decision: FeedDecision): void => {
      void useFeedStore.getState().decide(sessionRef, cardId, decision);
    },
    // `sessionRef` по значению — по его ключу.
    [key],
  );
  return { key, deciding, note, decide };
}
