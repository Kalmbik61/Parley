/**
 * Серое письмо в очереди Chat: другая сессия, комната или человек написали этой сессии, а она его ещё не забрала —
 * будильник держит указатель, пока идёт ход или сжатие (`metrics.pendingLetters`). Только чтобы видеть: ни «Send now»,
 * ни × — письмо доставит хост, когда агент сможет его принять.
 */

import { S } from '../../../shared/strings.js';

export interface LetterItemProps {
  /** Кто написал — уже подпись: `S02 reviewer`, `you`. */
  from: string;
  /** Название комнаты; `null` — прямое письмо. */
  room: string | null;
  text: string;
  /** Почему ещё не забрано; `null` — причина не известна. */
  reason: string | null;
}

export function LetterItem({ from, room, text, reason }: LetterItemProps): JSX.Element {
  return (
    <div data-testid="chat-letter" className="flex min-w-0 flex-col items-start">
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        <span className="text-xs [overflow-wrap:anywhere]">{S.chat.letter.from(from, room)}</span>
        <span className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
        <span className="text-xs">{S.chat.letter.waiting(reason)}</span>
      </div>
    </div>
  );
}
