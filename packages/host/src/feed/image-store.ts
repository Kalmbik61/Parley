/**
 * Файлы картинок ленты (план 2026-10-09, Task 3). Лента несёт ссылки на файлы, а base64 из результатов
 * инструментов хост кладёт сюда: `<дом Parley>/feed-images/<24 hex sha256>.<png|jpg|webp|gif>`.
 *
 * Запись синхронная (`writeFileSync`): `onHook` отвечает хуку сразу, и порядок событий нельзя менять
 * ожиданием диска. Имя — первые 24 hex sha256 байтов, поэтому та же картинка не пишется дважды (в
 * журнале Claude она стоит и в `toolUseResult`, и в `tool_result`, а журнал читается снова при каждом
 * севе); повторная запись лишь обновляет файлу время, чтобы картинка, на которую живая лента ссылается
 * снова, не ушла по сроку через семь суток от первой записи. Каталог 0700, файлы 0600; файл пишется во
 * временный и переименовывается: оборванная запись не оставит обрезанную картинку под настоящим именем, а
 * сорвавшаяся не оставит и временного файла.
 *
 * Уборка (`sweep`) асинхронная: каталог может держать тысячи файлов, а хост живёт сессиями и хуками, и цикл событий
 * нельзя занимать удалением на секунды. Сначала уходят файлы старше `FEED_IMAGE_TTL_MS`, затем, пока все файлы вместе
 * тяжелее `FEED_IMAGE_MAX_TOTAL_BYTES`, самые старые по времени файла. `save` синхронный и уборки не ждёт: файл, который
 * он обновил в тот же миг, когда уборка его удаляет, пропадёт, и ссылка на него станет «Image unavailable»; та же
 * картинка при следующей записи ляжет заново.
 *
 * Наружу ничего не бросается. Нельзя взять картинку (неизвестный тип, байты не того типа, что назван, пустые,
 * битые или слишком большие данные) — `null` молча. Ошибка файловой системы — `null` и строка `console.warn`
 * с кодом ошибки, без данных, по одной на код: постоянный отказ (диск полон, нет прав) не печатает строку на
 * каждую картинку.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FEED_IMAGE_MAX_BYTES, FEED_IMAGE_MAX_TOTAL_BYTES, FEED_IMAGE_TTL_MS } from '@parley/core';
import type { FeedImageRef } from '@parley/core';

/** Сколько первых hex-знаков sha256 идёт в имя файла. */
const NAME_HEX_LENGTH = 24;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Расширение файла по типу картинки; других типов хранилище не берёт. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
/** Байты с `offset` начинаются с `text` (по одному байту на знак); короткий буфер — нет, а не чтение за его концом. */
const startsWith = (bytes: Buffer, offset: number, text: string): boolean =>
  bytes.toString('latin1', offset, offset + text.length) === text;

/**
 * Подпись начала файла каждого типа: байты после декодирования обязаны с неё начинаться. Тип приходит из чужого
 * результата, а имя файла получает расширение по нему, поэтому без подписи под `<hash>.png` лёг бы любой текст,
 * а окно потом отдало бы его системе как картинку.
 */
