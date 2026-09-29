/**
 * Уведомления в самом окне (спека окна 2026-09-29, 1.10): окно в фокусе, а решение ждёт в комнате, которой человек
 * сейчас не видит. Системное уведомление macOS тогда лишнее — человек и так за окном, — поэтому решение показывается
 * карточкой справа снизу (`WindowNotes.tsx`). Стор держит только очередь показанных; таймер скрытия ведёт компонент:
 * его отсчёт начинается с показа карточки, а не с записи в стор, и тесты видят его через поддельные таймеры.
 */

import { create } from 'zustand';
import type { FocusTarget } from '../../shared/bridge.js';

/** Через сколько карточка скрывается сама (1.10). */
export const WINDOW_NOTE_MS = 8_000;

/**
 * Сколько карточек стоит разом. Решения ждут в разных комнатах, и каждая — своя карточка (тег, как у системных
 * уведомлений), но столбец выше трёх закрыл бы полокна: старшая уходит.
 */
const SHOWN_MAX = 3;

export interface WindowNote {
  /** Один тег — одна карточка: новое уведомление той же комнаты заменяет прежнее, как у macOS (`main/notifications.ts`). */
  tag: string;
  title: string;
  body: string;
  /** Что открывает `Open` — та же цель, что у клика по системному уведомлению. */
  target: FocusTarget;
}

export interface ShownWindowNote extends WindowNote {
  /** Порядковый номер показа: заменённая карточка — новый номер, и её таймер начинается заново. */
  seq: number;
}

export interface WindowNotesState {
  notes: ShownWindowNote[];
  /** Показывает карточку; с тем же тегом заменяет прежнюю и ставит её последней (самой нижней). */
  show: (note: WindowNote) => void;
  /**
   * Скрывает карточку с тегом. `seq` — номер показа, который скрывает вызывающий: таймер заменённой карточки
   * не должен скрыть её преемницу. Без `seq` — скрыть что бы ни стояло под тегом.
   */
  dismiss: (tag: string, seq?: number) => void;
}

let lastSeq = 0;

export const useWindowNotesStore = create<WindowNotesState>((set) => ({
  notes: [],
  show: (note) => {
    lastSeq += 1;
    const shown: ShownWindowNote = { ...note, seq: lastSeq };
    set((state) => ({ notes: [...state.notes.filter((item) => item.tag !== note.tag), shown].slice(-SHOWN_MAX) }));
  },
  dismiss: (tag, seq) =>
    set((state) => {
      const notes = state.notes.filter((item) => item.tag !== tag || (seq !== undefined && item.seq !== seq));
      // Нечего скрывать — то же состояние: подписчики не перерисовываются зря.
      return notes.length === state.notes.length ? state : { notes };
    }),
}));
