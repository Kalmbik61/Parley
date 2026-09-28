/**
 * Тело вкладки одной комнаты (кусок 2.4): та же обвязка, что раньше была в
 * `panel-registry.tsx#RoomPanelContent` — своя копия `MailBody.tsx`, а не
 * общий хук: `MailBody.tsx` этот кусок не трогает, вводить абстракцию ради
 * одного дополнительного места рано (тот же выбор, что и в `RoomPanel.tsx`
 * самом по себе).
 */

import { useEffect, useState } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { RoomPanel } from '../../components/rooms/RoomPanel.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';

export interface RoomBodyProps {
  bridge: HarnasBridge;
  entry: WorkEntry;
  roomId: string;
  /** Работа активна — `LayoutBodyContext.active` из `GroupView` (кусок 4.2). */
  active: boolean;
}

export function RoomBody({ bridge, entry, roomId, active }: RoomBodyProps): JSX.Element {
  const activityByRef = useActivityStore((state) => state.byRef);
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  // Связь вернулась — список заново: тело при обрыве не перемонтируется (fix-7.3).
  const connections = useHostStore((state) => state.connections);

  useEffect(() => {
    bridge
      .call('providers.list', {})
      .then((result) => setProviders(result.providers))
      .catch(() => {});
  }, [bridge, connections]);

  const models: Record<string, string | null> = {};
  for (const session of entry.map.sessions) {
    const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
    models[session.id] = activityFor(activityByRef, ref)?.metrics?.model ?? null;
  }

  return (
    <RoomPanel
      entry={entry}
      roomId={roomId}
      providers={providers}
      models={models}
      bridge={bridge}
      active={active}
      onOpenExternal={(url) => void bridge.app.openExternal(url)}
    />
  );
}
