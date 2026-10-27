/**
 * Движок роя душ на Canvas 2D: порт класса `Swarm` из одобренного макета island-mockup.html (спека 2026-10-14,
 * раздел 9). Без React; рисует через переданный контекст (`null` — только шаг, для тестов и jsdom).
 * Душа — точка со спрайтом «ядро + мягкое свечение»; формы: точка, облако пятен, сфера Фибоначчи с короной-кольцом,
 * лицо (два глаза и рот из тех же душ, эмоции — таблица `EMO`); эффекты: слушание (сжатие по громкости и волна),
 * кольцо подтверждения, поток ответа, дуга инструмента. Отличия лица от макета: моргание — на втором потоке
 * генератора, а не на `Math.random`, и рот идёт по кадру настоящего голоса `voice`, а не по синтетической кривой.
 * Рот слушает голос (#9 §6.7, L1): формы рта смешиваются с высотой по громкости, и рот всегда читается как рот —
 * пороги F5 по `Swarm.face()` прототипа island-motion-sound (ограниченные множители, наименьшие длина и штрих, морф
 * «о/у» из линии в овал по параметрам, без усреднения положений). Лицо слушает интонацию (L2): после вопроса глаза
 * расширяются и поднимаются (бровей нет), пауза зовёт моргание, ударный слог даёт импульс размера и яркости, громче —
 * ярче. В режиме громкости и при reduced motion L2 не действует.
 * Все души живут в долях `d` (радиус сферы 0.5), экран — `cx + x * d`, `cy + y * d`.
 * Поверх облика — одноразовые реакции (#9 §4.1): масштаб, сдвиг, оборот с закруткой, волна яркости, искры. Они
 * меняют только отрисовку относительно `cx`/`cy` и к концу реакции сходят на нет; положения `souls` не трогают.
 */

import type { Visemes, VoiceFrame } from '../assistant/voice-features.js';
import { BLOBS, DUR, EMO, PAL, type FaceSpec, type SwarmPalette, type SwarmReaction, type SwarmSpec } from './spec.js';

export interface SwarmOptions {
  width: number;
  height: number;
  d: number;
  cy: number;
  k?: number;
  minPx?: number;
  seed?: number;
  /**
   * Что лицо берёт из кадра голоса: `full` — громкость, формы (L1) и интонацию (L2), `loudness` — только громкость,
   * как план 3 v1.
   * Внутренний флаг для тестов F1 (#9 §11.10): в UI переключателя нет, по умолчанию `full`.
   */
  voiceMode?: 'loudness' | 'full';
}

