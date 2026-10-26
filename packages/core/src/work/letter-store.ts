/**
 * API писем работы (спека хранилища 6.2, план 4, задача 1). Код работает с письмами через `LetterTx` — внутри
 * транзакции `updateMap` (вторым аргументом мутатора) или `writeLetters` — и через функции чтения вне транзакции.
 * Здесь API стоит поверх нынешнего `map.messages`: внутри транзакции это тот же черновик карты, что у мутатора, снаружи —
 * карта из кэша процесса (`readMapView`). Поведение каждого метода — ровно того кода, на который он ссылается; задача 7
 * подставит под тот же API таблицы `messages`, `message_reads` и `message_unread`.
 *
 * Что возвращают методы: внутри транзакции — живые объекты черновика (как `addMessage`), вне её — копии; менять
 * возвращённое письмо нельзя ни там, ни там: меняют письма только методы `LetterTx`.
 */

import type { LetterReader } from './context-pages.js';
import { recipientsOf, unreadFor, unreadForHuman } from './letters.js';
import { addMessage, maxNumber } from './map.js';
import { applyMapUpdate, readMapView, type UpdateMapOptions } from './store.js';
import { HUMAN, type Message, type MessageKind, type MessageVia, type WorkMap } from './types.js';

/** Новое письмо. Номер `m-NN` выдаёт хранилище; `readBy` и `at` задают тесты и переезд, у обычного письма их нет. */
export interface NewLetter {
  roomId: string | null;
  from: string;
  to: string[];
  text: string;
  kind: MessageKind;
  replyTo?: string;
  via?: MessageVia;
  readBy?: Record<string, string>;
  at?: string;
}

/**
 * Выборка писем. Условия складываются по «и»; порядок — порядок карты (по номеру письма), `newestFirst` берёт с конца.
 * `roomId`: не задан — любой канал, `null` — только прямые письма, строка — одна комната. `sinceAt` — строго позже
 * этого момента (как прежнее окно «последний час»: `now - at < окно`). `beforeSeq`/`afterSeq` — по числу из `m-NN`,
 * границы не входят. `limit` обязателен: запрос без предела в транзакции — ошибка вызова.
 */
export interface LetterQuery {
  roomId?: string | null;
  from?: string;
  kind?: MessageKind;
  sinceAt?: string;
  ids?: readonly string[];
  beforeSeq?: number;
  afterSeq?: number;
  limit: number;
  newestFirst?: boolean;
}

export interface LetterTx {
  /** Кладёт письмо в конец с номером `m-NN`; номера не переиспользуются (`work.messageSeq`). */
  add(letter: NewLetter): Message;
  /** `readBy[reader] ??= at` письмам из `ids`; возвращает id писем, отмеченных впервые. Чужие id пропускаются. */
  markRead(reader: string, ids: readonly string[], at: string): string[];
  byId(id: string): Message | undefined;
  query(q: LetterQuery): Message[];
  count(q: Omit<LetterQuery, 'limit'>): number;
  /** Непрочитанное читателем: у сессии — правила `unreadFor` (`letters.ts`), у `human` — `unreadForHuman`. */
  unreadFor(reader: string): Message[];
  /** Сессия вошла в комнату. Пока письма в карте, непрочитанное считается из всех писем — метод ничего не делает. */
  joined(roomId: string, reader: string): void;
  /** Сессия вышла из комнаты. Здесь ничего не делает (см. `joined`). */
  left(roomId: string, reader: string): void;
  /** Комната ушла в архив. Здесь ничего не делает (см. `joined`). */
  archived(roomId: string): void;
  /**
   * Комната возвращена из архива: `readBy[id] ??= at` текущим адресатам каждого письма комнаты, как `reopenRoom`.
   * Зовут после того, как `archivedAt` снова `null`: у архивной комнаты адресатов нет.
   */
  reopened(roomId: string, at: string): void;
  /** Письма комнаты уходят, `work.messageSeq` запоминает наибольший номер до удаления, как `deleteRoom`. */
  deleteRoom(roomId: string): void;
  /** Письма от сессии и к ней получают `deleted = true`, как `removeSession`. */
  flagDeleted(sessionId: string): void;
  /** Эффект плана отменён. Здесь ничего не делает: `cancelledPlanLetter` смотрит в карту. */
  effectCancelled(messageId: string): void;
  /** Исполняет `fn`; бросила — письма и отметки, сделанные внутри через `LetterTx`, пропадают, ошибка идёт дальше. */
  savepoint<T>(fn: () => T): T;
}

