/**
 * Плашка цитаты над полем ввода (Reply, `reply.ts`): начало цитаты в две строки и крестик «убрать». Одна на поле «Chat»
 * и на поле комнаты; цитата уходит вместе со следующим сообщением.
 */

import { Reply, X } from 'lucide-react';
import { S } from '../../shared/strings.js';

export function ReplyPlate({ quote, onRemove }: { quote: string; onRemove: () => void }): JSX.Element {
  return (
    <div
      data-testid="reply-plate"
      title={quote}
      className="mx-3 mb-1 flex min-w-0 items-start gap-2 rounded-md border-l-[3px] border-primary bg-muted px-2 py-1 text-xs text-muted-foreground"
    >
      <Reply className="mt-0.5 size-3.5 shrink-0" aria-label={S.chat.reply.label} />
      <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{quote}</span>
      <button
        type="button"
        aria-label={S.chat.reply.remove}
        title={S.chat.reply.remove}
        onClick={onRemove}
        className="flex size-[18px] shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/12"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
