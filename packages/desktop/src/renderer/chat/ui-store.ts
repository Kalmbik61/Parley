/**
 * Состояние вида «Chat», которое переживает размонтирование `ChatView` (ревью куска 3): черновик поля
 * ввода, вложения над ним и серые элементы очереди по `refKey` сессии. Тело вкладки рисуется только у
 * активной вкладки группы и только в виде «Chat», поэтому переход Chat → Terminal → Chat или на соседнюю
 * вкладку размонтирует вид — а набранный текст, добавленные файлы и сообщение, уже ушедшее в очередь CLI,
 * пропадать не должны.
 */

import { create } from 'zustand';
import type { QueuedPrompt } from './FeedList.js';

/** Ключ карточки: `cardId` у разных сессий может совпасть, поэтому с ключом сессии. */
export function cardKey(sessionKey: string, cardId: string): string {
  return `${sessionKey}\n${cardId}`;
}

/**
 * Черновик ответа на карточку (план 2026-10-01, кусок 4a): строки ленты виртуализированы и
 * размонтируются при прокрутке, поэтому выбранное и набранное живёт здесь.
 */
export interface CardDraft {
  /** Разрешение: текст отказа для модели. */
  message: string;
  /** Вопрос: номер показанного вопроса. */
  step: number;
  /** Вопрос: выбранные подписи по номеру вопроса. */
  picked: Readonly<Record<number, readonly string[]>>;
  /** Вопрос: выбран пункт «Other». */
  otherOn: Readonly<Record<number, boolean>>;
  /** Вопрос: текст «Other». */
  otherText: Readonly<Record<number, string>>;
}

export const EMPTY_CARD_DRAFT: CardDraft = { message: '', step: 0, picked: {}, otherOn: {}, otherText: {} };

/** Ждущее сообщение и сколько промптов с тем же текстом было в ленте, когда оно ушло. */
export interface Queued extends QueuedPrompt {
  seen: number;
}

export interface ChatUiState {
  drafts: Record<string /* refKey */, string>;
  /** Вложения поля ввода: пути файлов, которые уйдут упоминаниями вместе с текстом (`attachments.ts`). */
  attachments: Record<string /* refKey */, readonly string[]>;
  queued: Record<string /* refKey */, readonly Queued[]>;
  setDraft(key: string, text: string): void;
  /** Заменить вложения сессии; тот же массив — стор не трогается. */
  setAttachments(key: string, paths: readonly string[]): void;
  /** Черновики карточек по `cardKey`. */
  cardDrafts: Record<string, CardDraft>;
  setCardDraft(key: string, patch: Partial<CardDraft>): void;
  /** Забыть черновики карточек сессии (лента закрыта); `only` — только этих `cardId` (карточка перестала быть `pending`). */
  clearCardDrafts(sessionKey: string, only?: readonly string[]): void;
  /** Обновить очередь сессии; тот же массив — стор не трогается. */
  updateQueued(key: string, update: (was: readonly Queued[]) => readonly Queued[]): void;
}

const NONE: readonly Queued[] = [];
const NO_PATHS: readonly string[] = [];

export const useChatUiStore = create<ChatUiState>((set) => ({
  drafts: {},
  attachments: {},
  queued: {},
  cardDrafts: {},
  setCardDraft: (key, patch) =>
    set((state) => ({ cardDrafts: { ...state.cardDrafts, [key]: { ...(state.cardDrafts[key] ?? EMPTY_CARD_DRAFT), ...patch } } })),
  clearCardDrafts: (sessionKey, only) =>
    set((state) => {
      const prefix = `${sessionKey}\n`;
      const drop = (key: string): boolean =>
        only === undefined ? key.startsWith(prefix) : only.some((id) => key === cardKey(sessionKey, id));
      if (!Object.keys(state.cardDrafts).some(drop)) return state;
      return { cardDrafts: Object.fromEntries(Object.entries(state.cardDrafts).filter(([key]) => !drop(key))) };
    }),
  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  setAttachments: (key, paths) =>
    set((state) => ((state.attachments[key] ?? NO_PATHS) === paths ? state : { attachments: { ...state.attachments, [key]: paths } })),
  updateQueued: (key, update) =>
    set((state) => {
      const was = state.queued[key] ?? NONE;
      const next = update(was);
      return next === was ? state : { queued: { ...state.queued, [key]: next } };
    }),
}));

/** Только для тестов. */
export function resetChatUiStoreForTests(): void {
  useChatUiStore.setState({ drafts: {}, attachments: {}, queued: {}, cardDrafts: {} });
}
