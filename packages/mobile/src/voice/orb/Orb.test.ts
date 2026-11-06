// Регрессия: конец перекрёстного затухания палитры не должен ломать Orb (на устройстве: «Cannot read property 'c1' of undefined» в Body).
// Полноценного рендерера в пакете нет, поэтому Orb вызывается как функция с минимальной реализацией хуков React,
// а reanimated подменён: runOnJS повторяет границу UI→JS, где функция-аргумент не доходит до JS как вызываемая.
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAL } from './orb-spec';

const uiCallbacks: Array<(done: boolean) => void> = [];

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, create: <T>(s: T) => s },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  Ellipse: 'Ellipse',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));
vi.mock('../../theme', () => ({ voicePalette: { bg: '#000' } }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  Easing: { linear: 0, ease: 0, inOut: () => 0 },
  runOnJS:
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) =>
      // функция, созданная на UI-потоке, в JS приходит не вызываемой; простые значения проходят как есть
      fn(...args.map((a) => (typeof a === 'function' ? {} : a))),
  useAnimatedStyle: () => ({}),
  useFrameCallback: () => ({ setActive: () => {} }),
  useReducedMotion: () => false,
  useSharedValue: <T>(v: T) => React.useMemo(() => ({ value: v, modify: () => {} }), []),
  withTiming: (to: number, _cfg: unknown, cb?: (done: boolean) => void) => {
    if (cb) uiCallbacks.push(cb);
    return to;
  },
}));

// Минимальный набор хуков: состояние, эффекты и мемо живут в слотах между вызовами Orb.
let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
let dirty = false;

vi.mock('react', async (orig) => {
  const actual = await orig<typeof React>();
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = <T>(make: () => T, deps: unknown[]): T => {
    const i = cursor++;
    const prev = slots[i] as { v: T; deps: unknown[] } | undefined;
    if (prev && same(prev.deps, deps)) return prev.v;
    slots[i] = { v: make(), deps };
    return (slots[i] as { v: T }).v;
  };
  const hooks = {
    useState: <T>(init: T) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (n: unknown) => {
        slots[i] = typeof n === 'function' ? (n as (p: T) => T)(slots[i] as T) : n;
        dirty = true;
      };
      return [slots[i], set];
    },
    useMemo: memo,
    useCallback: <T>(fn: T, deps: unknown[]) => memo(() => fn, deps),
    useId: () => ':r0:',
    useEffect: (fn: () => void, deps: unknown[]) => {
      const i = cursor++;
      const prev = slots[i] as unknown[] | undefined;
      if (!same(prev, deps)) {
        slots[i] = deps;
        effects.push(fn);
      }
    },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Orb } = await import('./Orb');

type El = { type: ((...a: never[]) => unknown) | string; props: { children?: unknown; pal?: unknown } };

function bodies(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => bodies(n, out));
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as El;
    if (typeof el.type === 'function' && el.type.name === 'Body') out.push(el);
    bodies(el.props.children, out);
  }
  return out;
}

// Рендер до стабилизации: эффекты и обновления состояния доигрываются как после коммита.
function render(state: '01' | '10'): El[] {
  let tree: unknown;
  for (let i = 0; i < 10; i++) {
    cursor = 0;
    effects = [];
    dirty = false;
    tree = Orb({ state });
    effects.forEach((e) => e());
    if (!dirty && effects.length === 0) break;
  }
  return bodies(tree);
}

afterEach(() => {
  slots = [];
  uiCallbacks.length = 0;
});

describe('Orb: перекрёстное затухание палитры', () => {
  it('после конца затухания у каждого Body остаётся существующая палитра', () => {
    render('10'); // offline, серая
    const during = render('01'); // idle, янтарная: старая палитра под новой
    expect(during.length).toBe(2);
    expect(uiCallbacks.length).toBe(1);

    uiCallbacks.forEach((cb) => cb(true)); // конец withTiming на UI-потоке
    const after = render('01');

    expect(after.length).toBeGreaterThan(0);
    for (const b of after) expect(PAL[b.props.pal as keyof typeof PAL]).toBeDefined();
    expect(after.length).toBe(1); // старая копия убрана
  });
});
