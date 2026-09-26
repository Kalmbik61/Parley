/**
 * Дерево сессий одной работы: порядок и вложенность — из `lib/tree-order.ts`.
 * Строки перетаскиваются в сетку (кусок 2.1 плана окна): `dragPayload` кладёт
 * адрес сессии под свой MIME, `Workspace.tsx` читает его в `onDidDrop`.
 *
 * Строка «вся почта работы» (кусок 2.4) стоит здесь, а не в `WorkList.tsx`,
 * хотя она не про сессию: `SessionTree` уже вызывается ровно один раз на
 * работу (план куска называет именно этот файл), и `hasMail` — то же самое
 * булево на работу, что и остальные пропсы этого компонента.
 *
 * Комнаты (кусок 3.6 плана окна, спека 5.1, тест 1): комната, которую завела
 * сессия, стоит сразу под её строкой; комната человека — прямо под работой,
 * тем же уровнем, что и «вся почта работы» (строка человека рисуется первой,
 * до дерева сессий, — так же, как «вся почта работы» до куска 3.6). Закрытая
 * сессия (`lifecycle === 'closed'`) — тусклая, слово состояния заменяется на
 * «закрыта»: `displayStatus` этого не различает, он сворачивает `closed` в
 * `exited`/`done`/`failed` того же вида, что и у спящей без итога
 * (`lib/dot-state.ts`), а в дереве это два разных состояния сессии.
 */

import type { Room, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { displayStatus, dotState, STATE_WORDS } from '../../lib/dot-state.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { treeOrder, workKey } from '../../lib/tree-order.js';
import type { ActivityEntry } from '../../store/activity.js';
import { activityFor } from '../../store/activity.js';
import { DRAG_MIME, dragPayload } from '../layout/sidebar-drag.js';
import { MetricsLine } from './MetricsLine.js';
import { SessionMenu } from './SessionMenu.js';
import { StatusDot } from './StatusDot.js';

const HUMAN = 'human';

interface RoomRowProps {
  room: Room;
  depth: number;
  onOpen: () => void;
}

function RoomRow({ room, depth, onOpen }: RoomRowProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      data-room-id={room.id}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className="flex min-w-0 cursor-default items-center gap-2 rounded px-2 py-1 text-sm text-[var(--h-subtext)] hover:bg-[var(--h-surface)]"
    >
      <span className="w-2 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{room.title}</span>
    </div>
  );
}

export interface SessionTreeProps {
  projectPath: string;
  workId: string;
  sessions: readonly WorkSession[];
  /** Комнаты работы (спека 6.1) — размещаются под создателем или, для человека, прямо под работой. */
  rooms: readonly Room[];
  selectedSessionId: string | null;
  activityByRef: Record<string, ActivityEntry>;
  /** В работе есть хотя бы одно письмо — показывать строку «вся почта работы» (спека 6.4). */
  hasMail: boolean;
  onSelect: (session: WorkSession) => void;
  onOpen: (session: WorkSession) => void;
  onResume: (session: WorkSession) => void;
  onStop: (session: WorkSession) => void;
  onClose: (session: WorkSession) => void;
  onDelete: (session: WorkSession) => void;
  onCreateRoom: (session: WorkSession) => void;
  onOpenMail: () => void;
  onOpenRoom: (room: Room) => void;
}

export function SessionTree({
  projectPath,
  workId,
  sessions,
  rooms,
  selectedSessionId,
  activityByRef,
  hasMail,
  onSelect,
  onOpen,
  onResume,
  onStop,
  onClose,
  onDelete,
  onCreateRoom,
  onOpenMail,
  onOpenRoom,
}: SessionTreeProps): JSX.Element {
  const humanRooms = rooms.filter((room) => room.creator === HUMAN);
  const roomsByCreator = new Map<string, Room[]>();
  for (const room of rooms) {
    if (room.creator === HUMAN) continue;
    const list = roomsByCreator.get(room.creator);
    if (list === undefined) roomsByCreator.set(room.creator, [room]);
    else list.push(room);
  }

  return (
    <div>
      {hasMail ? (
        <div
          role="button"
          tabIndex={0}
          onClick={onOpenMail}
          className="flex min-w-0 cursor-default items-center gap-2 rounded px-2 py-1 pl-2 text-sm text-[var(--h-subtext)] hover:bg-[var(--h-surface)]"
        >
          <span className="w-2 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Вся почта работы</span>
        </div>
      ) : null}
      {humanRooms.map((room) => (
        <RoomRow key={room.id} room={room} depth={0} onOpen={() => onOpenRoom(room)} />
      ))}
      {treeOrder(sessions).map(({ session, depth }) => {
        const ref: SessionRef = { projectPath, workId, sessionId: session.id };
        const entry = activityFor(activityByRef, ref);
        const status = displayStatus(session);
        const state = dotState(status, entry?.activity.activity ?? null);
        const selected = session.id === selectedSessionId;
        const label = sessionRowLabel(session.id, session.label);
        const closed = session.lifecycle === 'closed';

        return (
          <div key={session.id}>
            <SessionMenu
              status={status}
              closed={closed}
              label={label}
              onOpen={() => onOpen(session)}
              onResume={() => onResume(session)}
              onStop={() => onStop(session)}
              onClose={() => onClose(session)}
              onDelete={() => onDelete(session)}
              onCreateRoom={() => onCreateRoom(session)}
            >
              <div
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    DRAG_MIME,
                    dragPayload({ kind: 'terminal', ref, workKey: workKey(projectPath, workId) }),
                  )
                }
                data-session-id={session.id}
                data-selected={selected}
                onClick={() => onSelect(session)}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                className={`flex min-w-0 cursor-default items-center gap-2 rounded px-2 py-1 text-sm ${
                  selected
                    ? 'bg-[var(--h-selection)] text-[var(--h-text)]'
                    : closed
                      ? 'text-[var(--h-muted)] opacity-60 hover:bg-[var(--h-surface)]'
                      : 'text-[var(--h-subtext)] hover:bg-[var(--h-surface)]'
                }`}
              >
                <StatusDot state={state} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 truncate text-xs text-[var(--h-muted)]">{closed ? 'закрыта' : STATE_WORDS[state]}</span>
              </div>
            </SessionMenu>
            {selected ? <MetricsLine metrics={entry?.metrics ?? null} /> : null}
            {(roomsByCreator.get(session.id) ?? []).map((room) => (
              <RoomRow key={room.id} room={room} depth={depth + 1} onOpen={() => onOpenRoom(room)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
