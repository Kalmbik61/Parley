/**
 * Ход оборвался ошибкой API (план 2026-10-01, решение 3, `StopFailure`): красная карточка с текстом.
 * Код `codex-history-in-terminal` (лента Codex, спека 2026-10-07, 5.4) — не сбой, а заметка: журнал не хранит
 * историю до подключения Parley; строка окна и кнопка «Open terminal».
 */

import { useContext } from 'react';
import { CircleAlert } from 'lucide-react';
import type { FeedError } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { updateTab } from '../../layout/tree.js';
import { useLayoutStore } from '../../layout/store.js';
import { Button } from '../../ui/button.js';
import { ChatEnvContext } from '../chat-env.js';

export function ErrorItem({ item }: { item: FeedError }): JSX.Element {
  const env = useContext(ChatEnvContext);
  if (item.error === 'codex-history-in-terminal') {
    const { workKey, tabId } = env ?? {};
    return (
      <div data-testid="chat-error" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 [overflow-wrap:anywhere]">{S.chat.codexHistoryInTerminal}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            if (workKey === undefined || tabId === undefined) return;
            useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: 'terminal' }));
          }}
        >
          {S.chat.openTerminal}
        </Button>
      </div>
    );
  }
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
