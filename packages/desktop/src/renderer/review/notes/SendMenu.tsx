/**
 * Меню получателя отправки агенту (кусок 8.4b, спека 11.4; его же берёт Design Mode — 9.3b, спека
 * 12.3). Сделано в 9.3b раньше этапа 8 по решению контролёра, пропы — `SendMenuProps` плана 8.
 *
 * Кнопка из двух частей: подпись шлёт сессии по умолчанию (её ярлык виден на самой кнопке —
 * человек видит, кому уходит текст), «▾» открывает сессии работы: точка состояния, ярлык и время
 * последней активности. Сессии без живого процесса (`lifecycle` не `active`) неактивны с подписью
 * «not running»: `pty.send` им ответил бы `not_found`. Ни монтирование, ни открытие меню ничего не
 * шлют — `onSend` зовёт только нажатие человека (спека 15.1, п. 9).
 */

import { Check, ChevronDown } from 'lucide-react';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { S } from '../../../shared/strings.js';
import { AgentStateDot } from '../../components/AgentStateDot.js';
import { cn } from '../../lib/cn.js';
import { displayStatus, dotState } from '../../lib/dot-state.js';
import { sessionRowLabel, sessionTag } from '../../lib/participant.js';
import { relativeTime } from '../../lib/relative-time.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../ui/dropdown-menu.js';

export interface SendMenuProps {
  entry: WorkEntry; // сессии работы: AgentStateDot, ярлык, время последней активности
  defaultSessionId: string | null; // по умолчанию — сессия диффа
  label: string; // подпись кнопки: S.common.send, S.notes.sendFile…
  disabled?: boolean;
  onSend(sessionId: string): void; // выбран получатель — отправка
}

function isLive(session: WorkSession): boolean {
  return session.lifecycle === 'active';
}

const PART =
  'flex h-6 shrink-0 items-center gap-1 border border-border bg-background px-2 text-xs text-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40';

export function SendMenu({ entry, defaultSessionId, label, disabled = false, onSend }: SendMenuProps): JSX.Element {
  const byRef = useActivityStore((state) => state.byRef);
  const sessions = entry.map.sessions;
  const fallback = sessions.find((session) => session.id === defaultSessionId) ?? null;
  const canSendDefault = !disabled && fallback !== null && isLive(fallback);
  const now = new Date();

  return (
    <div className="flex min-w-0 items-center">
      <button
        type="button"
        disabled={!canSendDefault}
        onClick={() => {
          if (fallback !== null && canSendDefault) onSend(fallback.id);
        }}
        className={cn(PART, 'min-w-0 rounded-l-md')}
      >
        <span className="truncate">{label}</span>{' '}
        {fallback !== null ? <span className="shrink-0 text-muted-foreground">{sessionTag(fallback.id)}</span> : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button type="button" aria-label={S.notes.chooseRecipient} title={S.notes.chooseRecipient} className={cn(PART, '-ml-px rounded-r-md px-1')}>
            <ChevronDown className="size-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-72 max-w-[calc(100vw-32px)] overflow-y-auto">
          {sessions.map((session) => {
            const live = isLive(session);
            const activity = activityFor(byRef, { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
            const lastEventAt = activity?.activity.lastEventAt ?? session.resultAt ?? session.startedAt;
            return (
              <DropdownMenuItem
                key={session.id}
                data-session-id={session.id}
                {...(session.id === defaultSessionId ? { 'data-default': '' } : {})}
                disabled={!live}
                onSelect={() => {
                  if (live) onSend(session.id);
                }}
                className="gap-2 text-xs"
              >
                <Check className={cn('size-3 shrink-0', session.id === defaultSessionId ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <AgentStateDot state={dotState(displayStatus(session), activity?.activity.activity ?? null)} lifecycle={session.lifecycle} size="sm" />
                <span className="min-w-0 flex-1 truncate">{sessionRowLabel(session.id, session.label)}</span>
                {live ? (
                  lastEventAt === null ? null : (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{relativeTime(lastEventAt, now)}</span>
                  )
                ) : (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{S.notes.notRunning}</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
