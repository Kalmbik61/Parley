/**
 * Письма, доставленные сессии, как элемент ленты `mail` (спека 2026-11-12, §3): разбор текста доставки хоста
 * (`mailFromInline`) и результата `check_inbox` / `wait_for("inbox")` (`mailFromTool`). Чистые функции без узлов Node:
 * модуль идёт и в окно.
 */
import { isRecord } from '../work/events.js';
import { FEED_MAIL_TEXT_LIMIT } from './types.js';
import type { FeedMail, FeedMailLetter, FeedTool } from './types.js';

/**
 * Первая строка доставки вместе с указателем. Повтор `INLINE_MAIL_LINE` из `mcp/tools.ts`: тот модуль тянет Node и
 * MCP SDK, а этот идёт в окно. Равенство сверяет `mail.test.ts`.
 */
const INLINE_LINE = 'Parley delivered the messages announced above; they are marked read. Do not call check_inbox for them.';

const MAX_LETTERS = 50;
const MAX_DEPTH = 4;
const KINDS = new Set(['note', 'question', 'decision']);
const CUT_HINT = /Message (\S+) is cut:/;

/** Страница `{messages, remaining?, hint?}` из значения: строка JSON, обёртка MCP `{content:[…]}` или массив текстовых частей. */
function pageOf(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') {
    try {
      return pageOf(JSON.parse(value) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') continue;
      const page = pageOf(part['text'], depth + 1);
      if (page !== null) return page;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value['messages'])) return value;
  return Array.isArray(value['content']) ? pageOf(value['content'], depth + 1) : null;
}

function letterOf(value: unknown, cutId: string | null): FeedMailLetter | null {
  if (!isRecord(value)) return null;
  const { id, from, fromLabel, kind, room, at, text } = value;
  if (typeof id !== 'string' || id === '' || typeof from !== 'string' || from === '') return null;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof at !== 'string' || typeof text !== 'string') return null;
  if (fromLabel !== undefined && fromLabel !== null && typeof fromLabel !== 'string') return null;
  let place: FeedMailLetter['room'] = null;
  if (room !== undefined && room !== null) {
    if (!isRecord(room) || typeof room['id'] !== 'string' || typeof room['title'] !== 'string') return null;
    place = { id: room['id'], title: room['title'] };
  }
  const over = text.length > FEED_MAIL_TEXT_LIMIT;
  return {
    id,
    from,
    fromLabel: typeof fromLabel === 'string' ? fromLabel : null,
    kind: kind as FeedMailLetter['kind'],
    room: place,
    at,
    text: over ? text.slice(0, FEED_MAIL_TEXT_LIMIT) : text,
    ...(over || id === cutId ? { cut: true as const } : {}),
  };
}

function mailOf(page: Record<string, unknown>, via: FeedMail['via'], toolUseId: string | null, at: string): FeedMail | null {
  const hint = typeof page['hint'] === 'string' ? page['hint'] : '';
  const cutId = CUT_HINT.exec(hint)?.[1] ?? null;
  const letters: FeedMailLetter[] = [];
  for (const raw of page['messages'] as unknown[]) {
    const letter = letterOf(raw, cutId);
    if (letter !== null && letters.length < MAX_LETTERS) letters.push(letter);
  }
  const first = letters[0];
  if (first === undefined) return null;
  const remaining = page['remaining'];
  return {
    id: `mail:${first.id}`,
    at,
    kind: 'mail',
    via,
    toolUseId,
    letters,
    ...(typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0 ? { remaining } : {}),
  };
}

/** Доставка вместе с указателем: `INLINE_MAIL_LINE`, перевод строки и JSON страницы. `at` — время ответа хоста. */
export function mailFromInline(text: string, at: string): FeedMail | null {
  if (!text.startsWith(`${INLINE_LINE}\n`)) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(INLINE_LINE.length + 1));
  } catch {
    return null;
  }
  const page = isRecord(json) && Array.isArray(json['messages']) ? json : null;
  return page === null ? null : mailOf(page, 'pointer', null, at);
}

/**
 * Письма из законченного вызова верхнего уровня: `mcp__parley__check_inbox` или `mcp__parley__wait_for` с
 * `input.target === 'inbox'`, статус `done`, ответ не обрезан и разбирается в страницу с письмами.
 * `read_room`, `get_map` и прочее писем не дают: они не доставляют.
 */
export function mailFromTool(tool: FeedTool): FeedMail | null {
  if (tool.status !== 'done' || tool.agentId !== undefined) return null;
  const via =
    tool.name === 'mcp__parley__check_inbox'
      ? 'check_inbox'
      : tool.name === 'mcp__parley__wait_for' && tool.input['target'] === 'inbox'
        ? 'wait_for'
        : null;
  const response = tool.response;
  if (via === null || response === undefined || response.truncated) return null;
  const page = pageOf(response.text);
  return page === null ? null : mailOf(page, via, tool.toolUseId, tool.endedAt ?? tool.at);
}
