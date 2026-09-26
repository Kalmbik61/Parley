/**
 * Строка статуса: последнее событие хоста, состояние связи и переключатель
 * паузы будильника живых сессий (кусок 1.10 плана окна).
 */

import type { HostNotice } from '@harnas/protocol';
import type { HostStatus } from '../../shared/bridge.js';

const CONNECTION_TEXT: Record<HostStatus['state'], (status: HostStatus) => string> = {
  connecting: () => 'подключение…',
  connected: (status) => (status.state === 'connected' ? `хост ${status.hostVersion}` : ''),
  mismatch: () => 'хост другой версии',
  disconnected: (status) => (status.state === 'disconnected' ? `нет связи: ${status.reason}` : ''),
};

export interface StatusBarProps {
  status: HostStatus;
  lastNotice: HostNotice | null;
  wakePaused: boolean | null;
  onToggleWake: () => void;
}

export function StatusBar({ status, lastNotice, wakePaused, onToggleWake }: StatusBarProps): JSX.Element {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-[var(--h-overlay)] bg-[var(--h-mantle)] px-3 text-xs text-[var(--h-subtext)]">
      <span className="min-w-0 flex-1 truncate">{lastNotice?.text ?? ''}</span>
      <span className="shrink-0">{CONNECTION_TEXT[status.state](status)}</span>
      <button
        type="button"
        onClick={onToggleWake}
        disabled={wakePaused === null}
        className="shrink-0 rounded px-2 py-0.5 text-[var(--h-text)] hover:bg-[var(--h-surface)] disabled:opacity-50"
      >
        {wakePaused === true ? 'будильник на паузе' : 'будильник работает'}
      </button>
    </div>
  );
}
