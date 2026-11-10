/**
 * Сжатие журналов хуков (`events/<session-id>.jsonl`) спящих и закрытых сессий на старте хоста.
 *
 * Журнал только растёт, а читатель (`openEvents`) разбирает его целиком при первом чтении. Здесь у
 * журнала отрезается голова, которая ничего не меняет в свёртке `activityOf`: хвост — самый короткий
 * суффикс файла по байтам, начинающийся не позже последнего `SessionStart` запуска, чья свёртка равна
 * свёртке всего журнала. Запуск сбрасывает всё, кроме фазы хода и `turnEndedAt`; равенство выхода
 * проверяется, а не предполагается.
 *
 * Данные необратимо теряются, поэтому: журнал не трогается, если что-то не сошлось; хвост пишется во
 * временный файл рядом, а старый остаётся до успешного `rename`; перед `rename` размер и mtime
 * журнала сверяются с прочитанными (дописанную за это время строку не потерять); mtime хвоста равен
 * mtime старого файла — читатель присваивает событиям время файла, и оно не сдвигается.
 */

import { isDeepStrictEqual } from 'node:util';
import { chmod, open, rename, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { isLaunchSource, activityOf } from './activity.js';
import { eventRecordOf, type EventRecord } from './events.js';
import { workPaths } from './store.js';
import type { WorkEntry } from './works.js';

/** Журнал больше этого размера в байтах сжимается; меньший не трогается. */
export const JOURNAL_ROTATE_BYTES = 1024 * 1024;

/** Сколько начал строк перебирается вниз от последнего `SessionStart` запуска в поисках равной свёртки. */
export const JOURNAL_CUT_SEARCH = 1000;

/** Сколько миллисекунд проход по журналам работ тратит на старте; дальше оставшиеся журналы не трогаются. */
export const JOURNAL_ROTATE_BUDGET_MS = 2000;

/** Размер файла до сжатия и после. */
export interface JournalRotation {
  before: number;
  after: number;
}

const NEWLINE = 0x0a;
/** Проб между уступками циклу событий. */
const PROBES_PER_YIELD = 50;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Читает файл целиком; `size` и `mtimeMs` берутся с того же дескриптора. */
async function readWhole(file: string): Promise<{ data: Buffer; size: number; mtimeMs: number; mtime: Date; atime: Date; mode: number; ino: number } | null> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const data = Buffer.alloc(info.size);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await handle.read(data, read, data.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    // Файл успел сократиться (его переписали): не наш случай.
    if (read !== data.length) return null;
    return { data, size: info.size, mtimeMs: info.mtimeMs, mtime: info.mtime, atime: info.atime, mode: info.mode, ino: info.ino };
  } finally {
    await handle.close();
  }
}

/**
 * Сжимает один журнал. `null` — не тронут: нечего резать, нет равной свёртки в пределах поиска, файл
 * менялся во время работы, не хватило срока или что-то не удалось. Повторный вызов на сжатом файле
 * ничего не меняет и тоже отдаёт `null`.
 */
export async function rotateJournal(file: string, deadline = Number.POSITIVE_INFINITY): Promise<JournalRotation | null> {
  const tmp = `${file}.tmp`;
  try {
    const whole = await readWhole(file);
    if (whole === null) return null;

    // Строки так, как их видит `openEvents`: полные (с переводом строки), битые и пустые пропускаются.
    const events: EventRecord[] = [];
    const starts: number[] = [];
    const at = whole.mtime.toISOString();
    let lineStart = 0;
    for (let i = whole.data.indexOf(NEWLINE); i !== -1; i = whole.data.indexOf(NEWLINE, lineStart)) {
      const text = whole.data.subarray(lineStart, i).toString('utf8');
      if (text.trim() !== '') {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const event = eventRecordOf(parsed, at);
        if (event !== null) {
          events.push(event);
          starts.push(lineStart);
        }
      }
      lineStart = i + 1;
    }

    let launch = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event !== undefined && event.name === 'SessionStart' && isLaunchSource(event.source)) {
        launch = i;
        break;
      }
    }
    if (launch <= 0) return null;

    const now = Date.parse(at);
    const full = activityOf({ events, now });
    let cut = -1;
    let probes = 0;
    for (let k = launch; k > 0 && probes < JOURNAL_CUT_SEARCH; k -= 1, probes += 1) {
      if (probes % PROBES_PER_YIELD === PROBES_PER_YIELD - 1) {
        await yieldToLoop();
        if (Date.now() > deadline) return null;
      }
      if (isDeepStrictEqual(activityOf({ events: events.slice(k), now }), full)) {
        cut = k;
        break;
      }
    }
    const offset = cut > 0 ? starts[cut] : undefined;
    if (offset === undefined || offset <= 0) return null;

    const tail = whole.data.subarray(offset);
    const out = await open(tmp, 'w', whole.mode & 0o777);
    try {
      await out.writeFile(tail);
      await out.sync();
    } finally {
      await out.close();
    }
    await chmod(tmp, whole.mode & 0o777);
    await utimes(tmp, whole.atime, whole.mtime);

    // Дописанная за время работы строка (хук, хост, MCP агента) сдвинула бы размер или mtime: тогда журнал остаётся как был.
    const now2 = await stat(file);
    if (now2.size !== whole.size || now2.mtimeMs !== whole.mtimeMs || now2.ino !== whole.ino) {
      await unlink(tmp).catch(() => {});
      return null;
    }
    await rename(tmp, file);
    return { before: whole.size, after: tail.length };
  } catch {
    await unlink(tmp).catch(() => {});
    return null;
  }
}

/**
 * Сжимает журналы спящих и закрытых сессий работ из снимка — других не трогает: у `active` есть процесс,
 * который может дописать строку, а службы хранят позиции в массиве событий живых сессий. Вызывается
 * на старте хоста после сверки живости, до первого читателя. Ошибка по одному файлу не мешает остальным;
 * по исходу `budgetMs` оставшиеся журналы дожидаются следующего старта.
 */
export async function rotateWorkJournals(
  entries: readonly WorkEntry[],
  budgetMs = JOURNAL_ROTATE_BUDGET_MS,
): Promise<{ rotated: number; freedBytes: number }> {
  const deadline = Date.now() + budgetMs;
  let rotated = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    const dir = workPaths(entry.projectPath, entry.map.work.id).events;
    for (const session of entry.map.sessions) {
      if (Date.now() > deadline) return { rotated, freedBytes };
      if (session.lifecycle !== 'sleeping' && session.lifecycle !== 'closed') continue;
      const file = path.join(dir, `${session.id}.jsonl`);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size <= JOURNAL_ROTATE_BYTES) continue;
        const result = await rotateJournal(file, deadline);
        if (result === null) continue;
        rotated += 1;
        freedBytes += result.before - result.after;
      } catch {
        // Файла нет или он не читается: журнал остаётся как был.
      }
    }
  }
  return { rotated, freedBytes };
}
