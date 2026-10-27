/**
 * Уши острова в вырезе (#9 §12.1, план 3b B28): статус правого уха по приоритету, общая ширина ушей
 * `max(h + 4, статус + 18)`, высота — высота выреза, промежуток — ширина выреза (N3); слева мини-рой 24 px по правилам
 * малого роя — в покое 0 к/с, реакция только вспышкой (N4); уменьшенное движение — рой статичен, точка статуса не
 * пульсирует, уши без проявления (N10). jsdom не раскладывает страницу: ширину статуса подменяет `offsetWidth`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { HOST_IDLE } from './assistant/store.js';
import type { IslandAssistantProps } from './IslandView.js';
import type { IslandModel } from './model.js';
import { earStatus, earWidth, NotchEars, notchShift, type EarStatus, type Notch } from './NotchEars.js';
import * as engineModule from './swarm/engine.js';

const ISLAND_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'island.css'), 'utf8');

/** Вырез MacBook Pro 14″ (замер спеки §12.2): 185 × 32 pt, центр в кадре окна 480 pt — на половине точки. */
const NOTCH: Notch = { width: 185, height: 32, centerX: 239.5 };

const COUNTS: Pick<IslandModel, 'waiting' | 'working' | 'proposals'> = { waiting: 0, working: 0, proposals: 0 };

function assistantProps(patch: Partial<IslandAssistantProps> = {}): IslandAssistantProps {
  return {
    view: {
      host: HOST_IDLE, input: 'idle', level: 0, draft: '', notice: null, cardError: null, sending: null, queue: [], history: [], deciding: null, hotkey: 'Alt+Space', pending: null,
      sentenceMood: null, speakOn: false,
      onDraft: vi.fn(), onSubmit: vi.fn(), onMic: vi.fn(), onDecide: vi.fn(), onUnqueue: vi.fn(), onShowRequests: vi.fn(), onToggleSpeak: vi.fn(),
    },
    open: false, collapsed: false, busy: false, mini: null, onOpen: vi.fn(),
    ...patch,
  };
}

function ears(status: EarStatus | null, swarm: { assistant: IslandAssistantProps | null; reducedMotion: boolean } | null = { assistant: null, reducedMotion: false }, onEar = vi.fn()) {
  render(<NotchEars notch={NOTCH} status={status} swarm={swarm} onEar={onEar} />);
  return { onEar, left: screen.getByTestId('island-ear-left'), right: screen.getByTestId('island-ear-right'), gap: screen.getByTestId('island-notch-gap') };
}

/** Правило `island.css` с ровно таким селектором: тело между `{` и `}`. */
function cssRule(selector: string): string {
  const rule = ISLAND_CSS.split('}').map((chunk) => chunk.split('{')).find((parts) => parts.length >= 2 && parts.at(-2)!.split('*/').at(-1)!.trim() === selector);
  expect(rule, selector).toBeDefined();
  return rule!.at(-1)!;
}

/**
 * Подставной цикл кадров, как в тесте «места» карточки: контекст считает кадры (`clearRect`), rAF копит колбэки,
 * `tick(from, to)` гоняет их каждые 16 мс, часы `performance.now` ставит `setClock`.
 */
