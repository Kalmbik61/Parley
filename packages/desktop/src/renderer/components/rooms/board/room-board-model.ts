/**
 * Модель доски комнаты: чистая функция от плана, карты работы, участников и живой активности.
 * К хосту и сторам не обращается. Правила «выполнен», «готов», «кому действовать» берутся из `plan-state`.
 */
import type { PlanAttempt, PlanItem, PlanItemStatus, PlanMode, Room, RoomPlan, SessionNeed, WindowWorkEntry } from '@parley/core';
import { roomAwaitsDecision, sessionNeed } from '@parley/core/attention';
import { planItemDuties, planItemReady, planItemSatisfied, planSubmission } from '@parley/core/plan-state';
import { isoMs } from '../../../lib/iso-time.js';
import { sessionRowLabel } from '../../../lib/participant.js';
import { roomLiveLead, roomVerifierUnavailable } from '../../../lib/room-lead.js';
import { sessionWord } from '../../../lib/session-word.js';
import { activityFor, type ActivityEntry } from '../../../store/activity.js';
import type { ParticipantModel } from '../feed-model.js';
import { checkLine, lastAttempt, latestAttemptCheck } from '../latest-attempt-check.js';
import { ownerLabel } from '../PlanPanel.js';

export type BoardColumnId = 'waiting' | 'progress' | 'review' | 'done';
export interface BoardAgent {
  id: string;
  label: string;
  /** null — сессии нет в карте: ни значка, ни цвета, ни Open session. */
  provider: string | null;
  /** Слово состояния; '' — у сессии вне карты. */
  word: string;
}
export type BoardObstacle =
  | { kind: 'blocked'; note: string | null }
  | { kind: 'need'; need: SessionNeed }
  | { kind: 'soft'; text: string };
export type BoardReview =
  | { kind: 'waiting'; reviewer: BoardAgent }
  | { kind: 'human' }
  | { kind: 'none' }
  | { kind: 'attempt'; status: PlanAttempt['status']; check: string; failed: boolean };
export interface BoardCardModel {
  itemId: number;
  title: string;
  status: PlanItemStatus;
  column: BoardColumnId;
  /** null — автономный пункт без исполнителя: «Engine». */
  agent: BoardAgent | null;
  doing: string | null;
  obstacle: BoardObstacle | null;
  /** Незакрытые зависимости; только в Waiting. */
  waitsFor: number[];
  /** Пункт в Waiting, зависимости закрыты. */
  ready: boolean;
  returned: string | null;
  /** Только в In review. */
  review: BoardReview | null;
  basis: number | null;
  attempt: { n: number; of: number } | null;
  submission: number | null;
  updatedAt: string | null;
  needsHuman: boolean;
  /** Сессии, названные на карточке, — для фильтра. */
  involved: string[];
}
export type BoardNotice = { kind: 'decision' } | { kind: 'halted'; detail: string };
export interface RoomBoardModel {
  mode: PlanMode;
  columns: { id: BoardColumnId; cards: BoardCardModel[] }[];
  notice: BoardNotice | null;
  filterAgents: BoardAgent[];
}
export interface RoomBoardInput {
  plan: RoomPlan;
  room: Room;
  entry: WindowWorkEntry;
  participants: readonly ParticipantModel[];
  activity: Record<string, ActivityEntry>;
  now: Date;
}

/** Доска доступна: план в состоянии active, completing или completed. */
export function roomBoardAvailable(plan: RoomPlan | null): plan is RoomPlan {
  return plan !== null && (plan.status === 'active' || plan.status === 'completing' || plan.status === 'completed');
}

const COLUMNS: Record<PlanMode, BoardColumnId[]> = {
  checklist: ['waiting', 'progress', 'done'],
  verified: ['waiting', 'progress', 'review', 'done'],
  autonomous: ['waiting', 'progress', 'review', 'done'],
};
const REVIEW_ATTEMPT: PlanAttempt['status'][] = ['submitted', 'checking', 'accepted', 'queued'];

function agentFor(input: RoomBoardInput, id: string): BoardAgent {
  const { entry, now } = input;
  const session = entry.map.sessions.find((row) => row.id === id);
  if (session === undefined) return { id, label: ownerLabel(entry, id), provider: null, word: '' };
  const live = activityFor(input.activity, { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: id });
  return {
    id,
    label: sessionRowLabel(session.id, session.label),
    provider: session.provider,
    word: sessionWord(session, live?.activity ?? null, now),
  };
}

/** Исполнитель пункта для показа; `null` — автономный пункт без исполнителя. */
export function boardItemAgent(input: RoomBoardInput, item: PlanItem): BoardAgent | null {
  const { plan } = input;
  const id = plan.mode === 'autonomous' ? (lastAttempt(plan, item.id)?.worker ?? null) : item.owner;
  return id === null ? null : agentFor(input, id);
}

function columnOf(plan: RoomPlan, item: PlanItem, attempt: PlanAttempt | undefined): BoardColumnId {
  const status = item.status;
  let column: BoardColumnId;
  if (status === 'waiting' || status === 'ready') column = 'waiting';
  else if (status === 'returned' || status === 'blocked') column = 'progress';
  else if (plan.mode === 'autonomous') {
    if (status === 'verified') column = 'done';
    else if (status === 'in_progress' && attempt !== undefined && REVIEW_ATTEMPT.includes(attempt.status)) column = 'review';
    else column = 'progress';
  } else if (planItemSatisfied(plan, item)) column = 'done';
  else if (status === 'done') column = 'review';
  else column = 'progress';
  // Колонки нет в режиме (Checklist без review): карточка не пропадает.
  return COLUMNS[plan.mode].includes(column) ? column : 'progress';
}

