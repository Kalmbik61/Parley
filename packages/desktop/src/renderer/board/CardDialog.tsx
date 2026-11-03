/** Открытая карточка: только чтение — заголовок, детали, проект, источник и история. */
import { S } from '../../shared/strings.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { relativeTimeAgo } from '../lib/relative-time.js';
import type { BoardCard } from './board-model.js';
import type { BoardBridge } from './board-store.js';
import type { TargetInfo } from './target-info.js';

export interface CardDialogProps { bridge: BoardBridge; card: BoardCard | null; target: TargetInfo | null; onClose(): void }

export function CardDialog({ card, target, onClose }: CardDialogProps): JSX.Element {
  const now = new Date();
  const item = card?.item;
  // Цели нет среди работ — в истории остаётся номер, куда ушла карточка (`taken`).
  const sentLabel = target?.label ?? item?.taken;
  const history: string[] = [];
  if (item !== undefined) {
    if (item.created !== undefined) history.push(S.board.created(relativeTimeAgo(item.created, now)));
    if (item.sent !== undefined && sentLabel !== undefined) history.push(S.board.sentTo(sentLabel, relativeTimeAgo(item.sent, now)));
    if (item.review !== undefined) history.push(S.board.reviewAt(relativeTimeAgo(item.review, now)));
    if (item.done !== undefined) history.push(S.board.doneOn(item.done));
  }
  return (
    <Dialog open={card !== null} onOpenChange={open => { if (!open) onClose(); }}>
      {card !== null && item !== undefined && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{item.title}</DialogTitle>
            <DialogDescription>{card.project.title} · {item.by !== undefined ? S.board.byAgent(item.by) : S.board.byHuman}</DialogDescription>
          </DialogHeader>
          {item.details !== '' && <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.details}</p>}
          {history.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted-foreground">{S.board.history}</h4>
              <ul className="flex flex-col gap-0.5 text-sm">
                {history.map(line => <li key={line} className="[overflow-wrap:anywhere]">{line}</li>)}
              </ul>
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
