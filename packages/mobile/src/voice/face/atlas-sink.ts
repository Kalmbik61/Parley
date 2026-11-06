// Приёмник кадра роя в буферы атласа Skia: индекс спрайта, RSXform и альфа каждой души. Без Skia, поэтому проверяется
// в vitest; SwarmFace.tsx переносит буферы в `drawAtlas`.
import type { SwarmPalette, SwarmSink } from '@parley/core/swarm';

/** Сторона спрайта в атласе, px; `scale` RSXform = size / SPRITE. */
export const SPRITE = 48;
/** Палитры в порядке строк атласа; в строке 4 цвета палитры. Индекс спрайта = строка * 4 + цвет. */
export const PALETTES: readonly SwarmPalette[] = ['amber', 'coral', 'gray'];
export const SPRITE_COUNT = PALETTES.length * 4;

export interface AtlasSink extends SwarmSink {
  /** Сколько душ нарисовано в последнем кадре. */
  count: number;
  readonly sprite: Uint8Array;
  /** По четыре числа на душу: scos, ssin, tx, ty. */
  readonly xform: Float32Array;
  readonly alpha: Float32Array;
}

/** `capacity` — число вызовов `soul` за кадр: при кроссфейде палитры на душу приходится два. */
export function createAtlasSink(capacity: number): AtlasSink {
  const sink: AtlasSink = {
    count: 0,
    sprite: new Uint8Array(capacity),
    xform: new Float32Array(capacity * 4),
    alpha: new Float32Array(capacity),
    begin() {
      sink.count = 0;
    },
    soul(pal, color, x, y, size, alpha) {
      const i = sink.count;
      if (i >= capacity) return;
      sink.sprite[i] = PALETTES.indexOf(pal) * 4 + color;
      sink.xform[i * 4] = size / SPRITE;
      sink.xform[i * 4 + 1] = 0;
      sink.xform[i * 4 + 2] = x;
      sink.xform[i * 4 + 3] = y;
      sink.alpha[i] = alpha;
      sink.count = i + 1;
    },
    end() {},
  };
  return sink;
}
