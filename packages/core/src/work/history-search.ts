import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseBacklog } from './backlog.js';
import type { ProjectContextOptions } from './project-context.js';
import { parseProjectMemory } from './project-memory.js';
import { stateDir } from './state-dir.js';
import { MISSING_SHARED_VERSION, readMap, readSharedFile, sharedProjectPaths } from './store.js';
import type { SharedProjectPaths } from './store.js';

/**
 * Поиск по прошлому проекта (спека памяти и журнала, раздел 6). Индекса нет: файлы и карты читаются при каждом
 * запросе. Только записи самого проекта — каталоги скиллов и личная память CLI не читаются.
 */
export const HISTORY_SCOPES = ['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions', 'all'] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];
export type HistorySource = Exclude<HistoryScope, 'all'>;
const SOURCES: readonly HistorySource[] = ['decisions', 'memory', 'plans', 'backlog', 'history', 'sessions'];

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 30;
const MAX_QUERY_LENGTH = 1000;
const MAX_WORDS = 16;
const EXCERPT_LENGTH = 240;
const EXCERPT_LEAD = 80;
const TITLE_LENGTH = 200;

export class HistorySearchError extends Error {
  constructor(readonly code: 'search-invalid') { super(code); this.name = 'HistorySearchError'; }
}

export interface HistorySearchInput { query: string; scope?: HistoryScope; limit?: number }
/**
 * Одна находка. Отрывок ограничен: `complete` — он покрывает запись целиком; полный текст читают по `file` и `line`
 * (или по карте для сессии). `hash` — отпечаток всей записи, по нему известный текст не загружают повторно.
 */
export interface HistoryHit {
  source: HistorySource;
  title: string;
  excerpt: string;
  /** ISO-время записи; `null` — у записи даты нет (память и бэклог её не хранят). */
  date: string | null;
  /** Абсолютный путь файла-источника; у итога сессии файла нет. */
  file?: string;
  /** Строка файла (с 1), где стоит найденное место. */
  line?: number;
  id?: string;
  workId?: string;
  roomId?: string;
  sessionId?: string;
  /** Память: `current` или `superseded`; бэклог: `open` или `done`. */
  state?: string;
  /** Запись взята из выложенного снимка истории (`history-shared`). */
  shared?: true;
  /** Локальная запись, у которой есть та же в выложенном снимке: показана одна, локальная. */
  alsoShared?: true;
  complete: boolean;
  /** Длина всей записи в знаках. */
  length: number;
  /** Первые 16 знаков sha256 текста записи. */
  hash: string;
}
export interface HistorySearchResult {
  query: string;
  scope: HistoryScope;
  limit: number;
  /** Сколько записей подошло; больше `hits.length` — результат обрезан лимитом. */
  total: number;
  hits: HistoryHit[];
  /** Источники, которые не удалось прочесть целиком (конфликт, ошибка чтения, нет общего контекста проекта). */
  unavailable: HistorySource[];
}

interface Rec {
  source: HistorySource; title: string; text: string; date: string | null;
  file?: string; line?: number; id?: string; workId?: string; roomId?: string; sessionId?: string;
  state?: string; shared?: true; alsoShared?: true;
}

/** Нижний регистр без смены длины: смещения в свёрнутом тексте остаются смещениями в исходном. */
const fold = (value: string): string => Array.from(value, ch => { const low = ch.toLowerCase(); return low.length === ch.length ? low : ch; }).join('');
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const splitLines = (text: string): string[] => text.split(/\r\n|\n|\r/);
const firstLine = (text: string): string => text.split(/\r\n|\n|\r/).find(row => row.trim() !== '')?.trim() ?? '';
const time = (date: string | null): number => { const value = date === null ? NaN : Date.parse(date); return Number.isFinite(value) ? value : -Infinity; };
const latest = (text: string): string | null => {
  const dates = text.match(/\d{4}-\d{2}-\d{2}T[\w:.+-]+/g)?.filter(value => Number.isFinite(Date.parse(value))) ?? [];
  return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
};
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

function validate(input: HistorySearchInput): { words: string[]; scope: HistoryScope; limit: number } {
  const { query, scope = 'all', limit = DEFAULT_SEARCH_LIMIT } = input;
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) throw new HistorySearchError('search-invalid');
  const words = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (words.length === 0 || words.length > MAX_WORDS) throw new HistorySearchError('search-invalid');
  if (!HISTORY_SCOPES.includes(scope)) throw new HistorySearchError('search-invalid');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new HistorySearchError('search-invalid');
  return { words, scope, limit };
}

