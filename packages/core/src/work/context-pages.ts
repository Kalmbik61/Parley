import { markedExcerpt, textHash } from './context-budget.js';
import { unreadFor, unreadForHuman } from './letters.js';
import { displayStatus } from './status-view.js';
import type { Message, MapCompact, RoomPlan, WorkMap, WorkSession } from './types.js';

/**
 * Компактная карта и страницы (P35, первая ступень A14). JSON-карта остаётся хранилищем: здесь только то, что
 * из неё отдают наружу. Агенту и окну по умолчанию уходит топология, статусы, активная ревизия, непрочитанное и
 * курсоры; история, резюме, письма, артефакты и длинные тексты читаются отдельными страницами с потолком в байтах.
 *
 * Потолок проверяется до сборки ответа: каждое представление меряется отдельно, а страница набирается, пока
 * влезает; готовый ответ никогда не обрезается задним числом. Единица — байты JSON, измеренные с запасом на
 * отступы MCP (`viewBytes`), поэтому провод и модель получают не больше, чем заявлено.
 */

/** Размер страницы по умолчанию и пределы, которые можно запросить. */
export const PAGE_DEFAULT_BYTES = 64 * 1024;
export const PAGE_MAX_BYTES = 256 * 1024;
export const PAGE_MIN_BYTES = 2 * 1024;
export const PAGE_MAX_ITEMS = 500;

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

/**
 * Страница записей, упорядоченных по `seq` (по возрастанию). Без курсора — самая новая; `before:N` — старше
 * номера N; `after:N` — новее номера N. Записи внутри страницы идут по возрастанию. Курсор называет номер, а не
 * позицию: записи, дописанные в конец между запросами, не сдвигают ни обратное, ни прямое чтение, и ни одна
 * запись не пропускается и не повторяется.
 */
export function pageBySeq<T, V>(items: readonly T[], options: SeqPageOptions<T, V>): { items: V[]; page: PageInfo } {
  const maxBytes = options.maxBytes ?? PAGE_DEFAULT_BYTES;
  const maxItems = Math.min(options.maxItems ?? PAGE_MAX_ITEMS, PAGE_MAX_ITEMS);
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

  const taken: V[] = [];
  let bytes = 0;
  let cut = 0;
  let index = forward ? low : low - 1;
  let lastSeq = cursor.seq;
  for (; forward ? index < items.length : index >= 0; index += forward ? 1 : -1) {
    if (taken.length >= maxItems) break;
    const item = items[index] as T;
    let view = options.view(item);
    let size = viewBytes(view);
    if (size > maxBytes) {
      if (options.shrink === undefined) throw new Error(`a record of ${size} bytes does not fit the ${maxBytes}-byte page`);
      view = options.shrink(view, maxBytes);
      size = viewBytes(view);
      cut += 1;
    }
    // Первая запись берётся всегда (после сокращения она влезает), следующие — пока помещаются.
    if (taken.length > 0 && bytes + size > maxBytes) break;
    taken.push(view);
    bytes += size;
    lastSeq = options.seq(item);
  }
  if (!forward) taken.reverse();

  const more = forward ? index < items.length : index >= 0;
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
  cursor?: PageCursor | null;
  maxBytes?: number;
  maxItems?: number;
  view: (message: Message) => V;
}

