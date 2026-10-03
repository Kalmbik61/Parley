/**
 * Решение ведущего, которое ждёт человека (дизайн комнат, 2.4 и 3.1): ведущий кладёт его
 * в слот `Room.proposal` (`setProposal`, его зовёт `propose_decision`), человек отвечает
 * `Accept` или `Return for rework` (`resolveProposal`, его зовёт `rooms.resolveProposal`
 * хоста). Обе функции меняют карту в памяти — вызывающий держит их внутри `updateMap`.
 */

import { addMessage, maxNumber } from './map.js';
import { addSystemMessage, isRoomClosed, liveLead, RoomRuleError } from './rooms.js';
import { acceptRoomPlan, completeRoomPlan, planRoom, requirePlanLead, planItemsComplete, PlanConflictError } from './plans.js';
import { proposedRoomPlan } from './plans.js';
import { HUMAN, type PlanDraft, type Room, type WorkMap } from './types.js';

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
  if (room === undefined) throw new RoomRuleError(`room ${roomId} is not in the map`);
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
 * Ведущий приносит решение. Приносить может только он (`liveLead`: назначенный, а закрытого
 * или удалённого подменяет первый живой участник), и только в живую комнату. Пока человек не
 * ответил, повторный вызов заменяет текст: тот же `id`, `rev + 1` — окно обновит карточку, а
 * `Accept` по ней остаётся верным, если человек показал `rev`. После ответа слот пуст, и новое
 * решение получает новый `id`. Письма решение не создаёт: лента остаётся лентой фактов, факты
 * пишет `resolveProposal`.
 */
export interface ProposalOptions { plan?: PlanDraft }

export function setProposal(
  map: WorkMap,
  roomId: string,
  from: string,
  text: string,
  at = new Date().toISOString(),
  options: ProposalOptions = {},
): { proposalId: string; rev: number } {
  const room = roomOf(map, roomId);
  if (isRoomClosed(map, room)) {
    throw new RoomRuleError(`room ${roomId} is closed: it has no live participants`);
  }
  // Ведущий из `liveLead` жив по построению: отдельной проверки «сессия закрыта» не нужно.
  if (liveLead(map, room) !== from) {
    throw new RoomRuleError(
      `session ${from} is not the lead of room ${roomId}: only the lead brings a decision`,
    );
  }
  if (text.trim() === '' || text.length > PROPOSAL_TEXT_MAX) {
    throw new RoomRuleError(`decision text: 1–${PROPOSAL_TEXT_MAX} characters`);
  }

  const mode = room.mode ?? 'free';
  if (mode === 'free' && options.plan !== undefined || mode !== 'free' && options.plan === undefined) throw new RoomRuleError('decision must match room mode');
  const plan = options.plan === undefined ? undefined : proposedRoomPlan(map, roomId, from, options.plan, text.length);
  const extra = plan === undefined ? {} : { kind: 'decision' as const, plan };
  const current = room.proposal;
  if (current === null) {
    room.proposal = { id: nextProposalId(map), from, text, rev: 0, at, ...extra };
    return { proposalId: room.proposal.id, rev: 0 };
  }
  room.proposal = { id: current.id, from, text, rev: current.rev + 1, at, ...extra };
  return { proposalId: current.id, rev: current.rev + 1 };
}

/** Что человек добавляет к ответу на решение. */
export interface ResolveOptions {
  /** Required for plan-bearing decisions/completions, in addition to proposal rev. */
  planId?: string;
  planRev?: number;
  /** Заметка возврата (`return`); пустая и из одних пробелов — как без неё. */
  note?: string | undefined;
  /**
   * Версия карточки, на которую человек отвечает (`Proposal.rev`). Не совпала с нынешней — ведущий
   * успел заменить текст, пока карточка висела на экране, и ответ на неё — `ProposalConflictError`:
   * `id` при замене сохраняется, и одним `proposalId` принять текст, которого человек не видел,
   * не остановить. Нет — проверяется только `proposalId` (окно, которое версию не шлёт).
   */
  rev?: number | undefined;
}

