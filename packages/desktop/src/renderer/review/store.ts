/**
 * Стор ревью (кусок 8.2a, решение сверки I8) — не сохраняется ни в `ui.json`, ни в
 * раскладку. Выбор сессии в шапке «Изменений» до смены работы (спека 11.1) нигде больше
 * не живёт, а `SessionRowMenu` до состояния панели не дотянется. Путь файла в `TabSpec`
 * вида `diff` менял бы сохраняемый формат раскладки — поэтому разовый переход к файлу
 * тоже здесь.
 */

import type { WorkEntry } from '@harnas/core';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { bufferKey } from '../files/buffer.js';
import { focusedSessionOf, useLayoutStore, type LayoutState } from '../layout/store.js';

export interface ReviewState {
  /** Выбор сессии в шапке «Изменений» по работе; записи нет — сессия в фокусе. */
  changesSession: Record<string /* workKey */, string /* sessionId */>;
  selectChangesSession(workKey: string, sessionId: string): void;
  /** Разовый переход вкладки диффа к файлу; ключ — bufferKey(workKey, tabId) (7.3a). */
  revealed: Record<string, { path: string; nonce: number }>;
  revealFile(workKey: string, tabId: string, path: string): void;
}

export const useReviewStore: UseBoundStore<StoreApi<ReviewState>> = create<ReviewState>((set) => ({
  changesSession: {},
  selectChangesSession: (workKey, sessionId) =>
    set((state) => ({ changesSession: { ...state.changesSession, [workKey]: sessionId } })),
  revealed: {},
  revealFile: (workKey, tabId, path) =>
    set((state) => {
      // Ключ с работой: id вкладки `diff:s-02` одинаков у двух работ. `nonce` растёт на
      // каждый вызов — повторный клик по тому же файлу снова прокручивает (8.3).
      const key = bufferKey(workKey, tabId);
      const nonce = (state.revealed[key]?.nonce ?? 0) + 1;
      return { revealed: { ...state.revealed, [key]: { path, nonce } } };
    }),
}));

/** Сессия шапки «Изменений»: выбор человека, пока сессия в карте; иначе focusedSessionOf (7.2). */
export function changesSessionOf(
  review: Pick<ReviewState, 'changesSession'>,
  layout: Pick<LayoutState, 'layouts' | 'entries'>,
  workKey: string,
  entry: WorkEntry,
): string | null {
  const chosen = review.changesSession[workKey];
  if (chosen !== undefined && entry.map.sessions.some((session) => session.id === chosen)) return chosen;
  // Одна «сессия в фокусе» на «Файлы» и «Изменения».
  return focusedSessionOf(layout, workKey);
}

/** Смена активной работы стирает выбор той, с которой ушли: подписка на activeWorkKey стора раскладки (AppShell, 8.2b). */
export function bindReviewToLayout(): () => void {
  return useLayoutStore.subscribe((state, prev) => {
    const left = prev.activeWorkKey;
    if (left === null || left === state.activeWorkKey) return;
    const { changesSession } = useReviewStore.getState();
    if (!(left in changesSession)) return;
    useReviewStore.setState({
      changesSession: Object.fromEntries(Object.entries(changesSession).filter(([key]) => key !== left)),
    });
  });
}
