/**
 * Письма работы на таблицах `messages`, `message_reads` и `message_unread` (спека хранилища 6.2, план 4, задача 7): SQL
 * под API `LetterTx` и функциями чтения (`letter-store.ts`). Модуль не знает ни кэша карт, ни блокировок записи — только
 * соединение с базой, ключ работы и живые правила непрочитанного (`letters.ts`); `store.ts` зовёт его внутри своих
 * транзакций, `letter-store.ts` — снаружи.
 *
 * Непрочитанное хранится кандидатами (`message_unread`): надмножеством того, что читатель ещё не прочёл. Окончательно
 * письмо отбирают прежние правила на маленьком наборе кандидатов — `isUnreadFor` (`recipientsOf`, `cancelledPlanLetter`) у
 * сессий, `isHumanUnread` у человека. Инвариант: у читателя нет кандидата на письмо, которое он уже отметил
 * (`message_reads`), а человек — кандидат на каждое письмо, которое он видит и не прочёл, и ни на какое другое: поэтому его
 * счётчики считаются запросом по кандидатам без разбора писем.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isHumanUnread } from './attention.js';
import type { LetterQuery, LetterTx, NewLetter } from './letter-store.js';
import { isUnreadFor, recipientsOf, type LetterLookup } from './letters.js';
import { maxNumber } from './map.js';
import { isRoomArchived } from './rooms.js';
import { sql } from './sql-statements.js';
import { HUMAN, MESSAGE_KINDS, PARLEY, SYSTEM, type Message, type MessageKind, type MessageVia, type WindowWorkMap, type WorkMap } from './types.js';

/** Число из номера письма `m-NN`; `0` — id не из этой нумерации. */
export const letterSeq = (id: string): number => maxNumber([id], 'm-');

/** Предел запроса — неотрицательное целое: иначе выборка без границы или с NaN стала бы тихим «ничего» или «всё». */
export function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`letter query limit must be a non-negative integer, got ${limit}`);
}

/** `sinceAt` в виде, по которому строки `at` сравниваются как текст: канонический ISO-момент. Нечитаемый — ошибка вызова. */
export function sinceBound(sinceAt: string): string {
  // Нечитаемый момент не должен молча выключать условие: лимиты расхода считают письма «за час» по этому полю.
  const since = Date.parse(sinceAt);
  if (Number.isNaN(since)) throw new RangeError(`letter query sinceAt is not a date: ${sinceAt}`);
  return new Date(since).toISOString();
}

/** Отправители, которых нет среди агентов: письма человека, хоста и плана не тратят разговорную квоту (`resource-policy.ts`). */
export const NON_AGENT_SENDERS: readonly string[] = [HUMAN, SYSTEM, PARLEY];

/** Строка таблицы `messages` с отметками прочтения, собранными в JSON-объект `reads`. */
interface LetterRow {
  seq: number;
  id: string;
  room_id: string | null;
  sender: string;
  recipients: string;
  at: string;
  kind: string;
  deleted: number;
  body: string;
  reads: string | null;
}

/**
 * Колонки письма и его `readBy`, собранный из `message_reads` только для отобранных строк (спека хранилища 6.2): коррелированный
 * подзапрос идёт по первичному ключу отметок, а не по всем отметкам работы.
 */
const LETTER_COLUMNS = `m.seq, m.id, m.room_id, m.sender, m.recipients, m.at, m.kind, m.deleted, m.body,
  (SELECT json_group_object(r.reader, r.at) FROM message_reads r
    WHERE r.project_path = m.project_path AND r.work_id = m.work_id AND r.seq = m.seq) AS reads`;

/**
 * Колонки кандидатов для подсчёта: отметки не нужны (у кандидата читателя их нет), а текст нужен только письмам плана —
 * по нему `cancelledPlanLetter` узнаёт письмо эффекта; у остальных он пустой.
 */
const COUNTING_COLUMNS = `m.seq, m.id, m.room_id, m.sender, m.recipients, m.at, m.kind, m.deleted,
  CASE WHEN m.sender = '${PARLEY}' THEN m.body ELSE '{"text":""}' END AS body, NULL AS reads`;

