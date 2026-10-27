/**
 * Письма в окно событием `rooms.mail`: пачка журналов записи по работе и сборка события из неё (спека rooms.mail 6.3, 6.6).
 *
 * Пачка копит журналы коммитов (`LetterJournal` из события `onMapWritten`), пока не истечёт `MAIL_BATCH_MS`. Событие
 * собирается один раз, при рассылке, и читает таблицы писем одним снимком базы: итоги, верх комнат и непрочитанное в нём
 * согласованы между собой и абсолютны (потерянное или повторённое событие не сбивает окно навсегда). Рассылку, таймеры и
 * счётчики ведёт `works-service.ts`; здесь только данные и расчёт.
 */

import {
  HUMAN,
  humanMentionCandidates,
  keepNewestWithin,
  letterById,
  letterCount,
  readLetters,
  seqOf,
  shrinkText,
  unreadCount,
  viewBytes,
  viewMap,
  WINDOW_MENTION_MAX_BYTES,
  WINDOW_TEXT_MAX,
  withLetterSnapshot,
} from '@parley/core';
import { isHumanUnread, plainHumanMention } from '@parley/core/attention';
import type { LetterJournal, Message } from '@parley/core';
import type { RoomsMailEvent, RoomsMailRoom } from '@parley/protocol';

/** Сколько писем одной работы копится в одно событие. Ориентир спеки 6.6, как у ленты (`feed-service.ts`). */
export const MAIL_BATCH_MS = 50;
/** Потолок кадра события, байт: письма сверх него не едут, комната получает `reread` (спека 6.6). */
export const MAIL_EVENT_MAX_BYTES = 256 * 1024;
/** Клиент, у которого в буфере записи больше, считается медленным: ему уходит склеенное событие с `reread` (спека 6.6). */
export const MAIL_SLOW_CLIENT_BYTES = 1024 * 1024;

/**
 * Потолок ожидания пачки, которую держит снимок: страховка на случай, когда полный проход не доходит до `publish`; окно само
 * держит событие по комнате, которой нет в его снимке (спека rooms.mail 6.5), поэтому раннее освобождение безопасно.
 */
export const MAIL_HOLD_MAX_MS = 2000;

/** Одна запись с письмами для подписчиков хоста (`WorksService.onMail`): по уведомлению на каждый коммит с непустым журналом. */
export interface MailNotice {
  projectPath: string;
  workId: string;
  /** Версия работы в базе после записи и до неё. */
  version: number;
  prevVersion: number;
  /** Что запись сделала с письмами; подписчик его не меняет. */
  journal: LetterJournal;
  /** Запись другого процесса (журнала у неё нет): письма названы по номеру, отметки не восстановить — комнаты с `reread`. */
  foreign: boolean;
}

/** Журналы коммитов одной работы между рассылками. */
export interface MailBatch {
  projectPath: string;
  workId: string;
  /** Версия до первой записи пачки и после последней. */
  prevVersion: number;
  version: number;
  /**
   * Версия последней записи, которую пачка ждёт: структурной записи самой пачки или структурной записи этого процесса без
   * писем, лёгшей до пачки и ещё не разосланной снимком; 0 — ждать нечего. Такая пачка выходит после публикации снимка с этой
   * версией: окно получает структуру (комнату, участников) раньше писем (спека 6.5, «смешанная запись»).
   */
  structuralVersion: number;
  /** Когда началась пачка, мс (`Date.now()`): от этого момента считается `MAIL_HOLD_MAX_MS`. */
  startedAt: number;
  /** Уведомления смешанных записей: подписчики узнают о них после публикации снимка, а не в момент коммита. */
  notices: MailNotice[];
  journal: LetterJournal;
  timer: NodeJS.Timeout | undefined;
}

const emptyJournal = (): LetterJournal => ({ added: [], reads: [], deleted: [], droppedRooms: [], rereadRooms: [] });

export const journalIsEmpty = (journal: LetterJournal): boolean =>
  journal.added.length + journal.reads.length + journal.deleted.length + journal.droppedRooms.length + journal.rereadRooms.length === 0;

/** Дописывает журнал коммита в пачку: порядок записей сохраняется, письма и отметки применяются по порядку полей (`LetterJournal`). */
export function joinBatch(batch: MailBatch, write: { version: number; journal: LetterJournal; structural: boolean }): void {
  const { journal } = write;
  for (const letter of journal.added) batch.journal.added.push(letter);
  for (const read of journal.reads) batch.journal.reads.push(read);
  for (const id of journal.deleted) batch.journal.deleted.push(id);
  for (const roomId of journal.droppedRooms) batch.journal.droppedRooms.push(roomId);
  for (const roomId of journal.rereadRooms) batch.journal.rereadRooms.push(roomId);
  batch.version = write.version;
  if (write.structural) batch.structuralVersion = write.version;
}

