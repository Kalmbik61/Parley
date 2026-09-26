/**
 * Баннер упавших сессий (кусок 3.6 плана окна, спека 7.4): при подключении
 * спрашивает `sessions.interrupted`, и если список непуст — «Прерваны
 * посреди хода: S03, S05» с кнопкой «Поднять всех» (`sessions.resumeInterrupted`).
 * Сам себя прячет, когда список пуст — рендерится безусловно под `Workspace`
 * в `App.tsx`, как и остальные подключённые к бриджу диалоги (`SettingsDialog`
 * и т. п.), а не по внешнему условию.
 */

import { useEffect, useState } from 'react';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { sessionTag } from '../lib/participant.js';

export interface InterruptedBannerProps {
  bridge: HarnasBridge;
}

export function InterruptedBanner({ bridge }: InterruptedBannerProps): JSX.Element | null {
  const [refs, setRefs] = useState<SessionRef[]>([]);

  useEffect(() => {
    bridge
      .call('sessions.interrupted', {})
      .then((result) => setRefs(result.refs))
      .catch(() => {
        // Нет ответа — баннера просто не будет, не повод падать.
      });
  }, [bridge]);

  if (refs.length === 0) return null;

  const resumeAll = (): void => {
    bridge
      .call('sessions.resumeInterrupted', { refs })
      .then(() => setRefs([]))
      .catch(() => {
        // Не удалось — баннер остаётся, попробовать можно ещё раз.
      });
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--h-overlay)] bg-[var(--h-surface)] px-3 py-2 text-sm text-[var(--h-text)]">
      <span>Прерваны посреди хода: {refs.map((ref) => sessionTag(ref.sessionId)).join(', ')}</span>
      <button
        type="button"
        onClick={resumeAll}
        className="shrink-0 rounded bg-[var(--h-blue)] px-2 py-1 text-xs text-[var(--h-base)]"
      >
        Поднять всех
      </button>
    </div>
  );
}
