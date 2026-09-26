/**
 * Одно письмо ленты «вся почта работы» (спека 5.1, 6.3): шапка — время,
 * отправитель, адресат, вид письма (заметку суффикс не помечает — перенос
 * `kindSuffix` из `tui/src/room-view.ts`); тело — markdown.
 *
 * `react-markdown` + `remark-gfm`, **без** `rehype-raw` (план куска, файлы):
 * без него `<script>…</script>` в тексте письма попадает в дерево как узел
 * `html` и на выходе печатается экранированным текстом, а не исполняется —
 * проверено (`renderToStaticMarkup`) и это ровно то, что просит спека 9.1/CSP:
 * агент не должен получить исполнение произвольного HTML через письмо.
 * Добавлять `rehype-raw` для «поддержки HTML» специально не нужно и вредно.
 *
 * Ссылки — через `app.openExternal` (дизайн окна 5.3, `use-terminal.ts` делает
 * то же для ссылок терминала): обычный переход в песочнице `contextIsolation`
 * открыл бы чужой домен в самом окне, а не в системном браузере.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LetterView } from '../../lib/mail-view.js';

export interface LetterProps {
  letter: LetterView;
  onOpenExternal: (url: string) => void;
}

/** Вид письма суффиксом заголовка: у заметки его нет (перенос из `room-view.ts`). */
function kindSuffix(kind: LetterView['kind']): string {
  if (kind === 'question') return ' · вопрос';
  if (kind === 'decision') return ' · решение';
  return '';
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
        className="text-[var(--h-blue)] underline"
      >
        {children}
      </a>
    ),
    // Инлайн-код и блок кода react-markdown отличает наличием `className`
    // (`language-xxx` ставит только код внутри ``` — remark-rehype кладёт его
    // на дочерний `<code>` фенса, у инлайн-кода класса нет).
    code: ({ className, children }) => (
      <code
        className={`rounded bg-[var(--h-surface)] font-mono text-[0.9em] ${
          className !== undefined ? 'block overflow-x-auto p-2' : 'px-1'
        }`}
      >
        {children}
      </code>
    ),
  };
}

export function Letter({ letter, onOpenExternal }: LetterProps): JSX.Element {
  return (
    <div data-letter-id={letter.id} className="py-2">
      <div className="flex items-center gap-1 text-sm text-[var(--h-text)]">
        {letter.unread ? (
          <span aria-label="непрочитано" className="text-[var(--h-blue)]">
            ▤
          </span>
        ) : null}
        <span>
          {letter.time} {letter.from} → {letter.to}
          {kindSuffix(letter.kind)}
        </span>
      </div>
      <div className="mt-1 text-sm text-[var(--h-subtext)]">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenExternal)}>
          {letter.text}
        </ReactMarkdown>
      </div>
    </div>
  );
}
