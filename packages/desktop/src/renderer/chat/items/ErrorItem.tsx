/** Ход оборвался ошибкой API (план 2026-10-01, решение 3, `StopFailure`): красная карточка с текстом. */

import { CircleAlert } from 'lucide-react';
import type { FeedError } from '@parley/core';
import { S } from '../../../shared/strings.js';

export function ErrorItem({ item }: { item: FeedError }): JSX.Element {
  return (
    <div
      data-testid="chat-error"
      role="alert"
      className="flex min-w-0 gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
        <span className="font-semibold text-destructive">{item.retry === undefined ? S.chat.error : S.chat.retrying}</span>
        <span className="whitespace-pre-wrap">{item.message ?? item.error}</span>
        {item.message === null ? null : <span className="text-xs text-muted-foreground">{item.error}</span>}
        {item.retry === undefined ? null : (
          <span className="text-xs text-muted-foreground">
            {S.chat.retryScheduled(Math.ceil(item.retry.delayMs / 1000))} · {S.chat.retryAttempt(item.retry.attempt, item.retry.maxAttempts)}
          </span>
        )}
      </div>
    </div>
  );
}
