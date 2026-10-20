// packages/desktop/src/renderer/browser/AgentBadge.tsx
/**
 * Значок агента в строке страницы (этап D): ярлык сессии, которая сейчас работает на странице, и кнопка Stop.
 * Подсказка — последние операции. На узкой строке подпись «Stop» прячется, остаётся значок (как у прочих кнопок строки).
 */

import { Square } from 'lucide-react';
import { S } from '../../shared/strings.js';

export function AgentBadge({ session, recent, onStop }: { session: string; recent: string[]; onStop(): void }): JSX.Element {
  const title = recent.length > 0 ? `${S.browser.panel.agentActing(session)}. ${S.browser.panel.agentRecent(recent)}` : S.browser.panel.agentActing(session);
  return (
    <span
      data-testid="agent-badge"
      title={title}
      className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-blue-500/15 pl-2 pr-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400"
    >
      <span>{session}</span>
      <button
        type="button"
        aria-label={S.browser.panel.agentStop}
        title={S.browser.panel.agentStopHint}
        onClick={onStop}
        className="flex h-5 shrink-0 items-center gap-1 rounded-full px-1 hover:bg-blue-500/25"
      >
        <Square className="size-3 fill-current" aria-hidden="true" />
        <span className="hidden min-[900px]:inline">{S.browser.panel.agentStop}</span>
      </button>
    </span>
  );
}
