// Сфера голосового помощника: типизированный перенос параметров и simulate() из handoff
// (docs/design/2026-11-03-jarvis-handoff/design/orb-spec.js). При расхождении прав orb-spec.js. Чистый TS, без React.

export type PaletteKey = 'amber' | 'warm' | 'coral' | 'gray';
export interface OrbPalette {
  c1: string;
  c2: string;
  c3: string;
  /** c1 + 22 % белого. */
  c1w: string;
  /** Кромка ядра. */
  edge: string;
}

export const PAL: Record<PaletteKey, OrbPalette> = {
  amber: { c1: '#EFB05C', c2: '#F48A64', c3: '#F0DDA5', c1w: '#F3C180', edge: '#975C00' },
  warm: { c1: '#EFB05C', c2: '#F7A062', c3: '#F0DDA5', c1w: '#F3C180', edge: '#975C00' },
  coral: { c1: '#DC604C', c2: '#C43F40', c3: '#F8B287', c1w: '#E48373', edge: '#7A2E24' },
  gray: { c1: '#9C948A', c2: '#6F665F', c3: '#C3BCB1', c1w: '#B2ABA4', edge: '#4A4540' },
};

export type OrbName =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'forming'
  | 'speaking'
  | 'awaiting'
  | 'recording'
  | 'error'
  | 'offline';

/** Номер состояния из handoff: ровно то, что отдаёт `orbStateOf()` (там без 05 и 08). */
export type OrbStateId = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10';

export const STATES: readonly { id: OrbName; n: OrbStateId; caption: string }[] = [
  { id: 'idle', n: '01', caption: 'на связи' },
  { id: 'listening', n: '02', caption: 'слушаю' },
  { id: 'thinking', n: '03', caption: 'думаю' },
  { id: 'working', n: '04', caption: 'проверяю расписание' },
  { id: 'forming', n: '05', caption: 'отвечаю' },
  { id: 'speaking', n: '06', caption: 'говорю' },
  { id: 'awaiting', n: '07', caption: 'нужно подтверждение' },
  { id: 'recording', n: '08', caption: 'запись' },
  { id: 'error', n: '09', caption: 'не удалось ответить' },
  { id: 'offline', n: '10', caption: 'нет связи' },
];

export const nameOf = (n: OrbStateId): OrbName => STATES.find((s) => s.n === n)?.id ?? 'idle';

export const BUSY: Readonly<Partial<Record<OrbName, true>>> = {
  thinking: true,
  working: true,
  forming: true,
};

/** Занятое состояние показывается с задержкой 150 мс и держится не меньше 400 мс. */
export const BUSY_DELAY_MS = 150;
export const BUSY_HOLD_MS = 400;

/** Мини-вариант включается при d ≤ 48. */
export const MINI_MAX = 48;

export interface OrbParams {
  pal: PaletteKey;
  /** Кроссфейд палитры, мс. */
  xf: number;
  /** Переход частот и амплитуд, мс. */
  ramp: number;
  fB: number;
  aB: number;
  s0: number;
  hLo: number;
  hHi: number;
  hS: number;
  hs0: number;
  fD: number;
  aD: number;
  fR: number;
  rot0: number;
  aP: number;
  aL: number;
  dim: number;
  op: number;
  ring: { mode: 'cycle'; T: number } | { mode: 'level' } | { mode: 'static' } | null;
  arc: { T: number } | { still: number } | null;
  sector: { T: number } | { still: number } | null;
  dots: { T: number; lag: number } | { still: true } | null;
  gap: boolean;
  badge: 'speaker' | 'alert' | null;
  level: 'mic' | 'tts' | null;
  frozen: boolean;
  none: boolean;
}

export interface ResolveOptions {
  mini?: boolean;
  reduced?: boolean;
  /** Карточка в ответе: точки у «формирует». */
  card?: boolean;
  /** Голосовой режим: кольцо «слушает» следует громкости. */
  voice?: boolean;
  /** Пауза записи. */
  paused?: boolean;
  /** Период дуги «работает», с. */
  arcT?: number;
}

function base(): OrbParams {
  return {
    pal: 'amber',
    xf: 300,
    ramp: 600,
    fB: 0,
    aB: 0,
    s0: 1,
    hLo: 0.35,
    hHi: 0.35,
    hS: 0,
    hs0: 0,
    fD: 0,
    aD: 0,
    fR: 0,
    rot0: 0,
    aP: 0,
    aL: 0,
    dim: 0,
    op: 1,
    ring: null,
    arc: null,
    sector: null,
    dots: null,
    gap: false,
    badge: null,
    level: null,
    frozen: false,
    none: false,
  };
}

