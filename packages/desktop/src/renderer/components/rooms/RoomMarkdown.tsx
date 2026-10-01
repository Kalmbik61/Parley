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
 * Человек видит всё, что прочтёт агент. По MCP агент получает исходный текст письма целиком, а Markdown при
 * отрисовке кое-что молча теряет — и человек принял бы решение, которого не видел. Плагин `remarkReveal`
 * возвращает потерянное текстом, и в обычном, и в строчном виде:
 *  — определение ссылки `[x]: адрес "title"` — абзац с исходным текстом (узел остаётся: ссылки `[текст][x]`
 *    работают);
 *  — определение сноски `[^a]: …` — абзац с исходным текстом (сноска не рисуется, ссылка на неё — номер);
 *  — `title` ссылки и картинки — ` (title)` сразу за ней;
 *  — таблица, в какой-то строке которой ячеек больше, чем в заголовке (лишние Markdown отбрасывает), — блок
 *    кода с исходником таблицы;
 *  — строка после ``` (язык и всё за ним) — подпись над блоком кода;
 *  — картинка без `alt` и ссылка без подписи — своим адресом (`RoomImage`, `components.a`).
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
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveMarkdownLink, safeUrlTransform } from '../../lib/markdown-links.js';
import { sessionTag } from '../../lib/participant.js';
import { MENTION_CHIP_CLASS, splitMentions } from './mention.js';

export interface RoomMarkdownProps {
  text: string;
  /** Ярлык участника для чипа: `S02 бэкенд`; неизвестной сессии — `S02`. */
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  /** Строчный вид для превью в одну строку (плашка решений): блоки сворачиваются в текст, корень — `span`. */
  inline?: boolean;
}

/**
 * Узел mdast в той мере, в какой его читает и пишет плагин. Пакета типов `mdast` в зависимостях окна нет
 * (его тянет только `react-markdown`), поэтому форма своя.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
  /** Текст вставлен как есть (исходник, подпись, title): упоминания в нём не разбираются. */
  literal?: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
  /** `link` и `image`. */
  title?: string | null;
  /** `code`: язык и остаток строки после тройных кавычек. */
  lang?: string | null;
  meta?: string | null;
  /** `table`: выравнивание столбцов, по нему считается число столбцов. */
  align?: unknown[];
}

/**
 * Внутри ссылки текст остаётся как есть: `@s02` в адресе — часть адреса (`https://x.example/@s02`), а чип
 * внутри `<a>` открывал бы ссылку, а не участника.
 */
const LITERAL_PARENTS = new Set(['link', 'linkReference']);
const LINE_BREAK = /\r\n|\r|\n/;

/** Мелкая приглушённая подпись над блоком кода. */
const CAPTION_CLASS = 'text-xs text-muted-foreground';

/** Абзац из готового текста, который не разбирается дальше: это исходник, а не разметка. */
function literalParagraph(value: string, className?: string): MdNode {
  return {
    type: 'paragraph',
    children: [{ type: 'text', value, literal: true }],
    ...(className === undefined ? {} : { data: { hProperties: { className } } }),
  };
}

/** Исходный текст узла — ровно то, что прочтёт агент. */
function sourceOf(node: MdNode, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? '' : source.slice(start, end);
}

/**
 * В какой-то строке ячеек больше, чем столбцов в заголовке: лишние `mdast-util-to-hast` отбрасывает молча
 * (строки короче дополняет пустыми — там терять нечего).
 */
function hasExcessCells(table: MdNode): boolean {
  const columns = table.align?.length;
  return (
    columns !== undefined &&
    (table.children ?? []).some((row) => (row.children?.length ?? 0) > columns)
  );
}

/** Что Markdown прячет при отрисовке, а агент читает: см. шапку файла. */
function revealHidden(parent: MdNode, source: string): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    const raw = sourceOf(child, source);
    if (child.type === 'definition' && raw !== '') {
      // Узел остаётся: по нему `mdast-util-to-hast` собирает адреса ссылок `[текст][метка]`.
      next.push(child, literalParagraph(raw));
      continue;
    }
    if (child.type === 'footnoteDefinition' && raw !== '') {
      next.push(literalParagraph(raw));
      continue;
    }
    if (child.type === 'table' && raw !== '' && hasExcessCells(child)) {
      next.push({ type: 'code', value: raw });
      continue;
    }
    if (child.type === 'code') {
      const info = [child.lang, child.meta]
        .filter((part) => part !== null && part !== undefined && part !== '')
        .join(' ');
      if (info !== '') next.push(literalParagraph(info, CAPTION_CLASS));
      next.push(child);
      continue;
    }
    revealHidden(child, source);
    next.push(child);
    if (
      (child.type === 'link' || child.type === 'image') &&
      typeof child.title === 'string' &&
      child.title !== ''
    ) {
      next.push({ type: 'text', value: ` (${child.title})`, literal: true });
    }
  }
  parent.children = next;
}

/** Плагин remark: возвращает текстом то, что Markdown прячет (исходник берётся из `file`, позиции — из узлов). */
function remarkReveal() {
  return (tree: MdNode, file: { toString(): string }): void => revealHidden(tree, String(file));
}

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

/**
 * Текстовый узел → текст, упоминания и `break` на каждом переводе строки (в строчном виде `\n` остаётся
 * в тексте и читается пробелом). Разбор токена — `mention.ts`.
 */
function expandText(value: string, lineBreaks: boolean, literal: boolean): MdNode[] {
  const out: MdNode[] = [];
  for (const segment of literal ? [{ kind: 'text' as const, text: value }] : splitMentions(value)) {
    if (segment.kind === 'mention') {
      out.push(mentionNode(segment.sessionId));
      continue;
    }
    if (!lineBreaks) {
      out.push({ type: 'text', value: segment.text });
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
function expandChildren(parent: MdNode, lineBreaks: boolean): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value !== undefined) {
      next.push(...expandText(child.value, lineBreaks, child.literal === true));
      continue;
    }
    if (!LITERAL_PARENTS.has(child.type)) expandChildren(child, lineBreaks);
    next.push(child);
  }
  parent.children = next;
}

/** Плагин remark: упоминания и переносы строк в текстовых узлах. */
function remarkMentions(options?: { lineBreaks?: boolean }) {
  const lineBreaks = options?.lineBreaks ?? true;
  return (tree: MdNode): void => expandChildren(tree, lineBreaks);
}

type RemarkPlugins = NonNullable<Options['remarkPlugins']>;
const REMARK_PLUGINS: RemarkPlugins = [remarkGfm, remarkReveal, remarkMentions];
const INLINE_REMARK_PLUGINS: RemarkPlugins = [
  remarkGfm,
  remarkReveal,
  [remarkMentions, { lineBreaks: false }],
];

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
