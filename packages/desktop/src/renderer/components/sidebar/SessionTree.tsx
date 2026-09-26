/** Дерево сессий одной работы: порядок и вложенность — из `lib/tree-order.ts`. */

import type { WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { dotState, STATE_WORDS } from '../../lib/dot-state.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { treeOrder } from '../../lib/tree-order.js';
import type { ActivityEntry } from '../../store/activity.js';
import { activityFor } from '../../store/activity.js';
import { MetricsLine } from './MetricsLine.js';
import { SessionMenu } from './SessionMenu.js';
import { StatusDot } from './StatusDot.js';

export interface SessionTreeProps {
  projectPath: string;
  workId: string;
  sessions: readonly WorkSession[];
  selectedSessionId: string | null;
  activityByRef: Record<string, ActivityEntry>;
  onSelect: (session: WorkSession) => void;
  onOpen: (session: WorkSession) => void;
  onResume: (session: WorkSession) => void;
  onStop: (session: WorkSession) => void;
  onDelete: (session: WorkSession) => void;
}

export function SessionTree({
  projectPath,
  workId,
  sessions,
  selectedSessionId,
  activityByRef,
  onSelect,
  onOpen,
  onResume,
  onStop,
  onDelete,
}: SessionTreeProps): JSX.Element {
  return (
    <div>
      {treeOrder(sessions).map(({ session, depth }) => {
        const ref: SessionRef = { projectPath, workId, sessionId: session.id };
        const entry = activityFor(activityByRef, ref);
        const state = dotState(session.status, entry?.activity.activity ?? null);
        const selected = session.id === selectedSessionId;
        const label = sessionRowLabel(session.id, session.label);

        return (
          <div key={session.id}>
            <SessionMenu
              status={session.status}
              label={label}
              onOpen={() => onOpen(session)}
              onResume={() => onResume(session)}
              onStop={() => onStop(session)}
              onDelete={() => onDelete(session)}
            >
              <div
                role="button"
                tabIndex={0}
                data-session-id={session.id}
                data-selected={selected}
                onClick={() => onSelect(session)}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                className={`flex min-w-0 cursor-default items-center gap-2 rounded px-2 py-1 text-sm ${
                  selected ? 'bg-[var(--h-selection)] text-[var(--h-text)]' : 'text-[var(--h-subtext)] hover:bg-[var(--h-surface)]'
                }`}
              >
                <StatusDot state={state} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 truncate text-xs text-[var(--h-muted)]">{STATE_WORDS[state]}</span>
              </div>
            </SessionMenu>
            {selected ? <MetricsLine metrics={entry?.metrics ?? null} /> : null}
          </div>
        );
      })}
    </div>
  );
}