/**
 * Чтение писем для читателей карты, у которых нет транзакции (брифы, история комнаты, окна участия). Подходит и сам
 * `LetterTx`. Читатели берут это последним необязательным параметром: без него — письма карты (`mapLetterTx`), пока
 * письма живут в `map.messages`; задача 7 сделает параметр обязательным.
 */
export type LetterReads = Pick<LetterTx, 'query' | 'count'>;

const letterSeq = (id: string): number => maxNumber([id], 'm-');

/** Предел запроса — неотрицательное целое: иначе выборка без границы или с NaN стала бы тихим «ничего» или «всё». */
function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`letter query limit must be a non-negative integer, got ${limit}`);
}

/** Условие выборки одним предикатом; `sinceAt` разбирается один раз. */
function matcher(q: Omit<LetterQuery, 'limit'>): (message: Message) => boolean {
  const ids = q.ids === undefined ? undefined : new Set(q.ids);
  const since = q.sinceAt === undefined ? undefined : Date.parse(q.sinceAt);
  // Нечитаемый момент не должен молча выключать условие: лимиты расхода считают письма «за час» по этому полю.
  if (since !== undefined && Number.isNaN(since)) throw new RangeError(`letter query sinceAt is not a date: ${q.sinceAt}`);
  return (message) =>
    (q.roomId === undefined || message.roomId === q.roomId) &&
    (q.from === undefined || message.from === q.from) &&
    (q.kind === undefined || message.kind === q.kind) &&
    (since === undefined || Date.parse(message.at) > since) &&
    (ids === undefined || ids.has(message.id)) &&
    (q.beforeSeq === undefined || letterSeq(message.id) < q.beforeSeq) &&
    (q.afterSeq === undefined || letterSeq(message.id) > q.afterSeq);
}

function selectLetters(map: Readonly<WorkMap>, q: LetterQuery): Message[] {
  assertLimit(q.limit);
  const matches = matcher(q);
  const list = map.messages;
  const found: Message[] = [];
  if (q.newestFirst === true) {
    for (let at = list.length - 1; at >= 0 && found.length < q.limit; at -= 1) {
      if (matches(list[at]!)) found.push(list[at]!);
    }
  } else {
    for (let at = 0; at < list.length && found.length < q.limit; at += 1) {
      if (matches(list[at]!)) found.push(list[at]!);
    }
  }
  return found;
}

function countLetters(map: Readonly<WorkMap>, q: Omit<LetterQuery, 'limit'>): number {
  const matches = matcher(q);
  let total = 0;
  for (const message of map.messages) if (matches(message)) total += 1;
  return total;
}

const unreadOf = (map: Readonly<WorkMap>, reader: string): Message[] =>
  reader === HUMAN ? map.messages.filter(unreadForHuman) : unreadFor(map, reader);

/** Ключ канала в итогах: комната — её id, прямые письма — пустая строка. */
const channelOf = (message: Message): string => message.roomId ?? '';

function unreadCountOf(map: Readonly<WorkMap>, reader: string): { total: number; byRoom: Record<string, number> } {
  const byRoom: Record<string, number> = {};
  const unread = unreadOf(map, reader);
  for (const message of unread) byRoom[channelOf(message)] = (byRoom[channelOf(message)] ?? 0) + 1;
  return { total: unread.length, byRoom };
}

function channelStatsOf(map: Readonly<WorkMap>): Record<string, { total: number; latestId: string | null }> {
  const stats: Record<string, { total: number; latestId: string | null }> = {};
  const latest: Record<string, number> = {};
  for (const message of map.messages) {
    const channel = channelOf(message);
    const entry = (stats[channel] ??= { total: 0, latestId: null });
    entry.total += 1;
    // Новейшее — с наибольшим номером, при равных последнее в карте: так его назовёт индекс таблицы по (канал, номер).
    const seq = letterSeq(message.id);
    if (entry.latestId === null || seq >= (latest[channel] ?? 0)) {
      entry.latestId = message.id;
      latest[channel] = seq;
    }
  }
  return stats;
}

/**
 * `LetterTx` над черновиком карты `map` (ссылку на `map.messages` не держим: `deleteRoom` подменяет массив) и признак
 * «письма были записаны» для `updateMap`: когда письма лягут в свои таблицы, диф строк карты их не увидит и пустую запись
 * от непустой отличит только он. Признак поднимают методы, которые что-то изменили.
 *
 * `savepoint` ведёт журнал отмен только своих методов: объекты, которые держит вызывающий, остаются теми же, а
 * вложенный `savepoint` при успехе отдаёт свой журнал внешнему.
 *
 * Экспортируется из ядра: хост гоняет на копии карты пробный расчёт доставки планов (`rooms/plan-effects.ts`), а тесты —
 * правила комнат и планов над картой без транзакции; читатели без транзакции берут его по умолчанию (`LetterReads`).
 */
