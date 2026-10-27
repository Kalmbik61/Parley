/**
 * Проигрыватель речи (план 3b B14; план 3 Task 5 на кусках f32): куски встык на шине голоса общего графа острова,
 * мгновенная остановка, сброс сорвавшейся попытки, рот и данные анализатора для лица. Контекст подменён: анализатор
 * фейка слышит только те источники, у которых путь соединений доходит до него, — так V1 проверяется на настоящем графе
 * B07.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createIslandSound, type IslandAudioGraph } from '../sound/graph.js';
import { createSpeaker } from './speaker.js';

const { playCue } = vi.hoisted(() => ({ playCue: vi.fn() }));
vi.mock('../sound/synth.js', () => ({ playCue }));

class FakeParam {
  constructor(public value = 1) {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}

class FakeNode {
  connections: FakeNode[] = [];
  constructor(readonly context: FakeContext) {}
  connect(target: FakeNode) {
    this.connections.push(target);
    return target;
  }
  reaches(target: FakeNode): boolean {
    return this.connections.some((next) => next === target || next.reaches(target));
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData() {
    return this.data;
  }
}

abstract class FakeSource extends FakeNode {
  startedAt: number | null = null;
  stopCalls: unknown[][] = [];
  ended = false;
  onended: (() => void) | null = null;
  start(when = 0) {
    this.startedAt = when;
  }
  stop(...args: unknown[]) {
    this.stopCalls.push(args);
  }
  /** Тест сам решает, когда источник доиграл. */
  end() {
    this.ended = true;
    this.onended?.();
  }
  playing(): boolean {
    return this.startedAt !== null && this.startedAt <= this.context.currentTime && !this.ended && this.stopCalls.length === 0;
  }
  abstract sample(index: number): number;
}

class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  sample(index: number) {
    const data = this.buffer?.data;
    return data && data.length > 0 ? (data[index % data.length] ?? 0) : 0;
  }
}

class FakeOscillator extends FakeSource {
  frequency = new FakeParam(440);
  sample() {
    return 0.5;
  }
}

/** Анализатор фейка: сумма звучащих источников, чей путь доходит до него. */
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  private signal(index: number): number {
    return this.context.sources
      .filter((source) => source.playing() && source.reaches(this))
      .reduce((sum, source) => sum + source.sample(index), 0);
  }
  getFloatTimeDomainData(array: Float32Array) {
    for (let index = 0; index < array.length; index += 1) array[index] = this.signal(index);
  }
  getFloatFrequencyData(array: Float32Array) {
    for (let index = 0; index < array.length; index += 1) array[index] = 20 * Math.log10(Math.abs(this.signal(index)) + 1e-9);
  }
}

class FakeContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 10;
  sampleRate = 48_000;
  destination = new FakeNode(this);
  sources: FakeSource[] = [];
  resume = vi.fn(async () => undefined);
  createGain() {
    return new FakeGain(this);
  }
  createAnalyser() {
    return new FakeAnalyser(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    // Как в браузере: частота вне 3000…768000 Гц — NotSupportedError.
    if (sampleRate < 3000 || sampleRate > 768_000) throw new Error('NotSupportedError');
    return new FakeBuffer(length, sampleRate);
  }
  createBufferSource() {
    const source = new FakeBufferSource(this);
    this.sources.push(source);
    return source;
  }
  createOscillator() {
    const source = new FakeOscillator(this);
    this.sources.push(source);
    return source;
  }
}

function chunk(utteranceId: string, seq: number, { seconds = 0.5, level = 0.1, sampleRate = 24_000 } = {}) {
  return { utteranceId, seq, sampleRate, pcm: new Float32Array(Math.round(seconds * sampleRate)).fill(level) };
}

/** Маленький граф: шина голоса → анализатор → выход, как голосовая ветка B07. */
function setup() {
  const context = new FakeContext();
  const voice = context.createGain();
  const analyser = context.createAnalyser();
  voice.connect(analyser);
  analyser.connect(context.destination);
  let now = 0;
  const graph = { context, voice, analyser } as unknown as IslandAudioGraph;
  const speaker = createSpeaker({ graph: () => graph, now: () => now });
  const sources = () => context.sources as FakeBufferSource[];
  return {
    context,
    voice,
    analyser,
    speaker,
    sources,
    setNow(next: number) {
      now = next;
    },
  };
}

