import { humanDecisionOutcome, plainHumanMention } from './attention.js';
import { markedExcerpt, textHash } from './context-budget.js';
import type { LetterQuery } from './letter-store.js';
import { isRoomArchived } from './rooms.js';
import { agentStatus } from './session-state.js';
import type { SessionNeed } from './stuck.js';
import { HUMAN, type Message, type MapCompact, type MapCompactMail, type RoomPlan, type WindowWorkMap, type WorkMap, type WorkSession } from './types.js';

/**
 * Компактная карта и страницы (P35, первая ступень A14). Карта остаётся хранилищем состояния, а письма читаются через
 * `LetterReader` (спека хранилища 6.2, 6.7): здесь только то, что из писем отдают наружу. Агенту и окну по умолчанию
 * уходит топология, статусы, активная ревизия, непрочитанное и курсоры; история, резюме, письма, артефакты и длинные
 * тексты читаются отдельными страницами с потолком в байтах.
 *
 * Потолок проверяется до сборки ответа: каждое представление меряется отдельно, а страница набирается, пока
 * влезает; готовый ответ никогда не обрезается задним числом. Единица — байты JSON, измеренные с запасом на
 * отступы MCP (`viewBytes`), поэтому провод и модель получают не больше, чем заявлено.
 */

/** Размер страницы по умолчанию и пределы, которые можно запросить. */
export const PAGE_DEFAULT_BYTES = 64 * 1024;
export const PAGE_MAX_BYTES = 256 * 1024;
export const PAGE_MIN_BYTES = 2 * 1024;
/** Потолок записей на странице по номеру: история, артефакты, резюме, архив работ. */
export const PAGE_MAX_ITEMS = 500;
/** Страница писем — не больше 100 писем (спека хранилища 6.2; было 500): письмо весит больше строки истории. */
export const LETTER_PAGE_MAX_ITEMS = 100;

/** Размер представления в байтах: JSON с отступами MCP и запасом на отступ внутри массива страницы. */
export function viewBytes(value: unknown): number {
  const pretty = JSON.stringify(value, null, 2);
  let lines = 1;
  for (let at = pretty.indexOf('\n'); at !== -1; at = pretty.indexOf('\n', at + 1)) lines += 1;
  return Buffer.byteLength(pretty, 'utf8') + 4 * lines;
}

/** Потолок страницы из запроса: нечисло и выход за пределы возвращаются к ближайшему допустимому. */
export function clampPageBytes(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return PAGE_DEFAULT_BYTES;
  return Math.min(PAGE_MAX_BYTES, Math.max(PAGE_MIN_BYTES, Math.floor(requested)));
}

export type PageErrorCode = 'invalid-cursor' | 'stale-cursor' | 'unknown-target';

/** Ошибка запроса страницы: сообщение английское и говорит агенту, что поправить. */
export class PageError extends Error {
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PageError';
  }
}

/** Курсор страницы: от какого номера и в какую сторону читать. Номер — позиция записи, а не индекс в массиве. */
export interface PageCursor {
  dir: 'before' | 'after';
  seq: number;
}

const CURSOR = /^(before|after):(\d{1,12})$/;

export function parseCursor(raw: unknown): PageCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const match = typeof raw === 'string' ? CURSOR.exec(raw) : null;
  if (match === null) throw new PageError('invalid-cursor', 'cursor must be the `next` value of a previous page ("before:N" or "after:N").');
  return { dir: match[1] as PageCursor['dir'], seq: Number(match[2]) };
}

const formatCursor = (dir: PageCursor['dir'], seq: number): string => `${dir}:${seq}`;

export interface PageInfo {
  /** Сколько записей в выборке; `null` — выборка не знает своего размера. */
  total: number | null;
  returned: number;
  /** `true` — дальше в этом направлении ничего нет: страница дочитала выборку. */
  complete: boolean;
  /** Курсор следующей страницы; `null`, когда `complete`. */
  next: string | null;
  /** Размер набранных представлений. */
  bytes: number;
  /** У скольких записей текст пришлось сократить, чтобы страница влезла. */
  cut: number;
}

export interface SeqPageOptions<T, V> {
  /** Возрастающий номер записи: по нему идёт курсор, поэтому дописывание в конец ничего не сдвигает. */
  seq: (item: T) => number;
  view: (item: T) => V;
  /** Укорачивает представление, которое одно не влезает в потолок. Без неё такая запись — ошибка. */
  shrink?: (view: V, maxBytes: number) => V;
  cursor?: PageCursor | null;
  maxBytes?: number;
  maxItems?: number;
  /** Размер выборки, если он известен не по длине списка (`null` — неизвестен). */
  total?: number | null;
}

/** Потолки страницы из параметров: байты по умолчанию, записей — не больше `ceiling` (`PAGE_MAX_ITEMS`, у писем `LETTER_PAGE_MAX_ITEMS`). */
const pageLimits = (
  options: { maxBytes?: number; maxItems?: number },
  ceiling: number = PAGE_MAX_ITEMS,
): { maxBytes: number; maxItems: number } => ({
  maxBytes: options.maxBytes ?? PAGE_DEFAULT_BYTES,
  maxItems: Math.min(options.maxItems ?? ceiling, ceiling),
});

/**
 * Набирает страницу из потока записей в порядке чтения (от курсора в сторону чтения). Первая запись берётся всегда
 * (после сокращения она влезает), следующие — пока помещаются в байты и в `maxItems`; `more` — поток оборвали, не
 * дочитав: следующая запись есть. `lastSeq` — номер последней взятой записи (начало следующей страницы).
 */
function takeSeqPage<T, V>(
  source: Iterator<T>,
  options: Pick<SeqPageOptions<T, V>, 'seq' | 'view' | 'shrink'> & { maxBytes: number; maxItems: number; from: number },
): { taken: V[]; bytes: number; cut: number; lastSeq: number; more: boolean } {
  const taken: V[] = [];
  let bytes = 0;
  let cut = 0;
  let lastSeq = options.from;
  for (let step = source.next(); step.done !== true; step = source.next()) {
    const item = step.value;
    if (taken.length >= options.maxItems) return { taken, bytes, cut, lastSeq, more: true };
    let view = options.view(item);
    let size = viewBytes(view);
    if (size > options.maxBytes) {
      if (options.shrink === undefined) throw new Error(`a record of ${size} bytes does not fit the ${options.maxBytes}-byte page`);
      view = options.shrink(view, options.maxBytes);
      size = viewBytes(view);
      cut += 1;
    }
    if (taken.length > 0 && bytes + size > options.maxBytes) return { taken, bytes, cut, lastSeq, more: true };
    taken.push(view);
    bytes += size;
    lastSeq = options.seq(item);
  }
  return { taken, bytes, cut, lastSeq, more: false };
}

