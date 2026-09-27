/**
 * Строка статуса: последнее событие хоста, состояние связи и переключатель
 * паузы будильника живых сессий (кусок 1.10 плана окна). Перенесена из
 * `renderer/components/StatusBar.tsx` в `renderer/shell/` куском 2.3
 * (спека 5.9) — содержимое не менялось.
 *
 * `noticeLine` приходит уже переведённым текстом (`shared/strings.ts#noticeText`,
 * раунд исправлений 1 куска E.1) — сам компонент `HostNotice` больше не
 * видит и русский `notice.text` показать не может, даже случайно.
 */

import { useState } from 'react';
import type { HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { missingMethods } from '../lib/capabilities.js';

const CONNECTION_TEXT: Record<HostStatus['state'], (status: HostStatus) => string> = {
  connecting: () => S.connection.statusConnecting,
  connected: (status) => (status.state === 'connected' ? S.connection.statusConnected(status.hostVersion) : ''),
  mismatch: () => S.connection.statusMismatch,
  disconnected: (status) => (status.state === 'disconnected' ? S.connection.statusDisconnected(status.reason) : ''),
};

export interface StatusBarProps {
  status: HostStatus;
  /** Английский текст последнего уведомления хоста, уже собранный `noticeText` — пусто, если уведомлений ещё не было. */
  noticeLine: string;
  wakePaused: boolean | null;
  onToggleWake: () => void;
  /** «Restart» в подтверждении: AppShell передаёт () => void bridge.app.restartHost(). */
  onRestartHost: () => void;
}

export function StatusBar({
  status,
  noticeLine,
  wakePaused,
  onToggleWake,
  onRestartHost,
}: StatusBarProps): JSX.Element {
  // Подтверждение — локальное состояние строки статуса; 6.3 переведёт его
  // открытие на общий `confirmRestartHost`.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const outdated = missingMethods(status).length > 0;
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{noticeLine}</span>
      <span className="shrink-0">{CONNECTION_TEXT[status.state](status)}</span>
      {outdated ? (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="shrink-0 rounded px-2 py-0.5 text-foreground hover:bg-accent"
        >
          {S.statusBar.hostOutdated}
        </button>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={S.statusBar.restartHostTitle}
        description={S.statusBar.restartHostDescription}
        confirmLabel={S.connection.restart}
        onConfirm={onRestartHost}
        onOpenChange={setConfirmOpen}
      />
      <button
        type="button"
        onClick={onToggleWake}
        disabled={wakePaused === null}
        className="shrink-0 rounded px-2 py-0.5 text-foreground hover:bg-accent disabled:opacity-50"
      >
        {wakePaused === true ? S.statusBar.wakePaused : S.statusBar.wakeOn}
      </button>
    </div>
  );
}
