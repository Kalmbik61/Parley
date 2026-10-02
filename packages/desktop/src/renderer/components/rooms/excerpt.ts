/**
 * Выдержка из текста сообщения комнаты (Parley 0.3.0) — короткая строка без разметки: цитата над ответом
 * (`feed-model.ts`) и тело уведомления об упоминании человека (`attention/notify.ts`). Правила одни, чтобы то,
 * что человек читает в ленте, и то, что приходит ему в уведомлении, не разошлось.
 *
 * Выдержка строится из того же разбора Markdown, что и лента: `unified` + `remark-parse` и те же плагины
 * (`room-remark.ts`, как у `hasHumanMention`), а правила — обход дерева mdast. Прежние регулярки разметки местами
 * расходились с лентой: `[ask @human](url)` в цитате давало «@you», а лента рисует ссылку с буквальным текстом.
 *
 * Вход обрезается до `INPUT_MAX` кодовых единиц до разбора — суррогатная пара не рвётся: выдержке нужно начало, а
 * разбор длинного текста дорог. Блоки читаются по порядку документа, берётся первый, давший непустой текст:
 *  — абзац, заголовок, пункт списка, ячейка таблицы — их строчный текст; цитата — по её детям;
 *  — блок кода и сырой HTML (лента показывает его текстом) — первая непустая строка, буквально;
 *  — тематический разрыв пропускается, как и подпись языка над блоком кода (`isCodeCaption`: это метка кода, а не
 *    текст сообщения, — цитата сообщения, начатого с ```ts, показывает строку кода, а не «ts»).
 * Строчное содержимое — как в ленте: текст и инлайн-код — буквально (`@human` в коде остаётся кодом); упоминание
 * сессии — `@` и подпись (`labelOf` или тег `S02`), упоминание человека — `@you`; ссылка и ссылка-сноска — текст
 * детей, а `@` в нём остаётся буквальным; картинка — её `alt`; перенос строки — пробел; выделения — их дети. Дальше
 * пробелы схлопываются, а длиннее 140 знаков (графем: флаг и эмодзи с ZWJ — один знак) — 140 и `…`.
 *
 * Свой `@human` человека — не чип (`humanChips: false`): в цитате его сообщения он остаётся `@human`, как в ленте.
 *
 * Разобранные куски кешируются по тексту и правилу `@human`: цитаты считаются на каждую отрисовку панели, а текст
 * сообщения не меняется. В кеше лежат куски, а не готовая строка: подписи упоминаний подставляются при каждом вызове —
 * сессию могут переименовать. Не осилил разбор текст (вложенность глубже стека) — запасной путь: первая непустая
 * строка сырого текста, обрезанная так же.
 */

import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { markdownTooDeep } from '../../lib/markdown-depth.js';
import { sessionTag } from '../../lib/participant.js';
import { MENTION_ATTR, isCodeCaption, remarkPluginsFor, type MdNode } from './room-remark.js';

/** Выдержка — не больше стольких знаков (графем: флаг и эмодзи с ZWJ — один знак); длиннее обрезается с `…`. */
const EXCERPT_MAX = 140;
/** Разбирается не больше стольких кодовых единиц текста: на выдержку хватает с запасом, а длиннее разбор дорог. */
const INPUT_MAX = 4000;
/** Кеш — до стольких разобранных текстов; при переполнении очищается целиком (как у `hasHumanMention`). */
const CACHE_MAX = 500;
/** Язык не задан: границы графем от него не зависят. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Куски выдержки: готовый текст или упоминание сессии, чью подпись берут при каждом вызове (`replyExcerpt`).
 * Упоминание человека — готовый текст «@you»: подписи у него нет.
 */
type Piece = string | { sessionId: string };

/**
 * Процессоры: один на правило `@human`. Как и у `hasHumanMention`, после первого разбора они заморожены, а
 * состояния между разборами нет.
 */
const withChips = unified().use(remarkParse).use(remarkPluginsFor(false, true));
const withoutChips = unified().use(remarkParse).use(remarkPluginsFor(false, false));

const cache = new Map<string, Piece[]>();

/**
 * Текст не длиннее `INPUT_MAX` кодовых единиц. Верхняя половина суррогатной пары на краю остаётся без нижней — её
 * отбрасывают, чтобы в разбор не попал обломок знака.
 */