/** Записи массива от индекса `start` в сторону чтения. */
function* walkItems<T>(items: readonly T[], start: number, forward: boolean): Generator<T> {
  for (let index = start; forward ? index < items.length : index >= 0; index += forward ? 1 : -1) yield items[index] as T;
}

/**
 * Страница записей, упорядоченных по `seq` (по возрастанию). Без курсора — самая новая; `before:N` — старше
 * номера N; `after:N` — новее номера N. Записи внутри страницы идут по возрастанию. Курсор называет номер, а не
 * позицию: записи, дописанные в конец между запросами, не сдвигают ни обратное, ни прямое чтение, и ни одна
 * запись не пропускается и не повторяется.
 */
export function pageBySeq<T, V>(items: readonly T[], options: SeqPageOptions<T, V>): { items: V[]; page: PageInfo } {
  const { maxBytes, maxItems } = pageLimits(options);
  const cursor = options.cursor ?? { dir: 'before' as const, seq: Number.POSITIVE_INFINITY };
  const forward = cursor.dir === 'after';

  // Первый индекс, чей номер строго больше (after) или не меньше (before) номера курсора.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const seq = options.seq(items[mid] as T);
    if (forward ? seq <= cursor.seq : seq < cursor.seq) low = mid + 1;
    else high = mid;
  }

  const { taken, bytes, cut, lastSeq, more } = takeSeqPage(walkItems(items, forward ? low : low - 1, forward), {
    seq: options.seq,
    view: options.view,
    ...(options.shrink === undefined ? {} : { shrink: options.shrink }),
    maxBytes,
    maxItems,
    from: cursor.seq,
  });
  if (!forward) taken.reverse();

  return {
    items: taken,
    page: {
      total: options.total === undefined ? items.length : options.total,
      returned: taken.length,
      complete: !more,
      next: more ? formatCursor(forward ? 'after' : 'before', lastSeq) : null,
      bytes,
      cut,
    },
  };
}

/** Номер из id вида `m-12`; `0` — id не из этой нумерации. */
export function seqOf(id: string, prefix: string): number {
  const digits = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
  return Number.isInteger(digits) && digits > 0 ? digits : 0;
}

/** Представление с полем `text`, ужатое под потолок: текст сокращён с пометкой, полный размер назван. */
export function shrinkText<V extends { text: string }>(view: V, maxBytes: number): V & { textBytes: number } {
  const full = Buffer.byteLength(view.text, 'utf8');
  const overhead = viewBytes({ ...view, text: '' });
  const room = Math.max(256, maxBytes - overhead - 256);
  return { ...view, text: markedExcerpt(view.text, room).text, textBytes: full };
}

export interface MessagePageOptions<V extends { text: string }> {
  roomId: string | null;
  kind?: Message['kind'];
  /** Дополнительный отбор (например, прямые письма сессии): выборка и её размер считаются уже с ним. */
  filter?: (message: Message) => boolean;
  /**
   * Предотбор запросом для `filter`: письма, где отправитель или адресат назван в списке (`LetterQuery.involving`). Без него
   * итог страницы с `filter` читает весь канал; со списком — только письма названных. `filter` должен быть не шире списка.
   */
  involving?: readonly string[];
  cursor?: PageCursor | null;
  maxBytes?: number;
  maxItems?: number;
  view: (message: Message) => V;
}

/**
 * Чтение писем для страниц и снимка (спека хранилища 6.2, 6.7): запросы по индексу, а не обход карты. Ключ канала `''` —
 * прямые письма. Реализации: `mapLetterReader` над картой (чистые тесты и читатели без базы), `storeLetterReader` над
 * таблицами работы. Читатель в `messagePage`, `mapTopology` и `compactWorkMap` обязателен: в хранимой карте писем нет.
 */
export interface LetterReader {
  /** Выборка по `LetterQuery`: порядок номера письма, `newestFirst` берёт новейшие. */
  page(q: LetterQuery): Message[];
  /** Сколько писем подходит под условия (итог страницы). */
  count(q: Omit<LetterQuery, 'limit'>): number;
  /** Письма по номерам (по возрастанию); несуществующих в ответе нет. */
  byIds(ids: readonly string[]): Message[];
  /** Последние `n` писем канала (`null` — прямые) по возрастанию номера. */
  tail(roomId: string | null, n: number): Message[];
  /** Последние `limit` писем, которые человек видит и не прочёл, по возрастанию номера (правило `unreadForHuman`). */
  humanUnread(limit: number): Message[];
  /** Сколько писем читатель не прочёл: всего и по каналам (`''` — прямые). У сессии — правила `unreadFor`, у `human` — `unreadForHuman`. */
  unreadCount(reader: string): { total: number; byRoom: Record<string, number> };
  /** Итоги каналов: сколько писем и номер новейшего; каналов без писем нет. */
  channelStats(): Record<string, { total: number; latestId: string | null }>;
}

/** Сколько писем читатель отдаёт за запрос, когда страница набирает письма по одному. */
const WALK_BATCH = 25;

/**
 * Письма выборки от номера `from` в сторону чтения (назад или вперёд), пачками по `WALK_BATCH`: страница, которая встала
 * на байтовом потолке, не читает остаток канала. `filter` отсеивает письма уже после чтения.
 */
function* walkLetters(
  letters: LetterReader,
  selection: Omit<LetterQuery, 'limit'>,
  from: number,
  forward: boolean,
  filter: ((message: Message) => boolean) | undefined,
): Generator<Message> {
  let edge = from;
  for (;;) {
    const rows = letters.page({
      ...selection,
      ...(forward ? { afterSeq: edge } : Number.isFinite(edge) ? { beforeSeq: edge } : {}),
      limit: WALK_BATCH,
      ...(forward ? {} : { newestFirst: true }),
    });
    for (const row of rows) {
      edge = seqOf(row.id, 'm-');
      if (filter === undefined || filter(row)) yield row;
    }
    if (rows.length < WALK_BATCH) return;
  }
}

/**
 * Страница писем комнаты (`roomId`) или прямых писем (`null`). Письма идут по номеру `m-NN`: он только растёт. Письма
 * читаются запросами от курсора; итог страницы — `count`, а с `filter` — подсчёт отобранных (предикат на одно письмо).
 */
