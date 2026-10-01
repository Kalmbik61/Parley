/**
 * Тело вкладки одной комнаты (кусок 2.4): та же обвязка, что раньше была в
 * `panel-registry.tsx#RoomPanelContent` — своя копия `MailBody.tsx`, а не
 * общий хук: `MailBody.tsx` этот кусок не трогает, вводить абстракцию ради
 * одного дополнительного места рано (тот же выбор, что и в `RoomPanel.tsx`
 * самом по себе).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../../attention/focus-target.js';
import { RoomPanel } from '../../components/rooms/RoomPanel.js';
import { useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';

export interface RoomBodyProps {
  bridge: ParleyBridge;
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

  // Клик по карточке участника: тот же переход, что клик по уведомлению (4.3) — вкладка терминала, вспышка, фокус.
  const openSession = (sessionId: string): void => {
    const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId };
    if (!applyFocusTarget({ kind: 'session', ref }, buildFocusTargetDeps())) toast(S.notifications.targetGone);
  };

  return (
    <RoomPanel
      entry={entry}
      roomId={roomId}
      providers={providers}
      activity={activityByRef}
      bridge={bridge}
      active={active}
      onOpenExternal={(url) => void bridge.app.openExternal(url)}
      onOpenSession={openSession}
    />
  );
}
