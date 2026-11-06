// Рой душ острова на телефоне: движок `@parley/core/swarm` шагает на JS-потоке в буферы атласа (atlas-sink.ts), кадр
// записывается в SkPicture и кладётся в shared value — `<Picture>` читает его без перерисовки React. Душа — спрайт из
// радиального градиента (как в canvas острова), души кладутся `drawAtlas` с аддитивным смешением (`'lighter'` острова).
// Лица и рта на телефоне нет: `phoneSwarmSpec` превращает `face` в сферу, а громкость 0..1 качает рой (`soundPulse`).
import { useEffect, useRef, useState } from 'react';
import {
  BlendMode,
  Canvas,
  Picture,
  Skia,
  TileMode,
  type SkImage,
  type SkPicture,
  type SkRect,
  type SkRSXform,
} from '@shopify/react-native-skia';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { createSwarm, PAL, type SwarmSpec } from '@parley/core/swarm';
import { createAtlasSink, PALETTES, SPRITE } from './atlas-sink';

export interface SwarmFaceProps {
  spec: SwarmSpec;
  /** Громкость 0..1 (около 20 раз/с); рой плавно догоняет её сам. */
  level: number;
  /** Сторона квадрата, pt. */
  size?: number;
}

const SOULS = 700;
const FRAME_MS = 1000 / 30;
/** Геометрия `AssistantView` острова (d 86, k 0.058, minPx 2.4), перенесённая на квадрат: d = 0,6 стороны. */
const D_RATIO = 0.6;
const ISLAND_D = 86;

interface Atlas {
  image: SkImage;
  rects: SkRect[];
}

let atlas: Atlas | null = null;

/** Спрайты 12 цветов (строка — палитра, столбец — цвет) в одном изображении; стопы градиента — как в canvas острова. */
function buildAtlas(): Atlas {
  const surface = Skia.Surface.MakeOffscreen(SPRITE * 4, SPRITE * PALETTES.length) ?? Skia.Surface.Make(SPRITE * 4, SPRITE * PALETTES.length);
  if (surface === null) throw new Error('Skia: no surface for the swarm atlas');
  const canvas = surface.getCanvas();
  const rects: SkRect[] = [];
  const paint = Skia.Paint();
  const c = SPRITE / 2;
  PALETTES.forEach((name, row) => {
    PAL[name].colors.forEach((hex, col) => {
      const n = parseInt(hex.slice(1), 16);
      const r = n >> 16;
      const g = (n >> 8) & 255;
      const b = n & 255;
      // k(a, m): цвет, смешанный с белым на m, с альфой a.
      const k = (a: number, m: number) => Float32Array.of((r + (255 - r) * m) / 255, (g + (255 - g) * m) / 255, (b + (255 - b) * m) / 255, a);
      paint.setShader(
        Skia.Shader.MakeRadialGradient(
          { x: col * SPRITE + c, y: row * SPRITE + c },
          c,
          [k(1, 0.55), k(0.9, 0.2), k(0.3, 0), k(0, 0)],
          [0, 0.12, 0.35, 1],
          TileMode.Clamp,
        ),
      );
      const rect = Skia.XYWHRect(col * SPRITE, row * SPRITE, SPRITE, SPRITE);
      canvas.drawRect(rect, paint);
      rects.push(rect);
    });
  });
  surface.flush();
  return { image: surface.makeImageSnapshot(), rects };
}

/** Пустая картинка до первого кадра. */
function emptyPicture(): SkPicture {
  const rec = Skia.PictureRecorder();
  rec.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  return rec.finishRecordingAsPicture();
}

export function SwarmFace({ spec, level, size = 220 }: SwarmFaceProps): JSX.Element {
  const reduced = useReducedMotion();
  const [initial] = useState(emptyPicture);
  const picture = useSharedValue<SkPicture>(initial);
  const live = useRef({ spec, level, reduced });
  live.current = { spec, level, reduced };
  const engineRef = useRef<ReturnType<typeof createSwarm> | null>(null);
  const kick = useRef<(() => void) | null>(null);
  // Облик, уже отданный движку: первый эффект ставит его при создании, второй — только при смене.
  const applied = useRef<{ spec: SwarmSpec; reduced: boolean } | null>(null);

  // Движок, буферы и цикл кадров: один раз на размер.
  useEffect(() => {
    atlas ??= buildAtlas();
    const { image, rects } = atlas;
    const d = size * D_RATIO;
    const engine = createSwarm(SOULS, { width: size, height: size, d, cy: size / 2, k: 0.058, minPx: (2.4 * d) / ISLAND_D, soundPulse: true });
    engineRef.current = engine;
    // При кроссфейде палитры на душу приходится два вызова.
    const capacity = SOULS * 2;
    const sink = createAtlasSink(capacity);
    const xforms: SkRSXform[] = Array.from({ length: capacity }, () => Skia.RSXform(1, 0, 0, 0));
    const colors = Array.from({ length: capacity }, () => Float32Array.of(1, 1, 1, 1));
    const srcs: SkRect[] = new Array<SkRect>(capacity);
    const paint = Skia.Paint();
    paint.setBlendMode(BlendMode.Plus);
    const bounds = Skia.XYWHRect(0, 0, size, size);
    let raf = 0;
    let last = -Infinity;

    const render = (now: number): void => {
      engine.frame(now, sink, live.current.reduced, live.current.level);
      const n = sink.count;
      for (let i = 0; i < n; i++) {
        xforms[i]!.set(sink.xform[i * 4]!, sink.xform[i * 4 + 1]!, sink.xform[i * 4 + 2]!, sink.xform[i * 4 + 3]!);
        colors[i]![3] = sink.alpha[i]!;
        srcs[i] = rects[sink.sprite[i]!]!;
      }
      const rec = Skia.PictureRecorder();
      // Цвет с альфой душ перемножается со спрайтом (Modulate), затем слой кладётся на холст через Plus.
      rec.beginRecording(bounds).drawAtlas(image, srcs.slice(0, n), xforms.slice(0, n), paint, BlendMode.Modulate, colors.slice(0, n));
      picture.value = rec.finishRecordingAsPicture();
    };

    const loop = (now: number): void => {
      raf = 0;
      const { spec: s, level: lv, reduced: rm } = live.current;
      // Правило острова: кадры идут, пока движок просит (переход, реакция), пока рой качает звук и пока рой живёт
      // (не облако покоя); при reduced motion вращения нет — только то, что просит движок, и звук.
      const run = engine.needsFrame() || lv > 0 || (!rm && (s.shape !== 'cloud' || s.fx !== null));
      if (!run) return;
      if (now - last >= FRAME_MS - 2) {
        last = now;
        render(now);
      }
      raf = requestAnimationFrame(loop);
    };
    kick.current = () => {
      if (raf === 0) raf = requestAnimationFrame(loop);
    };
    applied.current = { spec: live.current.spec, reduced: live.current.reduced };
    engine.setSpec(applied.current.spec, performance.now(), applied.current.reduced);
    kick.current();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      kick.current = null;
      engineRef.current = null;
    };
  }, [size, picture]);

  // Смена облика и reduced motion уходят в движок; цикл, если стоял, просыпается.
  useEffect(() => {
    if (applied.current?.spec === spec && applied.current.reduced === reduced) return;
    applied.current = { spec, reduced };
    engineRef.current?.setSpec(spec, performance.now(), reduced);
    kick.current?.();
  }, [spec, reduced]);

  // Новый звук будит остановленный цикл.
  useEffect(() => {
    if (level > 0) kick.current?.();
  }, [level]);

  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Picture picture={picture} />
    </Canvas>
  );
}
