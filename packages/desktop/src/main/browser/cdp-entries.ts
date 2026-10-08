// packages/desktop/src/main/browser/cdp-entries.ts
/**
 * Перевод событий CDP в записи журнала (спека 2026-10-07-browser-devtools-agent-design.md, 3.3, 3.4): консоль —
 * `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` и `Log.entryAdded`; поля сети — `Network.*`. Только чистые
 * функции: кольца, эпохи и пачки — в `inspector.ts`. Всё здесь — данные страницы: длины режутся пределами
 * `DEVTOOLS_LIMITS`, форме не верим — любое поле может отсутствовать.
 */
import {
  DEVTOOLS_LIMITS,
  type ConsoleEntry,
  type ConsoleLevel,
  type NetworkFailure,
  type NetworkKind,
  type StackFrame,
} from '../../shared/browser-devtools.js';

/** RemoteObject CDP — только читаемые поля. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PropertyPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
}

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface StackTrace {
  callFrames?: CallFrame[];
}

export interface ConsoleApiParams {
  type?: string;
  args?: RemoteObject[];
  stackTrace?: StackTrace;
}

export interface ExceptionParams {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: StackTrace;
    exception?: RemoteObject;
  };
}

export interface LogParams {
  entry?: {
    source?: string;
    level?: string;
    text?: string;
    url?: string;
    lineNumber?: number;
    stackTrace?: StackTrace;
    networkRequestId?: string;
  };
}

/** Запись консоли без полей журнала: id, эпоху, время и повторы ставит инспектор. */
export type ConsoleDraft = Pick<ConsoleEntry, 'level' | 'origin' | 'text' | 'location' | 'stack'>;

/** Служебное предупреждение Electron (CSP и прочее) — не сообщение страницы (спека 3.3). */
const ELECTRON_WARNING = '%cElectron Security Warning';

/** Тип `console.*` → уровень; null — не запись: без текста или служебное. Прочие типы — info. */
const API_LEVEL: Readonly<Record<string, ConsoleLevel | null>> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  debug: 'debug',
  endGroup: null,
  clear: null,
  profile: null,
  profileEnd: null,
};

const KIND: Readonly<Record<string, NetworkKind>> = {
  Document: 'document',
  Fetch: 'fetch',
  XHR: 'xhr',
  Script: 'script',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Font: 'font',
  Media: 'media',
  WebSocket: 'websocket',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Первые `limit` знаков; половина суррогатной пары (эмодзи) на краю не остаётся. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function propertyText(property: PropertyPreview): string {
  return property.type === 'string' ? `'${property.value ?? ''}'` : (property.value ?? property.type);
}

function previewText(preview: ObjectPreview): string {
  const isArray = preview.subtype === 'array' || preview.subtype === 'typedarray';
  const items = (preview.properties ?? []).map((property) =>
    isArray ? propertyText(property) : `${property.name}: ${propertyText(property)}`,
  );
  if (preview.overflow === true) items.push('…');
  if (isArray) return `${preview.description ?? 'Array'} [${items.join(', ')}]`;
  const name = preview.description === undefined || preview.description === 'Object' ? '' : `${preview.description} `;
  return `${name}{${items.join(', ')}}`;
}

/** Аргумент консоли текстом: строка — как есть, объект — краткий предпросмотр CDP, ошибка — описание со стеком. */
export function remoteText(arg: RemoteObject): string {
  switch (arg.type) {
    case 'string':
      return typeof arg.value === 'string' ? arg.value : '';
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
    case 'bigint':
      return arg.unserializableValue ?? String(arg.value);
    case 'object':
      if (arg.subtype === 'null') return 'null';
      if (arg.subtype === 'error') return arg.description ?? 'Error';
      return arg.preview === undefined ? (arg.description ?? 'Object') : previewText(arg.preview);
    default:
      return arg.description ?? arg.type;
  }
}

/** Аргументы `console.*` строкой: подстановки `%s %d %i %f %o %O` первого аргумента; `%c` (стиль) выпадает. */
export function formatConsoleArgs(args: readonly RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first === undefined) return '';
  if (first.type !== 'string' || typeof first.value !== 'string' || !first.value.includes('%')) {
    return args.map((arg) => remoteText(arg)).join(' ');
  }
  let used = 0;
  const head = first.value.replace(/%([sdifoOc%])/g, (match: string, code: string) => {
    if (code === '%') return '%';
    const arg = rest[used];
    if (arg === undefined) return match;
    used += 1;
    if (code === 'c') return '';
    if ((code === 'd' || code === 'i') && typeof arg.value === 'number') return String(Math.trunc(arg.value));
    return remoteText(arg);
  });
  return [head, ...rest.slice(used).map((arg) => remoteText(arg))].join(' ');
}

function frames(trace: StackTrace | undefined): StackFrame[] {
  return (trace?.callFrames ?? []).slice(0, DEVTOOLS_LIMITS.stackFrames).map((frame) => ({
    fn: frame.functionName === undefined || frame.functionName === '' ? '(anonymous)' : frame.functionName,
    url: clip(frame.url ?? '', DEVTOOLS_LIMITS.url),
    // CDP считает строки и столбцы с нуля, люди и DevTools — с единицы.
    line: (frame.lineNumber ?? 0) + 1,
    column: (frame.columnNumber ?? 0) + 1,
  }));
}

