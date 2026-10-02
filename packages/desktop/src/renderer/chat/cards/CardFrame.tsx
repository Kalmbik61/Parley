/**
 * Общая рамка карточки разрешения, вопроса и плана (план 2026-10-01, решение 3, кусок 4a): иконка, имя,
 * сводка одной строкой, тело и строка состояния. Ждущая карточка — с жёлтой рамкой. `data-testid`,
 * `data-card-kind` и `data-card-state` на корне — за них держатся тесты и e2e.
 */

import type { ReactNode } from 'react';
import { ClipboardList, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import type { FeedCard } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { firstLine, toolHeadline } from '../feed-model.js';

function summaryOf(card: FeedCard): string | null {
  switch (card.kind) {
    case 'permission':
      return toolHeadline(card.toolName, card.toolInput).summary;
    case 'question':
      return card.questions[0]?.question ?? null;
    case 'plan':
      return firstLine(card.plan);
  }
}

const ICONS = { permission: ShieldQuestion, question: MessageCircleQuestion, plan: ClipboardList } as const;

export interface CardFrameProps {
  item: FeedCard;
  /** Строка состояния под заголовком; `null` — не нужна (у ждущей карточки её роль играют кнопки). */
  status: string | null;
  children?: ReactNode;
}

export function CardFrame({ item, status, children }: CardFrameProps): JSX.Element {
  const Icon = ICONS[item.kind];
  const pending = item.state === 'pending';
  const name = item.kind === 'permission' ? toolHeadline(item.toolName, item.toolInput).name : S.chat.cardKind[item.kind];
  const summary = summaryOf(item);
  return (
    <div
      data-testid="chat-card"
      data-card-kind={item.kind}
      data-card-state={item.state}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2 text-sm',
        pending ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]' : 'border-border',
      )}
    >
      <div className="flex min-w-0 items-center gap-2" title={summary ?? name}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="max-w-[45%] shrink-0 truncate font-mono font-semibold">{name}</span>
        {summary === null ? null : <span data-card-summary="" className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{summary}</span>}
      </div>
      {children === undefined ? null : <div className="flex min-w-0 flex-col gap-2 pl-6">{children}</div>}
      {status === null ? null : (
        <span className={cn('pl-6 text-xs [overflow-wrap:anywhere]', pending ? 'font-semibold text-[var(--status-warning-text)]' : 'text-muted-foreground')}>
          {status}
        </span>
      )}
    </div>
  );
}
