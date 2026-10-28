/**
 * История сессии для помощника (спека 2026-10-28, 5.3): разговор из ленты окна — вопросы человека, ответы агента,
 * ошибки и субагенты — страницами от новых к старым. Чистая функция: лента на входе, в ответе шапка и записи.
 * Вызовы инструментов — не записи, а короткие строки под предыдущей записью. Курсор — `id` самой старой показанной
 * записи ленты; он живёт, пока запись не вытеснена из кольца ленты.
 */

import type { FeedItem, FeedTool } from '@parley/core';
import { LETTER_MAX, PAGE_BUDGET } from './room-page.js';

export const HISTORY_PAGE = 20;
export const HISTORY_PAGE_MAX = 50;
/** Сколько строк инструментов подряд показано под записью; остальные — одной строкой счётчика. */
export const TOOLS_PER_GAP = 8;
/** Строка инструмента длиннее этого обрезается. */
const TOOL_LINE_MAX = 160;

const BEGINNING = 'This is the beginning of the session history.';

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Строка вызова инструмента: что сделал агент, одной строкой; неудачный или отклонённый вызов помечен. */
export function toolLine(item: FeedTool): string {
  const { name, input } = item;
  const command = str(input.command);
  const filePath = str(input.file_path);
  const pattern = str(input.pattern);
  const url = str(input.url);
  let body: string;
  if (name === 'Bash' && command !== undefined) body = `ran: ${command}`;
  else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) && filePath !== undefined)
    body = `edited: ${filePath}`;
  else if (name === 'Read' && filePath !== undefined) body = `read: ${filePath}`;
  else if ((name === 'Grep' || name === 'Glob') && pattern !== undefined)
    body = `searched: ${pattern}`;
  else if (name === 'WebFetch' && url !== undefined) body = `fetched: ${url}`;
  else {
    const first = Object.values(input).find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    body = first === undefined ? name : `${name} ${first}`;
  }
  const mark = item.status === 'failed' || item.status === 'rejected' ? ` (${item.status})` : '';
  // Метка статуса не теряется при усечении: общая длина строки укладывается в предел вместе с ней.
  return `${clip(oneLine(body), TOOL_LINE_MAX - mark.length)}${mark}`;
}

/** Запись истории: строки текста и вызовы инструментов, что шли после неё. */
interface Entry {
  id: string;
  line: string;
  tools: string[];
  moreTools: number;
}

/** Запись из элемента ленты; `null` — элемент в историю не входит (инструмент, уведомление, карточка, обычный конец хода). */
function entryOf(item: FeedItem): Entry | null {
  const make = (line: string): Entry => ({ id: item.id, line, tools: [], moreTools: 0 });
  switch (item.kind) {
    case 'prompt':
      return make(`Asked: ${clip(item.text, LETTER_MAX)}`);
    case 'text':
      return item.text.trim() === ''
        ? null
        : make(`Agent: ${clip(item.text, LETTER_MAX)}${item.streaming ? ' (still writing)' : ''}`);
    case 'error':
      return make(`Error: ${clip(item.message ?? item.error, LETTER_MAX)}`);
    case 'agent':
      return make(`Subagent: ${item.description ?? item.agentType ?? 'task'}`);
    case 'turn':
      return item.interrupted === true ? make('(turn interrupted)') : null;
    default:
      return null;
  }
}

const render = (entry: Entry): string =>
  [
    entry.line,
    ...entry.tools.map((line) => `  · ${line}`),
    ...(entry.moreTools > 0 ? [`  · …and ${entry.moreTools} more tool calls`] : []),
  ].join('\n');

export function historyText(
  header: string,
  items: readonly FeedItem[],
  page: { before?: string; limit?: number },
): { text: string } | { error: string } {
  const requested =
    page.limit !== undefined && Number.isFinite(page.limit) ? Math.trunc(page.limit) : HISTORY_PAGE;
  const limit = Math.min(Math.max(requested, 1), HISTORY_PAGE_MAX);
  const end =
    page.before === undefined ? items.length : items.findIndex((item) => item.id === page.before);
  if (end < 0)
    return {
      error: 'This cursor is no longer in the session feed; call parley_session without before.',
    };
  const entries: Entry[] = [];
  for (const item of items.slice(0, end)) {
    const entry = entryOf(item);
    if (entry !== null) {
      entries.push(entry);
    } else if (item.kind === 'tool' && entries.length > 0) {
      // Инструменты липнут к предыдущей записи; без неё (начало ленты) показывать их не под чем.
      const last = entries[entries.length - 1]!;
      if (last.tools.length < TOOLS_PER_GAP) last.tools.push(toolLine(item));
      else last.moreTools += 1;
    }
  }
  const rendered = entries.map(render);
  // Страница — до `limit` записей от новых к старым, пока текст влезает в бюджет (одна запись — всегда).
  let first = entries.length;
  let used = 0;
  while (first > 0 && entries.length - first < limit) {
    const size = rendered[first - 1]!.length;
    if (first < entries.length && used + size > PAGE_BUDGET) break;
    first -= 1;
    used += size;
  }
  if (first === entries.length) {
    return {
      text: `${header}\n${page.before === undefined ? 'No history for this session yet.' : BEGINNING}`,
    };
  }
  const lines = [header, 'History, oldest first:', ...rendered.slice(first)];
  lines.push(
    first > 0 ? `Older: call parley_session with before=${entries[first]!.id}` : BEGINNING,
  );
  return { text: lines.join('\n') };
}
