/**
 * React-обёртка роя: canvas с учётом `devicePixelRatio` и цикл кадров. Один движок на монтирование; смена `spec`
 * уходит в движок эффектом; кадр рисуется, если пора по `fps` (0 — только переходы и смена спеки) или движок просит
 * (`needsFrame`). Reduced motion — один статичный кадр на смену спеки, без цикла. Нет 2d-контекста (jsdom) — компонент
 * ничего не рисует. Без `setInterval`: размонтирование отменяет rAF.
 */

import { useEffect, useRef } from 'react';
import { createSwarm, type SwarmEngine } from './engine.js';
import type { SwarmSpec } from './spec.js';

export interface SwarmProps {
  spec: SwarmSpec;
  souls: number;
  width: number;
  height: number;
  d: number;
  cy: number;
  k?: number;
  minPx?: number;
  seed?: number;
  /** Кадров в секунду в покое; 0 — рисовать только переходы и смену спеки. */
  fps: number;
  /** Громкость микрофона 0..1 для облика «слушает». */
  mic?: number;
  /** Открытие рта лица 0..1; геттер читается в кадре, без ререндера. */
  mouth?: () => number;
  className?: string;
}

const REDUCED = '(prefers-reduced-motion: reduce)';

export function Swarm(props: SwarmProps): JSX.Element {
  const { spec, souls, width, height, className } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SwarmEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const mqlRef = useRef<MediaQueryList | null>(null);
  // Цикл кадров читает свежие `fps`, `mic` и `mouth` отсюда, не пересоздаваясь.
  const live = useRef({ fps: props.fps, mic: props.mic ?? 0, mouth: props.mouth });
  live.current = { fps: props.fps, mic: props.mic ?? 0, mouth: props.mouth };
  if (engineRef.current === null) {
    engineRef.current = createSwarm(souls, {
      width,
      height,
      d: props.d,
      cy: props.cy,
      ...(props.k === undefined ? {} : { k: props.k }),
      ...(props.minPx === undefined ? {} : { minPx: props.minPx }),
      ...(props.seed === undefined ? {} : { seed: props.seed }),
    });
  }
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (canvas === null || engine === null) return undefined;
    mqlRef.current = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED) : null;
    ctxRef.current = canvas.getContext('2d') ?? null;
    const ctx = ctxRef.current;
    if (ctx === null) return undefined;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mqlRef.current?.matches === true) return undefined;
    let raf = 0;
    let last = 0;
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const { fps, mic, mouth } = live.current;
      const interval = 1000 / (fps || 30) - 2;
      if ((fps > 0 || engine.needsFrame()) && now - last >= interval) {
        last = now;
        engine.frame(now, ctx, mqlRef.current?.matches === true, mic, mouth?.() ?? 0);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [dpr]);

  useEffect(() => {
    const engine = engineRef.current;
    if (engine === null) return;
    const reduced = mqlRef.current?.matches === true;
    const now = performance.now();
    engine.setSpec(spec, now, reduced);
    if (reduced) engine.frame(now, ctxRef.current, true, live.current.mic);
  }, [spec]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="swarm"
      data-shape={spec.shape}
      data-emo={spec.shape === 'face' ? (spec.emo ?? undefined) : undefined}
      className={className}
      width={width * dpr}
      height={height * dpr}
      style={{ width, height }}
    />
  );
}
