/**
 * Шапка вкладки комнаты (спека окна 2026-09-29, 1.3): название — Caprasimo 25px/1.12, подзаголовок 13px
 * вторичным цветом (`Created by you · 4 agents · lead S01 · {работа}`), ниже лента участников; снизу
 * линия 1px `currentColor 12%`. Название и подзаголовок — в одну строку с многоточием и полным текстом в
 * тултипе: название в 120 знаков в невысоком окне иначе съело бы ленту.
 */

import type { ParticipantModel } from './feed-model.js';
import { ParticipantStrip } from './ParticipantStrip.js';

export interface RoomHeaderProps {
  title: string;
  subtitle: string;
  participants: readonly ParticipantModel[];
  onOpenSession: (sessionId: string, agentId?: string) => void;
}

export function RoomHeader({ title, subtitle, participants, onOpenSession }: RoomHeaderProps): JSX.Element {
  return (
    <div
      data-room-header=""
      className="flex shrink-0 flex-col gap-3 border-b border-[color-mix(in_srgb,currentColor_12%,transparent)] px-9 pb-3.5 pt-6"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 title={title} className="m-0 truncate font-heading text-[25px] leading-[1.12] tracking-[-0.015em]">
          {title}
        </h3>
        <span title={subtitle} className="truncate text-[13px] text-muted-foreground">
          {subtitle}
        </span>
      </div>
      <ParticipantStrip participants={participants} onOpenSession={onOpenSession} />
    </div>
  );
}
