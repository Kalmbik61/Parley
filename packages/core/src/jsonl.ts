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
 */
export async function forEachJsonlRecord(
  file: string,
  onRecord: (record: RawRecord, lineNo: number) => void,
): Promise<JsonlStats> {
  const stats: JsonlStats = { lines: 0, parsed: 0, malformed: 0, lastLineMalformed: false };
  const rl = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
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