/** Обычные `.md` файлы каталога по имени; симлинки и подкаталоги пропускаются. Нет каталога — нет файлов. */
async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(row => row.isFile() && row.name.endsWith('.md')).map(row => row.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Куски файла по границам-строкам; кусок до первой границы — вступление. Пустые хвостовые строки отбрасываются. */
function chunks(source: string, isBoundary: (line: string) => boolean): { start: number; lines: string[] }[] {
  const out: { start: number; lines: string[] }[] = [];
  splitLines(source).forEach((line, index) => {
    if (isBoundary(line) || out.length === 0) out.push({ start: index, lines: [] });
    out[out.length - 1]!.lines.push(line);
  });
  for (const part of out) while (part.lines.length > 0 && part.lines[part.lines.length - 1]!.trim() === '') part.lines.pop();
  return out.filter(part => part.lines.length > 0);
}

/** Строки (с 1) пунктов `- …` по порядку: парсеры пунктов смещений не отдают. */
function itemLines(source: string, needles: readonly string[]): (number | undefined)[] {
  const lines = splitLines(source);
  let cursor = 0;
  return needles.map(needle => {
    for (let index = cursor; index < lines.length; index++) {
      if (lines[index]!.startsWith('- ') && lines[index]!.includes(needle)) { cursor = index + 1; return index + 1; }
    }
    return undefined;
  });
}

async function decisionRecords(paths: SharedProjectPaths, fail: () => void): Promise<Rec[]> {
  const recs: Rec[] = [];
  for (const name of await markdownFiles(paths.decisions)) {
    try {
      const file = path.join(paths.decisions, name);
      const snapshot = await readSharedFile(file);
      if (snapshot.version === MISSING_SHARED_VERSION) continue;
      const parsed = /^(\d{4}-\d{2}-\d{2})-(w-\d+)-(r-\d+)-(p-\d+)-rev-\d+\.md$/.exec(name);
      recs.push({ source: 'decisions', file, line: 1, title: firstLine(snapshot.text).replace(/^#+\s*/, ''), text: snapshot.text,
        date: latest(/^Accepted: (.*)$/m.exec(snapshot.text)?.[1] ?? '') ?? (parsed ? parsed[1]! : null),
        ...(parsed ? { workId: parsed[2]!, roomId: parsed[3]!, id: parsed[4]! } : {}) });
    } catch { fail(); }
  }
  return recs;
}

async function memoryRecords(paths: SharedProjectPaths): Promise<Rec[]> {
  const snapshot = await readSharedFile(paths.memory);
  if (snapshot.version === MISSING_SHARED_VERSION) return [];
  const items = parseProjectMemory(snapshot.text);
  const lines = itemLines(snapshot.text, items.map(item => item.fact));
  return items.map((item, index) => ({
    source: 'memory', file: paths.memory, title: item.fact, date: null, state: item.state ?? item.provenance?.state ?? 'current',
    text: item.details ? `${item.fact}\n${item.details}` : item.fact,
    ...(lines[index] === undefined ? {} : { line: lines[index]! }), ...(item.id === null ? {} : { id: item.id }),
  }));
}

async function backlogRecords(paths: SharedProjectPaths): Promise<Rec[]> {
  const snapshot = await readSharedFile(paths.backlog);
  if (snapshot.version === MISSING_SHARED_VERSION) return [];
  const items = parseBacklog(snapshot.text);
  const lines = itemLines(snapshot.text, items.map(item => item.title));
  return items.map((item, index) => ({
    source: 'backlog', file: paths.backlog, title: item.title, date: null, state: item.checked ? 'done' : 'open',
    text: item.details ? `${item.title}\n${item.details}` : item.title,
    ...(lines[index] === undefined ? {} : { line: lines[index]! }), ...(item.id === null ? {} : { id: item.id }),
  }));
}

/** Снимок плана режется на вступление, цель, пункты и итог: запись — пункт. */
async function planRecords(paths: SharedProjectPaths, fail: () => void): Promise<Rec[]> {
  const recs: Rec[] = [];
  for (const name of await markdownFiles(paths.plans)) {
    try {
      const file = path.join(paths.plans, name);
      const snapshot = await readSharedFile(file);
      if (snapshot.version === MISSING_SHARED_VERSION) continue;
      const parsed = /^(w-\d+)-(r-\d+)-(pl-\d+)-rev-\d+-\w+\.md$/.exec(name);
      const date = latest(/^Accepted: (.*)$/m.exec(snapshot.text)?.[1] ?? '');
      for (const part of chunks(snapshot.text, line => /^#{2,3} /.test(line))) {
        const heading = part.lines[0]!.replace(/^#+\s*/, '');
        // Заголовки «Items» и «Removed items…» стоят без тела: записи из них не делаем.
        if (part.lines.length === 1 && part.start > 0) continue;
        const item = /^### (\d+)\./.exec(part.lines[0]!)?.[1];
        recs.push({ source: 'plans', file, line: part.start + 1, title: heading, text: part.lines.join('\n'), date,
          ...(parsed ? { workId: parsed[1]!, roomId: parsed[2]!, id: item === undefined ? parsed[3]! : `${parsed[3]!}#${item}` } : {}) });
      }
    } catch { fail(); }
  }
  return recs;
}

/** Лента комнаты: вступление и по записи на письмо. */
async function historyRecords(dir: string, shared: boolean, fail: () => void): Promise<Rec[]> {
  const recs: Rec[] = [];
  for (const name of await markdownFiles(dir)) {
    const parsed = /^(w-\d+)-(r-\d+)\.md$/.exec(name);
    if (!parsed) continue;
    try {
      const file = path.join(dir, name);
      const snapshot = await readSharedFile(file);
      if (snapshot.version === MISSING_SHARED_VERSION) continue;
      for (const part of chunks(snapshot.text, line => /^### \d{4}-\d{2}-\d{2}T\S* — /.test(line))) {
        const letter = /^### (\d{4}-\d{2}-\d{2}T\S*) — /.exec(part.lines[0]!);
        const text = letter ? [part.lines[0]!.slice(4), ...part.lines.slice(1)].join('\n') : part.lines.join('\n');
        recs.push({ source: 'history', file, line: part.start + 1, workId: parsed[1]!, roomId: parsed[2]!, ...(shared ? { shared: true as const } : {}),
          title: letter ? firstLine(part.lines.slice(1).join('\n')) || part.lines[0]!.slice(4) : part.lines[0]!.replace(/^#+\s*/, ''), text,
          date: letter ? letter[1]! : latest(/^Created: (.*)$/m.exec(text)?.[1] ?? '') });
      }
    } catch { fail(); }
  }
  return recs;
}

/**
 * Одно письмо в локальной истории и в снимке — одна запись (ключ: имя файла и текст записи). Побеждает локальная:
 * она производная от карты и не старше снимка; у снимка остаются только письма, которых в локальной истории нет
 * (работа удалена или письмо исчезло). Локальной записи ставится `alsoShared`.
 */
function dedupeHistory(local: Rec[], shared: Rec[]): Rec[] {
  const key = (rec: Rec): string => `${path.basename(rec.file!)}\0${digest(rec.text)}`;
  const byKey = new Map(local.map(rec => [key(rec), rec]));
  return [...local, ...shared.filter(rec => {
    const twin = byKey.get(key(rec));
    if (twin) twin.alsoShared = true;
    return !twin;
  })];
}

/** Итоги и отчёты сессий из карт всех работ проекта. */
async function sessionRecords(projectPath: string, fail: () => void): Promise<Rec[]> {
  const recs: Rec[] = [];
  let works: string[];
  try {
    works = (await readdir(path.join(stateDir(projectPath), 'works'), { withFileTypes: true })).filter(row => row.isDirectory()).map(row => row.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recs;
    throw error;
  }
  for (const workId of works) {
    try {
      for (const session of (await readMap(projectPath, workId)).sessions) {
        if (session.summary === null || session.summary.trim() === '') continue;
        recs.push({ source: 'sessions', title: firstLine(session.summary), text: session.summary, workId, sessionId: session.id,
          date: session.resultAt ?? session.endedAt ?? session.startedAt });
      }
    } catch { fail(); }
  }
  return recs;
}

function excerptOf(rec: Rec, position: number): { excerpt: string; line?: number; complete: boolean } {
  const start = Math.max(0, position - EXCERPT_LEAD);
  const end = Math.min(rec.text.length, start + EXCERPT_LENGTH);
  // Окно не рвёт суррогатную пару.
  const from = start > 0 && /[\uDC00-\uDFFF]/.test(rec.text[start]!) ? start - 1 : start;
  const to = end < rec.text.length && /[\uD800-\uDBFF]/.test(rec.text[end - 1]!) ? end - 1 : end;
  const body = rec.text.slice(from, to).replace(/\s+/g, ' ').trim();
  const complete = from === 0 && to === rec.text.length;
  const newlines = rec.text.slice(0, position).split('\n').length - 1;
  return { excerpt: `${from > 0 ? '…' : ''}${body}${to < rec.text.length ? '…' : ''}`, complete,
    ...(rec.line === undefined ? {} : { line: rec.line + newlines }) };
}

/**
 * Ищет `query` в записях проекта. Все слова — в одной записи, без учёта регистра. Выше записи с совпадением в
 * заголовке (первой строке): чем больше слов запроса в нём, тем выше; затем новые; затем фиксированный порядок
 * источника, файла и строки — выдача и отрывки детерминированы. Записи без даты идут после датированных.
 */
export async function searchHistory(projectPath: string, input: HistorySearchInput, options: ProjectContextOptions = {}): Promise<HistorySearchResult> {
  const { words, scope, limit } = validate(input);
  const wanted = scope === 'all' ? SOURCES : [scope];
  const unavailable = new Set<HistorySource>();
  const recs: Rec[] = [];
  let shared: SharedProjectPaths | null = null;
  try { shared = await sharedProjectPaths(projectPath, options); } catch { /* общие источники ниже отметятся недоступными */ }
  const run = async (source: HistorySource, body: (fail: () => void) => Promise<Rec[]>): Promise<void> => {
    try { recs.push(...await body(() => unavailable.add(source))); } catch { unavailable.add(source); }
  };
  for (const source of wanted) {
    if (source === 'sessions') await run(source, fail => sessionRecords(projectPath, fail));
    else if (source === 'history') {
      await run(source, async fail => {
        const local = await historyRecords(path.join(stateDir(projectPath), 'history'), false, fail);
        if (shared === null) { unavailable.add(source); return local; }
        return dedupeHistory(local, await historyRecords(shared.historyShared, true, fail));
      });
    } else if (shared === null) unavailable.add(source);
    else if (source === 'decisions') await run(source, fail => decisionRecords(shared!, fail));
    else if (source === 'plans') await run(source, fail => planRecords(shared!, fail));
    else if (source === 'memory') await run(source, () => memoryRecords(shared!));
    else await run(source, () => backlogRecords(shared!));
  }
  const matched: { rec: Rec; position: number; titleHits: number }[] = [];
  for (const rec of recs) {
    const text = fold(rec.text);
    const positions = words.map(word => text.indexOf(word));
    if (positions.some(position => position < 0)) continue;
    const title = fold(rec.title);
    matched.push({ rec, position: Math.min(...positions), titleHits: words.filter(word => title.includes(word)).length });
  }
  matched.sort((a, b) => b.titleHits - a.titleHits || cmp(time(b.rec.date), time(a.rec.date)) ||
    cmp(SOURCES.indexOf(a.rec.source), SOURCES.indexOf(b.rec.source)) || cmp(a.rec.file ?? '', b.rec.file ?? '') ||
    cmp(a.rec.line ?? 0, b.rec.line ?? 0) || cmp(a.rec.workId ?? '', b.rec.workId ?? '') || cmp(a.rec.sessionId ?? '', b.rec.sessionId ?? '') ||
    cmp(a.rec.id ?? '', b.rec.id ?? ''));
  const hits = matched.slice(0, limit).map(({ rec, position }): HistoryHit => {
    const { excerpt, line, complete } = excerptOf(rec, position);
    return { source: rec.source, title: rec.title.length > TITLE_LENGTH ? `${rec.title.slice(0, TITLE_LENGTH)}…` : rec.title, excerpt, date: rec.date,
      ...(rec.file === undefined ? {} : { file: rec.file }), ...(line === undefined ? {} : { line }),
      ...(rec.id === undefined ? {} : { id: rec.id }), ...(rec.workId === undefined ? {} : { workId: rec.workId }),
      ...(rec.roomId === undefined ? {} : { roomId: rec.roomId }), ...(rec.sessionId === undefined ? {} : { sessionId: rec.sessionId }),
      ...(rec.state === undefined ? {} : { state: rec.state }), ...(rec.shared ? { shared: true as const } : {}),
      ...(rec.alsoShared ? { alsoShared: true as const } : {}), complete, length: rec.text.length, hash: digest(rec.text).slice(0, 16) };
  });
  return { query: input.query, scope, limit, total: matched.length, hits, unavailable: SOURCES.filter(source => unavailable.has(source)) };
}
