import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LOCK_TIMEOUT_MS, withLock, workPaths, writeAtomic, type WorkPaths } from './store.js';
import type { Message, MessageKind } from './types.js';

/**
 * Журналы писем карты v3 (спека 2026-10-16, B1–B3). Одна строка JSON — одно письмо, файл только растёт.
 *
 * Строка = поля `Message` в порядке `addMessage` без `readBy` (его заменяют курсоры) плюс `seq` — номер строки
 * в этом журнале, он идёт первым:
 *   {"seq":5,"id":"m-r01-5","roomId":"r-01","from":"s-02","to":[],"text":"…","kind":"note","at":"…","replyTo":"m-r01-3"}
 * `replyTo` и `deleted` есть, только когда заданы. Прежние письма мигрированного журнала сохраняют id `m-NN`,
 * но получают `seq`, поэтому следующий id после 500 прежних писем — `m-r01-501`.
 *
 * Число строк никогда не считается чтением файла: `seq` последней строки читается с хвоста под замком журнала.
 */
export interface JournalLetter extends Omit<Message, 'readBy' | 'textBytes'> {
  seq: number;
}

/** Письмо на запись: id, комнату и номер выдаёт журнал. */
export interface NewJournalMessage {
  from: string;
  to: string[];
  text: string;
  kind?: MessageKind;
  at?: string;
  replyTo?: string;
  deleted?: boolean;
}

/** Прочитанное одной сессией: id комнаты (или `direct`) → id последнего прочитанного письма. */
export type SessionCursors = Record<string, string>;

export interface JournalReadOptions {
  /** Письма строго после этого id. Неизвестный id — как если бы `after` не был задан. */
  after?: string;
  /** Письма строго до этого id. Неизвестный id — пустой список. */
  before?: string;
  /** Сколько писем самое большее; по умолчанию 50. */
  limit?: number;
  /** Сколько байт строк самое большее; по умолчанию 64 КБ. Одно письмо отдаётся всегда, даже если оно больше. */
  maxBytes?: number;
  /** Куда сообщать о пропущенной строке; по умолчанию `console.warn`. */
  warn?: (message: string) => void;
}

/** Ключ прямых писем в файле курсора. Id комнаты (`r-NN`) с ним не совпадает. */
export const DIRECT_CURSOR_KEY = 'direct';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 64 * 1024;
/** Размер блока чтения с конца. Страница журнала читает не больше `maxBytes` плюс один такой блок. */
const CHUNK_BYTES = 8 * 1024;