export function messagePage<V extends { text: string }>(
  map: WorkMap,
  options: MessagePageOptions<V>,
  letters: LetterReader,
): { messages: V[]; page: PageInfo } {
  const { maxBytes, maxItems } = pageLimits(options, LETTER_PAGE_MAX_ITEMS);
  const cursor = options.cursor ?? { dir: 'before' as const, seq: Number.POSITIVE_INFINITY };
  const forward = cursor.dir === 'after';
  const selection = {
    roomId: options.roomId,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.involving === undefined ? {} : { involving: options.involving }),
  };

  const { taken, bytes, cut, lastSeq, more } = takeSeqPage(walkLetters(letters, selection, cursor.seq, forward, options.filter), {
    seq: (message) => seqOf(message.id, 'm-'),
    view: options.view,
    shrink: shrinkText,
    maxBytes,
    maxItems,
    from: cursor.seq,
  });
  if (!forward) taken.reverse();

  // Итог — один запрос: без отбора это `count`, с отбором (предикат на одно письмо в `count` не уложить) — выборка канала, а
  // с предотбором `involving` — только писем названных.
  const total =
    options.filter === undefined
      ? letters.count(selection)
      : letters.page({ ...selection, limit: letters.count(selection) }).filter(options.filter).length;
  return {
    messages: taken,
    page: {
      total,
      returned: taken.length,
      complete: !more,
      next: more ? formatCursor(forward ? 'after' : 'before', lastSeq) : null,
      bytes,
      cut,
    },
  };
}

/** Страница длинного текста: кусок по границе символа, полный размер и хеш, курсор на продолжение. */
export interface TextPage {
  text: string;
  /** Смещение начала куска в байтах UTF-8 полного текста. */
  offset: number;
  /** Размер куска. */
  bytes: number;
  totalBytes: number;
  sha256: string;
  complete: boolean;
  next: string | null;
}

const TEXT_CURSOR = /^offset:(\d{1,12}):([0-9a-f]{12})$/;

/**
 * Кусок текста по смещению в байтах. Курсор несёт хеш полного текста: пока агент читал, текст мог смениться
 * (повторный `report` перезаписывает резюме), и склеить куски разных текстов значило бы выдать чужое за полное.
 */
export function textPage(full: string, rawCursor: unknown, maxBytes: number): TextPage {
  const hash = textHash(full);
  let offset = 0;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    const match = typeof rawCursor === 'string' ? TEXT_CURSOR.exec(rawCursor) : null;
    if (match === null) throw new PageError('invalid-cursor', 'cursor must be the `next` value of a previous text page ("offset:N:HASH").');
    if (match[2] !== hash) throw new PageError('stale-cursor', 'The text changed since the first page; read it again from the start (no cursor).');
    offset = Number(match[1]);
  }
  const buffer = Buffer.from(full, 'utf8');
  if (offset > buffer.length) throw new PageError('invalid-cursor', 'cursor is past the end of the text.');
  // Экранирование JSON раздувает управляющие знаки (до шести байт на знак): подбираем длину куска так,
  // чтобы он влез в потолок уже в таком виде.
  const budget = Math.max(256, maxBytes - 512);
  let length = Math.min(buffer.length - offset, budget);
  let chunk = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let end = offset + length;
    while (end < buffer.length && end > offset && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1;
    chunk = buffer.toString('utf8', offset, end);
    const escaped = Buffer.byteLength(JSON.stringify(chunk), 'utf8') - 2;
    if (escaped <= budget || length <= 1) {
      length = end - offset;
      break;
    }
    length = Math.max(1, Math.floor((length * budget) / escaped) - 1);
  }
  const end = offset + length;
  const complete = end >= buffer.length;
  return {
    text: chunk,
    offset,
    bytes: length,
    totalBytes: buffer.length,
    sha256: hash,
    complete,
    next: complete ? null : `offset:${end}:${hash}`,
  };
}

/** Одна запись об обрезанном поле: путь и полный размер. */
export interface CutRecord {
  path: string;
  bytes: number;
}

const MAX_CUT_RECORDS = 50;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Копия значения, где каждая строка длиннее `maxBytes` сокращена с пометкой, а в `cuts` записан путь и полный
 * размер. Нетронутые ветки возвращаются теми же ссылками: карта большая, копировать её целиком незачем.
 */
export function capStrings<T>(value: T, maxBytes: number, path: string, cuts: CutRecord[]): T {
  if (typeof value === 'string') {
    if (value.length <= maxBytes / 4 || Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    const { text } = markedExcerpt(value, maxBytes);
    cuts.push({ path, bytes: Buffer.byteLength(value, 'utf8') });
    return text as T;
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, index) => {
      const next = capStrings(item, maxBytes, `${path}[${index}]`, cuts);
      if (next !== item) (copy ??= value.slice())[index] = next;
    });
    return (copy ?? value) as T;
  }
  if (isPlain(value)) {
    let copy: Record<string, unknown> | null = null;
    for (const [key, item] of Object.entries(value)) {
      const next = capStrings(item, maxBytes, path === '' ? key : `${path}.${key}`, cuts);
      if (next !== item) (copy ??= { ...value })[key] = next;
    }
    return (copy ?? value) as T;
  }
  return value;
}

/** Пределы текстов в карте окна: хватает на человеческую задачу, а гигантские поля уходят по ссылке на страницу. */
export const WINDOW_TEXT_MAX = 32 * 1024;
/** Сколько последних писем на комнату (и на прямую почту) окно получает без запроса страниц. */
export const WINDOW_RECENT_PER_ROOM = 100;
/** Сколько непрочитанных человеком писем окно получает сверх хвоста: точное число всё равно в `compact.unread`. */
export const WINDOW_UNREAD_MAX = 200;
/** Записей истории сессии и артефактов в окне; остальное — страницами. */
export const WINDOW_LIST_MAX = 100;
/**
 * Сколько байт окно получает под кандидатов в упоминания человека — в событии `rooms.mail` и в снимке без писем один и тот
 * же потолок (спека rooms.mail 6.3). Кандидаты — непрочитанные человеком письма с `@human`, до `WINDOW_UNREAD_MAX`, каждое
 * до `WINDOW_TEXT_MAX`; без потолка в байтах они съедали бы кадр события.
 */
export const WINDOW_MENTION_MAX_BYTES = 64 * 1024;

/**
 * Самые новые письма набора, пока влезают в `maxBytes`, и порядок прежний. Хвост без дыр: письмо, которое не влезло, обрывает
 * набор, а более старые за ним не берутся. Считаются байты JSON писем и запятых между ними; скобки массива в счёт не идут.
 */
export function keepNewestWithin(letters: readonly Message[], maxBytes: number): Message[] {
  const kept: Message[] = [];
  let size = 0;
  for (let at = letters.length - 1; at >= 0; at -= 1) {
    const letter = letters[at] as Message;
    const bytes = Buffer.byteLength(JSON.stringify(letter), 'utf8') + (kept.length > 0 ? 1 : 0);
    if (size + bytes > maxBytes) break;
    size += bytes;
    kept.push(letter);
  }
  return kept.reverse();
}

