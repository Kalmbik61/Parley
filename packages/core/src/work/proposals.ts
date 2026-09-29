/**
 * Решение ведущего, которое ждёт человека (дизайн комнат, 2.4 и 3.1): ведущий кладёт его
 * в слот `Room.proposal` (`setProposal`, его зовёт `propose_decision`), человек отвечает
 * `Accept` или `Return for rework` (`resolveProposal`, его зовёт `rooms.resolveProposal`
 * хоста). Обе функции меняют карту в памяти — вызывающий держит их внутри `updateMap`.
 */

import { addMessage, maxNumber } from './map.js';
import { addSystemMessage, isRoomClosed, roomLead, RoomRuleError } from './rooms.js';
import { HUMAN, type Room, type WorkMap } from './types.js';

/** Предел текста решения в знаках (дизайн комнат, 3.1). */
export const PROPOSAL_TEXT_MAX = 10_000;

/** Системная строка ленты при принятии решения. */
export const ACCEPTED_LINE = 'You accepted the decision';
/** Письмо человека ведущему о принятии: по нему ведущий раздаёт части. */
export const ACCEPTED_LETTER = 'Decision accepted.';
/** Начало письма о возврате: `Returned for rework: {заметка}` или `Returned for rework.`. */
export const RETURNED_LETTER = 'Returned for rework';

/**
 * Ответ человека пришёл не на то решение, которое лежит в слоте: его уже приняли, вернули
 * или заменили новым, пока окно держало старую карточку. Отдельный класс: хост отвечает на
 * него `conflict`, а не `bad_request` — запрос был верным, устарело состояние.
 */
export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalConflictError';
  }
}

const roomOf = (map: WorkMap, roomId: string): Room => {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new RoomRuleError(`комнаты ${roomId} нет в карте`);
  return room;
};

/**
 * Следующий id решения: `p-01`, `p-02`, … Счётчик — `work.proposalSeq`, а не список: после
 * ответа человека слот пуст, и по нему номер уехал бы назад (тот же приём, что у `nextRoomId`).
 */
function nextProposalId(map: WorkMap): string {
  const next =
    Math.max(
      map.work.proposalSeq ?? 0,
      maxNumber(
        map.rooms.flatMap((room) => (room.proposal === null ? [] : [room.proposal.id])),
        'p-',
      ),
    ) + 1;
  map.work.proposalSeq = next;
  return `p-${String(next).padStart(2, '0')}`;
}

/**
 * Ведущий приносит решение. Приносить может только он (`roomLead`), и только в живую
 * комнату. Пока человек не ответил, повторный вызов заменяет текст: тот же `id`, `rev + 1`
 * — окно обновит карточку, а `Accept` по ней останется верным. После ответа слот пуст, и
 * новое решение получает новый `id`. Письма решение не создаёт: лента остаётся лентой
 * фактов, факты пишет `resolveProposal`.
 */
export function setProposal(
  map: WorkMap,
  roomId: string,
  from: string,
  text: string,
  at = new Date().toISOString(),
): { proposalId: string; rev: number } {
  const room = roomOf(map, roomId);
  if (isRoomClosed(map, room)) {
    throw new RoomRuleError(`комната ${roomId} закрыта: в ней нет живых участников`);
  }
  if (roomLead(room) !== from) {
    throw new RoomRuleError(
      `сессия ${from} не ведущий комнаты ${roomId}: решение приносит только ведущий`,
    );
  }
  const session = map.sessions.find((candidate) => candidate.id === from);
  if (session === undefined || session.lifecycle === 'closed') {
    throw new RoomRuleError(`сессия ${from} закрыта: решение не принято`);
  }
  if (text.trim() === '' || text.length > PROPOSAL_TEXT_MAX) {
    throw new RoomRuleError(`текст решения: 1–${PROPOSAL_TEXT_MAX} знаков`);
  }

  const current = room.proposal;
  if (current === null) {
    room.proposal = { id: nextProposalId(map), from, text, rev: 0, at };
    return { proposalId: room.proposal.id, rev: 0 };
  }
  room.proposal = { id: current.id, from, text, rev: current.rev + 1, at };
  return { proposalId: current.id, rev: current.rev + 1 };
}

/**
 * Человек отвечает на решение. Слот очищается в обоих случаях, а факты дописываются в ленту:
 *  - `accept` — сообщение `decision` от ведущего с текстом решения (всей комнате, как
 *    рассылка), системная строка `You accepted the decision` и письмо ведущему о принятии;
 *    возвращается id сообщения `decision`;
 *  - `return` — письмо человека ведущему `Returned for rework: {заметка}` (без заметки —
 *    `Returned for rework.`); возвращается его id.
 * Решение в слоте — не то, на которое отвечают (`proposalId` устарел, решения уже нет,
 * ответ повторён), — `ProposalConflictError`, и карта не меняется: дублей сообщений нет.
 * Письмо идёт нынешнему ведущему, а не автору решения: если автор успел уйти из комнаты,
 * доработку принимает тот, кто ведёт её сейчас.
 */
export function resolveProposal(
  map: WorkMap,
  roomId: string,
  proposalId: string,
  action: 'accept' | 'return',
  note?: string,
  at = new Date().toISOString(),
): { messageId: string } {
  const room = roomOf(map, roomId);
  const proposal = room.proposal;
  if (proposal === null || proposal.id !== proposalId) {
    throw new ProposalConflictError(
      `решение ${proposalId} комнаты ${roomId} не ждёт ответа: его уже приняли, вернули или заменили новым`,
    );
  }
  const lead = roomLead(room) ?? proposal.from;
  room.proposal = null;

  if (action === 'return') {
    const remark = (note ?? '').trim();
    const text = remark === '' ? `${RETURNED_LETTER}.` : `${RETURNED_LETTER}: ${remark}`;
    const letter = addMessage(map, { from: HUMAN, to: [lead], roomId, kind: 'note', text }, at);
    return { messageId: letter.id };
  }

  // `to: []` — рассылка комнате: участники узнают решение письмом kind `decision`. Человек его
  // только что принял, и «непрочитанным» оно ему не значится.
  const decision = addMessage(
    map,
    { from: proposal.from, to: [], roomId, kind: 'decision', text: proposal.text },
    at,
  );
  decision.readBy[HUMAN] = at;
  addSystemMessage(map, roomId, ACCEPTED_LINE, at);
  addMessage(map, { from: HUMAN, to: [lead], roomId, kind: 'note', text: ACCEPTED_LETTER }, at);
  return { messageId: decision.id };
}
