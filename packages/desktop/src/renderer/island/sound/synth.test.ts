/**
 * Движок сигналов острова (#9 §3.1–§3.2, T1): рецепты, палитры, огибающие по времени, бюджет осцилляторов, остановка
 * узлов. Подставной `AudioContext` записывает узлы, связи и расписание параметров.
 */

import { describe, expect, it } from 'vitest';
import { PALETTES, type IslandPalette } from './palettes.js';
import { CUE_RECIPES, MAX_CUE_OSCILLATORS, playCue, type CueSound } from './synth.js';

type Call = [method: string, ...args: number[]];

class FakeParam {
  calls: Call[] = [];
  constructor(public value = 0) {}
  setValueAtTime(value: number, time: number) {
    this.calls.push(['setValueAtTime', value, time]);
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push(['linearRampToValueAtTime', value, time]);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.calls.push(['exponentialRampToValueAtTime', value, time]);
  }
}

class FakeNode {
  connections: unknown[] = [];
  constructor(public kind: string) {}
  connect(target: unknown) {
    this.connections.push(target);
    return target;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  wave: unknown = null;
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
  started: number | null = null;
  stopped: number | null = null;
  constructor() {
    super('oscillator');
  }
  setPeriodicWave(wave: unknown) {
    this.type = 'custom';
    this.wave = wave;
  }
  start(time: number) {
    this.started = time;
  }
  stop(time: number) {
    this.stopped = time;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor() {
    super('gain');
  }
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  constructor() {
    super('filter');
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  started: number | null = null;
  stopped: number | null = null;
  constructor() {
    super('buffer-source');
  }
  start(time: number) {
    this.started = time;
  }
  stop(time: number) {
    this.stopped = time;
  }
}

class FakeContext {
  currentTime = 2;
  sampleRate = 48_000;
  nodes: FakeNode[] = [];
  waves: Array<{ real: number[]; imag: number[] }> = [];
  private add<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
  createOscillator() {
    return this.add(new FakeOscillator());
  }
  createGain() {
    return this.add(new FakeGain());
  }
  createBiquadFilter() {
    return this.add(new FakeFilter());
  }
  createBufferSource() {
    return this.add(new FakeBufferSource());
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createPeriodicWave(real: number[], imag: number[]) {
    const wave = { real, imag };
    this.waves.push(wave);
    return wave;
  }
  of<T extends FakeNode>(type: new () => T): T[] {
    return this.nodes.filter((node): node is T => node instanceof type);
  }
}

const KINDS = Object.keys(CUE_RECIPES) as CueSound[];
const NAMES = Object.keys(PALETTES) as IslandPalette[];
const START = 2.01;

function play(kind: CueSound, palette: IslandPalette, options?: { quiet?: boolean }) {
  const context = new FakeContext();
  const destination = new FakeNode('destination');
  playCue(context as unknown as BaseAudioContext, destination as unknown as AudioNode, kind, palette, options);
  return { context, destination };
}

/** Огибающие нот — те усилители, что подключены прямо к выходу сигнала. */
function envelopes(context: FakeContext, destination: FakeNode): FakeGain[] {
  return context.of(FakeGain).filter((node) => node.connections.includes(destination));
}

/** Узел доходит до выхода по связям (через фильтры, усилители и параметр частоты несущей). */
function reaches(node: unknown, target: unknown, context: FakeContext, seen = new Set<unknown>()): boolean {
  if (node === target) return true;
  if (seen.has(node) || !(node instanceof FakeNode)) return false;
  seen.add(node);
  return node.connections.some((next) => {
    const owner = context.nodes.find((candidate) => candidate instanceof FakeOscillator && candidate.frequency === next);
    return reaches(owner ?? next, target, context, seen);
  });
}

describe('playCue', () => {
  it(`ни один сигнал ни в одной палитре не берёт больше ${MAX_CUE_OSCILLATORS} осцилляторов`, () => {
    for (const kind of KINDS) {
      for (const palette of NAMES) {
        const { context } = play(kind, palette);
        expect(context.of(FakeOscillator).length, `${kind} / ${palette}`).toBeLessThanOrEqual(MAX_CUE_OSCILLATORS);
        expect(context.of(FakeOscillator).length + context.of(FakeBufferSource).length).toBeGreaterThan(0);
      }
    }
  });

  it('каждый источник запущен и остановлен по огибающей, и каждый узел доходит до выхода', () => {
    for (const kind of KINDS) {
      for (const palette of NAMES) {
        const { context, destination } = play(kind, palette);
        for (const source of [...context.of(FakeOscillator), ...context.of(FakeBufferSource)]) {
          expect(source.started).not.toBeNull();
          expect(source.stopped).toBeGreaterThan(source.started ?? Infinity);
        }
        for (const node of context.nodes) expect(reaches(node, destination, context), `${kind} / ${palette}`).toBe(true);
      }
    }
  });

  it('done: ноты входят по рецепту, огибающая — атака палитры, спад до тишины за длительность × хвост, stop после неё', () => {
    const { context, destination } = play('done', 'soft');
    const soft = PALETTES.soft;
    const notes = CUE_RECIPES.done.notes ?? [];
    const gains = envelopes(context, destination);
    expect(gains).toHaveLength(notes.length);
    notes.forEach(([, startMs, durationMs, gainDb], index) => {
      const start = START + startMs / 1000;
      const end = start + (durationMs / 1000) * soft.tail;
      const peak = 10 ** ((CUE_RECIPES.done.level + gainDb) / 20);
      const calls = gains[index]?.gain.calls ?? [];
      expect(calls[0]).toEqual(['setValueAtTime', 0, start]);
      expect(calls[1]?.[0]).toBe('linearRampToValueAtTime');
      expect(calls[1]?.[1]).toBeCloseTo(peak, 6);
      expect(calls[1]?.[2]).toBeCloseTo(start + soft.attack, 6);
      expect(calls.at(-1)?.[0]).toBe('exponentialRampToValueAtTime');
      expect(calls.at(-1)?.[2]).toBeCloseTo(end, 6);
      const oscillator = context.of(FakeOscillator)[index];
      expect(oscillator?.started).toBeCloseTo(start, 6);
      expect(oscillator?.stopped).toBeCloseTo(end + 0.05, 6);
    });
  });

  it('уровни §3.1 в дБ: разрешение −7, Done −5, наведение −28; под речью (quiet) на 10 дБ тише', () => {
    const peak = (kind: CueSound, quiet = false) => {
      const { context, destination } = play(kind, 'soft', { quiet });
      return envelopes(context, destination)[0]?.gain.calls[1]?.[1] ?? 0;
    };
    expect(20 * Math.log10(peak('permission'))).toBeCloseTo(-7, 6);
    expect(20 * Math.log10(peak('done'))).toBeCloseTo(-5 - 2, 6);
    expect(20 * Math.log10(peak('hover'))).toBeCloseTo(-28, 6);
    expect(20 * Math.log10(peak('done', true))).toBeCloseTo(-5 - 2 - 10, 6);
  });

  it('S5: один рецепт в трёх палитрах — разные тоники', () => {
    const tonic = (palette: IslandPalette) => play('question', palette).context.of(FakeOscillator)[0]?.frequency.value;
    expect(tonic('soft')).toBeCloseTo(587.33, 2);
    expect(tonic('crystal')).toBeCloseTo(659.25, 2);
    expect(tonic('warm')).toBeCloseTo(392, 2);
  });

  it('S5: и разные тембры — синус с тихой октавой, FM-колокол с обертоном, треугольник с расстроенной пилой', () => {
    const soft = play('question', 'soft').context;
    expect(soft.of(FakeOscillator).map((node) => node.type)).toEqual(['custom', 'custom']);
    expect(soft.waves[0]?.imag).toEqual([0, 1, 0.12]);
    expect(soft.of(FakeFilter).map((node) => node.frequency.value)).toEqual([3_200, 3_200]);

    const crystal = play('question', 'crystal').context;
    const [carrier, modulator, shimmer] = crystal.of(FakeOscillator);
    expect(modulator?.frequency.value).toBeCloseTo((carrier?.frequency.value ?? 0) * 3.5, 6);
    expect(shimmer?.frequency.value).toBeCloseTo((carrier?.frequency.value ?? 0) * 2.76, 6);
    // Модулятор бьёт в частоту несущей, индекс гаснет за ноту.
    const index = crystal.of(FakeGain).find((node) => node.connections.includes(carrier?.frequency));
    expect(index?.gain.calls.map(([method]) => method)).toEqual(['setValueAtTime', 'exponentialRampToValueAtTime']);

    const warm = play('question', 'warm').context;
    const types = warm.of(FakeOscillator).map((node) => node.type);
    expect(types.slice(0, 3)).toEqual(['triangle', 'sawtooth', 'sawtooth']);
    expect(warm.of(FakeOscillator).slice(1, 3).map((node) => node.detune.value)).toEqual([-7, 7]);
    expect(warm.of(FakeFilter)[0]?.frequency.calls[1]?.[0]).toBe('exponentialRampToValueAtTime');

    const attack = (palette: IslandPalette) => PALETTES[palette].attack;
    expect(new Set(NAMES.map(attack)).size).toBe(3);
  });

  it('много нот — меньше слоёв: Done в «Тёплой» — пять треугольников, без пилы', () => {
    const { context } = play('done', 'warm');
    expect(context.of(FakeOscillator).map((node) => node.type)).toEqual(Array(5).fill('triangle'));
  });

  it('вопрос: последняя нота поднимается на 2 полутона во второй половине', () => {
    const { context } = play('question', 'soft');
    const [, last] = context.of(FakeOscillator);
    const [, startMs = 0, durationMs = 0] = CUE_RECIPES.question.notes?.[1] ?? [];
    const start = START + startMs / 1000;
    const from = last?.frequency.value ?? 0;
    expect(last?.frequency.calls).toEqual([
      ['setValueAtTime', from, start + (durationMs / 1000) * 0.45],
      ['exponentialRampToValueAtTime', from * 2 ** (2 / 12), start + durationMs / 1000],
    ]);
  });

  it('открыть: полосовой шум со свипом вверх, добротность полосы — от палитры', () => {
    for (const palette of NAMES) {
      const { context } = play('open', palette);
      const [source] = context.of(FakeBufferSource);
      expect(source?.buffer).not.toBeNull();
      const band = context.of(FakeFilter).find((node) => node.type === 'bandpass');
      expect(band?.Q.value).toBe(PALETTES[palette].noiseQ);
      const [from, to] = band?.frequency.calls ?? [];
      expect(from?.[1]).toBeLessThan(to?.[1] ?? 0);
    }
  });
});
