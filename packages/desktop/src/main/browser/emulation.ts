// packages/desktop/src/main/browser/emulation.ts
/**
 * Размер вьюпорта вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2; спайк 0.3 — механизм
 * `cdp`): `Emulation.setDeviceMetricsOverride` со `scale` для вписывания в поле, касания и мобильный UA. Команды
 * идут через инспектор — его закрытый список и тайм-аут. Окно ставит `<webview>` размером ширина×scale на
 * высота×scale по центру поля страницы.
 *
 * Эмуляция переживает `reload`, переход на другой origin и `goBack` (спайк 0.3, 3 из 3): повтор команд не нужен.
 * Касания включаются только с новым документом — окно предлагает «Reload to apply touch». Размер картинки со
 * страницы при эмуляции — размер вида × DPR, а не размер на экране: `scale` его не уменьшает (Mobile M 2x даёт
 * 750×1624). Это пригодится снимку этапа C.
 *
 * `withTemporary` — снимок агента в другом размере: временный размер шлётся прямо в CDP и в `state` не пишется, `state` —
 * всегда размер человека. Применения на одну вкладку идут по одному (цепочка промисов), `set` человека ждёт конца снимка.
 */
import { MOBILE_USER_AGENT, viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import type { CdpMethod, Inspector } from './inspector.js';

/** Место под страницу в поле вкладки, CSS-пиксели окна. */
export interface ViewportArea {
  width: number;
  height: number;
}

export interface EmulationCommand {
  method: CdpMethod;
  params: Record<string, unknown>;
}

/** Точек касания у мобильной эмуляции — как у пресетов Chrome. */
const TOUCH_POINTS = 5;

/** Команды CDP для размера; `null` — Fit: эмуляция, касания и подмена UA сняты. `scale` — вписывание, не больше 1. */
export function viewportCommands(spec: ViewportSpec | null, area: ViewportArea, deviceScaleFactor?: number): { commands: EmulationCommand[]; scale: number } {
  if (spec === null) {
    return {
      commands: [
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        // Пустая строка снимает подмену UA.
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    };
  }
  const size = viewportSize(spec);
  const fit = Math.min(1, area.width / size.width, area.height / size.height);
  // Поле ещё не измерено (нулевое) — без уменьшения: scale 0 спрятал бы страницу.
  const scale = Number.isFinite(fit) && fit > 0 ? fit : 1;
  return {
    commands: [
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: size.width, height: size.height, deviceScaleFactor: deviceScaleFactor ?? size.dpr, mobile: size.mobile, scale },
      },
      {
        method: 'Emulation.setTouchEmulationEnabled',
        params: size.mobile ? { enabled: true, maxTouchPoints: TOUCH_POINTS } : { enabled: false },
      },
      { method: 'Emulation.setUserAgentOverride', params: { userAgent: size.mobile ? MOBILE_USER_AGENT : '' } },
    ],
    scale,
  };
}

/** Копия только своих полей: размер приходит из окна, лишнее в `state` не несём и чужой объект не держим. */
function copySpec(spec: ViewportSpec): ViewportSpec {
  return 'preset' in spec
    ? { preset: spec.preset, rotated: spec.rotated, dpr: spec.dpr }
    : { width: spec.width, height: spec.height, mobile: spec.mobile, dpr: spec.dpr };
}

export interface Emulation {
  /** `deviceScaleFactor` — подмена DPR команды (снимок агента на экране с DPR > 1, см. `withTemporary`); `current` отдаёт `spec` как есть. */
  set(id: number, spec: ViewportSpec | null, area: ViewportArea, deviceScaleFactor?: number): Promise<{ scale: number }>;
  current(id: number): ViewportSpec | null;
  /** Вписывание и мобильность размера человека для пересчёта точек ввода агента; `null` — Fit (эмуляции нет). */
  fitOf(id: number): { scale: number; mobile: boolean } | null;
  /** Гость уничтожен: размер его вкладки не помним (id не переиспользуются, но `current` не должен отдавать чужой след). */
  forget(id: number): void;
  /** C: снимок агента в чужом размере — размер на время `run`, потом размер и поле человека (спека 2 п. 10). */
  /**
   * `deviceScaleFactor` — DPR экрана окна: эмуляция с DPR 1 на экране DPR 2 не действует, и Chromium рисует вдвое крупную левую
   * верхнюю четверть страницы (спайк 0, В3). Без него — DPR из `spec`.
   */
  withTemporary<T>(id: number, spec: ViewportSpec, run: () => Promise<T>, deviceScaleFactor?: number): Promise<T>;
}

export function createEmulation(deps: { inspector: Pick<Inspector, 'send'> }): Emulation {
  /** Размер и поле человека. Временный размер снимка сюда не попадает никогда. */
  const state = new Map<number, { spec: ViewportSpec; area: ViewportArea }>();
  /** Хвост применений CDP каждой вкладки: `set` и `withTemporary` идут по одному, в порядке вызова. */
  const chains = new Map<number, Promise<unknown>>();
  function serial<T>(id: number, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(id) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(id, tail);
    void tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return result;
  }
  /** Команды по одной и по порядку; отказ — отказ всей цепочки. */
  async function apply(id: number, commands: EmulationCommand[]): Promise<void> {
    for (const { method, params } of commands) await deps.inspector.send(id, method, params);
  }
  const emulation: Emulation = {
    set(id, spec, area, deviceScaleFactor) {
      return serial(id, async () => {
        const { commands, scale } = viewportCommands(spec, area, deviceScaleFactor);
        // Отказ — отказ set; прежний размер остаётся в state.
        await apply(id, commands);
        if (spec === null) state.delete(id);
        else state.set(id, { spec: copySpec(spec), area: { width: area.width, height: area.height } });
        return { scale };
      });
    },
    current(id) {
      const entry = state.get(id);
      return entry === undefined ? null : copySpec(entry.spec);
    },
    fitOf(id) {
      const entry = state.get(id);
      if (entry === undefined) return null;
      return { scale: viewportCommands(entry.spec, entry.area).scale, mobile: viewportSize(entry.spec).mobile };
    },
    forget(id) {
      state.delete(id);
    },
    withTemporary(id, spec, run, deviceScaleFactor) {
      return serial(id, async () => {
        const { width, height } = viewportSize(spec);
        try {
          // Поле равно размеру — scale 1: страница снимается в полный размер, а не вписанной во вкладку. `state` не трогаем.
          await apply(id, viewportCommands(spec, { width, height }, deviceScaleFactor).commands);
          return await run();
        } finally {
          // Размер и поле человека — на этот момент: пока цепочка держит вкладку, `set` человека ждёт и ложится следом. Записи
          // нет (Fit) — эмуляция снимается, даже если временный размер не встал (команды могли лечь частично).
          const human = state.get(id);
          await apply(id, viewportCommands(human?.spec ?? null, human?.area ?? { width, height }).commands).catch((error: unknown) =>
            console.warn('[parley] emulation restore failed', error),
          );
        }
      });
    },
  };
  return emulation;
}
