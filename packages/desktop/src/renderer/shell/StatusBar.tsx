/**
 * Строка статуса: последнее событие хоста, состояние связи и переключатель
 * паузы будильника живых сессий (кусок 1.10 плана окна). Перенесена из
 * `renderer/components/StatusBar.tsx` в `renderer/shell/` куском 2.3
 * (спека 5.9).
 *
 * Облик Organic (спека окна 2026-09-29, 1.1, решение 3): 28px на фоне окна, без линии и подложки,
 * отступ `0 14 2 18`, зазор 14, 12px `neutral-800`. Слева — сегмент на провайдера: значок 14, имя и версия
 * CLI моноширинным 11px `neutral-700`. Claude/Codex/GLM видны всегда в этом порядке;
 * недоступная кнопка приглушена, без версии и лимитов. Клик открывает общую карточку подключения. Справа — сегменты спеки Orca-UI 5.9: последнее уведомление хоста
 * (сжимается многоточием), счётчики внимания, связь с хостом, «Host is outdated», будильник.
 *
 * Лимиты подписки (кусок 9b, спека комнат Organic, 3.5) — после версии: полоска пятичасового окна (нет
 * его — недельного) и «58% 5h · 41% wk». Нет данных — сегмент прежний. Проценты целые, округление вниз:
 * не завышать расход и не прыгать при каждом обновлении. От 80 % в любом окне текст и полоска — `accent-700`.
 *
 * `noticeLine` приходит уже переведённым текстом (`shared/strings.ts#noticeText`,
 * раунд исправлений 1 куска E.1) — сам компонент `HostNotice` больше не
 * видит и `notice.text` хоста показать не может, даже случайно.
 */

import { useEffect, useRef, useState } from 'react';
import { Hourglass, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { LimitWindow, ProviderLimits } from '@parley/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../shared/strings.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { ProviderCard } from '../components/providers/ProviderCard.js';
import { cn } from '../lib/cn.js';
import { hostMethods, missingMethods, otherHostBuild } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../store/providers.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';

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

/** Быстрый локальный ответ не должен закончить анимацию до первого заметного кадра. */
const MIN_REFRESH_FEEDBACK_MS = 600;

/** Целые проценты окна, округление вниз (решение контролёра куска 9b); окна нет — `null`. */
const wholePercent = (limit: LimitWindow | null): number | null => (limit === null ? null : Math.floor(limit.usedPercent));

// Время в тултипе — местное и короткое, по-английски, как в `review/notes/NoteZone.tsx`: «9:30 PM», день — «Sat».
const clock = (iso: string): string => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const weekday = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });

/**
 * Лимиты подписки: трек 44×4 и текст окон. Внутри кнопки сначала сжимаются лимиты,
 * затем версия, затем имя; полоска остаётся. Основа текста 4.5ch переносит слишком
 * короткий остаток во вторую обрезанную строку, чтобы вместо процента не оставалась цифра.
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
    fiveHourLimit?.resetsAt == null ? null : clock(fiveHourLimit.resetsAt),
    weekLimit?.resetsAt == null ? null : { day: weekday(weekLimit.resetsAt), time: clock(weekLimit.resetsAt) },
    clock(limits.at),
  );
  return (
    <span
      data-limits
      title={tooltip}
      className="ml-1 flex h-4 min-w-11 shrink-[1000000000] flex-wrap content-start items-center gap-x-[7px] overflow-hidden"
    >
      <span aria-hidden className="my-1.5 h-1 w-11 shrink-0 overflow-hidden rounded-full bg-current/18">
        <span
          data-limits-fill
          className={cn('block h-full rounded-full', warning ? 'bg-accent-700' : 'bg-neutral-800')}
          style={{ width: `${bar}%` }}
        />
      </span>
      <span className={cn('min-w-0 grow basis-[4.5ch] truncate tabular-nums', warning && 'text-accent-700')}>
        {S.statusBar.limitsText(fiveHour, week)}
      </span>
    </span>
  );
}

/** Основные кнопки видны и без ответа хоста; свои провайдеры добавляются после них. */
const CORE_PROVIDERS = ['claude', 'codex', 'glm'] as const;

/**
 * Сегмент — кнопка поповера, и строка делит нехватку места между кнопками целиком, пропорционально вес × ширина: порядок
 * «лимиты, версия, имя» держится только внутри кнопки. Сегмент из значка и имени (недоступный GLM) иначе получал свою долю и
 * терял имя, пока у соседей ещё широк текст лимитов. Поэтому у сегмента с лимитами или версией вес строки — как у блока
 * лимитов внутри, на порядки больше единицы у сегмента из одного имени.
 */
const YIELDING_SEGMENT = 'shrink-[1000000000]';

/**
 * Пол такого сегмента — то, что в нём не сжимается: значок 14 и зазоры 7 между частями, а с блоком лимитов — ещё `ml-1` и
 * трек 44. Без пола при весе 10⁹ кнопка сжималась бы до нуля раньше сегментов из одного имени, и значок с полоской налезали
 * бы на соседей.
 */
const segmentFloor = (version: boolean, meter: boolean): number =>
  14 + 7 * (1 + Number(version) + Number(meter)) + (meter ? 4 + 44 : 0);

