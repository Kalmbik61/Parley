/** Облик роя: таблица «состояние → облик», приоритет ввода, мини-вид и ореол. */

import { describe, expect, it } from 'vitest';
import type { AssistantState } from '@parley/protocol';
import { HOST_IDLE } from '../assistant/store.js';
import { haloFor, swarmSpecFor } from './spec.js';

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
    expect(swarmSpecFor(host('idle'), 'idle', false)).toEqual({ shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false });
  });

  it('ввод важнее фазы: listening и transcribing — облако listen', () => {
    expect(swarmSpecFor(host('thinking'), 'listening', false)).toMatchObject({ shape: 'cloud', fx: 'listen', pal: 'amber' });
    expect(swarmSpecFor(host('error'), 'transcribing', false)).toMatchObject({ shape: 'cloud', fx: 'listen', pal: 'amber' });
  });

  it('мини: облако — точка, сфера остаётся сферой', () => {
    expect(swarmSpecFor(host('idle'), 'idle', true).shape).toBe('dot');
    expect(swarmSpecFor(host('thinking'), 'idle', true).shape).toBe('sphere');
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
