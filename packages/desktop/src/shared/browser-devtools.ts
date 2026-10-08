/**
 * Консоль и сеть вкладки браузера, размеры вьюпорта (спека 2026-10-07-browser-devtools-agent-design.md, 3.4, 4.2,
 * раздел 8): общие для main (инспектор CDP, эмуляция), прелоада и окна. Имена и форма — контракт индекса плана
 * (`2026-10-07-browser-devtools-agent-plan.md`, «Общие имена»): этапы B–D ими пользуются.
 */

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface StackFrame {
  fn: string;
  url: string;
  line: number;
  column: number;
}

export interface ConsoleEntry {
  id: number;
  /** Номер документа главного фрейма (спека 3.3). */
  epoch: number;
  ts: number;
  level: ConsoleLevel;
  origin: 'console' | 'exception' | 'network' | 'browser';
  text: string;
  location: { url: string; line: number; column: number } | null;
  stack: StackFrame[];
  /** Одинаковые сообщения подряд. */
  count: number;
}

export type NetworkKind =
  | 'document'
  | 'fetch'
  | 'xhr'
  | 'script'
  | 'stylesheet'
  | 'image'
  | 'font'
  | 'media'
  | 'websocket'
  | 'other';

export interface NetworkFailure {
  reason: 'net' | 'cors' | 'blocked' | 'canceled';
  text: string;
}

export interface NetworkEntry {
  /** requestId CDP. */
  id: string;
  epoch: number;
  ts: number;
  method: string;
  url: string;
  kind: NetworkKind;
  status: number | null;
  statusText: string;
  failure: NetworkFailure | null;
  mimeType: string | null;
  encodedBytes: number | null;
  durationMs: number | null;
  fromCache: boolean;
  remoteAddress: string | null;
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  hasPostData: boolean;
  postData: string | null;
}

/** Упавший: ответ 4xx–5xx или отказ, кроме отмены. Для «Failed only», красного счётчика и агента (спека 3.4). */
export function isFailed(entry: NetworkEntry): boolean {
  return (entry.status !== null && entry.status >= 400) || (entry.failure !== null && entry.failure.reason !== 'canceled');
}

/** `late` — захват подключился после начала загрузки: запросы документа могли пройти мимо. */
export type CaptureState = 'on' | 'late' | 'unavailable';

export interface DevtoolsSnapshot {
  epoch: number;
  capture: CaptureState;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/** Пачка окну (событие `browser:devtools`): новые и изменённые записи; `reset` — журнал перед ней очищен. */
export interface DevtoolsBatch extends DevtoolsSnapshot {
  webContentsId: number;
  reset: boolean;
}

export interface ResponseBody {
  text: string;
  base64: boolean;
  truncated: boolean;
}

export type ViewportPreset = 'mobile-s' | 'mobile-m' | 'mobile-l' | 'tablet' | 'laptop' | 'desktop';
export type ViewportDpr = 1 | 2 | 3;
export type ViewportSpec =
  | { preset: ViewportPreset; rotated: boolean; dpr: ViewportDpr }
  | { width: number; height: number; mobile: boolean; dpr: ViewportDpr };

/** Пресеты device toolbar Chrome (спека 4.2): мобильные — с касаниями и мобильным UA. */
export const VIEWPORT_PRESETS: Readonly<Record<ViewportPreset, { width: number; height: number; mobile: boolean }>> = {
  'mobile-s': { width: 320, height: 568, mobile: true },
  'mobile-m': { width: 375, height: 812, mobile: true },
  'mobile-l': { width: 430, height: 932, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  laptop: { width: 1280, height: 800, mobile: false },
  desktop: { width: 1440, height: 900, mobile: false },
};

/** UA мобильного Safari, как у пресетов iPhone в Chrome. */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Пределы раздела 8 спеки: main, окно и тесты берут числа только отсюда. */
export const DEVTOOLS_LIMITS = {
  consoleEntries: 1000,
  networkEntries: 500,
  consoleText: 10_000,
  stackFrames: 20,
  url: 4096,
  headers: 64,
  headerValue: 2048,
  postData: 65_536,
  panelBody: 1_048_576,
  batchMs: 150,
  batchMax: 200,
  resourceBuffer: 5_242_880,
  totalBuffer: 52_428_800,
  customMin: 200,
  customMaxWidth: 3840,
  customMaxHeight: 2400,
} as const;

/** Размер страницы в CSS-пикселях: пресет (с поворотом) или свой. */
export function viewportSize(spec: ViewportSpec): { width: number; height: number; mobile: boolean; dpr: ViewportDpr } {
  if (!('preset' in spec)) return { width: spec.width, height: spec.height, mobile: spec.mobile, dpr: spec.dpr };
  const preset = VIEWPORT_PRESETS[spec.preset];
  return spec.rotated
    ? { width: preset.height, height: preset.width, mobile: preset.mobile, dpr: spec.dpr }
    : { width: preset.width, height: preset.height, mobile: preset.mobile, dpr: spec.dpr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDpr(value: unknown): value is ViewportDpr {
  return value === 1 || value === 2 || value === 3;
}

function isSide(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= DEVTOOLS_LIMITS.customMin && value <= max;
}

/** Размер из раскладки или из моста: пресет из списка или свой в пределах раздела 8. Лишние поля не проверяются. */
export function isViewportSpec(value: unknown): value is ViewportSpec {
  if (!isRecord(value) || !isDpr(value.dpr)) return false;
  if ('preset' in value) {
    return typeof value.preset === 'string' && Object.hasOwn(VIEWPORT_PRESETS, value.preset) && typeof value.rotated === 'boolean';
  }
  return (
    isSide(value.width, DEVTOOLS_LIMITS.customMaxWidth) &&
    isSide(value.height, DEVTOOLS_LIMITS.customMaxHeight) &&
    typeof value.mobile === 'boolean'
  );
}