export function startBatch(projectPath: string, workId: string, prevVersion: number): MailBatch {
  return {
    projectPath,
    workId,
    prevVersion,
    version: prevVersion,
    structuralVersion: 0,
    startedAt: Date.now(),
    notices: [],
    journal: emptyJournal(),
    timer: undefined,
  };
}

/** Письмо в событии — как его отдаёт `context.messages`: текст до `WINDOW_TEXT_MAX`, у сокращённых — `textBytes`. */
const asWindowLetter = (message: Message): Message => (viewBytes(message) > WINDOW_TEXT_MAX ? shrinkText(message, WINDOW_TEXT_MAX) : message);

interface Touched {
  letters: Message[];
  reads: RoomsMailRoom['reads'];
  deleted: string[];
  reread: boolean;
}

/**
 * Событие `rooms.mail` из пачки (спека 6.3). Читает таблицы писем работы одним снимком; работы нет — `WorkNotFoundError`.
 * Комнаты — те, что названы письмами, отметками, удалениями и массовой отметкой; комнаты из `droppedRooms` в `rooms` не
 * входят: окно убирает их письма и счётчики по `droppedRooms`. `top`, `total`, `lastAt` и `unread` берутся из таблиц на
 * момент сборки, а не складываются из журнала: к ним же приходит и чужая запись, которой в журнале нет. Кандидаты в
 * упоминания — только новые письма пачки (спека 6.3): весь набор непрочитанного человеком читался бы на каждое событие.
 */