function toMessage(row: LetterRow): Message {
  const body = JSON.parse(row.body) as { text: string; replyTo?: string; via?: MessageVia };
  const message: Message = {
    id: row.id,
    roomId: row.room_id,
    from: row.sender,
    to: JSON.parse(row.recipients) as string[],
    at: row.at,
    text: body.text,
    kind: row.kind as MessageKind,
    readBy: row.reads === null ? {} : (JSON.parse(row.reads) as Record<string, string>),
  };
  if (body.replyTo !== undefined) message.replyTo = body.replyTo;
  if (body.via !== undefined) message.via = body.via;
  if (row.deleted === 1) message.deleted = true;
  return message;
}

const rowsOf = (db: DatabaseSync, text: string, params: SQLInputValue[]): Message[] =>
  (sql(db, text).all(...params) as unknown as LetterRow[]).map(toMessage);

type Condition = Omit<LetterQuery, 'limit'>;

/**
 * Откуда и как выбирать: `from` — таблица писем или, когда названы номера, список номеров (`json_each`) снаружи и письма
 * внутри (`CROSS JOIN` держит этот порядок): письма берутся по уникальному индексу `messages_id`, а не обходом всех писем
 * работы с фильтром `id IN (…)`, который планировщик выбирал сам. `where` — «и» всех заданных условий; параметры идут в
 * порядке подстановок. Нечитаемый `sinceAt` — `RangeError`.
 */
function conditions(projectPath: string, workId: string, q: Condition): { from: string; where: string; params: SQLInputValue[] } {
  const where = ['m.project_path = ?', 'm.work_id = ?'];
  const params: SQLInputValue[] = [];
  let from = 'messages m';
  if (q.ids !== undefined) {
    from = 'json_each(?) j CROSS JOIN messages m';
    params.push(JSON.stringify([...new Set(q.ids)]));
    where.push('m.id = j.value');
  }
  params.push(projectPath, workId);
  if (q.roomId === null) where.push('m.room_id IS NULL');
  else if (q.roomId !== undefined) {
    where.push('m.room_id = ?');
    params.push(q.roomId);
  }
  if (q.from !== undefined) {
    where.push('m.sender = ?');
    params.push(q.from);
  }
  if (q.agentsOnly === true) where.push(`m.sender NOT IN (${NON_AGENT_SENDERS.map((id) => `'${id}'`).join(', ')})`);
  if (q.involving !== undefined) {
    const named = JSON.stringify(q.involving);
    where.push(
      'm.sender IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(m.recipients) r WHERE r.value IN (SELECT value FROM json_each(?)))',
    );
    params.push(named, named);
  }
  if (q.kind !== undefined) {
    where.push('m.kind = ?');
    params.push(q.kind);
  }
  if (q.sinceAt !== undefined) {
    where.push('m.at > ?');
    params.push(sinceBound(q.sinceAt));
  }
  // Границы номера не входят; нечисловая и бесконечная граница ведут себя, как сравнение чисел.
  if (q.beforeSeq !== undefined && q.beforeSeq !== Number.POSITIVE_INFINITY) {
    if (Number.isNaN(q.beforeSeq) || q.beforeSeq === Number.NEGATIVE_INFINITY) where.push('0');
    else {
      where.push('m.seq < ?');
      params.push(q.beforeSeq);
    }
  }
  if (q.afterSeq !== undefined && q.afterSeq !== Number.NEGATIVE_INFINITY) {
    if (Number.isNaN(q.afterSeq) || q.afterSeq === Number.POSITIVE_INFINITY) where.push('0');
    else {
      where.push('m.seq > ?');
      params.push(q.afterSeq);
    }
  }
  // Условие с OR берётся в скобки, чтобы «и» остальных условий не расползлось по нему.
  return { from, where: where.map((condition) => `(${condition})`).join(' AND '), params };
}

