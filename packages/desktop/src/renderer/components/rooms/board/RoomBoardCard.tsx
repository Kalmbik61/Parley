/**
 * Карточка пункта на доске комнаты (спека доски комнаты 4.3): кнопка на всю ширину, слева полоса цвета агента.
 * Строки сверху вниз, пустые пропускаются.
 */

import type { PlanMode } from '@parley/core';
import { S } from '../../../../shared/strings.js';
import { needLabel } from '../../../attention/derive.js';
import { agentColourVar } from '../../../lib/agent-colour.js';
import { cn } from '../../../lib/cn.js';
import { relativeTimeAgo } from '../../../lib/relative-time.js';
import { AgentIcon } from '../../AgentIcon.js';
import type { BoardCardModel } from './room-board-model.js';

export interface RoomBoardCardProps {
  card: BoardCardModel;
  mode: PlanMode;
  /** Карточка не относится к выбранному в фильтре агенту. */
  dimmed: boolean;
  now: Date;
  /** Нажатие и Enter; панель пункта подключает задача 6. */
  onOpen?: (itemId: number) => void;
}

/** Фон вопроса агента — у строк, где пункт ждёт человека или упёрся в препятствие. */
const QUESTION = 'rounded-md bg-accent-200 px-1.5 py-1 text-xs text-agent-question-text [overflow-wrap:anywhere]';
const MUTED = 'text-xs text-muted-foreground [overflow-wrap:anywhere]';

/** Состояния, которые колонка In progress и так показывает; для остальных рядом с названием стоит слово состояния. */
const SHOWN_IN_PROGRESS = new Set(['in_progress', 'returned', 'blocked']);

export function RoomBoardCard({ card, dimmed, now, onOpen }: RoomBoardCardProps): JSX.Element {
  const { agent, obstacle, review } = card;
  const stripe = agent !== null && agent.provider !== null ? agentColourVar(agent.id) : null;
  const waitsForHuman = obstacle?.kind === 'need';
  const obstacleText =
    obstacle === null
      ? null
      : obstacle.kind === 'blocked'
        ? S.roomBoard.blocked(obstacle.note ?? '')
        : obstacle.kind === 'need'
          ? needLabel(obstacle.need, now.getTime())
          : obstacle.text;

  let reviewLine: { text: string; question: boolean } | null = null;
  if (review !== null) {
    if (review.kind === 'waiting') reviewLine = { text: S.roomBoard.waitingFor(review.reviewer.label), question: false };
    else if (review.kind === 'human') reviewLine = { text: S.roomBoard.waitingForYou, question: true };
    else if (review.kind === 'none') reviewLine = { text: S.roomBoard.noVerifier, question: true };
    else {
      const status = S.plans.attemptStatus[review.status];
      reviewLine = { text: review.check === '' ? status : `${status} · ${review.check}`, question: review.failed };
    }
  }

  const fallbackStatus = card.column === 'progress' && !SHOWN_IN_PROGRESS.has(card.status);
  const small: string[] = [];
  if (card.attempt !== null) small.push(S.roomBoard.attempt(card.attempt.n, card.attempt.of));
  else if (card.submission !== null) small.push(S.roomBoard.submission(card.submission));
  if (card.updatedAt !== null) small.push(S.roomBoard.updated(relativeTimeAgo(card.updatedAt, now)));

  return (
    <button
      type="button"
      data-board-item={card.itemId}
      onClick={onOpen === undefined ? undefined : () => onOpen(card.itemId)}
      className={cn(
        'relative flex w-full flex-col gap-1.5 overflow-hidden rounded-[14px] bg-card py-2.5 pl-4 pr-2.5 text-left text-sm shadow-sm',
        dimmed && 'opacity-30',
      )}
    >
      <span
        aria-hidden="true"
        data-board-stripe=""
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: stripe ?? 'var(--color-neutral-400)' }}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
          <span>{S.roomBoard.item(card.itemId)}</span>
          {fallbackStatus ? <span data-board-status="">{S.plans.itemStatus[card.status]}</span> : null}
        </span>
        <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{card.title}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        {agent === null ? (
          <span className="truncate">{S.roomBoard.engine}</span>
        ) : (
          <>
            {agent.provider === null ? null : <AgentIcon provider={agent.provider} size={16} sessionId={agent.id} />}
            <span className="min-w-0 truncate font-medium">{agent.label}</span>
            {agent.word === '' || waitsForHuman ? null : <span className="shrink-0 text-muted-foreground">{agent.word}</span>}
          </>
        )}
      </span>
      {card.doing === null ? null : <span className={cn('line-clamp-2', MUTED)}>{card.doing}</span>}
      {obstacleText === null ? null : <span data-board-obstacle="" className={QUESTION}>{obstacleText}</span>}
      {card.column !== 'waiting' ? null : (
        <span className={MUTED}>{card.ready ? S.roomBoard.ready : S.roomBoard.waitsFor(card.waitsFor.map((id) => `#${id}`).join(', '))}</span>
      )}
      {card.returned === null ? null : <span className={MUTED}>{S.roomBoard.returned(card.returned)}</span>}
      {reviewLine === null ? null : <span className={reviewLine.question ? QUESTION : MUTED}>{reviewLine.text}</span>}
      {card.basis === null ? null : <span className={MUTED}>{S.plans.basis(card.basis)}</span>}
      {small.length === 0 ? null : <span className="text-[11px] text-muted-foreground">{small.join(' · ')}</span>}
    </button>
  );
}
