/**
 * Одно сообщение ленты комнаты (спека окна 2026-09-29, 1.3): аватар 18, мета — отправитель (600), `★`
 * у ведущего, `→ all` или `→ S02 бэкенд, S03 ревью`, тег вида, время, точка «непрочитано»; текст
 * 14px/1.55 — Markdown (GFM) с чипами (`RoomMarkdown.tsx`); под ним строка ожидания
 * `▤ Not picked up yet by S02, S03`. Системная строка — аватар системы без адресата и без точки
 * (решение контролёра 4 куска 6).
 *
 * Точка — токен `--state-done`, а не `accent-2-500` handoff: тот к листу светлой темы 2.6:1, ниже порога
 * 3:1 для признака состояния (решение 11 спеки — те же токены у значков состояний).
 *
 * За «прочитано» (`observeRef`, `attention/use-mark-read.ts`) наблюдается строка меты, а не всё
 * сообщение: наблюдатель ждёт половину площади цели, а сообщение в 2000 знаков в невысоком окне выше
 * самого окна — половина его не видна никогда, и прочтение не наступило бы.
 */

import { S } from '../../../shared/strings.js';
import { relativeTime } from '../../lib/relative-time.js';
import { Badge } from '../../ui/badge.js';
import type { MessageModel } from './feed-model.js';
import { RoomMarkdown } from './RoomMarkdown.js';
import { SenderAvatar } from './SenderAvatar.js';

/**
 * Вид сообщения → вид тега: вопрос — accent, решение — accent-2, заметка — neutral (1.3). Лента стоит на
 * листе, где `neutral-100` светлой темы — сам лист, а `accent-100` и `accent-2-100` от него неотличимы, поэтому
 * все три — виды `*-sheet` (в светлой заливка 200, в тёмной прежняя 100).
 */
const TAG_VARIANT = { question: 'accent-sheet', decision: 'accent-2-sheet', note: 'neutral-sheet' } as const;

export interface RoomMessageProps {
  message: MessageModel;
  now: Date;
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  observeRef?: (el: HTMLElement | null) => void;
}

export function RoomMessage({ message, now, labelOf, onOpenExternal, observeRef }: RoomMessageProps): JSX.Element {
  return (
    <div data-message-id={message.id} data-sender={message.sender.kind} className="flex max-w-[680px] gap-2.5">
      <div className="flex w-5 shrink-0 justify-center pt-px">
        <SenderAvatar kind={message.sender.kind} provider={message.sender.provider} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          ref={observeRef}
          data-message-meta={message.id}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          <span className="min-w-0 break-words font-semibold text-foreground">{message.from}</span>
          {message.lead ? (
            <span title={S.rooms.lead} className="text-accent-700">
              ★
            </span>
          ) : null}
          {message.to === null ? null : <span className="min-w-0 break-words">→ {message.to}</span>}
          <Badge variant={TAG_VARIANT[message.kind]}>{S.mail.kindTag[message.kind]}</Badge>
          <span>{relativeTime(message.at, now)}</span>
          {message.unread ? (
            <span
              role="img"
              aria-label={S.rooms.newMessage}
              title={S.rooms.newMessage}
              className="size-[7px] shrink-0 rounded-full bg-state-done"
            />
          ) : null}
        </div>
        <RoomMarkdown text={message.text} labelOf={labelOf} onOpenExternal={onOpenExternal} />
        {message.waiting.length > 0 ? (
          <span data-message-waiting className="text-xs text-muted-foreground">
            {S.rooms.notPickedUp(message.waiting.join(', '))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
