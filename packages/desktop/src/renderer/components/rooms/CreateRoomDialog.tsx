/**
 * «Создать комнату с…» из меню сессии (кусок 3.6 плана окна, спека 5.1, 6.2):
 * название и выбор остальных участников → `rooms.create`. Сессия, с которой
 * открыли пункт меню, — обязательный участник и снята с выбора (её и так
 * убирать некуда, комната без неё не тот пункт меню, который нажали).
 * Создатель всегда `human` — комнату через окно заводит человек, а не агент
 * (спека 6.2 — `create_room` для агентов остаётся MCP-инструментом).
 *
 * Кусок 3.4 (спека 6.4): «New room» из меню карточки открывает тот же диалог без
 * обязательного участника (`requiredMember: null`) — заголовок «New room», и «Create»
 * доступна, только когда выбран хотя бы один участник.
 *
 * Кусок 1.4 плана «облик Orca»: примитивы `ui/dialog`, `ui/input`,
 * `ui/checkbox`, `ui/button` вместо голого Radix и токенов старой палитры —
 * список остальных участников многовыборный (не вкл/выкл одной настройки),
 * поэтому флажок, а не `ui/switch` (как у одиночных булевых полей диалогов).
 */

import { useEffect, useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';

export interface RoomCandidate {
  id: string;
  label: string;
  closed: boolean;
}

export interface CreateRoomDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  projectPath: string;
  workId: string;
  /** Сессия, с которой вызвали «Создать комнату с…» — обязательный участник; `null` — из меню карточки. */
  requiredMember: { id: string; label: string } | null;
  /** Остальные сессии работы — необязательные участники; закрытые недоступны. */
  candidates: RoomCandidate[];
  onOpenChange: (open: boolean) => void;
}

export function CreateRoomDialog({
  open,
  bridge,
  projectPath,
  workId,
  requiredMember,
  candidates,
  onOpenChange,
}: CreateRoomDialogProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setSelected(new Set());
    setError(null);
  }, [open]);

  const toggle = (candidate: RoomCandidate): void => {
    if (candidate.closed) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.add(candidate.id);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed === '') {
      setError(S.rooms.nameRequired);
      return;
    }
    try {
      await bridge.call('rooms.create', {
        projectPath,
        workId,
        title: trimmed,
        members: requiredMember === null ? [...selected] : [requiredMember.id, ...selected],
      });
      onOpenChange(false);
    } catch (err) {
      console.warn('[harnas] rooms.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createRoom));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>{requiredMember === null ? S.rooms.newRoomTitle : S.rooms.createTitle(requiredMember.label)}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            {S.rooms.nameField}
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          {candidates.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{S.rooms.moreParticipants}</span>
              <div className="flex flex-wrap gap-3 text-xs">
                {candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className={`flex items-center gap-1.5 ${candidate.closed ? 'opacity-50' : ''}`}
                  >
                    <Checkbox
                      checked={selected.has(candidate.id)}
                      disabled={candidate.closed}
                      onCheckedChange={() => toggle(candidate)}
                    />
                    {candidate.label}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={requiredMember === null && selected.size === 0} onClick={() => void submit()}>
            {S.common.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
