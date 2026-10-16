import { mkdir, open, readFile, rmdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { JOURNAL_SCHEMA_VERSION, parseIndex, peekSchemaVersion } from './map.js';
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

/**
 * Прочитанное одной сессией (человек — читатель `human`) — ДИАПАЗОНЫ номеров строк (`seq`) на журнал.
 *
 * ФОРМА ФАЙЛА КУРСОРОВ `cursors/<сессия>.json` (одна, определена здесь):
 * `{ "<ключ журнала>": [[от, до], …], … }`, например `{"r-01":[[1,120],[130,130]],"direct":[[1,5]]}`.
 * Ключ журнала — id комнаты или `direct`. Диапазон `[от, до]` — номера `seq` от `от` до `до` включительно, оба целые и
 * `от <= до`; диапазоны идут по возрастанию и не пересекаются и не соприкасаются (`до + 1 < от` следующего): соседние и
 * перекрывающиеся склеиваются при каждой записи. Прочитано = номер письма входит в один из диапазонов. Обычный случай
 * («прочитано всё по N») — один диапазон `[1, N]`; разреженная история человека — несколько диапазонов. Потолка и
 * выбрасываемых отметок нет: размер файла растёт с числом РАЗРЫВОВ в прочитанном, а не с числом писем.
 * Запись только ДОБАВЛЯЕТ к прочитанному (`addRange`) и никогда не убирает: устаревший писатель не «разчитает» письмо.
 * Исключение одно — удаление комнаты стирает ключ журнала целиком. Нечитаемый ключ или диапазон при разборе отбрасывается
 * (письма выглядят непрочитанными — безопасная сторона), порядок и склейка при разборе восстанавливаются.
 */
export type CursorFile = Record<string, [number, number][]>;

const keyRoom = (key: string): string | null => (key === DIRECT_CURSOR_KEY ? null : key);

/** Прочитано ли письмо с номером строки `seq` в журнале ключа `key`. */
export function isRead(file: CursorFile, key: string, seq: number): boolean {
  for (const [from, to] of file[key] ?? []) {
    if (seq < from) return false;
    if (seq <= to) return true;
  }
  return false;
}

/** До какого номера прочитано сплошняком с первого письма (`0` — первое письмо не прочитано). Дальше первый разрыв. */
export function readPrefix(file: CursorFile, key: string): number {
  const first = file[key]?.[0];
  return first !== undefined && first[0] === 1 ? first[1] : 0;
}

/** Склеивает диапазоны: по возрастанию, перекрывающиеся и соприкасающиеся — в один. Негодные пары отбрасываются. */
function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.filter(([from, to]) => Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Добавляет к прочитанному ключа письма `from..to` включительно; возвращает, изменился ли файл. Убирать из прочитанного нельзя. */
export function addRange(file: CursorFile, key: string, from: number, to: number): boolean {
  const before = file[key] ?? [];
  const after = mergeRanges([...before, [from, to]]);
  if (after.length === before.length && after.every(([a, b], i) => a === before[i]![0] && b === before[i]![1])) return false;
  file[key] = after;
  return true;
}

/**
 * Номера строк писем карты по порядку `messages`: из id (`m-r01-5`), а у прежних писем (`m-NN`) — позиция в своём
 * журнале с единицы (миграция нумерует их именно так). Карта хранит письма журнала по порядку журнала.
 */
export function messageSeqs(messages: readonly Pick<Message, 'id' | 'roomId'>[]): number[] {
  const counts = new Map<string, number>();
  return messages.map((message) => {
    const key = message.roomId ?? DIRECT_CURSOR_KEY;
    const position = (counts.get(key) ?? 0) + 1;
    counts.set(key, position);
    return seqOfLetterId(message.id, keyRoom(key)) ?? position;
  });
}

const serializeCursors = (file: CursorFile): string => {
  const live: CursorFile = {};
  for (const [key, ranges] of Object.entries(file)) if (ranges.length > 0) live[key] = ranges;
  return `${JSON.stringify(live)}\n`;
};

export interface JournalReadOptions {
  /** Письма строго после этого id. Неизвестный id — как если бы `after` не был задан. */
  after?: string;
  /** Письма строго до этого id. Неизвестный id — пустой список. */
  before?: string;
  /**
   * Письма с номером строки строго больше этого (вперёд, самые старые первыми), как `after`, но по номеру, а не по id:
   * у прежних писем (`m-NN`) номера в id нет. Положение ищется обратным проходом от хвоста (платим за непрочитанное).
   * Главнее `after`.
   */
  afterSeq?: number;
  /**
   * Без `after` читать вперёд с первого письма журнала, а не с конца: «всё непрочитанное» у сессии без курсора
   * (`check_inbox`). Неизвестный `after` (письма уже нет в журнале) не воспроизводит журнал: если по id виден номер
   * строки (`m-r01-5`), отдаются письма с большим номером; иначе курсор прижимается к концу журнала (`clampedTo`)
   * с предупреждением, и ничего не отдаётся повторно.
   */
  fromStart?: boolean;
  /** Сколько писем самое большее; по умолчанию 50. */
  limit?: number;
  /** Сколько байт строк самое большее; по умолчанию 64 КБ. Одно письмо отдаётся всегда, даже если оно больше. */
  maxBytes?: number;
  /** Куда сообщать о пропущенной строке; по умолчанию `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Номер строки журнала по id вида `letterId` (`m-r01-5`, `m-d-5`); `null`, если id другого вида: прежние `m-NN` и id
 * чужого журнала номера этой строки не несут.
 */
export function seqOfLetterId(id: string, roomId: string | null): number | null {
  const prefix = roomId === null ? 'm-d-' : `m-${roomId.replaceAll('-', '')}-`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/** Ключ прямых писем в файле курсора. Id комнаты (`r-NN`) с ним не совпадает. */
export const DIRECT_CURSOR_KEY = 'direct';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 64 * 1024;
const LINE_SEQ = /^\{"seq":(\d+),/;

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

export const cursorFile = (paths: WorkPaths, sessionId: string): string => path.join(paths.cursors, `${safeId('session', sessionId)}.json`);

/** `m-r01-5`, `m-d-5`: дефис из id комнаты убран, как в примерах спеки. */
export const letterId = (roomId: string | null, seq: number): string => (roomId === null ? `m-d-${seq}` : `m-${roomId.replaceAll('-', '')}-${seq}`);

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

/** Текст файла курсоров → диапазоны прочитанного; `null`, если файл не объект. Нечитаемый файл вызывающий считает «ничего не прочитано». */
export function parseCursorFile(text: string): CursorFile | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const file: CursorFile = {};
    for (const [key, raw] of Object.entries(value)) {
      if (!Array.isArray(raw)) continue;
      const pairs = raw.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'number' && typeof pair[1] === 'number');
      const ranges = mergeRanges(pairs);
      if (ranges.length > 0) file[key] = ranges;
    }
    return file;
  } catch {
    return null;
  }
}

/** Текст предупреждения о нечитаемом файле курсоров: один на асинхронное и синхронное чтение. */
export const unreadableCursorsMessage = (file: string): string => `cursor file ${file} is unreadable: treating the session as having read nothing`;

/** Письмо в журнал комнаты, которой нет в индексе: не воскрешаем каталог удалённой комнаты. */
export class RoomGoneError extends Error {
  constructor(roomId: string) {
    super(`room ${roomId} does not exist (it may have just been deleted): the letter was not written`);
    this.name = 'RoomGoneError';
  }
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/** Комнаты индекса по состоянию файла (`stat`: inode, размер, mtime; индекс пишется заменой файла): пока он не менялся, `appendMessage` его не читает. */
const roomsOfIndex = new Map<string, { sig: string; rooms: ReadonlySet<string> | null }>();

/**
 * Знает ли индекс карты-журнала комнату. Нет карты, карта v2 или нечитаемый файл — «знает»: сверять не с чем, а
 * отказывать из-за чужой беды нельзя. Индекс разбирается заново, только когда файл менялся.
 */
async function indexHasRoom(paths: WorkPaths, roomId: string): Promise<boolean> {
  let info;
  try {
    info = await stat(paths.map);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const sig = `${info.ino}:${info.size}:${info.mtimeMs}`;
  let known = roomsOfIndex.get(paths.map);
  if (known?.sig !== sig) {
    let rooms: ReadonlySet<string> | null = null;
    try {
      const raw = await readFile(paths.map, 'utf8');
      if (peekSchemaVersion(raw) === JOURNAL_SCHEMA_VERSION) rooms = new Set(parseIndex(raw, paths.map).rooms.map((room) => room.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      rooms = null;
    }
    known = { sig, rooms };
    roomsOfIndex.set(paths.map, known);
  }
  return known.rooms === null || known.rooms.has(roomId);
}

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
  const paths = workPaths(projectPath, workId);
  const file = journalFile(paths, roomId);
  // Каталога комнаты нет — он мог быть удалён вместе с комнатой: создавать его заново можно, только если индекс комнату знает.
  if (roomId !== null && !(await exists(path.dirname(file))) && !(await indexHasRoom(paths, roomId))) throw new RoomGoneError(roomId);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    return await appendLocked(file, paths, roomId, message);
  } catch (error) {
    // Каталог, который мы успели пересоздать для комнаты без индекса, убираем (пустой; непустой `rmdir` не тронет).
    if (error instanceof RoomGoneError) await rmdir(path.dirname(file)).catch(() => undefined);
    throw error;
  }
}

async function appendLocked(file: string, paths: WorkPaths, roomId: string | null, message: NewJournalMessage): Promise<JournalLetter> {
  return withLock(path.join(path.dirname(file), 'messages.lock'), DEFAULT_LOCK_TIMEOUT_MS, async () => {
    // Под замком журнала: удаление комнаты записывает индекс раньше, чем убирает каталог (`afterCommit` приёмника), так
    // что опоздавшее письмо видит индекс без комнаты здесь.
    if (roomId !== null && !(await indexHasRoom(paths, roomId))) throw new RoomGoneError(roomId);
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
  /** Неизвестный курсор прижат к концу журнала: id последнего письма, на которое вызывающему надо поставить курсор. */
  clampedTo?: string;
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

/** Смещение сразу за последней строкой с номером не больше `seq` — обратным проходом от хвоста; `0`, если таких строк нет. */
async function locateEndBySeq(handle: FileHandle, size: number, seq: number): Promise<number> {
  if (seq <= 0) return 0;
  for await (const { line, start } of reverseLines(handle, size)) {
    const head = LINE_SEQ.exec(line.subarray(0, 32).toString('latin1'));
    if (head !== null && Number(head[1]) <= seq) return Math.min(start + line.length + 1, size);
  }
  return 0;
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
  { after, before, afterSeq, fromStart = false, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES, warn = console.warn }: JournalReadOptions = {},
): Promise<JournalPage> {
  if (limit <= 0) return { letters: [], more: false };
  const file = journalFile(workPaths(projectPath, workId), roomId);
  const handle = await openIfExists(file, 'r');
  if (handle === null) return { letters: [], more: false };
  try {
    const { size } = await handle.stat();
    if (after !== undefined || afterSeq !== undefined || fromStart) {
      let from: number | null = 0;
      let skipThroughSeq: number | undefined;
      if (afterSeq !== undefined) {
        from = await locateEndBySeq(handle, size, afterSeq);
      } else if (after !== undefined) {
        from = await locateEnd(handle, size, after);
        if (from === null && fromStart) {
          // Письма с этим id нет (его убрали): журнал с начала не отдаём, иначе всё прочитанное придёт повторно.
          const seq = seqOfLetterId(after, roomId);
          if (seq === null) {
            warn(`journal ${file}: cursor ${after} is not in the journal and has no line number: moved to the end, nothing is replayed`);
            return { letters: [], more: false, ...(await lastIdOf(handle, size)) };
          }
          from = 0;
          skipThroughSeq = seq;
        }
      }
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
          if (skipThroughSeq !== undefined && letter.seq <= skipThroughSeq) continue;
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

/** `{ clampedTo }` по id последней целой строки журнала; журнал без целых строк — `{}`. */
async function lastIdOf(handle: FileHandle, size: number): Promise<{ clampedTo?: string }> {
  for await (const { line } of reverseLines(handle, size)) {
    const letter = parseLetter(line.toString('utf8'));
    if (letter !== null) return { clampedTo: letter.id };
  }
  return {};
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
 * `findMessage` с потолком: просматривает с хвоста не больше `maxBytes` байт журнала. `scanned` — сколько байт хвоста
 * просмотрено (по строке, на которой остановились), `truncated` — письма не нашли, а непросмотренные строки остались.
 * Для поиска письма, чей журнал по id не определить (`m-NN`): цена поиска ограничена, а не растёт с возрастом письма.
 */
export async function findMessageWithin(
  projectPath: string,
  workId: string,
  roomId: string | null,
  id: string,
  maxBytes: number,
): Promise<{ letter?: JournalLetter; scanned: number; truncated: boolean }> {
  const handle = await openIfExists(journalFile(workPaths(projectPath, workId), roomId), 'r');
  if (handle === null) return { scanned: 0, truncated: false };
  try {
    const { size } = await handle.stat();
    const needle = `"id":${JSON.stringify(id)}`;
    let scanned = 0;
    for await (const { line, start } of reverseLines(handle, size)) {
      if (scanned > 0 && size - start > maxBytes) return { scanned, truncated: true };
      scanned = size - start;
      const raw = line.toString('utf8');
      if (!raw.includes(needle)) continue;
      const letter = parseLetter(raw);
      if (letter?.id === id) return { letter, scanned, truncated: false };
    }
    return { scanned, truncated: false };
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
 * Файл курсоров сессии целиком (сотни байт). Файла нет — пусто, то есть «ничего не прочитано»; нечитаемый файл
 * тоже: письма придут повторно, а не потеряются. Человек — читатель тоже, его курсор — сессия `human` (`HUMAN`).
 */
export async function readCursorFile(
  projectPath: string,
  workId: string,
  sessionId: string,
  { warn = console.warn }: { warn?: (message: string) => void } = {},
): Promise<CursorFile> {
  const file = cursorFile(workPaths(projectPath, workId), sessionId);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = parseCursorFile(text);
  if (parsed === null) {
    warn(unreadableCursorsMessage(file));
    return {};
  }
  return parsed;
}

/**
 * Помечает прочитанным всё с первого письма по номер `upToSeq` включительно (`null` вместо комнаты — прямые письма):
 * читает файл, добавляет диапазон, пишет атомарно. Назад не идёт: уже прочитанное остаётся прочитанным.
 */
export async function writeCursor(
  projectPath: string,
  workId: string,
  sessionId: string,
  roomId: string | null,
  upToSeq: number,
): Promise<void> {
  await withCursors(projectPath, workId, sessionId, async (file) => ({
    changed: addRange(file, roomId === null ? DIRECT_CURSOR_KEY : safeId('room', roomId), 1, upToSeq),
    value: undefined,
  }));
}

export interface SeqPageOptions {
  /** Письма строго старше этого номера строки журнала (`seq`). */
  beforeSeq?: number;
  /** Письма строго новее этого номера; читаются вперёд, самые старые первыми. Главнее `beforeSeq`. */
  afterSeq?: number;
  limit: number;
  maxBytes: number;
  warn?: (message: string) => void;
}


/**
 * Страница журнала по номеру строки (`seq`), а не по id: курсор страниц `read_room` — номер (`before:N`), и прежние
 * id мигрированных писем (`m-NN`) с ним не связаны. Пока номер строки не дошёл до границы, строки только
 * пролистываются по префиксу `{"seq":N,` без разбора. СТОИМОСТЬ: назад — от хвоста до границы, вперёд — от начала до
 * границы (читаются с диска, не разбираются), то есть растёт с глубиной, как у `before`. Без границ — самые новые
 * `limit` писем в пределах `maxBytes` (одно письмо отдаётся всегда). `more` — за страницей в этом направлении есть ещё.
 */
export async function readPageBySeq(
  projectPath: string,
  workId: string,
  roomId: string | null,
  { beforeSeq, afterSeq, limit, maxBytes, warn = console.warn }: SeqPageOptions,
): Promise<JournalPage> {
  if (limit <= 0) return { letters: [], more: false };
  const file = journalFile(workPaths(projectPath, workId), roomId);
  const handle = await openIfExists(file, 'r');
  if (handle === null) return { letters: [], more: false };
  try {
    const { size } = await handle.stat();
    const letters: JournalLetter[] = [];
    let bytes = 0;
    let more = false;
    const take = (buffer: Buffer): 'taken' | 'full' => {
      if (letters.length >= limit || (letters.length > 0 && bytes + buffer.length > maxBytes)) return 'full';
      const letter = parseLetter(buffer.toString('utf8'));
      if (letter === null) {
        warn(skippedLineMessage(file, buffer.length));
        return 'taken';
      }
      letters.push(letter);
      bytes += buffer.length;
      return 'taken';
    };
    if (afterSeq !== undefined) {
      for await (const buffer of forwardLines(handle, 0, size)) {
        const head = LINE_SEQ.exec(buffer.subarray(0, 32).toString('latin1'));
        if (head !== null && Number(head[1]) <= afterSeq) continue;
        if (take(buffer) === 'full') {
          more = true;
          break;
        }
      }
      return { letters, more };
    }
    for await (const { line } of reverseLines(handle, size)) {
      const head = LINE_SEQ.exec(line.subarray(0, 32).toString('latin1'));
      if (beforeSeq !== undefined && head !== null && Number(head[1]) >= beforeSeq) continue;
      if (take(line) === 'full') {
        more = true;
        break;
      }
    }
    return { letters: letters.reverse(), more };
  } finally {
    await handle.close();
  }
}

/**
 * Курсоры сессии под её замком: `body` читает и меняет файл курсоров, файл пишется один раз и только если `body`
 * вернул `changed: true`. Замок один на весь вызов, поэтому два `check_inbox` одной сессии (инструмент и ожидание) не раздадут
 * одно письмо дважды: второй читает курсор уже после записи первого. `writeCursor` берёт тот же замок — внутри `body`
 * его звать нельзя.
 */
export async function withCursors<T>(
  projectPath: string,
  workId: string,
  sessionId: string,
  body: (file: CursorFile) => Promise<{ changed: boolean; value: T }>,
): Promise<T> {
  const paths = workPaths(projectPath, workId);
  const file = cursorFile(paths, sessionId);
  await mkdir(paths.cursors, { recursive: true });
  return withLock(`${file}.lock`, DEFAULT_LOCK_TIMEOUT_MS, async () => {
    const state = await readCursorFile(projectPath, workId, sessionId);
    const { changed, value } = await body(state);
    if (changed) await writeAtomic(file, serializeCursors(state));
    return value;
  });
}
