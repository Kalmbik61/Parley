/**
 * Лента участников комнаты (спека окна 2026-09-29, 1.3): горизонтальная прокрутка, карточка 230px,
 * радиус 14, padding `9 12`. Строка 1 (12px): значок состояния, значок агента 14, `S02 бэкенд` (600),
 * `★` у ведущего, слово состояния 11px; в тесной строке сжимается чип роли (`RoleChip`), имя — не уже `5ch`
 * (номер сессии `S02…`), `★` и слово состояния — целиком; строка 2 — чем занят участник (`doing`: субагенты, ожидание
 * `wait_for`), а когда ничем, — задача, 12px в одну строку; подсказка строки — `doingDetail`. Фон по состоянию:
 * `blocked` — `accent-200`, `unseen` — `accent-2-200`, иначе `currentColor 6%`; наведение — рамка внутри
 * `currentColor 28%`. Тултип — `Claude Code · Opus 5.5`: провайдер и модель из живых метрик, а пока
 * модель неизвестна — один провайдер; усилие не показывается, его никто не хранит. Клик открывает терминал
 * участника.
 *
 * Строка субагентов («Subagent: …», «3 subagents: …») — бейдж с поповером (`AgentsBadge`, кусок 4b плана 2026-10-01):
 * клик по агенту в поповере открывает сессию участника на карточке этого агента (`onOpenSession` вторым аргументом).
 * Кнопку в кнопку не вложить, поэтому у такой карточки кнопка открытия — только первая строка, а вторая — бейдж; у
 * остальных карточка по-прежнему одна кнопка на обе строки. Сама карточка — блок: фон, рамка наведения и тултип у него.
 */

import { S } from '../../../shared/strings.js';
import { RoleChip } from '../../lib/role-summary.js';
import { cn } from '../../lib/cn.js';
import { AgentIcon } from '../AgentIcon.js';
import { AgentsBadge } from '../AgentsBadge.js';
import { AgentStateDot } from '../AgentStateDot.js';
import type { ParticipantModel } from './feed-model.js';

export interface ParticipantStripProps {
  participants: readonly ParticipantModel[];
  /** Клик по карточке — открыть сессию; по агенту в поповере — открыть её на карточке этого агента (`agentId`). */
  onOpenSession: (sessionId: string, agentId?: string) => void;
}

export function ParticipantStrip({ participants, onOpenSession }: ParticipantStripProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label={S.rooms.participants}
      data-participant-strip=""
      className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
    >
      {participants.map((participant) => {
        const open = (): void => onOpenSession(participant.id);
        const header = (
          <span className="flex items-center gap-1.5 text-xs">
            <AgentStateDot state={participant.state} lifecycle={participant.lifecycle} />
            <AgentIcon provider={participant.provider} size={14} />
            <span className="min-w-[5ch] flex-1 truncate font-semibold">{participant.label}</span>
            <RoleChip {...(participant.roleRevision ? { revision: participant.roleRevision } : {})} role={participant.role} {...(participant.sessionRef ? { sessionRef: participant.sessionRef } : {})} />
            {participant.lead ? (
              <span title={S.rooms.lead} className="shrink-0 text-accent-700">
                ★
              </span>
            ) : null}
            <span
              className={cn(
                'shrink-0 text-[11px]',
                participant.attention === 'needs-you'
                  ? 'text-accent-800'
                  : participant.attention === 'unseen'
                    ? 'text-accent-2-800'
                    : 'text-neutral-700',
              )}
            >
              {participant.word}
            </span>
          </span>
        );
        return (
          <div
            key={participant.id}
            data-participant={participant.id}
            title={S.rooms.participantTooltip(participant.providerName, participant.model)}
            className={cn(
              'flex w-[230px] shrink-0 flex-col rounded-[14px] text-foreground hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_28%,transparent)]',
              participant.attention === 'needs-you'
                ? 'bg-accent-200'
                : participant.attention === 'unseen'
                  ? 'bg-accent-2-200'
                  : 'bg-[color-mix(in_srgb,currentColor_6%,transparent)]',
            )}
          >
            {participant.agents.length > 0 && participant.doing !== null ? (
              <>
                <button type="button" onClick={open} className="flex w-full flex-col rounded-t-[14px] px-3 pt-[9px] text-left">
                  {header}
                </button>
                <AgentsBadge
                  tasks={participant.agents}
                  label={participant.doing}
                  {...(participant.doingDetail === null ? {} : { title: participant.doingDetail })}
                  onOpen={(task) => onOpenSession(participant.id, task.id)}
                  className="mx-3 mb-[9px] mt-1 min-h-4 truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
                />
              </>
            ) : (
              <button type="button" onClick={open} className="flex w-full flex-col gap-1 rounded-[14px] px-3 py-[9px] text-left">
                {header}
                <span
                  title={participant.doing === null ? undefined : (participant.doingDetail ?? undefined)}
                  className="min-h-4 truncate text-xs text-muted-foreground"
                >
                  {participant.doing ?? participant.task}
                </span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
