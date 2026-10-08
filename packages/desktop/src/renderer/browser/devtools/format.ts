/**
 * Текст панели Console | Network из записей журнала (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4):
 * источник `файл:строка`, текст «Copy», ячейки Status, Name и Size, отформатированный JSON, query и поля form-тела.
 * Чистые функции — их делят виды панели и детали запроса.
 */
import type { ConsoleEntry, NetworkEntry, StackFrame } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';

export function frameText(frame: StackFrame): string {
  return `    at ${frame.fn} (${frame.url}:${frame.line}:${frame.column})`;
}

/** Текст строки для «Copy»: сообщение и кадры стека; без стека — место записи (SyntaxError при загрузке, строка CSP). */
export function consoleCopyText(entry: ConsoleEntry): string {
  const frames = entry.stack.map(frameText);
  if (frames.length === 0 && entry.location !== null) {
    frames.push(`    at (${entry.location.url}:${entry.location.line}:${entry.location.column})`);
  }
  return [entry.text, ...frames].join('\n');
}

/** `app.js:10` — имя файла и строка; без файла — хост; полный адрес — в подсказке строки. */
export function sourceLabel(location: NonNullable<ConsoleEntry['location']>): string {
  try {
    const url = new URL(location.url);
    const name = url.pathname.split('/').filter((part) => part !== '').at(-1) ?? url.host;
    return `${name}:${location.line}`;
  } catch {
    return `${location.url}:${location.line}`;
  }
}

export type StatusTone = 'error' | 'muted' | 'normal';

/** Ячейка Status (спека 4.4): отказ важнее кода — CORS, blocked, failed красным, (canceled) серым; без ответа — (pending). */
export function statusCell(entry: NetworkEntry): { text: string; tone: StatusTone } {
  const status = S.browser.devtools.status;
  if (entry.failure !== null) {
    switch (entry.failure.reason) {
      case 'cors':
        return { text: status.cors, tone: 'error' };
      case 'blocked':
        return { text: status.blocked, tone: 'error' };
      case 'canceled':
        return { text: status.canceled, tone: 'muted' };
      default:
        return { text: status.failed, tone: 'error' };
    }
  }
  if (entry.status === null) return { text: status.pending, tone: 'muted' };
  return { text: String(entry.status), tone: entry.status >= 400 ? 'error' : 'normal' };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Ячейка Name: путь и query; хост — только у чужого origin (спека 4.4). */
export function nameParts(url: string, pageUrl: string): { path: string; host: string | null } {
  try {
    const target = new URL(url);
    return { path: `${target.pathname}${target.search}`, host: target.origin === originOf(pageUrl) ? null : target.host };
  } catch {
    return { path: url, host: null };
  }
}

export function sizeText(entry: NetworkEntry): string {
  if (entry.fromCache) return S.browser.devtools.fromCache;
  return entry.encodedBytes === null ? '—' : S.browser.devtools.bytes(entry.encodedBytes);
}

/** JSON — с отступом в два пробела; не JSON — null (текст показывается как есть). */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return null;
  }
}

/** Байт в теле base64: три на четыре знака без добивки `=`. */
export function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

export function queryParams(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

export function formFields(text: string): Array<[string, string]> {
  return [...new URLSearchParams(text).entries()];
}

/** Значение заголовка без учёта регистра имени; нет — null. */
export function headerValue(headers: ReadonlyArray<[string, string]>, name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}
