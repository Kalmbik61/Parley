/** Карточка доски: заголовок, чип проекта, цель для «в работе» и «на проверке». */
import { S } from '../../shared/strings.js';
import { Badge } from '../ui/badge.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { relativeTimeAgo } from '../lib/relative-time.js';
import type { BoardCard } from './board-model.js';
import type { BoardBridge } from './board-store.js';
import type { TargetInfo } from './target-info.js';

export interface BoardCardViewProps { bridge: BoardBridge; card: BoardCard; target: TargetInfo | null; onOpen(card: BoardCard): void }

export function BoardCardView({ card, target, onOpen }: BoardCardViewProps): JSX.Element {
  const { item, project, state } = card;
  const now = new Date();
  const showTarget = state === 'in-progress' || state === 'review';
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-card p-2.5 text-sm" data-board-card={item.id ?? undefined}>
      <button type="button" className="line-clamp-2 min-w-0 text-left font-medium [overflow-wrap:anywhere]" onClick={() => onOpen(card)}>
        {item.title}
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Badge className="max-w-full truncate">{project.title}</Badge>
        {item.by !== undefined && <span className="text-[11px] text-muted-foreground">{S.board.agent}</span>}
        {item.section !== null && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{item.section}</span>}
      </div>
      {/* Цель не нашлась (сессии или комнаты уже нет в работах) — та же пометка, что у закрытой. */}
      {showTarget && (target !== null || item.taken !== undefined) && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {target === null || target.gone ? (
            <span className="min-w-0 truncate">{S.board.targetGone}</span>
          ) : (
            <>
              <button type="button" className="min-w-0 truncate text-left underline-offset-2 hover:underline" onClick={() => applyFocusTarget(target.focus, buildFocusTargetDeps())}>
                {target.label}
              </button>
              {target.word !== '' && <span className="shrink-0">{target.word}</span>}
            </>
          )}
        </div>
      )}
      {state === 'review' && item.review !== undefined && <div className="text-xs text-muted-foreground">{S.board.reported(relativeTimeAgo(item.review, now))}</div>}
      {state === 'done' && item.done !== undefined && <div className="text-xs text-muted-foreground">{S.board.doneOn(item.done)}</div>}
    </li>
  );
}
