/**
 * Разбор Markdown комнаты — чистая часть без React и DOM: плагины remark, которыми `RoomMarkdown` превращает
 * исходник сообщения или решения в дерево, и вопрос «есть ли в тексте упоминание человека». Лента и внимание
 * окна читают `@human` одним и тем же разбором: чип «@you» рисуется ровно там, где этот модуль находит узел
 * упоминания, и счётчик, Dock и уведомление (`attention/derive.ts#isHumanMention`) считают ровно такие же.
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
 *  — картинка без `alt` и ссылка без подписи — своим адресом (`RoomImage`, `components.a` в `RoomMarkdown`).
 * Инвариант — «слова исходника не пропадают из текста» — держит `RoomMarkdown.test.tsx`.
 *
 * Плагин `remarkMentions` режет текстовые узлы по токенам (`mention.ts`): `@s02` — упоминание сессии, `@human` —
 * упоминание человека; перенос строки (Shift+Enter в поле ввода) — `break`, как у `remark-breaks`, которого в
 * зависимостях нет. Упоминанием становится токен в обычном тексте — абзаца, заголовка, цитаты, пункта, ячейки,
 * выделения. Не становится в `inlineCode`, `code` и `html` (листья со своим `value`, а не `text`), в детях `link` и
 * `linkReference` (`@s02` в адресе — часть адреса, а чип внутри `<a>` открывал бы ссылку, а не участника) и в тексте,
 * который `remarkReveal` вставил как есть (`literal`).
 *
 * Свой `@human` человека — не чип «@you» (Parley 0.3.0): себя человек не упоминает, а чип «для тебя» в его же слове
 * выглядел бы странно. Опция `humanChips: false` оставляет `@human` обычным текстом; ленту с ней рисует
 * `RoomMessage` для сообщений человека (`remarkPluginsFor`). Внимание окна от этого не меняется: сообщения человека оно
 * и так не считает упоминаниями (`attention/derive.ts#isHumanMention`), поэтому `hasHumanMention` — без опции.
 *
 * Списки плагинов (`REMARK_PLUGINS`, `INLINE_REMARK_PLUGINS` и их двойники без чипа человека) собраны здесь же: ими
 * разбирает `RoomMarkdown`, а основным из них — и `hasHumanMention`. Правка плагинов правит всех сразу — расходиться им
 * негде.
 */

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified, type PluggableList } from 'unified';
import { S } from '../../../shared/strings.js';
import { markdownTooDeep } from '../../lib/markdown-depth.js';
import { sessionTag } from '../../lib/participant.js';
import { splitFeedMentions } from './mention.js';

/**
 * Атрибуты, с которыми узлы упоминаний попадают в hast, а оттуда — в `components.span` ленты: по ним она узнаёт
 * чип сессии и чип «@you».
 */
export const MENTION_ATTR = 'data-mention';
export const HUMAN_MENTION_ATTR = 'data-mention-human';

/**
 * Узел mdast в той мере, в какой его читает и пишет плагин (и выдержка, `excerpt.ts`). Пакета типов `mdast` в
 * зависимостях окна нет (его тянет только `react-markdown`), поэтому форма своя.
 */
export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
  /** Текст вставлен как есть (исходник, подпись, title): упоминания в нём не разбираются. */
  literal?: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
  /** `link` и `image`. */
  title?: string | null;
  /** `image` и `imageReference`: то, что лента показывает вместо картинки. */
  alt?: string | null;
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

/**
 * Узел — подпись над блоком кода (язык и всё за ```): `remarkReveal` ставит её абзацем перед самим блоком. Это
 * метка кода, а не текст сообщения: выдержка (`excerpt.ts`) её пропускает и берёт строку кода.
 */
export function isCodeCaption(node: MdNode): boolean {
  return node.type === 'paragraph' && node.data?.hProperties?.className === CAPTION_CLASS;
}

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
export function remarkReveal() {
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
    data: { hName: 'span', hProperties: { [MENTION_ATTR]: sessionId } },
  };
}

/**
 * Упоминание человека `@human`: тот же приём — `<span data-mention-human>` с текстом «@you», а `components.span`
 * подменяет его чипом (`HumanMentionChip`).
 */
function humanMentionNode(): MdNode {
  return {
    type: 'text',
    value: S.rooms.humanMention,
    data: { hName: 'span', hProperties: { [HUMAN_MENTION_ATTR]: '' } },
  };
}

/** Узел — то, что `humanMentionNode` ставит вместо `@human`: из него лента делает чип «@you». */
function isHumanMentionNode(node: MdNode): boolean {
  return node.data?.hProperties?.[HUMAN_MENTION_ATTR] !== undefined;
}

