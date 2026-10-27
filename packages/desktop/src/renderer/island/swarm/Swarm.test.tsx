/** Обёртка роя в jsdom: canvas с учётом DPR, нет 2d-контекста — не падает, форма видна в `data-shape`. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swarmSpecFor } from './spec.js';
import { HOST_IDLE } from '../assistant/store.js';
import type { VoiceFrame } from '../assistant/voice-features.js';
import * as engineModule from './engine.js';
import { Swarm } from './Swarm.js';

const IDLE = swarmSpecFor(HOST_IDLE, 'idle', true);
const THINKING = swarmSpecFor({ ...HOST_IDLE, phase: 'thinking' }, 'idle', true);
const JOY = swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false);
const VOICE: VoiceFrame = { amp: 0.7, visemes: { a: 0.5, i: 0, u: 0, m: 0 } };

/**
 * Поддельный цикл кадров: контекст считает кадры (`clearRect`), rAF копит колбэки, `tick(from, to)` гоняет их каждые
 * 16 мс, часы `performance.now` ставит `setClock`. `reduced` — ответ `matchMedia` на reduced motion.
 */
function fakeLoop(reduced: boolean): { draws: () => number; tick: (from: number, to: number) => void; setClock: (ms: number) => void } {
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  let frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query }));
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  return {
    draws: () => ctx.clearRect.mock.calls.length,
    tick: (from, to) => {
      for (let t = from; t < to; t += 16) {
        clock = t;
        const run = frames;
        frames = [];
        for (const cb of run) cb(t);
      }
    },
    setClock: (ms) => {
      clock = ms;
    },
  };
}

beforeEach(() => {
  // jsdom не реализует getContext и пишет «Not implemented» — глушим, возвращая null, как в проде без контекста.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Swarm', () => {
  it('canvas: ширина с учётом devicePixelRatio, без контекста не падает', () => {
    render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    const canvas = screen.getByTestId('swarm') as HTMLCanvasElement;
    expect(canvas.width).toBe(28 * (window.devicePixelRatio || 1));
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('смена spec меняет data-shape', () => {
    const { rerender } = render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('dot');
    rerender(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('sphere');
  });

  it('лицо: data-shape="face" и data-emo; у сферы data-emo нет', () => {
    const { rerender } = render(<Swarm spec={JOY} souls={20} width={420} height={136} d={86} cy={62} fps={0} voice={() => VOICE} />);
    const canvas = screen.getByTestId('swarm');
    expect(canvas.getAttribute('data-shape')).toBe('face');
    expect(canvas.getAttribute('data-emo')).toBe('joy');
    rerender(<Swarm spec={THINKING} souls={20} width={420} height={136} d={86} cy={62} fps={0} voice={() => VOICE} />);
    expect(canvas.getAttribute('data-emo')).toBeNull();
  });

  it('voice — геттер: читается в кадре, без ререндера, и кадр голоса уходит в движок', () => {
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const voice = vi.fn(() => VOICE);
    const create = vi.spyOn(engineModule, 'createSwarm');
    render(<Swarm spec={JOY} souls={20} width={420} height={136} d={86} cy={62} fps={60} voice={voice} />);
    const engine = create.mock.results[0]!.value as ReturnType<typeof engineModule.createSwarm>;
    const step = vi.spyOn(engine, 'frame');
    expect(voice).not.toHaveBeenCalled();
    frames.shift()!(1000);
    expect(voice).toHaveBeenCalled();
    expect(step).toHaveBeenLastCalledWith(1000, ctx, false, 0, VOICE);
  });

  it('P1: мини-рой в покое — 0 кадров; pulse даёт кадры на длительность реакции, потом снова 0', () => {
    const { draws, tick, setClock } = fakeLoop(false);
    setClock(1000);
    const { rerender } = render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    tick(1000, 3000);
    expect(draws()).toBe(1); // кадр спеки при монтировании
    setClock(3000);
    rerender(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} pulse={{ reaction: 'spin', at: 3000 }} />);
    tick(3000, 4400);
    const during = draws() - 1;
    expect(during).toBeGreaterThan(35); // 1,4 с при 30 к/с
    expect(during).toBeLessThan(50);
    tick(4400, 8000);
    expect(draws() - 1 - during).toBeLessThanOrEqual(1); // последний кадр снимает реакцию
    const settled = draws();
    rerender(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} pulse={{ reaction: 'spin', at: 3000 }} />);
    tick(8000, 10000);
    expect(draws()).toBe(settled); // тот же pulse повторно — ничего
  });

  it('pulse из прошлого при монтировании кадров не добавляет', () => {
    const { draws, tick, setClock } = fakeLoop(false);
    setClock(5000);
    render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} pulse={{ reaction: 'spin', at: 1000 }} />);
    tick(5000, 7000);
    expect(draws()).toBe(1);
  });

  it('reduced motion: pulse — вспышка 300 мс без цикла в покое', () => {
    const { draws, tick, setClock } = fakeLoop(true);
    setClock(1000);
    const { rerender } = render(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={30} />);
    tick(1000, 3000);
    const still = draws();
    expect(still).toBeLessThanOrEqual(2); // статичный кадр спеки
    setClock(3000);
    rerender(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={30} pulse={{ reaction: 'hop', at: 3000 }} />);
    tick(3000, 6000);
    const flash = draws() - still;
    expect(flash).toBeGreaterThan(5);
    expect(flash).toBeLessThanOrEqual(12); // 300 мс при 30 к/с
  });

  it('reducedMotion (настройка Parley «Reduce motion») — как системная: без цикла в покое, pulse — только вспышка', () => {
    const { draws, tick, setClock } = fakeLoop(false);
    setClock(1000);
    const { rerender } = render(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={30} reducedMotion />);
    tick(1000, 3000);
    const still = draws();
    expect(still).toBeLessThanOrEqual(2);
    setClock(3000);
    rerender(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={30} reducedMotion pulse={{ reaction: 'hop', at: 3000 }} />);
    tick(3000, 6000);
    const flash = draws() - still;
    expect(flash).toBeGreaterThan(5);
    expect(flash).toBeLessThanOrEqual(12);
  });

  it('размонтирование не оставляет цикла кадров', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const { unmount } = render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={30} />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