function topOf(stack: readonly StackFrame[]): ConsoleEntry['location'] {
  const top = stack[0];
  return top === undefined || top.url === '' ? null : { url: top.url, line: top.line, column: top.column };
}

function placeOf(url: string | undefined, line: number | undefined, column: number | undefined): ConsoleEntry['location'] {
  return url === undefined || url === ''
    ? null
    : { url: clip(url, DEVTOOLS_LIMITS.url), line: (line ?? 0) + 1, column: (column ?? 0) + 1 };
}

export function consoleFromApi(params: ConsoleApiParams): ConsoleDraft | null {
  const type = params.type ?? 'log';
  const level = Object.hasOwn(API_LEVEL, type) ? (API_LEVEL[type] ?? null) : 'info';
  if (level === null) return null;
  const args = params.args ?? [];
  const first = args[0];
  if (first?.type === 'string' && typeof first.value === 'string' && first.value.startsWith(ELECTRON_WARNING)) return null;
  const formatted = formatConsoleArgs(args);
  const text = type !== 'assert' ? formatted : formatted === '' ? 'Assertion failed' : `Assertion failed: ${formatted}`;
  const stack = frames(params.stackTrace);
  return { level, origin: 'console', text: clip(text, DEVTOOLS_LIMITS.consoleText), location: topOf(stack), stack };
}

export function consoleFromException(params: ExceptionParams): ConsoleDraft {
  const details = params.exceptionDetails ?? {};
  const head = details.text ?? 'Uncaught';
  const exception = details.exception;
  const body =
    exception === undefined
      ? ''
      : exception.subtype === 'error'
        ? ((exception.description ?? '').split('\n')[0] ?? '')
        : remoteText(exception);
  const text = body === '' || head.includes(body) ? head : `${head} ${body}`;
  const stack = frames(details.stackTrace);
  return {
    level: 'error',
    origin: 'exception',
    text: clip(text, DEVTOOLS_LIMITS.consoleText),
    location: topOf(stack) ?? placeOf(details.url, details.lineNumber, details.columnNumber),
    stack,
  };
}

export function consoleFromLog(params: LogParams): ConsoleDraft {
  const entry = params.entry ?? {};
  const level: ConsoleLevel =
    entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : entry.level === 'verbose' ? 'debug' : 'info';
  const stack = frames(entry.stackTrace);
  return {
    level,
    // «Failed to load resource…» и CORS — строки про запрос: красный счётчик считает сам запрос (Фокус ревью 3).
    origin: entry.source === 'network' || typeof entry.networkRequestId === 'string' ? 'network' : 'browser',
    text: clip(entry.text ?? '', DEVTOOLS_LIMITS.consoleText),
    location: topOf(stack) ?? placeOf(entry.url, entry.lineNumber, 0),
    stack,
  };
}

/** Тип ресурса CDP → вид записи; Preflight, Ping и прочие — other. */
export function networkKind(type: unknown): NetworkKind {
  return typeof type === 'string' && Object.hasOwn(KIND, type) ? (KIND[type] ?? 'other') : 'other';
}

/** Заголовки CDP (объект) → пары по порядку; не больше 64, значение до 2 КБ (раздел 8). */
export function headerPairs(headers: unknown): Array<[string, string]> {
  if (!isRecord(headers)) return [];
  return Object.entries(headers)
    .slice(0, DEVTOOLS_LIMITS.headers)
    .map(([name, value]): [string, string] => [name, clip(String(value), DEVTOOLS_LIMITS.headerValue)]);
}

/** Причина отказа `Network.loadingFailed`: отмена, CORS, блок, сеть — в этом порядке. */
export function failureOf(data: Record<string, unknown>): NetworkFailure {
  const errorText = typeof data.errorText === 'string' ? data.errorText : '';
  if (data.canceled === true) return { reason: 'canceled', text: errorText };
  if (isRecord(data.corsErrorStatus)) {
    const cors = data.corsErrorStatus.corsError;
    return { reason: 'cors', text: typeof cors === 'string' ? cors : errorText };
  }
  if (typeof data.blockedReason === 'string') return { reason: 'blocked', text: data.blockedReason };
  return { reason: 'net', text: errorText };
}

/** Адрес сервера ответа; IPv6 — в скобках, как в адресной строке. */
export function remoteAddress(response: Record<string, unknown>): string | null {
  const ip = response.remoteIPAddress;
  if (typeof ip !== 'string' || ip === '') return null;
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return typeof response.remotePort === 'number' ? `${host}:${response.remotePort}` : host;
}

/** Тело запроса: `postData` или склейка `postDataEntries` (base64); до 64 КБ (раздел 8). */
export function postDataOf(request: Record<string, unknown>): string | null {
  if (typeof request.postData === 'string') return clip(request.postData, DEVTOOLS_LIMITS.postData);
  const parts: unknown[] = Array.isArray(request.postDataEntries) ? request.postDataEntries : [];
  if (parts.length === 0) return null;
  const bytes = parts.map((part) => Buffer.from(isRecord(part) && typeof part.bytes === 'string' ? part.bytes : '', 'base64'));
  return clip(Buffer.concat(bytes).toString('utf8'), DEVTOOLS_LIMITS.postData);
}
