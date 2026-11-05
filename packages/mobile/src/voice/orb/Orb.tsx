// Сфера голосового помощника (VM0, палитра A): react-native-svg рисует градиенты, reanimated двигает слои на UI-потоке.
// Параметры и переходы — из orb-spec.ts (порт orb-spec.js). Кадровый цикл повторяет step() из JarvisOrb.dc.html:
// частоты и амплитуды плавно идут к целевым за `ramp`, фазы копятся как φ += f·dt, поэтому смена состояния не рвёт движение.
import { useEffect, useId, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { voicePalette } from '../../theme';
import {
  MINI_MAX,
  PAL,
  nameOf,
  needsFrameLoop,
  resolve,
  type OrbParams,
  type OrbStateId,
  type PaletteKey,
} from './orb-spec';

export interface OrbProps {
  /** Номер состояния из handoff (как отдаёт `orbStateOf()`). */
  state: OrbStateId;
  /** Диаметр: 168 (экран) или 32 (мини); при d ≤ 48 включается мини-вариант. */
  size?: 168 | 32 | number;
  /** Сглаженная громкость 0…1 для «слушает» (кольцо), «говорит» и «записывает». Без неё слои громкости неподвижны. */
  level?: number;
  /** Цвет выреза под значком (фон за сферой). */
  cutout?: string;
}

type Kids = React.ComponentProps<typeof View>['children'];
// Типы Animated.View в этом пакете сводятся к `{}` (нет ни style, ни children): явный тип, поведение то же.
const AView = Animated.View as unknown as React.ComponentType<{
  style?: StyleProp<ViewStyle> | object;
  children?: Kids;
}>;

const TAU = Math.PI * 2;
// Числовые параметры, которые плавно переходят между состояниями.
const NUM = [
  'fB',
  'aB',
  's0',
  'hLo',
  'hHi',
  'hS',
  'hs0',
  'fD',
  'aD',
  'fR',
  'rot0',
  'aP',
  'aL',
  'dim',
  'op',
] as const;
const N = NUM.length;
// Раскладка массива состояния кадрового цикла: [cur | from | to | фазы и конфигурация].
const FROM = N;
const TO = 2 * N;
const P_B = 3 * N; // фазы: дыхание, три пятна, вращение, пульс голоса, дуга, сектор, кольцо
const P_D1 = P_B + 1;
const P_D2 = P_B + 2;
const P_D3 = P_B + 3;
const P_R = P_B + 4;
const P_P = P_B + 5;
const P_A = P_B + 6;
const P_S = P_B + 7;
const P_C = P_B + 8;
const P_L = P_B + 9; // сглаженная громкость
const T0 = P_B + 10; // начало перехода (-1 = взять из первого кадра)
const DUR = P_B + 11;
const IDLE = P_B + 12; // кадры покоя подряд
const RING = P_B + 13; // 0 нет, 1 cycle, 2 level, 3 static
const ARC_T = P_B + 14;
const ARC_STILL = P_B + 15;
const SEC_T = P_B + 16;
const SEC_STILL = P_B + 17;
const LEVEL_ON = P_B + 18;
const DIAM = P_B + 19; // диаметр, px
const SIZE = P_B + 20;

const ringCode = (r: OrbParams['ring']) =>
  !r ? 0 : r.mode === 'cycle' ? 1 : r.mode === 'level' ? 2 : 3;
// Конфигурация слоёв, кладётся в массив состояния с индекса RING подряд.
const cfgOf = (c: OrbParams, d: number): number[] => [
  ringCode(c.ring),
  c.arc && 'T' in c.arc ? c.arc.T : 0,
  c.arc && 'still' in c.arc ? c.arc.still : 0,
  c.sector && 'T' in c.sector ? c.sector.T : 0,
  c.sector && 'still' in c.sector ? c.sector.still : 0,
  c.level ? 1 : 0,
  d,
];

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

interface Motion {
  core: SharedValue<number>;
  hO: SharedValue<number>;
  hS: SharedValue<number>;
  rot: SharedValue<number>;
  b1x: SharedValue<number>;
  b1y: SharedValue<number>;
  b2x: SharedValue<number>;
  b2y: SharedValue<number>;
  b3x: SharedValue<number>;
  b3y: SharedValue<number>;
  rS: SharedValue<number>;
  rO: SharedValue<number>;
  dim: SharedValue<number>;
  aR: SharedValue<number>;
  sR: SharedValue<number>;
}

const easeInOut = (u: number) => {
  'worklet';
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
};
const easeOut = (u: number) => {
  'worklet';
  return 1 - (1 - u) * (1 - u);
};
const wave = (v: number) => {
  'worklet';
  return (1 - Math.cos(TAU * v)) / 2;
};

/** Слой, который появляется за 200 мс (кольцо подтверждения — 150) и исчезает за 150 мс; reduced motion — 100 мс. */
function FadeLayer({
  on,
  rm,
  enter,
  children,
}: {
  on: boolean;
  rm: boolean;
  enter?: number;
  children: Kids;
}) {
  const [shown, setShown] = useState(on);
  const op = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    if (on) {
      setShown(true);
      op.value = withTiming(1, {
        duration: rm ? 100 : (enter ?? 200),
        easing: rm ? Easing.linear : Easing.out(Easing.quad),
      });
    } else {
      op.value = withTiming(
        0,
        { duration: rm ? 100 : 150, easing: rm ? Easing.linear : Easing.in(Easing.quad) },
        (done) => {
          if (done) runOnJS(setShown)(false);
        },
      );
    }
  }, [on, rm, enter, op]);
  const style = useAnimatedStyle(() => ({ opacity: op.value }));
  if (!shown) return null;
  return <AView style={[StyleSheet.absoluteFill, style]}>{children}</AView>;
}

