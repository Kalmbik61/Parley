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
  WorkNotFoundError,
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

/**
 * Сколько писем чужой записи уходит в одно событие (спека rooms.mail 6.11): записей-россыпей в тысячи писем не бывает, а
 * событие с ними собиралось бы в цикле хоста. Берутся новейшие; комнаты названных писем всё равно получают `reread`, и окно
 * дочитывает их страницей.
 */
export const MAIL_FOREIGN_LETTERS_MAX = 500;

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
   * версией: окно получает структуру (комнату, участников) раньше писем (спека 6.5, «смешанная запись»). Не позже
   * `MAIL_HOLD_MAX_MS` от начала пачки: потолок выпускает её и без снимка, окно само держит событие по комнате, которой у него
   * нет (спека 6.5).
   */
  structuralVersion: number;
  /** Когда началась пачка, мс (`Date.now()`): от этого момента считается `MAIL_HOLD_MAX_MS`. */
  startedAt: number;
  /**
   * Уведомления смешанных записей: подписчики узнают о них после публикации снимка, а не в момент коммита. Потолок
   * `MAIL_HOLD_MAX_MS` выпускает их вместе с событием и до снимка; смешанная запись всё равно доходит до каждого подписчика
   * через `onChange` после прохода, и подписчики, которым нужны письма, пересчитывают и по нему.
   */
  notices: MailNotice[];
  journal: LetterJournal;
  /**
   * В пачке есть письма чужой записи среди прямых: комнаты у них нет, и в `journal.rereadRooms` (только строки) их канал не
   * назвать. Событие ставит `reread` комнате `null`.
   */
  rereadDirect: boolean;
  timer: NodeJS.Timeout | undefined;
}

/** Что хост знает о работе по своим записям (спека rooms.mail 6.11): версия базы и наибольший номер письма, который уже объявлен. */
export interface MailKnown {
  version: number;
  seq: number;
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
    rereadDirect: false,
    timer: undefined,
  };
}

/** Наибольший номер письма работы по всем каналам; писем нет — 0, работы нет — `undefined`. */
export function topLetterSeq(projectPath: string, workId: string): number | undefined {
  try {
    const newest = readLetters(projectPath, workId, { limit: 1, newestFirst: true })[0];
    return newest === undefined ? 0 : seqOf(newest.id, 'm-');
  } catch (error) {
    if (error instanceof WorkNotFoundError) return undefined;
    throw error;
  }
}

/**
 * Письма новее `afterSeq` по всем каналам работы — то, что запись другого процесса добавила к известному хосту (спека 6.11);
 * по возрастанию номера, не больше `MAIL_FOREIGN_LETTERS_MAX` новейших. `top` — наибольший номер в таблице на этот момент
 * (не меньше `afterSeq`): дальше объявляются только письма новее его. Работы нет — писем нет.
 */
export function lettersAfter(projectPath: string, workId: string, afterSeq: number): { letters: Message[]; top: number } {
  try {
    const found = readLetters(projectPath, workId, { afterSeq, limit: MAIL_FOREIGN_LETTERS_MAX, newestFirst: true });
    const newest = found[0];
    return { letters: found.reverse(), top: newest === undefined ? afterSeq : Math.max(afterSeq, seqOf(newest.id, 'm-')) };
  } catch (error) {
    if (error instanceof WorkNotFoundError) return { letters: [], top: afterSeq };
    throw error;
  }
}

/**
 * Журнал чужой записи (спека 6.11): письма названы по номеру, а отметки прочтения и удаления восстановить нельзя, поэтому
 * каждая комната с письмами получает `reread` — окно читает её страницей. Прямые письма отмечает `MailBatch.rereadDirect`.
 */
export function foreignJournal(letters: readonly Message[]): LetterJournal {
  const rooms = new Set<string>();
  for (const letter of letters) if (letter.roomId !== null) rooms.add(letter.roomId);
  return { added: [...letters], reads: [], deleted: [], droppedRooms: [], rereadRooms: [...rooms] };
}