function fakeFrames(): { draws: () => number; tick: (from: number, to: number) => void; setClock: (ms: number) => void } {
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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('статус правого уха (N4)', () => {
  it('приоритет: ошибка → ждёт тебя (запросы и комнаты) → работает → ✅ N; ничего нет — пусто', () => {
    expect(earStatus({ waiting: 1, working: 2, proposals: 1 }, 3, true)).toEqual({ kind: 'error' });
    expect(earStatus({ waiting: 1, working: 2, proposals: 1 }, 3, false)).toEqual({ kind: 'waiting', count: 2 });
    expect(earStatus({ ...COUNTS, proposals: 1, working: 2 }, 3, false)).toEqual({ kind: 'waiting', count: 1 });
    expect(earStatus({ ...COUNTS, working: 2 }, 3, false)).toEqual({ kind: 'working', count: 2 });
    expect(earStatus(COUNTS, 3, false)).toEqual({ kind: 'done', count: 3 });
    expect(earStatus({ waiting: 0, working: 0 }, 0, false)).toBeNull();
  });

  it('ошибка — красная точка и «!», ждёт — точка акцента и N, работает — синяя пульсирующая точка и N, Done — «✅ N»', () => {
    const cases: Array<[EarStatus, string, string | null, string]> = [
      [{ kind: 'error' }, '!', 'bg-[#dc604c]', S.island.ears.error],
      [{ kind: 'waiting', count: 2 }, '2', 'bg-[var(--color-accent)]', S.island.ears.waiting(2)],
      [{ kind: 'working', count: 3 }, '3', 'bg-[#5fb4ff]', S.island.ears.working(3)],
      [{ kind: 'done', count: 4 }, '✅ 4', null, S.island.ears.done(4)],
    ];
    for (const [status, text, dot, label] of cases) {
      const { right } = ears(status);
      expect(right.textContent, status.kind).toBe(text);
      expect(right.getAttribute('aria-label'), status.kind).toBe(label);
      const mark = right.querySelector('[data-testid="island-ear-dot"]');
      if (dot === null) expect(mark, status.kind).toBeNull();
      else {
        expect(mark?.getAttribute('class'), status.kind).toContain(dot);
        // Точка 6 px; пульсирует прозрачностью только у работы.
        expect(mark?.getAttribute('class'), status.kind).toContain('size-1.5');
        expect(mark?.getAttribute('class')?.includes('island-ear-pulse'), status.kind).toBe(status.kind === 'working');
      }
      cleanup();
    }
  });

  it('без статуса правое ухо пустое и без подписи', () => {
    const { right } = ears(null);
    expect(right.textContent).toBe('');
    expect(right.hasAttribute('aria-label')).toBe(false);
  });
});

describe('размер ушей (N3)', () => {
  it('ширина уха — max(h + 4, ширина статуса + 18), статус — с округлением вверх', () => {
    expect(earWidth(32, 0)).toBe(36);
    expect(earWidth(32, 18)).toBe(36);
    expect(earWidth(32, 19)).toBe(37);
    expect(earWidth(32, 27.2)).toBe(46);
  });

  it('без статуса уши по h + 4, промежуток — ширина выреза, высота — высота выреза; форма nw + 2·ear', () => {
    const { left, right, gap, onEar } = ears(null);
    expect(left.style.width).toBe('36px');
    expect(right.style.width).toBe('36px');
    expect(gap.style.width).toBe('185px');
    expect(screen.getByTestId('island-ears').style.height).toBe('32px');
    expect(onEar).toHaveBeenLastCalledWith(36);
    const total = [left, gap, right].reduce((sum, part) => sum + parseFloat(part.style.width), 0);
    expect(total).toBe(NOTCH.width + 2 * 36);
  });

  it('широкий статус раздвигает оба уха одинаково: форма остаётся по центру выреза', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(30);
    const { left, right, onEar } = ears({ kind: 'working', count: 12 });
    expect(right.style.width).toBe('48px');
    expect(left.style.width).toBe('48px');
    expect(onEar).toHaveBeenLastCalledWith(48);
  });

  it('сдвиг формы от середины кадра к центру выреза — с точностью до половины точки', () => {
    const before = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    try {
      expect(notchShift(NOTCH)).toBe(-0.5);
      expect(notchShift({ ...NOTCH, centerX: 240 })).toBe(0);
      expect(notchShift({ ...NOTCH, centerX: 240.5 })).toBe(0.5);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: before });
    }
  });
});

