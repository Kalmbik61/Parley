/** Открытая карточка: заголовок, детали, проект, источник и история; правка, удаление и перенос в другой проект. */
import { useState } from 'react';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { relativeTimeAgo } from '../lib/relative-time.js';
import { deleteCard, editCard, moveCardToProject } from './board-actions.js';
import { cardKey } from './board-model.js';
import type { BoardCard } from './board-model.js';
import { useBoardProjects, useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';
import type { TargetInfo } from './target-info.js';

export interface CardDialogProps { bridge: BoardBridge; card: BoardCard | null; target: TargetInfo | null; onClose(): void }

export function CardDialog({ bridge, card, target, onClose }: CardDialogProps): JSX.Element {
  const now = new Date();
  const projects = useBoardProjects();
  const inboxPath = useBoardStore(state => state.inboxPath);
  const [editing, setEditing] = useState<{ title: string; details: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reset = (): void => { setEditing(null); setConfirmDelete(false); };
  // Правка и подтверждение удаления принадлежат своей карточке: другая (или никакая) их не наследует.
  const key = card === null ? null : cardKey(card);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) { setShownKey(key); reset(); }
  // Все пути закрытия идут через `close`, иначе форма прежней карточки переживёт закрытие.
  const close = (): void => { reset(); onClose(); };
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
    <Dialog open={card !== null} onOpenChange={open => { if (!open) close(); }}>
      {card !== null && item !== undefined && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{item.title}</DialogTitle>
            <DialogDescription>{card.project.title} · {item.by !== undefined ? S.board.byAgent(item.by) : S.board.byHuman}</DialogDescription>
          </DialogHeader>
          {editing !== null ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">{S.board.taskField}
                <Input value={editing.title} data-card-field="title" onChange={event => setEditing({ ...editing, title: event.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">{S.board.detailsField}
                <Textarea value={editing.details} rows={4} data-card-field="details" onChange={event => setEditing({ ...editing, details: event.target.value })} />
              </label>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" data-card-action="edit-cancel" onClick={() => setEditing(null)}>{S.board.cancel}</Button>
                <Button type="button" size="sm" data-card-action="edit-save" disabled={editing.title.trim() === ''}
                  onClick={() => {
                    const patch: { title?: string; details?: string } = {};
                    if (editing.title.trim() !== item.title) patch.title = editing.title.trim();
                    if (editing.details !== item.details) patch.details = editing.details;
                    setEditing(null);
                    if (Object.keys(patch).length > 0) void editCard(bridge, card, patch);
                  }}>{S.board.save}</Button>
              </div>
            </div>
          ) : item.details !== '' && <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{item.details}</p>}
          {history.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted-foreground">{S.board.history}</h4>
              <ul className="flex flex-col gap-0.5 text-sm">
                {history.map(line => <li key={line} className="[overflow-wrap:anywhere]">{line}</li>)}
              </ul>
            </div>
          )}
          {card.state === 'backlog' && (
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">{S.board.moveProject}
              <select value="" data-card-field="project" className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                onChange={event => {
                  const path = event.target.value;
                  if (path === '') return;
                  close();
                  void moveCardToProject(bridge, card, path);
                }}>
                <option value="">{S.board.projectField}</option>
                {projects.filter(project => project.key !== card.project.key && !project.inbox).map(project => (
                  <option key={project.key} value={project.projectPath}>{project.title}</option>
                ))}
                {!card.project.inbox && inboxPath !== null && <option value={inboxPath}>{S.board.noProject}</option>}
              </select>
            </label>
          )}
          <DialogFooter>
            {confirmDelete ? (
              <>
                <span className="self-center text-sm">{S.board.deleteConfirm}</span>
                <Button type="button" variant="outline" size="sm" data-card-action="delete-cancel" onClick={() => setConfirmDelete(false)}>{S.board.cancel}</Button>
                <Button type="button" variant="destructive" size="sm" data-card-action="delete-confirm"
                  onClick={() => { close(); void deleteCard(bridge, card); }}>{S.board.delete}</Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="sm" data-card-action="edit" disabled={editing !== null}
                  onClick={() => setEditing({ title: item.title, details: item.details })}>{S.board.edit}</Button>
                <Button type="button" variant="outline" size="sm" data-card-action="delete" onClick={() => setConfirmDelete(true)}>{S.board.delete}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