/**
 * Текстовый узел → текст, упоминания и `break` на каждом переводе строки (в строчном виде `\n` остаётся
 * в тексте и читается пробелом). Разбор токенов — `mention.ts`. `@human` — чип, а при `humanChips: false` —
 * обычный текст, как он написан.
 */
function expandText(
  value: string,
  lineBreaks: boolean,
  literal: boolean,
  humanChips: boolean,
): MdNode[] {
  const out: MdNode[] = [];
  const segments = literal ? [{ kind: 'text' as const, text: value }] : splitFeedMentions(value);
  for (const segment of segments) {
    if (segment.kind === 'mention') {
      out.push(mentionNode(segment.sessionId));
      continue;
    }
    if (segment.kind === 'human' && humanChips) {
      out.push(humanMentionNode());
      continue;
    }
    const text = segment.kind === 'human' ? segment.raw : segment.text;
    if (!lineBreaks) {
      out.push({ type: 'text', value: text });
      continue;
    }
    text.split(LINE_BREAK).forEach((line, index) => {
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
function expandChildren(parent: MdNode, lineBreaks: boolean, humanChips: boolean): void {
  if (parent.children === undefined) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value !== undefined) {
      next.push(...expandText(child.value, lineBreaks, child.literal === true, humanChips));
      continue;
    }
    if (!LITERAL_PARENTS.has(child.type)) expandChildren(child, lineBreaks, humanChips);
    next.push(child);
  }
  parent.children = next;
}

/**
 * Плагин remark: упоминания и переносы строк в текстовых узлах. `humanChips` (по умолчанию `true`): `@human` — чип
 * «@you»; `false` — обычный текст (сообщение самого человека).
 */
export function remarkMentions(options?: { lineBreaks?: boolean; humanChips?: boolean }) {
  const lineBreaks = options?.lineBreaks ?? true;
  const humanChips = options?.humanChips ?? true;
  return (tree: MdNode): void => expandChildren(tree, lineBreaks, humanChips);
}

/** Кандидат в путь: подряд идущие буквы, цифры и `._@+~/-`; что из этого путь, решает `isPathToken`. */
const PATH_RUN = /[\w.@+~/-]+/g;
/** Хвост, который к пути не относится: точка или запятая в конце фразы, двоеточие перед пояснением. */
const PATH_TRAILER = /[.,;:!?]+$/;
/** Последний сегмент с расширением файла, можно со строками: `store.py`, `rate_limit.py:40-72`. */
const FILE_SEGMENT = /\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?:-\d+)?)?$/;
/** Корни проекта, за которыми идёт путь и без расширения: `src/features/documents`. */
const PROJECT_ROOTS = new Set(['src', 'packages', 'apps', 'lib', 'libs', 'test', 'tests', 'docs', 'e2e', 'scripts']);

/**
 * Путь к файлу или папке — по строгому правилу, чтобы дроби и перечисления через слэш (`200/201/204`,
 * `guest/patient/administrator`, `PDF/JPEG/PNG`, `and/or`) остались текстом. Путь — это сегменты через `/` с хотя бы
 * одной латинской буквой и одно из: файл с расширением в конце, начало `~/`, `./`, `../` или `/`, первая папка-точка
 * (`.omc/…`, `.parley/…`) или корень проекта (`src/…`, `packages/…`). Путь папки без такого признака
 * (`features/documents/api`) не узнаётся: отличить его от перечисления нечем.
 */
export function isPathToken(token: string): boolean {
  if (!token.includes('/') || token.includes('//') || !/[A-Za-z]/.test(token)) return false;
  const segments = token.replace(/^(?:~|\.{1,2})?\//, '').replace(/\/$/, '').split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) return false;
  if (/^(?:~|\.{1,2})?\//.test(token)) return true;
  const [first = ''] = segments;
  if (/^\.[A-Za-z][\w-]*$/.test(first) || PROJECT_ROOTS.has(first)) return true;
  return FILE_SEGMENT.test(segments[segments.length - 1] ?? '');
}

/** Текстовый узел → текст и `inlineCode` на месте путей. */
function codePathsIn(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(PATH_RUN)) {
    const token = match[0].replace(PATH_TRAILER, '');
    const start = match.index ?? 0;
    if (!isPathToken(token)) continue;
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
    out.push({ type: 'inlineCode', value: token });
    last = start + token.length;
  }
  if (last === 0) return [{ type: 'text', value }];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function codePathsChildren(parent: MdNode): void {
  if (parent.children === undefined) return;
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'text' && child.value !== undefined && child.literal !== true) return codePathsIn(child.value);
    if (!LITERAL_PARENTS.has(child.type)) codePathsChildren(child);
    return [child];
  });
}