describe('мини-рой в левом ухе (N4)', () => {
  it('canvas 24 px — малый рой; подпись уха для чтения с экрана', () => {
    const create = vi.spyOn(engineModule, 'createSwarm');
    const { left } = ears(null);
    const swarm = within(left).getByTestId('swarm') as HTMLCanvasElement;
    expect(swarm.style.width).toBe('24px');
    expect(swarm.style.height).toBe('24px');
    expect(create).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ width: 24, height: 24 }));
    expect(left.getAttribute('role')).toBe('img');
    expect(left.getAttribute('aria-label')).toBe(S.island.ears.swarm);
  });

  it('без помощника — облик покоя; с помощником — его фаза, как у мини-роя пилюли', () => {
    ears(null);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('dot');
    cleanup();
    ears(null, { assistant: assistantProps({ view: { ...assistantProps().view, host: { ...HOST_IDLE, phase: 'thinking' } } }), reducedMotion: false });
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).not.toBe('dot');
  });

  it('P1: в покое 0 кадров; реакция — короткая вспышка, затем снова 0', () => {
    const { draws, tick, setClock } = fakeFrames();
    setClock(1000);
    const { rerender } = render(<NotchEars notch={NOTCH} status={null} swarm={{ assistant: assistantProps(), reducedMotion: false }} />);
    tick(1000, 3000);
    const rest = draws();
    tick(3000, 6000);
    expect(draws()).toBe(rest);
    setClock(6000);
    rerender(<NotchEars notch={NOTCH} status={null} swarm={{ assistant: assistantProps({ pulse: { reaction: 'hop', at: 6000 } }), reducedMotion: false }} />);
    tick(6000, 9000);
    const flashed = draws();
    expect(flashed).toBeGreaterThan(rest);
    expect(flashed - rest).toBeLessThanOrEqual(14); // вспышка 300 мс при 30 к/с, не постоянный цикл
    tick(9000, 12000);
    expect(draws()).toBe(flashed);
  });

  it('помощник занят — рой живёт 30 к/с', () => {
    const { draws, tick, setClock } = fakeFrames();
    setClock(1000);
    render(<NotchEars notch={NOTCH} status={null} swarm={{ assistant: assistantProps({ busy: true }), reducedMotion: false }} />);
    tick(1000, 2000);
    const first = draws();
    tick(2000, 3000);
    expect(draws() - first).toBeGreaterThan(20);
  });

  it('без роя (образец размера для зоны нажатия) — уши той же ширины, без canvas и без подписи', () => {
    const { left } = ears(null, null);
    expect(left.style.width).toBe('36px');
    expect(within(left).queryByTestId('swarm')).toBeNull();
    expect(left.hasAttribute('role')).toBe(false);
  });
});

describe('уменьшенное движение (N10, §12.5)', () => {
  it('«Reduce motion» Parley доходит до роя в ухе: статичный кадр', () => {
    const engines: Array<ReturnType<typeof vi.fn>> = [];
    const real = engineModule.createSwarm;
    vi.spyOn(engineModule, 'createSwarm').mockImplementation((...args) => {
      const engine = real(...args);
      engines.push(vi.spyOn(engine, 'setSpec') as unknown as ReturnType<typeof vi.fn>);
      return engine;
    });
    ears(null, { assistant: null, reducedMotion: true });
    expect(engines).toHaveLength(1);
    expect(engines[0]).toHaveBeenCalledWith(expect.objectContaining({ shape: 'dot' }), expect.any(Number), true);
  });

  it('уши проступают island-reveal — при уменьшенном движении появление снято', () => {
    ears({ kind: 'working', count: 1 });
    expect(screen.getByTestId('island-ears').className).toContain('island-reveal');
    expect(cssRule("[data-motion='reduce'] .island-reveal")).toContain('animation: none;');
  });

  it('точка статуса пульсирует только прозрачностью; системная и Parley «Reduce motion» её останавливают', () => {
    expect(cssRule('.island-ear-pulse')).toContain('animation: island-ear-pulse');
    const frame = /@keyframes island-ear-pulse\s*\{\s*50%\s*\{([^}]*)\}/.exec(ISLAND_CSS)?.[1];
    expect(frame).toContain('opacity: 0.35;');
    expect(frame).not.toContain('transform');
    const reduced = ISLAND_CSS.split('@media (prefers-reduced-motion: reduce)').slice(1).some((block) => /^\s*\{\s*\.island-ear-pulse\s*\{\s*animation: none;/.test(block));
    expect(reduced).toBe(true);
    expect(cssRule("[data-motion='reduce'] .island-ear-pulse")).toContain('animation: none;');
  });
});
