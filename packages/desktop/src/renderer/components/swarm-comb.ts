/**
 * Живая иконка роя «Соты из капель» (спека роя v1, 7.5). Без React и зависимостей: canvas 2D и ImageData, один объект
 * на иконку. Эталон — модуль `comb-icon.js` из передачи дизайна (раунд 3, вариант 2), перенесён как есть, с типами.
 *
 * Ячеек столько, сколько трутней и проверяющих (до семи), полные — сдавшие. Мёд — 3D-материал: поле расстояний до
 * фигур с мягким слиянием (капля перетекает в ячейку), скруглённый скос, свет сверху-слева, блик и тёплый «просвет».
 *
 *   const icon = createCombIcon({ size: 16, theme: 'dark' });
 *   icon.set({ status, handed, total }, performance.now());   // на каждую смену данных роя
 *   icon.frame(ctx, performance.now(), reducedMotion);        // живой рой — с частотой иконки, реакции — пока
 *                                                             // needsFrame(now)
 * Холст: ширина и высота — size × devicePixelRatio, CSS-размер — size; трансформацию ставит модуль. `ctx` null —
 * только состояние, без рисования (тесты в jsdom).
 */

import type { SwarmStatus } from '@parley/core/swarms';

export type CombTheme = 'light' | 'dark';

export interface CombState {
  status: SwarmStatus;
  /** Сколько участников уже сдали. */
  handed: number;
  /** Сколько участников всего (трутни и проверяющие); меньше 1 считается за 1. */
  total: number;
}

export interface CombIcon {
  /** Новые данные роя на момент `nowMs` (мс, как `performance.now()`). */
  set: (next: CombState, nowMs: number) => void;
  /** Идёт ли реакция (полёт капли, перетекание, «готово», вспышка): тогда кадры нужны с частотой экрана. */
  needsFrame: (nowMs: number) => boolean;
  /** Рисует кадр; `ctx` null — ничего не рисует. */
  frame: (ctx: CanvasRenderingContext2D | null, nowMs: number, reducedMotion?: boolean) => void;
}

type Rgb = readonly [number, number, number];
type Pt = readonly [number, number];

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2);
const out3 = (t: number): number => 1 - Math.pow(1 - t, 3);
/** Пружина с перелётом: `resp` — период, с; `z` — затухание. */
function spring(e: number, resp: number, z: number): number {
  if (e <= 0) return 0;
  if (e > 4) return 1;
  const w = TAU / resp,
    wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * e) * (Math.cos(wd * e) + ((z * w) / wd) * Math.sin(wd * e));
}

/** Тайминги, с. */
const FLY = 0.45; // капля летит к своей ячейке
const SETTLE = 1; // долетев, перетекает из круга в шестиугольник
const DONE = 1.6; // реакция «готово» целиком: свет, волна, искры
const COLLECT_DELAY = 0.8; // «сводит» начинается, когда долетела последняя капля
const FLASH = 0.3; // reduce motion: вспышка яркости вместо реакции

interface Palette {
  glow: boolean;
  halo: string;
  wax: string;
  cellTop: string;
  cellBot: string;
  grey: string;
  spark: string;
  flash: string;
}

/** Окно: светлая и тёмная тема; остров всегда тёмный. На тёмном — ореол, на светлом — тёмная кромка у мёда. */
export const PALETTE: Record<CombTheme, Palette> = {
  dark: { glow: true, halo: '#EFB05C', wax: '#D9B56C', cellTop: '#140d07', cellBot: '#30211a', grey: '#8b8479', spark: '#FFE2A0', flash: '' },
  light: { glow: false, halo: '', wax: '#A87532', cellTop: '#e2cca2', cellBot: '#f7ead0', grey: '#82796a', spark: '#B2622D', flash: '#8C491A' },
};

interface Material {
  deep: Rgb;
  mid: Rgb;
  lit: Rgb;
  glow: Rgb;
  spec: number;
}
/** Мёд: тень, мёд, свет, свечение на просвет; серый — сбой и отмена (мёд «засахарился»). */
const MAT: { gold: Material; grey: Material } = {
  gold: { deep: [138, 64, 14], mid: [234, 156, 46], lit: [255, 212, 124], glow: [255, 190, 84], spec: 1 },
  grey: { deep: [78, 74, 70], mid: [146, 140, 132], lit: [192, 186, 176], glow: [146, 140, 132], spec: 0.3 },
};
/** Тёмная кромка мёда на светлом фоне: без неё светлый край сливается с сайдбаром. */
const RIM: Rgb = [96, 50, 14];

