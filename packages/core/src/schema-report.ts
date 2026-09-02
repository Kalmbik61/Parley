import { forEachJsonlRecord, type RawRecord } from './jsonl.js';

export interface FieldReport {
  /** Сколько раз поле встретилось. */
  seen: number;
  /** Какого типа были значения: string, number, object, array, null. */
  kinds: Record<string, number>;
  /** Первое скалярное значение — чтобы понять, что там вообще лежит. */
  sample: string | number | boolean | null;
}

export interface TypeReport {
  count: number;
  fields: Record<string, FieldReport>;
}

/** Отчёт по схеме: тип записи → его поля. */
export type SchemaReport = Record<string, TypeReport>;

/** Глубже этого уровня во вложенные объекты не спускаемся: отчёт станет нечитаемым. */
const MAX_DEPTH = 4;
const MAX_SAMPLE = 120;

const kindOf = (value: unknown): string =>
  Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

/**
 * Ключ вида `trackedFileBackups./Users/…/file.ts` — это не поле схемы, а элемент
 * мапы. Такие сегменты схлопываем: иначе отчёт распухает и тащит в себя пути.
 */
const isDynamicKey = (key: string): boolean => key.includes('/') || key.includes('\\');

/** Добавляет одну запись в отчёт. Ничего не считает обязательным. */
export function observeRecord(
  report: SchemaReport,
  record: unknown,
  prefix = '',
  type?: string,
): void {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return;

  const raw = record as RawRecord;
  const kind = type ?? (typeof raw['type'] === 'string' ? (raw['type'] as string) : 'unknown');

  const entry = (report[kind] ??= { count: 0, fields: {} });
  if (prefix === '') entry.count++;

  for (const [key, value] of Object.entries(raw)) {
    const name = prefix + (isDynamicKey(key) ? '<key>' : key);
    const field = (entry.fields[name] ??= { seen: 0, kinds: {}, sample: null });

    field.seen++;
    const valueKind = kindOf(value);
    field.kinds[valueKind] = (field.kinds[valueKind] ?? 0) + 1;

    if (field.sample === null && ['string', 'number', 'boolean'].includes(valueKind)) {
      field.sample =
        typeof value === 'string' && value.length > MAX_SAMPLE
          ? `${value.slice(0, MAX_SAMPLE)}…`
          : (value as string | number | boolean);
    }

    if (valueKind === 'object' && prefix.split('.').length < MAX_DEPTH) {
      observeRecord(report, value, `${name}.`, kind);
    }
  }
}

export interface SchemaReportResult {
  report: SchemaReport;
  files: number;
  records: number;
  /** Битые строки — норма для сессии, которую пишут прямо сейчас. */
  malformed: number;
}

/**
 * Строит отчёт по схеме для набора .jsonl.
 *
 * Формат недокументирован и меняется между релизами: отчёт — то, по чему видно,
 * что он поехал, и нужен новый адаптер (specs/data-layer.md).
 */
export async function buildSchemaReport(files: string[]): Promise<SchemaReportResult> {
  const report: SchemaReport = {};
  let records = 0;
  let malformed = 0;

  for (const file of files) {
    const stats = await forEachJsonlRecord(file, (record) => {
      observeRecord(report, record);
      records++;
    });
    malformed += stats.malformed;
  }

  return { report, files: files.length, records, malformed };
}
