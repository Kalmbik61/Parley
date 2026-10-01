/**
 * Текст сообщения и решения комнаты — Markdown (GFM) (спека окна 2026-09-29, 1.3, 1.4; 0.2.0). Раньше лента
 * печатала обычный текст (`MentionText`), теперь разметку разбирает `react-markdown` + `remark-gfm`, а токен
 * `@s02` остаётся тем же чипом, что в поле ввода: его вырезает из текстовых узлов маленький remark-плагин, а
 * сам чип рисует `MentionChip` — ярлык берётся при отрисовке (`labelOf`), и переименование сессии обновляет
 * чипы, не заставляя разбирать текст заново.
 *
 * Правила безопасности — те же, что у письма (`mail/Letter.tsx`) и у превью файлов
 * (`files/preview/MarkdownPreview.tsx`), агент не должен получить из комнаты ни исполнение, ни переход окна:
 *  — `rehype-raw` нет: сырой HTML попадает в дерево узлом `html` и печатается текстом;
 *  — ссылка активна только по `http(s)`, клик — `onOpenExternal` с `preventDefault` (переход в самом окне
 *    открыл бы чужой домен в песочнице). `javascript:`, `file:`, `data:`, `mailto:`, относительный путь,
 *    `//хост` и `#якорь` — текст без `href`. Адреса, которые связывает сам `remark-gfm` (`https://…`, `www.…`,
 *    почта), идут тем же путём;
 *  — `<img>` нет: CSP окна пускает только `img-src 'self' data: blob:`, удалённая картинка не загрузилась бы.
 *    Вместо неё — её `alt` текстом, у адреса `http(s)` — ссылкой по тем же правилам.
 *
 * Перенос строки (Shift+Enter в поле ввода) — `<br>`: плагин ставит его на каждом одиночном `\n`, как
 * `remark-breaks`, которого в зависимостях нет. `white-space: pre-line` на `li` не годится: `react-markdown`
 * кладёт `\n` между блоками внутри пункта, и вложенный или «свободный» список растёт вдвое пустыми строками.
 *
 * Типографика — потомковые селекторы на корне, как в `MarkdownPreview.tsx`, по токенам темы: светлая и тёмная.
 */

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveMarkdownLink, safeUrlTransform } from '../../lib/markdown-links.js';
import { sessionTag } from '../../lib/participant.js';
import { MENTION_CHIP_CLASS, splitMentions } from './mention.js';

export interface RoomMarkdownProps {
  text: string;
  /** Ярлык участника для чипа: `S02 бэкенд`; неизвестной сессии — `S02`. */
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
}

/**
 * Узел mdast в той мере, в какой его читает и пишет плагин. Пакета типов `mdast` в зависимостях окна нет
 * (его тянет только `react-markdown`), поэтому форма своя.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName: string; hProperties: Record<string, string> };
}

/**
 * Внутри ссылки текст остаётся как есть: `@s02` в адресе — часть адреса (`https://x.example/@s02`), а чип
 * внутри `<a>` открывал бы ссылку, а не участника.
 */
const LITERAL_PARENTS = new Set(['link', 'linkReference']);
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Упоминание: текстовый узел с `data.hName` — `mdast-util-to-hast` делает из него `<span data-mention="s-02">`
 * с этим текстом, а `components.span` подменяет его чипом (`MentionChip`).
 */
function mentionNode(sessionId: string): MdNode {
  return {
    type: 'text',
    value: `@${sessionTag(sessionId)}`,
    data: { hName: 'span', hProperties: { 'data-mention': sessionId } },
  };
}

/** Текстовый узел → текст, упоминания и `break` на каждом переводе строки. Разбор токена — `mention.ts`. */
function expandText(value: string): MdNode[] {
  const out: MdNode[] = [];
  for (const segment of splitMentions(value)) {
    if (segment.kind === 'mention') {
      out.push(mentionNode(segment.sessionId));
      continue;
    }
    segment.text.split(LINE_BREAK).forEach((line, index) => {
      if (index > 0) out.push({ type: 'break' });
      if (line !== '') out.push({ type: 'text', value: line });
    });
  }
  return out;
}

/**
 * Код (`inlineCode`, `code`) и разметка HTML — узлы-листья со своим `value`, а не `text`: их плагин не
 * трогает, `@s02` в них остаётся буквальным.
 */
function expandChildren(parent: MdNode): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value !== undefined) {
      next.push(...expandText(child.value));
      continue;
    }
    if (!LITERAL_PARENTS.has(child.type)) expandChildren(child);
    next.push(child);
  }
  parent.children = next;
}

/** Плагин remark: упоминания и переносы строк в текстовых узлах. */
function remarkMentions() {
  return (tree: MdNode): void => expandChildren(tree);
}

const REMARK_PLUGINS = [remarkGfm, remarkMentions];

/** Ярлык участника для чипа — из контекста: разобранное дерево от `labelOf` не зависит. */
const LabelOf = createContext<RoomMarkdownProps['labelOf']>(() => null);

function MentionChip({ sessionId }: { sessionId: string }): JSX.Element {
  const labelOf = useContext(LabelOf);
  return (
    <span data-mention={sessionId} className={MENTION_CHIP_CLASS}>
      @{labelOf(sessionId) ?? sessionTag(sessionId)}
    </span>
  );
}