/** Ячейки вершиной вверх в единицах апофемы со стенкой: центр, потом кольцо — соты растут кучно. */
const HEX7: readonly Pt[] = [[0, 0], [2, 0], [1, -1.7320508], [-1, -1.7320508], [-2, 0], [-1, 1.7320508], [1, 1.7320508]];

/** Раскладка `count` ячеек (1..7) по центру холста: апофема `a` и центры ячеек, CSS px. */
export function combLayout(count: number, S: number): { a: number; pos: Pt[] } {
  const cells = HEX7.slice(0, Math.max(1, Math.min(7, count)));
  let x0 = 1e9,
    x1 = -1e9,
    y0 = 1e9,
    y1 = -1e9;
  for (const [x, y] of cells as Array<[number, number]>) {
    x0 = Math.min(x0, x - 1);
    x1 = Math.max(x1, x + 1);
    y0 = Math.min(y0, y - 1.1547);
    y1 = Math.max(y1, y + 1.1547);
  }
  const a = Math.min((0.84 * S) / (x1 - x0), (0.84 * S) / (y1 - y0), 0.2 * S);
  const ox = S / 2 - ((x0 + x1) / 2) * a,
    oy = S / 2 - ((y0 + y1) / 2) * a;
  return { a, pos: (cells as Array<[number, number]>).map(([x, y]): Pt => [ox + x * a, oy + y * a]) };
}

/**
 * Мягкий шестиугольник вершиной вверх, `a` — апофема: 8-норма проекций на нормали трёх граней. Углы скругляются
 * сами, а у скоса нет рёбер от углов — мёд выглядит подушкой, а не гранёным камнем. Внутри — минус.
 */
export function sdHex(x: number, y: number, a: number): number {
  const p1 = x,
    p2 = 0.5 * x + 0.8660254 * y,
    p3 = 0.5 * x - 0.8660254 * y;
  let s1 = p1 * p1,
    s2 = p2 * p2,
    s3 = p3 * p3;
  s1 *= s1;
  s2 *= s2;
  s3 *= s3;
  s1 *= s1;
  s2 *= s2;
  s3 *= s3;
  return Math.sqrt(Math.sqrt(Math.sqrt(s1 + s2 + s3))) - a;
}
/** Мягкое объединение: в зоне `k` формы сливаются жидким мостиком. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Фигура мёда: круг (`u` 0), мягкий шестиугольник (`u` 1) или переход; `sx`, `sy` — сплющивание; `lv(x)` — уровень. */
interface Shape {
  x: number;
  y: number;
  a: number;
  R: number;
  u: number;
  sx: number;
  sy: number;
  k: number;
  lv: ((x: number) => number) | null;
  b0: number;
  b1: number;
  b2: number;
  b3: number;
}
type ShapeInit = Partial<Omit<Shape, 'b0' | 'b1' | 'b2' | 'b3'>>;

function sdShape(s: Shape, x: number, y: number): number {
  const dx = (x - s.x) / s.sx,
    dy = (y - s.y) / s.sy;
  const dc = Math.sqrt(dx * dx + dy * dy) - s.R;
  let d = s.u <= 0 ? dc : s.u >= 1 ? sdHex(dx, dy, s.a) : dc + (sdHex(dx, dy, s.a) - dc) * s.u;
  d *= s.sx < s.sy ? s.sx : s.sy;
  if (s.lv) {
    const l = s.lv(x) - y;
    if (l > d) d = l;
  }
  return d;
}
/** Высота скоса 0..1: четверть окружности от края до глубины B. */
function bevelH(d: number, B: number): number {
  const t = -d / B;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = 1 - t;
  return Math.sqrt(1 - u * u);
}
const cellHoney = (x: number, y: number, a: number, o: ShapeInit): Shape => ({ x, y, a, R: a * 1.02, u: 1, sx: 1, sy: 1, k: 0, lv: null, b0: 0, b1: 0, b2: 0, b3: 0, ...o });
const dropHoney = (x: number, y: number, r: number, k: number): Shape => ({ x, y, a: r, R: r, u: 0, sx: 1, sy: 1, k, lv: null, b0: 0, b1: 0, b2: 0, b3: 0 });

/** Буферы одной иконки: расстояния, `ImageData` и внеэкранный холст; пересоздаются при смене размера холста. */
interface HoneyMem {
  W: number;
  H: number;
  D: Float32Array;
  off: HTMLCanvasElement;
  octx: CanvasRenderingContext2D;
  img: ImageData;
}

