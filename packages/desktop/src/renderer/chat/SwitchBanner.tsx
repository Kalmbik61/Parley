/**
 * Баннер над полем ввода вида «Chat» (спека 2026-10-30, 5.7): сессия упёрлась в лимит или вход, либо её провайдера
 * удалили — кнопка открывает диалог замены. Идёт замена — «Switching to …» без кнопки. Решает, показывать ли его,
 * `switchBannerKind`; `ChatView` лишь ставит баннер рядом с `WaitingBanner`.
 */

import { localClock } from '@parley/core/stuck';
import type { WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { openSwitchAgent } from '../store/switch-agent.js';
import { Button } from '../ui/button.js';

export type SwitchBannerKind = 'limit' | 'sign-in' | 'removed' | 'switching';

/** Какой баннер нужен сессии; `null` — никакой. Закрытым и сессиям движка autonomous замена не предлагается. */
export function switchBannerKind(session: WorkSession, providerMissing: boolean): SwitchBannerKind | null {
  if (session.lifecycle === 'closed' || (session.workspace ?? null) !== null) return null;
  if ((session.switching ?? null) !== null) return 'switching';
  if (providerMissing) return 'removed';
  if (session.stuck?.kind === 'limit') return 'limit';
  if (session.stuck?.kind === 'sign-in') return 'sign-in';
  return null;
}

export interface SwitchBannerProps {
  session: WorkSession;
  kind: SwitchBannerKind;
  sessionRef: SessionRef;
  /** Подпись провайдера для человека. */
  label: (providerId: string) => string;
}

export function SwitchBanner({ session, kind, sessionRef, label }: SwitchBannerProps): JSX.Element {
  const switching = kind === 'switching' ? (session.switching ?? null) : null;
  const resetsAt = session.stuck?.kind === 'limit' ? session.stuck.resetsAt : null;
  const text =
    switching !== null
      ? S.chat.switchBanner.switching(label(switching.to))
      : kind === 'limit'
        ? S.chat.switchBanner.limit(label(session.provider), resetsAt === null ? null : localClock(resetsAt, new Date()))
        : kind === 'sign-in'
          ? S.chat.switchBanner.signIn(label(session.provider))
          : S.chat.switchBanner.removed(session.provider);
  return (
    <div
      data-testid="chat-switch-banner"
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {switching === null ? (
        <Button type="button" size="xs" variant="outline" data-testid="chat-switch-open" onClick={() => openSwitchAgent(sessionRef)} className="shrink-0">
          {S.chat.switchBanner.action}
        </Button>
      ) : null}
    </div>
  );
}