export interface SwarmEngine {
  setSpec(spec: SwarmSpec, now: number, reducedMotion: boolean): void;
  /**
   * Шаг и отрисовка одного кадра; `ctx` null — только шаг (тесты, jsdom). `mic` — громкость 0..1 для fx listen,
   * `voice` — кадр голоса для рта лица; `null` — голос молчит, рот закрыт.
   */
  frame(now: number, ctx: CanvasRenderingContext2D | null, reducedMotion: boolean, mic: number, voice?: VoiceFrame | null): void;
  /** Нужен ли кадр: идёт переход или реакция, сменилась палитра или спека. */
  needsFrame(): boolean;
  /**
   * Реакция с началом `at`, мс (время кадров). В малом рое (≤ 32 px) реакция со сдвигом, в лице и при `reducedMotion`
   * любая — вспышка 300 мс; та же реакция заново начинается сначала; реакция, чьё время к `now` вышло, не ставится.
   */
  react(reaction: SwarmReaction, at: number, now: number, reducedMotion: boolean): void;
  /** Для тестов: положения душ в долях d (x, y, z) после последнего кадра; роль в лице: 0, 1 — глаза, 2 — рот. */
  readonly souls: ReadonlyArray<{ readonly x: number; readonly y: number; readonly z: number; readonly corona: boolean; readonly role: 0 | 1 | 2 }>;
  /** Для тестов: длительность перехода и задержка рта, с; вспышка 0..1; целевая палитра; идущие реакции. */
  readonly debug: {
    readonly dur: number;
    readonly extra: number;
    readonly flash: number;
    readonly pal: SwarmPalette;
    readonly reacts: ReadonlyArray<SwarmReaction | 'flash'>;
  };
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

/** Кривые ключей реакций: выход, вход-выход и выход с лёгким перелётом. */
const CURVE = {
  out: (t: number): number => 1 - Math.pow(1 - t, 3),
  inOut: ease,
  back: (t: number): number => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
};
type Key = readonly [to: number, ms: number, curve: keyof typeof CURVE];
/** Значение цепочки ключей через `el` мс от начала; до первого ключа — `from`. */
const keys = (chain: readonly Key[], el: number, from = 0): number => {
  let v = from;
  let rest = el;
  for (const [to, ms, curve] of chain) {
    if (rest < ms) return v + (to - v) * CURVE[curve](clamp(rest / ms));
    rest -= ms;
    v = to;
  }
  return v;
};

/** Вклад реакции в кадр: масштаб и яркость (множители), сдвиг в долях d, оборот, закрутка, искры, радиус волны. */
interface Mod {
  sc?: number;
  br?: number;
  ox?: number;
  oy?: number;
  spin?: number;
  swirl?: number;
  spark?: number;
  wave?: number;
}

/**
 * Реакции #9 §4.1: длительность, мс; `pos` — сдвигает души (в малом рое заменяется вспышкой, §4.3); `f` — вклад через
 * `el` мс. `flash` — вспышка яркости 300 мс вместо движения.
 */
const REACT: Record<SwarmReaction | 'flash', { dur: number; pos: boolean; f: (el: number) => Mod }> = {
  breathe: {
    dur: 700,
    pos: false,
    f: (el) => ({ sc: keys([[0.9, 180, 'out'], [1.05, 220, 'out'], [1, 300, 'back']], el, 1), br: 1 + 0.35 * Math.sin(Math.PI * clamp(el / 700)) }),
  },
  glint: { dur: 450, pos: false, f: (el) => ({ wave: el / 450 }) },
  hop: { dur: 450, pos: true, f: (el) => ({ oy: keys([[-0.13, 150, 'out'], [0, 300, 'back']], el) }) },
  nod: { dur: 700, pos: true, f: (el) => ({ oy: keys([[-0.07, 110, 'out'], [0, 170, 'back'], [-0.05, 110, 'out'], [0, 310, 'back']], el) }) },
  shake: { dur: 290, pos: true, f: (el) => ({ ox: keys([[0.07, 50, 'out'], [-0.07, 70, 'inOut'], [0.045, 70, 'inOut'], [0, 100, 'out']], el) }) },
  // Оборот за 950 мс с закруткой (внутренние души ведут); искры у 16 % душ с 500 до 1400 мс.
  spin: { dur: 1400, pos: false, f: (el) => ({ spin: el < 950 ? TAU * ease(el / 950) : TAU, swirl: Math.sin(Math.PI * clamp(el / 950)), spark: clamp((el - 500) / 900) }) },
  lean: {
    dur: 520,
    pos: false,
    f: (el) => ({ sc: keys([[1.05, 160, 'out'], [1, 360, 'back']], el, 1), br: 1 + 0.25 * Math.sin(Math.PI * clamp(el / 520)) }),
  },
  flash: { dur: 300, pos: false, f: (el) => ({ br: 1 + 0.7 * Math.sin(Math.PI * clamp(el / 300)) }) },
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
  /** Роль в лице: 0 — левый глаз, 1 — правый, 2 — рот. */
  role: 0 | 1 | 2;
  /** Хэш номера души 0..1 для искр `spin`; не от генератора, чтобы облик по seed не менялся. */
  sk: number;
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

/** Наименьший штрих рта-линии в долях d до масштаба лица (#9 §6.7: «рот всегда читается»). */
const MOUTH_STROKE = 0.07;

const shapeClass = (shape: SwarmSpec['shape']): 'cloud' | 'sphere' | 'face' => (shape === 'dot' ? 'cloud' : shape);

class SwarmImpl implements SwarmEngine {
  readonly souls: Soul[] = [];
  private readonly W: number;
  private readonly H: number;
  private readonly d: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly k: number;
  private readonly minPx: number;
  /** Малый рой (≤ 32 px): реакции со сдвигом — вспышкой (#9 §4.3). */
  private readonly mini: boolean;
  private readonly voiceMode: 'loudness' | 'full';
  /** Идущие реакции и их начало, мс. */
  private reacts: Array<{ name: SwarmReaction | 'flash'; t0: number }> = [];
  private readonly bd: Array<{ ax: number; ay: number; per: number; ph: number }>;
  /** Второй поток генератора — для моргания; облик роя по seed от него не зависит. */
  private readonly R2: () => number;
  private sp: SwarmSpec | null = null;
  private key: string | null = null;
  private dirty = true;
  private trans = false;
  private tr0 = -1e9;
  private dur = 1;
  /** Задержка рта при входе в лицо, с. */
  private extra = 0;
  private toFace = false;
  /** Вспышка яркости на входе в `surprise`, спад за 0,6 с. */
  private flash = 0;
  /** Моргание: время следующего, начало текущего, двойное ли. */
  private nb = 0;
  private b0 = 0;
  private dbl = false;
  /** Интонация кадра (L2): подъём глаз и ударный импульс 0..1. */
  private eyesUp = 0;
  private pulse = 0;
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
    this.mini = Math.max(o.width, o.height) <= 32;
    this.voiceMode = o.voiceMode ?? 'full';
    const R = rng(o.seed ?? 7);
    this.R2 = rng((o.seed ?? 7) ^ 0x9e3779b9);
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
        ra: 0, ux: 0, uy: 0, uz: 0, b: 0, role: 0, sk: hs(i + 0.5),
      };
      let q = R() * tot;
      let b = 0;
      while (q > BLOBS[b]![4] && b < BLOBS.length - 1) {
        q -= BLOBS[b]![4];
        b++;
      }
      s.b = b;
      const r = R();
      s.role = r < 0.24 ? 0 : r < 0.48 ? 1 : 2;
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

  get debug(): { dur: number; extra: number; flash: number; pal: SwarmPalette; reacts: Array<SwarmReaction | 'flash'> } {
    return { dur: this.dur, extra: this.extra, flash: this.flash, pal: this.palTo, reacts: this.reacts.map((r) => r.name) };
  }

  needsFrame(): boolean {
    return this.sp !== null && (this.dirty || this.trans || this.palT < 1 || this.reacts.length > 0);
  }

  react(reaction: SwarmReaction, at: number, now: number, reducedMotion: boolean): void {
    const face = this.sp !== null && this.sp.shape === 'face';
    // Лицо не двигают (V3), малый рой не дрожит (§4.3), уменьшенное движение — без движения (§4.5).
    const name = reducedMotion || face || (this.mini && REACT[reaction].pos) ? 'flash' : reaction;
    if (now - at >= REACT[name].dur) return;
    this.reacts = this.reacts.filter((r) => r.name !== name);
    this.reacts.push({ name, t0: at });
  }

  setSpec(spec: SwarmSpec, now: number, reducedMotion: boolean): void {
    const key = `${spec.shape}|${spec.fx ?? ''}|${spec.emo ?? ''}`;
    const old = this.sp;
    // В макете первое моргание — через 1,2 с после создания роя; у движка нет часов до первой спеки.
    if (old === null) this.nb = now + 1200;
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
        this.dur = a === b ? (old.emo !== spec.emo ? 0.6 : 0.7) : DUR[`${a}${b}` as keyof typeof DUR];
        this.extra = b === 'face' && a !== 'face' ? 0.2 : 0;
        this.toFace = this.extra > 0;
      } else this.tr0 = -1e9;
      if (spec.emo === 'surprise' && !reducedMotion) this.flash = 1;
    }
    // Сбой — на входе в состояние, даже если форма та же (thinking → error: сфера остаётся сферой).
    if (spec.glitch && !(old !== null && old.glitch)) this.gl = now + 280;
    this.sp = spec;
    this.dirty = true;
  }

  /**
   * Живая цель души `s` в долях d (начало — центр); пишет в `this.o`. `amp` — открытие рта, `bl` — открытость глаз,
   * `vis` — формы рта (`null` — без форм).
   */
  private tg(s: Soul, t: number, amp: number, bl: number, vis: Visemes | null): void {
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
    } else if (E.shape === 'sphere') {
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
    } else this.face(s, EMO[E.emo ?? 'calm'], amp, bl, t, vis);
  }

  /** Лицо из тех же душ: два глаза (роли 0, 1) и рот (роль 2); корона — пыль вокруг силуэта. */
  private face(s: Soul, F: FaceSpec, amp: number, bl: number, t: number, vis: Visemes | null): void {
    const o = this.o;
    const sx = s.role === 0 ? -1 : 1;
    o.z = 0.35;
    if (s.role < 2) {
      const ex = 0.41 * sx;
      // Вопрос: глаза расширяются и поднимаются — бровей у лица нет.
      const ey = -(F.ey + 0.03 * this.eyesUp);
      const ea = F.a! * (1 + 0.12 * this.eyesUp);
      const eb = F.b! * (1 + 0.25 * this.eyesUp);
      if (F.x === true) {
        const q = (s.ru * 2 - 1) * F.len!;
        const k = s.rv < 0.5 ? 1 : -1;
        o.x = ex + q;
        o.y = ey + k * q + (((s.rv * 4) % 1) - 0.5) * 0.028;
      } else {
        const r = Math.sqrt(s.ru);
        const th = TAU * s.rv;
        const X = r * Math.cos(th);
        let Y = r * Math.sin(th);
        if (F.dome === true) Y = -Math.abs(Y);
        if (F.cut !== undefined) {
          // Косое веко.
          const ym = clamp(F.cut[0] + F.cut[1] * sx * X, -1, 0.8);
          Y = ym + ((Y + 1) / 2) * (1 - ym);
        }
        o.x = ex + ea * X;
        o.y = ey + eb * Y * bl;
      }
    } else {
      // Формы рта (L1): «о/у» сужает и ведёт в овал, «а» поднимает, «и/е» растягивает, понижает и даёт улыбку,
      // закрытый — линия. Множители ограничены, а не перемножаются без предела.
      const ro = vis?.u ?? 0;
      const wi = vis?.a ?? 0;
      const sm = vis?.i ?? 0;
      const cl = vis?.m ?? 0;
      const hf = clamp(1 + 0.45 * wi - 0.35 * sm, 0.6, 1.45);
      const open = lerp(lerp(F.H0, F.H1, amp) * hf, 0, cl);
      const curl = (F.curl ?? 0) + 0.06 * sm;
      if (F.mo === true) {
        // Овал surprise — свой: не уже 0,65·mw, не ниже 0,5·H0.
        const w = F.mw * clamp(1 - 0.35 * ro + 0.2 * sm, 0.65, 1.25);
        const H = Math.max(0.5 * F.H0, open);
        const r = Math.sqrt(s.ru);
        const th = TAU * s.rv;
        const c = Math.cos(th);
        const n = Math.sin(th);
        o.x = ((Math.sign(c) * Math.pow(Math.abs(c), 0.8) * r * w) / 2) * (0.92 + 0.16 * amp);
        o.y = 0.25 + (Math.sign(n) * Math.pow(Math.abs(n), 0.8) * r * H) / 2;
      } else {
        // Линия не короче закрытой ширины эмоции; «о/у» сужает её не больше чем до 0,65·mw.
        const wLine = F.mw * clamp(1 + 0.05 * wi + 0.2 * sm, 1, 1.25);
        const W = lerp(wLine, 0.65 * F.mw, ro);
        const q = s.ru * 2 - 1;
        const tap = Math.pow(Math.max(0, 1 - q * q), F.pw!);
        // Наименьший штрих — и на концах (55 %); закрытый рот — видимая линия этой толщины во всю ширину.
        const lineT = Math.max(open * tap, MOUTH_STROKE * (0.55 + 0.45 * tap));
        const ovalT = Math.max(open, 0.45 * W) * Math.sqrt(Math.max(0, 1 - q * q));
        let yc = 0.25 - curl * q * q * (1 - ro);
        if (F.wave === true) yc += 0.035 * Math.sin(q * 3.4 * Math.PI);
        o.x = (q * W) / 2;
        // «о/у» — морф тех же душ из линии в овал по толщине, без усреднения координат.
        o.y = yc + (s.rv - 0.4) * lerp(lineT, Math.max(ovalT, lineT), ro);
        o.m = 1.1; // души рта на 10 % ярче
      }
    }
    if (s.corona) {
      o.x += s.gx * 0.045 + 0.012 * Math.sin((t / 1000) * 0.8 + s.tw);
      o.y += s.gy * 0.045;
      o.m = 0.7;
    }
    // Лицо на 20 % крупнее сферы, чтобы черты читались; ударный слог раздувает души на 10 %.
    o.x *= 1.2;
    o.y *= 1.2;
    o.sm = 1.15 * (1 + 0.1 * this.pulse);
  }

  /** Моргание по паузе голоса (L2), не чаще раза в 600 мс от начала прошлого; следующее своё — через 2,4–4,4 с. */
  private forceBlink(now: number): void {
    if (now - this.b0 <= 600) return;
    this.b0 = now;
    this.dbl = false;
    this.nb = now + 2400 + this.R2() * 2000;
  }

  /** Открытость глаз 1..0,06: моргание раз в 2,4–4,4 с по 220 мс, в 20 % двойное; `nb` и reduced motion — без него. */
  private blink(now: number, F: FaceSpec, rm: boolean): number {
    if (F.nb === true || rm) return 1;
    if (now > this.nb) {
      this.b0 = now;
      this.dbl = this.R2() < 0.2;
      this.nb = now + 2400 + this.R2() * 2000;
    }
    const u = (now - this.b0) / 220;
    let k = 0;
    if (u >= 0 && u < 1) k = Math.sin(Math.PI * u);
    else if (this.dbl) {
      const u2 = (now - this.b0 - 330) / 180;
      if (u2 >= 0 && u2 < 1) k = Math.sin(Math.PI * u2);
    }
    return 1 - 0.94 * k;
  }

  frame(now: number, ctx: CanvasRenderingContext2D | null, reducedMotion: boolean, mic: number, voice: VoiceFrame | null = null): void {
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
    this.flash = Math.max(0, this.flash - dt / 0.6);
    const F = EMO[E.emo ?? 'calm'];
    const amp = rm ? 0.3 : E.shape === 'face' ? (voice?.amp ?? 0) : 0;
    // Reduced motion выключает L1 (F4); режим громкости — рот плана 3 v1 без форм (F1).
    const vis = !rm && E.shape === 'face' && this.voiceMode === 'full' ? (voice?.visemes ?? null) : null;
    // Интонация (L2) — там же, где формы: в лице, в полном режиме и без reduced motion (F4).
    const pro = vis === null ? null : voice;
    this.eyesUp = pro?.eyesUp ?? 0;
    this.pulse = pro?.pulse ?? 0;
    if (pro?.blink === true) this.forceBlink(now);
    // Громче — ярче, ударный слог — вспышка яркости +45 %.
    const lit = pro === null ? 1 : (0.9 + 0.25 * pro.loud) * (1 + 0.45 * pro.pulse);
    const bl = E.shape === 'face' ? this.blink(now, F, rm) : 1;
    // Реакции — в один общий модификатор; кончившиеся снимаются, и кадров они больше не просят.
    let sc = 1;
    let br = 1;
    let ox = 0;
    let oy = 0;
    let spin = 0;
    let swirl = 0;
    let spark = 0;
    let wave = -1;
    this.reacts = this.reacts.filter((r) => {
      const el = now - r.t0;
      const R = REACT[r.name];
      if (el >= R.dur) return false;
      const m = R.f(el);
      if (m.sc !== undefined) sc *= m.sc;
      if (m.br !== undefined) br *= m.br;
      ox += m.ox ?? 0;
      oy += m.oy ?? 0;
      spin += m.spin ?? 0;
      swirl = Math.max(swirl, m.swirl ?? 0);
      if (m.spark !== undefined) spark = m.spark;
      if (m.wave !== undefined) wave = m.wave;
      return true;
    });
    // Реакция, начатая до лица или до reduced motion, дальше идёт только яркостью.
    if (rm || E.shape === 'face') {
      sc = 1;
      ox = 0;
      oy = 0;
      spin = 0;
      swirl = 0;
    }
    const el = rm ? 1e9 : (now - this.tr0) / 1000;
    const dur = this.dur;
    const glitch = now < this.gl && !rm;
    this.trans = el < dur + this.extra;
    // Оборот сферы — через её вращение; облако и точка оборачиваются на отрисовке.
    const rotS = this.rot + (E.shape === 'sphere' ? spin : 0);
    const cloudSpin = E.shape === 'sphere' ? 0 : spin;
    this.cr = Math.cos(rotS);
    this.sr = Math.sin(rotS);
    const spr = ctx === null ? null : sprites();
    if (ctx !== null) {
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.globalCompositeOperation = 'lighter';
    }
    const sa = spr === null ? null : spr[this.palTo];
    const sb = spr === null ? null : spr[this.palFrom];
    const pt = this.palT;
    const o = this.o;
    const dim = E.dim * (1 + 0.8 * this.flash) * lit;
    for (const s of this.souls) {
      this.tg(s, t, amp, bl, vis);
      let x = o.x;
      let y = o.y;
      let z = o.z;
      // У каждой души своя задержка; при входе в лицо рот приходит на 0,2 с позже.
      const p = clamp((el - s.rd * 0.33 * dur - (this.toFace && s.role === 2 ? 0.2 : 0)) / (0.67 * dur));
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
      // Слой реакций: закрутка (внутренние души ведут), масштаб и сдвиг — относительно центра роя.
      let rx = x;
      let ry = y;
      let mm = o.m;
      if (cloudSpin !== 0) {
        const a = cloudSpin + swirl * 0.9 * (0.45 - Math.hypot(x, y));
        const c = Math.cos(a);
        const n = Math.sin(a);
        rx = x * c - y * n;
        ry = x * n + y * c;
      }
      rx = rx * sc + ox;
      ry = ry * sc + oy;
      if (wave >= 0) mm *= 1 + 1.6 * Math.exp(-Math.pow((Math.hypot(rx, ry) - wave * 0.75) / 0.07, 2)); // кольцо от центра
      const zn = clamp(z + 0.5);
      let al = (s.corona ? 0.62 : 0.85) * mm * (0.5 + 0.5 * zn) * s.v * dim * br * (1 + 0.2 * Math.sin((TAU * t) / 1000 / s.tp + s.tw)); // мерцание ±20 %
      if (spark > 0 && spark < 1 && s.sk < 0.16) al *= 1 + 3 * Math.sin(Math.PI * spark);
      const D = Math.max(this.minPx, this.d * this.k * s.sz * o.sm * (0.85 + 0.3 * zn));
      let px = this.cx + rx * this.d;
      const py = this.cy + ry * this.d;
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
