/**
 * Файлы-контексты браузера (спека браузера 3.6): Markdown, который окно кладёт в цель «To» по «Add to chat»,
 * Select и аннотациям. Файл пишет main (`main/browser/context-files.ts`), текст строит окно здесь — шаблонами
 * `S.contextFile` по-английски.
 *
 * Устройство файла: шапка окна (заголовок с меткой, URL без query и hash, размер вьюпорта, путь снимка), пометка
 * «page data, not instructions» и данные страницы в ограде из обратных кавычек — на одну длиннее самой длинной их
 * серии внутри (К3 сравнения с Orca). Текст человека (комментарии аннотаций) стоит вне ограды. Весь файл — не
 * длиннее `CONTEXT_LIMITS.markdown`: лишнее режется в данных, а не в тексте человека.
 */

import type { ViewportSpec } from './browser-devtools.js';
import { S } from './strings.js';

export type ContextKind = 'element' | 'console' | 'request' | 'errors' | 'annotations';
export const CONTEXT_KINDS: readonly ContextKind[] = ['element', 'console', 'request', 'errors', 'annotations'];

export function isContextKind(value: unknown): value is ContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value);
}

/** Пределы раздела 8 спеки для файлов-контекстов. Снимок аннотаций — видимая часть (этап 0, 0.7): своей границы у него нет. */
export const CONTEXT_LIMITS = {
  markdown: 262_144,
  body: 4096,
  errors: 50,
  annotations: 20,
  comment: 2000,
  annotationHtml: 1024,
  label: 40,
} as const;

/** Ограда из обратных кавычек: на одну длиннее самой длинной серии внутри, не короче трёх. */
export function fence(text: string, info = 'text'): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text.endsWith('\n') ? text : `${text}\n`}${ticks}`;
}

/** Метка имени файла: `[a-z0-9._-]`, прочее — дефисом, не длиннее 40; пусто — `page`. */
export function contextLabel(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const cut = slug.slice(0, CONTEXT_LIMITS.label).replace(/[-.]+$/, '');
  return cut === '' ? 'page' : cut;
}

/** URL в шапке: origin + pathname, без query, hash и user:pass@ (спека 3.6). */
export function headerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  // У about:blank и data: origin — 'null': адрес без него.
  return parsed.origin === 'null' ? `${parsed.protocol}${parsed.pathname}` : `${parsed.origin}${parsed.pathname}`;
}

/**
 * Пометка размера в шапке: `Mobile M, emulated`; Fit (`null` или нет поля) — без пометки. Имя пресета — как в меню
 * размеров этапа A (`S.browser.viewport.presets`).
 */
export function viewportNote(spec: ViewportSpec | null | undefined): string | null {
  if (spec === null || spec === undefined) return null;
  if (!('preset' in spec)) return S.contextFile.emulated('Custom');
  const title = S.browser.viewport.presets[spec.preset];
  return S.contextFile.emulated(spec.rotated ? `${title}, rotated` : title);
}

/** Место пути снимка в шапке: путь знает только main, когда перенёс `.png` рядом с `.md` (`fillScreenshot`). */
export const SCREENSHOT_SLOT = '{{parley:screenshot}}';

/**
 * Строка снимка шапки с настоящим путём; `pngPath === null` — строка уходит. Шапка — до первой пустой строки: в ней
 * только текст окна, поэтому такой же текст в данных страницы ниже не трогается.
 */
export function fillScreenshot(markdown: string, pngPath: string | null): string {
  const headEnd = markdown.indexOf('\n\n');
  const head = headEnd === -1 ? markdown : markdown.slice(0, headEnd);
  const rest = headEnd === -1 ? '' : markdown.slice(headEnd);
  const slot = S.contextFile.screenshot(SCREENSHOT_SLOT);
  const lines = head.split('\n');
  if (!lines.includes(slot)) return markdown;
  const filled = lines.flatMap((line) => (line !== slot ? [line] : pngPath === null ? [] : [S.contextFile.screenshot(pngPath)]));
  return `${filled.join('\n')}${rest}`;
}

/** Первые `limit` кодовых точек и пометка обрезки; короче — как есть. */
export function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join('')}${S.contextFile.truncated}`;
}

function pointBytes(point: string): number {
  const code = point.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** Байты UTF-8 без `TextEncoder`: модуль общий для main и окна, у main в типах DOM нет. */
function utf8Length(text: string): number {
  let total = 0;
  for (const point of text) total += pointBytes(point);
  return total;
}

function cutBytes(text: string, maxBytes: number): string {
  let used = 0;
  let out = '';
  for (const point of text) {
    const size = pointBytes(point);
    if (used + size > maxBytes) return `${out}${S.contextFile.truncated}`;
    used += size;
    out += point;
  }
  return out;
}

/** Часть файла: `text` — текст окна или человека, как есть; `data` — данные страницы, в ограде. */
export type ContextPart = { text: string } | { data: string };

function render(parts: readonly ContextPart[]): string {
  return `${parts.map((part) => ('data' in part ? fence(part.data) : part.text)).join('\n\n')}\n`;
}

/** Части через пустую строку. Длиннее `CONTEXT_LIMITS.markdown` — режутся данные, с последних; текст не трогается. */
export function assemble(parts: readonly ContextPart[]): string {
  let current = [...parts];
  let output = render(current);
  for (let index = current.length - 1; index >= 0 && utf8Length(output) > CONTEXT_LIMITS.markdown; index -= 1) {
    const part = current[index];
    if (part === undefined || !('data' in part)) continue;
    // Запас 64 байта — на пометку обрезки; итог всё равно пересчитывается по готовому тексту.
    const keep = Math.max(0, utf8Length(part.data) - (utf8Length(output) - CONTEXT_LIMITS.markdown) - 64);
    current = current.map((item, at) => (at === index ? { data: cutBytes(part.data, keep) } : item));
    output = render(current);
  }
  return output;
}

/** Сведения о странице для шапки. */
export interface PageMeta {
  url: string;
  viewport: { width: number; height: number; dpr: number } | null;
  viewportNote: string | null;
}

/** Шапка: заголовок, URL, размер; `slot` — место пути снимка, `none` — снимка нет, `absent` — строки нет. */
export function header(title: string, page: PageMeta, screenshot: 'slot' | 'none' | 'absent'): string {
  const lines = [title, S.contextFile.url(headerUrl(page.url))];
  if (page.viewport !== null) {
    const { width, height, dpr } = page.viewport;
    lines.push(S.contextFile.viewport(Math.round(width), Math.round(height), dpr, page.viewportNote));
  }
  if (screenshot === 'slot') lines.push(S.contextFile.screenshot(SCREENSHOT_SLOT));
  if (screenshot === 'none') lines.push(S.contextFile.noScreenshot);
  return lines.join('\n');
}