/** Страница писем комнаты (`roomId`) или прямых писем (`null`). Письма идут по номеру `m-NN`: он только растёт. */
export function messagePage<V extends { text: string }>(
  map: WorkMap,
  options: MessagePageOptions<V>,
): { messages: V[]; page: PageInfo } {
  const selected = map.messages.filter(
    (message) =>
      message.roomId === options.roomId &&
      (options.kind === undefined || message.kind === options.kind) &&
      (options.filter === undefined || options.filter(message)),
  );
  const { items, page } = pageBySeq(selected, {
    seq: (message) => seqOf(message.id, 'm-'),
    view: options.view,
    shrink: shrinkText,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
  });
  return { messages: items, page };
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

export interface WindowOptions {
  /** Бюджет писем окна в байтах JSON: письма сверх него не включаются, а считаются в `compact.messages`. */
  messageBytes: number;
  recentPerRoom?: number;
  unreadMax?: number;
  textMax?: number;
}

const windowMessageBytes = (message: Message): number => Buffer.byteLength(JSON.stringify(message), 'utf8');

/**
 * Карта для окна: та же форма `WorkMap`, но ограниченная. Письма — хвост каждой комнаты, непрочитанные человеком
 * и подлинники цитат, сколько влезает в `messageBytes`; длинные тексты сокращены с пометкой, история сессий и
 * артефакты обрезаны хвостом, внутренние очереди хоста (`decisionExports`) и тела снимков планов не отправляются.
 * Что осталось за окном, названо в `compact`: итоги, точные счётчики непрочитанного и пути обрезанных полей.
 */
export function compactWorkMap(map: WorkMap, options: WindowOptions): WorkMap {
  const recent = options.recentPerRoom ?? WINDOW_RECENT_PER_ROOM;
  const unreadMax = options.unreadMax ?? WINDOW_UNREAD_MAX;
  const textMax = options.textMax ?? WINDOW_TEXT_MAX;
  const cuts: CutRecord[] = [];
  const omitted: Record<string, number> = {};

  // Один проход: итоги по комнатам, хвосты и непрочитанное. Карта в порядке возрастания номера письма.
  const totals = new Map<string | null, number>();
  const tails = new Map<string | null, Message[]>();
  const unread: Message[] = [];
  const unreadRooms: Record<string, number> = {};
  let unreadLetters = 0;
  const byId = new Map<string, Message>();
  for (const message of map.messages) {
    byId.set(message.id, message);
    totals.set(message.roomId, (totals.get(message.roomId) ?? 0) + 1);
    const tail = tails.get(message.roomId) ?? [];
    tail.push(message);
    if (tail.length > recent) tail.shift();
    tails.set(message.roomId, tail);
    if (unreadForHuman(message)) {
      unread.push(message);
      if (message.roomId === null) unreadLetters += 1;
      else unreadRooms[message.roomId] = (unreadRooms[message.roomId] ?? 0) + 1;
    }
  }

  const chosen = new Map<string, Message>();
  for (const tail of tails.values()) for (const message of tail) chosen.set(message.id, message);
  for (const message of unread.slice(-unreadMax)) chosen.set(message.id, message);
  // Подлинник цитаты берётся из той же комнаты: чужой id окно всё равно не покажет.
  for (const message of [...chosen.values()]) {
    const original = message.replyTo === undefined ? undefined : byId.get(message.replyTo);
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
  // Хвост без дыр: с конца карты, пока подряд идут письма комнаты, которые в окне есть.
  const contiguous = new Map<string | null, { from: number | null; broken: boolean }>();
  for (let index = map.messages.length - 1; index >= 0; index -= 1) {
    const message = map.messages[index] as Message;
    const state = contiguous.get(message.roomId) ?? { from: null, broken: false };
    contiguous.set(message.roomId, state);
    if (state.broken) continue;
    if (keptIds.has(message.id)) state.from = seqOf(message.id, 'm-');
    else state.broken = true;
  }
  const rooms: MapCompact['messages']['rooms'] = {};
  for (const [roomId, total] of totals) {
    rooms[roomId ?? 'direct'] = { total, included: keptRooms.get(roomId) ?? 0, tailFrom: contiguous.get(roomId)?.from ?? null };
  }

  const sessions = map.sessions.map((session) => {
    let next: WorkSession = session;
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
  return {
    ...base,
    work,
    sessions,
    messages: kept,
    rooms: roomList,
    ...(plans === undefined ? {} : { plans }),
    // Окно читает только состояние снимков (`pending`/`written`): тело — целый Markdown плана — ему не нужно.
    ...(planExports === undefined ? {} : { planExports: planExports.map((intent) => ({ ...intent, content: '' })) }),
    ...(effects === undefined ? {} : { planEffects: effects }),
    compact: {
      version: 1,
      messages: {
        total: map.messages.length,
        included: kept.length,
        latestId: map.messages.at(-1)?.id ?? null,
        rooms,
      },
      unread: { letters: unreadLetters, rooms: unreadRooms },
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
  /** Единый статус для разговора с человеком: `displayStatus`. */
  status: string;
  resultAt: string | null;
  closedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  role: WorkSession['role'];
  model?: string | null;
  effort?: WorkSession['effort'];
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
  'get_map {field: goal|title} reads the workspace text; {session, field: task|summary|history|artifacts|contextFrom} one session field; {room} one room in full; {field: messages, room?, kind?, cursor?, maxBytes?} message pages (newest first, `next` continues); {field: message, id} one message text; {field: summaries} summaries of all sessions; {field: archive} other workspaces of this project. A cut field names its full size in `cut`.';

/**
 * Топология для агента: участники, статусы, комнаты, действующие ревизии планов, счётчики и курсоры. Размер
 * зависит от числа сессий и комнат, а не от длины переписки; письма, история и артефакты — страницами.
 */
export function mapTopology(map: WorkMap, callerId: string | null): MapTopology {
  const workCut: Cut = {};
  const unreadList = callerId === null ? [] : unreadFor(map, callerId);
  const unreadRooms: Record<string, number> = {};
  let unreadDirect = 0;
  for (const message of unreadList) {
    if (message.roomId === null) unreadDirect += 1;
    else unreadRooms[message.roomId] = (unreadRooms[message.roomId] ?? 0) + 1;
  }
  const perRoom = new Map<string | null, { total: number; latestId: string | null }>();
  for (const message of map.messages) {
    const entry = perRoom.get(message.roomId) ?? { total: 0, latestId: null };
    entry.total += 1;
    entry.latestId = message.id;
    perRoom.set(message.roomId, entry);
  }

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
      status: displayStatus(session),
      resultAt: session.resultAt,
      closedAt: session.closedAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      role: session.role ?? null,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
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
    const counted = perRoom.get(room.id) ?? { total: 0, latestId: null };
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
      members: room.members,
      lead: room.lead ?? null,
      mode: room.mode ?? 'free',
      createdAt: room.createdAt,
      // Плейбук рецепта получает только ведущий (слоем и письмом): в карте агенту видны id и имя.
      recipe: room.recipe == null ? null : { id: room.recipe.id, name: room.recipe.name },
      proposal: waiting,
      messages: { total: counted.total, latestId: counted.latestId, unreadForYou: unreadRooms[room.id] ?? 0 },
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

  const direct = perRoom.get(null) ?? { total: 0, latestId: null };
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
      total: map.messages.length,
      latestId: map.messages.at(-1)?.id ?? null,
      direct,
      unreadForYou: { total: unreadList.length, rooms: unreadRooms, direct: unreadDirect },
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