function clip(text: string): string {
  if (text.length <= INPUT_MAX) return text;
  const last = text.charCodeAt(INPUT_MAX - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? INPUT_MAX - 1 : INPUT_MAX);
}

/** Строчное содержимое узла — в `out`, как его показывает лента: см. шапку файла. */
function collectInline(node: MdNode, out: Piece[]): void {
  const sessionId = node.data?.hProperties?.[MENTION_ATTR];
  if (typeof sessionId === 'string') {
    out.push({ sessionId });
    return;
  }
  if (node.type === 'break') {
    out.push(' ');
    return;
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    out.push(node.alt ?? '');
    return;
  }
  // `text` (в том числе «@you» человека: это текстовый узел плагина), `inlineCode` и строчный `html` — значение
  // как есть; у выделений и ссылок значения нет, их текст — в детях.
  if (node.value !== undefined) out.push(node.value);
  for (const child of node.children ?? []) collectInline(child, out);
}

/** Есть видимый текст: непробельный знак или упоминание сессии (подпись у него непустая всегда). */
function hasText(pieces: readonly Piece[]): boolean {
  return pieces.some((piece) => typeof piece !== 'string' || piece.trim() !== '');
}

/** Первая непустая строка значения (блок кода, сырой HTML, сырой текст) — буквально; `null` — все строки пусты. */
function firstLine(value: string): Piece[] | null {
  const line = value.split(LINE_BREAK).find((candidate) => candidate.trim() !== '');
  return line === undefined ? null : [line];
}

/**
 * Куски первого блока поддерева, давшего непустой текст; `null` — такого нет. Блоки без текста (тематический
 * разрыв, определение, пустой код) и подпись языка над кодом пропускаются; прочие узлы — цитата, список, пункт,
 * таблица, строка таблицы — читаются по детям.
 */
function blockPieces(node: MdNode): Piece[] | null {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'tableCell': {
      if (isCodeCaption(node)) return null;
      const pieces: Piece[] = [];
      collectInline(node, pieces);
      return hasText(pieces) ? pieces : null;
    }
    case 'code':
    case 'html':
      return firstLine(node.value ?? '');
    default:
      for (const child of node.children ?? []) {
        const found = blockPieces(child);
        if (found !== null) return found;
      }
      return null;
  }
}

/** Куски выдержки из текста (из кеша или разбором); пусто — в тексте нет блока с текстом. */
function piecesOf(text: string, humanChips: boolean): Piece[] {
  const source = clip(text);
  const key = `${humanChips ? 1 : 0}${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const processor = humanChips ? withChips : withoutChips;
  let pieces: Piece[];
  try {
    // Цитаты глубже предела лента показывает сырым текстом (`MarkdownBoundary`) — выдержка берёт его строку.
    pieces = markdownTooDeep(source)
      ? (firstLine(source) ?? [])
      : (blockPieces(processor.runSync(processor.parse(source), source) as MdNode) ?? []);
  } catch {
    // Текст пишет агент: вложенность глубже стека роняет разбор, а выдержка не должна ронять панель комнаты.
    pieces = firstLine(source) ?? [];
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, pieces);
  return pieces;
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
 * Выдержка из текста сообщения: см. шапку файла. Пусто, если в тексте нет блока с текстом (одна картинка без `alt`,
 * одни ограды и разрывы): цитата тогда покажет только подпись. `labelOf` — ярлык участника для упоминания, как у
 * `RoomMarkdown`: `null` — сессии нет в карте, берётся тег. `humanChips` (по умолчанию `true`) — как у `RoomMarkdown`:
 * `false` у сообщения человека, в нём `@human` остаётся текстом.
 */
export function replyExcerpt(
  text: string,
  labelOf: (sessionId: string) => string | null,
  options?: { humanChips?: boolean },
): string {
  const joined = piecesOf(text, options?.humanChips ?? true)
    .map((piece) =>
      typeof piece === 'string'
        ? piece
        : `@${labelOf(piece.sessionId) ?? sessionTag(piece.sessionId)}`,
    )
    .join('');
  return truncate(joined.replace(/\s+/g, ' ').trim());
}