/**
 * Человек отвечает на решение. Слот очищается в обоих случаях, а факты дописываются в ленту:
 *  - `accept` — сообщение `decision` от ведущего с текстом решения (всей комнате, как
 *    рассылка), системная строка `You accepted the decision` и письмо ведущему о принятии;
 *    возвращается id сообщения `decision`;
 *  - `return` — письмо человека ведущему `Returned for rework: {заметка}` (без заметки —
 *    `Returned for rework.`); возвращается его id.
 * Решение в слоте — не то, на которое отвечают (`proposalId` устарел, решения уже нет,
 * ответ повторён, `rev` показанной карточки не совпал с нынешним), — `ProposalConflictError`, и
 * карта не меняется: дублей сообщений нет. Письмо идёт нынешнему живому ведущему (`liveLead`),
 * а не автору решения: если автор успел уйти из комнаты или закрыться, доработку принимает тот,
 * кто ведёт её сейчас; живых нет — автору.
 */
export function resolveProposal(
  map: WorkMap,
  roomId: string,
  proposalId: string,
  action: 'accept' | 'return',
  options: ResolveOptions = {},
  at = new Date().toISOString(),
): { messageId: string } {
  let room = roomOf(map, roomId);
  const proposal = room.proposal;
  if (proposal === null || proposal.id !== proposalId) {
    throw new ProposalConflictError(
      `decision ${proposalId} of room ${roomId} is not waiting for an answer: it has already been accepted, returned or replaced by a new one`,
    );
  }
  if (options.rev !== undefined && options.rev !== proposal.rev) {
    throw new ProposalConflictError(
      `decision ${proposalId} of room ${roomId} was replaced: version ${proposal.rev} is waiting, but the answer was given to version ${options.rev}`,
    );
  }
  if (proposal.plan || proposal.kind === 'completion') {
    const planId = proposal.plan?.id ?? proposal.planId; const planRev = proposal.plan?.rev ?? proposal.planRev;
    if (options.rev !== proposal.rev || options.planId !== planId || options.planRev !== planRev) throw new ProposalConflictError('plan identity/revision must match the displayed proposal');
    if (proposal.kind === 'completion') {
      if (planId === undefined || planRev === undefined) throw new PlanConflictError();
      completeRoomPlan(map, planId, planRev, action, proposal.text, at);
    } else if (action === 'accept' && proposal.plan) acceptRoomPlan(map, proposal.plan, at);
    room = roomOf(map, roomId);
  }
  const lead = liveLead(map, room) ?? proposal.from;
  room.proposal = null;

  if (action === 'return') {
    const remark = (options.note ?? '').trim();
    const text = remark === '' ? `${RETURNED_LETTER}.` : `${RETURNED_LETTER}: ${remark}`;
    const letter = addMessage(map, { from: HUMAN, to: [proposal.kind === 'completion' ? HUMAN : lead], roomId, kind: 'note', text }, at);
    if (proposal.kind === 'completion') letter.readBy[HUMAN] = at;
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
  addSystemMessage(map, roomId, proposal.kind === 'completion' ? `Plan ${proposal.planId} completed` : ACCEPTED_LINE, at);
  addMessage(map, { from: HUMAN, to: [lead], roomId, kind: 'note', text: proposal.kind === 'completion' ? 'Completion accepted.' : ACCEPTED_LETTER }, at);
  return { messageId: decision.id };
}

/** Completion is a separate, revision-bound human decision, never owner self-acceptance. */
export function proposeCompletion(map: WorkMap, roomId: string, from: string, planId: string, rev: number, summary: string, at = new Date().toISOString()): { proposalId: string; rev: number } {
  const room = planRoom(map, roomId); requirePlanLead(map, room, from);
  const plan = map.plans?.find(plan => plan.id === planId && plan.roomId === roomId);
  if (!plan || plan.rev !== rev || plan.mode !== 'verified' || !['active', 'completing'].includes(plan.status) || !planItemsComplete(plan)) throw new PlanConflictError();
  if (!summary.trim() || summary.length > PROPOSAL_TEXT_MAX || summary.includes('\0') || Buffer.from(summary, 'utf8').toString('utf8') !== summary) throw new RoomRuleError('invalid completion summary');
  const previous = room.proposal;
  const proposal = { id: previous?.id ?? nextProposalId(map), from, text: summary, at, rev: previous ? previous.rev + 1 : 0, kind: 'completion' as const, planId, planRev: rev };
  plan.status = 'completing'; room.proposal = proposal;
  return { proposalId: proposal.id, rev: proposal.rev };
}