/** Рисует мёд: расстояния в рамке фигур, затем нормаль по скосу и свет; результат — поверх через `drawImage`. */
function honey3d(c: CanvasRenderingContext2D, S: number, shapes: Shape[], mem: { m?: HoneyMem }, grey: boolean, rim: boolean, la: number, B: number): void {
  if (!shapes.length) return;
  const W = c.canvas.width,
    H = c.canvas.height,
    dpr = W / S;
  if (!mem.m || mem.m.W !== W || mem.m.H !== H) {
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d');
    if (octx === null) return;
    mem.m = { W, H, D: new Float32Array(W * H), off, octx, img: octx.createImageData(W, H) };
  }
  const { D, img } = mem.m;
  const px = img.data,
    pad = B + 2 / dpr;
  px.fill(0);
  let X0 = 1e9,
    Y0 = 1e9,
    X1 = -1e9,
    Y1 = -1e9;
  for (const s of shapes) {
    const e = Math.max(s.R, s.u > 0 ? s.a * 1.155 : 0) * Math.max(s.sx, s.sy) + s.k + pad;
    s.b0 = s.x - e;
    s.b1 = s.x + e;
    s.b2 = s.y - e;
    s.b3 = s.y + e;
    X0 = Math.min(X0, s.b0);
    X1 = Math.max(X1, s.b1);
    Y0 = Math.min(Y0, s.b2);
    Y1 = Math.max(Y1, s.b3);
  }
  const bx0 = Math.max(0, Math.floor(X0 * dpr)),
    bx1 = Math.min(W - 1, Math.ceil(X1 * dpr));
  const by0 = Math.max(0, Math.floor(Y0 * dpr)),
    by1 = Math.min(H - 1, Math.ceil(Y1 * dpr));
  if (bx1 < bx0 || by1 < by0) return;
  for (let y = by0; y <= by1; y++) {
    const cy = (y + 0.5) / dpr;
    for (let x = bx0, i = y * W + bx0; x <= bx1; x++, i++) {
      const cx = (x + 0.5) / dpr;
      let d = 1e9;
      for (const s of shapes) {
        if (cx < s.b0 || cx > s.b1 || cy < s.b2 || cy > s.b3) continue;
        const ds = sdShape(s, cx, cy);
        d = s.k > 0 ? smin(d, ds, s.k) : ds < d ? ds : d;
      }
      D[i] = d;
    }
  }
  const M = grey ? MAT.grey : MAT.gold;
  const lx = 0.62 * Math.cos(la),
    ly = 0.62 * Math.sin(la),
    lz = 0.78;
  const hl = Math.hypot(lx, ly, lz + 1),
    hx = lx / hl,
    hy = ly / hl,
    hz = (lz + 1) / hl;
  const slope = (B * dpr) / 2,
    spA = M.spec * 255;
  // Значения массива расстояний внутри рамки всегда заданы: границы рамки учтены в обходе.
  const at = (j: number): number => D[j] as number;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0, i = y * W + bx0; x <= bx1; x++, i++) {
      const d = at(i);
      if (d > 0.7 / dpr) continue;
      const h0 = bevelH(d, B);
      const gx = (bevelH(x < bx1 ? at(i + 1) : d, B) - bevelH(x > bx0 ? at(i - 1) : d, B)) * slope;
      const gy = (bevelH(y < by1 ? at(i + W) : d, B) - bevelH(y > by0 ? at(i - W) : d, B)) * slope;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const nx = -gx * inv,
        ny = -gy * inv,
        nz = inv;
      const dif = nx * lx + ny * ly + nz * lz;
      let sp = nx * hx + ny * hy + nz * hz;
      sp = sp > 0 ? sp : 0;
      sp *= sp;
      sp *= sp;
      sp *= sp;
      sp *= sp;
      sp *= sp;
      const back = nx * lx + ny * ly;
      const tr = (back < 0 ? -back : 0) * (1 - h0) * 0.75;
      const k1 = clamp(0.18 + dif * 0.95),
        k2 = clamp((dif - 0.72) * 2.4, 0, 0.7);
      let r = M.deep[0] + (M.mid[0] - M.deep[0]) * k1,
        g = M.deep[1] + (M.mid[1] - M.deep[1]) * k1,
        b = M.deep[2] + (M.mid[2] - M.deep[2]) * k1;
      r += (M.lit[0] - r) * k2;
      g += (M.lit[1] - g) * k2;
      b += (M.lit[2] - b) * k2;
      r += (M.glow[0] - r) * tr;
      g += (M.glow[1] - g) * tr;
      b += (M.glow[2] - b) * tr;
      r += spA * sp;
      g += spA * sp;
      b += spA * sp;
      if (rim) {
        // 1 на самом краю, 0 в 1,4 пикселя внутри.
        const e = clamp(1 + (d * dpr) / 1.4) * 0.6;
        r += (RIM[0] - r) * e;
        g += (RIM[1] - g) * e;
        b += (RIM[2] - b) * e;
      }
      const a = 0.5 - d * dpr,
        q = i * 4;
      px[q] = r > 255 ? 255 : r;
      px[q + 1] = g > 255 ? 255 : g;
      px[q + 2] = b > 255 ? 255 : b;
      px[q + 3] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
    }
  }
  mem.m.octx.putImageData(img, 0, 0);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(mem.m.off, 0, 0);
  c.restore();
}

