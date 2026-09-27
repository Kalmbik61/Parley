/**
 * «Создать комнату с…» из меню сессии (кусок 3.6 плана окна, спека 5.1, 6.2):
 * название и выбор остальных участников → `rooms.create`. Сессия, с которой
 * открыли пункт меню, — обязательный участник и снята с выбора (её и так
 * убирать некуда, комната без неё не тот пункт меню, который нажали).
 * Создатель всегда `human` — комнату через окно заводит человек, а не агент
 * (спека 6.2 — `create_room` для агентов остаётся MCP-инструментом).
 *
 * Кусок 1.4 плана «облик Orca»: примитивы `ui/dialog`, `ui/input`,
 * `ui/checkbox`, `ui/button` вместо голого Radix и токенов старой палитры —
 * список остальных участников многовыборный (не вкл/выкл одной настройки),
 * поэтому флажок, а не `ui/switch` (как у одиночных булевых полей диалогов).
 */

import { useEffect, useState } from 'react';
import type { HarnasBridge } from '../../../shared/bridge.js';
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
  /** Сессия, с которой вызвали «Создать комнату с…» — обязательный участник. */
  requiredMember: { id: string; label: string };
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
      setError('нужно название');
      return;
    }
    try {
      await bridge.call('rooms.create', {
        projectPath,
        workId,
        title: trimmed,
        members: [requiredMember.id, ...selected],
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-96 max-w-96">
        <DialogTitle>Создать комнату с {requiredMember.label}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Название
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          {candidates.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Ещё участники</span>
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
              Отмена
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void submit()}>
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
