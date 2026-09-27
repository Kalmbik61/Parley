/**
 * Ссылки терминала (кусок 5.3, спека 8.3): пути и адреса в выводе агента.
 *
 * `WebLinksAddon` больше не используется: его провайдер строил
 * `new RegExp(source, flags + 'g')` и на регулярке с флагом `g` падал
 * `SyntaxError` («flags 'gg'») на каждом наведении. Здесь регулярки создаются
 * один раз и сразу с `gu`; `lastIndex` сбрасывается перед каждым проходом.
 *
 * Путь становится ссылкой, только если main нашёл его в корне работы этого
 * терминала (`files.locate`, кусок 5.2): иначе агент мог бы подсунуть ссылку на
 * что угодно на диске. Адрес — только http(s).
 */

import type { IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import type { WorkSession } from '@harnas/core';
import type { Located } from '../../shared/files-types.js';

export interface LinkCandidate {
  /**
   * Границы `[start, end)` в кодовых единицах строки, которую получила
   * `findLinkCandidates`; в ячейки буфера их переводит провайдер
   * (`createLinkProvider`) по своей карте ширин.
   */
  start: number;
  end: number;
  kind: 'path' | 'url';
  path?: string;
  line?: number;
  col?: number;
  url?: string;
}

/** Ссылка под указателем: путь — только найденный в корне своей работы, URL — только http(s). */
export type TerminalLink =
  | { kind: 'path'; absPath: string; located: Located; line?: number; col?: number }
  | { kind: 'url'; url: string };

// URL — умолчание `WebLinksAddon` 0.12 (`strictUrlRegex`): последний символ не пунктуация,
// поэтому `https://x.y/z).` даёт `https://x.y/z`. Флаги `gu` — с рождения, не дописываются.
const URL_RE = /(?:https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gu;

// Слева от пути — не символ пути: иначе `src/app/main.ts:12:3` совпал бы ещё и как
// `/app/main.ts:12:3`. `\p{L}` вместо `\w` — кириллица в именах (`./docs/Отчёт.md`).
const PATH_CHAR = String.raw`[\p{L}\p{N}_.@+\-]`;
const LINE_COL = String.raw`(?::\d+(?::\d+)?)?`;
const ABSOLUTE = String.raw`(?:~|\.{1,2})?(?:/${PATH_CHAR}+)+${LINE_COL}`;
// Относительный — только с расширением, где есть буква: `version 1.2.3` не ссылка.
const RELATIVE = String.raw`${PATH_CHAR}+(?:/${PATH_CHAR}+)*\.(?=[\p{L}\p{N}]{0,7}\p{L})[\p{L}\p{N}]{1,8}(?![\p{L}\p{N}])${LINE_COL}`;
const PATH_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_.@+\-/~])(?:${ABSOLUTE}|${RELATIVE})`, 'gu');

const TRAILING_PUNCT = /[.,;:!?)]+$/u;
const LINE_COL_TAIL = /:(\d+)(?::(\d+))?$/u;

/**
 * Пути (абсолютные, ~, ./, ../, src/a.ts:12:3) и адреса http(s) в логической строке —
 * исправленные регулярки спеки 8.3. URL важнее пути, совпадения не пересекаются.
 */
export function findLinkCandidates(lineText: string): LinkCandidate[] {
  const result: LinkCandidate[] = [];
  // Путь внутри найденного адреса не ищется: адрес заменяется пробелами той же длины,
  // индексы остальной строки не сдвигаются.
  let masked = lineText;
  URL_RE.lastIndex = 0;
  for (const match of lineText.matchAll(URL_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    result.push({ start, end, kind: 'url', url: match[0] });
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
  }
  PATH_RE.lastIndex = 0;
  for (const match of masked.matchAll(PATH_RE)) {
    let text = match[0].replace(TRAILING_PUNCT, '');
    const start = match.index;
    let line: number | undefined;
    let col: number | undefined;
    const tail = LINE_COL_TAIL.exec(text);
    const end = start + text.length;
    if (tail !== null) {
      line = Number(tail[1]);
      if (tail[2] !== undefined) col = Number(tail[2]);
      text = text.slice(0, tail.index);
    }
    if (text === '' || text === '~' || text === '.' || text === '..') continue;
    const candidate: LinkCandidate = { start, end, kind: 'path', path: text };
    if (line !== undefined) candidate.line = line;
    if (col !== undefined) candidate.col = col;
    result.push(candidate);
  }
  return result.sort((a, b) => a.start - b.start);
}

/** Наружу — только http и https, как `main/ipc.ts#isAllowedExternalUrl`. */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Лексическое снятие `.` и `..`: в рендерере нет `node:path`, выше `/` не поднимаемся. */
function normalizeAbsolute(absPath: string): string {
  const out: string[] = [];
  for (const segment of absPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

/**
 * Абсолютный путь кандидата: относительный — от cwd; `.` и `..` снимаются лексически (в рендерере
 * нет node:path), выше `/` не поднимается. `~` остаётся как есть — его раскрывает main (files.locate).
 */
export function resolveCandidatePath(candidate: LinkCandidate, cwd: string): string {
  const raw = candidate.path ?? '';
  if (raw === '~' || raw.startsWith('~/')) return raw;
  if (raw.startsWith('/')) return normalizeAbsolute(raw);
  return normalizeAbsolute(`${cwd}/${raw}`);
}

/** Кэш поверх files.locate: ключ — workKey и путь, 500 записей, 10 с жизни; null кэшируется тоже. */
export interface StatCache {
  lookup(workKey: string, absPaths: string[]): Promise<Array<Located | null>>;
}

/** Предел пачки `files.locate` на main (5.2). */
const LOCATE_BATCH = 200;

export function createStatCache(
  locate: (workKey: string, absPaths: string[]) => Promise<Array<Located | null>>,
  options: { max?: number; ttlMs?: number; now?: () => number } = {},
): StatCache {
  const max = options.max ?? 500;
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  // Порядок вставки `Map` — порядок старения: запись обновляется удалением и вставкой.
  const entries = new Map<string, { value: Located | null; at: number }>();
  const keyOf = (workKey: string, absPath: string): string => `${workKey}\n${absPath}`;

  const fresh = (key: string): { value: Located | null } | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at >= ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    async lookup(workKey, absPaths) {
      const missing = [...new Set(absPaths.filter((absPath) => fresh(keyOf(workKey, absPath)) === undefined))];
      for (let i = 0; i < missing.length; i += LOCATE_BATCH) {
        const batch = missing.slice(i, i + LOCATE_BATCH);
        const answers = await locate(workKey, batch);
        const at = now();
        batch.forEach((absPath, index) => {
          const key = keyOf(workKey, absPath);
          entries.delete(key);
          entries.set(key, { value: answers[index] ?? null, at });
          while (entries.size > max) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
        });
      }
      return absPaths.map((absPath) => entries.get(keyOf(workKey, absPath))?.value ?? null);
    },
  };
}

/** worktree.path, если worktree.createdAt !== null; иначе projectPath. */
export function sessionCwd(session: WorkSession, projectPath: string): string {
  return session.worktree !== null && session.worktree.createdAt !== null ? session.worktree.path : projectPath;
}

/** Что провайдеру нужно от xterm: ширина строки и строки буфера. */
export interface LinkBufferSource {
  readonly cols: number;
  readonly buffer: { readonly active: { getLine(y: number): IBufferLine | undefined } };
}

interface CellPos {
  x: number;
  y: number;
  width: number;
}

/**
 * Логическая строка под `y` (0-based): перенесённые строки (`isWrapped`) склеиваются с
 * предыдущей. Карта `cells` — ячейка каждой кодовой единицы текста: широкий символ
 * (CJK, эмодзи) занимает две ячейки, а в строке — одну или две единицы.
 */
export function logicalLine(source: LinkBufferSource, y: number): { text: string; cells: CellPos[] } {
  const buffer = source.buffer.active;
  let top = y;
  while (top > 0 && buffer.getLine(top)?.isWrapped === true) top -= 1;
  let bottom = y;
  while (buffer.getLine(bottom + 1)?.isWrapped === true) bottom += 1;

  let text = '';
  const cells: CellPos[] = [];
  for (let row = top; row <= bottom; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined) break;
    const width = Math.min(line.length, source.cols);
    // Пустые ячейки в хвосте строки — не пробелы: при раннем переносе широкого символа
    // xterm оставляет последнюю ячейку пустой, и пробел разорвал бы путь надвое.
    let last = width - 1;
    while (last >= 0 && (line.getCell(last)?.getChars() ?? '') === '') last -= 1;
    for (let x = 0; x <= last; x += 1) {
      const cell = line.getCell(x);
      if (cell === undefined) continue;
      const cellWidth = cell.getWidth();
      if (cellWidth === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i += 1) cells.push({ x, y: row, width: cellWidth });
    }
  }
  return { text, cells };
}

