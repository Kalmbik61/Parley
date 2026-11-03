/** Карточка доски: заголовок, чип проекта, цель для «в работе» и «на проверке». */
import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { MoreHorizontal } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Textarea } from '../ui/textarea.js';
import { useWorksStore } from '../store/works.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { dndId, type DragSourceData } from '../layout/dnd.js';
import { relativeTimeAgo } from '../lib/relative-time.js';
import { moveCard, returnCard } from './board-actions.js';
import { cardKey, resolveTaken } from './board-model.js';
import type { BoardCard } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';
import { SendToMenu } from './SendToMenu.js';
import type { TargetInfo } from './target-info.js';

export interface BoardCardViewProps { bridge: BoardBridge; card: BoardCard; target: TargetInfo | null; onOpen(card: BoardCard): void }

export function BoardCardView({ bridge, card, target, onOpen }: BoardCardViewProps): JSX.Element {
  const { item, project, state } = card;
  const now = new Date();
  const showTarget = state === 'in-progress' || state === 'review';
  const entries = useWorksStore(s => s.entries);
  const sendingTo = useBoardStore(s => s.sending.get(cardKey(card)));
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const taken = resolveTaken(item.taken, project, entries);
  // Цель пропала посреди Return…: поле уходит вместе с ней, Accept и Return… возвращаются на карточку.
  if (returning && taken === null) { setReturning(false); setNote(''); }
  const gone = target === null || target.gone;
  const targetLost = showTarget && (target !== null || item.taken !== undefined) && gone;
  const returnDisabled = taken === null || gone;
  // Тянуть можно только карточки Backlog, не ждущие отправки; порог PointerSensor сохраняет обычный клик.
  const data: DragSourceData = { item: { kind: 'card', projectPath: project.projectPath, id: item.id ?? null, index: card.index, title: item.title } };
  const { setNodeRef, listeners } = useDraggable({ id: dndId.card(cardKey(card)), data, disabled: state !== 'backlog' || sendingTo !== undefined });
  const toBacklog = (): void => { void moveCard(bridge, card, 'backlog'); };
  return (
    <li ref={setNodeRef} {...listeners} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-card p-2.5 text-sm" data-board-card={item.id ?? undefined}>
      <div className="flex min-w-0 items-start gap-1">
        <button type="button" className="line-clamp-2 min-w-0 flex-1 text-left font-medium [overflow-wrap:anywhere]" onClick={() => onOpen(card)}>
          {item.title}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={S.board.cardMenu} title={S.board.cardMenu}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10">
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {state === 'backlog' && <DropdownMenuItem data-card-action="done" onSelect={() => { void moveCard(bridge, card, 'done'); }}>{S.board.markDone}</DropdownMenuItem>}
            {state === 'in-progress' && <DropdownMenuItem data-card-action="review" onSelect={() => { void moveCard(bridge, card, 'review'); }}>{S.board.moveToReview}</DropdownMenuItem>}
            {state !== 'backlog' && <DropdownMenuItem data-card-action="backlog" onSelect={toBacklog}>{S.board.backToBacklog}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
      {state === 'backlog' && sendingTo !== undefined && <div className="min-w-0 truncate text-xs text-muted-foreground" data-board-sending="">{S.board.sending(sendingTo)}</div>}
      {state === 'backlog' && <div><SendToMenu bridge={bridge} card={card} /></div>}
      {state === 'in-progress' && targetLost && (
        <div><Button type="button" size="sm" variant="outline" data-card-action="back-visible" onClick={toBacklog}>{S.board.backToBacklog}</Button></div>
      )}
      {state === 'review' && !returning && (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" data-card-action="accept" onClick={() => { void moveCard(bridge, card, 'done'); }}>{S.board.accept}</Button>
          <Button type="button" size="sm" variant="outline" data-card-action="return" disabled={returnDisabled}
            {...(returnDisabled ? { title: S.board.targetGone } : null)} onClick={() => setReturning(true)}>{S.board.return}</Button>
        </div>
      )}
      {state === 'review' && returning && taken !== null && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Textarea value={note} rows={3} placeholder={S.board.returnNote} aria-label={S.board.returnNote} onChange={event => setNote(event.target.value)} />
          <div className="flex gap-1.5">
            <Button type="button" size="sm" data-card-action="return-send" disabled={note.trim() === ''}
              onClick={() => { void returnCard(bridge, card, taken, note); }}>{S.board.returnSend}</Button>
            <Button type="button" size="sm" variant="outline" data-card-action="return-cancel" onClick={() => { setReturning(false); setNote(''); }}>{S.board.cancel}</Button>
          </div>
        </div>
      )}
      {state === 'review' && item.review !== undefined && <div className="text-xs text-muted-foreground">{S.board.reported(relativeTimeAgo(item.review, now))}</div>}
      {state === 'done' && item.done !== undefined && <div className="text-xs text-muted-foreground">{S.board.doneOn(item.done)}</div>}
    </li>
  );
}
