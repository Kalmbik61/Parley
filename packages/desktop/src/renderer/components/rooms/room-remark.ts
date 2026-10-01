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
 * Список плагинов (`REMARK_PLUGINS`, `INLINE_REMARK_PLUGINS`) один: им разбирает `RoomMarkdown` и им же
 * `hasHumanMention`. Правка плагинов правит оба сразу — расходиться им негде.
 */

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified, type PluggableList } from 'unified';
import { S } from '../../../shared/strings.js';
import { sessionTag } from '../../lib/participant.js';
import { splitFeedMentions } from './mention.js';

/**
 * Атрибуты, с которыми узлы упоминаний попадают в hast, а оттуда — в `components.span` ленты: по ним она узнаёт
 * чип сессии и чип «@you».
 */
export const MENTION_ATTR = 'data-mention';
export const HUMAN_MENTION_ATTR = 'data-mention-human';

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
 * в тексте и читается пробелом). Разбор токенов — `mention.ts`.
 */
function expandText(value: string, lineBreaks: boolean, literal: boolean): MdNode[] {
  const out: MdNode[] = [];
  const segments = literal ? [{ kind: 'text' as const, text: value }] : splitFeedMentions(value);
  for (const segment of segments) {
    if (segment.kind === 'mention') {
      out.push(mentionNode(segment.sessionId));
      continue;
    }
    if (segment.kind === 'human') {
      out.push(humanMentionNode());
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
export function remarkMentions(options?: { lineBreaks?: boolean }) {
  const lineBreaks = options?.lineBreaks ?? true;
  return (tree: MdNode): void => expandChildren(tree, lineBreaks);
}

export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkReveal, remarkMentions];
export const INLINE_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkReveal,
  [remarkMentions, { lineBreaks: false }],
];

/** В дереве есть узел упоминания человека: тот, что лента превращает в чип «@you». */
function containsHumanMention(node: MdNode): boolean {
  return isHumanMentionNode(node) || (node.children?.some(containsHumanMention) ?? false);
}

/**
 * Разбор Markdown без перевода в hast и React (`remark-rehype` и отрисовка здесь не нужны): те же `remark-parse`,
 * GFM и плагины, что у ленты. Процессор один на модуль: после первого разбора он заморожен и разборов не
 * накапливает.
 */
const processor = unified().use(remarkParse).use(REMARK_PLUGINS);

/**
 * Быстрый отсев: упоминание человека бывает только в тексте с подстрокой `@human` (регистр не важен, флаги —
 * как у токена в `mention.ts`). Подавляющее большинство сообщений её не содержит и разбора не получает.
 */
const HUMAN_HINT = /@human/iu;

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
 * Такой текст ленты не нарисовала бы, упоминанием он не считается.
 */
export function hasHumanMention(text: string): boolean {
  if (!HUMAN_HINT.test(text)) return false;
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