/** Картинка внутри ссылки (значок-бейдж) отдаёт ссылке свой `alt`: вложенных `<a>` не бывает. */
const InsideLink = createContext(false);

/** Адрес для клика: только `http(s)`; всё прочее (схемы, пути, `//хост`, `#якорь`) — `null`, то есть текст. */
function externalUrl(href: string | undefined): string | null {
  const link = resolveMarkdownLink(href ?? '', '');
  return link?.kind === 'external' ? link.url : null;
}

function ExternalLink({
  url,
  openExternal,
  children,
}: {
  url: string;
  openExternal: (url: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <InsideLink.Provider value>
      <a
        href={url}
        // Подпись ссылки может скрывать адрес (`[Accept](https://…)`): окно показывает его подсказкой.
        title={url}
        onClick={(event) => {
          event.preventDefault();
          openExternal(url);
        }}
        className="text-primary underline"
      >
        {children}
      </a>
    </InsideLink.Provider>
  );
}

function RoomImage({
  src,
  alt,
  openExternal,
}: {
  src: string | undefined;
  alt: string | undefined;
  openExternal: (url: string) => void;
}): JSX.Element {
  const insideLink = useContext(InsideLink);
  const url = externalUrl(src);
  const label = alt ?? '';
  if (url === null || insideLink) return <>{label}</>;
  // Без `alt` ссылка называется своим адресом: пустая молча не показала бы, что здесь была картинка.
  return (
    <ExternalLink url={url} openExternal={openExternal}>
      {label === '' ? url : label}
    </ExternalLink>
  );
}

function markdownComponents(openExternal: (url: string) => void): Components {
  return {
    a: ({ href, children }) => {
      const url = externalUrl(href);
      return url === null ? (
        <>{children}</>
      ) : (
        <ExternalLink url={url} openExternal={openExternal}>
          {children}
        </ExternalLink>
      );
    },
    img: ({ src, alt }) => <RoomImage src={src} alt={alt} openExternal={openExternal} />,
    // Единственные `span` в дереве — упоминания из плагина выше.
    span: ({ node, children }) => {
      const sessionId = node?.properties['data-mention'];
      return typeof sessionId === 'string' ? (
        <MentionChip sessionId={sessionId} />
      ) : (
        <span>{children}</span>
      );
    },
    // Широкая таблица прокручивается в своей обёртке, а не раздвигает ленту.
    table: ({ children }) => (
      <div className="my-1.5 overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
  };
}

const ROOT_CLASS = [
  // Размер и перенос — как у прежнего обычного текста: 14px/1.55, длинные слова и адреса переносятся.
  'min-w-0 text-sm leading-[1.55] break-words [overflow-wrap:anywhere] [text-wrap:pretty]',
  // Блоки: между абзацами небольшие отступы, а у первого и последнего блока снаружи их нет — текст сидит
  // в сообщении и в карточке решения ровно там, где сидел обычный.
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1.5',
  // Заголовки: полужирные и умеренные — лента комнаты разговор, а не документ.
  '[&_:is(h1,h2,h3,h4,h5,h6)]:mt-3 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
  '[&_h1]:text-base [&_h2]:text-[15px]',
  // Списки: preflight Tailwind снимает и маркеры, и отступ слева.
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li_ul]:my-0.5 [&_li_ol]:my-0.5',
  // Список задач (`- [ ] …`): вместо маркера у пункта флажок.
  '[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0 [&_input]:mr-1.5',
  // Код: инлайн — моноширинный на `bg-muted`; блок — то же плюс горизонтальная прокрутка, а код в нём без
  // собственной подложки.
  '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-1.5 [&_blockquote]:border-l-[3px] [&_blockquote]:border-neutral-400 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
].join(' ');

export function RoomMarkdown({ text, labelOf, onOpenExternal }: RoomMarkdownProps): JSX.Element {
  // Один набор компонентов на экземпляр: новые функции React счёл бы новыми типами и пересоздал бы ссылки и
  // таблицы при каждой перерисовке ленты — выделение текста в них сбрасывалось бы. Колбэк читается из ref.
  const openRef = useRef(onOpenExternal);
  openRef.current = onOpenExternal;
  const components = useMemo(() => markdownComponents((url) => openRef.current(url)), []);

  // Разбор Markdown — ~0.5 мс на сообщение, а лента перерисовывается на каждое событие активности (`RoomBody`
  // подписан на всю карту) и каждый раз зовёт со свежими `labelOf` и `onOpenExternal`. Дерево от них не зависит
  // (ярлыки чипам отдаёт контекст), поэтому пока текст тот же, элемент остаётся прежним и React не разбирает его
  // заново. Замыканий над `labelOf` в нём нет: иначе каждое сообщение держало бы устаревшую карту работы.
  const content = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        // Штатная чистка react-markdown пропустила бы `mailto:`, `irc:`, `xmpp:`; своя — только http(s), пути и якоря.
        urlTransform={safeUrlTransform}
      >
        {text}
      </ReactMarkdown>
    ),
    [text, components],
  );

  return (
    <LabelOf.Provider value={labelOf}>
      <div data-room-markdown="" className={ROOT_CLASS}>
        {content}
      </div>
    </LabelOf.Provider>
  );
}
