/**
 * Состояние вида «Chat», которое переживает размонтирование `ChatView` (ревью куска 3): черновик поля
 * ввода и серые элементы очереди по `refKey` сессии. Тело вкладки рисуется только у активной вкладки
 * группы и только в виде «Chat», поэтому переход Chat → Terminal → Chat или на соседнюю вкладку
 * размонтирует вид — а набранный текст и сообщение, уже ушедшее в очередь CLI, пропадать не должны.
 */

import { create } from 'zustand';
import type { QueuedPrompt } from './FeedList.js';

/** Ждущее сообщение и сколько промптов с тем же текстом было в ленте, когда оно ушло. */
export interface Queued extends QueuedPrompt {
  seen: number;
}

export interface ChatUiState {
  drafts: Record<string /* refKey */, string>;
  queued: Record<string /* refKey */, readonly Queued[]>;
  setDraft(key: string, text: string): void;
  /** Обновить очередь сессии; тот же массив — стор не трогается. */
  updateQueued(key: string, update: (was: readonly Queued[]) => readonly Queued[]): void;
}

const NONE: readonly Queued[] = [];

export const useChatUiStore = create<ChatUiState>((set) => ({
  drafts: {},
  queued: {},
  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  updateQueued: (key, update) =>
    set((state) => {
      const was = state.queued[key] ?? NONE;
      const next = update(was);
      return next === was ? state : { queued: { ...state.queued, [key]: next } };
    }),
}));

/** Только для тестов. */
export function resetChatUiStoreForTests(): void {
  useChatUiStore.setState({ drafts: {}, queued: {} });
}
