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

import { DEVTOOLS_LIMITS, type ConsoleEntry, type NetworkEntry, type ResponseBody, type ViewportSpec } from './browser-devtools.js';
import type { ReactComponentInfo } from './browser-types.js';
import { selectorTail } from './css-selector.js';
import { redactBody, redactHeaders, redactUrl, redactUrlsInText, unmaskableJson } from './redact.js';
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
  // Хвост срезается от начала серии (`(?<![-.])`), а не с каждой её точки: иначе длинная серия «.» или «.-» внутри
  // строки даёт квадратичный перебор, а путь страницы, из которого строят метку, задаёт сама страница.
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|(?<![-.])[-.]+$/g, '');
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

/** Готовый файл-контекст: вид, метка имени файла (`<вид>-<метка>-<4 hex>.md`) и текст. */
export interface BuiltContext {
  kind: ContextKind;
  label: string;
  markdown: string;
}

/** Данные элемента в ограде: Select и метки аннотаций на элементах. */
export interface ElementData {
  selector: string;
  text: string;
  html: string;
  styles: Readonly<Record<string, string>>;
  role?: string;
  name?: string;
  react?: readonly ReactComponentInfo[];
}

/** Элемент Select: данные, адрес страницы, путь снимка в `drops/` и размер вьюпорта (`PickResult` подходит как есть). */
export interface ElementContextInput extends ElementData {
  url: string;
  imagePath: string | null;
  viewport: PageMeta['viewport'];
}

/** Метка элемента по последнему звену селектора: `button.save`, `button-save` (по id), `body`. */
export function elementLabel(selector: string): string {
  const tail = selectorTail(selector);
  const tag = tail.tag === '' ? 'element' : tail.tag;
  if (tail.id !== null) return contextLabel(`${tag}-${tail.id}`);
  const first = tail.classes[0];
  return contextLabel(first === undefined ? tag : `${tag}.${first}`);
}

export function consoleLabel(entry: Pick<ConsoleEntry, 'level' | 'text'>): string {
  // Адрес в начале сообщения с маской: метка — это и заголовок файла, и его имя.
  return contextLabel(`${entry.level}-${redactUrlsInText(entry.text.slice(0, 80))}`);
}

export function requestLabel(entry: Pick<NetworkEntry, 'method' | 'url' | 'status' | 'failure'>): string {
  let path = '';
  try {
    path = new URL(entry.url).pathname;
  } catch {
    path = '';
  }
  const outcome = entry.status !== null ? String(entry.status) : entry.failure !== null ? entry.failure.reason : 'pending';
  return contextLabel(`${entry.method}-${path}-${outcome}`);
}

/** Метка файлов страницы (`errors`, `annotations`): путь страницы, корень — `page`. */
export function pageLabel(url: string): string {
  let path = '';
  try {
    // Хвост срезается от начала серии (`(?<!\/)`), а не с каждой её точки — как в `contextLabel`: путь задаёт сама страница.
    path = new URL(url).pathname.replace(/^\/+|(?<!\/)\/+$/g, '');
  } catch {
    path = '';
  }
  return contextLabel(path === '' ? 'page' : path);
}

function page(url: string): PageMeta {
  return { url, viewport: null, viewportNote: null };
}

function stylesText(styles: Readonly<Record<string, string>>): string {
  return Object.entries(styles)
    .map(([name, value]) => `${name}:${value}`)
    .join('; ');
}

function elementLines(data: ElementData): string {
  const lines = [S.contextFile.selector(data.selector)];
  if (data.role !== undefined) lines.push(S.contextFile.role(data.role, data.name ?? ''));
  if (data.react !== undefined && data.react.length > 0) {
    lines.push(S.contextFile.react(data.react.map((item) => S.contextFile.component(item.name, item.source, item.approx)).join(' < ')));
  }
  lines.push(S.contextFile.text(data.text), S.contextFile.styles(stylesText(data.styles)), S.contextFile.html, data.html);
  return lines.join('\n');
}

export function elementContext(input: { pick: ElementContextInput; viewportNote: string | null }): BuiltContext {
  const { pick } = input;
  const label = elementLabel(pick.selector);
  const head = header(
    S.contextFile.elementTitle(label),
    { url: pick.url, viewport: pick.viewport, viewportNote: input.viewportNote },
    pick.imagePath === null ? 'absent' : 'slot',
  );
  return { kind: 'element', label, markdown: assemble([{ text: head }, { text: S.contextFile.pageDataNote }, { data: elementLines(pick) }]) };
}

/** Место в коде страницы: URL с маской, строка и столбец. */
function located(location: { url: string; line: number; column: number }): string {
  return `${redactUrl(location.url)}:${location.line}:${location.column}`;
}