/**
 * Дописывает письма чужой записи в пачку, в том числе уже начатую своими письмами: `prevVersion` пачки не растёт, `version` не
 * падает, письма остаются по возрастанию номера. Пачка ждёт снимка с версией не ниже `structuralVersion`: чужая запись могла
 * менять и карту, и событие её писем идёт после снимка, который её включает (спека 6.5).
 */
export function joinForeign(batch: MailBatch, write: { prevVersion: number; version: number; structuralVersion: number; journal: LetterJournal }): void {
  const structuralVersion = Math.max(batch.structuralVersion, write.structuralVersion);
  joinBatch(batch, { version: Math.max(batch.version, write.version), journal: write.journal, structural: false });
  batch.structuralVersion = structuralVersion;
  batch.prevVersion = Math.min(batch.prevVersion, write.prevVersion);
  batch.journal.added.sort((left, right) => seqOf(left.id, 'm-') - seqOf(right.id, 'm-'));
  if (write.journal.added.some((letter) => letter.roomId === null)) batch.rereadDirect = true;
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
    if (batch.rereadDirect) touch(null).reread = true;
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
/** Отметка человека: по ней окно убирает письмо из набора кандидатов в упоминания. */
const isHumanRead = (read: RoomsMailRoom['reads'][number]): boolean => read.reader === HUMAN;
/** Кадр — это ещё `{"event":"rooms.mail","data":…}` и перевод строки. */
const frameBytes = (data: RoomsMailEvent): number => jsonBytes({ event: 'rooms.mail', data }) + 1;
/** Что добавляет к комнате признак `reread`, которого в ней не было: `,"reread":true`. */
const REREAD_BYTES = Buffer.byteLength(',"reread":true');
/**
 * Письмо человеку: прямое (комната `null`) от не-человека или с человеком среди адресатов. Окно уведомляет о нём по самому
 * событию, а письмо, которое событие не несёт, неоткрытая комната не дочитает никогда, — поэтому урезанная и склеенная
 * комната их оставляет: таких писем немного, и они малы (спека rooms.mail 6.6, итоговое ревью I3).
 */
const isToHuman = (message: Message): boolean => (message.roomId === null && message.from !== HUMAN) || message.to.includes(HUMAN);
/** Что письма добавляют к кадру в `letters`, который был пуст: сами письма и запятые между ними. */
const lettersBytes = (letters: readonly Message[]): number => (letters.length === 0 ? 0 : jsonBytes(letters) - jsonBytes([]));

/**
 * Событие под потолок кадра (`MAIL_EVENT_MAX_BYTES`, спека 6.6). Порядок, в котором кадр делится:
 * 1. каркас — комнаты без писем и без кандидатов, с отметками и удалениями. Не влез он сам (сотни тысяч отметок) —
 *    комнаты с самыми тяжёлыми отметками других читателей теряют их и получают `reread`; отметки человека и `deleted`
 *    остаются: по ним окно убирает кандидатов в упоминания, в том числе из комнат, которых оно не держит. Не влезло и так
 *    (десятки тысяч отметок человека или удалений) — тогда уходят и они, снова от самых тяжёлых комнат;
 * 2. кандидаты в упоминания — новые письма пачки: `buildMailEvent` уже собрал их под `WINDOW_MENTION_MAX_BYTES`; здесь они
 *    урезаются дальше, до остатка кадра, и только когда каркас оставил меньше потолка (редко); самые новые остаются, как и там;
 * 3. письма комнат по порядку, пока остаток влезает; письма комнаты, которой не хватило, не едут вовсе, и комната
 *    получает `reread` — окно читает её страницей. Комната целиком, а не по частям: окно, получившее хвост письма без
 *    начала, держало бы дыру, а `reread` её закрывает. Исключение — письма человеку (`isToHuman`): они остаются и в такой
 *    комнате, а их байты отложены до писем комнат, чтобы ни одна комната не вытеснила их у следующей. Не влезли они сами —
 *    уходят и они, остаётся один `reread`.
 * Байты `,"reread":true` у комнат с письмами отложены заранее: кадр не вылезает за потолок на них.
 */
export function fitMailEvent(event: RoomsMailEvent): RoomsMailEvent {
  const rooms: RoomsMailRoom[] = event.rooms.map((room) => ({ ...room, letters: [] }));
  let size = frameBytes({ ...event, rooms, mentionCandidates: [] });

  if (size > MAIL_EVENT_MAX_BYTES) {
    // Порядок каждого прохода — по тому, что он может снять: первый берёт отметки других читателей, и комната, тяжёлая только
    // отметками человека и удалениями, ничего бы ему не дала.
    const heavyBy = (bytesOf: (room: RoomsMailRoom) => number): Array<{ at: number }> =>
      rooms.map((room, at) => ({ at, bytes: bytesOf(room) })).sort((left, right) => right.bytes - left.bytes);
    const removable = heavyBy((room) => jsonBytes(room.reads.filter((read) => !isHumanRead(read))));
    const heavy = heavyBy((room) => jsonBytes(room.reads) + jsonBytes(room.deleted));
    // Сначала уходят отметки других читателей: человека и удаления окну нужны, чтобы снять кандидатов (спека 6.3).
    for (const { at } of removable) {
      if (size <= MAIL_EVENT_MAX_BYTES) break;
      const room = rooms[at] as RoomsMailRoom;
      const human = room.reads.filter(isHumanRead);
      if (human.length === room.reads.length) continue;
      const cut = { ...room, reads: human, reread: true as const };
      size -= jsonBytes(room) - jsonBytes(cut);
      rooms[at] = cut;
    }
    // Каркас всё ещё не влез: уходит и остальное, окну остаётся `reread` и ближайший снимок.
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

  // Письма человеку оплачены вперёд: комната, которой не хватило, оставит их, а комната, которой хватило, доплатит за остальное.
  const human = event.rooms.map((room) => room.letters.filter(isToHuman));
  const humanBytes = human.map(lettersBytes);
  const reserved = humanBytes.reduce((sum, bytes) => sum + bytes, 0);
  const keepHuman = reserved <= budget;
  if (keepHuman) budget -= reserved;

  const fitted = rooms.map((room, at) => {
    const letters = (event.rooms[at] as RoomsMailRoom).letters;
    if (letters.length === 0) return room;
    const paid = keepHuman ? (humanBytes[at] as number) : 0;
    const extra = lettersBytes(letters) - paid;
    if (extra <= budget) {
      budget -= extra;
      return { ...room, letters };
    }
    return { ...room, letters: keepHuman ? (human[at] as Message[]) : [], reread: true as const };
  });
  return { ...event, rooms: fitted, mentionCandidates: candidates };
}

/**
 * Склеенное событие для медленного клиента: письма и отметки других читателей не едут, каждая комната названа с `reread`,
 * числа и версии прежние — окно ставит их из события и дочитывает письма страницами, когда буфер освободится (спека 6.6).
 * Кандидаты в упоминания остаются вместе с тем, что их снимает, — отметками человека и `deleted`: окно держит набор по
 * работе, а комнаты, которых оно не держит, ему не дочитать. Остаются и письма человеку (`isToHuman`): по ним окно
 * уведомляет, а неоткрытая комната их не дочитает. Не влезли они в кадр — не едут, как и прочие письма.
 */
export function gluedMailEvent(event: RoomsMailEvent): RoomsMailEvent {
  const glue = (keepHuman: boolean): RoomsMailEvent => ({
    ...event,
    rooms: event.rooms.map((room) => ({
      ...room,
      letters: keepHuman ? room.letters.filter(isToHuman) : [],
      reads: room.reads.filter(isHumanRead),
      reread: true as const,
    })),
  });
  const kept = glue(true);
  if (kept.rooms.every((room) => room.letters.length === 0)) return kept;
  return frameBytes(kept) <= MAIL_EVENT_MAX_BYTES ? kept : glue(false);
}
