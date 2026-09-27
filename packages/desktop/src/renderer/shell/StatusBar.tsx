/**
 * Строка статуса: последнее событие хоста, состояние связи и переключатель
 * паузы будильника живых сессий (кусок 1.10 плана окна). Перенесена из
 * `renderer/components/StatusBar.tsx` в `renderer/shell/` куском 2.3
 * (спека 5.9) — содержимое не менялось.
 */

import type { HostNotice } from '@harnas/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';

const CONNECTION_TEXT: Record<HostStatus['state'], (status: HostStatus) => string> = {
  connecting: () => S.connection.statusConnecting,
  connected: (status) => (status.state === 'connected' ? S.connection.statusConnected(status.hostVersion) : ''),
  mismatch: () => S.connection.statusMismatch,
  disconnected: (status) => (status.state === 'disconnected' ? S.connection.statusDisconnected(status.reason) : ''),
};

export interface StatusBarProps {
  status: HostStatus;
  lastNotice: HostNotice | null;
  wakePaused: boolean | null;
  onToggleWake: () => void;
}

export function StatusBar({ status, lastNotice, wakePaused, onToggleWake }: StatusBarProps): JSX.Element {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{lastNotice?.text ?? ''}</span>
      <span className="shrink-0">{CONNECTION_TEXT[status.state](status)}</span>
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
