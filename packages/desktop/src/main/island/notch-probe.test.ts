import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotchProbe, NOTCH_PROBE_DELAY_MS, NOTCH_PROBE_TIMEOUT_MS, NOTCH_SCRIPT, type ExecFileLike } from './notch-probe.js';
import type { DisplayLike } from './placement.js';

/** Замер на MacBook Pro 14″ (`Mac16,8`, 1512×982) с внешним 3440×1440 слева сверху — спека #9 §12.2. */
const MACBOOK_SCREEN = { id: 1, frame: { x: 0, y: 0, width: 1512, height: 982 }, top: 32, left: 663, right: 664 };
const EXTERNAL_SCREEN = { id: 2, frame: { x: -2790, y: 982, width: 3440, height: 1440 }, top: 0, left: 0, right: 0 };
const MACBOOK: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 }, internal: true };
const EXTERNAL: DisplayLike = { id: 2, bounds: { x: -2790, y: -1440, width: 3440, height: 1440 }, workArea: { x: -2790, y: -1415, width: 3440, height: 1415 }, internal: false };
const NOTCH_14 = { width: 185, height: 32, centerX: 755.5 };

type Callback = Parameters<ExecFileLike>[3];

function setup(displays: DisplayLike[] = [MACBOOK, EXTERNAL]) {
  const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number }; callback: Callback }> = [];
  const execFile = vi.fn<ExecFileLike>((file, args, options, callback) => {
    calls.push({ file, args, options, callback });
  });
  const onChange = vi.fn();
  const warn = vi.fn();
  const probe = createNotchProbe({ execFile, displays: () => displays, onChange, warn });
  /** Ответ последнего запуска `osascript`. */
  const answer = (stdout: string, error: Error | null = null): void => calls.at(-1)?.callback(error, stdout);
  return { probe, calls, execFile, onChange, warn, answer };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('датчик выреза: замер и разбор (N1)', () => {
  it('JXA через osascript вне потока main: execFile с тайм-аутом 2 с, без запуска при создании', () => {
    const { probe, calls } = setup();
    expect(calls).toHaveLength(0);
    probe.measure();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('/usr/bin/osascript');
    expect(calls[0]?.args).toEqual(['-l', 'JavaScript', '-e', NOTCH_SCRIPT]);
    expect(calls[0]?.options).toEqual({ timeout: NOTCH_PROBE_TIMEOUT_MS });
    expect(NOTCH_PROBE_TIMEOUT_MS).toBe(2000);
    for (const field of ['NSScreenNumber', 'frame', 'safeAreaInsets', 'auxiliaryTopLeftArea', 'auxiliaryTopRightArea']) {
      expect(NOTCH_SCRIPT).toContain(field);
    }
  });

  it('14″: вырез 185 × 32, центр 755,5 от левого края; внешний монитор без выреза — null', () => {
    const { probe, answer, onChange, warn } = setup();
    expect(probe.geometry(1)).toBeNull();
    probe.measure();
    answer(JSON.stringify([MACBOOK_SCREEN, EXTERNAL_SCREEN]));
    expect(probe.geometry(1)).toEqual(NOTCH_14);
    expect(probe.geometry(2)).toBeNull();
    expect(probe.geometry(99)).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('дисплей Electron сопоставляется по NSScreenNumber, а не по порядку экранов', () => {
    const { probe, answer } = setup([EXTERNAL, MACBOOK]);
    probe.measure();
    answer(JSON.stringify([EXTERNAL_SCREEN, MACBOOK_SCREEN]));
    expect(probe.geometry(1)).toEqual(NOTCH_14);
    expect(probe.geometry(2)).toBeNull();
  });

  it('id не совпал — по размеру; одинаковые размеры различает x (ось y у AppKit направлена вверх)', () => {
    const left: DisplayLike = { ...MACBOOK, id: 10, bounds: { x: -1512, y: 0, width: 1512, height: 982 } };
    const right: DisplayLike = { ...MACBOOK, id: 11 };
    const { probe, answer } = setup([left, right]);
    probe.measure();
    answer(JSON.stringify([
      { ...MACBOOK_SCREEN, id: 7, frame: { ...MACBOOK_SCREEN.frame, x: -1512 }, left: 600, right: 727 },
      { ...MACBOOK_SCREEN, id: 8 },
    ]));
    expect(probe.geometry(10)).toEqual({ width: 185, height: 32, centerX: 692.5 });
    expect(probe.geometry(11)).toEqual(NOTCH_14);
  });

  it('ни id, ни размер не совпали — у дисплея выреза нет', () => {
    const { probe, answer } = setup([MACBOOK]);
    probe.measure();
    answer(JSON.stringify([{ ...MACBOOK_SCREEN, id: 5, frame: { ...MACBOOK_SCREEN.frame, width: 1728 } }]));
    expect(probe.geometry(1)).toBeNull();
  });

  it.each([
    ['ширина 0 (вспомогательные полосы во весь экран)', { left: 756, right: 756 }],
    ['ширина во весь экран (полос нет)', { left: 0, right: 0 }],
    ['ширина больше экрана', { left: -10, right: -10 }],
    ['высота 0', { top: 0 }],
    ['высота больше 64', { top: 65 }],
  ])('проверка чисел: %s — выреза нет, без предупреждения', (_name, patch) => {
    const { probe, answer, warn } = setup([MACBOOK]);
    probe.measure();
    answer(JSON.stringify([{ ...MACBOOK_SCREEN, ...patch }]));
    expect(probe.geometry(1)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('высота ровно 64 — ещё вырез', () => {
    const { probe, answer } = setup([MACBOOK]);
    probe.measure();
    answer(JSON.stringify([{ ...MACBOOK_SCREEN, top: 64 }]));
    expect(probe.geometry(1)).toEqual({ ...NOTCH_14, height: 64 });
  });

  it.each([
    ['не JSON', 'execution error: Error: ReferenceError'],
    ['не массив', '{"id":1}'],
    ['пустая строка', ''],
    ['строка вместо числа', JSON.stringify([{ ...MACBOOK_SCREEN, top: '32' }])],
    ['нет frame', JSON.stringify([{ id: 1, top: 32, left: 663, right: 664 }])],
    ['id не целое', JSON.stringify([{ ...MACBOOK_SCREEN, id: 1.5 }])],
    ['null среди экранов', JSON.stringify([MACBOOK_SCREEN, null])],
  ])('мусор в ответе (%s) — null у всех дисплеев и предупреждение', (_name, stdout) => {
    const { probe, answer, warn } = setup();
    probe.measure();
    answer(stdout);
    expect(probe.geometry(1)).toBeNull();
    expect(probe.geometry(2)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('тайм-аут или ошибка osascript — null без падения; одно предупреждение за сессию, без повторов в цикле', () => {
    const { probe, answer, warn, calls, onChange } = setup();
    probe.measure();
    answer(JSON.stringify([MACBOOK_SCREEN, EXTERNAL_SCREEN]));
    expect(probe.geometry(1)).toEqual(NOTCH_14);
    probe.measure();
    expect(() => answer('', Object.assign(new Error('Command failed: osascript'), { killed: true, signal: 'SIGTERM' }))).not.toThrow();
    expect(probe.geometry(1)).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
    probe.measure();
    answer('garbage');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('notch probe');
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(3);
  });

  it('тот же ответ ещё раз — onChange не зовётся: остров не переставляется зря', () => {
    const { probe, answer, onChange } = setup();
    probe.measure();
    answer(JSON.stringify([MACBOOK_SCREEN, EXTERNAL_SCREEN]));
    probe.measure();
    answer(JSON.stringify([EXTERNAL_SCREEN, MACBOOK_SCREEN]));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ответ старого запуска, пришедший после нового, отбрасывается', () => {
    const { probe, calls, onChange } = setup();
    probe.measure();
    probe.measure();
    calls[1]?.callback(null, JSON.stringify([MACBOOK_SCREEN, EXTERNAL_SCREEN]));
    calls[0]?.callback(null, JSON.stringify([]));
    expect(probe.geometry(1)).toEqual(NOTCH_14);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('датчик выреза: события дисплеев (N8)', () => {
  it('display-added и display-removed — замер через 250 мс', () => {
    const { probe, calls } = setup();
    probe.displaysChanged();
    vi.advanceTimersByTime(NOTCH_PROBE_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    expect(NOTCH_PROBE_DELAY_MS).toBe(250);
  });

  it.each([[['bounds']], [['scaleFactor']], [['workArea', 'bounds']], [['scaleFactor', 'workArea']]])(
    'display-metrics-changed с %j — замер',
    (changed) => {
      const { probe, calls } = setup();
      probe.displaysChanged(changed);
      vi.advanceTimersByTime(NOTCH_PROBE_DELAY_MS);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([[['workArea']], [['rotation']], [[]]])('display-metrics-changed с %j (Dock, строка меню, полный экран) — без замера', (changed) => {
    const { probe, calls } = setup();
    probe.displaysChanged(changed);
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(0);
  });

  it('серия событий схлопывается в один замер, отсчёт 250 мс — от последнего события', () => {
    const { probe, calls } = setup();
    probe.displaysChanged();
    vi.advanceTimersByTime(200);
    probe.displaysChanged(['bounds']);
    vi.advanceTimersByTime(200);
    probe.displaysChanged(['workArea']);
    probe.displaysChanged(['scaleFactor']);
    vi.advanceTimersByTime(NOTCH_PROBE_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(1);
  });

  it('новый замер после смены дисплеев: встроенный отключили — вырез пропал, onChange', () => {
    const displays = [MACBOOK, EXTERNAL];
    const { probe, answer, onChange } = setup(displays);
    probe.measure();
    answer(JSON.stringify([MACBOOK_SCREEN, EXTERNAL_SCREEN]));
    displays.splice(0, 1);
    probe.displaysChanged();
    vi.advanceTimersByTime(NOTCH_PROBE_DELAY_MS);
    answer(JSON.stringify([EXTERNAL_SCREEN]));
    expect(probe.geometry(1)).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
