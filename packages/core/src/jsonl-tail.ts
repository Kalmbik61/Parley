import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RawRecord } from './jsonl.js';

/** Кусок чтения лога: больше за раз в память не берём. */
const READ_CHUNK_BYTES = 1024 * 1024;
const LF = 0x0a;
const CR = 0x0d;

/** Чтение файла для дочитывания хвоста; в тестах подменяется, чтобы видеть, что и сколько читали. */
export interface TimelineReader {
  stat(file: string): Promise<{ size: number; ino: number }>;
  open(file: string, start: number): NodeJS.ReadableStream;
}

export const DEFAULT_TIMELINE_READER: TimelineReader = {
  stat: async (file) => {
    const { size, ino } = await stat(file);
    return { size, ino };
  },
  open: (file, start) => createReadStream(file, { start, highWaterMark: READ_CHUNK_BYTES }),
};

/** До какого места файл уже разобран. Следующее чтение начинается с `offset`. */
export interface TailCursor {
  /** Байт, до которого лог разобран целыми строками. */
  offset: number;
  /** Сколько байт файла прочитано (по факту чтения, не по `stat`: файл мог дорасти между ними). */
  size: number;
  ino: number;
  /** Номер последней разобранной строки (считаются все строки, и пустые): как у `forEachJsonlRecord`. */
  lineNo: number;
  /** Последняя строка принята без `\n`: перевод строки, пришедший позже, не начинает новую пустую. */
  unterminated: boolean;
  /**
   * За `offset` лежит оборванная строка, которая пока не разбирается (полное чтение посчитало бы её битой).
   * В записи она не попала и ждёт дописывания; на итоговый `malformed` вызывающий добавляет её сам.
   */
  pendingMalformed: boolean;
}

export const EMPTY_TAIL_CURSOR: TailCursor = {
  offset: 0,
  size: 0,
  ino: 0,
  lineNo: 0,
  unterminated: false,
  pendingMalformed: false,
};

export interface TailHandler {
  /** Чтение начинается с нуля (первое, усечение, подмена файла): накопленное прежде сбрасывается. */
  reset(): void;
  record(record: RawRecord, lineNo: number): void;
}

export interface TailResult {
  cursor: TailCursor;
  /** Файла нет: курсор пустой, записей не было. */
  missing: boolean;
  /** Принято записей-объектов за это чтение (пустые строки не считаются). */
  parsed: number;
  /** Битых строк (не JSON или не объект) за это чтение, как у `forEachJsonlRecord`. */
  malformed: number;
}

type Line = { kind: 'empty' } | { kind: 'bad' } | { kind: 'ok'; record: RawRecord };

function classifyLine(line: Buffer): Line {
  const trimmed = line.toString('utf8').trim();
  if (trimmed === '') return { kind: 'empty' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { kind: 'ok', record: parsed as RawRecord }
      : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

const missingResult = (): TailResult => ({ cursor: EMPTY_TAIL_CURSOR, missing: true, parsed: 0, malformed: 0 });

/**
 * Дочитывает JSONL с `previous.offset` и отдаёт новые записи в `handler`. Усечение (файл стал короче
 * прочитанного) или подмена файла (другой `ino`) — чтение с нуля. Оборванная последняя строка ждёт следующего
 * вызова (offset остаётся на её начале); целая (JSON-объект) без `\n` принимается сразу, как у readline.
 * Нет новых байт — файл не открывается.
 */
export async function readJsonlTail(
  previous: TailCursor | null,
  file: string,
  reader: TimelineReader,
  handler: TailHandler,
): Promise<TailResult> {
  let current: { size: number; ino: number };
  try {
    current = await reader.stat(file);
  } catch (error) {
    if (isMissingFile(error)) return missingResult();
    throw error;
  }

  const keep = previous !== null && previous.ino === current.ino && current.size >= previous.size;
  if (!keep) handler.reset();
  const base: TailCursor = keep ? previous : { ...EMPTY_TAIL_CURSOR, ino: current.ino };
  const start = base.offset;

  // Ничего нового: файл открывать незачем (оборванный хвост, если он есть, остаётся прежним).
  if (current.size === base.size) return { cursor: base, missing: false, parsed: 0, malformed: 0 };

  let lineNo = base.lineNo;
  let skipLf = base.unterminated;
  let parsed = 0;
  let malformed = 0;
  let consumed = start;
  let bytesRead = 0;
  let carry: Buffer = Buffer.alloc(0);

  const take = (line: Buffer): void => {
    lineNo++;
    const found = classifyLine(line);
    if (found.kind === 'ok') {
      parsed++;
      handler.record(found.record, lineNo);
    } else if (found.kind === 'bad') {
      malformed++;
    }
  };

  let stream: NodeJS.ReadableStream;
  try {
    stream = reader.open(file, start);
  } catch (error) {
    if (isMissingFile(error)) return missingResult();
    throw error;
  }
  try {
    for await (const chunk of stream) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      bytesRead += piece.length;
      let data = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
      // Перевод строки (`\n` или `\r\n`) после уже принятой строки без `\n` — её конец, не пустая строка.
      if (skipLf && data.length > 0 && !(data[0] === CR && data.length === 1)) {
        skipLf = false;
        const skip = data[0] === LF ? 1 : data[0] === CR && data[1] === LF ? 2 : 0;
        data = data.subarray(skip);
        consumed += skip;
      }
      let pos = 0;
      for (let end = data.indexOf(LF, pos); end !== -1; end = data.indexOf(LF, pos)) {
        take(data.subarray(pos, end));
        consumed += end + 1 - pos;
        pos = end + 1;
      }
      carry = data.subarray(pos);
    }
  } catch (error) {
    if (isMissingFile(error)) return missingResult();
    throw error;
  } finally {
    (stream as { destroy?: () => void }).destroy?.();
  }

  // Хвост без `\n`: целый объект считается сразу, иначе ждёт дописывания (offset остаётся на его начале).
  let unterminated = skipLf;
  let pendingMalformed = false;
  if (carry.length > 0) {
    const found = classifyLine(carry);
    if (found.kind === 'ok') {
      lineNo++;
      parsed++;
      handler.record(found.record, lineNo);
      consumed += carry.length;
      unterminated = true;
    } else if (found.kind === 'bad') {
      pendingMalformed = true;
    }
  }

  return {
    cursor: { offset: consumed, size: start + bytesRead, ino: current.ino, lineNo, unterminated, pendingMalformed },
    missing: false,
    parsed,
    malformed,
  };
}