export function mapLetterTx(map: WorkMap): { letters: LetterTx; wrote: () => boolean } {
  let wrote = false;
  const logs: Array<Array<() => void>> = [];
  const record = (undo: () => void): void => {
    logs.at(-1)?.push(undo);
  };

  const letters: LetterTx = {
    add(letter) {
      const message = addMessage(
        map,
        {
          from: letter.from,
          to: letter.to,
          text: letter.text,
          kind: letter.kind,
          roomId: letter.roomId,
          ...(letter.replyTo === undefined ? {} : { replyTo: letter.replyTo }),
          ...(letter.via === undefined ? {} : { via: letter.via }),
        },
        letter.at,
      );
      if (letter.readBy !== undefined) message.readBy = { ...letter.readBy };
      wrote = true;
      record(() => {
        const at = map.messages.lastIndexOf(message);
        if (at !== -1) map.messages.splice(at, 1);
      });
      return message;
    },

    markRead(reader, ids, at) {
      const wanted = new Set(ids);
      const marked: string[] = [];
      for (const message of map.messages) {
        if (!wanted.has(message.id) || message.readBy[reader] !== undefined) continue;
        message.readBy[reader] = at;
        marked.push(message.id);
        record(() => {
          delete message.readBy[reader];
        });
      }
      if (marked.length > 0) wrote = true;
      return marked;
    },

    byId: (id) => map.messages.find((message) => message.id === id),
    query: (q) => selectLetters(map, q),
    count: (q) => countLetters(map, q),
    unreadFor: (reader) => unreadOf(map, reader),

    joined() {},
    left() {},
    archived() {},
    effectCancelled() {},

    reopened(roomId, at) {
      for (const message of map.messages) {
        if (message.roomId !== roomId) continue;
        for (const id of recipientsOf(message, map)) {
          if (message.readBy[id] !== undefined) continue;
          message.readBy[id] = at;
          wrote = true;
          record(() => {
            delete message.readBy[id];
          });
        }
      }
    },

    deleteRoom(roomId) {
      const before = map.messages;
      const seqBefore = map.work.messageSeq;
      map.work.messageSeq = Math.max(map.work.messageSeq ?? 0, maxNumber(map.messages.map((message) => message.id), 'm-'));
      map.messages = map.messages.filter((message) => message.roomId !== roomId);
      wrote = true;
      record(() => {
        map.messages = before;
        if (seqBefore === undefined) delete map.work.messageSeq;
        else map.work.messageSeq = seqBefore;
      });
    },

    flagDeleted(sessionId) {
      for (const message of map.messages) {
        // `to` — массив: сравнивать с ним строку было бы всегда ложно (как в `removeSession`).
        if ((message.from !== sessionId && !message.to.includes(sessionId)) || message.deleted === true) continue;
        const previous = message.deleted;
        message.deleted = true;
        wrote = true;
        record(() => {
          if (previous === undefined) delete message.deleted;
          else message.deleted = previous;
        });
      }
    },

    savepoint<T>(fn: () => T): T {
      const log: Array<() => void> = [];
      const wroteBefore = wrote;
      logs.push(log);
      try {
        const result = fn();
        logs.pop();
        for (const undo of log) record(undo);
        return result;
      } catch (error) {
        logs.pop();
        for (let at = log.length - 1; at >= 0; at -= 1) log[at]!();
        wrote = wroteBefore;
        throw error;
      }
    },
  };
  return { letters, wrote: () => wrote };
}

/**
 * Пишет письма работы одной транзакцией. Синхронна, как тело `updateMap`; `fn` получает `LetterTx` и карту только для
 * чтения (правила и комнаты). Ничего не записала — версия работы, `updatedAt` и подписчики `onMapWritten` не
 * шевелятся. `touch: false` — `updatedAt` не сдвигается, когда запись всё же была.
 */
export function writeLetters<T>(
  projectPath: string,
  workId: string,
  fn: (letters: LetterTx, map: Readonly<WorkMap>) => T,
  options?: Pick<UpdateMapOptions, 'touch' | 'lockTimeoutMs'>,
): T {
  let result: T | undefined;
  applyMapUpdate(projectPath, workId, (map, letters) => {
    result = fn(letters, map);
  }, options);
  return result as T;
}

/** Выборка писем вне транзакции — копии, не объекты кэша. */
export function readLetters(projectPath: string, workId: string, q: LetterQuery): Message[] {
  return structuredClone(selectLetters(readMapView(projectPath, workId), q));
}

