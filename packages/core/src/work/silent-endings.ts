import type { LetterReads, LetterTx } from './letter-store.js';
import { letterSeq } from './letter-tables.js';
import { hookedSince, type SessionActivity } from './activity.js';
import { liveLead, isRoomArchived } from './rooms.js';
import { swarmOfSession } from './swarms.js';
import { isTaskLetter, reportRecipients } from './task-giver.js';
import { HUMAN, PARLEY, type Message, type SilentEndingMark, type WorkMap, type WorkSession } from './types.js';

export type { SilentEndingKind, SilentEndingMark } from './types.js';

/** Тихая концовка, о которой пишет живой обработчик: выход процесса, Stop или Close человеком. */
export type SilentEnding = { kind: 'exit'; exitCode: number; signal?: number } | { kind: 'stop' } | { kind: 'close' };

/**
 * Тексты писем. `sessionId` — как есть (`s-05`), чтобы агент передал его в инструменты. Для `turn` — письмо
 * получателям; письмо самой сессии — `nudgeText`.
 */
export function silentEndingText(sessionId: string, ending: SilentEnding | { kind: 'turn' }): string {
  switch (ending.kind) {
    case 'exit': {
      const how = ending.signal !== undefined && ending.signal !== 0 ? `signal ${ending.signal}` : `exit code ${ending.exitCode}`;
      return `${sessionId} stopped (${how}) without a result. A letter to ${sessionId} resumes it.`;
    }
    case 'stop':
      return `${sessionId} was stopped by the human without a result.`;
    case 'close':
      return `${sessionId} was closed by the human without a result.`;
    case 'turn':
      return `${sessionId} ended its turn without a report.`;
  }
}

/** Напоминание самой сессии, кончившей ход без `report`; `recipients` — кому она может написать. */
export function nudgeText(recipients: readonly string[]): string {
  return `You ended your turn without calling report. Call report {status: "done" | "failed", summary: "…"}, or tell ${recipients.join(', ')} what blocks you with send_message.`;
}