/** Шестиугольник вершиной вверх, R — до вершины. */
function hexPath(c: CanvasRenderingContext2D, x: number, y: number, R: number): void {
  c.beginPath();
  for (let j = 0; j < 6; j++) {
    const a = -Math.PI / 2 + (j * Math.PI) / 3;
    if (j) c.lineTo(x + R * Math.cos(a), y + R * Math.sin(a));
    else c.moveTo(x + R * Math.cos(a), y + R * Math.sin(a));
  }
  c.closePath();
}
/** Воск и пустые ячейки — вектором, под мёдом; пустая ячейка темнее сверху, видна глубина. */
function waxComb(c: CanvasRenderingContext2D, pos: readonly Pt[], a: number, wall: number, P: Palette, grey: boolean): void {
  const Ro = a / 0.8660254 + 0.3,
    Ri = (a - wall) / 0.8660254;
  c.fillStyle = grey ? P.grey : P.wax;
  for (const [x, y] of pos) {
    hexPath(c, x, y, Ro);
    c.fill();
  }
  for (const [x, y] of pos) {
    const g = c.createLinearGradient(0, y - Ri, 0, y + Ri);
    g.addColorStop(0, P.cellTop);
    g.addColorStop(1, P.cellBot);
    c.fillStyle = g;
    hexPath(c, x, y, Ri);
    c.fill();
  }
}
const glowCache = new Map<string, HTMLCanvasElement>();
/** Мягкий ореол за сотами на тёмном фоне (спрайт на цвет). */
function glow(c: CanvasRenderingContext2D, x: number, y: number, R: number, hex: string, a: number): void {
  let s = glowCache.get(hex);
  if (s === undefined) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const g = sprite.getContext('2d');
    if (g === null) return;
    const n = parseInt(hex.slice(1), 16),
      rgb = `${n >> 16},${(n >> 8) & 255},${n & 255}`;
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${rgb},1)`);
    gr.addColorStop(0.3, `rgba(${rgb},.42)`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(hex, sprite);
    s = sprite;
  }
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = a;
  c.drawImage(s, x - R, y - R, 2 * R, 2 * R);
  c.restore();
}
/** Искры «готово»: через `delay` разлетаются от центра и гаснут; в мелких размерах — точки. */
function sparks(c: CanvasRenderingContext2D, S: number, de: number, color: string, delay: number): void {
  const u = clamp((de - delay) / 0.8);
  if (u <= 0 || u >= 1) return;
  c.fillStyle = color;
  c.globalAlpha = Math.sin(Math.PI * u);
  for (let j = 0; j < 5; j++) {
    const a = -Math.PI / 2 + (TAU * j) / 5 + 0.45,
      r = S * lerp(0.38, 0.5, out3(u));
    const x = S / 2 + r * Math.cos(a),
      y = S / 2 + r * Math.sin(a);
    c.beginPath();
    if (S < 22) c.arc(x, y, Math.max(0.55, S * 0.04), 0, TAU);
    else {
      const q = S * 0.075 * (1 - 0.4 * u);
      c.moveTo(x, y - q);
      c.quadraticCurveTo(x, y, x + q, y);
      c.quadraticCurveTo(x, y, x, y + q);
      c.quadraticCurveTo(x, y, x - q, y);
      c.quadraticCurveTo(x, y, x, y - q);
    }
    c.fill();
  }
  c.globalAlpha = 1;
}

interface Inner {
  shown: boolean;
  status: SwarmStatus;
  n: number;
  k: number;
  handAt: number;
  doneAt: number;
  collAt: number;
  flashAt: number;
  pFrom: number;
  pTo: number;
  pAt: number;
  pHand: boolean;
}

/**
 * Иконка: `size` — сторона, CSS px; `theme` — 'dark' или 'light'. Первый `set` показывает состояние без реакций;
 * дальше рост `handed` — капля сдавшего летит в свою ячейку, переход в `done` — реакция «готово»; `failed` и
 * `cancelled` — серые статичные соты.
 */
export function createCombIcon({ size, theme }: { size: number; theme: CombTheme }): CombIcon {
  const S = size,
    P = PALETTE[theme];
  const s: Inner = { shown: false, status: 'running', n: 1, k: 0, handAt: -1e9, doneAt: -1e9, collAt: -1e9, flashAt: -1e9, pFrom: 0, pTo: 0, pAt: -1e9, pHand: false };
  const mem: { m?: HoneyMem } = {};

  function set(next: CombState, nowMs: number): void {
    const t = nowMs / 1000,
      n = Math.max(1, next.total),
      k = clamp(next.handed, 0, n);
    if (!s.shown || n !== s.n) {
      // Первый показ и смена числа участников — без реакций.
      Object.assign(s, { shown: true, status: next.status, n, k, pFrom: k / n, pTo: k / n, pAt: -1e9, pHand: false });
      return;
    }
    if (k > s.k) Object.assign(s, { k, handAt: t, flashAt: t, pFrom: s.pTo, pTo: k / n, pAt: t, pHand: true });
    else if (k < s.k) Object.assign(s, { k, pFrom: k / n, pTo: k / n, pHand: false });
    if (next.status !== s.status) {
      if (next.status === 'collecting') s.collAt = s.pHand && t - s.handAt < COLLECT_DELAY ? s.handAt + COLLECT_DELAY : t;
      if (next.status === 'done') {
        Object.assign(s, { doneAt: t, flashAt: t });
        if (s.k < n) Object.assign(s, { k: n, pFrom: s.pTo, pTo: 1, pAt: t, pHand: false });
      }
      s.status = next.status;
    }
  }

  function needsFrame(nowMs: number): boolean {
    const t = nowMs / 1000;
    return (s.pHand && t - s.handAt < FLY + SETTLE) || t - s.pAt < 1.2 || (s.status === 'done' && t - s.doneAt < DONE) || t - s.flashAt < FLASH;
  }

  function frame(c: CanvasRenderingContext2D | null, nowMs: number, reducedMotion?: boolean): void {
    if (!c || !s.shown) return;
    const t = nowMs / 1000,
      R = reducedMotion === true,
      dpr = c.canvas.width / S;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, S, S);
    const status = s.status === 'cancelled' ? 'failed' : s.status;
    const collE = status === 'collecting' ? (R ? 1e9 : t - s.collAt) : -1;
    const failed = status === 'failed',
      done = status === 'done',
      coll = collE >= 0;
    const de = done ? (R ? 1e9 : t - s.doneAt) : 1e9;
    const handE = R || !s.pHand ? 1e9 : t - s.handAt;
    const tt = R ? 0 : t; // reduce motion: время стоит, капли на своих местах через равные углы
    const small = S < 22,
      m = S / 2;
    const prog = (delay: number, resp: number, z: number): number => (R ? s.k / s.n : lerp(s.pFrom, s.pTo, spring(t - s.pAt - (s.pHand ? delay : 0), resp, z)));

    const nc = Math.min(s.n, 7);
    const { a, pos } = combLayout(nc, S);
    // Раскладка отдаёт ровно `nc` центров: индексы ниже не выходят за них.
    const cell = (j: number): Pt => pos[j] as Pt;
    const wall = Math.max(0.45, a * 0.1),
      ain = a - wall - Math.max(0.25, a * 0.05);
    if (P.glow && !failed) glow(c, m, m, S * 0.5, P.halo, 0.1);
    waxComb(c, pos, a, wall, P, failed);

    // Полные ячейки; при n > 7 последняя наполняется частично. Новая — пока перетекает из капли — рисуется ниже.
    let full = s.k,
      part = 0;
    if (s.n > 7) {
      const f = clamp(prog(FLY, 0.6, 0.5)) * 7;
      full = Math.floor(f);
      part = f - full;
    }
    if (done) {
      full = nc;
      part = 0;
    }
    const newest = s.n <= 7 && !done && !failed && handE < FLY + SETTLE ? s.k - 1 : -1;
    // Волна «желе» на «готово»: кольцо вздрагивает на 0,1 с позже центра.
    const jelly = (j: number): number => {
      if (!done || R) return 1;
      const e = de - 0.1 - (j === 0 ? 0 : 0.1);
      return e < 0 || e > 0.7 ? 1 : 1 + 0.13 * Math.sin((Math.PI * e) / 0.28) * Math.exp(-e * 4);
    };
    const shapes: Shape[] = [];
    for (let j = 0; j < full; j++) {
      if (j === newest) continue;
      const q = jelly(j);
      shapes.push(cellHoney(cell(j)[0], cell(j)[1], ain, { sx: 2 - q, sy: q }));
    }
    if (part > 0.01 && full < nc) {
      const [x, y] = cell(full),
        y0 = y + (ain / 0.8660254) * (1 - 2 * part);
      shapes.push(cellHoney(x, y, ain, { lv: (xx) => y0 + (R ? 0 : S * 0.01 * Math.sin((xx / S) * 12 + tt * 3)) }));
    }
    // Капли несдавших кружат вокруг сот: не больше 4 в мелких размерах и 5 в крупных, у каждой свой слот;
    // новая проявляется в освободившемся слоте.
    const SL = Math.min(s.n, small ? 4 : 5),
      dr = Math.max(0.9, S * 0.062);
    const dropPos = (i: number, at: number): Pt => {
      const j = i % SL,
        ang = -Math.PI / 2 + (TAU * j) / SL + 0.3 + at * 0.5,
        q = 1 + 0.03 * Math.sin(at * 1.7 + j * 2.1);
      // Орбита с «дыханием» не выходит за холст: 0,425·1,03 + радиус капли ≤ 0,5.
      return [m + Math.cos(ang) * S * 0.425 * q, m + Math.sin(ang) * S * 0.405 * q];
    };
    if (!failed && !done) {
      for (let i = s.k; i < Math.min(s.n, s.k + SL); i++) {
        const [x, y] = dropPos(i, tt),
          g = i === s.k + SL - 1 && handE < 0.6 ? clamp(handE / 0.6) : 1;
        if (g > 0.05) shapes.push(dropHoney(x, y, dr * g, S * 0.09));
      }
      // Сдавший летит к своей ячейке, а долетев, расплющивается и перетекает из круга в шестиугольник.
      if (s.k > 0 && handE < FLY + SETTLE) {
        const target = newest >= 0 ? cell(newest) : cell(Math.min(full, nc - 1));
        if (handE < FLY) {
          const [x0, y0] = dropPos(s.k - 1, s.handAt),
            u = (handE / FLY) ** 2;
          shapes.push(dropHoney(lerp(x0, target[0], u), lerp(y0, target[1], u), dr, S * 0.09));
        } else if (newest >= 0) {
          const e = handE - FLY,
            g = spring(e, 0.45, 0.42),
            mu = clamp(spring(e - 0.06, 0.5, 0.5));
          const sq = 1 - 0.2 * Math.exp(-e * 6) * Math.cos(e * 24);
          shapes.push(cellHoney(target[0], target[1], ain, { R: lerp(dr, ain * 1.02, g), u: mu, sx: 2 - sq, sy: sq, k: S * 0.07 * (1 - mu) }));
        }
      }
    }
    // Свет: обычно сверху-слева; пока королева сводит, обходит соты по кругу; на «готово» — один полный оборот.
    let la = -2.2;
    if (coll && !R) la += collE * 1.4;
    if (done && !R && de < 1.4) la += TAU * ease(clamp(de / 1.1));
    honey3d(c, S, shapes, mem, failed, !P.glow, la, Math.max(0.9, S * 0.075));
    if (done && !R) sparks(c, S, de, P.spark, 0.5);

    // Reduce motion: вместо движения — вспышка яркости 300 мс, как у движка острова.
    const fe = t - s.flashAt;
    if (R && fe >= 0 && fe < FLASH) {
      const f = Math.sin((Math.PI * fe) / FLASH);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (P.glow) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = 0.6 * f;
        c.drawImage(c.canvas, 0, 0);
      } else {
        c.globalCompositeOperation = 'source-atop';
        c.globalAlpha = 0.45 * f;
        c.fillStyle = P.flash;
        c.fillRect(0, 0, c.canvas.width, c.canvas.height);
      }
      c.restore();
    }
  }

  return { set, needsFrame, frame };
}
