/**
 * Строка статуса: последнее событие хоста, состояние связи и переключатель
 * паузы будильника живых сессий (кусок 1.10 плана окна). Перенесена из
 * `renderer/components/StatusBar.tsx` в `renderer/shell/` куском 2.3
 * (спека 5.9).
 *
 * Облик Organic (спека окна 2026-09-29, 1.1, решение 3): 28px на фоне окна, без линии и подложки,
 * отступ `0 14 2 18`, зазор 14, 12px `neutral-800`. Слева — сегмент на провайдера: значок 14, имя и версия
 * CLI моноширинным 11px `neutral-700` (`store/providers.ts`: только `available`, в порядке хоста;
 * нет версии — только значок и имя). Справа — сегменты спеки Orca-UI 5.9: последнее уведомление хоста
 * (сжимается многоточием), счётчики внимания, связь с хостом, «Host is outdated», будильник.
 *
 * Лимиты подписки (кусок 9b, спека комнат Organic, 3.5) — после версии: полоска пятичасового окна (нет
 * его — недельного) и «58% 5h · 41% wk». Нет данных — сегмент прежний. Проценты целые, округление вниз:
 * не завышать расход и не прыгать при каждом обновлении. От 80 % в любом окне текст и полоска — `accent-700`.
 *
 * `noticeLine` приходит уже переведённым текстом (`shared/strings.ts#noticeText`,
 * раунд исправлений 1 куска E.1) — сам компонент `HostNotice` больше не
 * видит и русский `notice.text` показать не может, даже случайно.
 */

import type { LimitWindow, ProviderLimits } from '@harnas/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { providerName, S } from '../../shared/strings.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { cn } from '../lib/cn.js';
import { missingMethods } from '../lib/capabilities.js';
import { useProvidersStore } from '../store/providers.js';

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

/** Кнопка-сегмент справа: пилюля, основной цвет и на hover — вторичный текст на заливке ниже 4.5:1. */
const SEGMENT_BUTTON = 'shrink-0 rounded-full px-2 py-0.5 text-foreground transition-colors hover:bg-foreground/8';

/** От скольки процентов лимит в любом окне считается на исходе: текст и полоска — `accent-700` (спека 3.5). */
const LIMIT_WARNING_PERCENT = 80;

/** Целые проценты окна, округление вниз (решение контролёра куска 9b); окна нет — `null`. */
const wholePercent = (limit: LimitWindow | null): number | null => (limit === null ? null : Math.floor(limit.usedPercent));

// Время в тултипе — местное и короткое, по-английски, как в `review/notes/NoteZone.tsx`: «9:30 PM», день — «Sat».
const clock = (iso: string): string => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const weekday = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });

/**
 * Лимиты подписки провайдера: полоска (пятичасовое окно, нет его — недельное) и «58% 5h · 41% wk» после версии.
 * Ширины и отступы — по прототипу handoff: трек 44×4, зазор 7, слева ещё 4. Нет данных (`null`, оба окна
 * отсутствуют) — ничего не рисуется, сегмент остаётся значком, именем и версией. Тултип — когда сбросятся окна,
 * которые есть, и когда CLI отдал эти числа.
 */
function ProviderLimitsMeter({ limits }: { limits: ProviderLimits | null }): JSX.Element | null {
  const fiveHourLimit = limits?.fiveHour ?? null;
  const weekLimit = limits?.week ?? null;
  const fiveHour = wholePercent(fiveHourLimit);
  const week = wholePercent(weekLimit);
  const bar = fiveHour ?? week;
  if (limits === null || bar === null) return null;
  const warning = (fiveHour ?? 0) >= LIMIT_WARNING_PERCENT || (week ?? 0) >= LIMIT_WARNING_PERCENT;
  const tooltip = S.statusBar.limitsTooltip(
    fiveHourLimit === null ? null : clock(fiveHourLimit.resetsAt),
    weekLimit === null ? null : { day: weekday(weekLimit.resetsAt), time: clock(weekLimit.resetsAt) },
    clock(limits.at),
  );
  return (
    <span data-limits title={tooltip} className="ml-1 flex min-w-0 items-center gap-[7px]">
      <span aria-hidden className="h-1 w-11 shrink-0 overflow-hidden rounded-full bg-current/18">
        <span
          data-limits-fill
          className={cn('block h-full rounded-full', warning ? 'bg-accent-700' : 'bg-neutral-800')}
          style={{ width: `${bar}%` }}
        />
      </span>
      <span className={cn('min-w-0 truncate tabular-nums', warning && 'text-accent-700')}>{S.statusBar.limitsText(fiveHour, week)}</span>
    </span>
  );
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
  const providers = useProvidersStore((state) => state.providers).filter((provider) => provider.available);
  // Письма в счёт не входят: они в бейдже и на карточках, а клик ведёт только к сессиям.
  const attentionText = S.statusBar.attention(attention.needsYou, attention.unseen);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3.5 pb-0.5 pl-[18px] pr-3.5 text-xs text-neutral-800">
      {providers.map((provider) => (
        <span key={provider.id} data-provider-segment={provider.id} className="inline-flex shrink-0 items-center gap-[7px]">
          <AgentIcon provider={provider.id} size={14} />
          <span>{providerName(provider.id, provider.label)}</span>
          {provider.version === null ? null : <span className="font-mono text-[11px] text-neutral-700">{provider.version}</span>}
          <ProviderLimitsMeter limits={provider.limits} />
        </span>
      ))}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3.5">
        <span className="min-w-0 truncate">{noticeLine}</span>
        {attentionText === '' ? null : (
          <button type="button" data-attention-segment onClick={onNextAttention} className={SEGMENT_BUTTON}>
            {attentionText}
          </button>
        )}
        <span className="shrink-0">{CONNECTION_TEXT[status.state](status)}</span>
        {outdated ? (
          <button type="button" onClick={() => onRestartHostOpenChange(true)} className={SEGMENT_BUTTON}>
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
          className={`${SEGMENT_BUTTON} disabled:opacity-50`}
        >
          {wakePaused === true ? S.statusBar.wakePaused : S.statusBar.wakeOn}
        </button>
      </div>
    </div>
  );
}
