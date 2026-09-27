/**
 * ⌘D/⇧⌘D (кусок 2.1 плана окна, сигнатура — кусок 2.3): список сессий
 * ТЕКУЩЕЙ работы, у которых ещё нет открытого терминала — выбранная встаёт
 * справа/снизу от активной панели (`Workspace.tsx#openBeside`, `AppShell.tsx`).
 * Полноценная палитра команд ⌘K — кусок 2.3, тут только список сессий одной
 * работы, без нечёткого поиска.
 *
 * `openSessionIds` — id САМИХ СЕССИЙ, не id панелей dockview: `lib/panel-id.ts`
 * этому компоненту с куска 2.3 не нужен (он живёт до 2.7, ради него отдельную
 * зависимость заводить незачем) — `Workspace.tsx` сам знает, что панель у
 * терминала. Файл живёт до 6.2 (полноценная палитра ⌘K).
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { S } from '../../../shared/strings.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { treeOrder } from '../../lib/tree-order.js';

export interface SessionCandidate {
  ref: SessionRef;
  label: string;
}

/** Сессии работы, которых нет в `openSessionIds` (тест 12). */
export function sessionCandidates(entry: WorkEntry, openSessionIds: ReadonlySet<string>): SessionCandidate[] {
  return treeOrder(entry.map.sessions)
    .filter(({ session }) => !openSessionIds.has(session.id))
    .map(({ session }): SessionCandidate => ({
      ref: { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id },
      label: sessionRowLabel(session.id, session.label),
    }));
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
          <Dialog.Title className="px-2 py-1 text-sm font-medium">{S.picker.title}</Dialog.Title>
          {candidates.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">{S.picker.empty}</p>
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
