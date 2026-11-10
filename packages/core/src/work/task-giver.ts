import type { LetterReads } from './letter-store.js';
import { letterSeq } from './letter-tables.js';
import { isRoomArchived, liveLead } from './rooms.js';
import { swarmOfSession } from './swarms.js';
import { HUMAN, PARLEY, SYSTEM, type Message, type SessionResult, type WorkMap } from './types.js';

/** Письмо о сдаче с тем же итогом в пределах окна — повтор; с другим итогом — обновление (`reportLetterText`). */
export const REPORT_UPDATE_WINDOW_MS = 60_000;

export type ReportRecipientRole = 'giver' | 'lead' | 'owner';
export interface ReportRecipient { id: string; as: ReportRecipientRole; roomId?: string }

/** Отправитель самого нового прямого письма-задания: не вопрос, не служебное, не сам и не свой ребёнок. */
function latestTaskSender(map: WorkMap, letters: LetterReads, sessionId: string): string | null {
  let beforeSeq: number | undefined;
  for (;;) {
    const page = letters.query({ involving: [sessionId], roomId: null, newestFirst: true, limit: 50,
      ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    const task = page.find((letter) => letter.to.includes(sessionId) && letter.from !== sessionId &&
      letter.from !== SYSTEM && letter.from !== PARLEY && letter.kind !== 'question' &&
      !map.sessions.some((sender) => sender.id === letter.from && sender.createdBy === sessionId));
    if (task !== undefined) return task.from;
    if (page.length < 50) return null;
    beforeSeq = letterSeq(page[page.length - 1]!.id);
  }
}

/**
 * Кто ждёт итог сессии: в каждой открытой комнате докладчика — живой ведущий (а если докладчик сам ведёт — владелец),
 * затем создатель и самый новый давший задание. Дубликаты — по первому вхождению: роль в комнате важнее «task giver».
 * Участник роя отчитывается протоколом роя, у автономной комнаты — своим (`attempt_*`): им письма нет.
 */
export function reportRecipients(map: WorkMap, letters: LetterReads, sessionId: string): ReportRecipient[] {
  if (swarmOfSession(map, sessionId) !== null) return [];
  const found: ReportRecipient[] = [];
  for (const room of map.rooms) {
    if (isRoomArchived(room) || !room.members.includes(sessionId)) continue;
    const lead = liveLead(map, room);
    if (lead !== null && lead !== sessionId) {
      if (room.mode !== 'autonomous') found.push({ id: lead, as: 'lead', roomId: room.id });
    } else if (room.ownerId != null) found.push({ id: room.ownerId, as: 'owner', roomId: room.id });
  }
  const created = map.sessions.find((session) => session.id === sessionId)?.createdBy;
  if (typeof created === 'string') found.push({ id: created, as: 'giver' });
  const sender = latestTaskSender(map, letters, sessionId);
  if (sender !== null) found.push({ id: sender, as: 'giver' });
  return found.filter((recipient, index) => recipient.id !== sessionId && recipient.id !== HUMAN &&
    map.sessions.some((session) => session.id === recipient.id && session.lifecycle !== 'closed') &&
    found.findIndex((other) => other.id === recipient.id) === index);
}

export function reportLetterText(
  sessionId: string,
  status: SessionResult,
  summary: string,
  options: { rooms?: readonly string[]; update?: boolean } = {},
): string {
  const line = summary.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? '';
  const excerpt = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  const rooms = options.rooms !== undefined && options.rooms.length > 0 ? ` in ${options.rooms.join(', ')}` : '';
  return `${sessionId} reported ${status}${options.update === true ? ' (update)' : ''}${rooms}${excerpt === '' ? '' : `: ${excerpt}`}. Full summary: get_map {session: "${sessionId}", field: "summary"}`;
}

export function isReportLetterAbout(message: Pick<Message, 'from' | 'roomId' | 'text'>, sessionId: string): boolean {
  return message.from === SYSTEM && message.roomId === null && message.text.startsWith(`${sessionId} reported `);
}

/** Письмо-обновление итога: тот же докладчик сдал другой итог в пределах `REPORT_UPDATE_WINDOW_MS`. */
export function isReportUpdateLetter(message: Pick<Message, 'from' | 'roomId' | 'text'>): boolean {
  return message.from === SYSTEM && message.roomId === null && /^\S+ reported (?:done|failed) \(update\)/.test(message.text);
}
