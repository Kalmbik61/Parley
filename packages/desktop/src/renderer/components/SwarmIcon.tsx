/**
 * Живая иконка роя (спека роя v1, 7.5): «соты из капель» — свой `<canvas>` и рендер `swarm-comb.ts`, один на
 * монтирование. Ячеек столько, сколько участников (`total`), полные — сдавшие (`handed`); несдавшие — капли мёда,
 * кружащие вокруг сот. Идущий рой (`running`, `collecting`), у которого есть слот (`useSwarmIconSlot`, не больше трёх
 * на окно), рисуется с `SWARM_ICON_FPS`; реакции — сдача, «готово», вспышка при Reduce motion — идут с частотой
 * экрана, пока `needsFrame`. Законченный рой, `still` (значок группы проекта), Reduce motion (настройка Parley или
 * системная) и иконка без слота — статичный кадр, но реакция на смену данных проигрывается и у них.
 *
 * Подложки нет: тема берётся из окна (`theme`), остров всегда `dark`. `size` — сторона холста, px; холст — `size` ×
 * `devicePixelRatio`. Нет 2d-контекста (jsdom) — иконка ничего не рисует.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { SwarmStatus } from '@parley/core/swarms';
import { isSwarmTerminal } from '@parley/core/swarms';
import { useSwarmIconSlot } from '../lib/swarm-icon-slots.js';
import { SWARM_ICON_FPS } from '../lib/swarm-view.js';
import { createCombIcon, type CombTheme } from './swarm-comb.js';

export interface SwarmIconProps {
  status: SwarmStatus;
  /** Сторона холста, px: строка роя ~16, чип шапки и значок карточки ~14. */
  size: number;
  /** Сколько участников уже сдали: рост — капля летит в свою ячейку. */
  handed?: number;
  /** Сколько участников всего (ячеек до семи). Где прогресс неизвестен (карточка, группа) — условный рой. */
  total: number;
  /** Тема фона: окно берёт её из `useSwarmIconTheme`, остров всегда `dark`. */
  theme: CombTheme;
  /** Значок группы проекта и всё, что не должно двигаться. */
  still?: boolean;
  /**
   * Настройка Parley «Reduce motion»: у окна — `ui.island.motion` (`useSwarmIconMotion`), у острова — `config.motion`.
   * Системное «уменьшить движение» иконка учитывает сама. Стор окна иконка не импортирует: её берёт и остров.
   */
  reducedMotion?: boolean;
}

const REDUCED = '(prefers-reduced-motion: reduce)';

export function SwarmIcon({ status, size, handed = 0, total, theme, still = false, reducedMotion = false }: SwarmIconProps): JSX.Element {
  const slot = useSwarmIconSlot(!isSwarmTerminal(status) && !still && !reducedMotion);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Палитра задаётся при создании: смена темы или размера — новая иконка (первый `set` реакций не даёт).
  const icon = useMemo(() => createCombIcon({ size, theme }), [size, theme]);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  // Цикл кадров читает свежие значения отсюда, не пересоздаваясь.
  const live = useRef({ fps: 0, forced: reducedMotion });
  live.current = { fps: slot ? SWARM_ICON_FPS : 0, forced: reducedMotion };
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const mqlRef = useRef<MediaQueryList | null>(null);
  const isReduced = (): boolean => live.current.forced || mqlRef.current?.matches === true;

  // Холст и контекст; цикл: живой рой — с `SWARM_ICON_FPS`, реакции — на каждом кадре экрана.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    mqlRef.current = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED) : null;
    const ctx = canvas.getContext('2d') ?? null;
    ctxRef.current = ctx;
    if (ctx === null) return undefined;
    let raf = 0;
    let last = 0;
    let wasReduced = isReduced();
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const reduced = isReduced();
      const { fps } = live.current;
      const lively = fps > 0 && !reduced && now - last >= 1000 / fps - 2;
      // Смена системного «уменьшить движение» — один кадр в новом режиме.
      if (lively || icon.needsFrame(now) || reduced !== wasReduced) {
        last = now;
        wasReduced = reduced;
        icon.frame(ctx, now, reduced);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [icon, dpr]);

  // Новые данные роя — в иконку; потом кадр, чтобы статичная иконка тоже показала новое состояние.
  useEffect(() => {
    icon.set({ status, handed, total }, performance.now());
  }, [icon, status, handed, total]);
  useEffect(() => {
    icon.frame(ctxRef.current, performance.now(), isReduced());
    // Перерисовка нужна на смену данных, режима и слота.
  }, [icon, status, handed, total, reducedMotion, slot]);

  return (
    <span aria-hidden="true" data-swarm-icon={status} data-live={slot ? '' : undefined} className="inline-flex shrink-0 items-center justify-center leading-[0]">
      <canvas ref={canvasRef} className="block" width={size * dpr} height={size * dpr} style={{ width: size, height: size }} />
    </span>
  );
}