const soft = (id: string, color: string, a: number) => (
  <RadialGradient id={id} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
    <Stop offset="0" stopColor={color} stopOpacity={a} />
    <Stop offset="0.28" stopColor={color} stopOpacity={a * 0.8} />
    <Stop offset="0.55" stopColor={color} stopOpacity={a * 0.45} />
    <Stop offset="0.8" stopColor={color} stopOpacity={a * 0.14} />
    <Stop offset="1" stopColor={color} stopOpacity={0} />
  </RadialGradient>
);

/** Круг с радиальным градиентом, вписанный в квадрат `s`. */
function Disc({ id, s, gradient }: { id: string; s: number; gradient: React.JSX.Element }) {
  return (
    <Svg width={s} height={s} viewBox="0 0 100 100">
      <Defs>{gradient}</Defs>
      <Circle cx="50" cy="50" r="50" fill={`url(#${id})`} />
    </Svg>
  );
}

/** Все слои, зависящие от палитры: при смене палитры новая копия проявляется поверх старой. */
function Body(props: {
  pal: PaletteKey;
  d: number;
  mini: boolean;
  rm: boolean;
  c: OrbParams;
  m: Motion;
}) {
  const { pal, d, mini, rm, c, m } = props;
  const P = PAL[pal];
  const uid = useId().replace(/[^A-Za-z0-9]/g, '');
  const g = (n: string) => `${uid}${n}`;
  const s1 = 0.58 * d;
  const s2 = 0.52 * d;
  const s3 = 0.46 * d;
  const bw = mini ? 1.5 : Math.max(1.5, Math.round(d * 0.009 * 2) / 2);
  const R = 48;
  const C = TAU * R;
  const sw = (px: number) => (px * 100) / (1.24 * d);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: m.hO.value,
    transform: [{ scale: m.hS.value }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: m.rO.value,
    transform: [{ scale: m.rS.value }],
  }));
  const coreStyle = useAnimatedStyle(() => ({ transform: [{ scale: m.core.value }] }));
  const rotStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${m.rot.value}deg` }] }));
  const b1 = useAnimatedStyle(() => ({
    transform: [{ translateX: m.b1x.value }, { translateY: m.b1y.value }],
  }));
  const b2 = useAnimatedStyle(() => ({
    transform: [{ translateX: m.b2x.value }, { translateY: m.b2y.value }],
  }));
  const b3 = useAnimatedStyle(() => ({
    transform: [{ translateX: m.b3x.value }, { translateY: m.b3y.value }],
  }));
  const secStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${m.sR.value}deg` }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: m.dim.value }));
  const arcStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${m.aR.value}deg` }] }));

  const box = (k: number): ViewStyle => ({
    position: 'absolute',
    left: -k * d,
    top: -k * d,
    width: (1 + 2 * k) * d,
    height: (1 + 2 * k) * d,
  });
  const ring = (dash: number, gap: number, rotate: number) => (
    <Svg width="100%" height="100%" viewBox="0 0 100 100" style={styles.visible}>
      <Circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke={P.c1}
        strokeWidth={sw(2)}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${gap}`}
        transform={`rotate(${rotate} 50 50)`}
      />
    </Svg>
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <AView style={[box(0.2), haloStyle]}>
        <Disc
          id={g('h')}
          s={1.4 * d}
          gradient={
            <RadialGradient id={g('h')} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={P.c1} stopOpacity={0.5} />
              <Stop offset="0.7" stopColor={P.c1} stopOpacity={0.5} />
              <Stop offset="0.76" stopColor={P.c1} stopOpacity={0.36} />
              <Stop offset="0.84" stopColor={P.c1} stopOpacity={0.18} />
              <Stop offset="0.92" stopColor={P.c1} stopOpacity={0.06} />
              <Stop offset="1" stopColor={P.c1} stopOpacity={0} />
            </RadialGradient>
          }
        />
      </AView>
      <FadeLayer on={!!c.ring} rm={rm}>
        <AView
          style={[
            box(0.04),
            { borderRadius: d, borderWidth: bw, borderColor: rgba(P.c1, 0.9) },
            ringStyle,
          ]}
        />
      </FadeLayer>
      <AView style={[{ width: d, height: d, borderRadius: d / 2, overflow: 'hidden' }, coreStyle]}>
        <Svg width={d} height={d} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id={g('c')} cx="32" cy="26" r="125" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={P.c3} />
              <Stop offset="0.46" stopColor={P.c1} />
              <Stop offset="1" stopColor={P.edge} />
            </RadialGradient>
            <LinearGradient
              id={g('sh')}
              x1="0"
              y1="0"
              x2="0"
              y2="100"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#FFFAF0" stopOpacity={0.16} />
              <Stop offset="0.26" stopColor="#FFFAF0" stopOpacity={0} />
              <Stop offset="0.56" stopColor="#000" stopOpacity={0} />
              <Stop offset="1" stopColor="#000" stopOpacity={0.26} />
            </LinearGradient>
          </Defs>
          <Rect width="100" height="100" fill={`url(#${g('c')})`} />
        </Svg>
        <AView style={[StyleSheet.absoluteFill, rotStyle]}>
          <AView style={[{ position: 'absolute', left: 0.06 * d, top: 0.08 * d }, b1]}>
            <Disc id={g('b1')} s={s1} gradient={soft(g('b1'), P.c3, 0.95)} />
          </AView>
          <AView style={[{ position: 'absolute', left: 0.44 * d, top: 0.32 * d }, b2]}>
            <Disc id={g('b2')} s={s2} gradient={soft(g('b2'), P.c1w, 0.95)} />
          </AView>
          <AView style={[{ position: 'absolute', left: 0.26 * d, top: 0.5 * d }, b3]}>
            <Disc id={g('b3')} s={s3} gradient={soft(g('b3'), P.c2, 0.5)} />
          </AView>
        </AView>
        <FadeLayer on={!!c.sector} rm={rm}>
          <AView style={[StyleSheet.absoluteFill, secStyle]}>
            <Svg width={d} height={d} viewBox="0 0 100 100">
              <Defs>
                <RadialGradient
                  id={g('sc')}
                  cx="50"
                  cy="17"
                  rx="22"
                  ry="36"
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0" stopColor="#FFFDF8" stopOpacity={0.95} />
                  <Stop offset="0.38" stopColor="#FFFDF8" stopOpacity={0.62} />
                  <Stop offset="0.7" stopColor="#FFFDF8" stopOpacity={0.2} />
                  <Stop offset="1" stopColor="#FFFDF8" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Ellipse cx="50" cy="17" rx="22" ry="36" fill={`url(#${g('sc')})`} />
            </Svg>
          </AView>
        </FadeLayer>
        <Svg width={d} height={d} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient
              id={g('sn')}
              cx="35"
              cy="20"
              rx="58"
              ry="42"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#FFF" stopOpacity={0.55} />
              <Stop offset="0.58" stopColor="#FFF" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100" height="100" fill={`url(#${g('sh')})`} />
          <Rect width="100" height="100" fill={`url(#${g('sn')})`} />
        </Svg>
        <AView style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, dimStyle]} />
      </AView>
      <FadeLayer on={!!c.arc} rm={rm}>
        <AView style={[box(0.12), arcStyle]}>{ring(C / 3, C, -90)}</AView>
      </FadeLayer>
      <FadeLayer on={c.gap} rm={rm} enter={150}>
        <View style={box(0.12)}>{ring(C * 0.93, C * 0.07, -32.4)}</View>
      </FadeLayer>
    </View>
  );
}

