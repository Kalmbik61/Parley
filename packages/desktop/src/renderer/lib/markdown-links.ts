/**
 * Ссылки Markdown — чистые функции без DOM (кусок 7.5, спека 10.6; вынесены из
 * `files/preview/MarkdownPreview.tsx` в 0.2.0): куда ведёт ссылка (`resolveMarkdownLink`) и какие адреса
 * `react-markdown` вообще пропускает (`safeUrlTransform`). Их зовут и превью файлов, и лента комнаты
 * (`components/rooms/RoomMarkdown.tsx`): правила безопасности ссылок у обоих одни.
 */

import { findLinkCandidates } from '../terminal/links.js';

export type MarkdownLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'anchor'; id: string }
  | null;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Куда ведёт ссылка из файла `filePath` (путь от корня). Относительный путь — от папки файла,
 * `/путь` — от корня; хвост `?…` и `#…` у пути отбрасывается. Выход выше корня — null: main
 * отказал бы всё равно, а вкладка с `../` в пути — мусор раскладки.
 */
export function resolveMarkdownLink(href: string, filePath: string): MarkdownLink {
  const raw = href.trim();
  if (raw === '') return null;
  if (raw.startsWith('#')) {
    const id = decode(raw.slice(1));
    return id === null || id === '' ? null : { kind: 'anchor', id };
  }
  // Схема (`https:`, `javascript:`, `file:`) или адрес без схемы `//хост`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    if (!/^https?:/i.test(raw)) return null;
    // Адрес уходит как написан: разбор только проверяет, что он годен.
    return URL.canParse(raw) ? { kind: 'external', url: raw } : null;
  }
  const cut = raw.search(/[?#]/);
  const decoded = decode(cut < 0 ? raw : raw.slice(0, cut));
  if (decoded === null || decoded === '') return null;
  // Файл вне корней работы (2026-10-31) лежит по абсолютному пути: `/путь` и `..` остаются в нём.
  const absolute = filePath.startsWith('/');
  const base = decoded.startsWith('/') ? (absolute ? [''] : []) : filePath.split('/').slice(0, -1);
  const parts = [...base];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0 || (absolute && parts.length === 1)) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 || (absolute && parts.length === 1) ? null : { kind: 'file', path: parts.join('/') };
}

/**
 * `urlTransform` превью (fix-7.5): свой вместо штатного, но такой же запирающий — пропускает
 * `http(s):`, относительные пути и `#якоря`, прочее (`javascript:`, `data:`, `file:`, `vbscript:`,
 * `mailto:`, `//хост`) — пустая строка. Так опасный адрес не доходит даже до своих `a`/`img`, и
 * их будущая правка (скажем, `href` для «открыть в новой вкладке») не откроет дорогу XSS.
 * Табуляции, переводы строк и управляющие символы по краям браузер выбрасывает из адреса сам
 * (`java\tscript:`), поэтому схема проверяется уже без них.
 */
export function safeUrlTransform(url: string): string {
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть то, что вычищается
  const bare = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  // `//хост` и `\\хост` браузер читает как адрес другого хоста.
  if (/^[/\\]{2}/.test(bare)) return '';
  const colon = bare.indexOf(':');
  const end = bare.search(/[/?#]/);
  // Двоеточие до первого `/`, `?`, `#` — это схема; двоеточие дальше — часть пути (`a/b:c.md`).
  if (colon === -1 || (end !== -1 && end < colon)) return url;
  return /^https?$/i.test(bare.slice(0, colon)) ? url : '';
}

export interface FilePathHref {
  path: string;
  line?: number;
  col?: number;
}

const GITHUB_LINE = /#L(\d+)(?:C(\d+))?$/;

/**
 * Адрес ссылки Markdown, который целиком есть путь к файлу (⌘-клик по пути вне корней, 2026-10-31): `/abs/x.md`,
 * `~/x.md`, `../x.md`, `src/x.ts:12:3`, GitHub-хвост `#L42` и `#L42C5`. Путь распознаёт та же регулярка, что в терминале
 * (`findLinkCandidates`), и кандидат обязан покрыть весь адрес — хвостовой мусор делает адрес текстом. Адрес со схемой
 * (`file:`, `javascript:`, `mailto:`) и `//хост` — не путь, `http(s)` — тоже: им занимается `resolveMarkdownLink`.
 */
export function parseFilePathHref(href: string): FilePathHref | null {
  let raw = href.trim();
  if (raw === '' || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  let hashLine: number | undefined;
  let hashCol: number | undefined;
  const hash = GITHUB_LINE.exec(raw);
  if (hash !== null) {
    hashLine = Number(hash[1]);
    if (hash[2] !== undefined) hashCol = Number(hash[2]);
    raw = raw.slice(0, hash.index);
  }
  const decoded = decode(raw);
  if (decoded === null) return null;
  const [candidate, ...rest] = findLinkCandidates(decoded);
  if (candidate === undefined || rest.length > 0 || candidate.kind !== 'path' || candidate.path === undefined) return null;
  if (candidate.start !== 0 || candidate.end !== decoded.length) return null;
  const line = candidate.line ?? hashLine;
  const col = candidate.line === undefined ? hashCol : candidate.col;
  return { path: candidate.path, ...(line === undefined ? {} : { line }), ...(col === undefined ? {} : { col }) };
}
