/**
 * Выдержка из текста сообщения комнаты (Parley 0.3.0) — короткая строка без разметки: цитата над ответом
 * (`feed-model.ts`) и тело уведомления об упоминании человека (`attention/notify.ts`). Правила одни, чтобы то,
 * что человек читает в ленте, и то, что приходит ему в уведомлении, не разошлось.
 *
 * Берётся первая подходящая строка текста: непустая, не ограда блока кода (```` ```ts ````, `~~~`) и не
 * тематический разрыв (`---`, `* * *`, `___`) — у них своего текста нет. Ограду и разрыв узнают после снятия
 * разметки начала строки, поэтому `> ```ts` и `- ```bash` — тоже ограды. Дальше строка очищается от простой
 * разметки Markdown: начало строки (`#`, `>`, маркер списка и флажок задачи `[ ]` / `[x]` за ним), ссылка
 * `[текст](адрес)` и картинка `![alt](адрес)` — до текста, `**`, `__`, `~~`. Инлайн-код остаётся кодом, как в
 * ленте: его содержимое не чистится и упоминания в нём не заменяются. Вне кода упоминания — как у чипов ленты
 * (`@s02` → `@S02 бэкенд`, `@human` → `@you`). Пробелы схлопываются, длиннее 140 знаков — 140 и `…`.
 *
 * Тексты пишут агенты и длины они не знают, а регулярки разметки на длинной строке дороги (ссылка с `[` без `]`
 * — квадратична): текст не делится на строки целиком, а читается строка за строкой до первой подходящей, и
 * любая строка до всякой регулярки обрезается до `LINE_MAX` знаков.
 */

import { S } from '../../../shared/strings.js';
import { sessionTag } from '../../lib/participant.js';
import { splitFeedMentions } from './mention.js';

/** Выдержка — не больше стольких знаков (графем: флаг и эмодзи с ZWJ — один знак); длиннее обрезается с `…`. */
const EXCERPT_MAX = 140;
/** Строка читается не дальше стольких знаков: на выдержку хватает с запасом, а длиннее регулярки дороги. */
const LINE_MAX = 1000;
/** Язык не задан: границы графем от него не зависят. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Один слой разметки начала строки: `#` заголовка, `>` цитаты, маркер списка (`-`, `*`, `+`, `1.`, `1)`) и флажок
 * задачи после него (`[ ]`, `[x]`). Слоёв бывает несколько подряд (`> - [ ] пункт`).
 */
const LINE_MARKER = /^\s*(?:#{1,6}\s+|>|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;
/** Тематический разрыв: три и больше одинаковых `-`, `*` или `_`, между ними можно пробелы. */
const THEMATIC_BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
/** Ограда блока кода. */
const CODE_FENCE = /^\s*(?:```|~~~)/;
/** Ссылка `[текст](адрес)` и картинка `![alt](адрес)` — от них остаётся текст. */
const LINK_MARKUP = /!?\[([^\]]*)\]\([^)]*\)/g;
/** Инлайн-код: серия обратных кавычек, содержимое и такая же серия (длиннее или короче серия — часть содержимого). */
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;
/** Вне кода: жирный, подчёркнутый, зачёркнутый (`**`, `__`, `~~`) и обрывки обратных кавычек без пары. */
const INLINE_MARKUP = /\*\*|__|~~|`/g;

/** Часть строки: инлайн-код (его содержимое, без кавычек) или всё остальное. */
interface Part {
  code: boolean;
  text: string;
}

/**
 * Строка `text[start, end)` не длиннее `LINE_MAX` знаков. Верхняя половина суррогатной пары на краю остаётся без
 * нижней — её отбрасывают, чтобы в выдержку не попал обломок знака.
 */
function capLine(text: string, start: number, end: number): string {
  let stop = Math.min(end, start + LINE_MAX);
  if (stop < end) {
    const last = text.charCodeAt(stop - 1);
    if (last >= 0xd800 && last <= 0xdbff) stop -= 1;
  }
  return text.slice(start, stop);
}

/**
 * Строка без разметки начала строки; `null` — строка в выдержку не годится: после любого слоя разметки она оказалась
 * тематическим разрывом (проверяется на каждом слое: `* * *` — разрыв, а не вложенные маркеры) или оградой кода.
 */
function lineContent(line: string): string | null {
  let rest = line;
  for (;;) {
    if (THEMATIC_BREAK.test(rest)) return null;
    const marker = LINE_MARKER.exec(rest);
    if (marker === null) break;
    rest = rest.slice(marker[0].length);
  }
  return CODE_FENCE.test(rest) ? null : rest;
}

/**
 * Первая подходящая строка текста, уже без разметки начала строки; `null` — подходящей нет. Текст читается строка
 * за строкой, а не делится целиком: нужна одна строка, а текст может быть любой длины.
 */
function firstLine(text: string): string | null {
  const lineEnd = /\r\n|\r|\n/g;
  let start = 0;
  for (;;) {
    lineEnd.lastIndex = start;
    const match = lineEnd.exec(text);
    const line = capLine(text, start, match === null ? text.length : match.index);
    if (line.trim() !== '') {
      const content = lineContent(line);
      if (content !== null) return content;
    }
    if (match === null) return null;
    start = match.index + match[0].length;
  }
}

/** Строка → части: инлайн-код и всё остальное, в порядке строки. */
function splitCode(line: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of line.matchAll(CODE_SPAN)) {
    if (match.index > last) parts.push({ code: false, text: line.slice(last, match.index) });
    parts.push({ code: true, text: match[2] as string });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push({ code: false, text: line.slice(last) });
  return parts;
}

/** Текст вне кода: простая разметка снята, упоминания — ярлыками, как у чипов ленты. */
function plainText(text: string, labelOf: (sessionId: string) => string | null): string {
  return splitFeedMentions(text.replace(INLINE_MARKUP, ''))
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : segment.kind === 'human'
          ? S.rooms.humanMention
          : `@${labelOf(segment.sessionId) ?? sessionTag(segment.sessionId)}`,
    )
    .join('');
}

/** Текст не длиннее `EXCERPT_MAX` знаков: длиннее — обрезан по графеме, без пробела перед `…`. */
function truncate(text: string): string {
  let count = 0;
  let cut = 0;
  for (const { index, segment } of GRAPHEMES.segment(text)) {
    if (count === EXCERPT_MAX) return `${text.slice(0, cut).trimEnd()}…`;
    count += 1;
    cut = index + segment.length;
  }
  return text;
}

/**
 * Выдержка из текста сообщения: см. шапку файла. Пусто, если от строки ничего не осталось (сообщение из одной
 * картинки без `alt`) или подходящей строки нет (одни ограды и разрывы): цитата тогда покажет только подпись.
 * `labelOf` — ярлык участника для упоминания, как у `RoomMarkdown`: `null` — сессии нет в карте, берётся тег.
 */
export function replyExcerpt(text: string, labelOf: (sessionId: string) => string | null): string {
  const line = firstLine(text);
  if (line === null) return '';
  const joined = splitCode(line.replace(LINK_MARKUP, '$1'))
    .map((part) => (part.code ? part.text : plainText(part.text, labelOf)))
    .join('');
  return truncate(joined.replace(/\s+/g, ' ').trim());
}
