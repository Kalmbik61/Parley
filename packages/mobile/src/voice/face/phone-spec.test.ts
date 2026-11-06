import { describe, expect, it } from 'vitest';
import { EMO, swarmSpecFor, type SwarmEmotion, type SwarmLive } from '@parley/core/swarm';
import { phoneSwarmSpec } from './phone-spec.js';

const idle: SwarmLive = { phase: 'idle', humanSpeaking: false, modelPlaying: false, checking: false, emotion: 'calm' };
const online = (live: Partial<SwarmLive>) => phoneSwarmSpec({ link: 'online', live: { ...idle, ...live } });
const EMOTIONS = Object.keys(EMO) as SwarmEmotion[];

describe('phoneSwarmSpec', () => {
  it('нет связи с Mac: облик offline острова', () => {
    const spec = phoneSwarmSpec({ link: 'offline', live: { ...idle, phase: 'live', modelPlaying: true } });
    expect(spec).toEqual(swarmSpecFor({ phase: 'offline', mood: 'calm' }, 'idle', false));
    expect(spec.pal).toBe('gray');
  });

  it('Live не идёт: спокойная сфера', () => {
    expect(online({})).toMatchObject({ shape: 'sphere', fx: null, pal: 'amber', emo: null });
  });

  it('подключение и закрытие: сфера', () => {
    for (const phase of ['connecting', 'closing'] as const) expect(online({ phase })).toMatchObject({ shape: 'sphere', fx: null });
  });

  it('говорит человек: облако слушания', () => {
    expect(online({ phase: 'live', humanSpeaking: true })).toMatchObject({ shape: 'cloud', fx: 'listen' });
  });

  it('проверяю: сфера с дугой', () => {
    expect(online({ phase: 'live', checking: true })).toMatchObject({ shape: 'sphere', fx: 'arc' });
  });

  it.each(EMOTIONS.filter((e) => e !== 'error'))('модель говорит, эмоция %s: сфера с палитрой и dim эмоции', (emotion) => {
    const spec = online({ phase: 'live', modelPlaying: true, emotion });
    expect(spec).toMatchObject({ shape: 'sphere', emo: null, pal: 'amber', dim: EMO[emotion].dim ?? 1 });
  });

  it('ошибка: коралловая сфера, даже если модель молчит', () => {
    for (const modelPlaying of [true, false]) {
      expect(online({ phase: 'live', modelPlaying, emotion: 'error' })).toMatchObject({ shape: 'sphere', emo: null, pal: 'coral' });
    }
  });

  it('лица нет ни в одном состоянии', () => {
    for (const emotion of EMOTIONS) {
      for (const modelPlaying of [true, false]) {
        expect(online({ phase: 'live', modelPlaying, emotion }).shape).not.toBe('face');
      }
    }
  });
});