beforeEach(() => {
  playCue.mockReset();
});

describe('createSpeaker: куски встык', () => {
  it('куски одного utteranceId встают встык: второй начинается ровно в конце первого (E1)', () => {
    const { speaker, sources } = setup();
    speaker.enqueue(chunk('u1', 0, { seconds: 0.5 }));
    speaker.enqueue(chunk('u1', 1, { seconds: 0.25 }));
    speaker.enqueue(chunk('u1', 2, { seconds: 0.5 }));
    expect(sources().map((source) => source.startedAt)).toEqual([10, 10.5, 10.75]);
    expect(speaker.speaking()).toBe(true);
  });

  it('AudioBuffer строится с sampleRate куска из его отсчётов, источник идёт в шину голоса', () => {
    const { speaker, sources, voice } = setup();
    const piece = chunk('u1', 0, { seconds: 0.1, sampleRate: 22_050, level: 0.3 });
    speaker.enqueue(piece);
    const [source] = sources();
    expect(source?.buffer?.sampleRate).toBe(22_050);
    expect(source?.buffer?.data).toEqual(piece.pcm);
    expect(source?.connections).toEqual([voice]);
  });

  it('кусок после того, как очередь доиграла, начинается с currentTime', () => {
    const { speaker, sources, context } = setup();
    speaker.enqueue(chunk('u1', 0));
    sources()[0]?.end();
    context.currentTime = 12;
    speaker.enqueue(chunk('u2', 0));
    expect(sources()[1]?.startedAt).toBe(12);
  });

  it('кусок, который Web Audio не принял, пропускается, следующий играет', () => {
    const { speaker, sources } = setup();
    expect(() => speaker.enqueue(chunk('u1', 0, { sampleRate: 1000 }))).not.toThrow();
    speaker.enqueue(chunk('u1', 1));
    expect(sources()).toHaveLength(1);
    expect(sources()[0]?.startedAt).toBe(10);
  });

  it('пустой кусок (final без звука) источника не создаёт', () => {
    const { speaker, sources } = setup();
    speaker.enqueue({ utteranceId: 'u1', seq: 0, sampleRate: 24_000, pcm: new Float32Array(0) });
    expect(sources()).toHaveLength(0);
    expect(speaker.speaking()).toBe(false);
  });

  it('без Web Audio куски молча пропускаются', () => {
    const speaker = createSpeaker({ graph: () => null, now: () => 0 });
    expect(() => speaker.enqueue(chunk('u1', 0))).not.toThrow();
    expect(speaker.speaking()).toBe(false);
    expect(speaker.mouth()).toBe(0);
  });
});

describe('createSpeaker: stop (E3)', () => {
  it('stop() глушит все источники в тот же такт, очередь пуста, speaking() — false', () => {
    const { speaker, sources } = setup();
    speaker.enqueue(chunk('u1', 0));
    speaker.enqueue(chunk('u1', 1));
    speaker.stop();
    expect(sources().map((source) => source.stopCalls)).toEqual([[[]], [[]]]);
    expect(speaker.speaking()).toBe(false);
    expect(speaker.mouth()).toBe(0);
  });

  it('после stop() нет новых источников: опоздавшие куски остановленного предложения не играют', () => {
    const { speaker, sources } = setup();
    speaker.enqueue(chunk('u1', 0));
    speaker.stop();
    speaker.enqueue(chunk('u1', 1));
    expect(sources()).toHaveLength(1);
    expect(speaker.speaking()).toBe(false);
    speaker.enqueue(chunk('u2', 0));
    expect(sources()).toHaveLength(2);
    expect(sources()[1]?.startedAt).toBe(10);
  });

  it('stop() не зовёт onIdle', () => {
    const { speaker } = setup();
    const idle = vi.fn();
    speaker.onIdle(idle);
    speaker.enqueue(chunk('u1', 0));
    speaker.stop();
    expect(idle).not.toHaveBeenCalled();
  });
});