export interface LinkProviderDeps {
  /** Читаются на каждом вызове: `workKey` и `cwd` сессии могут смениться без пересоздания xterm. */
  workKey(): string;
  cwd(): string;
  cache: StatCache;
  onLink(link: TerminalLink, event: MouseEvent): void;
}

/**
 * Провайдер ссылок xterm: зовётся на строку под указателем. Кандидаты логической строки
 * уходят в `files.locate` одной пачкой (через кэш); путь, которого main не нашёл в корнях
 * этой работы, ссылкой не становится.
 */
export function createLinkProvider(source: LinkBufferSource, deps: LinkProviderDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const { text, cells } = logicalLine(source, bufferLineNumber - 1);
      const candidates = findLinkCandidates(text);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      const toRange = (candidate: LinkCandidate): ILink['range'] | null => {
        const first = cells[candidate.start];
        const last = cells[candidate.end - 1];
        if (first === undefined || last === undefined) return null;
        // Диапазон xterm — 1-based и включительно по обоим краям.
        return { start: { x: first.x + 1, y: first.y + 1 }, end: { x: last.x + last.width, y: last.y + 1 } };
      };

      const workKey = deps.workKey();
      const cwd = deps.cwd();
      const paths = candidates.filter((candidate) => candidate.kind === 'path');
      const absPaths = paths.map((candidate) => resolveCandidatePath(candidate, cwd));
      const found: Promise<Array<Located | null>> =
        absPaths.length === 0 ? Promise.resolve([]) : deps.cache.lookup(workKey, absPaths).catch(() => absPaths.map(() => null));

      void found.then((located) => {
        const links: ILink[] = [];
        const push = (candidate: LinkCandidate, link: TerminalLink): void => {
          const range = toRange(candidate);
          if (range === null) return;
          links.push({
            range,
            text: text.slice(candidate.start, candidate.end),
            activate: (event) => deps.onLink(link, event),
          });
        };
        let pathIndex = 0;
        for (const candidate of candidates) {
          if (candidate.kind === 'url') {
            if (candidate.url !== undefined && isHttpUrl(candidate.url)) push(candidate, { kind: 'url', url: candidate.url });
            continue;
          }
          const index = pathIndex;
          pathIndex += 1;
          const hit = located[index] ?? null;
          const absPath = absPaths[index];
          // Страховка: main ищет корень только среди корней этой работы, но чужой корень —
          // всё равно не ссылка.
          if (hit === null || absPath === undefined || hit.root.workKey !== workKey) continue;
          const link: TerminalLink = { kind: 'path', absPath, located: hit };
          if (candidate.line !== undefined) link.line = candidate.line;
          if (candidate.col !== undefined) link.col = candidate.col;
          push(candidate, link);
        }
        callback(links.length === 0 ? undefined : links);
      });
    },
  };
}
