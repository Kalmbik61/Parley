import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

/**
 * Минимальный zip-писатель без зависимостей (формат PKWARE APPNOTE): метод 8 (deflate),
 * локальный заголовок с флагом бита 3 и дескриптором данных после данных, центральный
 * каталог и EOCD в конце. Zip64 не поддерживается: архив диагностики много меньше 4 ГиБ,
 * а переполнение поля поднимет `RangeError` из `writeUInt32LE`, а не тихо испортит файл.
 */

/** Кусок чтения файла и разбивки Buffer: логи (до 10 МиБ) не держим в памяти целиком. */
const CHUNK_BYTES = 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const VERSION = 20;
const METHOD_DEFLATE = 8;
/** Бит 3 — crc и размеры лежат в дескрипторе после данных, а не в локальном заголовке. */
const FLAG_DESCRIPTOR = 0x0008;
/** Бит 11 — имя в UTF-8; ставится только когда в имени есть не-ASCII. */
const FLAG_UTF8 = 0x0800;

export interface ZipEntry {
  name: string;
  source: Buffer | string | { file: string };
}

/** Что нужно центральному каталогу про уже записанную запись. */
interface WrittenEntry {
  name: Buffer;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Время и дата в формате MS-DOS: локальные, разрешение секунд — 2 с, годы с 1980. */
function dosDateTime(now: Date): { time: number; date: number } {
  const year = Math.max(now.getFullYear(), 1980);
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

function* sliceBuffer(data: Buffer): Generator<Buffer> {
  for (let start = 0; start < data.length; start += CHUNK_BYTES) {
    yield data.subarray(start, start + CHUNK_BYTES);
  }
}

/**
 * Пишет zip в `${target}.tmp` и переименовывает в `target`. Запись `{ file }`, которой нет
 * на диске, пропускается и попадает в `skipped`; остальные пишутся. Любой другой сбой
 * (чтение, запись) убирает `.tmp` и поднимается наружу. `now` — только для проверки
 * DOS-метки в тестах.
 */
export async function writeZip(
  target: string,
  entries: readonly ZipEntry[],
  now: Date = new Date(),
): Promise<{ skipped: string[] }> {
  const tmp = `${target}.tmp`;
  const out = createWriteStream(tmp);
  const skipped: string[] = [];
  const written: WrittenEntry[] = [];
  const { time, date } = dosDateTime(now);
  let offset = 0;

  /** Ждёт колбэк записи: так соблюдается обратное давление, а сбой записи не теряется. */
  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(chunk, (error) => (error ? reject(error) : resolve()));
    });

  try {
    for (const entry of entries) {
      const source = await openSource(entry.source);
      if (source === null) {
        skipped.push(entry.name);
        continue;
      }

      const name = Buffer.from(entry.name, 'utf8');
      const flags = FLAG_DESCRIPTOR | (name.length === entry.name.length ? 0 : FLAG_UTF8);
      const entryOffset = offset;

      // Локальный заголовок: crc и размеры нули, настоящие — в дескрипторе.
      const header = Buffer.alloc(30);
      header.writeUInt32LE(SIG_LOCAL, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(METHOD_DEFLATE, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      offset += header.length + name.length;

      let crc = 0;
      let size = 0;
      let compressedSize = 0;
      await pipeline(
        source,
        // crc32 и исходный размер копятся по ходу потока, без второго прохода.
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            done(null, chunk);
          },
        }),
        createDeflateRaw(),
        // Колбэк записи не зовём, пока кусок не ушёл на диск: так работает обратное давление.
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            compressedSize += chunk.length;
            out.write(chunk, done);
          },
        }),
      );
      offset += compressedSize;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      offset += descriptor.length;

      written.push({ name, flags, crc, compressedSize, size, offset: entryOffset });
    }

    // Центральный каталог.
    const directoryOffset = offset;
    for (const item of written) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(SIG_CENTRAL, 0);
      record.writeUInt16LE(VERSION, 4); // версия создателя
      record.writeUInt16LE(VERSION, 6); // версия для распаковки
      record.writeUInt16LE(item.flags, 8);
      record.writeUInt16LE(METHOD_DEFLATE, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(item.crc, 16);
      record.writeUInt32LE(item.compressedSize, 20);
      record.writeUInt32LE(item.size, 24);
      record.writeUInt16LE(item.name.length, 28);
      record.writeUInt32LE(item.offset, 42);
      await write(record);
      await write(item.name);
      offset += record.length + item.name.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(written.length, 8);
    eocd.writeUInt16LE(written.length, 10);
    eocd.writeUInt32LE(offset - directoryOffset, 12);
    eocd.writeUInt32LE(directoryOffset, 16);
    await write(eocd);

    out.end();
    await finished(out);
    await rename(tmp, target);
  } catch (error) {
    out.destroy();
    await rm(tmp, { force: true });
    throw error;
  }
  return { skipped };
}

/**
 * Поток данных записи. Для `{ file }` ждёт открытия файла, чтобы отсутствующий файл
 * отличить до записи заголовка: `null` — пропустить, архив остаётся целым.
 */
async function openSource(source: ZipEntry['source']): Promise<Readable | null> {
  if (typeof source === 'string') return Readable.from(sliceBuffer(Buffer.from(source, 'utf8')), { objectMode: false });
  if (Buffer.isBuffer(source)) return Readable.from(sliceBuffer(source), { objectMode: false });

  const stream = createReadStream(source.file, { highWaterMark: CHUNK_BYTES });
  return new Promise((resolve) => {
    const onOpen = () => {
      stream.off('error', onError);
      resolve(stream);
    };
    const onError = () => {
      stream.off('open', onOpen);
      resolve(null);
    };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
}