/**
 * Плагин remark: пути к файлам и папкам — `code` (письма Parley и системные строки ленты, `RoomMessage`). Код и ссылки
 * не трогаются: путь в обратных кавычках уже код, а в адресе ссылки — часть адреса. Стоит до `remarkMentions`: тот режет
 * текст на упоминания и строки, а пути внутри строки целиком.
 */
export function remarkCodePaths() {
  return (tree: MdNode): void => codePathsChildren(tree);
}

export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkReveal, remarkMentions];
/** Письма Parley и системные строки: пути — кодом (`remarkCodePaths`). */
const CODE_PATH_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkReveal, remarkCodePaths, remarkMentions];
export const INLINE_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkReveal,
  [remarkMentions, { lineBreaks: false }],
];
/** Те же списки для сообщения человека: `@human` в них — текст, а не чип «@you». */
const PLAIN_HUMAN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkReveal,
  [remarkMentions, { humanChips: false }],
];
const PLAIN_HUMAN_INLINE_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkReveal,
  [remarkMentions, { lineBreaks: false, humanChips: false }],
];

/**
 * Список плагинов для вида (`inline` — строчный вид плашки решений) и правила `@human` (`humanChips`). Списки
 * готовые и каждый раз те же: по ним `RoomMarkdown` решает, нужен ли новый разбор. Пути кодом (`codePaths`) — только у
 * сообщения ленты целиком с чипом «@you», так их и рисует `RoomMessage` для писем Parley; в остальных видах флаг не
 * нужен и не действует.
 */
export function remarkPluginsFor(inline: boolean, humanChips: boolean, codePaths = false): PluggableList {
  if (codePaths && !inline && humanChips) return CODE_PATH_REMARK_PLUGINS;
  if (humanChips) return inline ? INLINE_REMARK_PLUGINS : REMARK_PLUGINS;
  return inline ? PLAIN_HUMAN_INLINE_REMARK_PLUGINS : PLAIN_HUMAN_REMARK_PLUGINS;
}

/** В дереве есть узел упоминания человека: тот, что лента превращает в чип «@you». */
function containsHumanMention(node: MdNode): boolean {
  return isHumanMentionNode(node) || (node.children?.some(containsHumanMention) ?? false);
}

/**
 * Разбор Markdown без перевода в hast и React (`remark-rehype` и отрисовка здесь не нужны): те же `remark-parse`,
 * GFM и плагины, что у ленты. Процессор один на модуль: после первого разбора он заморожен, и состояния между
 * разборами у него нет.
 */
const processor = unified().use(remarkParse).use(REMARK_PLUGINS);

/**
 * Быстрый отсев: упоминание человека бывает только в тексте с подстрокой `@human` (регистр не важен, флаги —
 * как у токена в `mention.ts`) или со ссылкой на символ (`&#64;human`, `&commat;human`): разбор превращает её в
 * обычный текст, и лента рисует чип. Подавляющее большинство сообщений не содержит ни того, ни другого и разбора
 * не получает.
 */
const HUMAN_HINT = /@human|&#|&commat;/iu;

/** Кеш ответов: внимание пересчитывается на каждое событие активности, а текст сообщения не меняется. */
const HUMAN_MENTION_CACHE_MAX = 500;
const humanMentionCache = new Map<string, boolean>();

/**
 * В тексте есть упоминание человека `@human` — по тому же разбору Markdown, которым лента рисует чип «@you»:
 * в тексте абзаца, пункта, цитаты, ячейки и выделения (`**@human**`, `_@human_`) оно есть, а в инлайн-коде,
 * блоке кода, сыром HTML, подписи и адресе ссылки (`[ask @human](…)`, `https://github.com/@human`), `alt`
 * картинки и в email (`user@human.dev`) — нет. Границы токена — как у токена сессии (`mention.ts`).
 *
 * Разбор не должен ронять внимание окна: текст пишет агент, и вложенность глубже стека плагинов — `RangeError`.
 * Такой текст ленты не нарисовала бы, упоминанием он не считается. Цитаты глубже предела (`markdownTooDeep`)
 * лента рисует сырым текстом без чипов — их не разбирают и здесь.
 */
export function hasHumanMention(text: string): boolean {
  if (!HUMAN_HINT.test(text) || markdownTooDeep(text)) return false;
  const cached = humanMentionCache.get(text);
  if (cached !== undefined) return cached;
  let found: boolean;
  try {
    found = containsHumanMention(processor.runSync(processor.parse(text), text) as MdNode);
  } catch {
    found = false;
  }
  // Предел размера: при переполнении кеш очищается целиком — проще, чем вытеснять по одной записи.
  if (humanMentionCache.size >= HUMAN_MENTION_CACHE_MAX) humanMentionCache.clear();
  humanMentionCache.set(text, found);
  return found;
}
