/**
 * Аудиограф окна острова (#9 §3.3–§3.4, §6.4; T1): один ленивый контекст, шины сигналов и голоса, общая громкость
 * v², компрессор, анализатор только на голосе, приглушение голоса, одно предупреждение при сбое. Синтез сигналов
 * подменён: его узлы проверяет `synth.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIslandSound, DEFAULT_ISLAND_VOLUME } from './graph.js';

const { playCue } = vi.hoisted(() => ({ playCue: vi.fn() }));
vi.mock('./synth.js', () => ({ playCue }));

type Call = [method: string, ...args: number[]];

class FakeParam {
  calls: Call[] = [];
  assigned: number[] = [];
  private current: number;
  constructor(value = 1) {
    this.current = value;
  }
  get value() {
    return this.current;
  }
  set value(next: number) {
    this.assigned.push(next);
    this.current = next;
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    this.calls.push(['setTargetAtTime', value, time, constant]);
  }
  cancelScheduledValues(time: number) {
    this.calls.push(['cancelScheduledValues', time]);
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

class FakeGain extends FakeNode {
  gain = new FakeParam();
  constructor() {
    super('gain');
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor() {
    super('analyser');
  }
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
  constructor() {
    super('compressor');
  }
}

class FakeContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 3;
  destination = new FakeNode('destination');
  nodes: FakeNode[] = [];
  resume = vi.fn(async () => undefined);
  private add<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.add(new FakeGain());
  }
  createAnalyser() {
    return this.add(new FakeAnalyser());
  }
  createDynamicsCompressor() {
    return this.add(new FakeCompressor());
  }
}

function setup(state: FakeContext['state'] = 'running') {
  const contexts: FakeContext[] = [];
  const sound = createIslandSound(() => {
    const context = new FakeContext();
    context.state = state;
    contexts.push(context);
    return context as unknown as AudioContext;
  });
  return { sound, contexts };
}

/** Узлы графа по их роли: шина сигналов — единственный усилитель, что идёт в общую громкость мимо анализатора. */
function parts(context: FakeContext) {
  const analyser = context.nodes.find((node) => node instanceof FakeAnalyser) as FakeAnalyser;
  const compressor = context.nodes.find((node) => node instanceof FakeCompressor) as FakeCompressor;
  const gains = context.nodes.filter((node): node is FakeGain => node instanceof FakeGain);
  const master = gains.find((node) => node.connections.includes(compressor)) as FakeGain;
  const voice = gains.find((node) => node.connections.includes(analyser)) as FakeGain;
  const cues = gains.find((node) => node !== master && node !== voice) as FakeGain;
  return { analyser, compressor, master, voice, cues };
}

beforeEach(() => {
  playCue.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createIslandSound: граф', () => {
  it('контекст ленивый и один на окно', () => {
    const { sound, contexts } = setup();
    expect(contexts).toHaveLength(0);
    const graph = sound.graph();
    sound.play('done');
    sound.play('hover');
    expect(contexts).toHaveLength(1);
    expect(sound.graph()).toBe(graph);
    expect(graph?.context).toBe(contexts[0]);
  });

  it('сигналы → общая громкость → компрессор (−14 дБ, 4:1) → выход', () => {
    const { sound, contexts } = setup();
    sound.play('permission');
    const context = contexts[0] as FakeContext;
    const { compressor, master, cues } = parts(context);
    expect(cues.connections).toEqual([master]);
    expect(master.connections).toEqual([compressor]);
    expect(compressor.connections).toEqual([context.destination]);
    expect(compressor.threshold.value).toBe(-14);
    expect(compressor.ratio.value).toBe(4);
    expect(playCue).toHaveBeenCalledWith(context, cues, 'permission', 'soft', {});
  });

  it('V1: анализатор (fftSize 2048) стоит только на шине голоса, сигналы идут мимо него', () => {
    const { sound, contexts } = setup();
    const graph = sound.graph();
    sound.play('question');
    const context = contexts[0] as FakeContext;
    const { analyser, master, voice, cues } = parts(context);
    expect(graph?.voice).toBe(voice);
    expect(graph?.analyser).toBe(analyser);
    expect(analyser.fftSize).toBe(2048);
    expect(voice.connections).toEqual([analyser]);
    expect(analyser.connections).toEqual([master]);
    expect(context.nodes.filter((node) => node.connections.includes(analyser))).toEqual([voice]);
    const [, destination] = playCue.mock.calls[0] as [unknown, unknown];
    expect(destination).toBe(cues);
    expect(destination).not.toBe(voice);
  });
});