export function consoleContext(input: { pageUrl: string; entry: ConsoleEntry }): BuiltContext {
  const { entry } = input;
  const label = consoleLabel(entry);
  const lines = [S.contextFile.level(entry.level, entry.origin)];
  if (entry.location !== null) lines.push(S.contextFile.source(located(entry.location)));
  if (entry.count > 1) lines.push(S.contextFile.repeated(entry.count));
  // Сообщение может цитировать адрес запроса (CORS называет его целиком, с `?token=…`): адреса в тексте идут через маску.
  lines.push(S.contextFile.message, redactUrlsInText(entry.text));
  if (entry.stack.length > 0) {
    lines.push(S.contextFile.stack, ...entry.stack.slice(0, DEVTOOLS_LIMITS.stackFrames).map((frame) => S.contextFile.frame(frame.fn, located(frame))));
  }
  const head = header(S.contextFile.consoleTitle(label), page(input.pageUrl), 'absent');
  return { kind: 'console', label, markdown: assemble([{ text: head }, { text: S.contextFile.pageDataNote }, { data: lines.join('\n') }]) };
}

function headersBlock(title: string, headers: ReadonlyArray<[string, string]>): string[] {
  return headers.length === 0 ? [] : [title, ...redactHeaders(headers).map(([name, value]) => S.contextFile.header(name, value))];
}

function headerValue(headers: ReadonlyArray<[string, string]>, name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

/** Тело с маской и пределом; JSON, который не разобрался, не идёт вовсе — его маской не закрыть (спека 6). */
function bodyText(text: string, mimeType: string | null): string {
  return unmaskableJson(text, mimeType) ? S.contextFile.bodyNotMaskable : redactBody(text, mimeType, CONTEXT_LIMITS.body);
}

function responseText(body: ResponseBody | null, mimeType: string | null): string {
  if (body === null) return S.contextFile.bodyGone;
  if (body.base64) return S.contextFile.binaryBody;
  if (body.text === '') return S.contextFile.noBody;
  return bodyText(body.text, mimeType);
}

export function requestContext(input: { pageUrl: string; entry: NetworkEntry; responseBody: ResponseBody | null }): BuiltContext {
  const { entry } = input;
  const label = requestLabel(entry);
  const lines = [S.contextFile.request(entry.method, redactUrl(entry.url))];
  if (entry.status !== null) lines.push(S.contextFile.status(entry.status, entry.statusText));
  if (entry.failure !== null) lines.push(S.contextFile.failure(entry.failure.reason, entry.failure.text));
  if (entry.status === null && entry.failure === null) lines.push(S.contextFile.pending);
  lines.push(S.contextFile.type(entry.kind, entry.mimeType));
  if (entry.remoteAddress !== null) lines.push(S.contextFile.remote(entry.remoteAddress));
  lines.push(...headersBlock(S.contextFile.requestHeaders, entry.requestHeaders), ...headersBlock(S.contextFile.responseHeaders, entry.responseHeaders));
  if (entry.hasPostData) {
    const body = entry.postData === null ? S.contextFile.bodyNotCaptured : bodyText(entry.postData, headerValue(entry.requestHeaders, 'content-type'));
    lines.push(S.contextFile.requestBody, body);
  }
  // Ответа нет (CORS, сеть, отмена) — и тела ответа нет.
  if (entry.status !== null) lines.push(S.contextFile.responseBody, responseText(input.responseBody, entry.mimeType));
  const head = header(S.contextFile.requestTitle(label), page(input.pageUrl), 'absent');
  return { kind: 'request', label, markdown: assemble([{ text: head }, { text: S.contextFile.pageDataNote }, { data: lines.join('\n') }]) };
}

function outcomeText(entry: NetworkEntry): string {
  if (entry.status !== null) return entry.statusText === '' ? String(entry.status) : `${entry.status} ${entry.statusText}`;
  if (entry.failure !== null) return entry.failure.text === '' ? entry.failure.reason : `${entry.failure.reason}: ${entry.failure.text}`;
  return S.contextFile.noResponse;
}

/** Все видимые ошибки (спека 4.3): ошибки консоли и упавшие запросы по времени, не больше `CONTEXT_LIMITS.errors`. */
export function errorsContext(input: { pageUrl: string; console: readonly ConsoleEntry[]; requests: readonly NetworkEntry[] }): BuiltContext {
  const items = [
    ...input.console.map((entry) => ({
      ts: entry.ts,
      line: (n: number): string => {
        const item = S.contextFile.errorItem(n, redactUrlsInText(entry.text));
        return entry.location === null ? item : `${item}\n   ${S.contextFile.at(located(entry.location))}`;
      },
    })),
    ...input.requests.map((entry) => ({
      ts: entry.ts,
      line: (n: number): string => S.contextFile.failedItem(n, entry.method, redactUrl(entry.url), outcomeText(entry)),
    })),
  ].sort((a, b) => a.ts - b.ts);
  const shown = items.slice(0, CONTEXT_LIMITS.errors);
  const lines = shown.map((item, index) => item.line(index + 1));
  if (items.length > shown.length) lines.push(S.contextFile.more(items.length - shown.length));
  const label = pageLabel(input.pageUrl);
  const head = header(S.contextFile.errorsTitle(label), page(input.pageUrl), 'absent');
  return { kind: 'errors', label, markdown: assemble([{ text: head }, { text: S.contextFile.pageDataNote }, { data: lines.join('\n') }]) };
}
