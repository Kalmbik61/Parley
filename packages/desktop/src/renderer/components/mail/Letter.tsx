/**
 * Одно письмо ленты «вся почта работы» (спека 5.1, 6.3): шапка — время,
 * отправитель, адресат, вид письма; тело — markdown. Кегли — спека 4.3,
 * поведение куска 1.4: заголовок письма 12px muted, тело 14px обычным цветом
 * (было наоборот — старая палитра темы окна красила шапку в полный цвет, а
 * тело приглушала).
 *
 * `react-markdown` + `remark-gfm`, **без** `rehype-raw` (план куска, файлы):
 * без него `<script>…</script>` в тексте письма попадает в дерево как узел
 * `html` и на выходе печатается экранированным текстом, а не исполняется —
 * проверено (`renderToStaticMarkup`) и это ровно то, что просит спека 9.1/CSP:
 * агент не должен получить исполнение произвольного HTML через письмо.
 * Добавлять `rehype-raw` для «поддержки HTML» специально не нужно и вредно.
 *
 * Карточка вкладки «Почта» в облике Organic (спека окна 2026-09-29, 1.8): до 640px, тег вида, `S03 ревью →
 * you`, время, точка `accent-600` у непрочитанного, текст 14px. Лента комнаты рисует свои сообщения
 * (`rooms/RoomMessage.tsx`) и `Letter` не зовёт.
 *
 * Ссылки — через `app.openExternal` (дизайн окна 5.3, `use-terminal.ts` делает
 * то же для ссылок терминала): обычный переход в песочнице `contextIsolation`
 * открыл бы чужой домен в самом окне, а не в системном браузере.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { S } from '../../../shared/strings.js';
import type { LetterView } from '../../lib/mail-view.js';
import { Badge } from '../../ui/badge.js';

export interface LetterProps {
  letter: LetterView;
  onOpenExternal: (url: string) => void;
  /** Ref корня письма — наблюдатель «прочитано» панели (`attention/use-mark-read.ts`, кусок 4.2). */
  observeRef?: (el: HTMLElement | null) => void;
}

function markdownComponents(onOpenExternal: (url: string) => void): Components {
  return {
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (href !== undefined) onOpenExternal(href);
        }}
        className="text-primary underline"
      >
        {children}
      </a>
    ),
    // Инлайн-код и блок кода react-markdown отличает наличием `className`
    // (`language-xxx` ставит только код внутри ``` — remark-rehype кладёт его
    // на дочерний `<code>` фенса, у инлайн-кода класса нет).
    code: ({ className, children }) => (
      <code
        className={`rounded bg-muted font-mono text-[0.9em] ${
          className !== undefined ? 'block overflow-x-auto p-2' : 'px-1'
        }`}
      >
        {children}
      </code>
    ),
  };
}

/** Вид письма → вид тега: вопрос — accent, решение — accent-2, заметка — neutral (1.8). */
const TAG_VARIANT = { question: 'accent', decision: 'accent-2', note: 'neutral' } as const;

export function Letter({ letter, onOpenExternal, observeRef }: LetterProps): JSX.Element {
  const body = (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenExternal)}>
      {letter.text}
    </ReactMarkdown>
  );

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
        {body}
      </div>
    </div>
  );
}
