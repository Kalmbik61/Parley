/**
 * Разбор потоков CLI помощника (спека 2026-10-14, 6.3 и приложение A.3): строки `stream-json` Claude и GLM и
 * `exec --json` Codex — в общие события хода. Без состояния: строка → события.
 */

/** Имя MCP-сервера помощника: инструменты приходят от Claude как `mcp__parley-assistant__<имя>`. */
export const ASSISTANT_MCP_NAME = 'parley-assistant';
const TOOL_PREFIX = `mcp__${ASSISTANT_MCP_NAME}__`;

export type AssistantErrorKind = 'limit' | 'resume' | 'other';

export type AssistantStreamEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; kind: AssistantErrorKind; message: string };

export function classifyAssistantError(text: string): AssistantErrorKind {
  if (/no conversation found|no rollout found/i.test(text)) return 'resume';
  if (/usage limit|rate limit|limit reached|hit your limit|\b429\b/i.test(text)) return 'limit';
  return 'other';
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parse(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Аргументы инструмента: объект, а у некоторых версий — JSON-строка. */
function args(value: unknown): Json {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return record(value) ?? {};
}

export function parseClaudeLine(line: string): AssistantStreamEvent[] {
  const event = parse(line);
  if (event === null) return [];
  const type = event['type'];
  if (type === 'system' && event['subtype'] === 'init') {
    const id = str(event['session_id']);
    return id === null ? [] : [{ type: 'session', id }];
  }
  if (type === 'stream_event') {
    const inner = record(event['event']);
    const delta = record(inner?.['delta']);
    if (inner?.['type'] !== 'content_block_delta' || delta?.['type'] !== 'text_delta') return [];
    const text = str(delta['text']);
    return text === null || text === '' ? [] : [{ type: 'text', delta: text }];
  }
  if (type === 'assistant') {
    // Текст берём только из дельт (`--include-partial-messages`), отсюда — вызовы инструментов с полными аргументами.
    const raw = record(event['message'])?.['content'];
    const content = Array.isArray(raw) ? raw : [];
    return content.flatMap((block): AssistantStreamEvent[] => {
      const item = record(block);
      if (item?.['type'] !== 'tool_use') return [];
      const name = str(item['name']) ?? '';
      return [{ type: 'tool', name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input: args(item['input']) }];
    });
  }
  if (type === 'result') {
    // Неверная модель приходит с `subtype: "success"`, но `is_error: true` — смотреть на `is_error`.
    if (event['is_error'] !== true) return [{ type: 'done' }];
    const rawErrors = event['errors'];
    const errors = Array.isArray(rawErrors) ? rawErrors.filter((item): item is string => typeof item === 'string') : [];
    const message = [str(event['result']), ...errors].filter((part): part is string => part !== null && part !== '').join(' ');
    const text = message === '' ? 'the CLI reported an error' : message;
    return [{ type: 'error', kind: event['api_error_status'] === 429 ? 'limit' : classifyAssistantError(text), message: text }];
  }
  return [];
}

export function parseCodexLine(line: string): AssistantStreamEvent[] {
  const event = parse(line);
  if (event === null) return [];
  const type = event['type'];
  if (type === 'thread.started') {
    const id = str(event['thread_id']);
    return id === null ? [] : [{ type: 'session', id }];
  }
  const item = record(event['item']);
  if (type === 'item.started' && item?.['type'] === 'mcp_tool_call') {
    return [{ type: 'tool', name: str(item['tool']) ?? '', input: args(item['arguments']) }];
  }
  if (type === 'item.completed' && item?.['type'] === 'agent_message') {
    const text = str(item['text']);
    return text === null || text === '' ? [] : [{ type: 'text', delta: text }];
  }
  if (type === 'turn.completed') return [{ type: 'done' }];
  if (type === 'turn.failed') {
    const message = str(record(event['error'])?.['message']) ?? 'the CLI reported an error';
    return [{ type: 'error', kind: classifyAssistantError(message), message }];
  }
  return [];
}
