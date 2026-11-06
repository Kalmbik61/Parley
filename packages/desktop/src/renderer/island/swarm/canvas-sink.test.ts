/** Canvas-приёмник острова на поддельном 2d-контексте: очистка, `'lighter'`, спрайт души, сброс альфы. */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeCtx {
  calls: string[];
  drawn: { img: unknown; args: number[]; alpha: number }[];
  globalAlpha: number;
  globalCompositeOperation: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: unknown, ...args: number[]): void;
}

function fakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    calls: [],
    drawn: [],
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    clearRect(x, y, w, h) {
      ctx.calls.push(`clearRect ${x},${y},${w},${h}`);
    },
    drawImage(img, ...args) {
      ctx.drawn.push({ img, args, alpha: ctx.globalAlpha });
    },
  };
  return ctx;
}

/** Свежий модуль (кэш спрайтов — на уровне модуля), опционально с 2d-контекстом у спрайтовых canvas. */
async function load(withSpriteContext: boolean) {
  vi.resetModules();
  const spriteContext = { createRadialGradient: () => ({ addColorStop: () => {} }), fillRect: () => {}, fillStyle: '' };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => (withSpriteContext ? spriteContext : null)) as never);
  const { createCanvasSink } = await import('./canvas-sink.js');
  return { createCanvasSink, getContext };
}

afterEach(() => vi.restoreAllMocks());

describe('createCanvasSink', () => {
  it('begin: clearRect(0, 0, w, h) и режим смешения lighter', async () => {
    const { createCanvasSink } = await load(true);
    const ctx = fakeCtx();
    createCanvasSink(ctx as unknown as CanvasRenderingContext2D).begin(120, 80);
    expect(ctx.calls).toEqual(['clearRect 0,0,120,80']);
    expect(ctx.globalCompositeOperation).toBe('lighter');
  });

  it('soul: globalAlpha и drawImage(спрайт, x, y, size, size); спрайт зависит от палитры и цвета', async () => {
    const { createCanvasSink } = await load(true);
    const ctx = fakeCtx();
    const sink = createCanvasSink(ctx as unknown as CanvasRenderingContext2D);
    sink.begin(100, 100);
    sink.soul('amber', 0, 10, 20, 6, 0.5);
    sink.soul('amber', 1, 11, 21, 7, 0.25);
    sink.soul('coral', 0, 12, 22, 8, 1);
    sink.soul('amber', 0, 13, 23, 9, 0.75);
    expect(ctx.drawn.map((d) => [d.args, d.alpha])).toEqual([
      [[10, 20, 6, 6], 0.5],
      [[11, 21, 7, 7], 0.25],
      [[12, 22, 8, 8], 1],
      [[13, 23, 9, 9], 0.75],
    ]);
    const [a0, a1, c0, a0again] = ctx.drawn.map((d) => d.img);
    expect(a0).toBeInstanceOf(HTMLCanvasElement);
    expect((a0 as HTMLCanvasElement).width).toBe(48);
    expect(a0).toBe(a0again); // спрайт кэшируется
    expect(new Set([a0, a1, c0]).size).toBe(3);
  });

  it('end: globalAlpha возвращается к 1', async () => {
    const { createCanvasSink } = await load(true);
    const ctx = fakeCtx();
    const sink = createCanvasSink(ctx as unknown as CanvasRenderingContext2D);
    sink.begin(10, 10);
    sink.soul('gray', 2, 0, 0, 4, 0.3);
    expect(ctx.globalAlpha).toBe(0.3);
    sink.end();
    expect(ctx.globalAlpha).toBe(1);
  });

  it('без 2d-контекста у спрайтов (jsdom) души не рисуются, а begin и end работают; кэш не запоминает пустоту', async () => {
    const { createCanvasSink, getContext } = await load(false);
    const ctx = fakeCtx();
    const sink = createCanvasSink(ctx as unknown as CanvasRenderingContext2D);
    sink.begin(10, 10);
    sink.soul('amber', 0, 1, 2, 3, 0.5);
    sink.end();
    expect(ctx.calls).toEqual(['clearRect 0,0,10,10']);
    expect(ctx.drawn).toEqual([]);
    expect(ctx.globalAlpha).toBe(1);
    // Контекст появился: следующий begin строит спрайты заново.
    getContext.mockImplementation((() => ({ createRadialGradient: () => ({ addColorStop: () => {} }), fillRect: () => {}, fillStyle: '' })) as never);
    sink.begin(10, 10);
    sink.soul('amber', 0, 1, 2, 3, 0.5);
    expect(ctx.drawn).toHaveLength(1);
  });
});