const SIGNATURES: ReadonlyMap<string, (bytes: Buffer) => boolean> = new Map([
  ['image/png', (bytes) => startsWith(bytes, 0, '\x89PNG')],
  ['image/jpeg', (bytes) => startsWith(bytes, 0, '\xff\xd8\xff')],
  ['image/gif', (bytes) => startsWith(bytes, 0, 'GIF8')],
  // «RIFF», четыре байта размера, «WEBP».
  ['image/webp', (bytes) => startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')],
]);
/** Расширение временного файла записи. */
const TEMP_EXTENSION = 'tmp';
/** Имена, которые пишет само хранилище (и его недописанные временные файлы): `sweep` трогает только их. */
const OWN_NAME = new RegExp(
  `^[0-9a-f]{${NAME_HEX_LENGTH}}\\.(?:${[...EXTENSIONS.values()].join('|')})(?:\\.${TEMP_EXTENSION})?$`,
);
/**
 * Base64 в обычном или url-алфавите, с переводами строк и без паддинга; всё прочее — битые данные. Пробельные
 * знаки после `=` допустимы (Node их пропускает), а в хвосте стоят только вместе с `=`: голый `\s*` рядом с
 * `\s` в классе заставил бы движок на каждой длинной цепочке пробелов с мусором в конце перебирать все её
 * разбиения, то есть расти квадратично. Строка здесь чужая (результат инструмента), а проверка идёт в
 * `onHook` и при каждом севе.
 */
const BASE64 = /^[A-Za-z0-9+/_\-\s]*(?:=\s*){0,2}$/;
/** Каталога нет или на его месте не каталог: убирать нечего. */
const NOTHING_TO_SWEEP: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

export type SaveFeedImage = (base64: string, mime: string) => FeedImageRef | null;

export interface FeedImageStore {
  /** Кладёт картинку в файл и отдаёт ссылку; `null` — в ленту её не берём. Не бросает. */
  save: SaveFeedImage;
  /**
   * Убирает файлы старше `FEED_IMAGE_TTL_MS`, затем самые старые, пока все вместе тяжелее `maxTotalBytes`. Асинхронный;
   * не бросает и не отклоняется.
   */
  sweep(): Promise<void>;
}

export interface FeedImageStoreOptions {
  /** Каталог файлов; заводится при первой записи. */
  dir: string;
  /** Часы для `sweep`; по умолчанию `Date.now`. */
  now?: () => number;
  /** Предел картинки после декодирования; по умолчанию `FEED_IMAGE_MAX_BYTES`. */
  maxBytes?: number;
  /** Предел всех файлов вместе для `sweep`; по умолчанию `FEED_IMAGE_MAX_TOTAL_BYTES`. */
  maxTotalBytes?: number;
}

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'error';

/** Байты картинки из base64; `null` — данные пусты, битые или тяжелее `maxBytes`. */
function decode(base64: string, maxBytes: number): Buffer | null {
  // Размер оценивается до декодирования: чтобы отказать огромной строке, не надо раскладывать её в память.
  if (Buffer.byteLength(base64, 'base64') > maxBytes || !BASE64.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length === 0 || bytes.length > maxBytes ? null : bytes;
}

export function createFeedImageStore(options: FeedImageStoreOptions): FeedImageStore {
  const dir = path.resolve(options.dir);
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? FEED_IMAGE_MAX_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? FEED_IMAGE_MAX_TOTAL_BYTES;
  /** Коды ошибок, о которых уже сказано. Хранилище одно на хост, так что это «раз на код за жизнь процесса». */
  const warned = new Set<string>();

  function warn(error: unknown): void {
    const code = codeOf(error);
    if (warned.has(code)) return;
    warned.add(code);
    console.warn('[parley] feed image', code);
  }

  function write(file: string, bytes: Buffer): void {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const temporary = `${file}.${TEMP_EXTENSION}`;
    try {
      writeFileSync(temporary, bytes, { mode: FILE_MODE });
      renameSync(temporary, file);
    } catch (error) {
      // Недописанный временный файл (диск полон) не должен лежать до срока `sweep`, когда места и так нет.
      try {
        unlinkSync(temporary);
      } catch {
        // Его могло и не быть.
      }
      throw error;
    }
  }

  /** Файл уже лежит и годится; его время обновляется, чтобы показанная снова картинка не ушла по сроку. */
  function refresh(file: string): void {
    try {
      const time = new Date(now());
      utimesSync(file, time, time);
    } catch {
      // Ссылка годится и без этого: файл просто уберётся по сроку от прежней записи.
    }
  }

  return {
    save(base64, mime) {
      const extension = EXTENSIONS.get(mime);
      if (extension === undefined) return null;
      try {
        const bytes = decode(base64, maxBytes);
        if (bytes === null || SIGNATURES.get(mime)?.(bytes) !== true) return null;
        const name = createHash('sha256').update(bytes).digest('hex').slice(0, NAME_HEX_LENGTH);
        const file = path.join(dir, `${name}.${extension}`);
        if (existsSync(file)) refresh(file);
        else write(file, bytes);
        return { path: file, mime, bytes: bytes.length };
      } catch (error) {
        warn(error);
        return null;
      }
    },

    async sweep() {
      try {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (error) {
          if (!NOTHING_TO_SWEEP.has(codeOf(error))) warn(error);
          return;
        }
        const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
        for (const name of names) {
          if (!OWN_NAME.test(name)) continue;
          const file = path.join(dir, name);
          try {
            const info = await lstat(file);
            if (info.isFile()) files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
          } catch {
            // Файл ушёл сам — убирать нечего.
          }
        }
        // От старых к новым: просроченные уходят первыми, затем, пока всё тяжелее предела, самые старые из свежих.
        files.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const cutoff = now() - FEED_IMAGE_TTL_MS;
        let total = files.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of files) {
          if (entry.mtimeMs >= cutoff && total <= maxTotalBytes) break;
          try {
            await unlink(entry.file);
            total -= entry.size;
          } catch {
            // Файл не удаляется — уберётся в следующий раз; уборка идёт к следующему по возрасту.
          }
        }
      } catch (error) {
        warn(error);
      }
    },
  };
}
