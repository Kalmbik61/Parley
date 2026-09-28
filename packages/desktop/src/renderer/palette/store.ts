/**
 * Стор палитры ⌘J (кусок 6.2, спека 3.5): открыта ли палитра, в каком режиме и с каким
 * запросом. Единственный флаг «палитра открыта» в окне — его читают обработчик клавиш
 * (`keys/handler.ts`: ⌘1–9 выбирают строку) и кнопки, которые палитру открывают.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

export type PaletteMode = 'default' | 'open' | 'splitRight' | 'splitDown' | 'files';

export interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  query: string;
  openWith(mode: PaletteMode, query?: string): void;
  close(): void;
  setQuery(query: string): void;
  /** ⌘1–9 из обработчика окна (pickPaletteRow): Palette выбирает строку с этим номером среди видимых. */
  pickRow(index: number): void;
}

/**
 * Выбор строки по номеру знает только смонтированная `Palette` — видимые строки есть лишь у
 * неё. Ссылка — не состояние: выбор должен случиться сразу, в том же нажатии, которое
 * обработчик окна уже погасил, а не эффектом после отрисовки.
 */
let rowPicker: ((index: number) => void) | null = null;

/** `Palette` ставит свой выбор строки на время жизни; `null` — снять. */
export function registerRowPicker(picker: ((index: number) => void) | null): void {
  rowPicker = picker;
}

export const usePaletteStore: UseBoundStore<StoreApi<PaletteState>> = create<PaletteState>((set, get) => ({
  open: false,
  mode: 'default',
  query: '',
  openWith: (mode, query = '') => set({ open: true, mode, query }),
  close: () => set({ open: false, query: '' }),
  setQuery: (query) => set({ query }),
  pickRow: (index) => {
    if (get().open) rowPicker?.(index);
  },
}));
