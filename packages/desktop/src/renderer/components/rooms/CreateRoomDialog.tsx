/**
 * «Создать комнату с…» из меню сессии (кусок 3.6 плана окна, спека 5.1, 6.2):
 * название и выбор остальных участников → `rooms.create`. Сессия, с которой
 * открыли пункт меню, — обязательный участник и снята с выбора (её и так
 * убирать некуда, комната без неё не тот пункт меню, который нажали).
 * Создатель всегда `human` — комнату через окно заводит человек, а не агент
 * (спека 6.2 — `create_room` для агентов остаётся MCP-инструментом).
 */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { HarnasBridge } from '../../../shared/bridge.js';

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--h-base)] p-4 text-[var(--h-text)] shadow-lg">
          <Dialog.Title className="text-sm font-medium">Создать комнату с {requiredMember.label}</Dialog.Title>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              Название
              <input
                className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {candidates.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-[var(--h-muted)]">Ещё участники</span>
                <div className="flex flex-wrap gap-3 text-xs">
                  {candidates.map((candidate) => (
                    <label key={candidate.id} className={`flex items-center gap-1 ${candidate.closed ? 'opacity-50' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(candidate.id)}
                        disabled={candidate.closed}
                        onChange={() => toggle(candidate)}
                      />
                      {candidate.label}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            {error !== null ? <p className="text-[var(--h-red)]">{error}</p> : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="rounded px-3 py-1 text-[var(--h-subtext)]">
                Отмена
              </button>
            </Dialog.Close>
            <button type="button" className="rounded bg-[var(--h-blue)] px-3 py-1 text-[var(--h-base)]" onClick={() => void submit()}>
              Создать
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