const present = (text: string | null | undefined): string | null => (text === undefined || text === null || text === '' ? null : text);

function latestAt(times: string[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const at of times) {
    const ms = isoMs(at);
    if (ms !== null && ms > bestMs) {
      best = at;
      bestMs = ms;
    }
  }
  return best;
}

const sessionNumber = (id: string): number => {
  const match = /^s-(\d+)$/.exec(id);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
};

export function buildRoomBoard(input: RoomBoardInput): RoomBoardModel {
  const { plan, room, entry, participants, activity } = input;
  const live = roomLiveLead(entry.map, room);
  const prepared = plan.items.map((item) => {
    const attempt = lastAttempt(plan, item.id);
    return { item, attempt, column: columnOf(plan, item, attempt), agent: boardItemAgent(input, item) };
  });
  const inProgress = (agentId: string): number =>
    prepared.filter((row) => row.column === 'progress' && row.agent?.id === agentId).length;

  const cards: BoardCardModel[] = prepared.map(({ item, attempt, column, agent }) => {
    const session = agent === null ? undefined : entry.map.sessions.find((row) => row.id === agent.id);
    const need =
      session === undefined
        ? null
        : sessionNeed(session, activityFor(activity, { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id })?.activity ?? null);

    let review: BoardReview | null = null;
    if (column === 'review') {
      if (plan.mode === 'autonomous') {
        if (attempt !== undefined) {
          const check = latestAttemptCheck(plan, attempt);
          review = { kind: 'attempt', status: attempt.status, check: checkLine(check), failed: check?.verdict === 'fail' || check?.verdict === 'error' };
        }
      } else if (plan.mode === 'verified') {
        const unavailable = roomVerifierUnavailable(entry.map, room, item.verifier);
        const duty = planItemDuties(plan, item, live, unavailable).find((row) => row.action === 'verify');
        review = duty === undefined ? { kind: 'none' } : duty.sessionId === 'human' ? { kind: 'human' } : { kind: 'waiting', reviewer: agentFor(input, duty.sessionId) };
      }
    }

    const blocker = item.progress?.owner?.blocker ?? null;
    const obstacle: BoardObstacle | null =
      item.status === 'blocked'
        ? { kind: 'blocked', note: item.note }
        : need !== null
          ? { kind: 'need', need }
          : present(blocker) !== null
            ? { kind: 'soft', text: blocker as string }
            : null;

    let doing: string | null = null;
    if (column === 'progress') {
      doing = present(item.progress?.owner?.next);
      if (doing === null && agent !== null && inProgress(agent.id) === 1) {
        const line = participants.find((row) => row.id === agent.id)?.planLine ?? null;
        if (line !== null && line.kind === 'current') doing = present(line.text);
      }
    }

    const submissions = item.submissions ?? [];
    const lastSubmission = submissions.length > 0 ? submissions[submissions.length - 1]! : undefined;
    const returned =
      item.status === 'returned' ? (present(lastSubmission?.returnNote) ?? present(lastSubmission?.note) ?? present(item.note) ?? '') : null;
    const submission = plan.mode === 'verified' ? planSubmission(item) : null;
    const reviewer = review !== null && review.kind === 'waiting' ? review.reviewer : null;

    return {
      itemId: item.id,
      title: item.title,
      status: item.status,
      column,
      agent,
      doing,
      obstacle,
      waitsFor: column === 'waiting' ? item.after.filter((id) => {
        const dependency = plan.items.find((other) => other.id === id);
        return dependency === undefined || !planItemSatisfied(plan, dependency);
      }) : [],
      ready: column === 'waiting' && planItemReady(plan, item),
      returned,
      review,
      basis: column === 'done' && item.status === 'done' && plan.mode !== 'checklist' ? (item.acceptedChecklistRevision ?? null) : null,
      attempt: attempt === undefined ? null : { n: attempt.n, of: plan.autonomous?.budget.limits.attemptsPerItem ?? 0 },
      submission: submission !== null && submission > 1 ? submission : null,
      updatedAt: latestAt([...item.log.map((row) => row.at), ...(attempt?.log.map((row) => row.at) ?? [])]),
      needsHuman: need !== null || review?.kind === 'human',
      involved: [...(agent === null ? [] : [agent.id]), ...(reviewer === null ? [] : [reviewer.id])],
    };
  });

  const agents = new Map<string, BoardAgent>();
  for (const card of cards) {
    if (card.agent !== null && card.agent.provider !== null) agents.set(card.agent.id, card.agent);
    if (card.review?.kind === 'waiting' && card.review.reviewer.provider !== null) agents.set(card.review.reviewer.id, card.review.reviewer);
  }

  return {
    mode: plan.mode,
    columns: COLUMNS[plan.mode].map((id) => ({
      id,
      cards: cards
        .filter((card) => card.column === id)
        .sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman) || a.itemId - b.itemId),
    })),
    notice: roomAwaitsDecision(room)
      ? { kind: 'decision' }
      : plan.autonomous?.halted != null
        ? { kind: 'halted', detail: plan.autonomous.halted.detail }
        : null,
    filterAgents: [...agents.values()].sort((a, b) => sessionNumber(a.id) - sessionNumber(b.id)),
  };
}