/**
 * Кандидаты в упоминания человека из непрочитанных им писем (по возрастанию номера, как `unreadLetters`): те, что проходят
 * `plainHumanMention`, не больше `WINDOW_UNREAD_MAX` последних, текст сокращён как у письма окна, и всё это не больше
 * `WINDOW_MENTION_MAX_BYTES` — сверх потолка не едут самые старые. Событие `rooms.mail` передаёт сюда новые непрочитанные
 * письма своей пачки, а снимок без писем — непрочитанный хвост человека: окно дописывает кандидатов события в набор работы,
 * а заменяет набор только снимок. Потолок и сокращение текста у них общие, чтобы источники не расходились по составу.
 * Точное правило «@вы» применяет окно (спека rooms.mail 6.3).
 */
export function humanMentionCandidates(unread: readonly Message[], textMax: number = WINDOW_TEXT_MAX): Message[] {
  const candidates = unread
    .filter((message) => plainHumanMention(message.text))
    .slice(-WINDOW_UNREAD_MAX)
    .map((message) => (viewBytes(message) > textMax ? shrinkText(message, textMax) : message));
  return keepNewestWithin(candidates, WINDOW_MENTION_MAX_BYTES);
}

export interface WindowOptions {
  /** Бюджет писем окна в байтах JSON: письма сверх него не включаются, а считаются в `compact.messages`. */
  messageBytes: number;
  recentPerRoom?: number;
  unreadMax?: number;
  textMax?: number;
}

const windowMessageBytes = (message: Message): number => Buffer.byteLength(JSON.stringify(message), 'utf8');

const channelRoom = (channel: string): string | null => (channel === '' ? null : channel);

/** Сколько писем канала читатель отдаёт за запрос, когда хвост без дыр идёт глубже хвоста комнаты. */
const CONTIGUOUS_BATCH = 50;

/** Сумма писем по каналам и номер новейшего письма работы. */
function totalsOf(stats: Record<string, { total: number; latestId: string | null }>): { total: number; latestId: string | null } {
  let total = 0;
  let latestId: string | null = null;
  for (const entry of Object.values(stats)) {
    total += entry.total;
    if (entry.latestId !== null && (latestId === null || seqOf(entry.latestId, 'm-') > seqOf(latestId, 'm-'))) latestId = entry.latestId;
  }
  return { total, latestId };
}

/**
 * Всё в карте окна, кроме писем: сессии, работа, комнаты и планы ужаты так, как их отдаёт `compactWorkMap` и без писем
 * `mailWorkMap`. История сессии и артефакты — хвостом (`WINDOW_LIST_MAX`, число опущенных в `omitted`), длинные поля
 * сокращены до `textMax` (пути — в `cuts`), внутренние очереди хоста (`decisionExports`) и тела снимков планов не едут.
 */
function windowMapBase(map: WorkMap, textMax: number, cuts: CutRecord[], omitted: Record<string, number>): WorkMap {
  const sessions = map.sessions.map((session) => {
    let next: WorkSession = { ...session };
    delete next.codexThreadBinding;
    if (session.history.length > WINDOW_LIST_MAX) {
      omitted[`sessions.${session.id}.history`] = session.history.length - WINDOW_LIST_MAX;
      next = { ...next, history: session.history.slice(-WINDOW_LIST_MAX) };
    }
    if (session.artifacts.length > WINDOW_LIST_MAX) {
      omitted[`sessions.${session.id}.artifacts`] = session.artifacts.length - WINDOW_LIST_MAX;
      next = { ...next, artifacts: session.artifacts.slice(0, WINDOW_LIST_MAX) };
    }
    return capStrings(next, textMax, `sessions.${session.id}`, cuts);
  });

  const { decisionExports, planExports, ...base } = map;
  if (decisionExports !== undefined && decisionExports.length > 0) omitted['decisionExports'] = decisionExports.length;
  const work = capStrings(map.work, textMax, 'work', cuts);
  const roomList = capStrings(map.rooms, textMax, 'rooms', cuts);
  const plans = map.plans === undefined ? undefined : capStrings(map.plans, textMax, 'plans', cuts);
  const effects = map.planEffects === undefined ? undefined : capStrings(map.planEffects, 1024, 'planEffects', cuts);
  // Терминальные рои копятся, а `objective` и `result.summary` длинные: как история сессии — хвост и число опущенных.
  if (map.swarms !== undefined && map.swarms.length > WINDOW_LIST_MAX) omitted['swarms'] = map.swarms.length - WINDOW_LIST_MAX;
  const swarms = map.swarms === undefined ? undefined : capStrings(map.swarms.slice(-WINDOW_LIST_MAX), textMax, 'swarms', cuts);
  return {
    ...base,
    work,
    sessions,
    rooms: roomList,
    ...(plans === undefined ? {} : { plans }),
    ...(swarms === undefined ? {} : { swarms }),
    // Окно читает только состояние снимков (`pending`/`written`): тело — целый Markdown плана — ему не нужно.
    ...(planExports === undefined ? {} : { planExports: planExports.map((intent) => ({ ...intent, content: '' })) }),
    ...(effects === undefined ? {} : { planEffects: effects }),
  };
}

/**
 * Карта для окна: та же форма `WorkMap`, но ограниченная. Письма — хвост каждой комнаты, непрочитанные человеком
 * и подлинники цитат, сколько влезает в `messageBytes`; длинные тексты сокращены с пометкой, история сессий и
 * артефакты обрезаны хвостом, внутренние очереди хоста (`decisionExports`) и тела снимков планов не отправляются.
 * Что осталось за окном, названо в `compact`: итоги, точные счётчики непрочитанного и пути обрезанных полей.
 * Письма и их итоги читаются у `letters` запросами (спека хранилища 6.7), а не обходом карты.
 */
