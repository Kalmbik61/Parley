/**
 * Одно письмо ленты «вся почта работы» (спека 5.1, 6.3): шапка — время,
 * отправитель, адресат, вид письма; тело — markdown. Кегли — спека 4.3,
 * поведение куска 1.4: заголовок письма 12px muted, тело 14px обычным цветом
 * (было наоборот — старая палитра темы окна красила шапку в полный цвет, а
 * тело приглушала).
 *
 * Тело — тот же `RoomMarkdown`, что у ленты комнаты и «Chat» (`rooms/RoomMarkdown.tsx`): GFM без `rehype-raw` (сырой
 * HTML печатается текстом, исполнения агенту письмо не даёт — спека 9.1/CSP), ссылки только `http(s)`, Copy у блока
 * кода, ⌘/Ctrl-пути (`FilePathText`, контекст ставит `MailBody`). Упоминание `@s02` — чип, перенос строки — `<br>`, как
 * в комнате. Письмо пишет агент: если Markdown не осилил текст, `RoomMarkdown` показывает его сырым текстом.
 *
 * Карточка вкладки «Почта» в облике Organic (спека окна 2026-09-29, 1.8): до 640px, тег вида, `S03 ревью →
 * you`, время, точка `accent-600` у непрочитанного, текст 14px. Лента комнаты рисует свои сообщения
 * (`rooms/RoomMessage.tsx`) и `Letter` не зовёт.
 *
 * Ссылки — как в комнате: клик — вкладка встроенного браузера Parley, правый клик — меню, системный браузер —
 * `onOpenExternal` (`app.openExternal`): обычный переход в песочнице `contextIsolation` открыл бы чужой домен в самом окне.
 */

import { S } from '../../../shared/strings.js';
import type { LetterView } from '../../lib/mail-view.js';
import { Badge } from '../../ui/badge.js';
import { RoomMarkdown } from '../rooms/RoomMarkdown.js';

export interface LetterProps {
  letter: LetterView;
  onOpenExternal: (url: string) => void;
  /** Ref корня письма — наблюдатель «прочитано» панели (`attention/use-mark-read.ts`, кусок 4.2). */
  observeRef?: (el: HTMLElement | null) => void;
}

/** Ярлыков сессий у письма нет: чип упоминания — тег `@S02`. */
const noLabel = (): null => null;

/** Вид письма → вид тега: вопрос — accent, решение — accent-2, заметка — neutral (1.8). */
const TAG_VARIANT = { question: 'accent', decision: 'accent-2', note: 'neutral' } as const;

export function Letter({ letter, onOpenExternal, observeRef }: LetterProps): JSX.Element {
  return (
    <div
      ref={observeRef}
      data-letter-id={letter.id}
      className="flex min-w-0 max-w-[640px] flex-col gap-2 rounded-xl bg-background px-5 py-[18px] text-foreground"
    >
      <div data-letter-meta className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-700">
        <Badge variant={TAG_VARIANT[letter.kind]}>{S.mail.kindTag[letter.kind]}</Badge>
        <span className="min-w-0 break-words font-semibold text-foreground">{letter.from}</span>
        <span className="min-w-0 break-words">→ {letter.to}</span>
        <span>{letter.time}</span>
        {letter.unread ? (
          <span
            role="img"
            aria-label={S.mail.unreadAriaLabel}
            title={S.mail.unreadAriaLabel}
            className="size-2 shrink-0 rounded-full bg-accent-600"
          />
        ) : null}
      </div>
      <div data-letter-body className="min-w-0 break-words text-sm">
        <RoomMarkdown text={letter.text} labelOf={noLabel} onOpenExternal={onOpenExternal} />
      </div>
    </div>
  );
}
