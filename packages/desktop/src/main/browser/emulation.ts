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
 * Этап C добавит `withTemporary` (снимок агента в другом размере): размер и поле вкладки для возврата лежат в `state`.
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
export function viewportCommands(spec: ViewportSpec | null, area: ViewportArea): { commands: EmulationCommand[]; scale: number } {
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
        params: { width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.mobile, scale },
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
  set(id: number, spec: ViewportSpec | null, area: ViewportArea): Promise<{ scale: number }>;
  current(id: number): ViewportSpec | null;
}

export function createEmulation(deps: { inspector: Pick<Inspector, 'send'> }): Emulation {
  const state = new Map<number, { spec: ViewportSpec; area: ViewportArea }>();
  return {
    async set(id, spec, area) {
      const { commands, scale } = viewportCommands(spec, area);
      // По одной и по порядку. Отказ — отказ set; прежний размер остаётся в state.
      for (const { method, params } of commands) await deps.inspector.send(id, method, params);
      if (spec === null) state.delete(id);
      else state.set(id, { spec: copySpec(spec), area: { width: area.width, height: area.height } });
      return { scale };
    },
    current(id) {
      const entry = state.get(id);
      return entry === undefined ? null : copySpec(entry.spec);
    },
  };
}