export function Orb({ state, size = 168, level, cutout = voicePalette.bg }: OrbProps) {
  const d = size;
  const mini = d <= MINI_MAX;
  const rm = useReducedMotion();
  const id = nameOf(state);
  const voice = level !== undefined;
  const c = useMemo(() => resolve(id, { mini, reduced: rm, voice }), [id, mini, rm, voice]);

  const levelSv = useSharedValue(level ?? 0);
  useEffect(() => {
    levelSv.value = level ?? 0;
  }, [level, levelSv]);

  // Состояние кадрового цикла одним массивом: cur | from | to | фазы | конфигурация.
  const st = useSharedValue<number[]>(
    (() => {
      const cur = NUM.map((k) => c[k]);
      const phase = 0.618034;
      const tail = new Array<number>(SIZE - 3 * N).fill(0);
      const arr = [...cur, ...cur, ...cur, ...tail];
      arr[P_B] = phase;
      arr[P_D1] = (phase + 0.21) % 1;
      arr[P_D2] = (phase + 0.57) % 1;
      arr[P_D3] = (phase + 0.83) % 1;
      arr[P_A] = phase;
      arr[P_S] = phase;
      arr[P_C] = phase;
      arr[T0] = -1;
      cfgOf(c, d).forEach((v, i) => (arr[RING + i] = v));
      return arr;
    })(),
  );

  const m: Motion = {
    core: useSharedValue(c.s0),
    hO: useSharedValue(c.hLo),
    hS: useSharedValue(1 + c.hs0),
    rot: useSharedValue(c.rot0),
    b1x: useSharedValue(0),
    b1y: useSharedValue(0),
    b2x: useSharedValue(0),
    b2y: useSharedValue(0),
    b3x: useSharedValue(0),
    b3y: useSharedValue(0),
    rS: useSharedValue(1.12),
    rO: useSharedValue(0.55),
    dim: useSharedValue(c.dim),
    aR: useSharedValue(-30),
    sR: useSharedValue(40),
  };
  const opSv = useSharedValue(c.op);

  // Новое состояние: текущие значения становятся «from», цель — параметры состояния; фаза не сбрасывается.
  useEffect(() => {
    const to = NUM.map((k) => c[k]);
    const cfg = cfgOf(c, d);
    const dur = c.ramp;
    st.modify((v) => {
      'worklet';
      for (let i = 0; i < N; i++) {
        v[FROM + i] = v[i]!;
        v[TO + i] = to[i]!;
      }
      v[T0] = -1;
      v[DUR] = dur;
      v[IDLE] = 0;
      for (let i = 0; i < cfg.length; i++) v[RING + i] = cfg[i]!;
      return v;
    });
  }, [c, d, st]);

  const frame = useFrameCallback((info) => {
    'worklet';
    const delta = info.timeSincePreviousFrame ?? 16;
    const now = info.timestamp;
    st.modify((v) => {
      'worklet';
      if (v[T0] === -1) v[T0] = now;
      const dur = v[DUR]!;
      const u = !dur ? 1 : Math.min(1, (now - v[T0]!) / dur);
      const e = easeInOut(u);
      for (let i = 0; i < N; i++) v[i] = v[FROM + i]! + (v[TO + i]! - v[FROM + i]!) * e;
      const dt = Math.min(delta, 64) / 1000;
      const raw = v[LEVEL_ON] ? levelSv.value : 0;
      if (v[LEVEL_ON])
        v[P_L] = v[P_L]! + (raw - v[P_L]!) * (1 - Math.exp(-dt / (raw > v[P_L]! ? 0.05 : 0.18)));
      else v[P_L] = v[P_L]! * Math.exp(-dt / 0.18);
      const fB = v[0]!,
        aB = v[1]!,
        s0 = v[2]!,
        hLo = v[3]!,
        hHi = v[4]!,
        hS = v[5]!,
        hs0 = v[6]!,
        fD = v[7]!,
        aD = v[8]!;
      const fR = v[9]!,
        rot0 = v[10]!,
        aP = v[11]!,
        aL = v[12]!,
        dim = v[13]!,
        op = v[14]!;
      const ring = v[RING]!;
      const moving =
        u < 1 ||
        fB ||
        fD ||
        fR ||
        v[LEVEL_ON] ||
        v[P_L]! > 0.002 ||
        ring === 1 ||
        v[ARC_T] ||
        v[SEC_T];
      if (!moving) {
        if (v[IDLE]! >= 2) return v;
        v[IDLE] = v[IDLE]! + 1;
      } else v[IDLE] = 0;
      v[P_B] = v[P_B]! + dt * fB;
      v[P_D1] = v[P_D1]! + (dt * fD) / 1.7;
      v[P_D2] = v[P_D2]! + (dt * fD) / 2.1;
      v[P_D3] = v[P_D3]! + (dt * fD) / 1.4;
      v[P_R] = v[P_R]! + dt * fR * 360;
      v[P_P] = v[P_P]! + dt / 0.62;
      if (v[ARC_T]) v[P_A] = v[P_A]! + dt / v[ARC_T]!;
      if (v[SEC_T]) v[P_S] = v[P_S]! + dt / v[SEC_T]!;
      if (ring === 1) v[P_C] = v[P_C]! + dt / 2.4;
      const L = v[P_L]!;
      const wb = wave(v[P_B]!);
      m.core.value = s0 + aB * wb + aP * L * wave(v[P_P]!);
      m.hO.value = Math.min(1, hLo + (hHi - hLo) * wb + aL * L);
      m.hS.value = 1 + hs0 + hS * wb;
      const sz1 = 0.58 * v[DIAM]!,
        sz2 = 0.52 * v[DIAM]!,
        sz3 = 0.46 * v[DIAM]!;
      const w1 = wave(v[P_D1]!) * aD,
        w2 = wave(v[P_D2]!) * aD,
        w3 = wave(v[P_D3]!) * aD;
      m.b1x.value = 0.12 * sz1 * w1;
      m.b1y.value = 0.09 * sz1 * w1;
      m.b2x.value = -0.11 * sz2 * w2;
      m.b2y.value = 0.11 * sz2 * w2;
      m.b3x.value = 0.09 * sz3 * w3;
      m.b3y.value = -0.11 * sz3 * w3;
      m.rot.value = rot0 + v[P_R]!;
      m.dim.value = dim;
      opSv.value = op;
      if (ring === 1) {
        const k = easeOut(v[P_C]! % 1);
        m.rS.value = 0.9 + 0.32 * k;
        m.rO.value = 0.65 * (1 - k);
      } else if (ring === 2) {
        m.rS.value = 0.96 + 0.26 * L;
        m.rO.value = 0.25 + 0.6 * L;
      } else if (ring === 3) {
        m.rS.value = 1.12;
        m.rO.value = 0.55;
      }
      m.aR.value = v[ARC_T] ? (v[P_A]! % 1) * 360 : v[ARC_STILL]!;
      m.sR.value = v[SEC_T] ? (v[P_S]! % 1) * 360 : v[SEC_STILL]!;
      return v;
    });
  }, false);

  // Кадровый цикл нужен, пока есть цикл, громкость или переход; иначе после перехода (ramp + затухание громкости) он гаснет.
  const loop = needsFrameLoop(c, voice);
  const { setActive } = frame;
  useEffect(() => {
    setActive(true);
    if (loop) return undefined;
    const t = setTimeout(() => setActive(false), c.ramp + 1000);
    return () => clearTimeout(t);
  }, [c, loop, setActive]);

  // Смена палитры: новая копия слоёв проявляется поверх старой за `xf`.
  const [pals, setPals] = useState<{ cur: PaletteKey; prev: PaletteKey | null }>({
    cur: c.pal,
    prev: null,
  });
  const fade = useSharedValue(1);
  useEffect(() => {
    setPals((p) => {
      if (p.cur === c.pal) return p;
      fade.value = 0;
      fade.value = withTiming(
        1,
        { duration: c.xf, easing: c.xf <= 100 ? Easing.linear : Easing.inOut(Easing.ease) },
        (done) => {
          if (done) runOnJS(setPals)((q) => ({ ...q, prev: null }));
        },
      );
      return { cur: c.pal, prev: p.cur };
    });
  }, [c.pal, c.xf, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const rootStyle = useAnimatedStyle(() => ({ opacity: opSv.value }));

  const bs = mini ? 14 : Math.round(d * 0.17);
  const badgeBorder = mini ? 2 : Math.max(2, Math.round(d * 0.014));

  return (
    <AView style={[{ width: d, height: d, pointerEvents: 'none' }, rootStyle]}>
      {pals.prev && <Body pal={pals.prev} d={d} mini={mini} rm={rm} c={c} m={m} />}
      <AView style={[StyleSheet.absoluteFill, fadeStyle]}>
        <Body pal={pals.cur} d={d} mini={mini} rm={rm} c={c} m={m} />
      </AView>
      <FadeLayer on={!!c.badge} rm={rm}>
        {c.badge ? (
          <View
            style={{
              position: 'absolute',
              left: d * 0.854 - bs / 2,
              top: d * 0.854 - bs / 2,
              width: bs,
              height: bs,
              borderRadius: bs / 2,
              borderWidth: badgeBorder,
              borderColor: cutout,
              backgroundColor: c.badge === 'alert' ? '#DC604C' : '#F0DDA5',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {c.badge === 'alert' ? (
              <Text
                style={{
                  fontSize: Math.round(bs * 0.66),
                  lineHeight: Math.round(bs * 0.66) + 2,
                  fontWeight: '700',
                  color: '#2A0C07',
                }}
              >
                !
              </Text>
            ) : (
              <Svg
                width={bs * 0.64}
                height={bs * 0.64}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#2B1C08"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <Path d="M4 9.5h3l4.5-4v13L7 14.5H4z" fill="#2B1C08" />
                <Path d="M15.5 9a4 4 0 0 1 0 6" />
                <Path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
              </Svg>
            )}
          </View>
        ) : null}
      </FadeLayer>
    </AView>
  );
}

const styles = StyleSheet.create({ visible: { overflow: 'visible' } });
