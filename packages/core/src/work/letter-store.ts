/**
 * API писем работы (спека хранилища 6.2, план 4). Код работает с письмами через `LetterTx` — внутри транзакции `updateMap`
 * (вторым аргументом мутатора) или `writeLetters` — и через функции чтения вне транзакции. Письма лежат в таблицах
 * `messages`, `message_reads` и `message_unread` (`letter-tables.ts`), а не в карте: хранимая карта (`WorkMap`) писем не
 * содержит, карта с письмами — `WindowWorkMap` (окно, страницы, тесты).
 *
 * Для карты с письмами в памяти (тесты правил комнат и планов, сверка переезда) есть `mapLetterTx` и `mapLetterReader` — то же
 * API над массивом `map.messages`.
 *
 * Что возвращают методы: письма из таблиц — новые объекты, их можно держать; письма из `mapLetterTx` — живые объекты
 * карты, менять их нельзя: письма меняют только методы `LetterTx`.
 */

import type { LetterReader } from './context-pages.js';
import {
  assertLetter,
  assertLimit,
  channelKey,
  channelTotals,
  countLetters as countRows,
  humanUnreadTail,
  humanUnreadTotals,
  letterByIdRow,
  letterSeq,
  NON_AGENT_SENDERS,
  roomLetterTops as roomTops,
  selectLetters as selectRows,
  sessionUnreadTotals,
  sinceBound,
  unreadOfHuman,
  unreadOfSession,
} from './letter-tables.js';
import { recipientsOf, unreadFor, unreadForHuman } from './letters.js';
import { addMessage, maxNumber } from './map.js';
import { applyMapUpdate, letterDb, readMapView, readTransaction, storeDb, type UpdateMapOptions } from './store.js';
import { HUMAN, type Message, type MessageKind, type MessageVia, type WindowWorkMap, type WorkMap } from './types.js';

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
 * Выборка писем. Условия складываются по «и»; порядок — по номеру письма, `newestFirst` берёт с конца.
 * `roomId`: не задан — любой канал, `null` — только прямые письма, строка — одна комната. `sinceAt` — строго позже
 * этого момента (как прежнее окно «последний час»: `now - at < окно`). `beforeSeq`/`afterSeq` — по числу из `m-NN`,
 * границы не входят. `agentsOnly` — только письма агентов: не от человека, хоста и плана (`resource-policy.ts`).
 * `involving` — отправитель или кто-то из адресатов письма назван в списке (предотбор прямых писем семьи сессий, пока
 * точное правило видимости применяет вызывающий). `limit` обязателен: запрос без предела — ошибка вызова.
 */
export interface LetterQuery {
  roomId?: string | null;
  from?: string;
  kind?: MessageKind;
  sinceAt?: string;
  ids?: readonly string[];
  beforeSeq?: number;
  afterSeq?: number;
  agentsOnly?: boolean;
  involving?: readonly string[];
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
  /** Непрочитанное читателем: у сессии — правила `isUnreadFor` (`letters.ts`), у `human` — `isHumanUnread`. */
  unreadFor(reader: string): Message[];
  /** Сессия вошла в комнату: все рассылки комнаты без её отметки и не от неё становятся ей непрочитанными. */
  joined(roomId: string, reader: string): void;
  /** Сессия вышла из комнаты: рассылки комнаты ей больше не непрочитанные (письма с явным `to` остаются адресату). */
  left(roomId: string, reader: string): void;
  /** Комната ушла в архив: у неё нет адресатов-сессий, человеку её письма остаются непрочитанными. */
  archived(roomId: string): void;
  /**
   * Комната возвращена из архива: `readBy[id] ??= at` текущим адресатам каждого письма комнаты, как `reopenRoom`.
   * Зовут после того, как `archivedAt` снова `null`: у архивной комнаты адресатов нет.
   */
  reopened(roomId: string, at: string): void;
  /**
   * Письма комнаты уходят, `work.messageSeq` запоминает наибольший номер до удаления, как `deleteRoom`. Комната без писем
   * ничего не меняет.
   */
  deleteRoom(roomId: string): void;
  /** Письма от сессии и к ней получают `deleted = true`, как `removeSession`; непрочитанное самой сессии уходит. */
  flagDeleted(sessionId: string): void;
  /** Эффект плана отменён: письмо больше не непрочитанное у сессий (человек видит его по своему правилу). */
  effectCancelled(messageId: string): void;
  /**
   * Исполняет синхронную `fn`; бросила — письма и отметки, сделанные внутри через `LetterTx`, пропадают, ошибка идёт дальше.
   * Асинхронную `fn` не принимает: откатить отложенную работу нечем.
   */
  savepoint<T>(fn: () => T): T;
}