export function compactWorkMap(map: WorkMap, options: WindowOptions, letters: LetterReader): WindowWorkMap {
  const recent = options.recentPerRoom ?? WINDOW_RECENT_PER_ROOM;
  const unreadMax = options.unreadMax ?? WINDOW_UNREAD_MAX;
  const textMax = options.textMax ?? WINDOW_TEXT_MAX;
  const cuts: CutRecord[] = [];
  const omitted: Record<string, number> = {};

  // Итоги по каналам и их хвосты, непрочитанное человеком и точные счётчики — по одному запросу на канал.
  const stats = letters.channelStats();
  const all = totalsOf(stats);
  const totals = new Map<string | null, number>();
  const tails = new Map<string | null, Message[]>();
  for (const [channel, entry] of Object.entries(stats)) {
    totals.set(channelRoom(channel), entry.total);
    tails.set(channelRoom(channel), letters.tail(channelRoom(channel), recent));
  }
  const unread = letters.humanUnread(unreadMax);
  const { '': unreadLetters = 0, ...unreadRooms } = letters.unreadCount(HUMAN).byRoom;

  const chosen = new Map<string, Message>();
  for (const tail of tails.values()) for (const message of tail) chosen.set(message.id, message);
  for (const message of unread) chosen.set(message.id, message);
  // Подлинник цитаты берётся из той же комнаты: чужой id окно всё равно не покажет.
  const quoted = new Set<string>();
  for (const message of chosen.values()) if (message.replyTo !== undefined) quoted.add(message.replyTo);
  const originals = new Map(letters.byIds([...quoted]).map((original) => [original.id, original] as const));
  for (const message of [...chosen.values()]) {
    const original = message.replyTo === undefined ? undefined : originals.get(message.replyTo);
    if (original !== undefined && original.roomId === message.roomId) chosen.set(original.id, original);
  }

  // Бюджет: от новых к старым, пока влезает; сокращённый текст считается уже сокращённым.
  let spent = 0;
  const kept: Message[] = [];
  const ordered = [...chosen.values()].sort((a, b) => seqOf(b.id, 'm-') - seqOf(a.id, 'm-'));
  for (const message of ordered) {
    const text = capStrings(message.text, textMax, `messages.${message.id}.text`, cuts);
    const view: Message = text === message.text ? message : { ...message, text, textBytes: Buffer.byteLength(message.text, 'utf8') };
    const size = windowMessageBytes(view);
    if (spent + size > options.messageBytes) continue;
    spent += size;
    kept.push(view);
  }
  kept.sort((a, b) => seqOf(a.id, 'm-') - seqOf(b.id, 'm-'));

  const keptRooms = new Map<string | null, number>();
  const keptIds = new Set<string>();
  for (const message of kept) {
    keptRooms.set(message.roomId, (keptRooms.get(message.roomId) ?? 0) + 1);
    keptIds.add(message.id);
  }
  // Хвост без дыр: от новейшего письма канала назад, пока подряд идут письма, которые в окне есть. Сперва хвост комнаты,
  // уже прочитанный; глубже — только если в окне есть письма канала старше хвоста (непрочитанные и цитаты).
  const contiguousFrom = (roomId: string | null): number | null => {
    const tail = tails.get(roomId) ?? [];
    let from: number | null = null;
    for (let at = tail.length - 1; at >= 0; at -= 1) {
      const message = tail[at] as Message;
      if (!keptIds.has(message.id)) return from;
      from = seqOf(message.id, 'm-');
    }
    let before = tail.length === 0 ? Number.POSITIVE_INFINITY : seqOf((tail[0] as Message).id, 'm-');
    if (!kept.some((message) => message.roomId === roomId && seqOf(message.id, 'm-') < before)) return from;
    let seen = tail.length;
    while (seen < (totals.get(roomId) ?? 0)) {
      const older = letters.page({
        roomId,
        ...(Number.isFinite(before) ? { beforeSeq: before } : {}),
        newestFirst: true,
        limit: CONTIGUOUS_BATCH,
      });
      if (older.length === 0) break;
      for (const message of older) {
        if (!keptIds.has(message.id)) return from;
        from = seqOf(message.id, 'm-');
      }
      before = seqOf((older.at(-1) as Message).id, 'm-');
      seen += older.length;
    }
    return from;
  };
  const rooms: MapCompact['messages']['rooms'] = {};
  for (const [roomId, total] of totals) {
    rooms[roomId ?? 'direct'] = { total, included: keptRooms.get(roomId) ?? 0, tailFrom: contiguousFrom(roomId) };
  }

  return {
    ...windowMapBase(map, textMax, cuts, omitted),
    messages: kept,
    compact: {
      version: 1,
      messages: {
        total: all.total,
        included: kept.length,
        latestId: all.latestId,
        rooms,
      },
      unread: { letters: unreadLetters, rooms: unreadRooms },
      cut: cuts.slice(0, MAX_CUT_RECORDS),
      omitted,
    },
  };
}

/** Сколько писем человека читать за раз в поисках его ответа на решение, и сколько таких заходов делать самое большее. */
const DECISION_SCAN_BATCH = 5;
const DECISION_SCAN_PAGES = 6;

/**
 * Чем человек ответил на последнее решение комнаты: идёт по его письмам в комнату от новых к старым, пока не найдёт ответ
 * (`humanDecisionOutcome`). Слова человека, которые не ответ, ищущего не останавливают и ответа не отменяют: окно так и
 * считает (`roomDecisionReturned`: «свои слова человека в счёт не идут»). Ищет не глубже `DECISION_SCAN_BATCH *
 * DECISION_SCAN_PAGES` писем, чтобы цена не зависела от длины переписки; дальше — `null`.
 */
function lastHumanDecision(letters: LetterReader, roomId: string): MapCompactMail['rooms'][string]['decision'] {
  let before: number | undefined;
  for (let page = 0; page < DECISION_SCAN_PAGES; page += 1) {
    const found = letters.page({
      roomId,
      from: HUMAN,
      newestFirst: true,
      limit: DECISION_SCAN_BATCH,
      ...(before === undefined ? {} : { beforeSeq: before }),
    });
    for (const letter of found) {
      const outcome = humanDecisionOutcome(letter.text);
      if (outcome !== null) return outcome;
    }
    if (found.length < DECISION_SCAN_BATCH) return null;
    before = seqOf((found.at(-1) as Message).id, 'm-');
  }
  return null;
}

/**
 * Карта для окна с признаком `rooms-mail` (спека rooms.mail 6.8): та же форма `WorkMap` и те же ужатые сессии, комнаты и
 * планы, что у `compactWorkMap`, но писем нет совсем (`messages: []`), а в `compact` (версия 2, `MapCompactMail`) на каждую
 * комнату и на прямые письма — `total`, `top`, `lastAt`, непрочитанное человеком и итог его последнего ответа на решение.
 * Размер не зависит от числа писем: всё берётся запросами по индексам — `count`, одно новейшее письмо канала, `unreadCount`
 * и хвост непрочитанного, а не `channelStats` с группировкой по всей истории. `top` и `lastAt` даёт одно новейшее письмо
 * канала (`page` с `newestFirst`): так читаются и прямые письма, которых `roomLetterTops` не умеет. Кандидаты в упоминания —
 * `humanMentionCandidates` над хвостом непрочитанного человека.
 *
 * `options.textMax` — предел текстов, как у `compactWorkMap`: сокращает длинные поля карты и письма кандидатов.
 */
