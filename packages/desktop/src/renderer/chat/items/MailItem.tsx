/**
 * Письма, доставленные этой сессии (элемент ленты `mail`, спека 2026-11-12, 3.4): одна рамка на доставку, по записи на
 * письмо — отправитель, вид, комната, время и текст, свёрнутый до шести строк. Только чтобы видеть: ответа отсюда нет.
 */

import { useState } from 'react';
import type { FeedMail, FeedMailLetter } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { formatClock } from '../../lib/mail-view.js';
import { sessionRowLabel } from '../../lib/participant.js';

/** Те же литералы, что `HUMAN` и `SYSTEM` в `core/work/types.ts`: из корня core рендерер берёт только типы. */
const HUMAN = 'human';
const SYSTEM = 'system';
const PARLEY = 'parley';

/** Больше стольких строк (или знаков в длинных строках) текст сворачивается: в jsdom высоты нет, считаем по тексту. */
export const MAIL_FOLD_LINES = 6;
const FOLD_CHARS = 600;

/** Подпись отправителя: сессия — `S03 бэкенд`, человек — `you`, система и Parley — их подписи. */
export function mailSender(letter: FeedMailLetter): string {
  if (letter.from === HUMAN) return S.chat.mail.you;
  if (letter.from === SYSTEM) return S.participants.system;
  if (letter.from === PARLEY) return S.chat.mail.parley;
  return sessionRowLabel(letter.from, letter.fromLabel ?? '');
}

/** Длинное письмо: шесть строк по переводам строки или много знаков (длинные строки переносятся). */
const isLong = (text: string): boolean => text.split('\n').length > MAIL_FOLD_LINES || text.length > FOLD_CHARS;

function Letter({ letter }: { letter: FeedMailLetter }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = isLong(letter.text);
  return (
    <div data-testid="chat-mail-letter" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span data-testid="chat-mail-sender" className="font-medium text-foreground [overflow-wrap:anywhere]">{mailSender(letter)}</span>
        <span data-testid="chat-mail-kind" className="rounded border border-border px-1">{S.chat.mail.kind[letter.kind]}</span>
        {letter.room === null ? null : <span data-testid="chat-mail-room" className="[overflow-wrap:anywhere]">{S.chat.mail.room(letter.room.id, letter.room.title)}</span>}
        <span data-testid="chat-mail-time">{formatClock(letter.at)}</span>
      </div>
      <div data-testid="chat-mail-text" className={`whitespace-pre-wrap text-sm [overflow-wrap:anywhere] ${long && !open ? 'line-clamp-6' : ''}`}>{letter.text}</div>
      {long ? (
        <button type="button" data-find-label data-testid="chat-mail-toggle" className="self-start text-xs text-muted-foreground underline" onClick={() => setOpen(!open)}>
          {open ? S.chat.mail.showLess : S.chat.mail.showMore}
        </button>
      ) : null}
      {letter.cut === true ? <span data-find-label data-testid="chat-mail-cut" className="text-xs text-muted-foreground">{S.chat.mail.cut}</span> : null}
    </div>
  );
}

export function MailItem({ item }: { item: FeedMail }): JSX.Element {
  return (
    <div data-testid="chat-mail" className="flex min-w-0 flex-col items-start">
      <div className="flex min-w-0 max-w-[85%] flex-col gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
        {item.letters.map((letter) => <Letter key={letter.id} letter={letter} />)}
        {item.remaining !== undefined && item.remaining > 0
          ? <span data-find-label data-testid="chat-mail-remaining" className="text-xs text-muted-foreground">{S.chat.mail.remaining(item.remaining)}</span>
          : null}
      </div>
    </div>
  );
}
