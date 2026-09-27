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
  /** «Restart» в подтверждении: AppShell перезапускает хост, отказ — тостом. */
  onRestartHost: () => void;
  /** Подтверждение открыто — AppShell: dialogs.restartHost (кусок 6.3, тот же диалог, что у палитры). */
  restartHostOpen: boolean;
  /** true — confirmRestartHost(), false — closeRestartHostDialog(). */
  onRestartHostOpenChange(open: boolean): void;
  /** Итоги внимания по секциям сайдбара (кусок 4.2): AppShell — useAttentionTotals(). */
  attention: { needsYou: number; unseen: number };
  /** Клик по сегменту внимания — «следующая, где нужен ты» (спека 7.6): AppShell — openNextAttention. */
  onNextAttention: () => void;
}

export function StatusBar({
  status,
  noticeLine,
  wakePaused,
  onToggleWake,
  onRestartHost,
  restartHostOpen,
  onRestartHostOpenChange,
  attention,
  onNextAttention,
}: StatusBarProps): JSX.Element {
  const outdated = missingMethods(status).length > 0;
  // Письма в счёт не входят: они в бейдже и на карточках, а клик ведёт только к сессиям.
  const attentionText = S.statusBar.attention(attention.needsYou, attention.unseen);
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{noticeLine}</span>
      {attentionText === '' ? null : (
        <button
          type="button"
          data-attention-segment
          onClick={onNextAttention}
          className="shrink-0 rounded px-2 py-0.5 text-foreground hover:bg-accent"
        >
          {attentionText}
        </button>
      )}
      <span className="shrink-0">{CONNECTION_TEXT[status.state](status)}</span>
      {outdated ? (
        <button
          type="button"
          onClick={() => onRestartHostOpenChange(true)}
          className="shrink-0 rounded px-2 py-0.5 text-foreground hover:bg-accent"
        >
          {S.statusBar.hostOutdated}
        </button>
      ) : null}
      {/* Диалог смонтирован и без кнопки «устарел»: его открывает и действие палитры host.restart. */}
      <ConfirmDialog
        open={restartHostOpen}
        title={S.statusBar.restartHostTitle}
        description={S.statusBar.restartHostDescription}
        confirmLabel={S.connection.restart}
        onConfirm={onRestartHost}
        onOpenChange={onRestartHostOpenChange}
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