/**
 * Чтение писем для читателей карты, у которых нет транзакции (брифы, история комнаты, окна участия). Подходит и сам
 * `LetterTx`; вне транзакции — `storeLetterReads` над таблицами или `mapLetterTx` над картой с письмами.
 */
export type LetterReads = Pick<LetterTx, 'query' | 'count'>;

/** Условие выборки одним предикатом над письмом из памяти; `sinceAt` разбирается один раз. */
function matcher(q: Omit<LetterQuery, 'limit'>): (message: Message) => boolean {
  const ids = q.ids === undefined ? undefined : new Set(q.ids);
  const since = q.sinceAt === undefined ? undefined : Date.parse(sinceBound(q.sinceAt));
  return (message) =>
    (q.roomId === undefined || message.roomId === q.roomId) &&
    (q.from === undefined || message.from === q.from) &&
    (q.agentsOnly !== true || !NON_AGENT_SENDERS.includes(message.from)) &&
    (q.involving === undefined || q.involving.includes(message.from) || message.to.some((id) => q.involving?.includes(id))) &&
    (q.kind === undefined || message.kind === q.kind) &&
    (since === undefined || Date.parse(message.at) > since) &&
    (ids === undefined || ids.has(message.id)) &&
    (q.beforeSeq === undefined || letterSeq(message.id) < q.beforeSeq) &&
    (q.afterSeq === undefined || letterSeq(message.id) > q.afterSeq);
}