/** Самое новое письмо-задание сессии (`isTaskLetter`) в любой комнате; `null` — задание было из создания. */
export function lastTaskLetter(map: WorkMap, letters: LetterReads, sessionId: string): Message | null {
  let beforeSeq: number | undefined;
  for (;;) {
    const page = letters.query({ involving: [sessionId], newestFirst: true, limit: 50,
      ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    const task = page.find((letter) => isTaskLetter(map, sessionId, letter));
    if (task !== undefined) return task;
    if (page.length < 50) return null;
    beforeSeq = letterSeq(page[page.length - 1]!.id);
  }
}

const sessionOf = (map: WorkMap, sessionId: string): WorkSession | undefined =>
  map.sessions.find((session) => session.id === sessionId);

/** Итог текущего задания: он есть и поставлен не раньше нового письма-задания. */
function hasCurrentResult(session: WorkSession, task: Message | null): boolean {
  if (session.result === null) return false;
  if (task === null || session.resultAt === null) return true;
  return Date.parse(session.resultAt) >= Date.parse(task.at);
}

/** Отметка под текущее задание: чужая (старое задание) или отсутствующая заменяется чистой. */
function markFor(session: WorkSession, task: Message | null): SilentEndingMark {
  const assignment = task?.id ?? null;
  const mark = session.silentEnding;
  if (mark != null && mark.assignment === assignment) return mark;
  return { assignment, told: [], nudgedAt: null };
}

function note(letters: LetterTx, to: string[], text: string, at: string): void {
  letters.add({ roomId: null, from: PARLEY, to, text, kind: 'note', at });
}

/**
 * Сообщает получателям о тихой концовке и ставит отметку; `true` — письмо написано. Пишет только под замком карты.
 * Не пишет: у вида не то состояние (`exit` — спит без `autoSleep`, `stop` — спит, `close` — закрыта), итог задания
 * сдан, сессия в рое, получателей нет, вид под это задание уже сообщён.
 */
export function tellSilentEnding(
  map: WorkMap,
  letters: LetterTx,
  sessionId: string,
  ending: SilentEnding,
  at: string,
): boolean {
  const session = sessionOf(map, sessionId);
  if (session === undefined || swarmOfSession(map, sessionId) !== null) return false;
  const stateOk = ending.kind === 'exit' ? session.lifecycle === 'sleeping' && session.autoSleep == null
    : ending.kind === 'stop' ? session.lifecycle === 'sleeping' : session.lifecycle === 'closed';
  if (!stateOk) return false;
  const task = lastTaskLetter(map, letters, sessionId);
  if (hasCurrentResult(session, task)) return false;
  const mark = markFor(session, task);
  if (mark.told.includes(ending.kind)) return false;
  const waiting = (id: string): boolean =>
    ending.kind === 'close' && map.sessions.some((other) => other.id === id && other.lifecycle === 'sleeping' &&
      other.autoSleep?.waitTarget === sessionId);
  const to = reportRecipients(map, letters, sessionId).map((recipient) => recipient.id).filter((id) => !waiting(id));
  if (to.length === 0) return false;
  session.silentEnding = { ...mark, told: [...mark.told, ending.kind] };
  note(letters, to, silentEndingText(sessionId, ending), at);
  return true;
}

/**
 * Время (мс) конца хода, после которого сессия молчит: `idle` или `unseen`, конец хода известен, хуки были с запуска,
 * ход не открыт тишиной, нет `wait_for`, `need` и фоновых задач. Берётся позднее из конца хода и запуска процесса;
 * иначе `null`.
 */
export function silentTurnEnd(activity: SessionActivity | null | undefined, startedAtMs: number): number | null {
  if (activity == null || !hookedSince(activity, startedAtMs)) return null;
  if (activity.activity !== 'idle' && activity.activity !== 'unseen') return null;
  if (activity.quietTurn === true || activity.waitingFor !== null || activity.need !== null) return null;
  if (activity.runningBackground.length > 0 || activity.tasks.length > 0) return null;
  const endedAt = activity.turnEndedAt === null ? Number.NaN : Date.parse(activity.turnEndedAt);
  return Number.isNaN(endedAt) ? null : Math.max(endedAt, startedAtMs);
}

/** Сессия ведёт живую открытую комнату или у неё есть дети в работе: сдавать итог ей не обязательно. */
function coordinates(map: WorkMap, session: WorkSession): boolean {
  if (map.rooms.some((room) => !isRoomArchived(room) && room.members.includes(session.id) && liveLead(map, room) === session.id)) return true;
  return map.sessions.some((child) => (child.createdBy === session.id || child.parent === session.id) &&
    (child.lifecycle === 'active' || child.lifecycle === 'pending'));
}

/**
 * Один шаг сторожа конца хода без `report` (хост зовёт его под замком карты через `SILENT_TURN_MS` после конца хода).
 * Первый раз пишет напоминание самой сессии (`'nudged'`); следующий раз — письмо получателям (`'told'`), если после
 * напоминания сессия не написала ни одного письма (написала — отметка без письма). Дальше в задании — `null`.
 * Сессия без письма-задания, которую завёл человек (не `create_session` другой сессии), не получает напоминания:
 * она ещё ждёт свою часть от ведущего или решения человека, задания у неё нет. Черновик человека хост проверяет сам.
 */
export function silentTurnStep(map: WorkMap, letters: LetterTx, sessionId: string, at: string): 'nudged' | 'told' | null {
  const session = sessionOf(map, sessionId);
  if (session === undefined || session.lifecycle !== 'active' || session.stuck != null) return null;
  if (swarmOfSession(map, sessionId) !== null || coordinates(map, session)) return null;
  if (letters.unreadFor(sessionId).length > 0) return null;
  const task = lastTaskLetter(map, letters, sessionId);
  if (task === null && (session.createdBy == null || session.createdBy === '' || session.createdBy === HUMAN)) return null;
  if (hasCurrentResult(session, task)) return null;
  const to = reportRecipients(map, letters, sessionId).map((recipient) => recipient.id);
  if (to.length === 0) return null;
  const mark = markFor(session, task);
  if (mark.told.includes('turn')) return null;
  if (mark.nudgedAt === null) {
    session.silentEnding = { ...mark, nudgedAt: at };
    note(letters, [sessionId], nudgeText(to), at);
    return 'nudged';
  }
  session.silentEnding = { ...mark, told: [...mark.told, 'turn'] };
  if (letters.query({ from: sessionId, sinceAt: mark.nudgedAt, limit: 1 }).length > 0) return null;
  note(letters, to, silentEndingText(sessionId, { kind: 'turn' }), at);
  return 'told';
}