/** Сколько нечитаемых строк хвоста `appendMessage` пропускает в поисках последнего `seq`. */
const MAX_TAIL_GARBAGE = 64;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function safeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${kind} id: ${JSON.stringify(value)}`);
  return value;
}

/** Файл журнала комнаты или (`roomId === null`) прямых писем. */
export function journalFile(paths: WorkPaths, roomId: string | null): string {
  return roomId === null ? paths.direct : path.join(paths.rooms, safeId('room', roomId), 'messages.jsonl');
}

const cursorFile = (paths: WorkPaths, sessionId: string): string => path.join(paths.cursors, `${safeId('session', sessionId)}.json`);

/** `m-r01-5`, `m-d-5`: дефис из id комнаты убран, как в примерах спеки. */
const letterId = (roomId: string | null, seq: number): string => (roomId === null ? `m-d-${seq}` : `m-${roomId.replaceAll('-', '')}-${seq}`);

/** Строка журнала для записи; миграция (задача 6) пишет прежние письма тем же форматом. */
export function journalLine(letter: JournalLetter): string {
  const { seq, id, roomId, from, to, text, kind, at, replyTo, deleted } = letter;
  return `${JSON.stringify({
    seq,
    id,
    roomId,
    from,
    to,
    text,
    kind,
    at,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(deleted === undefined ? {} : { deleted }),
  })}\n`;
}

/**
 * Строки файла с конца к началу, целиком, без завершающего `\n`; читается блоками, а не файлом.
 * Последняя строка без `\n` (оборванная запись) отдаётся как есть — разбирает вызывающий.
 * Вместе со строкой отдаётся её смещение в файле (`start`): по нему страница `after` читает дальше вперёд.
 */
async function* reverseLines(handle: FileHandle, size: number): AsyncGenerator<{ line: Buffer; start: number }> {
  let position = size;
  let carry = Buffer.alloc(0);
  while (position > 0) {
    const length = Math.min(CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const buffer = Buffer.concat([chunk.subarray(0, filled), carry]);
    let end = buffer.length;
    for (;;) {
      const newline = end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1;
      if (newline === -1) break;
      if (end > newline + 1) yield { line: buffer.subarray(newline + 1, end), start: position + newline + 1 };
      end = newline;
    }
    carry = buffer.subarray(0, end);
  }
  if (carry.length > 0) yield { line: carry, start: 0 };
}

/** Строки файла от смещения `from` вперёд, блоками; пустые строки пропускаются, оборванная последняя отдаётся как есть. */
async function* forwardLines(handle: FileHandle, from: number, size: number): AsyncGenerator<Buffer> {
  let position = from;
  let carry = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled === 0) break;
    position += filled;
    const buffer = Buffer.concat([carry, chunk.subarray(0, filled)]);
    let begin = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, begin);
      if (newline === -1) break;
      if (newline > begin) yield buffer.subarray(begin, newline);
      begin = newline + 1;
    }
    carry = buffer.subarray(begin);
  }
  if (carry.length > 0) yield carry;
}

/** Строка журнала → письмо; `null` для оборванной или битой строки. Общий разбор асинхронного и синхронного чтения. */
export function parseLetter(raw: string): JournalLetter | null {
  try {
    const value = JSON.parse(raw) as Partial<JournalLetter> | null;
    if (value === null || typeof value !== 'object' || typeof value.seq !== 'number' || typeof value.id !== 'string') return null;
    return value as JournalLetter;
  } catch {
    return null;
  }
}

/** Текст предупреждения о пропущенной строке журнала: один на асинхронное и синхронное чтение. */
export const skippedLineMessage = (file: string, bytes: number): string => `journal ${file}: skipped an unparseable line (${bytes} bytes)`;

/** Весь текст журнала → письма по порядку; битые строки пропускаются с предупреждением. Синхронное чтение собирает карту этим же разбором. */
export function parseLetters(text: string, file: string, warn: (message: string) => void = console.warn): JournalLetter[] {
  const letters: JournalLetter[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const letter = parseLetter(raw);
    if (letter === null) warn(skippedLineMessage(file, Buffer.byteLength(raw)));
    else letters.push(letter);
  }
  return letters;
}

/** Текст файла курсоров → курсоры; `null`, если файл не объект. Нечитаемый файл вызывающий считает «ничего не прочитано». */
export function parseCursors(text: string): SessionCursors | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return null;
  }
}

/** Текст предупреждения о нечитаемом файле курсоров: один на асинхронное и синхронное чтение. */
export const unreadableCursorsMessage = (file: string): string => `cursor file ${file} is unreadable: treating the session as having read nothing`;

async function openIfExists(file: string, flags: string): Promise<FileHandle | null> {
  try {
    return await open(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Дописывает письмо одной строкой в журнал комнаты (или прямых писем). Замок — свой, `messages.lock` рядом с
 * журналом, а не `map.lock`: письма не стоят в очереди за записью индекса. Возвращает письмо вместе с id.
 */
export async function appendMessage(
  projectPath: string,
  workId: string,
  roomId: string | null,
  message: NewJournalMessage,
): Promise<JournalLetter> {
  const file = journalFile(workPaths(projectPath, workId), roomId);
  await mkdir(path.dirname(file), { recursive: true });
  return withLock(path.join(path.dirname(file), 'messages.lock'), DEFAULT_LOCK_TIMEOUT_MS, async () => {
    const handle = await open(file, 'a+');
    try {
      const { size } = await handle.stat();
      // Номер последней целой строки: оборванные строки хвоста пропускаем (не больше MAX_TAIL_GARBAGE) и идём к
      // предыдущей. Если целой строки нет в этих пределах, нумерацию не начинаем заново: прежние id (`m-r01-1`) выдали бы
      // повторно, поэтому отказ.
      let last = 0;
      let seen = 0;
      let found = false;
      for await (const { line } of reverseLines(handle, size)) {
        const parsed = parseLetter(line.toString('utf8'));
        if (parsed !== null) {
          last = parsed.seq;
          found = true;
          break;
        }
        seen += 1;
        if (seen >= MAX_TAIL_GARBAGE) break;
      }
      if (!found && seen > 0) {
        throw new Error(`journal ${file}: no parseable line among the last ${seen} lines, refusing to restart numbering`);
      }
      // Оборванная строка без `\n` приклеила бы к себе следующее письмо.
      let prefix = '';
      if (size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      const seq = last + 1;
      const stored: JournalLetter = {
        seq,
        id: letterId(roomId, seq),
        roomId,
        from: message.from,
        to: [...message.to],
        text: message.text,
        kind: message.kind ?? 'note',
        at: message.at ?? new Date().toISOString(),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(message.deleted === undefined ? {} : { deleted: message.deleted }),
      };
      await handle.write(prefix + journalLine(stored));
      return stored;
    } finally {
      await handle.close();
    }
  });
}

/** Страница журнала: письма по порядку журнала и признак, что после них в журнале есть ещё. */
export interface JournalPage {
  letters: JournalLetter[];
  /** Есть ещё письма после страницы (только для `after`; для чтения с конца и `before` всегда `false`). */
  more: boolean;
}

/** Смещение конца строки письма `id` (сразу за её `\n`) — обратным проходом от хвоста; `null`, если письма нет. */
async function locateEnd(handle: FileHandle, size: number, id: string): Promise<number | null> {
  const needle = `"id":${JSON.stringify(id)}`;
  for await (const { line, start } of reverseLines(handle, size)) {
    const raw = line.toString('utf8');
    if (raw.includes(needle) && parseLetter(raw)?.id === id) return Math.min(start + line.length + 1, size);
  }
  return null;
}

/**
 * Страница писем журнала, `letters` по порядку журнала.
 *
 * Без `after` — самые новые письма (читаются блоки с конца, `limit` и `maxBytes` останавливают чтение).
 * С `before` — ближайшие к нему перед ним. СТОИМОСТЬ `before`: обратный проход от хвоста до этого id пролистывает
 * каждую строку между ними (без разбора, но читает их с диска), то есть растёт с глубиной. `maxBytes` его не
 * ограничивает: для глубокого листания вызывающий не должен идти этим путём.
 *
 * С `after` — вперёд от письма сразу за этим id, самые СТАРЫЕ непрочитанные первыми, `limit`/`maxBytes` ограничивают
 * страницу, `more` говорит, остались ли письма после неё. Контракт вызывающего: поставить курсор на последнее
 * письмо страницы и повторять, пока `more`; так каждое письмо придёт ровно один раз и по порядку. Положение id
 * ищется обратным проходом от хвоста (платим за непрочитанное, не за весь файл), дальше чтение идёт вперёд.
 * Неизвестный `after` — как будто не задан: страница с конца, `more: false`.
 * С `after` и `before` — окно между ними; неизвестный `before` в окне — пустая страница.
 * Битая или оборванная строка пропускается с предупреждением. Журнала нет — пустая страница.
 */
export async function readPage(
  projectPath: string,
  workId: string,
  roomId: string | null,
  { after, before, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES, warn = console.warn }: JournalReadOptions = {},
): Promise<JournalPage> {
  if (limit <= 0) return { letters: [], more: false };
  const file = journalFile(workPaths(projectPath, workId), roomId);
  const handle = await openIfExists(file, 'r');
  if (handle === null) return { letters: [], more: false };
  try {
    const { size } = await handle.stat();
    if (after !== undefined) {
      const from = await locateEnd(handle, size, after);
      if (from !== null) {
        const letters: JournalLetter[] = [];
        let bytes = 0;
        let more = false;
        let reachedBefore = false;
        for await (const buffer of forwardLines(handle, from, size)) {
          const letter = parseLetter(buffer.toString('utf8'));
          if (letter === null) {
            warn(skippedLineMessage(file, buffer.length));
            continue;
          }
          if (before !== undefined && letter.id === before) {
            reachedBefore = true;
            break;
          }
          if (letters.length >= limit || (letters.length > 0 && bytes + buffer.length > maxBytes)) {
            more = true;
            break;
          }
          letters.push(letter);
          bytes += buffer.length;
        }
        if (before !== undefined && !reachedBefore && !more) return { letters: [], more: false };
        return { letters, more };
      }
    }
    const collected: JournalLetter[] = [];
    let bytes = 0;
    // Пока не дошли до `before`, строки только пролистываются: подстрока вместо разбора.
    let skipping = before !== undefined;
    const skipped = (raw: string, id: string): boolean => raw.includes(`"id":${JSON.stringify(id)}`);
    for await (const { line: buffer } of reverseLines(handle, size)) {
      const raw = buffer.toString('utf8');
      if (skipping && before !== undefined && !skipped(raw, before)) continue;
      const letter = parseLetter(raw);
      if (letter === null) {
        warn(skippedLineMessage(file, buffer.length));
        continue;
      }
      if (skipping) {
        if (letter.id === before) skipping = false;
        continue;
      }
      if (collected.length > 0 && bytes + buffer.length > maxBytes) break;
      collected.push(letter);
      bytes += buffer.length;
      if (collected.length >= limit) break;
    }
    return { letters: collected.reverse(), more: false };
  } finally {
    await handle.close();
  }
}

/** Письма страницы без признака `more`; о контракте `after` см. `readPage`. */
export async function readMessages(
  projectPath: string,
  workId: string,
  roomId: string | null,
  options: JournalReadOptions = {},
): Promise<JournalLetter[]> {
  return (await readPage(projectPath, workId, roomId, options)).letters;
}

/**
 * Письмо по id: обратный проход от хвоста с подстрокой вместо разбора (стоимость растёт с возрастом письма).
 * Нет журнала или письма — `undefined`.
 */
export async function findMessage(projectPath: string, workId: string, roomId: string | null, id: string): Promise<JournalLetter | undefined> {
  const handle = await openIfExists(journalFile(workPaths(projectPath, workId), roomId), 'r');
  if (handle === null) return undefined;
  try {
    const { size } = await handle.stat();
    const needle = `"id":${JSON.stringify(id)}`;
    for await (const { line } of reverseLines(handle, size)) {
      const raw = line.toString('utf8');
      if (!raw.includes(needle)) continue;
      const letter = parseLetter(raw);
      if (letter?.id === id) return letter;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Склейка списков писем (по одному на журнал, каждый в порядке журнала) в один по времени письма (`at`).
 * Порядок внутри журнала не нарушается (слияние, а не сортировка); при равном `at` раньше идёт журнал, что раньше
 * в `lists`, а внутри журнала — раньше по `seq`. Общий помощник `assemble.ts` и `unreadFromJournals`.
 */
export function mergeByTime<T extends { at: string }>(lists: readonly (readonly T[])[]): T[] {
  const heads = lists.map(() => 0);
  const merged: T[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i += 1) {
      const next = lists[i]![heads[i]!];
      if (next === undefined) continue;
      if (best === -1 || next.at < lists[best]![heads[best]!]!.at) best = i;
    }
    if (best === -1) return merged;
    merged.push(lists[best]![heads[best]!++]!);
  }
}

/**
 * Файл курсоров сессии целиком (сотни байт). Файла нет — `{}`, то есть «ничего не прочитано»; нечитаемый файл
 * тоже: письма придут повторно, а не потеряются. Человек — читатель тоже, его курсор — сессия `human` (`HUMAN`).
 */
export async function readCursors(
  projectPath: string,
  workId: string,
  sessionId: string,
  { warn = console.warn }: { warn?: (message: string) => void } = {},
): Promise<SessionCursors> {
  const file = cursorFile(workPaths(projectPath, workId), sessionId);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const cursors = parseCursors(text);
  if (cursors === null) {
    warn(unreadableCursorsMessage(file));
    return {};
  }
  return cursors;
}

/** Ставит курсор сессии на комнату (`null` — прямые письма): читает файл, меняет одну запись, пишет атомарно. */
export async function writeCursor(
  projectPath: string,
  workId: string,
  sessionId: string,
  roomId: string | null,
  lastId: string,
): Promise<void> {
  const paths = workPaths(projectPath, workId);
  const file = cursorFile(paths, sessionId);
  await mkdir(paths.cursors, { recursive: true });
  await withLock(`${file}.lock`, DEFAULT_LOCK_TIMEOUT_MS, async () => {
    const cursors = await readCursors(projectPath, workId, sessionId);
    cursors[roomId === null ? DIRECT_CURSOR_KEY : safeId('room', roomId)] = lastId;
    await writeAtomic(file, `${JSON.stringify(cursors)}\n`);
  });
}