/** Дыхание: период T, амплитуда ядра A, ореол lo→hi, scale-амплитуда ореола hS, период дрейфа пятен dT, множитель aD. */
function breath(
  T: number,
  A: number,
  lo: number,
  hi: number,
  hS: number,
  dT?: number,
  aD?: number,
): Partial<OrbParams> {
  return { fB: 1 / T, aB: A, hLo: lo, hHi: hi, hS, fD: 1 / (dT || T), aD: aD == null ? 1 : aD };
}

export function resolve(id: OrbName, o: ResolveOptions = {}): OrbParams {
  const mini = !!o.mini;
  const rm = !!o.reduced;
  const c = base();
  const arcT = +(o.arcT ?? 0) || 2;
  const set = (p: Partial<OrbParams>) => Object.assign(c, p);
  switch (id) {
    case 'idle':
      if (!mini) set(breath(7, 0.045, 0.5, 0.78, 0.07));
      break;
    case 'listening':
      if (!mini) set(breath(4, 0.045, 0.5, 0.78, 0.07));
      c.ring = o.voice && !mini ? { mode: 'level' } : { mode: 'cycle', T: 2.4 };
      if (o.voice && !mini) c.level = 'mic';
      break;
    case 'thinking':
      c.pal = 'warm';
      if (!mini) set(breath(3, 0.045, 0.5, 0.78, 0.07));
      c.fR = 1 / 7;
      break;
    case 'working':
      if (!mini) set(breath(7, 0.008, 0.6, 0.66, 0.015, 14, 0.6));
      c.arc = { T: arcT };
      break;
    case 'forming':
      if (!mini) set(breath(4, 0.02, 0.55, 0.72, 0.04, 5, 0.8));
      c.sector = { T: 2.4 };
      if (o.card && !mini) c.dots = { T: 1.2, lag: 0.4 };
      break;
    case 'speaking':
      if (!mini) {
        set(breath(2.4, 0.01, 0.5, 0.6, 0.02));
        c.aP = 0.05;
        c.aL = 0.28;
      } else {
        c.aP = 0.02;
        c.badge = 'speaker';
      }
      c.level = 'tts';
      break;
    case 'awaiting':
      set({
        ramp: 300,
        gap: true,
        hLo: mini ? 0.5 : 0.95,
        hHi: mini ? 0.5 : 0.95,
        hs0: mini ? 0 : 0.06,
        aD: mini ? 0 : 1,
      });
      break;
    case 'recording':
      if (mini) {
        c.none = true;
        break;
      }
      set(breath(7, 0.015, 0.5, 0.6, 0.02, 7, 0.6));
      c.ring = { mode: 'level' };
      c.level = 'mic';
      if (o.paused) set({ fB: 0, fD: 0, dim: 0.2, ramp: 300, frozen: true });
      break;
    case 'error':
      set({
        pal: 'coral',
        xf: 180,
        ramp: 180,
        badge: 'alert',
        hLo: mini ? 0.35 : 0.55,
        hHi: mini ? 0.35 : 0.55,
        aD: mini ? 0 : 1,
      });
      break;
    case 'offline':
      if (!mini) set(breath(13, 0.015, 0.06, 0.1, 0.02, 13, 0.5));
      else set({ hLo: 0.05, hHi: 0.05 });
      c.pal = 'gray';
      c.op = 0.72;
      break;
  }
  if (rm) {
    const m = (c.hLo + c.hHi) / 2;
    set({
      fB: 0,
      aB: 0,
      fD: 0,
      aD: 0,
      fR: 0,
      aP: 0,
      aL: 0,
      hLo: m,
      hHi: m,
      hs0: c.hs0 + c.hS / 2,
      hS: 0,
      xf: Math.min(c.xf, 100),
      ramp: 0,
      level: null,
      frozen: false,
    });
    if (c.ring) c.ring = { mode: 'static' };
    if (c.arc) c.arc = { still: -30 };
    if (c.sector) c.sector = { still: 135 };
    if (c.dots) c.dots = { still: true };
    if (id === 'thinking') c.rot0 = 150;
    if (id === 'speaking') {
      c.badge = 'speaker';
      if (!mini) c.s0 = 1.02;
    }
  }
  return c;
}