export function mailWorkMap(map: WorkMap, letters: LetterReader, options: { textMax?: number } = {}): WindowWorkMap {
  const textMax = options.textMax ?? WINDOW_TEXT_MAX;
  const cuts: CutRecord[] = [];
  const omitted: Record<string, number> = {};

  const unread = letters.unreadCount(HUMAN);
  const channels: Array<{ key: string; roomId: string | null }> = [{ key: '', roomId: null }];
  for (const room of map.rooms) channels.push({ key: room.id, roomId: room.id });
  const rooms: MapCompactMail['rooms'] = {};
  for (const { key, roomId } of channels) {
    const newest = letters.page({ roomId, newestFirst: true, limit: 1 })[0];
    rooms[key] = {
      total: letters.count({ roomId }),
      top: newest === undefined ? 0 : seqOf(newest.id, 'm-'),
      lastAt: newest?.at ?? null,
      unread: unread.byRoom[key] ?? 0,
      // Решение — письмо в комнату: у прямых писем ответов на решение нет.
      decision: roomId === null ? null : lastHumanDecision(letters, roomId),
    };
  }
  const mentionCandidates = humanMentionCandidates(letters.humanUnread(WINDOW_UNREAD_MAX), textMax);

  return {
    ...windowMapBase(map, textMax, cuts, omitted),
    messages: [],
    compact: {
      version: 2,
      rooms,
      unread: { letters: unread.total, rooms: unread.byRoom },
      mentionCandidates,
      cut: cuts.slice(0, MAX_CUT_RECORDS),
      omitted,
    },
  };
}

/** Пределы текстов в топологии для агента: длинное читается по полю, а не лежит в каждом ответе `get_map`. */
export const TOPOLOGY_LIMITS = {
  title: 256,
  goal: 1024,
  label: 128,
  task: 512,
  summary: 512,
  roomTitle: 128,
  proposal: 1024,
  planText: 1024,
} as const;

type Cut = Record<string, number>;

/** Поле в пределах `limit` как есть, иначе сокращённое с пометкой; полный размер называет `cut`. */
function bounded(text: string, limit: number, field: string, cut: Cut): string {
  const { text: shown, cut: was } = markedExcerpt(text, limit);
  if (was) cut[field] = Buffer.byteLength(text, 'utf8');
  return shown;
}

export interface SessionTopology {
  id: string;
  provider: string;
  label: string;
  parent: string | null;
  contextFrom: string[];
  lifecycle: WorkSession['lifecycle'];
  result: WorkSession['result'];
  /** Единый статус для разговора с человеком: `agentStatus` (у усыплённой хостом — `asleep`). */
  status: string;
  resultAt: string | null;
  closedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  role: WorkSession['role'];
  model?: string | null;
  effort?: WorkSession['effort'];
  /** Чего сессия ждёт от человека (спека застрявших 5.3); `null` — ничего, и когда поля нет в карте. */
  stuck: SessionNeed | null;
  worktree: { path: string; branch: string; base: string } | null;
  task: string;
  summary: string | null;
  summarySource: WorkSession['summarySource'];
  historyCount: number;
  lastEvent: WorkSession['history'][number] | null;
  artifactCount: number;
  /** Названные поля обрезаны; значение — полный размер в байтах. Читать: `get_map` с `session` и `field`. */
  cut?: Cut;
}

export interface RoomTopology {
  id: string;
  title: string;
  creator: string;
  ownerId: string | null;
  members: string[];
  lead: string | null;
  mode: string;
  createdAt: string;
  recipe: { id: string; name: string } | null;
  proposal: {
    id: string;
    kind: string;
    from: string;
    rev: number;
    at: string;
    planId?: string;
    planRev?: number;
    text: string;
    cut?: Cut;
  } | null;
  messages: { total: number; latestId: string | null; unreadForYou: number };
  /** Только у архивной комнаты: человек убрал её с глаз, писать в неё нельзя, пока он её не вернёт (`archivedAt` в `{room}`). */
  archived?: true;
  cut?: Cut;
}

export interface MapTopology {
  schemaVersion: 2;
  work: {
    id: string;
    title: string;
    goal: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    deletedSessions: string[];
    cut?: Cut;
  };
  sessions: SessionTopology[];
  rooms: RoomTopology[];
  /** Действующие ревизии планов: то, что агенту нужно для `plan_*` с точным `planId` и `rev`. */
  plans: RoomPlan[];
  messages: {
    total: number;
    latestId: string | null;
    direct: { total: number; latestId: string | null };
    /** Непрочитанное этой сессией: число и сколько в каждой комнате. */
    unreadForYou: { total: number; rooms: Record<string, number>; direct: number };
  };
  /** Как читать остальное: поля и страницы `get_map`. */
  pages: string;
}

const PLAN_LIVE = new Set<RoomPlan['status']>(['proposed', 'active', 'completing']);

/** Страницы и поля `get_map` одной строкой: ссылка из ответа, а не пересказ правил. */
export const TOPOLOGY_PAGES =
  'Partial overview: collections[field] gives total/returned/complete/next. Continue with {field: sessions|rooms|plans|deletedSessions|unreadRooms, cursor: next}; lists use page.next, at most 48 KiB per MCP result. {session} gives detail; {room} gives authorized full room detail; {field: plan, id, rev} pages full current plan JSON as text (concatenate text chunks). {field: goal|title} reads workspace text; {session, field: task|summary|history|artifacts|contextFrom} reads one session field; {field: messages, room?, kind?, cursor?, maxBytes?} pages messages; {field: message, id} pages one message text; {field: summaries|archive|providers} reads other catalogs. Letter/text pages retain 64 KiB default/256 KiB maximum. A cut field names its full size in cut.';

/**
 * Расширенная проекция для адресного чтения и прежних потребителей; бюджетный обзор строит `mapOverview`.
 * Участники, статусы, комнаты, действующие ревизии планов, счётчики и курсоры. Размер
 * зависит от числа сессий и комнат, а не от длины переписки; письма, история и артефакты — страницами. Счётчики и
 * курсоры писем даёт `letters` (спека хранилища 6.2): итоги каналов и непрочитанное вызывающей сессии.
 */