describe('createSpeaker: onIdle и onStart', () => {
  it('onIdle зовётся один раз после ended последнего источника', () => {
    const { speaker, sources } = setup();
    const idle = vi.fn();
    speaker.onIdle(idle);
    speaker.enqueue(chunk('u1', 0));
    speaker.enqueue(chunk('u1', 1));
    sources()[0]?.end();
    expect(idle).not.toHaveBeenCalled();
    expect(speaker.speaking()).toBe(true);
    sources()[1]?.end();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(speaker.speaking()).toBe(false);
  });

  it('отписка от onIdle и onStart работает', () => {
    const { speaker, sources } = setup();
    const idle = vi.fn();
    const start = vi.fn();
    speaker.onIdle(idle)();
    speaker.onStart(start)();
    speaker.enqueue(chunk('u1', 0));
    sources()[0]?.end();
    expect(idle).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('onStart зовётся один раз на первом куске каждого utteranceId, когда тот начинает звучать', () => {
    const { speaker, sources } = setup();
    const start = vi.fn();
    speaker.onStart(start);
    speaker.enqueue(chunk('u1', 0));
    speaker.enqueue(chunk('u1', 1));
    speaker.enqueue(chunk('u2', 0));
    speaker.enqueue(chunk('u2', 1));
    expect(start.mock.calls).toEqual([['u1']]);
    sources()[0]?.end();
    expect(start.mock.calls).toEqual([['u1']]);
    sources()[1]?.end();
    expect(start.mock.calls).toEqual([['u1'], ['u2']]);
    sources()[2]?.end();
    sources()[3]?.end();
    expect(start.mock.calls).toEqual([['u1'], ['u2']]);
  });
});

describe('createSpeaker: discard (сорвавшаяся попытка)', () => {
  it('куски попытки с seq ≥ fromSeq глушатся, ранние играют, следующий кусок встаёт в конец последнего оставленного', () => {
    const { speaker, sources, context } = setup();
    speaker.enqueue(chunk('u0', 4, { seconds: 0.5 }));
    speaker.enqueue(chunk('u1', 0, { seconds: 0.5 }));
    speaker.enqueue(chunk('u1', 1, { seconds: 0.5 }));
    speaker.enqueue(chunk('u1', 2, { seconds: 0.5 }));
    context.currentTime = 10.2;
    speaker.discard('u1', 1);
    expect(sources().map((source) => source.stopCalls.length)).toEqual([0, 0, 1, 1]);
    speaker.enqueue(chunk('u1', 3, { seconds: 0.5 }));
    expect(sources()[4]?.startedAt).toBe(11);
    expect(speaker.speaking()).toBe(true);
  });

  it('если оставленное уже доиграло, повтор начинается с currentTime', () => {
    const { speaker, sources, context } = setup();
    speaker.enqueue(chunk('u1', 0, { seconds: 0.5 }));
    speaker.enqueue(chunk('u1', 1, { seconds: 0.5 }));
    context.currentTime = 10.8;
    speaker.discard('u1', 1);
    speaker.enqueue(chunk('u1', 2));
    expect(sources()[2]?.startedAt).toBe(10.8);
  });

  it('заглушённые куски не зовут onIdle и onStart; повтор доигрывает, и тогда onIdle', () => {
    const { speaker, sources } = setup();
    const idle = vi.fn();
    const start = vi.fn();
    speaker.onIdle(idle);
    speaker.onStart(start);
    speaker.enqueue(chunk('u1', 0));
    speaker.enqueue(chunk('u1', 1));
    speaker.discard('u1', 0);
    sources()[0]?.end();
    sources()[1]?.end();
    expect(idle).not.toHaveBeenCalled();
    speaker.enqueue(chunk('u1', 2));
    expect(start.mock.calls).toEqual([['u1']]);
    sources()[2]?.end();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});

describe('createSpeaker: рот', () => {
  it('rms 0,27 → 1, rms 0,02 → 0', () => {
    const loud = setup();
    loud.speaker.enqueue(chunk('u1', 0, { level: 0.27 }));
    expect(loud.speaker.mouth()).toBe(1);
    const quiet = setup();
    quiet.speaker.enqueue(chunk('u1', 0, { level: 0.02 }));
    expect(quiet.speaker.mouth()).toBe(0);
  });

  it('атака мгновенная, спад за 80 мс до 0', () => {
    const { speaker, sources, setNow } = setup();
    speaker.enqueue(chunk('u1', 0, { level: 0.27 }));
    expect(speaker.mouth()).toBe(1);
    sources()[0]?.buffer?.data.fill(0);
    setNow(40);
    expect(speaker.mouth()).toBeCloseTo(0.5);
    setNow(80);
    expect(speaker.mouth()).toBe(0);
    sources()[0]?.buffer?.data.fill(0.27);
    setNow(81);
    expect(speaker.mouth()).toBe(1);
  });

  it('рот считается по последним 512 отсчётам анализатора', () => {
    const pcm = new Float32Array(2048);
    const tail = setup();
    tail.speaker.enqueue({ utteranceId: 'u1', seq: 0, sampleRate: 24_000, pcm: pcm.map((_, index) => (index >= 1536 ? 0.27 : 0)) });
    expect(tail.speaker.mouth()).toBe(1);
    const head = setup();
    head.speaker.enqueue({ utteranceId: 'u1', seq: 0, sampleRate: 24_000, pcm: pcm.map((_, index) => (index < 1536 ? 0.27 : 0)) });
    expect(head.speaker.mouth()).toBe(0);
  });

  it('mouth() = 0, когда голос молчит', () => {
    const { speaker, sources } = setup();
    expect(speaker.mouth()).toBe(0);
    speaker.enqueue(chunk('u1', 0, { level: 0.27 }));
    expect(speaker.mouth()).toBe(1);
    sources()[0]?.end();
    expect(speaker.mouth()).toBe(0);
  });
});

describe('createSpeaker: read для лица', () => {
  it('read даёт false и не трогает массивы, когда голос молчит', () => {
    const { speaker, sources } = setup();
    const time = new Float32Array(2048).fill(7);
    const freq = new Float32Array(1024).fill(7);
    expect(speaker.read(time, freq)).toBe(false);
    speaker.enqueue(chunk('u1', 0));
    sources()[0]?.end();
    expect(speaker.read(time, freq)).toBe(false);
    expect(time.every((value) => value === 7)).toBe(true);
    expect(freq.every((value) => value === 7)).toBe(true);
  });

  it('пока голос звучит, read заполняет время и спектр анализатора и даёт true', () => {
    const { speaker } = setup();
    speaker.enqueue(chunk('u1', 0, { level: 0.25 }));
    const time = new Float32Array(2048);
    const freq = new Float32Array(1024);
    expect(speaker.read(time, freq)).toBe(true);
    expect(time.every((value) => value === 0.25)).toBe(true);
    expect(freq[0]).toBeCloseTo(20 * Math.log10(0.25));
  });
});

describe('createSpeaker: V1 на графе острова', () => {
  function islandSetup() {
    const context = new FakeContext();
    const sound = createIslandSound(() => context as unknown as AudioContext);
    playCue.mockImplementation((ctx: FakeContext, destination: FakeNode) => {
      const oscillator = ctx.createOscillator();
      oscillator.connect(destination);
      oscillator.start(ctx.currentTime);
    });
    const speaker = createSpeaker({ graph: () => sound.graph(), now: () => 0 });
    return { context, sound, speaker };
  }

  it('сигнал на шине сигналов не меняет mouth() и данные read', () => {
    const { context, sound, speaker } = islandSetup();
    speaker.enqueue(chunk('u1', 0, { level: 0.1 }));
    const before = { time: new Float32Array(2048), freq: new Float32Array(1024) };
    expect(speaker.read(before.time, before.freq)).toBe(true);
    const mouth = speaker.mouth();
    sound.play('permission');
    expect(context.sources.filter((source) => source.playing())).toHaveLength(2);
    const after = { time: new Float32Array(2048), freq: new Float32Array(1024) };
    expect(speaker.read(after.time, after.freq)).toBe(true);
    expect(after).toEqual(before);
    expect(speaker.mouth()).toBe(mouth);
  });

  it('один сигнал без голоса: read — false, рот закрыт', () => {
    const { sound, speaker } = islandSetup();
    sound.play('done');
    expect(speaker.read(new Float32Array(2048), new Float32Array(1024))).toBe(false);
    expect(speaker.mouth()).toBe(0);
  });
});
