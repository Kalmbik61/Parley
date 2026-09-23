/**
 * Состояние ленты комнаты: прокрутка и кэш вида (дизайн комнаты 2026-09-23,
 * раздел 5.4). По образцу `use-thread.ts`, но без дока: комната не решает, где
 * ей стоять и какой ширины быть — она всегда занимает место панели целиком, а
 * размеры ей называет `app.tsx` (раздел 3).
 *
 * Вид пересчитывается лениво, по объекту карты и геометрии: чужое событие
 * watcher'а приносит ту же карту, и лента остаётся прежней (решение D15
 * прежнего дизайна треда — комната наследует его без изменений).
 */

import type { WorkEntry } from '@harnas/core';
import { useCallback, useRef, useState } from 'react';
import { glyphs } from './glyphs.js';
import { roomView, type RoomView } from './room-view.js';

export interface RoomOptions {
  /** Ширина ленты — те же колонки, что достались бы гостю. */
  width: number;
  /** Строк на экране — те же строки, что достались бы гостю. */
  height: number;
  /** Модель сессии по индексу логов; core о нём не знает (дизайн комнаты, 4). */
  modelOf: (id: string) => string | null;
}

/** Где стоит лента: чья это работа и сколько строк от её начала (5.4). */
interface Scroll {
  owner: string | null;
  at: number;
}

export interface RoomState {
  width: number;
  height: number;
  /** Колесо и клавиши без префикса: `+` — вниз по ленте, `−` — вверх (5.4). */
  scrollBy: (lines: number) => void;
  /** Вернуть ленту на хвост: `End`/`G` (5.4). */
  follow: () => void;
  /**
   * Вид ленты выбранной работы; `null` — работа не выбрана, показывать нечего.
   * Смена работы открывает ленту с хвоста (раздел 3, «Граничные случаи»).
   */
  viewOf: (entry: WorkEntry | undefined) => RoomView | null;
}

export function useRoom({ width, height, modelOf }: RoomOptions): RoomState {
  const [scroll, setScroll] = useState<Scroll | null>(null);
  const g = glyphs();

  /** Хвост последнего посчитанного вида (5.4). */
  const tail = useRef(0);
  /** Работа показанной комнаты: с ней сверяется хозяин прокрутки. */
  const owner = useRef<string | null>(null);
  const cache = useRef<{ key: readonly unknown[]; view: RoomView } | null>(null);

  const viewOf = useCallback(
    (entry: WorkEntry | undefined): RoomView | null => {
      if (entry === undefined) return null;
      const workId = entry.map.work.id;
      const key: readonly unknown[] = [entry.map, width, height, scroll, modelOf];
      const kept = cache.current;
      if (kept !== null && kept.key.every((value, at) => value === key[at])) return kept.view;
      const cut = (at: number | null): RoomView =>
        roomView({ entry, width, height, scroll: at, g, modelOf });
      let view = cut(scroll?.at ?? null);
      // Комната принадлежит своей работе: у другой работы лента другая, и
      // открывается она с хвоста, а не с чужого смещения (граничные случаи).
      if (scroll !== null && scroll.owner !== workId) view = cut(null);
      owner.current = workId;
      tail.current = Math.max(0, view.total - height);
      cache.current = { key, view };
      return view;
    },
    [width, height, scroll, modelOf, g],
  );

  const scrollBy = useCallback((lines: number) => {
    setScroll((now) => {
      const from = now !== null && now.owner === owner.current ? now.at : tail.current;
      const next = from + lines;
      // Вернулись к хвосту — снова следим за ним: иначе новое письмо приходило
      // бы ниже окна, а `↓N` считал бы строки, которые и так видны (5.4).
      return next >= tail.current ? null : { owner: owner.current, at: Math.max(0, next) };
    });
  }, []);

  const follow = useCallback(() => setScroll(null), []);

  return { width, height, scrollBy, follow, viewOf };
}
