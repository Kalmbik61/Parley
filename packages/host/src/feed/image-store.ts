/**
 * Файлы картинок ленты (план 2026-10-09, Task 3). Лента несёт ссылки на файлы, а base64 из результатов
 * инструментов хост кладёт сюда: `<дом Parley>/feed-images/<24 hex sha256>.<png|jpg|webp|gif>`.
 *
 * Запись синхронная (`writeFileSync`): `onHook` отвечает хуку сразу, и порядок событий нельзя менять
 * ожиданием диска. Имя — первые 24 hex sha256 байтов, поэтому та же картинка не пишется дважды (в
 * журнале Claude она стоит и в `toolUseResult`, и в `tool_result`, а журнал читается снова при каждом
 * севе). Каталог 0700, файлы 0600; файл пишется во временный и переименовывается: оборванная запись не
 * оставит обрезанную картинку под настоящим именем.
 *
 * Наружу ничего не бросается. Нельзя взять картинку (неизвестный тип, пустые, битые или слишком большие
 * данные) — `null` молча. Ошибка файловой системы — `null` и одна строка `console.warn` с кодом ошибки,
 * без данных.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { FEED_IMAGE_MAX_BYTES, FEED_IMAGE_TTL_MS } from '@parley/core';
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
/** Расширение временного файла записи. */
const TEMP_EXTENSION = 'tmp';
/** Имена, которые пишет само хранилище (и его недописанные временные файлы): `sweep` трогает только их. */
const OWN_NAME = new RegExp(
  `^[0-9a-f]{${NAME_HEX_LENGTH}}\\.(?:${[...EXTENSIONS.values()].join('|')})(?:\\.${TEMP_EXTENSION})?$`,
);
/** Base64 в обычном или url-алфавите, с переводами строк и без паддинга; всё прочее — битые данные. */
const BASE64 = /^[A-Za-z0-9+/_\-\s]*={0,2}\s*$/;
/** Каталога нет или на его месте не каталог: убирать нечего. */
const NOTHING_TO_SWEEP: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

export type SaveFeedImage = (base64: string, mime: string) => FeedImageRef | null;

export interface FeedImageStore {
  /** Кладёт картинку в файл и отдаёт ссылку; `null` — в ленту её не берём. Не бросает. */
  save: SaveFeedImage;
  /** Убирает файлы старше `FEED_IMAGE_TTL_MS`. Не бросает. */
  sweep(): void;
}

export interface FeedImageStoreOptions {
  /** Каталог файлов; заводится при первой записи. */
  dir: string;
  /** Часы для `sweep`; по умолчанию `Date.now`. */
  now?: () => number;
  /** Предел картинки после декодирования; по умолчанию `FEED_IMAGE_MAX_BYTES`. */
  maxBytes?: number;
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

  function write(file: string, bytes: Buffer): void {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const temporary = `${file}.${TEMP_EXTENSION}`;
    writeFileSync(temporary, bytes, { mode: FILE_MODE });
    renameSync(temporary, file);
  }

  return {
    save(base64, mime) {
      const extension = EXTENSIONS.get(mime);
      if (extension === undefined) return null;
      try {
        const bytes = decode(base64, maxBytes);
        if (bytes === null) return null;
        const name = createHash('sha256').update(bytes).digest('hex').slice(0, NAME_HEX_LENGTH);
        const file = path.join(dir, `${name}.${extension}`);
        if (!existsSync(file)) write(file, bytes);
        return { path: file, mime, bytes: bytes.length };
      } catch (error) {
        console.warn('[parley] feed image', codeOf(error));
        return null;
      }
    },

    sweep() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if (!NOTHING_TO_SWEEP.has(codeOf(error)))
          console.warn('[parley] feed image', codeOf(error));
        return;
      }
      const cutoff = now() - FEED_IMAGE_TTL_MS;
      for (const name of names) {
        if (!OWN_NAME.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const info = lstatSync(file);
          if (info.isFile() && info.mtimeMs < cutoff) unlinkSync(file);
        } catch {
          // Файл ушёл сам или не удаляется — уберётся в следующий раз.
        }
      }
    },
  };
}