function selectLetters(map: Pick<WindowWorkMap, 'messages'>, q: LetterQuery): Message[] {
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

function countLetters(map: Pick<WindowWorkMap, 'messages'>, q: Omit<LetterQuery, 'limit'>): number {
  const matches = matcher(q);
  let total = 0;
  for (const message of map.messages) if (matches(message)) total += 1;
  return total;
}

const unreadOf = (map: WindowWorkMap, reader: string): Message[] =>
  reader === HUMAN ? map.messages.filter(unreadForHuman) : unreadFor(map, reader);

function unreadCountOf(map: WindowWorkMap, reader: string): { total: number; byRoom: Record<string, number> } {
  const byRoom: Record<string, number> = {};
  const unread = unreadOf(map, reader);
  for (const message of unread) byRoom[channelKey(message.roomId)] = (byRoom[channelKey(message.roomId)] ?? 0) + 1;
  return { total: unread.length, byRoom };
}

function channelStatsOf(map: Pick<WindowWorkMap, 'messages'>): Record<string, { total: number; latestId: string | null }> {
  const stats: Record<string, { total: number; latestId: string | null }> = {};
  const latest: Record<string, number> = {};
  for (const message of map.messages) {
    const channel = channelKey(message.roomId);
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
 * `LetterTx` над картой с письмами в памяти `map` (ссылку на `map.messages` не держим: `deleteRoom` подменяет массив) и
 * признак «письма были записаны». Для тестов правил комнат и планов и для читателей без базы: письма в базе кладёт
 * `createTableLetterTx`. Непрочитанное считается по всем письмам карты, поэтому `joined`, `left`, `archived` и
 * `effectCancelled` здесь ничего не делают.
 *
 * `savepoint` ведёт журнал отмен только своих методов: объекты, которые держит вызывающий, остаются теми же, а
 * вложенный `savepoint` при успехе отдаёт свой журнал внешнему.
 */
export function mapLetterTx(map: WindowWorkMap): { letters: LetterTx; wrote: () => boolean } {
  let wrote = false;
  const logs: Array<Array<() => void>> = [];
  const record = (undo: () => void): void => {
    logs.at(-1)?.push(undo);
  };

  const letters: LetterTx = {
    add(letter) {
      assertLetter(letter);
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
      // Комната без писем номер не двигает и ничего не пишет.
      if (!before.some((message) => message.roomId === roomId)) return;
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

/** Выборка писем вне транзакции. Работы нет — `WorkNotFoundError`. */
export function readLetters(projectPath: string, workId: string, q: LetterQuery): Message[] {
  return selectRows(letterDb(projectPath, workId), projectPath, workId, q);
}

export function letterById(projectPath: string, workId: string, id: string): Message | undefined {
  return letterByIdRow(letterDb(projectPath, workId), projectPath, workId, id);
}

/**
 * Параметры чтения непрочитанного вне транзакции. `map` — карта вызывающего (снимок хоста, который он и так держит):
 * живые правила (`recipientsOf`, `cancelledPlanLetter`) идут по ней, а из базы читаются только кандидаты читателя и их письма;
 * карта работы не загружается. Пересчёт будильника и метрик зовёт это на каждую сессию каждой работы при каждом изменении, а
 * кэш карт — всего `MAP_CACHE_LIMIT` записей: без `map` при большем числе работ каждый проход загружал бы карты заново
 * (спека хранилища 6.2). Работы в базе нет — кандидатов нет, ответ пуст.
 */
export interface UnreadOptions {
  map?: Readonly<WorkMap>;
}

export function unreadLetters(projectPath: string, workId: string, reader: string, options: UnreadOptions = {}): Message[] {
  const db = options.map === undefined ? letterDb(projectPath, workId) : storeDb();
  if (reader === HUMAN) return unreadOfHuman(db, projectPath, workId);
  const map = options.map ?? readMapView(projectPath, workId);
  return unreadOfSession(db, projectPath, workId, reader, map, (id) => letterByIdRow(db, projectPath, workId, id));
}

/** Число непрочитанного читателем: всего и по каналам; ключ `''` — прямые письма. */
export function unreadCount(
  projectPath: string,
  workId: string,
  reader: string,
  options: UnreadOptions = {},
): { total: number; byRoom: Record<string, number> } {
  const db = options.map === undefined ? letterDb(projectPath, workId) : storeDb();
  if (reader === HUMAN) return humanUnreadTotals(db, projectPath, workId);
  const map = options.map ?? readMapView(projectPath, workId);
  return sessionUnreadTotals(db, projectPath, workId, reader, map, (id) => letterByIdRow(db, projectPath, workId, id));
}

/** Письма по каналам: сколько и номер новейшего; ключ `''` — прямые письма. Каналов без писем нет. */
export function channelStats(projectPath: string, workId: string): Record<string, { total: number; latestId: string | null }> {
  const db = letterDb(projectPath, workId);
  return readTransaction(db, () => channelTotals(db, projectPath, workId));
}

/**
 * Номер новейшего письма каждой из комнат `roomIds` (комнат без писем в ответе нет): запрос `MAX(seq)` на комнату по индексу
 * канала. Для отпечатков, которые сверяют на каждое изменение работ: цена — от числа комнат, не писем. Работы нет —
 * `WorkNotFoundError`.
 */
export function roomLetterTops(projectPath: string, workId: string, roomIds: readonly string[]): Record<string, number> {
  return roomTops(letterDb(projectPath, workId), projectPath, workId, roomIds);
}

/** Сколько писем подходит под условия вне транзакции (итог страницы, `LetterReader.count`). */
export function letterCount(projectPath: string, workId: string, q: Omit<LetterQuery, 'limit'>): number {
  return countRows(letterDb(projectPath, workId), projectPath, workId, q);
}

/**
 * Читатель писем для страниц и снимка (`LetterReader`, спека хранилища 6.2, 6.7) над картой с письмами `map`: то, что
 * берут `messagePage`, `mapTopology` и `compactWorkMap`, когда письма в памяти (чистые тесты, окно). Возвращает живые объекты
 * карты; менять их нельзя. Ключ канала `''` — прямые письма.
 */
export function mapLetterReader(map: WindowWorkMap): LetterReader {
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

/**
 * Читатель писем работы вне транзакции: то же, что `mapLetterReader`, но над таблицами. `options.map` — карта вызывающего
 * для живых правил непрочитанного сессий (снимок окна хоста): снимок писем не содержит, и сборка снимка не грузит карты из
 * базы (`UnreadOptions`).
 */
export function storeLetterReader(projectPath: string, workId: string, options: UnreadOptions = {}): LetterReader {
  return {
    page: (q) => readLetters(projectPath, workId, q),
    count: (q) => letterCount(projectPath, workId, q),
    byIds: (ids) => readLetters(projectPath, workId, { ids, limit: ids.length }),
    tail: (roomId, n) => readLetters(projectPath, workId, { roomId, limit: n, newestFirst: true }).reverse(),
    humanUnread: (limit) => humanUnreadTail(letterDb(projectPath, workId), projectPath, workId, limit),
    unreadCount: (reader) => unreadCount(projectPath, workId, reader, options),
    channelStats: () => channelStats(projectPath, workId),
  };
}

/** Чтение писем работы для читателей карты (`LetterReads`): брифы, история комнаты, окна участия. */
export const storeLetterReads = (projectPath: string, workId: string): LetterReads => ({
  query: (q) => readLetters(projectPath, workId, q),
  count: (q) => letterCount(projectPath, workId, q),
});

/**
 * `LetterTx` для пробного расчёта на копии карты `map`, ничего не пишущий в базу (хост проверяет, изменит ли доставка планов
 * карту, не беря блокировку записи). Чтение — из таблиц работы вне транзакции; `add` отдаёт письмо со следующим номером, но
 * не сохраняет его; отметки и прочее — пустые. Расчёт, зависящий от того, что записанное тут же прочитается, получит прежнюю
 * картину базы.
 */
export function previewLetterTx(projectPath: string, workId: string, map: WorkMap): LetterTx {
  // Номер следующего письма читается при первой записи: расчёт, который письма не пишет, базы не касается.
  let top: number | undefined;
  return {
    add(letter) {
      assertLetter(letter);
      top ??= Math.max(
        map.work.messageSeq ?? 0,
        letterSeq(readLetters(projectPath, workId, { limit: 1, newestFirst: true })[0]?.id ?? ''),
      );
      top += 1;
      return {
        id: `m-${String(top).padStart(2, '0')}`,
        roomId: letter.roomId ?? null,
        from: letter.from,
        to: [...letter.to],
        at: letter.at ?? new Date().toISOString(),
        text: letter.text,
        kind: letter.kind,
        readBy: { ...(letter.readBy ?? {}) },
        ...(letter.replyTo === undefined ? {} : { replyTo: letter.replyTo }),
        ...(letter.via === undefined ? {} : { via: letter.via }),
      };
    },
    markRead: () => [],
    byId: (id) => letterById(projectPath, workId, id),
    query: (q) => readLetters(projectPath, workId, q),
    count: (q) => letterCount(projectPath, workId, q),
    unreadFor: (reader) => unreadLetters(projectPath, workId, reader, { map }),
    joined() {},
    left() {},
    archived() {},
    reopened() {},
    deleteRoom() {},
    flagDeleted() {},
    effectCancelled() {},
    savepoint: (fn) => fn(),
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