/** Выборка писем по номеру письма; `newestFirst` берёт новейшие и отдаёт их от новейшего к старому. */
export function selectLetters(db: DatabaseSync, projectPath: string, workId: string, q: LetterQuery): Message[] {
  assertLimit(q.limit);
  const { from, where, params } = conditions(projectPath, workId, q);
  if (q.limit === 0) return [];
  return rowsOf(
    db,
    `SELECT ${LETTER_COLUMNS} FROM ${from} WHERE ${where} ORDER BY m.seq ${q.newestFirst === true ? 'DESC' : 'ASC'} LIMIT ?`,
    [...params, q.limit],
  );
}

/** Сколько писем подходит под условия: `COUNT(*)` по индексу канала (спека хранилища 6.2). */
export function countLetters(db: DatabaseSync, projectPath: string, workId: string, q: Condition): number {
  const { from, where, params } = conditions(projectPath, workId, q);
  return Number(sql(db, `SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`).get(...params)?.['n']);
}

export function letterByIdRow(db: DatabaseSync, projectPath: string, workId: string, id: string): Message | undefined {
  const row = sql(db, `SELECT ${LETTER_COLUMNS} FROM messages m WHERE m.project_path = ? AND m.work_id = ? AND m.id = ?`).get(
    projectPath,
    workId,
    id,
  );
  return row === undefined ? undefined : toMessage(row as unknown as LetterRow);
}

/** Все письма работы по возрастанию номера, каждое с отметками: полная карта (`readStoredMap`, выгрузка, сверка переезда). */
export function loadAllLetters(db: DatabaseSync, projectPath: string, workId: string): Message[] {
  return rowsOf(
    db,
    `SELECT ${LETTER_COLUMNS} FROM messages m WHERE m.project_path = ? AND m.work_id = ? ORDER BY m.seq`,
    [projectPath, workId],
  );
}

/** Ключ канала в итогах: комната — её id, прямые письма — пустая строка. */
export const channelKey = (roomId: string | null): string => roomId ?? '';

/** Письма по каналам: сколько и номер новейшего. Каналов без писем нет. */
export function channelTotals(
  db: DatabaseSync,
  projectPath: string,
  workId: string,
): Record<string, { total: number; latestId: string | null }> {
  const stats: Record<string, { total: number; latestId: string | null }> = {};
  const channels = sql(
    db,
    'SELECT room_id, COUNT(*) AS total, MAX(seq) AS top FROM messages WHERE project_path = ? AND work_id = ? GROUP BY room_id',
  ).all(projectPath, workId);
  for (const channel of channels) {
    const latest = sql(db, 'SELECT id FROM messages WHERE project_path = ? AND work_id = ? AND seq = ?').get(
      projectPath,
      workId,
      Number(channel['top']),
    );
    stats[channelKey((channel['room_id'] as string | null) ?? null)] = {
      total: Number(channel['total']),
      latestId: latest === undefined ? null : String(latest['id']),
    };
  }
  return stats;
}

/** Кандидаты читателя — письма по возрастанию номера; `counting` — лёгкие строки для подсчёта (см. `COUNTING_COLUMNS`). */
function candidates(db: DatabaseSync, projectPath: string, workId: string, reader: string, counting: boolean): Message[] {
  return rowsOf(
    db,
    `SELECT ${counting ? COUNTING_COLUMNS : LETTER_COLUMNS} FROM message_unread u
       JOIN messages m ON m.project_path = u.project_path AND m.work_id = u.work_id AND m.seq = u.seq
      WHERE u.project_path = ? AND u.work_id = ? AND u.reader = ? ORDER BY u.seq`,
    [projectPath, workId, reader],
  );
}

/**
 * Непрочитанное сессии: кандидаты, затем живые правила `isUnreadFor` на карте `map` — окончательно решают они, а не
 * таблица. `map` — карта без писем: правилам нужны комнаты и эффекты планов, а письма они берут через `byId`.
 */
export function unreadOfSession(
  db: DatabaseSync,
  projectPath: string,
  workId: string,
  reader: string,
  map: WorkMap,
  byId: LetterLookup,
  counting = false,
): Message[] {
  return candidates(db, projectPath, workId, reader, counting).filter((message) => isUnreadFor(message, reader, map, byId));
}

