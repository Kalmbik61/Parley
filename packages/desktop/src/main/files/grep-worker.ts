/**
 * Воркер поиска (`worker_threads`, спека 10.3 и 10.8, кусок 7.1b): поиск без git и
 * подсветка `ranges` у строк `git grep`. Регулярка человека по тексту агента исполняется
 * только здесь: катастрофический откат (`(a+)+$`) в потоке main остановил бы события хоста
 * и вывод терминалов, а синхронный `exec` не прерывается ничем, кроме `terminate()`.
 *
 * В сборке воркер создаёт `?nodeWorker` electron-vite, в тестах — `new Worker` по исходнику
 * (Node 22 снимает типы сам). Поэтому здесь только встроенные модули Node и `import type`.
 * Найденное уходит по файлу на сообщение: остановленный `terminate()` воркер отдаёт то, что
 * успел.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import type { GrepHit, GrepQuery, GrepResult } from '../../shared/files-types.js';

/** Пределы поиска (таблица чисел): 2000 совпадений, 200 файлов. */
export const GREP_LIMITS = { hits: 2000, files: 200 } as const;
/** Файлы больше 20 МБ поиск пропускает — тот же предел, что у чтения в редактор. */
export const GREP_MAX_FILE_BYTES = 20 * 1024 * 1024;
/**
 * Текст попадания — окно до 1000 кодовых единиц вокруг первого совпадения: строка минифицированного
 * файла бывает в мегабайты, а попаданий в ответе до 2000 — окну незачем копировать гигабайты.
 */
export const HIT_TEXT_LIMIT = 1000;
/** NUL в первых 8 КБ — двоичный, как `-I` у git. */
const BINARY_PROBE_BYTES = 8192;

export type GrepJob =
  | { kind: 'ranges'; query: GrepQuery; files: GrepResult['files'] }
  | { kind: 'walk'; query: GrepQuery; rootPath: string; paths: string[] };

export type GrepWorkerMessage =
  | { type: 'file'; file: GrepResult['files'][number] }
  | { type: 'done'; truncated: boolean };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Регулярка запроса; битая регулярка человека — null (совпадений нет), а не падение воркера. */
function compile(query: GrepQuery): RegExp | null {
  let source = query.regex ? query.text : escapeRegExp(query.text);
  // Граница слова как у `git grep -w`: соседи совпадения — не [A-Za-z0-9_].
  if (query.wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  try {
    return new RegExp(source, query.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function rangesOf(re: RegExp, line: string): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m[0].length === 0) {
      // Пустое совпадение (`x*`) не подсвечивается и не должно зациклить exec.
      re.lastIndex += 1;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Совпадения в строке: [начало, конец) в кодовых единицах; регулярка и флаги — из запроса. */
export function matchRanges(query: GrepQuery, line: string): [number, number][] {
  const re = compile(query);
  return re === null ? [] : rangesOf(re, line);
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Окно строки не длиннее HIT_TEXT_LIMIT вокруг первого совпадения; ranges — от начала окна, у
 * края обрезаны. Совпадения нет (ERE git и RegExp JS разошлись, подсветка не успела) — начало
 * строки. Суррогатная пара на краю окна не режется: край сдвигается внутрь.
 */
export function clipHit(line: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
  if (line.length <= HIT_TEXT_LIMIT) return { text: line, ranges };
  const first = ranges[0];
  let start = 0;
  if (first !== undefined) {
    const [from, to] = first;
    start = to - from >= HIT_TEXT_LIMIT ? from : from - Math.floor((HIT_TEXT_LIMIT - (to - from)) / 2);
    start = Math.max(0, Math.min(start, line.length - HIT_TEXT_LIMIT));
  }
  let end = start + HIT_TEXT_LIMIT;
  if (start > 0 && isLow(line.charCodeAt(start)) && isHigh(line.charCodeAt(start - 1))) start += 1;
  if (end < line.length && isHigh(line.charCodeAt(end - 1)) && isLow(line.charCodeAt(end))) end -= 1;
  const inside: [number, number][] = [];
  for (const [from, to] of ranges) {
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b > a) inside.push([a - start, b - start]);
  }
  return { text: line.slice(start, end), ranges: inside };
}

/** Содержимое обычного файла внутри корня или null: наружу по ссылке, не файл, больше предела, двоичный. */
function readCandidate(rootPath: string, relPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(path.join(rootPath, relPath));
  } catch {
    return null;
  }
  // Обход проверил ссылки, но агент мог подменить файл ссылкой наружу после него.
  if (real !== rootPath && !real.startsWith(rootPath + path.sep)) return null;
  let fd: number;
  try {
    // O_NONBLOCK: FIFO агента иначе повесил бы open — как в `readText`.
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const data = buffer.subarray(0, read);
    if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
    return data.toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Задание целиком; `post` получает файлы по одному и в конце `done`. */
export function runJob(job: GrepJob, post: (message: GrepWorkerMessage) => void): void {
  const re = compile(job.query);
  if (job.kind === 'ranges') {
    for (const file of job.files) {
      post({
        type: 'file',
        file: {
          path: file.path,
          hits: file.hits.map((hit) => ({ ...hit, ...clipHit(hit.text, re === null ? [] : rangesOf(re, hit.text)) })),
        },
      });
    }
    post({ type: 'done', truncated: false });
    return;
  }
  if (re === null) {
    post({ type: 'done', truncated: false });
    return;
  }
  let files = 0;
  let hitCount = 0;
  for (const relPath of job.paths) {
    const text = readCandidate(job.rootPath, relPath);
    if (text === null) continue;
    const lines = text.split('\n');
    // Последний '\n' файла не даёт лишней пустой строки.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const hits: GrepHit[] = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const ranges = rangesOf(re, line);
      if (ranges.length === 0) continue;
      if (hitCount >= GREP_LIMITS.hits || (hits.length === 0 && files >= GREP_LIMITS.files)) {
        truncated = true;
        break;
      }
      hits.push({ line: i + 1, ...clipHit(line, ranges) });
      hitCount += 1;
    }
    if (hits.length > 0) {
      files += 1;
      post({ type: 'file', file: { path: relPath, hits } });
    }
    if (truncated) {
      post({ type: 'done', truncated: true });
      return;
    }
  }
  post({ type: 'done', truncated: false });
}

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  port.once('message', (job: GrepJob) => runJob(job, (message) => port.postMessage(message)));
}