export function mapTopology(map: WorkMap, callerId: string | null, letters: LetterReader): MapTopology {
  const workCut: Cut = {};
  const unread = callerId === null ? { total: 0, byRoom: {} as Record<string, number> } : letters.unreadCount(callerId);
  const { '': unreadDirect = 0, ...unreadRooms } = unread.byRoom;
  const stats = letters.channelStats();

  const sessions = map.sessions.map((session): SessionTopology => {
    const cut: Cut = {};
    const entry: SessionTopology = {
      id: session.id,
      provider: session.provider,
      label: bounded(session.label, TOPOLOGY_LIMITS.label, 'label', cut),
      parent: session.parent,
      contextFrom: session.contextFrom,
      lifecycle: session.lifecycle,
      result: session.result,
      status: agentStatus(session),
      resultAt: session.resultAt,
      closedAt: session.closedAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      role: session.role ?? null,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
      stuck: session.stuck ?? null,
      worktree: session.worktree === null ? null : { path: session.worktree.path, branch: session.worktree.branch, base: session.worktree.base },
      task: bounded(session.task, TOPOLOGY_LIMITS.task, 'task', cut),
      summary: session.summary === null ? null : bounded(session.summary, TOPOLOGY_LIMITS.summary, 'summary', cut),
      summarySource: session.summarySource,
      historyCount: session.history.length,
      lastEvent: session.history.at(-1) ?? null,
      artifactCount: session.artifacts.length,
    };
    return Object.keys(cut).length === 0 ? entry : { ...entry, cut };
  });

  const rooms = map.rooms.map((room): RoomTopology => {
    const cut: Cut = {};
    const counted = stats[room.id] ?? { total: 0, latestId: null };
    const proposal = room.proposal ?? null;
    let waiting: RoomTopology['proposal'] = null;
    if (proposal !== null) {
      const proposalCut: Cut = {};
      waiting = {
        id: proposal.id,
        kind: proposal.kind ?? 'decision',
        from: proposal.from,
        rev: proposal.rev,
        at: proposal.at,
        ...(proposal.planId === undefined ? {} : { planId: proposal.planId }),
        ...(proposal.planRev === undefined ? {} : { planRev: proposal.planRev }),
        text: bounded(proposal.text, TOPOLOGY_LIMITS.proposal, 'text', proposalCut),
        ...(Object.keys(proposalCut).length === 0 ? {} : { cut: proposalCut }),
      };
    }
    const entry: RoomTopology = {
      id: room.id,
      title: bounded(room.title, TOPOLOGY_LIMITS.roomTitle, 'title', cut),
      creator: room.creator,
      ownerId: room.ownerId,
      members: room.members,
      lead: room.lead ?? null,
      mode: room.mode ?? 'free',
      createdAt: room.createdAt,
      // Плейбук рецепта получает только ведущий (слоем и письмом): в карте агенту видны id и имя.
      recipe: room.recipe == null ? null : { id: room.recipe.id, name: room.recipe.name },
      proposal: waiting,
      messages: { total: counted.total, latestId: counted.latestId, unreadForYou: unreadRooms[room.id] ?? 0 },
      ...(isRoomArchived(room) ? { archived: true as const } : {}),
    };
    return Object.keys(cut).length === 0 ? entry : { ...entry, cut };
  });

  const plans = (map.plans ?? [])
    .filter((plan) => PLAN_LIVE.has(plan.status))
    .map((plan) => {
      const cuts: CutRecord[] = [];
      const capped = capStrings(plan, TOPOLOGY_LIMITS.planText, `plans.${plan.id}`, cuts);
      // Журнал шагов растёт с работой и агенту для следующего действия не нужен: хвост и счёт остаются.
      return {
        ...capped,
        items: capped.items.map((item) => ({ ...item, log: item.log.slice(-3) })),
      };
    });

  const direct = stats[''] ?? { total: 0, latestId: null };
  const all = totalsOf(stats);
  const goal = bounded(map.work.goal, TOPOLOGY_LIMITS.goal, 'goal', workCut);
  const title = bounded(map.work.title, TOPOLOGY_LIMITS.title, 'title', workCut);
  return {
    schemaVersion: 2,
    work: {
      id: map.work.id,
      title,
      goal,
      status: map.work.status,
      createdAt: map.work.createdAt,
      updatedAt: map.work.updatedAt,
      deletedSessions: map.work.deletedSessions ?? [],
      ...(Object.keys(workCut).length === 0 ? {} : { cut: workCut }),
    },
    sessions,
    rooms,
    plans,
    messages: {
      total: all.total,
      latestId: all.latestId,
      direct,
      unreadForYou: { total: unread.total, rooms: unreadRooms, direct: unreadDirect },
    },
    pages: TOPOLOGY_PAGES,
  };
}

/** Страница списка по индексу: номер записи — её позиция, дописанное в конец ничего не сдвигает. */
export function listPage<T, V>(
  items: readonly T[],
  options: { view: (item: T) => V; cursor?: PageCursor | null; maxBytes?: number; maxItems?: number },
): { items: V[]; page: PageInfo } {
  const indexed = items.map((item, index) => ({ item, seq: index + 1 }));
  return pageBySeq(indexed, {
    seq: (entry) => entry.seq,
    view: (entry) => options.view(entry.item),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
  });
}

/** Бюджет всего результата MCP, включая повторное экранирование content[].text. */
export const TOPOLOGY_MAX_BYTES = 48 * 1024;
export function mcpResultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }] }), 'utf8');
}

export const TOPOLOGY_FIELDS = ['sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms'] as const;
export type TopologyField = typeof TOPOLOGY_FIELDS[number];
type SummaryRow = Record<string, unknown>;

/** Счётчики и поколение вычисляются один раз на запрос, в том числе для всех пяти частей обзора. */
function topologySnapshot(map: WorkMap, caller: string | null, letters: LetterReader) {
  const stats = letters.channelStats();
  const unread = caller === null ? { total: 0, byRoom: {} as Record<string, number> } : letters.unreadCount(caller);
  return { stats, unread, generation: textHash(JSON.stringify([map, stats, unread])) };
}
type TopologySnapshot = ReturnType<typeof topologySnapshot>;

/** Короткие строки считаются уже с экранированием; вложенные растущие данные в строки обзора не попадают. */
function summaryText(value: string, max = 96): string {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= max) return value;
  let length = Math.min(value.length, max);
  for (;;) {
    let prefix = value.slice(0, length);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    const text = `${prefix}…`;
    if (Buffer.byteLength(JSON.stringify(text), 'utf8') <= max) return text;
    length = Math.floor(length / 2);
  }
}