/**
 * Нужен ли кадровый цикл: есть бесконечный цикл (дыхание, дрейф, вращение, кольцо, дуга, сектор, точки) или живая громкость.
 * Переходы между состояниями цикл не требуют сам по себе: компонент включает его на время перехода.
 */
export function needsFrameLoop(c: OrbParams, hasLevel: boolean): boolean {
  if (c.none) return false;
  const cycle =
    c.fB > 0 ||
    c.fD > 0 ||
    c.fR > 0 ||
    c.ring?.mode === 'cycle' ||
    (!!c.arc && 'T' in c.arc) ||
    (!!c.sector && 'T' in c.sector) ||
    (!!c.dots && 'T' in c.dots);
  return cycle || (c.level !== null && hasLevel);
}

export interface SimEvent {
  t: number;
  to: OrbName;
  cap: string;
}
export interface SimScenario {
  id: string;
  end: number;
  events: readonly SimEvent[];
}
export interface SimBand {
  state: OrbName;
  caption: string;
  from: number;
  to: number;
}
export interface SimNote {
  kind: 'delay' | 'hold';
  from: number;
  to: number;
  ev?: number;
}

export const SCENARIOS: readonly SimScenario[] = [
  {
    id: 's1',
    end: 5600,
    events: [
      { t: 0, to: 'idle', cap: 'на связи' },
      { t: 600, to: 'thinking', cap: 'думаю' },
      { t: 980, to: 'working', cap: 'проверяю расписание' },
      { t: 3100, to: 'forming', cap: 'отвечаю' },
      { t: 4700, to: 'idle', cap: 'на связи' },
    ],
  },
  {
    id: 's2',
    end: 5600,
    events: [
      { t: 0, to: 'listening', cap: 'слушаю' },
      { t: 2200, to: 'idle', cap: 'на связи' },
      { t: 2200, to: 'thinking', cap: 'думаю' },
      { t: 3500, to: 'speaking', cap: 'говорю' },
    ],
  },
  {
    id: 's3',
    end: 5600,
    events: [
      { t: 0, to: 'working', cap: 'ищу заметку «Билеты»' },
      { t: 1300, to: 'awaiting', cap: 'нужно подтверждение' },
      { t: 3600, to: 'idle', cap: 'на связи' },
      { t: 3600, to: 'working', cap: 'удаляю заметку' },
    ],
  },
];

/** Правила 150 / 400 мс применяются к событиям сценария → полосы показанных состояний. */
export function simulate(sc: SimScenario): { bands: SimBand[]; notes: SimNote[] } {
  const ev = sc.events.slice().sort((a, b) => a.t - b.t);
  const first = ev[0];
  if (!first) return { bands: [], notes: [] };
  let shown = first.to;
  let cap = first.cap;
  let since = 0;
  let pend: { to: OrbName; cap: string; at: number } | null = null;
  const bands: SimBand[] = [];
  const notes: SimNote[] = [];
  const commit = (t: number, to: OrbName, c: string) => {
    if (t > since) bands.push({ state: shown, caption: cap, from: since, to: t });
    shown = to;
    cap = c;
    since = t;
  };
  for (let i = 1; i < ev.length; i++) {
    const e = ev[i]!;
    if (pend && pend.at <= e.t) {
      commit(pend.at, pend.to, pend.cap);
      pend = null;
    }
    if (!BUSY[e.to]) {
      pend = null;
      commit(e.t, e.to, e.cap);
      continue;
    }
    if (!BUSY[shown]) {
      pend = { to: e.to, cap: e.cap, at: e.t + BUSY_DELAY_MS };
      notes.push({ kind: 'delay', from: e.t, to: e.t + BUSY_DELAY_MS });
      continue;
    }
    const at = Math.max(e.t, since + BUSY_HOLD_MS);
    if (at > e.t) {
      notes.push({ kind: 'hold', from: since, to: at, ev: e.t });
      pend = { to: e.to, cap: e.cap, at };
    } else commit(e.t, e.to, e.cap);
  }
  if (pend && pend.at <= sc.end) commit(pend.at, pend.to, pend.cap);
  bands.push({ state: shown, caption: cap, from: since, to: sc.end });
  return { bands, notes };
}
