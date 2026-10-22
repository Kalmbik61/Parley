/**
 * Строка «Waiting for folder trust» (спека 2026-10-21, 4.2 п. 2): удержанная сессия Codex ждёт решения человека
 * по папке проекта. Одна на Chat (`ChatView`) и на терминал (`TerminalSurface`: pending-сессия открывается там);
 * кнопка «Trust folder» открывает диалог по карточке (`useConsentsStore.ask`). Отступы и размеры — у вызывающего
 * (`className`), `testId` разный у видов: Chat и терминал могут быть смонтированы одновременно.
 */

import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useConsentsStore } from '../store/consents.js';
import { Button } from '../ui/button.js';

export interface WaitingForTrustProps {
  /** Карточка согласия (`trustCardFor`), которую открывает кнопка. */
  cardId: string;
  testId: string;
  className?: string;
}

export function WaitingForTrust({ cardId, testId, className }: WaitingForTrustProps): JSX.Element {
  return (
    <div data-testid={testId} className={cn('flex min-w-0 items-center gap-2 rounded-lg bg-foreground/5 px-3 py-2 text-xs', className)}>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{S.chat.waitingForTrust}</span>
      <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={() => useConsentsStore.getState().ask(cardId)}>
        {S.chat.trustFolder}
      </Button>
    </div>
  );
}
