/** Облик роя: таблица «состояние → облик», приоритет ввода, мини-вид и ореол. */

import { describe, expect, it } from 'vitest';
import type { AssistantState } from '@parley/protocol';
import { HOST_IDLE } from '../assistant/store.js';
import { createSwarm } from './engine.js';
import { EMO, haloFor, swarmSpecFor } from './spec.js';

const host = (phase: AssistantState['phase']): AssistantState => ({ ...HOST_IDLE, phase });

describe('swarmSpecFor', () => {
  it('thinking — сфера', () => {
    expect(swarmSpecFor(host('thinking'), 'idle', false)).toMatchObject({ shape: 'sphere', fx: null, pal: 'amber' });
  });

  it('tool — сфера с дугой', () => {
    expect(swarmSpecFor(host('tool'), 'idle', false)).toMatchObject({ shape: 'sphere', fx: 'arc', rot: 0.1 });
  });

  it('answering — сфера с потоком', () => {
    expect(swarmSpecFor(host('answering'), 'idle', false)).toMatchObject({ shape: 'sphere', fx: 'flow', rot: 0.22 });
  });

  it('awaiting-confirm — сфера с кольцом', () => {
    expect(swarmSpecFor(host('awaiting-confirm'), 'idle', false)).toMatchObject({ shape: 'sphere', fx: 'ring', rot: 0 });
  });

  it('error — коралловая сфера со сбоем', () => {
    expect(swarmSpecFor(host('error'), 'idle', false)).toMatchObject({ shape: 'sphere', pal: 'coral', glitch: true });
  });

  it('offline — серое тусклое облако', () => {
    expect(swarmSpecFor(host('offline'), 'idle', false)).toMatchObject({ shape: 'cloud', pal: 'gray', vis: 0.45, ts: 0.12, dim: 0.8 });
  });

  it('idle — янтарное облако с умолчаниями', () => {
    expect(swarmSpecFor(host('idle'), 'idle', false)).toEqual({ shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false, emo: null });
  });

  it('ввод важнее фазы: listening и transcribing — облако listen', () => {
    expect(swarmSpecFor(host('thinking'), 'listening', false)).toMatchObject({ shape: 'cloud', fx: 'listen', pal: 'amber' });
    expect(swarmSpecFor(host('error'), 'transcribing', false)).toMatchObject({ shape: 'cloud', fx: 'listen', pal: 'amber' });
  });

  it('мини: облако — точка, сфера остаётся сферой', () => {
    expect(swarmSpecFor(host('idle'), 'idle', true).shape).toBe('dot');
    expect(swarmSpecFor(host('thinking'), 'idle', true).shape).toBe('sphere');
  });

  it('speaking — лицо с эмоцией хоста, янтарь', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false)).toMatchObject({ shape: 'face', emo: 'joy', pal: 'amber', dim: 1 });
  });

  it('speaking: anger и error — коралл; dim из таблицы EMO (sad 0.78)', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'anger' }, 'speaking', false)).toMatchObject({ shape: 'face', emo: 'anger', pal: 'coral' });
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'error' }, 'speaking', false)).toMatchObject({ shape: 'face', emo: 'error', pal: 'coral' });
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'sad' }, 'speaking', false)).toMatchObject({ shape: 'face', pal: 'amber', dim: EMO.sad.dim });
    expect(EMO.sad.dim).toBe(0.78);
  });

  it('settling — сфера rot 0.3 без эмоции', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'settling', false)).toMatchObject({ shape: 'sphere', fx: null, pal: 'amber', rot: 0.3, emo: null });
  });

  it('мини при речи — сфера без эмоции, палитра лица сохраняется', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', true)).toMatchObject({ shape: 'sphere', emo: null, pal: 'amber' });
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'anger' }, 'speaking', true)).toMatchObject({ shape: 'sphere', emo: null, pal: 'coral' });
  });

  it('offline хоста важнее речи', () => {
    expect(swarmSpecFor({ ...host('offline'), mood: 'joy' }, 'speaking', false)).toMatchObject({ shape: 'cloud', pal: 'gray', emo: null });
  });
});

describe('swarmSpecFor: эмоция предложения (L3, F3)', () => {
  it('sentenceMood важнее эмоции хода: sad при host.mood joy', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false, 'sad')).toMatchObject({ shape: 'face', emo: 'sad', pal: 'amber', dim: EMO.sad.dim });
  });

  it('палитра — по эмоции предложения: anger — коралл и в мини-виде', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'calm' }, 'speaking', false, 'anger')).toMatchObject({ emo: 'anger', pal: 'coral' });
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'calm' }, 'speaking', true, 'anger')).toMatchObject({ shape: 'sphere', emo: null, pal: 'coral' });
  });

  it('без sentenceMood — эмоция хода', () => {
    expect(swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false, undefined)).toMatchObject({ emo: 'joy' });
  });

  it('sentenceMood вне речи облик не меняет', () => {
    expect(swarmSpecFor(host('answering'), 'idle', false, 'sad')).toEqual(swarmSpecFor(host('answering'), 'idle', false));
  });

  it('смена эмоции предложения в лице — переход 0,6 с; при reduced motion — без перехода', () => {
    const joy = swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false, 'joy');
    const sad = swarmSpecFor({ ...HOST_IDLE, mood: 'joy' }, 'speaking', false, 'sad');
    const engine = createSwarm(120, { width: 200, height: 200, d: 100, cy: 100, seed: 7 });
    engine.setSpec(joy, 0, false);
    engine.setSpec(sad, 5000, false);
    expect(engine.debug.dur).toBe(0.6);
    engine.frame(5016, null, false, 0);
    expect(engine.needsFrame()).toBe(true);
    const still = createSwarm(120, { width: 200, height: 200, d: 100, cy: 100, seed: 7 });
    still.setSpec(joy, 0, true);
    still.setSpec(sad, 5000, true);
    still.frame(5016, null, true, 0);
    expect(still.needsFrame()).toBe(false);
  });
});

describe('haloFor', () => {
  it('прозрачность: confirm 0.32, offline 0.07, иначе 0.17; цвет — из палитры', () => {
    const confirm = host('awaiting-confirm');
    expect(haloFor(swarmSpecFor(confirm, 'idle', false), confirm)).toEqual({ rgb: '239,176,92', alpha: 0.32 });
    const offline = host('offline');
    expect(haloFor(swarmSpecFor(offline, 'idle', false), offline)).toEqual({ rgb: '156,148,138', alpha: 0.07 });
    const error = host('error');
    expect(haloFor(swarmSpecFor(error, 'idle', false), error)).toEqual({ rgb: '220,96,76', alpha: 0.17 });
  });
});
