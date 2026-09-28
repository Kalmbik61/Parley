/**
 * Тело вкладки «вся почта работы» (кусок 2.4): та же обвязка, что раньше была
 * в `panel-registry.tsx#MailPanelContent` — список провайдеров запрашивается
 * один раз при монтировании, модель каждой сессии берётся из живой activity.
 */

import { useEffect, useState } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { MailPanel } from '../../components/mail/MailPanel.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';

export interface MailBodyProps {
  bridge: HarnasBridge;
  entry: WorkEntry;
  /** Работа активна — `LayoutBodyContext.active` из `GroupView` (кусок 4.2). */
  active: boolean;
}

export function MailBody({ bridge, entry, active }: MailBodyProps): JSX.Element {
  const activityByRef = useActivityStore((state) => state.byRef);
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  // Связь вернулась — список заново: тело при обрыве не перемонтируется (fix-7.3).
  const connections = useHostStore((state) => state.connections);

  useEffect(() => {
    // Список провайдеров почти не меняется за сеанс — одного запроса на монтирование достаточно.
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
    <MailPanel
      entry={entry}
      providers={providers}
      models={models}
      bridge={bridge}
      active={active}
      onOpenExternal={(url) => void bridge.app.openExternal(url)}
    />
  );
}
