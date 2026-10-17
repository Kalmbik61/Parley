/**
 * Облик роя душ по состоянию помощника (спека 2026-10-14, раздел 9; эталон — одобренный макет island-mockup.html,
 * таблица `SPEC` и `specFor`). Чистые данные и функции без React и canvas: палитры, пятна облака, длительности
 * переходов и выбор облика по фазе хоста и фазе ввода. Лицо и эмоции (этап 3) сюда не входят.
 */

import type { AssistantState } from '@parley/protocol';
import type { InputPhase } from '../assistant/store.js';

export type SwarmPalette = 'amber' | 'coral' | 'gray';
export type SwarmShape = 'dot' | 'cloud' | 'sphere';
export type SwarmFx = 'listen' | 'ring' | 'flow' | 'arc' | null;

export interface SwarmSpec {
  shape: SwarmShape;
  fx: SwarmFx;
  pal: SwarmPalette;
  /** Скорость вращения сферы, рад/с (подтягивается плавно). */
  rot: number;
  /** Доля видимых душ 0..1. */
  vis: number;
  /** Масштаб времени. */
  ts: number;
  /** Множитель яркости. */
  dim: number;
  /** Сбой картинки на входе в состояние (280 мс). */
  glitch: boolean;
}

/**
 * Цвета душ: индекс 0 — основной (большинство), 1 — светлый (~25 %), 2 — второй (~10 %), 3 — янтарный для кольца
 * подтверждения. `halo` — `r,g,b` ореола за большим роем.
 */
export const PAL: Record<SwarmPalette, { colors: readonly [string, string, string, string]; halo: string }> = {
  amber: { colors: ['#EFB05C', '#F0DDA5', '#F48A64', '#FFC24D'], halo: '239,176,92' },
  coral: { colors: ['#DC604C', '#F8B287', '#C43F40', '#FFC24D'], halo: '220,96,76' },
  gray: { colors: ['#9C948A', '#C3BCB1', '#6F665F', '#9C948A'], halo: '156,148,138' },
};

/** Пятна облака: [cx, cy, sx, sy, вес] в долях `d`; последнее — «пыль» по всему облаку. */
export const BLOBS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [-0.34, -0.06, 0.2, 0.12, 1.2],
  [0.3, 0.08, 0.22, 0.13, 1],
  [0, 0.12, 0.26, 0.1, 1.3],
  [-0.05, -0.16, 0.15, 0.1, 0.8],
  [0.52, -0.1, 0.13, 0.09, 0.5],
  [-0.55, 0.1, 0.12, 0.1, 0.5],
  [0, 0, 0.5, 0.26, 0.8],
];

/** Длительность перехода облако ↔ сфера, с; точка считается облаком, одинаковая форма — 0,7 с (в движке). */
export const DUR: Record<'cloudsphere' | 'spherecloud', number> = { cloudsphere: 1.8, spherecloud: 1.5 };

const BASE: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false };

/** Облик по состоянию хоста и фазе ввода (таблица `SPEC` макета); в мини-виде облако рисуется точкой. */
export function swarmSpecFor(host: AssistantState, input: InputPhase, mini: boolean): SwarmSpec {
  let spec: SwarmSpec;
  if (input === 'listening' || input === 'transcribing') spec = { ...BASE, fx: 'listen' };
  else {
    switch (host.phase) {
      case 'thinking':
        spec = { ...BASE, shape: 'sphere' };
        break;
      case 'tool':
        spec = { ...BASE, shape: 'sphere', fx: 'arc', rot: 0.1 };
        break;
      case 'answering':
        spec = { ...BASE, shape: 'sphere', fx: 'flow', rot: 0.22 };
        break;
      case 'awaiting-confirm':
        spec = { ...BASE, shape: 'sphere', fx: 'ring', rot: 0 };
        break;
      case 'error':
        spec = { ...BASE, shape: 'sphere', pal: 'coral', rot: 0, glitch: true };
        break;
      case 'offline':
        spec = { ...BASE, pal: 'gray', vis: 0.45, ts: 0.12, dim: 0.8 };
        break;
      default:
        spec = { ...BASE };
    }
  }
  return mini && spec.shape === 'cloud' ? { ...spec, shape: 'dot' } : spec;
}

/** Ореол за большим роем: цвет палитры и прозрачность (подтверждение 0.32, нет связи 0.07, иначе 0.17). */
export function haloFor(spec: SwarmSpec, host: AssistantState): { rgb: string; alpha: number } {
  const alpha = host.phase === 'awaiting-confirm' ? 0.32 : host.phase === 'offline' ? 0.07 : 0.17;
  return { rgb: PAL[spec.pal].halo, alpha };
}