function ProviderSegment({ provider, onRestartHost }: { provider: ProviderInfo; onRestartHost: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const reload = useProvidersStore((state) => state.reload);
  const name = providerName(provider.id, provider.label);
  const title = S.statusBar.providerTitle(name, provider.available);
  const version = provider.available && provider.version !== null;
  const limits = provider.available && (provider.id !== 'glm' || provider.limits?.source === 'zai');
  // Блок лимитов рисуется, только когда есть хоть одно окно (`ProviderLimitsMeter`); у старого хоста поля нет вовсе.
  const meter = limits && (provider.limits?.fiveHour != null || provider.limits?.week != null);
  const yields = version || meter;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-provider-segment={provider.id} title={title} aria-label={title}
          style={yields ? { minWidth: segmentFloor(version, meter) } : undefined}
          className={cn('flex min-w-0 items-center gap-[7px] rounded-full text-left transition-colors hover:bg-foreground/8', yields && YIELDING_SEGMENT, !provider.available && 'opacity-50')}>
          <AgentIcon provider={provider.id} size={14} />
          <span className="min-w-0 truncate">{name}</span>
          {version ?
            <span className="min-w-0 shrink-[100000] truncate font-mono text-[11px] text-neutral-700">{provider.version}</span> : null}
          {limits ? <ProviderLimitsMeter limits={provider.limits} /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={name} side="top" align="start" className="max-h-[calc(100vh-48px)] w-[min(360px,calc(100vw-24px))] overflow-y-auto">
        <ProviderCard provider={provider} onReload={reload} onRestartHost={() => { setOpen(false); onRestartHost(); }} />
      </PopoverContent>
    </Popover>
  );
}

/** Причины квоты — только по точной паре; сырой ответ хоста не становится текстом тоста. */
function refreshErrorText(error: unknown): string {
  const { code, data } = decodeIpcError(error);
  if (code === 'internal' && data?.provider === 'glm') {
    switch (data.reason) {
      case 'authentication': return S.statusBar.refreshErrors.authentication;
      case 'unsupported_response': return S.statusBar.refreshErrors.unsupportedResponse;
      case 'timeout': return S.statusBar.refreshErrors.timeout;
      case 'unavailable': return S.statusBar.refreshErrors.unavailable;
    }
  }
  return errorText(code, S.errors.actions.refreshProviderLimits);
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
  const appVersion = useHostStore((state) => state.appVersion);
  // Хосту не хватает методов окна или он от другой сборки (окно обновили, хост остался прежним) — перезапуск.
  const outdated = missingMethods(status).length > 0 || otherHostBuild(status, appVersion) !== null;
  const snapshot = useProvidersStore((state) => state.providers);
  const refreshing = useProvidersStore((state) => state.refreshing);
  const refreshLimits = useProvidersStore((state) => state.refreshLimits);
  const connections = useHostStore((state) => state.connections);
  const [refreshFeedback, setRefreshFeedback] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshGeneration = useRef(0);
  const refreshBusy = refreshing || refreshFeedback;
  useEffect(() => {
    ++refreshGeneration.current;
    setRefreshFeedback(false);
    return () => {
      ++refreshGeneration.current;
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [connections, status.state]);
  const canRefresh = hostMethods(status).has('providers.refreshLimits') && snapshot.some((provider) => provider.available);
  const providers = [
    ...CORE_PROVIDERS.map((id): ProviderInfo => snapshot.find((provider) => provider.id === id) ??
      { id, label: providerName(id, id), available: false, version: null, limits: null }),
    ...snapshot.filter((provider) => provider.available && !CORE_PROVIDERS.some((id) => id === provider.id)),
  ];
  // Письма в счёт не входят: они в бейдже и на карточках, а клик ведёт только к сессиям.
  const attentionText = S.statusBar.attention(attention.needsYou, attention.unseen);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3.5 pb-0.5 pl-[18px] pr-3.5 text-xs text-neutral-800">
      <button
        type="button"
        title={S.statusBar.refreshLimits}
        aria-label={S.statusBar.refreshLimits}
        aria-busy={refreshBusy}
        disabled={!canRefresh || refreshBusy}
        className={cn('shrink-0 rounded-full p-0.5 transition-colors hover:bg-foreground/8 disabled:opacity-50', refreshBusy && 'bg-foreground/8 ring-1 ring-foreground/25')}
        onClick={() => {
          const generation = refreshGeneration.current;
          setRefreshFeedback(true);
          refreshTimer.current = setTimeout(() => {
            refreshTimer.current = null;
            setRefreshFeedback(false);
          }, MIN_REFRESH_FEEDBACK_MS);
          void refreshLimits().catch((error: unknown) => {
            if (generation === refreshGeneration.current)
              toast(refreshErrorText(error));
          });
        }}
      >
        <RefreshCw aria-hidden size={14} className={cn(refreshBusy && 'animate-spin motion-reduce:animate-none motion-reduce:hidden')} />
        {refreshBusy ? <Hourglass aria-hidden size={14} className="hidden motion-reduce:block" /> : null}
      </button>
      {providers.map((provider) => (
        <ProviderSegment key={provider.id} provider={provider} onRestartHost={() => onRestartHostOpenChange(true)} />
      ))}
      {/* Уведомление хоста — заполнитель: берёт то, что осталось, и уступает первым. */}
      <span className="min-w-0 flex-1 truncate text-right">{noticeLine}</span>
      <div className="flex shrink-0 items-center gap-3.5">
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
