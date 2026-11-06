/**
 * Приёмник кадра роя для canvas 2D (остров): спрайты душ, очистка кадра и аддитивное смешение `'lighter'`. Движок
 * (`@parley/core/swarm`) о canvas не знает, он зовёт только `SwarmSink`.
 */

import { PAL, type SwarmPalette, type SwarmSink } from '@parley/core/swarm';

type Sprites = Record<SwarmPalette, HTMLCanvasElement[]>;

/** Спрайт души: яркое ядро и мягкое свечение, 48×48; `null` — у документа нет 2d-контекста (jsdom). */
function sprite(hex: string): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const x = c.getContext('2d');
  if (x === null || x === undefined) return null;
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const gr = x.createRadialGradient(24, 24, 0, 24, 24, 24);
  const k = (a: number, m: number): string => `rgba(${(r + (255 - r) * m) | 0},${(g + (255 - g) * m) | 0},${(b + (255 - b) * m) | 0},${a})`;
  gr.addColorStop(0, k(1, 0.55));
  gr.addColorStop(0.12, k(0.9, 0.2));
  gr.addColorStop(0.35, k(0.3, 0));
  gr.addColorStop(1, k(0, 0));
  x.fillStyle = gr;
  x.fillRect(0, 0, 48, 48);
  return c;
}

let spriteCache: Sprites | null = null;

/** Спрайты всех палитр, общие для всех роёв; создаются при первом кадре с реальным контекстом. */
function sprites(): Sprites | null {
  if (spriteCache !== null) return spriteCache;
  const out: Partial<Sprites> = {};
  for (const name of Object.keys(PAL) as SwarmPalette[]) {
    const list: HTMLCanvasElement[] = [];
    for (const hex of PAL[name].colors) {
      const made = sprite(hex);
      if (made === null) return null;
      list.push(made);
    }
    out[name] = list;
  }
  spriteCache = out as Sprites;
  return spriteCache;
}

export function createCanvasSink(ctx: CanvasRenderingContext2D): SwarmSink {
  let spr: Sprites | null = null;
  return {
    begin(width, height) {
      spr = sprites();
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
    },
    soul(pal, color, x, y, size, alpha) {
      const img = spr?.[pal][color];
      if (img === undefined) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x, y, size, size);
    },
    end() {
      ctx.globalAlpha = 1;
    },
  };
}
