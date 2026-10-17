/**
 * Движок роя душ на Canvas 2D: порт класса `Swarm` из одобренного макета island-mockup.html (спека 2026-10-14,
 * раздел 9) без лица и эмоций. Без React; рисует через переданный контекст (`null` — только шаг, для тестов и jsdom).
 * Душа — точка со спрайтом «ядро + мягкое свечение»; формы: точка, облако пятен, сфера Фибоначчи с короной-кольцом;
 * эффекты: слушание (сжатие по громкости и волна), кольцо подтверждения, поток ответа, дуга инструмента.
 * Все души живут в долях `d` (радиус сферы 0.5), экран — `cx + x * d`, `cy + y * d`.
 */

import { BLOBS, DUR, PAL, type SwarmPalette, type SwarmSpec } from './spec.js';

export interface SwarmOptions {
  width: number;
  height: number;
  d: number;
  cy: number;
  k?: number;
  minPx?: number;
  seed?: number;
}

export interface SwarmEngine {
  setSpec(spec: SwarmSpec, now: number, reducedMotion: boolean): void;
  /** Шаг и отрисовка одного кадра; `ctx` null — только шаг (тесты, jsdom). `mic` — громкость 0..1 для fx listen. */
  frame(now: number, ctx: CanvasRenderingContext2D | null, reducedMotion: boolean, mic: number): void;
  /** Нужен ли кадр: идёт переход, сменилась палитра или спека. */
  needsFrame(): boolean;
  /** Для тестов: положения душ в долях d (x, y, z) после последнего кадра. */
  readonly souls: ReadonlyArray<{ readonly x: number; readonly y: number; readonly z: number; readonly corona: boolean }>;
}

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2);
/** Детерминированный генератор (mulberry32): один seed — один и тот же рой. */
const rng = (seed: number): (() => number) => {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const gauss = (R: () => number): number => Math.sqrt(-2 * Math.log(R() + 1e-9)) * Math.cos(TAU * R());
const hs = (n: number): number => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

/** Наклон оси сферы 16°. */
const CT = Math.cos((16 * Math.PI) / 180);
const ST = Math.sin((16 * Math.PI) / 180);

interface Soul {
  x: number;
  y: number;
  z: number;
  /** Положение на момент начала перехода. */
  fx: number;
  fy: number;
  fz: number;
  /** Видимость 0..1, плавно тянется к `vis`. */
  v: number;
  /** Задержка перехода и закрутка спирали. */
  rd: number;
  sp: number;
  sz: number;
  /** Индекс цвета: 0 основной, 1 светлый, 2 второй. */
  ci: number;
  tw: number;
  tp: number;
  rk: number;
  corona: boolean;
  gx: number;
  gy: number;
  gz: number;
  ru: number;
  rv: number;
  /** Участвует в потоке ответа. */
  fl: boolean;
  fph: number;
  /** Радиус короны и её скорость вращения. */
  rc: number;
  wc: number;
  /** Угол на кольце подтверждения. */
  ra: number;
  /** Единичный вектор на сфере. */
  ux: number;
  uy: number;
  uz: number;
  /** Номер пятна облака. */
  b: number;
}

interface Target {
  x: number;
  y: number;
  z: number;
  /** Множители яркости и размера. */
  m: number;
  sm: number;
  /** Индекс цвета. */
  c: number;
}

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

const shapeClass = (shape: SwarmSpec['shape']): 'cloud' | 'sphere' => (shape === 'sphere' ? 'sphere' : 'cloud');

class SwarmImpl implements SwarmEngine {
  readonly souls: Soul[] = [];
  private readonly W: number;
  private readonly H: number;
  private readonly d: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly k: number;
  private readonly minPx: number;
  private readonly bd: Array<{ ax: number; ay: number; per: number; ph: number }>;
  private sp: SwarmSpec | null = null;
  private key: string | null = null;
  private dirty = true;
  private trans = false;
  private tr0 = -1e9;
  private dur = 1;
  private palTo: SwarmPalette = 'amber';
  private palFrom: SwarmPalette = 'amber';
  private palT = 1;
  private T = 0;
  private rot = 0.5;
  private rv = 0.35;
  private mic = 0.4;
  private gl = 0;
  private last = 0;
  private cr = 1;
  private sr = 0;
  private readonly o: Target = { x: 0, y: 0, z: 0, m: 1, sm: 1, c: 0 };

  constructor(count: number, o: SwarmOptions) {
    this.W = o.width;
    this.H = o.height;
    this.d = o.d;
    this.cx = o.width / 2;
    this.cy = o.cy;
    this.k = o.k ?? 0.058;
    this.minPx = o.minPx ?? 2.4;
    const R = rng(o.seed ?? 7);
    const tot = BLOBS.reduce((a, b) => a + b[4], 0);
    const core: Soul[] = [];
    this.bd = BLOBS.map(() => ({ ax: 0.04 + 0.07 * R(), ay: 0.03 + 0.04 * R(), per: 8 + 12 * R(), ph: TAU * R() }));
    for (let i = 0; i < count; i++) {
      // Порядок обращений к генератору — как в макете: от него зависит, какой рой получится из seed.
      const s: Soul = {
        x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, v: 1,
        rd: R(),
        sp: R() * 2 - 1,
        sz: 0.7 + 0.7 * R(),
        ci: R() < 0.25 ? 1 : R() < 0.134 ? 2 : 0,
        tw: TAU * R(),
        tp: 2 + 8 * R(),
        rk: R(),
        corona: R() < 0.17,
        gx: gauss(R),
        gy: gauss(R),
        gz: gauss(R),
        ru: R(),
        rv: R(),
        fl: R() < 0.22,
        fph: R(),
        rc: 0.54 + 0.14 * R(),
        wc: (R() < 0.5 ? -1 : 1) * (0.5 + R()),
        ra: 0, ux: 0, uy: 0, uz: 0, b: 0,
      };
      let q = R() * tot;
      let b = 0;
      while (q > BLOBS[b]![4] && b < BLOBS.length - 1) {
        q -= BLOBS[b]![4];
        b++;
      }
      s.b = b;
      R(); // роль души в макете нужна только лицу; вызов оставлен, чтобы рой совпадал с макетом по seed
      if (s.corona) {
        const l = Math.hypot(s.gx, s.gy, s.gz) || 1;
        s.ux = s.gx / l;
        s.uy = s.gy / l;
        s.uz = s.gz / l;
      } else core.push(s);
      this.souls.push(s);
    }
    // Сфера Фибоначчи для не-корональных.
    core.forEach((s, k) => {
      const y = 1 - (2 * (k + 0.5)) / core.length;
      const r = Math.sqrt(1 - y * y);
      const f = k * 2.39996;
      s.ux = Math.cos(f) * r;
      s.uy = y;
      s.uz = Math.sin(f) * r;
    });
    // Кольцо подтверждения с разрывом.
    const cors = this.souls.filter((s) => s.corona);
    cors.forEach((s, k) => {
      s.ra = 0.18 + (k / cors.length) * (TAU - 0.36);
    });
  }

  needsFrame(): boolean {
    return this.sp !== null && (this.dirty || this.trans || this.palT < 1);
  }

  setSpec(spec: SwarmSpec, now: number, reducedMotion: boolean): void {
    const key = `${spec.shape}|${spec.fx ?? ''}`;
    const old = this.sp;
    if (spec.pal !== this.palTo) {
      this.palFrom = this.palTo;
      this.palTo = spec.pal;
      this.palT = reducedMotion ? 1 : 0;
    }
    if (key !== this.key) {
      this.key = key;
      if (old !== null && !reducedMotion) {
        for (const s of this.souls) {
          s.fx = s.x;
          s.fy = s.y;
          s.fz = s.z;
        }
        const a = shapeClass(old.shape);
        const b = shapeClass(spec.shape);
        this.tr0 = now;
        this.dur = a === b ? 0.7 : a === 'cloud' ? DUR.cloudsphere : DUR.spherecloud;
      } else this.tr0 = -1e9;
    }
    // Сбой — на входе в состояние, даже если форма та же (thinking → error: сфера остаётся сферой).
    if (spec.glitch && !(old !== null && old.glitch)) this.gl = now + 280;
    this.sp = spec;
    this.dirty = true;
  }

  /** Живая цель души `s` в долях d (начало — центр); пишет в `this.o`. */
  private tg(s: Soul, t: number): void {
    const E = this.sp!;
    const o = this.o;
    const T = this.T;
    o.m = 1;
    o.sm = 1;
    o.c = s.ci;
    if (E.shape === 'dot') {
      const k = 0.15 * (1 + (E.fx === 'listen' ? 0.7 * this.mic : 0));
      o.x = s.gx * k;
      o.y = s.gy * k;
      o.z = s.gz * 0.15;
    } else if (E.shape === 'cloud') {
      const B = BLOBS[s.b]!;
      const D = this.bd[s.b]!;
      const br = 1 + 0.04 * Math.sin((TAU * T) / 7);
      const ls = E.fx === 'listen' ? 0.62 + 0.5 * this.mic : 1;
      o.x = (B[0] + D.ax * Math.sin((TAU * T) / D.per + D.ph) + s.gx * B[2] * br) * ls;
      o.y = (B[1] + D.ay * Math.cos(((TAU * T) / D.per) * 1.3 + D.ph) + s.gy * B[3] * br) * ls;
      o.z = s.gz * 0.18;
      if (E.fx === 'listen') {
        // Волна от центра каждые 2,4 с.
        const r = Math.hypot(o.x, o.y);
        const rw = ((t / 2400) % 1) * 0.9;
        const w = Math.exp(-Math.pow((r - rw) / 0.08, 2));
        o.x += (o.x / (r + 0.01)) * 0.05 * w;
        o.y += (o.y / (r + 0.01)) * 0.05 * w;
        o.m = 1 + 0.9 * w;
      }
    } else {
      if (s.corona && E.fx === 'ring') {
        o.x = Math.cos(s.ra) * 0.64;
        o.y = Math.sin(s.ra) * 0.64;
        o.z = 0.3;
        o.c = 3;
        o.m = 1.15;
        return;
      }
      if (!s.corona && E.fx === 'flow' && s.fl) {
        const u = (T / 2.4 + s.fph) % 1;
        o.x = (s.ru - 0.5) * 0.46 * (1 - 0.4 * u);
        o.y = 0.12 + 0.7 * u;
        o.z = 0.4;
        o.m = Math.pow(Math.sin(Math.PI * u), 0.7) * 1.15;
        return;
      }
      const k = s.corona ? s.rc : 0.5 * (1 + 0.02 * Math.sin((TAU * T) / 2.4));
      const a = s.corona ? this.rot * s.wc : this.rot;
      const ca = s.corona ? Math.cos(a) : this.cr;
      const sa = s.corona ? Math.sin(a) : this.sr;
      const x1 = (s.ux * ca + s.uz * sa) * k;
      const z1 = (-s.ux * sa + s.uz * ca) * k;
      const y0 = s.uy * k;
      o.x = x1;
      o.y = y0 * CT - z1 * ST;
      o.z = y0 * ST + z1 * CT;
      if (E.fx === 'arc' && !s.corona) {
        // Яркая дуга 120° бежит по сфере.
        const ang = Math.atan2(o.y, o.x);
        const u = ((((((t / 2000) * TAU - ang) % TAU) + TAU) % TAU) / (TAU / 3));
        if (u < 1) {
          const b = Math.pow(1 - u, 1.4);
          o.m = 1 + 2.2 * b;
          o.sm = 1 + 0.7 * b;
          o.x *= 1 + 0.07 * b;
          o.y *= 1 + 0.07 * b;
        }
      }
    }
  }

  frame(now: number, ctx: CanvasRenderingContext2D | null, reducedMotion: boolean, mic: number): void {
    const E = this.sp;
    if (E === null) return;
    const rm = reducedMotion;
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.dirty = false;
    const t = rm ? 3200 : now;
    if (rm) {
      this.T = 3.2;
      this.rot = 0.9;
      this.mic = 0.5;
    } else {
      this.T += dt * E.ts;
      this.rv += (E.rot - this.rv) * Math.min(1, dt * 2);
      this.rot += dt * this.rv;
      if (E.fx === 'listen') this.mic += (mic - this.mic) * 0.3;
    }
    if (this.palT < 1) this.palT = clamp(this.palT + dt / 0.3);
    const el = rm ? 1e9 : (now - this.tr0) / 1000;
    const dur = this.dur;
    const glitch = now < this.gl && !rm;
    this.trans = el < dur;
    this.cr = Math.cos(this.rot);
    this.sr = Math.sin(this.rot);
    const spr = ctx === null ? null : sprites();
    if (ctx !== null) {
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.globalCompositeOperation = 'lighter';
    }
    const sa = spr === null ? null : spr[this.palTo];
    const sb = spr === null ? null : spr[this.palFrom];
    const pt = this.palT;
    const o = this.o;
    const dim = E.dim;
    for (const s of this.souls) {
      this.tg(s, t);
      let x = o.x;
      let y = o.y;
      let z = o.z;
      const p = clamp((el - s.rd * 0.33 * dur) / (0.67 * dur)); // у каждой души своя задержка
      if (p < 1) {
        // Плавное движение с лёгкой спиралью.
        const e = ease(p);
        const dx = x - s.fx;
        const dy = y - s.fy;
        const k = Math.sin(Math.PI * p) * 0.3 * s.sp;
        x = s.fx + dx * e - dy * k;
        y = s.fy + dy * e + dx * k;
        z = lerp(s.fz, z, e);
      }
      s.x = x;
      s.y = y;
      s.z = z;
      s.v += ((s.rk < E.vis ? 1 : 0) - s.v) * Math.min(1, dt * 5);
      if (ctx === null || sa === null || sb === null) continue;
      const zn = clamp(z + 0.5);
      let al = (s.corona ? 0.62 : 0.85) * o.m * (0.5 + 0.5 * zn) * s.v * dim * (1 + 0.2 * Math.sin((TAU * t) / 1000 / s.tp + s.tw)); // мерцание ±20 %
      const D = Math.max(this.minPx, this.d * this.k * s.sz * o.sm * (0.85 + 0.3 * zn));
      let px = this.cx + x * this.d;
      const py = this.cy + y * this.d;
      if (glitch) {
        const row = Math.floor(py / 6);
        if (row % 3 === 0) px += (hs(row + Math.floor(now / 70)) - 0.5) * 0.14 * this.d;
        if (hs(s.rd * 50) < 0.25) al *= 0.2;
      }
      al = clamp(al);
      if (al < 0.01) continue;
      const c = o.c;
      if (pt >= 1) {
        ctx.globalAlpha = al;
        ctx.drawImage(sa[c]!, px - D / 2, py - D / 2, D, D);
      } else {
        // Кроссфейд палитры за 0,3 с.
        ctx.globalAlpha = al * pt;
        ctx.drawImage(sa[c]!, px - D / 2, py - D / 2, D, D);
        ctx.globalAlpha = al * (1 - pt);
        ctx.drawImage(sb[c]!, px - D / 2, py - D / 2, D, D);
      }
    }
    if (ctx !== null) ctx.globalAlpha = 1;
  }
}

export function createSwarm(count: number, options: SwarmOptions): SwarmEngine {
  return new SwarmImpl(count, options);
}