/** Непрочитанное человеком: кандидаты, затем `isHumanUnread` (то же правило, что у окна и `mail.markRead`). */
export function unreadOfHuman(db: DatabaseSync, projectPath: string, workId: string): Message[] {
  return candidates(db, projectPath, workId, HUMAN, false).filter(isHumanUnread);
}

/** Последние `limit` непрочитанных человеком писем по возрастанию номера. */
export function humanUnreadTail(db: DatabaseSync, projectPath: string, workId: string, limit: number): Message[] {
  if (limit <= 0) return [];
  return rowsOf(
    db,
    `SELECT ${LETTER_COLUMNS} FROM message_unread u
       JOIN messages m ON m.project_path = u.project_path AND m.work_id = u.work_id AND m.seq = u.seq
      WHERE u.project_path = ? AND u.work_id = ? AND u.reader = ? ORDER BY u.seq DESC LIMIT ?`,
    [projectPath, workId, HUMAN, limit],
  )
    .filter(isHumanUnread)
    .reverse();
}

export interface UnreadTotals {
  total: number;
  byRoom: Record<string, number>;
}

/** Число непрочитанного человеком: одним запросом по кандидатам, письма не читаются (инвариант в шапке модуля). */
export function humanUnreadTotals(db: DatabaseSync, projectPath: string, workId: string): UnreadTotals {
  const byRoom: Record<string, number> = {};
  let total = 0;
  const groups = sql(
    db,
    'SELECT room_id, COUNT(*) AS n FROM message_unread WHERE project_path = ? AND work_id = ? AND reader = ? GROUP BY room_id',
  ).all(projectPath, workId, HUMAN);
  for (const group of groups) {
    const count = Number(group['n']);
    byRoom[channelKey((group['room_id'] as string | null) ?? null)] = count;
    total += count;
  }
  return { total, byRoom };
}

/** Число непрочитанного сессией: итог и по каналам (`''` — прямые). */
export function sessionUnreadTotals(
  db: DatabaseSync,
  projectPath: string,
  workId: string,
  reader: string,
  map: WorkMap,
  byId: LetterLookup,
): UnreadTotals {
  const byRoom: Record<string, number> = {};
  const unread = unreadOfSession(db, projectPath, workId, reader, map, byId, true);
  for (const message of unread) byRoom[channelKey(message.roomId)] = (byRoom[channelKey(message.roomId)] ?? 0) + 1;
  return { total: unread.length, byRoom };
}

/** Читатели, которым письмо ещё предстоит прочесть: адресаты на этот момент и человек, если письмо ему видно. Отмеченные не входят. */
export function candidateReaders(message: Message, map: WorkMap): string[] {
  const readers = new Set(recipientsOf(message, map));
  // Человек — не адресат по `recipientsOf`: его кандидатство решает `isHumanUnread`, одно и то же для всех писем.
  readers.delete(HUMAN);
  if (isHumanUnread({ ...message, readBy: {} })) readers.add(HUMAN);
  return [...readers].filter((reader) => message.readBy[reader] === undefined);
}

