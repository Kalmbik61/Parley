/**
 * Шапка вкладки комнаты (спека окна 2026-09-29, 1.3): название — Caprasimo 25px/1.12, подзаголовок 13px
 * вторичным цветом (`Created by you · 4 agents · lead S01 · {работа}`), ниже лента участников; снизу
 * линия 1px `currentColor 12%`. Название и подзаголовок — в одну строку с многоточием и полным текстом в
 * тултипе: название в 120 знаков в невысоком окне иначе съело бы ленту. У архивной комнаты (спека архива комнат, 5.2)
 * справа от названия стоит метка `Archived`: она не сжимается, обрезается название.
 */

import type { ReactNode } from 'react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Badge } from '../../ui/badge.js';
import type { ParticipantModel } from './feed-model.js';
import { ParticipantStrip } from './ParticipantStrip.js';

/**
 * Низкая панель (ниже 560 px по контейнеру `room-panel` у корня `RoomPanel`): в виде Board шапка сжимается до названия и
 * подзаголовка, ряд режима и лента участников прячутся (спека доски комнаты 4.1).
 */
export const SHORT_PANEL_HIDDEN = '[@container_room-panel_(max-height:559px)]:hidden';

export interface RoomHeaderProps {
  modeControl?: ReactNode;
  /** Чип рецепта комнаты (`RoomRecipeChip`) рядом с режимом. */
  recipeChip?: ReactNode;
  /** Кнопка «Browser» панели браузера комнаты (спека браузера 4.11) — справа в строке названия. */
  browserToggle?: ReactNode;
  /** Переключатель Feed / Board (`RoomViewSwitch`) — в строке названия перед кнопкой Browser. */
  viewSwitch?: ReactNode;
  /** Значок расхода токенов комнаты (`RoomUsageChip`) рядом с режимом. */
  usageChip?: ReactNode;
  /** Значок контекста комнаты (`RoomContextChip`, спека 2026-10-15, 3.3) рядом с расходом. */
  contextChip?: ReactNode;
  /** Чип контекста участника на карточке (`ContextChip`, спека 3.2). */
  participantContext?: (participant: ParticipantModel) => ReactNode;
  /** Открыт вид Board: в низкой панели ряд режима и лента участников прячутся. */
  boardOpen?: boolean;
  /** Метки пунктов плана у участников (`participantItemTags`). */
  itemTags?: ReadonlyMap<string, number[]>;
  title: string;
  subtitle: string;
  /** Комната в архиве: рядом с названием метка `Archived`. */
  archived?: boolean;
  participants: readonly ParticipantModel[];
  onOpenPlan?: (sessionId: string) => void;
  onOpenSession: (sessionId: string, agentId?: string) => void;
  /** «Сейчас» окна — для времени сброса лимита в слове причины участника (`ParticipantStrip`). */
  now: Date;
}

export function RoomHeader({ title, subtitle, archived = false, participants, onOpenSession, onOpenPlan, modeControl, recipeChip, browserToggle, viewSwitch, usageChip, contextChip, participantContext, itemTags, boardOpen = false, now }: RoomHeaderProps): JSX.Element {
  const strip = (
    <ParticipantStrip
      participants={participants}
      onOpenSession={onOpenSession}
      now={now}
      {...(onOpenPlan === undefined ? {} : { onOpenPlan })}
      {...(participantContext === undefined ? {} : { contextChip: participantContext })}
      {...(itemTags === undefined ? {} : { itemTags })}
    />
  );
  return (
    <div
      data-room-header=""
      className="flex shrink-0 flex-col gap-3 border-b border-[color-mix(in_srgb,currentColor_12%,transparent)] px-9 pb-3.5 pt-6"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-3">
          <h3 title={title} className="m-0 min-w-0 truncate font-heading text-[25px] leading-[1.12] tracking-[-0.015em]">
            {title}
          </h3>
          {archived ? (
            <Badge variant="neutral-sheet" data-room-archived="" className="shrink-0">
              {S.rooms.archived}
            </Badge>
          ) : null}
          {browserToggle === undefined && viewSwitch === undefined ? null : (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {viewSwitch}
              {browserToggle}
            </div>
          )}
        </div>
        <span title={subtitle} className="truncate text-[13px] text-muted-foreground">
          {subtitle}
        </span>
      </div>
      {recipeChip === undefined && usageChip === undefined && contextChip === undefined ? (
        boardOpen ? <div className={SHORT_PANEL_HIDDEN}>{modeControl}</div> : modeControl
      ) : (
        <div className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2', boardOpen && SHORT_PANEL_HIDDEN)}>{modeControl}{recipeChip}{usageChip}{contextChip}</div>
      )}
      {boardOpen ? <div className={SHORT_PANEL_HIDDEN}>{strip}</div> : strip}
    </div>
  );
}
