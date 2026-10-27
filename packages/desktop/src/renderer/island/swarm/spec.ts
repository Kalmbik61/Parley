/**
 * Облик роя душ по состоянию помощника (спека 2026-10-14, раздел 9; эталон — одобренный макет island-mockup.html,
 * таблицы `SPEC`, `EMO`, `DUR` и `specFor`). Чистые данные и функции без React и canvas: палитры, пятна облака,
 * силуэты лица по эмоциям, длительности переходов и выбор облика по фазе хоста и фазе ввода.
 */

import type { AssistantState } from '@parley/protocol';
import type { InputPhase } from '../assistant/store.js';

export type SwarmPalette = 'amber' | 'coral' | 'gray';
export type SwarmShape = 'dot' | 'cloud' | 'sphere' | 'face';
export type SwarmFx = 'listen' | 'ring' | 'flow' | 'arc' | null;
/** Эмоция лица — та же, что метка ответа хоста. */
export type SwarmEmotion = AssistantState['mood'];
/** Фаза ввода для облика: речь (`speaking`) и пауза после неё (`settling`) живут в острове, в `InputPhase`. */
export type SwarmInput = InputPhase;

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
  /** Эмоция лица; только у формы `face`, иначе `null`. */
  emo: SwarmEmotion | null;
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

/**
 * Длительность перехода между формами, с; точка считается облаком. Одинаковая форма — 0,7 с, смена эмоции внутри
 * лица — 0,6 с (в движке).
 */
export const DUR: Record<'cloudsphere' | 'spherecloud' | 'sphereface' | 'facesphere' | 'cloudface' | 'facecloud', number> = {
  cloudsphere: 1.8,
  spherecloud: 1.5,
  sphereface: 0.8,
  facesphere: 0.8,
  cloudface: 1.4,
  facecloud: 1.2,
};

/**
 * Силуэт лица в долях `d`. Глаз: `a`, `b` — полуоси, `ey` — высота над центром; `cut` — линия века [база, наклон];
 * `dome` — плоский низ; `x` — глаз крестиком длины `len`. Рот: `mw` — ширина, `H0`..`H1` — высота от закрытого до
 * открытого, `pw` — сужение к краям, `curl` — изгиб, `mo` — овал, `wave` — волна. `nb` — без моргания, `dim` — яркость.
 */
export interface FaceSpec {
  a?: number;
  b?: number;
  ey: number;
  mw: number;
  H0: number;
  H1: number;
  pw?: number;
  curl?: number;
  cut?: readonly [number, number];
  dome?: boolean;
  mo?: boolean;
  x?: boolean;
  len?: number;
  wave?: boolean;
  nb?: boolean;
  dim?: number;
}

/**
 * Таблица эмоций лица — из макета; sad и anger смягчены (B26 F-B26-2, s-28 m-1505, #9 §6.7 L3 «Мера эмоций»): веко
 * прикрывает глаз меньше и наклонено слабее, рот sad — пологая дуга, anger — почти прямая, sad почти не тускнеет.
 */
export const EMO: Record<SwarmEmotion, FaceSpec> = {
  calm: { a: 0.095, b: 0.13, ey: 0.28, mw: 0.78, curl: 0.07, H0: 0.1, H1: 0.24, pw: 0.6 },
  joy: { a: 0.115, b: 0.1, dome: true, ey: 0.28, mw: 1.04, curl: 0.18, H0: 0.14, H1: 0.3, pw: 0.55 },
  sad: { a: 0.095, b: 0.125, cut: [-0.3, 0.5], ey: 0.275, mw: 0.75, curl: -0.06, H0: 0.09, H1: 0.19, pw: 0.65, dim: 0.92 },
  surprise: { a: 0.11, b: 0.16, ey: 0.31, mo: true, mw: 0.4, H0: 0.3, H1: 0.4, nb: true },
  anger: { a: 0.1, b: 0.1, cut: [-0.25, -0.5], ey: 0.275, mw: 0.68, curl: -0.03, H0: 0.12, H1: 0.24, pw: 0.45 },
  error: { x: true, len: 0.1, ey: 0.28, mw: 0.86, curl: 0, wave: true, H0: 0.05, H1: 0.05, pw: 0.1, nb: true },
};

/**
 * Одноразовая реакция роя поверх облика фазы (#9 §4.1): вдох, кольцо яркости, подскок, кивок, оборот, дрожь, наклон
 * к курсору. В малом рое реакции со сдвигом, в лице и при уменьшенном движении — любые реакции движок заменяет
 * вспышкой яркости 300 мс (#9 §4.3, §4.5, V3).
 */
export type SwarmReaction = 'breathe' | 'glint' | 'hop' | 'nod' | 'spin' | 'shake' | 'lean';

/**
 * Событие, на которое отвечает рой (#9 §4.1). Согласие и терминал отвечают как `permission`, предложение комнаты —
 * как `question`.
 */
export type SwarmEvent = 'start' | 'tool' | 'permission' | 'question' | 'plan' | 'done' | 'error' | 'hover';

/** Событие → реакция (#9 §4.1): шаги — только яркость, запросы — движение, Done — самое длинное движение. */
export const REACTION_FOR: Readonly<Record<SwarmEvent, SwarmReaction>> = {
  start: 'breathe',
  tool: 'glint',
  permission: 'hop',
  question: 'nod',
  plan: 'hop',
  done: 'spin',
  error: 'shake',
  hover: 'lean',
};

/**
 * Проп `pulse` у `<Swarm>`: реакция и время события по `performance.now()`, мс. Новое `at` — новая реакция; то же
 * `at` повторно ничего не меняет, а реакция, чьё время уже вышло (рой смонтирован позже), кадров не добавляет.
 */
export interface SwarmPulse {
  reaction: SwarmReaction;
  at: number;
}

const BASE: SwarmSpec = { shape: 'cloud', fx: null, pal: 'amber', rot: 0.35, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };

/**
 * Облик по состоянию хоста и фазе ввода (таблица `SPEC` и `specFor` макета). Приоритет: слушание, затем `offline`
 * хоста, затем речь, затем фаза хоста. Речь — лицо с эмоцией звучащего предложения (`sentenceMood`, #9 §6.7 L3), а
 * без неё — с эмоцией хода; в мини-виде лица нет — сфера с палитрой лица. В мини-виде облако рисуется точкой.
 */
export function swarmSpecFor(host: AssistantState, input: SwarmInput, mini: boolean, sentenceMood?: SwarmEmotion): SwarmSpec {
  let spec: SwarmSpec;
  if (input === 'listening' || input === 'transcribing') spec = { ...BASE, fx: 'listen' };
  else if (host.phase !== 'offline' && input === 'speaking') {
    const emo = sentenceMood ?? host.mood;
    // Коралл — только сбой самого помощника (как сфера фазы error); рассказ о чужом сбое — янтарь (B26 F-B26-2).
    const pal = emo === 'error' ? 'coral' : 'amber';
    spec = { ...BASE, shape: 'face', emo, pal, dim: EMO[emo].dim ?? 1 };
    if (mini) spec = { ...spec, shape: 'sphere', emo: null };
  } else if (host.phase !== 'offline' && input === 'settling') spec = { ...BASE, shape: 'sphere', rot: 0.3 };
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
