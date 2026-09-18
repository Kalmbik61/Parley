/**
 * Состояние панели треда: открыт ли он, докуется ли справа от панели агента и
 * где стоит лента (спецификация 2026-09-08, 6.1–6.3).
 *
 * Строки считает чистый `thread-view.ts`, рисует `components/thread.tsx`; тут
 * только состояние и правило дока. Вид пересчитывается лениво, по объекту
 * карты и геометрии: чужое событие watcher'а приносит ту же карту, и лента
 * остаётся прежней (решение D15).
 */

import type { WorkEntry } from '@harnas/core';
import { useCallback, useRef, useState } from 'react';
import { glyphs } from './glyphs.js';
import { threadView, type ThreadView } from './thread-view.js';

/**
 * Колонок, ниже которых панель агента не опускается: 80 — минимум, на который
 * рассчитан сам Claude Code, и ради ленты ломать его нельзя (решение D21).
 */
export const PANEL_MIN = 80;

/** Влезает ли док: панель отдаёт тред с разделителем и остаётся не уже минимума. */
export const threadFits = (panelCols: number, width: number): boolean =>
  panelCols - width - 1 >= PANEL_MIN;

export interface ThreadOptions {
  /** Колонки панели агента без дока: из них и вычитается тред с разделителем. */
  panelCols: number;
  /** Строк у панели; одну забирает заголовок треда. */
  height: number;
  /** `config.threadWidth`: ширина тела треда (6.1). */
  width: number;
}

export interface ThreadState {
  /** Пользователь попросил тред; доком или оверлеем — решает ширина. */
  open: boolean;
  /** Тред справа от панели: ей осталось не меньше `PANEL_MIN` колонок. */
  docked: boolean;
  /** Док не влезает — тот же вид показывается оверлеем-запасником (6.1). */
  overlay: boolean;
  width: number;
  toggle: () => void;
  close: () => void;
  /** Колесо над тредом: `+` — вниз по ленте, `−` — вверх (6.3). */
  scrollBy: (lines: number) => void;
  /** Вернуть ленту на хвост. */
  follow: () => void;
  /** Вид треда выбранной сессии; `null` — сессии нет, показывать нечего. */
  viewOf: (entry: WorkEntry | undefined, sessionId: string | null) => ThreadView | null;
}

export function useThread({ panelCols, height, width }: ThreadOptions): ThreadState {
  const [open, setOpen] = useState(false);
  // `null` — лента держится хвоста; число — сколько строк от её начала (6.3).
  const [scroll, setScroll] = useState<number | null>(null);
  const g = glyphs();

  // Заголовок треда занимает первую строку колонки, лента идёт под ним.
  const room = Math.max(0, height - 1);
  const fits = threadFits(panelCols, width);

  /**
   * Хвост последнего посчитанного вида: от него отсчитывается уход вверх, и он
   * же говорит, когда прокрутка вернулась к хвосту и лента снова следит за
   * новыми письмами (6.3).
   */
  const tail = useRef(0);
  const cache = useRef<{ key: readonly unknown[]; view: ThreadView } | null>(null);

  const viewOf = useCallback(
    (entry: WorkEntry | undefined, sessionId: string | null): ThreadView | null => {
      if (entry === undefined || sessionId === null) return null;
      const key: readonly unknown[] = [entry.map, sessionId, width, room, scroll];
      const kept = cache.current;
      if (kept !== null && kept.key.every((value, at) => value === key[at])) return kept.view;
      const view = threadView({ entry, sessionId, width, height: room, scroll, g });
      tail.current = Math.max(0, view.total - room);
      cache.current = { key, view };
      return view;
    },
    [width, room, scroll, g],
  );

  const scrollBy = useCallback((lines: number) => {
    setScroll((now) => {
      const next = (now ?? tail.current) + lines;
      // Вернулись к хвосту — снова следим за ним: иначе новое письмо приходило
      // бы ниже окна, а `↓N` считал бы строки, которые и так видны (6.3).
      return next >= tail.current ? null : Math.max(0, next);
    });
  }, []);

  const follow = useCallback(() => setScroll(null), []);

  return {
    open,
    docked: open && fits,
    overlay: open && !fits,
    width,
    toggle: useCallback(() => setOpen((now) => !now), []),
    close: useCallback(() => setOpen(false), []),
    scrollBy,
    follow,
    viewOf,
  };
}
