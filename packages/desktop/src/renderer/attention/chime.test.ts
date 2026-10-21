/**
 * Свой сигнал «нужно действие» (спека застрявших 7.2): не чаще раза в 2 с, счётчик для E2E, WebAudio без падений.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHIME_MIN_GAP_MS, createChime } from './chime.js';

describe('createChime', () => {
  beforeEach(() => {
    (globalThis as { __parleyChimes?: number }).__parleyChimes = undefined;
  });

  it('два звонка за 1 с — один play', () => {
    let now = 10_000;
    const play = vi.fn();
    const chime = createChime({ now: () => now, play });
    chime.ring();
    now += 1_000;
    chime.ring();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('через CHIME_MIN_GAP_MS звонит снова', () => {
    let now = 10_000;
    const play = vi.fn();
    const chime = createChime({ now: () => now, play });
    chime.ring();
    now += CHIME_MIN_GAP_MS - 1;
    chime.ring();
    expect(play).toHaveBeenCalledTimes(1);
    now += 1;
    chime.ring();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('первый звонок на «нулевых» часах не глотается', () => {
    const play = vi.fn();
    createChime({ now: () => 0, play }).ring();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('каждый ring() увеличивает globalThis.__parleyChimes — это читает E2E', () => {
    let now = 10_000;
    const chime = createChime({ now: () => now, play: vi.fn() });
    chime.ring();
    expect((globalThis as { __parleyChimes?: number }).__parleyChimes).toBe(1);
    now += 5_000;
    chime.ring();
    expect((globalThis as { __parleyChimes?: number }).__parleyChimes).toBe(2);
  });
});

/** Подставной AudioContext: журнал осцилляторов и огибающих. */
function fakeAudio(state: 'running' | 'suspended' = 'running', resumeImpl: () => Promise<undefined> = async () => undefined) {
  const oscillators: Array<{
    type: string;
    frequency: { value: number };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }> = [];
  const gains: Array<{
    gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
  }> = [];
  const resume = vi.fn(resumeImpl);
  const instances: unknown[] = [];
  class FakeContext {
    state = state;
    currentTime = 5;
    destination = {};
    resume = resume;
    constructor() {
      instances.push(this);
    }
    createOscillator() {
      const node = { type: 'square', frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn() };
      oscillators.push(node);
      return node;
    }
    createGain() {
      const node = {
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
      gains.push(node);
      return node;
    }
  }
  return { FakeContext, oscillators, gains, resume, instances };
}

describe('playChimeTone', () => {
  const original = (globalThis as { AudioContext?: unknown }).AudioContext;
  afterEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = original;
    vi.restoreAllMocks();
  });

  it('два синуса 880 и 1320 Гц по 0,12 с, громкость 0,2: атака 0,02 с и спад 0,1 с', async () => {
    // Свежий модуль: контекст создаётся лениво и живёт в модуле, а предыдущий тест мог его завести.
    vi.resetModules();
    const audio = fakeAudio();
    (globalThis as { AudioContext?: unknown }).AudioContext = audio.FakeContext;
    const fresh = await import('./chime.js');
    fresh.playChimeTone();
    expect(audio.oscillators.map((node) => [node.type, node.frequency.value])).toEqual([
      ['sine', 880],
      ['sine', 1320],
    ]);
    for (const node of audio.oscillators) {
      const [from] = node.start.mock.calls[0] as [number];
      expect(node.stop).toHaveBeenCalledWith(from + 0.12);
    }
    for (const node of audio.gains) {
      const [, start] = node.gain.setValueAtTime.mock.calls[0] as [number, number];
      expect(node.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.2, start + 0.02);
      expect(node.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0, start + 0.12);
    }
  });

  it('один AudioContext на окно; suspended — resume()', async () => {
    vi.resetModules();
    const audio = fakeAudio('suspended');
    (globalThis as { AudioContext?: unknown }).AudioContext = audio.FakeContext;
    const fresh = await import('./chime.js');
    fresh.playChimeTone();
    fresh.playChimeTone();
    expect(audio.instances).toHaveLength(1);
    expect(audio.resume).toHaveBeenCalled();
  });

  it('resume() отказал — один console.warn на окно, а не молчание и не по предупреждению на каждый сигнал', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const audio = fakeAudio('suspended', async () => {
      throw new Error('autoplay blocked');
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = audio.FakeContext;
    const fresh = await import('./chime.js');
    expect(() => fresh.playChimeTone()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    fresh.playChimeTone();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ошибка WebAudio — один console.warn и никакого исключения', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        throw new Error('no audio');
      }
    };
    const fresh = await import('./chime.js');
    expect(() => fresh.playChimeTone()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
