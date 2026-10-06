import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Сырая запись .jsonl. Ни одно поле не обязательно — формат недокументирован. */
export type RawRecord = Record<string, unknown>;

export interface JsonlStats {
  /** непустых строк всего */
  lines: number;
  /** успешно разобранных */
  parsed: number;
  /** не разобранных */
  malformed: number;
  /**
   * Последняя непустая строка не разобралась. Для живой сессии, которую Claude Code
   * дописывает прямо сейчас, это норма, а не повреждение файла.
   */
  lastLineMalformed: boolean;
}

/**
 * Потоково читает .jsonl, отдавая каждую запись в колбэк. Файл целиком в память
 * не грузится: самый большой реальный файл сессии — 53 МБ.
 *
 * Битая строка пропускается и попадает в счётчик, парсер на ней не падает.
 *
 * `signal` прерывает чтение: файл закрывается, записи после остановки колбэк не получает,
 * промис отклоняется причиной остановки (`AbortError`) — неполный разбор за итог не сойдёт.
 */
export async function forEachJsonlRecord(
  file: string,
  onRecord: (record: RawRecord, lineNo: number) => void,
  signal?: AbortSignal,
): Promise<JsonlStats> {
  signal?.throwIfAborted();
  const stats: JsonlStats = { lines: 0, parsed: 0, malformed: 0, lastLineMalformed: false };
  const input = createReadStream(file, 'utf8');
  // Сигнал закрывает интерфейс и тогда, когда цикл ждёт следующего куска файла.
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
    ...(signal === undefined ? {} : { signal }),
  });

  let lineNo = 0;
  try {
    for await (const line of rl) {
      // Строки, прочитанные до остановки, уже не разбираются.
      if (signal?.aborted === true) break;
      lineNo++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      stats.lines++;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        stats.malformed++;
        stats.lastLineMalformed = true;
        continue;
      }

      // Строка валидного JSON может быть числом или строкой — записью считаем только объект.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        stats.malformed++;
        stats.lastLineMalformed = true;
        continue;
      }

      stats.parsed++;
      stats.lastLineMalformed = false;
      onRecord(parsed as RawRecord, lineNo);
    }
  } finally {
    // Закрытый интерфейс файл не закрывает: прерванное чтение (остановка, исключение колбэка)
    // держало бы дескриптор открытым.
    rl.close();
    input.destroy();
  }

  // Остановка, пока цикл ждал данных, выводит из него штатно, без исключения: неполный разбор
  // за итог не отдаём.
  signal?.throwIfAborted();
  return stats;
}

/** Собирает все записи файла в массив. Для тестов и мелких файлов. */
export async function readJsonlRecords(file: string): Promise<{
  records: RawRecord[];
  stats: JsonlStats;
}> {
  const records: RawRecord[] = [];
  const stats = await forEachJsonlRecord(file, (record) => records.push(record));
  return { records, stats };
}
