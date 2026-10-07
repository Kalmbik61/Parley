/**
 * Одно сообщение ленты комнаты (спека окна 2026-09-29, 1.3): аватар 18, мета — отправитель (600), `★`
 * у ведущего, `→ all` или `→ S02 бэкенд, S03 ревью`, тег вида, время, точка «непрочитано»; текст
 * 14px/1.55 — Markdown (GFM) с чипами (`RoomMarkdown.tsx`); под ним строка доставки
 * `✓ Picked up by S03 · ▤ Not picked up yet by S01 (busy), S02`. Системная строка — аватар системы без
 * адресата и без точки (решение контролёра 4 куска 6).
 *
 * Точка — токен `--state-done`, а не `accent-2-500` handoff: тот к листу светлой темы 2.6:1, ниже порога
 * 3:1 для признака состояния (решение 11 спеки — те же токены у значков состояний).
 *
 * Строка доставки (`message.delivery`) одна, когда у сообщения есть хотя бы один не закрытый адресат-агент: «забрали»
 * (`data-message-picked`, время каждого — в подсказке, а не в строке) и «ещё нет» (`data-message-waiting`; после тега
 * в скобках причина от хоста, `S01 (busy)`) через « · ». Текст идёт обычным потоком и переносится по словам, а
 * неразрывный (чужой id сессии) — по знакам: длинный список не раздвигает колонку и не даёт горизонтальной прокрутки.
 *
 * За «прочитано» (`observeRef`, `attention/use-mark-read.ts`) наблюдается строка меты, а не всё
 * сообщение: наблюдатель ждёт половину площади цели, а сообщение в 2000 знаков в невысоком окне выше
 * самого окна — половина его не видна никогда, и прочтение не наступило бы.
 *
 * Сообщение-ответ (`message.reply`, Parley 0.3.0) несёт цитату между метой и текстом: одна строка
 * `↩ S02 бэкенд: начало вопроса…` с акцентной чертой слева. Оригинал в этой комнате — кнопка, клик по ней зовёт
 * `onJumpTo(id)`; оригинала нет — тот же блок без кнопки. Имя кнопки — её видимый текст (подпись и выдержка), а
 * `title` показывает выдержку целиком, когда строка обрезана. Строка сообщения принимает фокус программно
 * (`tabIndex={-1}`): переход по цитате переносит его на оригинал, и читающий с клавиатуры продолжает оттуда.
 * Текст ответа — Markdown, как у любого сообщения.
 *
 * Свой `@human` человека (Parley 0.3.0) — текст, а не чип «@you»: себя человек не упоминает (`humanChips`); у сообщений
 * агентов чип остаётся — по нему агент зовёт человека.
 */

import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { isoMs } from '../../lib/iso-time.js';
import { relativeTime } from '../../lib/relative-time.js';
import { Badge } from '../../ui/badge.js';
import type { MessageModel, ReplyModel } from './feed-model.js';
import { planLetterMarkdown } from './plan-letter.js';
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
  /** Клик по цитате ответа: показать сообщение с этим id (прокрутить ленту и подсветить его). */
  onJumpTo: (messageId: string) => void;
  observeRef?: (el: HTMLElement | null) => void;
}

/**
 * `20:30:11` — время отметки «забрал» для подсказки: точное, в поясе окна (относительное «2m» ленты здесь ничего бы не
 * сказало — забирают за секунды). Не ISO-время — пусто, а не «Invalid Date».
 */
function clockTime(iso: string): string {
  const ms = isoMs(iso);
  return ms === null ? '' : new Date(ms).toTimeString().slice(0, 8);
}

/** Цитата — одна строка с обрезкой и акцентной чертой слева; у кнопки и у заглушки «оригинала нет» вид общий. */
const REPLY_QUOTE_CLASS =
  'block max-w-full self-start truncate border-l-2 border-(--color-accent) pl-2 text-left text-xs text-muted-foreground';

interface ReplyQuoteProps {
  reply: ReplyModel;
  onJumpTo: (messageId: string) => void;
}

function ReplyQuote({ reply, onJumpTo }: ReplyQuoteProps): JSX.Element {
  if (!reply.found) {
    return (
      <div data-message-reply-missing="" className={REPLY_QUOTE_CLASS}>
        <span aria-hidden="true">↩</span> {S.rooms.replyMissing}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-message-reply={reply.id}
      // Строка обрезается по ширине колонки — выдержка целиком видна подсказкой.
      title={reply.excerpt}
      onClick={() => onJumpTo(reply.id)}
      className={cn(REPLY_QUOTE_CLASS, 'cursor-pointer hover:text-foreground')}
    >
      <span aria-hidden="true">↩ </span>
      <span className="font-semibold">{reply.from}</span>
      {reply.excerpt === '' ? null : `: ${reply.excerpt}`}
    </button>
  );
}

export function RoomMessage({
  message,
  now,
  labelOf,
  onOpenExternal,
  onJumpTo,
  observeRef,
}: RoomMessageProps): JSX.Element {
  const { picked, waiting } = message.delivery;
  /** Письмо `parley` или системная строка. */
  const system = message.sender.kind === 'system';
  return (
    <div
      data-message-id={message.id}
      data-sender={message.sender.kind}
      tabIndex={-1}
      className="flex max-w-[680px] gap-2.5"
    >
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
        {message.reply === null ? null : <ReplyQuote reply={message.reply} onJumpTo={onJumpTo} />}
        <RoomMarkdown
          // Письмо плана от Parley — по разделам (`plan-letter.ts`), пути в письмах системы — кодом.
          text={system ? (planLetterMarkdown(message.text) ?? message.text) : message.text}
          labelOf={labelOf}
          onOpenExternal={onOpenExternal}
          humanChips={message.sender.kind !== 'human'}
          codePaths={system}
        />
        {picked.length === 0 && waiting.length === 0 ? null : (
          <div data-message-delivery="" className="break-words text-xs text-muted-foreground">
            {picked.length === 0 ? null : (
              <span
                data-message-picked=""
                title={picked.map(({ tag, at }) => `${tag} ${clockTime(at)}`.trim()).join(' · ')}
              >
                {S.rooms.pickedUp(picked.map(({ tag }) => tag).join(', '))}
              </span>
            )}
            {picked.length === 0 || waiting.length === 0 ? null : ' · '}
            {waiting.length === 0 ? null : (
              <span data-message-waiting="">
                {S.rooms.notPickedUp(
                  waiting
                    .map(({ tag, reason }) =>
                      reason === null ? tag : `${tag} (${S.rooms.mailWait[reason]})`,
                    )
                    .join(', '),
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
