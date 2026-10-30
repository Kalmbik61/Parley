/**
 * Плашка цитаты над полем ввода (Reply, `reply.ts`): начало цитаты в две строки и крестик «убрать». Одна на поле «Chat»
 * и на поле комнаты; цитата уходит вместе со следующим сообщением.
 */

import { Reply, X } from 'lucide-react';
import { S } from '../../shared/strings.js';

/** `target` — Reply в комнате: кому адресован ответ; `gone` — автор вышел из комнаты, письмо уйдёт без адресата. */
export function ReplyPlate({
  quote,
  target,
  onRemove,
}: {
  quote: string;
  target?: { label: string; gone: boolean };
  onRemove: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="reply-plate"
      title={quote}
      className="mx-3 mb-1 flex min-w-0 items-start gap-2 rounded-md border-l-[3px] border-primary bg-muted px-2 py-1 text-xs text-muted-foreground"
    >
      <Reply className="mt-0.5 size-3.5 shrink-0" aria-label={S.chat.reply.label} />
      <span className="min-w-0 flex-1">
        {target === undefined ? null : (
          <span data-reply-target="" className="block font-semibold text-foreground">
            {S.rooms.replyTo(target.label)}
            {target.gone ? <span className="font-normal text-muted-foreground"> · {S.rooms.replyAuthorGone}</span> : null}
          </span>
        )}
        <span className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{quote}</span>
      </span>
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
