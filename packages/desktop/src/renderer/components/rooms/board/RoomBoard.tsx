/**
 * Доска комнаты (спека доски комнаты 4.1–4.3): строка с фильтром агентов и ходом плана, уведомление, колонки.
 * Модель собирает `buildRoomBoard`; здесь только разметка и выбранный в фильтре агент.
 */

import { useState } from 'react';
import type { Room, RoomPlan, WindowWorkEntry } from '@parley/core';
import { S } from '../../../../shared/strings.js';
import { BoardColumn } from '../../../board/BoardColumn.js';
import { cn } from '../../../lib/cn.js';
import type { ActivityEntry } from '../../../store/activity.js';
import { Button } from '../../../ui/button.js';
import { AgentIcon } from '../../AgentIcon.js';
import type { ParticipantModel } from '../feed-model.js';
import { planProgress } from '../PlanPanel.js';
import { RoomBoardCard } from './RoomBoardCard.js';
import { buildRoomBoard } from './room-board-model.js';

export interface RoomBoardProps {
  plan: RoomPlan;
  room: Room;
  entry: WindowWorkEntry;
  participants: readonly ParticipantModel[];
  activity: Record<string, ActivityEntry>;
  now: Date;
  onOpenFeed: () => void;
  /** Нажатие и Enter на карточке; панель пункта подключает задача 6. */
  onOpenItem?: (itemId: number) => void;
}

export function RoomBoard({ plan, room, entry, participants, activity, now, onOpenFeed, onOpenItem }: RoomBoardProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const model = buildRoomBoard({ plan, room, entry, participants, activity, now });
  const noticeText =
    model.notice === null ? null : model.notice.kind === 'decision' ? S.roomBoard.noticeDecision : S.plans.haltNotice(model.notice.detail);
  return (
    <div data-room-board="" className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      <div className="flex shrink-0 items-center gap-3 px-9">
        <div role="group" aria-label={S.roomBoard.filter} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 p-0.5">
          {model.filterAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              aria-pressed={selected === agent.id}
              title={S.roomBoard.filterOnly(agent.label)}
              onClick={() => setSelected((current) => (current === agent.id ? null : agent.id))}
              className={cn('inline-flex shrink-0 rounded-full p-[3px]', selected === agent.id && 'bg-foreground/14')}
            >
              <AgentIcon provider={agent.provider ?? '?'} size={16} sessionId={agent.id} />
            </button>
          ))}
        </div>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {S.plans.status[plan.status]} · {planProgress(plan)}
        </span>
      </div>
      {noticeText === null ? null : (
        <div
          data-board-notice=""
          className="mx-9 flex shrink-0 items-center gap-3 rounded-md bg-accent-200 px-3 py-2 text-sm text-agent-question-text"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{noticeText}</span>
          <Button type="button" size="xs" variant="outline" onClick={onOpenFeed} className="shrink-0">
            {S.roomBoard.openFeed}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-start gap-3 overflow-auto px-9 pb-3">
        {model.columns.map(({ id, cards }) => (
          <div key={id} className="rounded-2xl bg-foreground/[0.06] p-2" data-board-column={id}>
            <BoardColumn title={S.roomBoard.columns[id === 'done' && plan.mode !== 'checklist' ? 'verified' : id]} count={cards.length}>
              {cards.length === 0 ? (
                <li className="px-1 py-2 text-xs text-muted-foreground">{S.roomBoard.empty}</li>
              ) : (
                cards.map((card) => (
                  <li key={card.itemId}>
                    <RoomBoardCard
                      card={card}
                      mode={plan.mode}
                      dimmed={selected !== null && !card.involved.includes(selected)}
                      now={now}
                      {...(onOpenItem === undefined ? {} : { onOpen: onOpenItem })}
                    />
                  </li>
                ))
              )}
            </BoardColumn>
          </div>
        ))}
      </div>
    </div>
  );
}