export function buildMailEvent(batch: MailBatch): RoomsMailEvent {
  const { projectPath, workId, journal } = batch;
  return withLetterSnapshot(projectPath, workId, () => {
    const touched = new Map<string | null, Touched>();
    const touch = (roomId: string | null): Touched => {
      let room = touched.get(roomId);
      if (room === undefined) touched.set(roomId, (room = { letters: [], reads: [], deleted: [], reread: false }));
      return room;
    };
    // Комната письма, названного отметкой или удалением: письма пачки известны, остальные — запросом по номеру.
    const roomOf = new Map<string, string | null | undefined>(journal.added.map((message) => [message.id, message.roomId] as const));
    const roomOfLetter = (id: string): string | null | undefined => {
      if (!roomOf.has(id)) roomOf.set(id, letterById(projectPath, workId, id)?.roomId);
      return roomOf.get(id);
    };

    for (const message of journal.added) touch(message.roomId).letters.push(message);
    for (const read of journal.reads) {
      const roomId = roomOfLetter(read.id);
      if (roomId !== undefined) touch(roomId).reads.push(read);
    }
    for (const id of journal.deleted) {
      const roomId = roomOfLetter(id);
      if (roomId !== undefined) touch(roomId).deleted.push(id);
    }
    for (const roomId of journal.rereadRooms) touch(roomId).reread = true;
    const droppedRooms = [...new Set(journal.droppedRooms)];
    for (const roomId of droppedRooms) touched.delete(roomId);

    const rooms: RoomsMailRoom[] = [...touched].map(([roomId, room]) => {
      const newest = readLetters(projectPath, workId, { roomId, limit: 1, newestFirst: true })[0];
      const top = newest === undefined ? 0 : seqOf(newest.id, 'm-');
      // Верх комнаты до пачки — новейшее письмо старше самого раннего письма пачки; без новых писем верх не менялся.
      const first = room.letters.reduce((least, message) => Math.min(least, seqOf(message.id, 'm-')), Number.POSITIVE_INFINITY);
      const prevTop =
        first === Number.POSITIVE_INFINITY
          ? top
          : seqOf(readLetters(projectPath, workId, { roomId, beforeSeq: first, limit: 1, newestFirst: true })[0]?.id ?? '', 'm-');
      return {
        roomId,
        prevTop,
        top,
        total: letterCount(projectPath, workId, { roomId }),
        lastAt: newest?.at ?? null,
        letters: room.letters.map(asWindowLetter),
        reads: room.reads,
        deleted: room.deleted,
        ...(room.reread ? { reread: true as const } : {}),
      };
    });

    const unread = unreadCount(projectPath, workId, HUMAN);
    // Новые письма пачки с `@human` перечитываются здесь же, в снимке: к сборке человек мог письмо прочитать, а запись той же
    // пачки — пометить удалённым. Такое письмо не кандидат (окно убрало бы его само по `reads` и `deleted`). Письмо без упоминания
    // не перечитывается: набор от него не зависит.
    const deleted = new Set(journal.deleted);
    const fresh = journal.added
      .filter((message) => plainHumanMention(message.text) && !deleted.has(message.id))
      .map((message) => letterById(projectPath, workId, message.id))
      .filter((message): message is Message => message !== undefined && isHumanUnread(message))
      .sort((left, right) => seqOf(left.id, 'm-') - seqOf(right.id, 'm-'));
    return {
      projectPath,
      workId,
      version: batch.version,
      prevVersion: batch.prevVersion,
      updatedAt: viewMap(projectPath, workId, (map) => map.work.updatedAt),
      rooms,
      droppedRooms,
      unread: { letters: unread.total, rooms: unread.byRoom },
      // Потолок набора в байтах и порядок — общий помощник ядра, которым берёт кандидатов и снимок без писем. `fitMailEvent`
      // урезает набор дальше лишь тогда, когда каркас кадра оставил меньше потолка.
      mentionCandidates: humanMentionCandidates(fresh),
    };
  });
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Кадр — это ещё `{"event":"rooms.mail","data":…}` и перевод строки. */
const frameBytes = (data: RoomsMailEvent): number => jsonBytes({ event: 'rooms.mail', data }) + 1;
/** Что добавляет к комнате признак `reread`, которого в ней не было: `,"reread":true`. */
const REREAD_BYTES = Buffer.byteLength(',"reread":true');

/**
 * Событие под потолок кадра (`MAIL_EVENT_MAX_BYTES`, спека 6.6). Порядок, в котором кадр делится:
 * 1. каркас — комнаты без писем и без кандидатов, с отметками и удалениями. Не влез он сам (сотни тысяч отметок) —
 *    комнаты с самыми тяжёлыми отметками теряют их и получают `reread`, как у склеенного события;
 * 2. кандидаты в упоминания — новые письма пачки: `buildMailEvent` уже собрал их под `WINDOW_MENTION_MAX_BYTES`; здесь они
 *    урезаются дальше, до остатка кадра, и только когда каркас оставил меньше потолка (редко); самые новые остаются, как и там;
 * 3. письма комнат по порядку, пока остаток влезает; письма комнаты, которой не хватило, не едут вовсе, и комната
 *    получает `reread` — окно читает её страницей. Комната целиком, а не по частям: окно, получившее хвост письма без
 *    начала, держало бы дыру, а `reread` её закрывает.
 * Байты `,"reread":true` у комнат с письмами отложены заранее: кадр не вылезает за потолок на них.
 */
export function fitMailEvent(event: RoomsMailEvent): RoomsMailEvent {
  const rooms: RoomsMailRoom[] = event.rooms.map((room) => ({ ...room, letters: [] }));
  let size = frameBytes({ ...event, rooms, mentionCandidates: [] });

  if (size > MAIL_EVENT_MAX_BYTES) {
    const heavy = rooms
      .map((room, at) => ({ at, bytes: jsonBytes(room.reads) + jsonBytes(room.deleted) }))
      .sort((left, right) => right.bytes - left.bytes);
    for (const { at } of heavy) {
      if (size <= MAIL_EVENT_MAX_BYTES) break;
      const room = rooms[at] as RoomsMailRoom;
      if (room.reads.length === 0 && room.deleted.length === 0) continue;
      const cut = { ...room, reads: [], deleted: [], reread: true as const };
      size -= jsonBytes(room) - jsonBytes(cut);
      rooms[at] = cut;
    }
  }

  let budget = MAIL_EVENT_MAX_BYTES - size;
  rooms.forEach((room, at) => {
    if (room.reread !== true && (event.rooms[at] as RoomsMailRoom).letters.length > 0) budget -= REREAD_BYTES;
  });

  // Кандидаты: потолок общий, а остаток кадра может быть меньше; `[]` в каркасе уже посчитан, поэтому в счёт идут письма и запятые.
  const candidates = keepNewestWithin(event.mentionCandidates, Math.min(WINDOW_MENTION_MAX_BYTES, budget));
  budget -= jsonBytes(candidates) - jsonBytes([]);

  const fitted = rooms.map((room, at) => {
    const letters = (event.rooms[at] as RoomsMailRoom).letters;
    if (letters.length === 0) return room;
    const bytes = jsonBytes(letters) - jsonBytes([]);
    if (bytes <= budget) {
      budget -= bytes;
      return { ...room, letters };
    }
    return { ...room, reread: true as const };
  });
  return { ...event, rooms: fitted, mentionCandidates: candidates };
}

/**
 * Склеенное событие для медленного клиента: письма и отметки не едут, каждая комната названа с `reread`, числа и версии
 * прежние — окно ставит их из события и дочитывает письма страницами, когда буфер освободится (спека 6.6). Кандидаты в
 * упоминания остаются: окну они нужны и по комнатам, которых оно не держит и не дочитает.
 */
export const gluedMailEvent = (event: RoomsMailEvent): RoomsMailEvent => ({
  ...event,
  rooms: event.rooms.map((room) => ({ ...room, letters: [], reads: [], deleted: [], reread: true as const })),
});