const INSERT_LETTER = `INSERT INTO messages (project_path, work_id, seq, id, room_id, sender, recipients, at, kind, deleted, body)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Строки письма: само письмо, отметки и кандидаты. `candidates` — читатели, которым письмо непрочитанное. */
function insertLetter(db: DatabaseSync, projectPath: string, workId: string, message: Message, readers: readonly string[]): void {
  const seq = letterSeq(message.id);
  const body: { text: string; replyTo?: string; via?: MessageVia } = { text: message.text };
  if (message.replyTo !== undefined) body.replyTo = message.replyTo;
  if (message.via !== undefined) body.via = message.via;
  sql(db, INSERT_LETTER).run(
    projectPath,
    workId,
    seq,
    message.id,
    message.roomId,
    message.from,
    JSON.stringify(message.to),
    message.at,
    message.kind,
    message.deleted === true ? 1 : 0,
    JSON.stringify(body),
  );
  for (const [reader, at] of Object.entries(message.readBy)) {
    sql(db, 'INSERT OR IGNORE INTO message_reads (project_path, work_id, seq, reader, at) VALUES (?, ?, ?, ?, ?)').run(
      projectPath,
      workId,
      seq,
      reader,
      at,
    );
  }
  for (const reader of readers) {
    sql(
      db,
      'INSERT OR IGNORE INTO message_unread (project_path, work_id, reader, seq, room_id) VALUES (?, ?, ?, ?, ?)',
    ).run(projectPath, workId, reader, seq, message.roomId);
  }
}

/**
 * Заменяет письма работы теми, что в `map.messages`: строки писем, отметки и кандидаты по правилам карты на этот момент
 * (адресаты по `recipientsOf` и человек). Так письма кладут переезд прежней карты и посев тестов; у такой карты кандидаты
 * равны непрочитанному по живым правилам, то есть без письма плана, ставшего неактуальным, их отсеет чтение.
 */
export function replaceLetters(db: DatabaseSync, projectPath: string, workId: string, map: WindowWorkMap): void {
  sql(db, 'DELETE FROM messages WHERE project_path = ? AND work_id = ?').run(projectPath, workId);
  const seen = new Set<number>();
  for (const message of map.messages) {
    const seq = letterSeq(message.id);
    if (seq === 0 || seen.has(seq)) {
      throw new Error(`letter id ${message.id} is not an unused m-N number — the letters cannot be stored`);
    }
    seen.add(seq);
    insertLetter(db, projectPath, workId, message, candidateReaders(message, map));
  }
}

/** Проверка письма при записи — вместо проверки писем в `normalizeMap`, которой в хранимой карте писем больше нет. */
export function assertLetter(letter: NewLetter): void {
  if (
    !Array.isArray(letter.to) ||
    !letter.to.every((id) => typeof id === 'string') ||
    typeof letter.text !== 'string' ||
    typeof letter.from !== 'string' ||
    !MESSAGE_KINDS.includes(letter.kind)
  ) {
    throw new TypeError('a letter needs string from, text, a list of string recipients and a known kind');
  }
}

const isThenable = (value: unknown): boolean => typeof (value as { then?: unknown } | null)?.then === 'function';

const changed = (result: { changes: number | bigint }): number => Number(result.changes);

/**
 * `LetterTx` над таблицами внутри открытой транзакции записи `db` и признак «письма были записаны» для `updateMap`: диф
 * строк карты писем не видит, и пустую запись от непустой отличит только он. `map` — черновик карты без писем: комнаты и
 * эффекты планов нужны правилам, `work.messageSeq` — номерам (спека хранилища 6.2).
 *
 * `savepoint` — `SAVEPOINT` SQLite: письма и отметки упавшего `fn` откатываются, транзакция продолжается; номер
 * `work.messageSeq`, который сдвинул внутри него `deleteRoom`, возвращает журнал отмен.
 */
export function createTableLetterTx(
  db: DatabaseSync,
  projectPath: string,
  workId: string,
  map: WorkMap,
): { letters: LetterTx; wrote: () => boolean } {
  let wrote = false;
  let savepoints = 0;
  const undo: Array<Array<() => void>> = [];
  const byId: LetterLookup = (id) => letterByIdRow(db, projectPath, workId, id);

  const letters: LetterTx = {
    add(letter) {
      assertLetter(letter);
      const top = sql(db, 'SELECT MAX(seq) AS top FROM messages WHERE project_path = ? AND work_id = ?').get(projectPath, workId);
      // Номер — под блокировкой записи: уникален и при двух процессах; ниже `work.messageSeq` не опускается (удалённая комната).
      const seq = Math.max(map.work.messageSeq ?? 0, Number(top?.['top'] ?? 0)) + 1;
      const message: Message = {
        id: `m-${String(seq).padStart(2, '0')}`,
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
      insertLetter(db, projectPath, workId, message, candidateReaders(message, map));
      wrote = true;
      return message;
    },

    markRead(reader, ids, at) {
      if (ids.length === 0) return [];
      const wanted = JSON.stringify([...new Set(ids)]);
      // Список номеров снаружи, письма по индексу `messages_id`: отметка стоит от числа названных писем, а не от числа писем работы.
      const fresh = sql(
        db,
        `SELECT m.seq, m.id FROM json_each(?) j CROSS JOIN messages m
          WHERE m.project_path = ? AND m.work_id = ? AND m.id = j.value
            AND NOT EXISTS (SELECT 1 FROM message_reads r
              WHERE r.project_path = m.project_path AND r.work_id = m.work_id AND r.seq = m.seq AND r.reader = ?)
          ORDER BY m.seq`,
      ).all(wanted, projectPath, workId, reader);
      if (fresh.length > 0) {
        sql(
          db,
          `INSERT INTO message_reads (project_path, work_id, seq, reader, at)
             SELECT ?, ?, value, ?, ? FROM json_each(?)`,
        ).run(projectPath, workId, reader, at, JSON.stringify(fresh.map((row) => Number(row['seq']))));
      }
      sql(
        db,
        `DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND reader = ?
           AND seq IN (SELECT m.seq FROM json_each(?) j CROSS JOIN messages m
                        WHERE m.project_path = ? AND m.work_id = ? AND m.id = j.value)`,
      ).run(projectPath, workId, reader, wanted, projectPath, workId);
      if (fresh.length > 0) wrote = true;
      return fresh.map((row) => String(row['id']));
    },

    byId,
    query: (q) => selectLetters(db, projectPath, workId, q),
    count: (q) => countLetters(db, projectPath, workId, q),
    unreadFor: (reader) =>
      reader === HUMAN ? unreadOfHuman(db, projectPath, workId) : unreadOfSession(db, projectPath, workId, reader, map, byId),

    joined(roomId, reader) {
      // Все рассылки комнаты без отметки читателя и не от него: новичок получает историю непрочитанной.
      const added = sql(
        db,
        `INSERT OR IGNORE INTO message_unread (project_path, work_id, reader, seq, room_id)
           SELECT m.project_path, m.work_id, ?, m.seq, m.room_id FROM messages m
            WHERE m.project_path = ? AND m.work_id = ? AND m.room_id = ? AND m.recipients = '[]' AND m.sender != ?
              AND NOT EXISTS (SELECT 1 FROM message_reads r
                WHERE r.project_path = m.project_path AND r.work_id = m.work_id AND r.seq = m.seq AND r.reader = ?)`,
      ).run(reader, projectPath, workId, roomId, reader, reader);
      if (changed(added) > 0) wrote = true;
    },

    left(roomId, reader) {
      // Только рассылки комнаты: письма с явным `to` остаются адресату и после выхода (`recipientsOf`).
      const removed = sql(
        db,
        `DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND reader = ? AND room_id = ?
           AND seq IN (SELECT seq FROM messages WHERE project_path = ? AND work_id = ? AND room_id = ? AND recipients = '[]')`,
      ).run(projectPath, workId, reader, roomId, projectPath, workId, roomId);
      if (changed(removed) > 0) wrote = true;
    },

    archived(roomId) {
      // У архивной комнаты адресатов нет (`recipientsOf`); человеку её письма остаются непрочитанными.
      const removed = sql(
        db,
        'DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND room_id = ? AND reader != ?',
      ).run(projectPath, workId, roomId, HUMAN);
      if (changed(removed) > 0) wrote = true;
    },

    reopened(roomId, at) {
      const room = map.rooms.find((candidate) => candidate.id === roomId);
      // У архивной комнаты адресатов нет: отметок не ставим.
      if (room !== undefined && isRoomArchived(room)) return;
      // Адресаты — как `recipientsOf` у открытой комнаты: явный `to` как есть, рассылка — участники без человека и отправителя.
      let marked = changed(
        sql(
          db,
          `INSERT OR IGNORE INTO message_reads (project_path, work_id, seq, reader, at)
             SELECT m.project_path, m.work_id, m.seq, j.value, ? FROM messages m, json_each(m.recipients) j
              WHERE m.project_path = ? AND m.work_id = ? AND m.room_id = ? AND m.recipients != '[]'`,
        ).run(at, projectPath, workId, roomId),
      );
      if (room !== undefined) {
        marked += changed(
          sql(
            db,
            `INSERT OR IGNORE INTO message_reads (project_path, work_id, seq, reader, at)
               SELECT m.project_path, m.work_id, m.seq, j.value, ? FROM messages m, json_each(?) j
                WHERE m.project_path = ? AND m.work_id = ? AND m.room_id = ? AND m.recipients = '[]' AND j.value != m.sender`,
          ).run(at, JSON.stringify(room.members.filter((id) => id !== HUMAN)), projectPath, workId, roomId),
        );
      }
      if (marked === 0) return;
      // Отмеченное больше не кандидат.
      sql(
        db,
        `DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND room_id = ?
           AND EXISTS (SELECT 1 FROM message_reads r
             WHERE r.project_path = message_unread.project_path AND r.work_id = message_unread.work_id
               AND r.seq = message_unread.seq AND r.reader = message_unread.reader)`,
      ).run(projectPath, workId, roomId);
      wrote = true;
    },

    deleteRoom(roomId) {
      const top = Number(
        sql(db, 'SELECT MAX(seq) AS top FROM messages WHERE project_path = ? AND work_id = ?').get(projectPath, workId)?.['top'] ?? 0,
      );
      // Отметки и кандидаты уходят каскадом.
      const removed = changed(
        sql(db, 'DELETE FROM messages WHERE project_path = ? AND work_id = ? AND room_id = ?').run(projectPath, workId, roomId),
      );
      // Комната без писем номер не двигает и версию не поднимает.
      if (removed === 0) return;
      const before = map.work.messageSeq;
      const next = Math.max(before ?? 0, top);
      if (next !== before) {
        map.work.messageSeq = next;
        undo.at(-1)?.push(() => {
          if (before === undefined) delete map.work.messageSeq;
          else map.work.messageSeq = before;
        });
      }
      wrote = true;
    },

    flagDeleted(sessionId) {
      // `recipients` — JSON-массив: сравнивать с ним строку было бы всегда ложно (как в прежнем `removeSession`).
      const flagged = sql(
        db,
        `UPDATE messages SET deleted = 1 WHERE project_path = ? AND work_id = ? AND deleted = 0
           AND (sender = ? OR EXISTS (SELECT 1 FROM json_each(messages.recipients) WHERE value = ?))`,
      ).run(projectPath, workId, sessionId, sessionId);
      const dropped = sql(db, 'DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND reader = ?').run(
        projectPath,
        workId,
        sessionId,
      );
      if (changed(flagged) > 0 || changed(dropped) > 0) wrote = true;
    },

    effectCancelled(messageId) {
      // Человека отмена не касается: `isHumanUnread` письма плана не различает, и кандидаты человека остаются ровно тем,
      // что он видит и не прочёл.
      const removed = sql(
        db,
        `DELETE FROM message_unread WHERE project_path = ? AND work_id = ? AND reader != ?
           AND seq = (SELECT seq FROM messages WHERE project_path = ? AND work_id = ? AND id = ?)`,
      ).run(projectPath, workId, HUMAN, projectPath, workId, messageId);
      if (changed(removed) > 0) wrote = true;
    },

    savepoint<T>(fn: () => T): T {
      savepoints += 1;
      const name = `letters_${savepoints}`;
      const log: Array<() => void> = [];
      const wroteBefore = wrote;
      db.exec(`SAVEPOINT ${name}`);
      undo.push(log);
      try {
        const result = fn();
        // Отложенная работа ушла бы из-под отката: откатить нечего, и вызов ошибочен.
        if (isThenable(result)) throw new TypeError('letters.savepoint takes a synchronous function');
        undo.pop();
        db.exec(`RELEASE ${name}`);
        // Вложенный успех отдаёт свои отмены внешнему: откат внешнего уносит и его.
        for (const action of log) undo.at(-1)?.push(action);
        return result;
      } catch (error) {
        undo.pop();
        for (let at = log.length - 1; at >= 0; at -= 1) log[at]!();
        wrote = wroteBefore;
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      }
    },
  };
  return { letters, wrote: () => wrote };
}
