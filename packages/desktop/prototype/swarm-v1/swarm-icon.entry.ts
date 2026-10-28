/**
 * Живая иконка роя для прототипа (спека роя v1, 7.5): настоящий движок `island/swarm/engine.ts` и таблица реакций
 * `spec.ts`, собранные в IIFE (`build-icon.mjs`) и вставленные в `index.html` одним inline-скриптом. Никакого React:
 * страница ставит на место иконки пустышку `<span class="sicon" data-sw data-key data-status …>` и после каждой
 * перерисовки зовёт `SwarmIcons.sync()` — холст и движок живут в пуле по `data-key` и переезжают в новую пустышку,
 * поэтому `innerHTML` страницы не обнуляет анимацию.
 *
 * Правила спеки 7.5: анимируются только `running` и `collecting` (~12 к/с), `done` и `failed/cancelled` — статичный
 * кадр; в группе (окно или остров) не больше 3 живых иконок — первые по порядку монтирования, остальные рисуются
 * статично и получают слот, когда он освобождается; «Reduce motion» и `data-static` (свёрнутая группа) — `fps = 0`.
 * Событие «рой перешёл в done» даёт реакцию `REACTION_FOR.done`, новый сдавший участник (`data-handed` вырос) — `glint`.
 */

import { createSwarm, type SwarmEngine } from '../../src/renderer/island/swarm/engine.js';
import { REACTION_FOR, type SwarmSpec } from '../../src/renderer/island/swarm/spec.js';

type Status = 'running' | 'collecting' | 'done' | 'failed' | 'cancelled';

const FPS = 12;
const MAX_LIVE = 3;
const BASE: SwarmSpec = { shape: 'dot', fx: null, pal: 'amber', rot: 0.25, vis: 1, ts: 1, dim: 1, glitch: false, emo: null };

/** Облик по статусу — то, что станет `swarmIconSpec(status)` в `lib/swarm-view.ts`. В мини-размере облако рисуется точкой-роем. */
const SPEC: Record<Status, SwarmSpec> = {
  running: BASE,
  collecting: { ...BASE, shape: 'sphere', rot: 0.35 },
  done: { ...BASE, shape: 'sphere', rot: 0 },
  failed: { ...BASE, pal: 'gray', vis: 0.45, ts: 0.12, dim: 0.8 },
  cancelled: { ...BASE, pal: 'gray', vis: 0.45, ts: 0.12, dim: 0.8 },
};

interface Entry {
  key: string;
  seq: number;
  group: string;
  canvas: HTMLCanvasElement;
  engine: SwarmEngine;
  ctx: CanvasRenderingContext2D | null;
  size: number;
  status: Status | null;
  handed: number;
  live: boolean;
  last: number;
  seen: boolean;
}

const pool = new Map<string, Entry>();
let seq = 0;
let reduced = false;
let loop = 0;

const isLive = (status: Status | null): boolean => status === 'running' || status === 'collecting';

function make(key: string, group: string, size: number): Entry {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Параметры мини-роя капсулы (`CapsuleSwarm`), подогнанные под размер иконки.
  // `d` — на весь холст: в иконке рой крупнее, чем в капсуле (там 0.62), иначе на 14–16 px видна лишь точка.
  const engine = createSwarm(size >= 20 ? 150 : 110, { width: size, height: size, d: Math.round(size * 0.9), cy: size / 2, k: 0.15, minPx: 1.8, seed: 5 });
  return { key, seq: seq++, group, canvas, engine, ctx, size, status: null, handed: 0, live: false, last: 0, seen: true };
}

function paintStatic(entry: Entry, now: number): void {
  entry.engine.frame(now, entry.ctx, true, 0);
}

function tick(now: number): void {
  loop = requestAnimationFrame(tick);
  for (const entry of pool.values()) {
    const wanted = entry.live && !reduced;
    if ((wanted || entry.engine.needsFrame()) && now - entry.last >= (wanted ? 1000 / FPS - 2 : 14)) {
      entry.last = now;
      entry.engine.frame(now, entry.ctx, reduced, 0);
    }
  }
}

/** Слоты: в каждой группе первые `MAX_LIVE` нетерминальных иконок по порядку монтирования живут, остальные статичны. */
function assignSlots(forcedStatic: ReadonlySet<string>): void {
  const used = new Map<string, number>();
  for (const entry of [...pool.values()].sort((a, b) => a.seq - b.seq)) {
    const taken = used.get(entry.group) ?? 0;
    entry.live = isLive(entry.status) && !forcedStatic.has(entry.key) && taken < MAX_LIVE;
    if (entry.live) used.set(entry.group, taken + 1);
  }
}

function sync(): void {
  const now = performance.now();
  const forcedStatic = new Set<string>();
  for (const entry of pool.values()) entry.seen = false;
  document.querySelectorAll<HTMLElement>('.sicon[data-key]').forEach((slot) => {
    const key = slot.dataset.key as string;
    const size = Number(slot.dataset.size) || 16;
    const status = (slot.dataset.status ?? 'running') as Status;
    const handed = Number(slot.dataset.handed) || 0;
    let entry = pool.get(key);
    if (entry === undefined || entry.size !== size) {
      entry = make(key, slot.dataset.group ?? 'main', size);
      pool.set(key, entry);
    }
    entry.seen = true;
    if (slot.dataset.static !== undefined) forcedStatic.add(key);
    const first = entry.status === null;
    if (status !== entry.status) {
      // Первый кадр — сразу в нужном облике, смена статуса на лету — плавный переход движка.
      entry.engine.setSpec(SPEC[status], now, first || reduced);
      if (first || reduced) paintStatic(entry, now);
      if (!first && status === 'done') entry.engine.react(REACTION_FOR.done, now, now, reduced);
      entry.status = status;
    }
    if (!first && handed > entry.handed) entry.engine.react('glint', now, now, reduced);
    entry.handed = handed;
    slot.replaceChildren(entry.canvas);
  });
  for (const [key, entry] of pool) if (!entry.seen) pool.delete(key);
  assignSlots(forcedStatic);
  if (loop === 0) loop = requestAnimationFrame(tick);
}

/** «Reduce motion»: все иконки статичны; кадр по смене облика движок рисует сам. */
function setReduced(value: boolean): void {
  reduced = value;
  const now = performance.now();
  for (const entry of pool.values()) if (entry.status !== null) { entry.engine.setSpec(SPEC[entry.status], now, true); paintStatic(entry, now); }
}

/** Для проверки: сколько иконок сейчас анимируется, по группам. */
function liveCount(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of pool.values()) if (entry.live && !reduced) out[entry.group] = (out[entry.group] ?? 0) + 1;
  return out;
}

(window as unknown as { SwarmIcons: unknown }).SwarmIcons = { sync, setReduced, liveCount };