/** Номер id задаёт полный порядок; приоритет вызывающего/его комнаты сохраняется и при продолжении. */
function topologyRows(map: WorkMap, caller: string | null, field: TopologyField, snapshot: TopologySnapshot): SummaryRow[] {
  const order = <T extends { id: string }>(rows: readonly T[], priority: (row: T) => boolean): T[] =>
    [...rows].sort((a, b) => Number(priority(b)) - Number(priority(a)) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (field === 'sessions') return order(map.sessions, (s) => s.id === caller).map((s) => ({
    id: s.id, label: summaryText(s.label), provider: summaryText(s.provider), lifecycle: s.lifecycle, result: s.result,
    ...(s.model === undefined ? {} : { model: s.model === null ? null : summaryText(s.model) }),
    ...(s.effort === undefined ? {} : { effort: s.effort === null ? null : summaryText(s.effort) }),
    status: reportedStatus(s), parent: s.parent, role: s.role == null ? null : summaryText(s.role.name),
    task: summaryText(s.task), summary: s.summary === null ? null : summaryText(s.summary),
    contextFromCount: s.contextFrom.length, historyCount: s.history.length, artifactCount: s.artifacts.length,
    stuck: s.stuck?.kind ?? null, hasWorktree: s.worktree != null,
  }));
  if (field === 'rooms') {
    const { stats, unread: { byRoom: unread } } = snapshot;
    return order(map.rooms, (r) => caller !== null && r.members.includes(caller)).map((r) => ({
      id: r.id, title: summaryText(r.title), ownerId: r.ownerId, lead: r.lead ?? null, mode: r.mode ?? 'free',
      memberCount: r.members.length, ...(isRoomArchived(r) ? { archived: true } : {}),
      recipe: r.recipe == null ? null : { id: summaryText(r.recipe.id), name: summaryText(r.recipe.name) },
      proposal: r.proposal === null || r.proposal === undefined ? null : {
        id: r.proposal.id, rev: r.proposal.rev, kind: r.proposal.kind ?? 'decision',
        ...(r.proposal.planId === undefined ? {} : { planId: r.proposal.planId, planRev: r.proposal.planRev }),
      },
      messages: { ...(stats[r.id] ?? { total: 0, latestId: null }), unreadForYou: unread[r.id] ?? 0 },
    }));
  }
  if (field === 'plans') return order(map.plans ?? [], (p) => map.rooms.some((r) => r.id === p.roomId && caller !== null && r.members.includes(caller))).map((p) => ({
    id: p.id, rev: p.rev, status: p.status, roomId: p.roomId, mode: p.mode, goal: summaryText(p.goal), itemCount: p.items.length,
  }));
  if (field === 'deletedSessions') return [...(map.work.deletedSessions ?? [])].sort().map((id) => ({ id }));
  return Object.entries(snapshot.unread.byRoom).filter(([id]) => id !== '').sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count }));
}

interface TopologyQuery { field: TopologyField; cursor?: string; maxBytes?: number }

/** Собственная версия курсора списков: старые before/after и текстовые offset не меняются. */
function topologySelection(map: WorkMap, caller: string | null, query: TopologyQuery, snapshot: TopologySnapshot) {
  const maxBytes = Math.min(TOPOLOGY_MAX_BYTES, clampPageBytes(query.maxBytes));
  const binding = textHash(JSON.stringify([map.work.id, caller, query.field, maxBytes]));
  // updatedAt недостаточен: два изменения могут иметь одинаковую метку времени. Хеш охватывает и удаление.
  const rows = topologyRows(map, caller, query.field, snapshot);
  const { generation } = snapshot;
  let offset = 0;
  if (query.cursor !== undefined) {
    try {
      if (!/^topology:[A-Za-z0-9_-]{1,512}$/.test(query.cursor)) throw new Error();
      const decoded = Buffer.from(query.cursor.slice(9), 'base64url').toString('utf8');
      if (Buffer.from(decoded).toString('base64url') !== query.cursor.slice(9)) throw new Error();
      const raw = JSON.parse(decoded) as unknown;
      if (!Array.isArray(raw) || raw.length !== 3 || raw[0] !== binding || typeof raw[1] !== 'string' || !/^[0-9a-f]{12}$/.test(raw[1]) || !Number.isSafeInteger(raw[2]) || raw[2] <= 0) throw new Error();
      if (raw[1] !== generation) throw new PageError('stale-cursor', 'stale-cursor: The map changed; restart this collection without a cursor.');
      offset = raw[2] as number;
      if (offset >= rows.length) throw new Error();
    } catch (error) {
      if (error instanceof PageError) throw error;
      throw new PageError('invalid-cursor', 'invalid-cursor: Use page.next with the same workspace, caller, field and maxBytes.');
    }
  }
  const next = (at: number) => `topology:${Buffer.from(JSON.stringify([binding, generation, at])).toString('base64url')}`;
  return { rows, offset, maxBytes, next };
}

/** Страница новых списков ограничена всем MCP-ответом, а не суммой размеров строк. */
export function topologyListPage(map: WorkMap, caller: string | null, letters: LetterReader, query: TopologyQuery, budget?: number, snapshot = topologySnapshot(map, caller, letters)) {
  const { rows, offset, maxBytes, next } = topologySelection(map, caller, query, snapshot);
  const items: SummaryRow[] = [];
  const result = { field: query.field, items, page: { total: rows.length, returned: 0, complete: false, next: null as string | null, bytes: 0, cut: 0 } };
  const update = () => {
    result.page.returned = items.length;
    result.page.complete = offset + items.length >= rows.length;
    result.page.next = result.page.complete ? null : next(offset + items.length);
    result.page.bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
  };
  update();
  for (const row of rows.slice(offset, offset + PAGE_MAX_ITEMS)) {
    items.push(row);
    update();
    if (mcpResultBytes(result) > (budget ?? maxBytes)) {
      items.pop();
      update();
      if (items.length === 0) throw new PageError('unknown-target', 'A summary row exceeds maxBytes; request a larger page.');
      break;
    }
  }
  return result;
}

/** Обзор — пять ограниченных коллекций с точными итогами; полные данные остаются в адресных страницах. */
export function mapOverview(map: WorkMap, caller: string | null, letters: LetterReader) {
  const cut: Cut = {};
  const snapshot = topologySnapshot(map, caller, letters);
  const { stats, unread } = snapshot;
  const pages = Object.fromEntries(TOPOLOGY_FIELDS.map((field) => [field, topologyListPage(map, caller, letters, { field }, 6000, snapshot)])) as Record<TopologyField, ReturnType<typeof topologyListPage>>;
  const result = {
    sessionId: caller,
    map: {
      schemaVersion: 3,
      work: { id: map.work.id, title: bounded(map.work.title, 256, 'title', cut), goal: bounded(map.work.goal, 256, 'goal', cut), status: map.work.status,
        createdAt: summaryText(map.work.createdAt), updatedAt: summaryText(map.work.updatedAt), deletedSessions: pages.deletedSessions.items.map((r) => r.id),
        ...(Object.keys(cut).length === 0 ? {} : { cut }) },
      sessions: pages.sessions.items, rooms: pages.rooms.items, plans: pages.plans.items,
      messages: { ...totalsOf(stats), direct: stats[''] ?? { total: 0, latestId: null },
        unreadForYou: { total: unread.total, direct: unread.byRoom[''] ?? 0, rooms: Object.fromEntries(pages.unreadRooms.items.map((r) => [r.id, r.count])) } },
      collections: Object.fromEntries(TOPOLOGY_FIELDS.map((field) => [field, pages[field].page])) as Record<TopologyField, PageInfo>,
      pages: TOPOLOGY_PAGES,
      note: 'Partial summary rows. Continue sessions with get_map {field: "sessions", cursor: collections.sessions.next}; use rooms, plans, deletedSessions or unreadRooms for other collections. Omit cursor to restart. Narrow with {session}, {room}, or {field: "plan", id, rev}; long session fields use {session, field}.',
    },
  };
  if (mcpResultBytes(result) > TOPOLOGY_MAX_BYTES) throw new PageError('unknown-target', 'Map metadata exceeds the overview budget; request a collection or target directly.');
  return result;
}
