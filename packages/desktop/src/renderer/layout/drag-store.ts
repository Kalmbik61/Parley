/**
 * Что тащат сейчас (`DragItem`): одна запись на окно. Кладёт её `AppShell` на старте жеста и убирает на конце и отмене.
 *
 * Зачем отдельный стор: `useDndContext()` меняется на каждое движение указателя, и каждый, кто его читает, перерисовывался
 * бы на любое перетаскивание — ленты Chat и комнат, каждый терминал. Здесь предмет меняется дважды за жест, а читатель
 * выбирает из него только то, что ему нужно (`use-drop-target.ts`: карточку доски).
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { DragItem } from './dnd.js';

export interface DragState {
  /** `null` — ничего не тащат (или тащат чужое: `dragItemOf` не узнал предмет). */
  item: DragItem | null;
  setItem(item: DragItem | null): void;
}

export const useDragStore: UseBoundStore<StoreApi<DragState>> = create<DragState>((set) => ({
  item: null,
  setItem: (item) => set({ item }),
}));
