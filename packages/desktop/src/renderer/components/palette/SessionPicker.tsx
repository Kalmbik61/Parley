/**
 * ⌘D/⇧⌘D (кусок 2.1 плана окна): список сессий ТЕКУЩЕЙ работы, у которых ещё
 * нет панели в сетке — выбранная встаёт справа/снизу от активной панели
 * (`Workspace.tsx`). Полноценная палитра команд ⌘K — кусок 2.3, тут только
 * список сессий одной работы, без нечёткого поиска.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { panelId, workKey } from '../../lib/panel-id.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { treeOrder } from '../../lib/tree-order.js';

export interface SessionCandidate {
  ref: SessionRef;
  label: string;
}

/** Сессии работы без открытой панели — `openPanelIds` берётся из `api.panels` (тест 5). */
export function sessionCandidates(entry: WorkEntry, openPanelIds: ReadonlySet<string>): SessionCandidate[] {
  const key = workKey(entry.projectPath, entry.map.work.id);
  return treeOrder(entry.map.sessions)
    .map(({ session }): SessionCandidate & { id: string } => {
      const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
      return { ref, label: sessionRowLabel(session.id, session.label), id: panelId({ kind: 'terminal', ref, workKey: key }) };
    })
    .filter((candidate) => !openPanelIds.has(candidate.id))
    .map(({ ref, label }) => ({ ref, label }));
}

export interface SessionPickerProps {
  open: boolean;
  candidates: readonly SessionCandidate[];
  onSelect: (ref: SessionRef) => void;
  onOpenChange: (open: boolean) => void;
}

export function SessionPicker({ open, candidates, onSelect, onOpenChange }: SessionPickerProps): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-card p-2 text-foreground shadow-lg">
          <Dialog.Title className="px-2 py-1 text-sm font-medium">Сессия в новую панель</Dialog.Title>
          {candidates.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">У этой работы нет сессий без панели</p>
          ) : (
            <ul className="flex flex-col">
              {candidates.map((candidate) => (
                <li key={candidate.ref.sessionId}>
                  <button
                    type="button"
                    className="w-full cursor-default rounded px-2 py-1 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={() => onSelect(candidate.ref)}
                  >
                    {candidate.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
