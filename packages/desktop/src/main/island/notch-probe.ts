/**
 * Датчик выреза (спека #9, §12.2): у Electron нет API безопасной зоны, поэтому числа берутся у AppKit через JXA —
 * `osascript` из системы, без своего бинаря. Из `NSScreen.screens` берутся `NSScreenNumber`, `frame`,
 * `safeAreaInsets.top` и ширины `auxiliaryTopLeftArea`/`auxiliaryTopRightArea`: вырез — то, что между ними.
 * Запуск — `execFile` (зависимость) вне потока main, тайм-аут 2 с. Ответ кешируется по дисплею Electron; ошибка,
 * тайм-аут или чужой ответ дают `null` (сегодняшняя полоса) и одно `console.warn` за сессию, без повторов в цикле.
 * Замеры по событиям `screen` схлопываются с задержкой 250 мс.
 */

import type { DisplayLike, NotchGeometry, Rect } from './placement.js';

export const NOTCH_PROBE_TIMEOUT_MS = 2000;
export const NOTCH_PROBE_DELAY_MS = 250;
/** Выше 64 pt выреза не бывает: такое число — мусор, а не вырез. */
const NOTCH_HEIGHT_MAX = 64;

/** Селекторы проверяются: на старой macOS их нет, такой экран — без выреза, а не ошибка. */
export const NOTCH_SCRIPT = `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const screen = screens.objectAtIndex(i);
  const frame = screen.frame;
  const has = (selector) => screen.respondsToSelector(selector);
  out.push({
    id: ObjC.unwrap(screen.deviceDescription.objectForKey('NSScreenNumber')),
    frame: { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height },
    top: has('safeAreaInsets') ? screen.safeAreaInsets.top : 0,
    left: has('auxiliaryTopLeftArea') ? screen.auxiliaryTopLeftArea.size.width : 0,
    right: has('auxiliaryTopRightArea') ? screen.auxiliaryTopRightArea.size.width : 0,
  });
}
JSON.stringify(out);`;

/** То, что датчику нужно от `child_process.execFile`. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface NotchProbeDeps {
  execFile: ExecFileLike;
  displays(): readonly DisplayLike[];
  /** Новый замер изменил геометрию хотя бы одного дисплея: main переставляет окно и шлёт конфиг острову. */
  onChange(): void;
  warn(message: string): void;
}

export interface NotchProbe {
  /** Замер сразу (старт приложения). */
  measure(): void;
  /**
   * Событие `screen`: без `changedMetrics` — `display-added`/`display-removed`, с ним — `display-metrics-changed`.
   * Замер — только если сменились `bounds` или `scaleFactor`: один `workArea` меняется при каждом показе Dock и входе в
   * полный экран. Серия событий за 250 мс даёт один замер.
   */
  displaysChanged(changedMetrics?: readonly string[]): void;
  /** Вырез дисплея по последнему замеру; не мерили, нет выреза или датчик отказал — `null`. */
  geometry(displayId: number): NotchGeometry | null;
}

interface ProbedScreen {
  id: number;
  frame: Rect;
  top: number;
  left: number;
  right: number;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseScreen(value: unknown): ProbedScreen | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, frame, top, left, right } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || !isNumber(top) || !isNumber(left) || !isNumber(right)) return null;
  if (typeof frame !== 'object' || frame === null) return null;
  const { x, y, width, height } = frame as Record<string, unknown>;
  if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) return null;
  return { id: id as number, frame: { x, y, width, height }, top, left, right };
}

/** Ответ JXA — массив экранов; что-то не так хотя бы в одном — весь ответ чужой (`null`). */
function parseScreens(stdout: string): ProbedScreen[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const screens: ProbedScreen[] = [];
  for (const item of value) {
    const screen = parseScreen(item);
    if (screen === null) return null;
    screens.push(screen);
  }
  return screens;
}

/** Вырез — между верхними боковыми полосами; числа вне `0 < nw < frame.width`, `0 < nh ≤ 64` — выреза нет. */
function geometryOf(screen: ProbedScreen): NotchGeometry | null {
  const width = screen.frame.width - screen.left - screen.right;
  const height = screen.top;
  if (!(width > 0 && width < screen.frame.width && height > 0 && height <= NOTCH_HEIGHT_MAX)) return null;
  return { width, height, centerX: screen.left + width / 2 };
}

/**
 * Экран AppKit для дисплея Electron: по `NSScreenNumber` (на macOS Chromium берёт `Display.id` из него же), иначе по
 * размеру. У AppKit ось y направлена вверх, поэтому одинаковые размеры различает только x.
 */
function screenFor(display: DisplayLike, screens: readonly ProbedScreen[]): ProbedScreen | undefined {
  const byId = screens.find((screen) => screen.id === display.id);
  if (byId !== undefined) return byId;
  const sized = screens.filter((screen) => screen.frame.width === display.bounds.width && screen.frame.height === display.bounds.height);
  return sized.length === 1 ? sized[0] : sized.find((screen) => screen.frame.x === display.bounds.x);
}

const sameGeometry = (a: NotchGeometry | null, b: NotchGeometry | null): boolean =>
  a === null || b === null ? a === b : a.width === b.width && a.height === b.height && a.centerX === b.centerX;

export function createNotchProbe(deps: NotchProbeDeps): NotchProbe {
  let cache = new Map<number, NotchGeometry | null>();
  let warned = false;
  /** Номер последнего запуска: ответ, который обогнал более новый замер, отбрасывается. */
  let runs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    deps.warn(message);
  };
  const apply = (next: Map<number, NotchGeometry | null>): void => {
    const ids = new Set([...cache.keys(), ...next.keys()]);
    const changed = [...ids].some((id) => !sameGeometry(cache.get(id) ?? null, next.get(id) ?? null));
    cache = next;
    if (changed) deps.onChange();
  };
  const measure = (): void => {
    runs += 1;
    const run = runs;
    deps.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', NOTCH_SCRIPT], { timeout: NOTCH_PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (run !== runs) return;
      if (error !== null) {
        warnOnce(`notch probe failed: ${error.message}`);
        apply(new Map());
        return;
      }
      const screens = parseScreens(stdout);
      if (screens === null) {
        warnOnce('notch probe: unexpected output');
        apply(new Map());
        return;
      }
      const next = new Map<number, NotchGeometry | null>();
      for (const display of deps.displays()) {
        const screen = screenFor(display, screens);
        next.set(display.id, screen === undefined ? null : geometryOf(screen));
      }
      apply(next);
    });
  };

  return {
    measure,
    displaysChanged: (changedMetrics) => {
      if (changedMetrics !== undefined && !changedMetrics.includes('bounds') && !changedMetrics.includes('scaleFactor')) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        measure();
      }, NOTCH_PROBE_DELAY_MS);
    },
    geometry: (displayId) => cache.get(displayId) ?? null,
  };
}