export function letterById(projectPath: string, workId: string, id: string): Message | undefined {
  const message = readMapView(projectPath, workId).messages.find((candidate) => candidate.id === id);
  return message === undefined ? undefined : structuredClone(message);
}

export function unreadLetters(projectPath: string, workId: string, reader: string): Message[] {
  return structuredClone(unreadOf(readMapView(projectPath, workId), reader));
}

/** Число непрочитанного читателем: всего и по каналам; ключ `''` — прямые письма. */
export function unreadCount(
  projectPath: string,
  workId: string,
  reader: string,
): { total: number; byRoom: Record<string, number> } {
  return unreadCountOf(readMapView(projectPath, workId), reader);
}

/** Письма по каналам: сколько и номер новейшего; ключ `''` — прямые письма. Каналов без писем нет. */
export function channelStats(projectPath: string, workId: string): Record<string, { total: number; latestId: string | null }> {
  return channelStatsOf(readMapView(projectPath, workId));
}

/** Сколько писем подходит под условия вне транзакции (итог страницы, `LetterReader.count`). */
export function letterCount(projectPath: string, workId: string, q: Omit<LetterQuery, 'limit'>): number {
  return countLetters(readMapView(projectPath, workId), q);
}

/**
 * Читатель писем для страниц и снимка (`LetterReader`, спека хранилища 6.2, 6.7) над картой `map`: то, что берут
 * `messagePage`, `mapTopology` и `compactWorkMap`, когда читателя им не передали. Возвращает живые объекты карты;
 * менять их нельзя. Ключ канала `''` — прямые письма.
 */
export function mapLetterReader(map: Readonly<WorkMap>): LetterReader {
  return {
    page: (q) => selectLetters(map, q),
    count: (q) => countLetters(map, q),
    byIds: (ids) => selectLetters(map, { ids, limit: ids.length }),
    tail: (roomId, n) => selectLetters(map, { roomId, limit: n, newestFirst: true }).reverse(),
    humanUnread: (limit) => (limit <= 0 ? [] : unreadOf(map, HUMAN).slice(-limit)),
    unreadCount: (reader) => unreadCountOf(map, reader),
    channelStats: () => channelStatsOf(map),
  };
}

/** Читатель писем работы вне транзакции: то же, что `mapLetterReader`, но над функциями чтения этого файла (копии писем). */
export function storeLetterReader(projectPath: string, workId: string): LetterReader {
  return {
    page: (q) => readLetters(projectPath, workId, q),
    count: (q) => letterCount(projectPath, workId, q),
    byIds: (ids) => readLetters(projectPath, workId, { ids, limit: ids.length }),
    tail: (roomId, n) => readLetters(projectPath, workId, { roomId, limit: n, newestFirst: true }).reverse(),
    humanUnread: (limit) => (limit <= 0 ? [] : unreadLetters(projectPath, workId, HUMAN).slice(-limit)),
    unreadCount: (reader) => unreadCount(projectPath, workId, reader),
    channelStats: () => channelStats(projectPath, workId),
  };
}

/**
 * Ставит `readBy.human` письмам, которые человек видит: прямым письмам человеку и сообщениям комнат, не от самого
 * человека (`unreadForHuman`). Уже прочитанные и чужие id пропускаются. Возвращает, сколько отметок поставлено.
 * `work.updatedAt` не сдвигается. Подходящих id нет — 0 без записи. Работы нет — `WorkNotFoundError`: его бросает
 * уже чтение, как и запись.
 */
export async function markHumanRead(projectPath: string, workId: string, messageIds: string[]): Promise<number> {
  // Предел запроса — число id: подходящих писем не больше, чем названо.
  const wanted = [...new Set(messageIds)];
  const pending = (read: (q: LetterQuery) => Message[]): string[] =>
    read({ ids: wanted, limit: wanted.length })
      .filter(unreadForHuman)
      .map((message) => message.id);

  // Сперва чтение без записи: пустая запись версию не поднимает, но берёт блокировку записи, а повтор пачки окна
  // не должен её занимать (спека хранилища 6.2).
  if (pending((q) => readLetters(projectPath, workId, q)).length === 0) return 0;

  // Под блокировкой отбираем заново: другой клиент мог отметить часть писем между чтениями.
  let marked = 0;
  writeLetters(
    projectPath,
    workId,
    (letters) => {
      marked = letters.markRead(HUMAN, pending((q) => letters.query(q)), new Date().toISOString()).length;
    },
    { touch: false },
  );
  return marked;
}