describe('createIslandSound: громкость (S4)', () => {
  it('общая громкость при создании — v², по умолчанию 60 % ≈ 0,36', () => {
    const { sound, contexts } = setup();
    sound.graph();
    const { master } = parts(contexts[0] as FakeContext);
    expect(DEFAULT_ISLAND_VOLUME).toBe(0.6);
    expect(master.gain.value).toBeCloseTo(0.36, 6);
  });

  it('0 % до первого сигнала — контекст и узлы не создаются вовсе', () => {
    const { sound, contexts } = setup();
    sound.setVolume(0);
    sound.play('done');
    sound.play('permission');
    expect(contexts).toHaveLength(0);
    expect(playCue).not.toHaveBeenCalled();
  });

  it('0 % при живом графе — сигнал не создаёт ни одного узла', () => {
    const { sound, contexts } = setup();
    sound.graph();
    const context = contexts[0] as FakeContext;
    const before = context.nodes.length;
    sound.setVolume(0);
    sound.play('done');
    expect(playCue).not.toHaveBeenCalled();
    expect(context.nodes).toHaveLength(before);
  });

  it('ползунок меняет громкость через setTargetAtTime (v²), значение не прыгает', () => {
    const { sound, contexts } = setup();
    sound.graph();
    const { master } = parts(contexts[0] as FakeContext);
    const assigned = master.gain.assigned.length;
    sound.setVolume(0.5);
    sound.setVolume(1);
    expect(master.gain.calls).toEqual([
      ['setTargetAtTime', 0.25, 3, 0.03],
      ['setTargetAtTime', 1, 3, 0.03],
    ]);
    expect(master.gain.assigned).toHaveLength(assigned);
  });

  it('включение после 0 % играет тихий unmute — один раз; смена громкости без выключения — нет', () => {
    const { sound } = setup();
    sound.setVolume(0.8);
    expect(playCue).not.toHaveBeenCalled();
    sound.setVolume(0);
    sound.setVolume(0.4);
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(playCue.mock.calls[0]?.[2]).toBe('unmute');
    sound.setVolume(0.7);
    expect(playCue).toHaveBeenCalledTimes(1);
  });
});

describe('createIslandSound: палитра, речь, сбои', () => {
  it('палитра и «тише под речью» доходят до синтеза', () => {
    const { sound } = setup();
    sound.setPalette('crystal');
    sound.play('done', { quiet: true });
    expect(playCue.mock.calls[0]?.slice(2)).toEqual(['done', 'crystal', { quiet: true }]);
  });

  it('duckVoice: голос за 0,02 с опускается до 30 % и через 0,7 с возвращается', () => {
    const { sound, contexts } = setup();
    sound.graph();
    const { voice } = parts(contexts[0] as FakeContext);
    sound.duckVoice();
    expect(voice.gain.calls).toEqual([
      ['cancelScheduledValues', 3],
      ['setTargetAtTime', 0.3, 3, 0.02],
      ['setTargetAtTime', 1, 3.7, 0.15],
    ]);
  });

  it('duckVoice без графа ничего не создаёт: голоса ещё не было', () => {
    const { sound, contexts } = setup();
    sound.duckVoice();
    expect(contexts).toHaveLength(0);
  });

  it('усыплённый контекст будится resume()', () => {
    const { sound, contexts } = setup('suspended');
    sound.play('hover');
    expect(contexts[0]?.resume).toHaveBeenCalled();
  });

  it('контекст не создался — одно console.warn на окно, без исключений и без новых попыток', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    const sound = createIslandSound(() => {
      attempts += 1;
      throw new Error('no audio');
    });
    expect(() => sound.play('done')).not.toThrow();
    expect(sound.graph()).toBeNull();
    sound.play('permission');
    sound.setVolume(0.2);
    sound.duckVoice();
    expect(attempts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('сбой синтеза и отказ resume() — тоже одно предупреждение на окно', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sound, contexts } = setup('suspended');
    sound.graph();
    (contexts[0] as FakeContext).resume.mockRejectedValue(new Error('autoplay blocked'));
    playCue.mockImplementation(() => {
      throw new Error('bad node');
    });
    expect(() => sound.play('done')).not.toThrow();
    expect(() => sound.play('question')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
