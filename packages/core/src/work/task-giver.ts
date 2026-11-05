import type { LetterReads } from './letter-store.js';
import { isRoomArchived } from './rooms.js';
import { swarmOfSession } from './swarms.js';
import { HUMAN, PARLEY, SYSTEM, type Message, type SessionResult, type WorkMap } from './types.js';

/** Последняя прямая задача; комнатные участники и рои отчитываются своим протоколом. */
export function lastTaskGiver(map: WorkMap, letters: LetterReads, sessionId: string): string | null {
  if (map.rooms.some((room) => !isRoomArchived(room) && room.members.includes(sessionId)) ||
    swarmOfSession(map, sessionId) !== null) return null;
  let giver = map.sessions.find((session) => session.id === sessionId)?.createdBy;
  let beforeSeq: number | undefined;
  for (;;) {
    const page = letters.query({ involving: [sessionId], roomId: null, newestFirst: true, limit: 50,
      ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    const task = page.find((letter) => letter.to.includes(sessionId) && letter.from !== sessionId &&
      letter.from !== SYSTEM && letter.from !== PARLEY && letter.kind !== 'question' &&
      !map.sessions.some((sender) => sender.id === letter.from && sender.createdBy === sessionId));
    if (task !== undefined) {
      giver = task.from;
      break;
    }
    if (page.length < 50) break;
    beforeSeq = Number(page[page.length - 1]!.id.slice(2));
  }
  if (giver == null || giver === sessionId || giver === HUMAN) return null;
  return map.sessions.some((session) => session.id === giver && session.lifecycle !== 'closed') ? giver : null;
}

export function reportLetterText(sessionId: string, status: SessionResult, summary: string): string {
  const line = summary.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? '';
  const excerpt = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  return `${sessionId} reported ${status}: ${excerpt}. Full summary: get_map {session: "${sessionId}", field: "summary"}`;
}

export function isReportLetterAbout(message: Pick<Message, 'from' | 'roomId' | 'text'>, sessionId: string): boolean {
  return message.from === SYSTEM && message.roomId === null && message.text.startsWith(`${sessionId} reported `);
}
