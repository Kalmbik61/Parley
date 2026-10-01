/**
 * Текст сообщения и решения комнаты — Markdown (GFM) (спека окна 2026-09-29, 1.3, 1.4; 0.2.0). Раньше лента
 * печатала обычный текст (`MentionText`), теперь разметку разбирает `react-markdown` + `remark-gfm`, а токен
 * `@s02` остаётся тем же чипом, что в поле ввода: его вырезает из текстовых узлов маленький remark-плагин
 * (`room-remark.ts`), а сам чип рисует `MentionChip` — ярлык берётся при отрисовке (`labelOf`), и переименование
 * сессии обновляет чипы, не заставляя разбирать текст заново. Упоминание человека `@human` (Parley 0.3.0) плагин
 * вырезает так же, а рисует его `HumanMentionChip` — чип «@you» плотнее чипа сессии: так агент, обратившийся к
 * человеку, заметен в ленте (поле ввода человека `@human` не разбирает: себя человек не упоминает). Что считается
 * упоминанием, решает разбор в `room-remark.ts`: по нему же окно считает сообщение письмом человеку.
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
 * Человек видит всё, что прочтёт агент. По MCP агент получает исходный текст письма целиком, а Markdown при
 * отрисовке кое-что молча теряет — и человек принял бы решение, которого не видел. Плагин `remarkReveal`
 * (`room-remark.ts`, там же полный список) возвращает потерянное текстом, и в обычном, и в строчном виде:
 * определения ссылок и сносок, `title` ссылки и картинки, лишние ячейки таблицы, строку после ```; а картинка
 * без `alt` и ссылка без подписи называются здесь своим адресом (`RoomImage`, `components.a`).
 * Адрес за подписью ссылки или картинки с `alt` — как в любом Markdown — виден подсказкой `title`, а не
 * текстом. Инвариант — «слова исходника не пропадают из текста» — держит `RoomMarkdown.test.tsx`.
 *
 * Перенос строки (Shift+Enter в поле ввода) — `<br>`: плагин ставит его на каждом одиночном `\n`, как
 * `remark-breaks`, которого в зависимостях нет. `white-space: pre-line` на `li` не годится: `react-markdown`
 * кладёт `\n` между блоками внутри пункта, и вложенный или «свободный» список растёт вдвое пустыми строками.
 *
 * Типографика — потомковые селекторы на корне, как в `MarkdownPreview.tsx`, по токенам темы: светлая и тёмная.
 *
 * Строчный вид (`inline`) — для превью в одну строку, плашка решений `mail/Decisions.tsx` под `line-clamp-2`:
 * тот же разбор (GFM, упоминания, правила ссылок и HTML), но остаются только инлайновые элементы — жирный,
 * курсив, зачёркнутый, код, ссылки, чипы и флажки задач; заголовки, абзацы, списки, цитаты, таблицы и блоки
 * кода разворачиваются в свой текст (`allowedElements` + `unwrapDisallowed`), перенос строки — пробел, а не `<br>`.
 */

import { Children, createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { S } from '../../../shared/strings.js';
import { resolveMarkdownLink, safeUrlTransform } from '../../lib/markdown-links.js';
import { sessionTag } from '../../lib/participant.js';
import { HUMAN_MENTION_CHIP_CLASS, MENTION_CHIP_CLASS } from './mention.js';
import {
  HUMAN_MENTION_ATTR,
  INLINE_REMARK_PLUGINS,
  MENTION_ATTR,
  REMARK_PLUGINS,
} from './room-remark.js';

export interface RoomMarkdownProps {
  text: string;
  /** Ярлык участника для чипа: `S02 бэкенд`; неизвестной сессии — `S02`. */
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  /** Строчный вид для превью в одну строку (плашка решений): блоки сворачиваются в текст, корень — `span`. */
  inline?: boolean;
}

/**
 * Что остаётся в строчном виде; прочие элементы (блоки) заменяются своим содержимым. Флажок списка задач
 * остаётся: без него «- [ ] готово» читалось бы как «готово».
 */
const INLINE_ELEMENTS = ['a', 'code', 'del', 'em', 'img', 'input', 'span', 'strong'];

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

/** «@you»: ярлыка у человека нет, текст и подсказка — из `strings.ts`. */
function HumanMentionChip(): JSX.Element {
  return (
    <span
      data-mention-human=""
      title={S.rooms.humanMentionTitle}
      className={HUMAN_MENTION_CHIP_CLASS}
    >
      {S.rooms.humanMention}
    </span>
  );
}

/** Картинка внутри ссылки (значок-бейдж) отдаёт ссылке свой `alt`: вложенных `<a>` не бывает. */
const InsideLink = createContext(false);

/** Видимого содержимого нет: пусто или одни пробелы. */
function isBlank(content: ReactNode): boolean {
  return Children.toArray(content).every((part) => typeof part === 'string' && part.trim() === '');
}

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
  // Без `alt` картинка называется своим адресом: пустая молча не показала бы, что здесь была картинка.
  const label = isBlank(alt) ? (url ?? src ?? '') : (alt ?? '');
  if (url === null || insideLink) return <>{label}</>;
  return (
    <ExternalLink url={url} openExternal={openExternal}>
      {label}
    </ExternalLink>
  );
}

function markdownComponents(openExternal: (url: string) => void): Components {
  return {
    a: ({ href, children }) => {
      const url = externalUrl(href);
      // Ссылка без подписи называется своим адресом, как и картинка без `alt`.
      const label = isBlank(children) ? (href ?? '') : children;
      return url === null ? (
        <>{label}</>
      ) : (
        <ExternalLink url={url} openExternal={openExternal}>
          {label}
        </ExternalLink>
      );
    },
    img: ({ src, alt }) => <RoomImage src={src} alt={alt} openExternal={openExternal} />,
    // Единственные `span` в дереве — упоминания из плагина (`room-remark.ts`): сессии и человека.
    span: ({ node, children }) => {
      const sessionId = node?.properties[MENTION_ATTR];
      if (typeof sessionId === 'string') return <MentionChip sessionId={sessionId} />;
      return node?.properties[HUMAN_MENTION_ATTR] === undefined ? (
        <span>{children}</span>
      ) : (
        <HumanMentionChip />
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

/** Инлайн-код: моноширинный на `bg-muted`; одинаков в ленте и в строчном виде. */
const CODE_CLASS =
  '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]';

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
  CODE_CLASS,
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-1.5 [&_blockquote]:border-l-[3px] [&_blockquote]:border-neutral-400 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
].join(' ');

export function RoomMarkdown({
  text,
  labelOf,
  onOpenExternal,
  inline = false,
}: RoomMarkdownProps): JSX.Element {
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
        remarkPlugins={inline ? INLINE_REMARK_PLUGINS : REMARK_PLUGINS}
        components={components}
        allowedElements={inline ? INLINE_ELEMENTS : undefined}
        unwrapDisallowed={inline}
        // Штатная чистка react-markdown пропустила бы `mailto:`, `irc:`, `xmpp:`; своя — только http(s), пути и якоря.
        urlTransform={safeUrlTransform}
      >
        {text}
      </ReactMarkdown>
    ),
    [text, components, inline],
  );

  return (
    <LabelOf.Provider value={labelOf}>
      {inline ? (
        // Строчный корень стоит в строке рядом с подписью, а не блоком; из типографики ему нужен только инлайн-код.
        <span data-room-markdown="inline" className={CODE_CLASS}>
          {content}
        </span>
      ) : (
        <div data-room-markdown="" className={ROOT_CLASS}>
          {content}
        </div>
      )}
    </LabelOf.Provider>
  );
}
