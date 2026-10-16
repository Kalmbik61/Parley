/**
 * Серое письмо человека в ленте комнаты (спека 2026-10-16, 4.2): справа, как сообщения человека (`RoomMessage`), но
 * с пунктирной рамкой. `sending` — в полёте или ушло и ждёт появления в ленте, `waiting` — ждёт за другим, `failed` —
 * «Not sent» с Retry и ×. Текст — тем же `RoomMarkdown`, что у отправленных: упоминания — чипами.
 */

import { X } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { RoomMarkdown } from './RoomMarkdown.js';

export interface RoomPendingMessageProps {
  text: string;
  state: 'sending' | 'waiting' | 'failed';
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  onRetry: () => void;
  onRemove: () => void;
}

export function RoomPendingMessage({ text, state, labelOf, onOpenExternal, onRetry, onRemove }: RoomPendingMessageProps): JSX.Element {
  const caption = state === 'failed' ? S.outbox.notSent : state === 'sending' ? S.outbox.sending : S.outbox.waiting;
  return (
    <div data-testid="room-pending" data-state={state} className="flex max-w-[680px] flex-col items-end gap-1 self-end">
      <div className="max-w-full break-words rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        <RoomMarkdown text={text} labelOf={labelOf} onOpenExternal={onOpenExternal} humanChips={false} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span role="status" className={state === 'failed' ? 'text-[var(--status-warning-text)]' : undefined}>
          {caption}
        </span>
        {state === 'failed' ? (
          <>
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {S.common.retry}
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={S.outbox.remove} title={S.outbox.remove} onClick={onRemove}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
