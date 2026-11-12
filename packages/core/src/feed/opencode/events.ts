/**
 * OpenCode 2.x SSE event → Parley journal record (spec 2026-11-12 §4.4). Pure: the host reads `GET /api/event`,
 * calls this per event and appends the records to `events/<session>.jsonl`, the lines the hook server writes for the
 * other families (`hook_event_name`, `session_id`, `timestamp`, `tool_name`, `notification_type`…).
 *
 * | event | record |
 * | --- | --- |
 * | `session.created` | `SessionStart` (`source: startup`) |
 * | `session.inbox.enqueued` (user item) | `UserPromptSubmit` |
 * | `session.tool.called` / `.success` / `.failed` | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` |
 * | `permission.asked` | `Notification` (`permission_prompt`) |
 * | `session.execution.succeeded` / `.interrupted` | `Stop` (`.interrupted` carries `interrupted: true`, `reason`) |
 * | `session.execution.failed` | `StopFailure` (`error`, `error_details`) |
 * | `session.usage.updated` | a usage fact (no record) |
 *
 * Events of other session ids and every other type give nothing. Tool events do not repeat the tool name, so
 * `session.tool.input.started` leaves it in the returned state for the later events of the same call.
 */

import { isOpencodeObject, opencodeIso } from './message-record.js';

export interface OpencodeBridgeState {
  /** Call id → tool name, from `session.tool.input.started`. */
  toolNames: Record<string, string>;
}

export const emptyOpencodeBridgeState = (): OpencodeBridgeState => ({ toolNames: {} });

export interface OpencodeJournalRecord {
  session_id: string;
  hook_event_name: string;
  timestamp: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  /** Short human detail of a tool call: `parley.check_inbox`, or the first line of the code. */
  detail?: string;
  prompt?: string;
  notification_type?: string;
  message?: string;
  source?: string;
  interrupted?: boolean;
  reason?: string;
  error?: string;
  error_details?: string;
}

export interface OpencodeUsageFact {
  sessionId: string;
  at: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface OpencodeMapped {
  state: OpencodeBridgeState;
  records: OpencodeJournalRecord[];
  usage: OpencodeUsageFact | null;
}

const DETAIL_LIMIT = 120;
const PARLEY_CALL = /\btools\.(parley\.[A-Za-z0-9_]+)\s*\(/;

const str = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const count = (source: Record<string, unknown>, key: string): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

function detailOf(name: string, input: Record<string, unknown>): string {
  const code = str(input, 'code');
  if (name === 'execute' && code !== null) {
    const parley = PARLEY_CALL.exec(code)?.[1];
    if (parley !== undefined) return parley;
  }
  const first = (code ?? JSON.stringify(input)).split('\n', 1)[0] ?? '';
  return first.length > DETAIL_LIMIT ? `${first.slice(0, DETAIL_LIMIT - 1)}…` : first;
}

export function mapOpencodeEvent(raw: unknown, sessionId: string, state: OpencodeBridgeState): OpencodeMapped {
  const none: OpencodeMapped = { state, records: [], usage: null };
  if (!isOpencodeObject(raw)) return none;
  const type = str(raw, 'type');
  const data = isOpencodeObject(raw['data']) ? raw['data'] : null;
  const timestamp = opencodeIso(raw['created']);
  if (type === null || data === null || timestamp === null || data['sessionID'] !== sessionId) return none;

  const base = { session_id: sessionId, timestamp };
  const one = (record: Omit<OpencodeJournalRecord, 'session_id' | 'timestamp'>): OpencodeMapped => ({
    state,
    records: [{ ...base, ...record }],
    usage: null,
  });
  const callId = str(data, 'id');

  switch (type) {
    case 'session.created':
      return one({ hook_event_name: 'SessionStart', source: 'startup' });
    case 'session.inbox.enqueued': {
      const item = isOpencodeObject(data['item']) ? data['item'] : null;
      if (item?.['type'] !== 'user') return none;
      const payload = isOpencodeObject(item['payload']) ? item['payload'] : {};
      return one({ hook_event_name: 'UserPromptSubmit', prompt: str(payload, 'text') ?? '' });
    }
    case 'session.tool.input.started': {
      const name = str(data, 'name');
      if (callId === null || name === null) return none;
      return { state: { toolNames: { ...state.toolNames, [callId]: name } }, records: [], usage: null };
    }
    case 'session.tool.called':
    case 'session.tool.success':
    case 'session.tool.failed': {
      if (callId === null) return none;
      const name = state.toolNames[callId] ?? 'tool';
      const input = isOpencodeObject(data['input']) ? data['input'] : null;
      const hook = type === 'session.tool.called' ? 'PreToolUse' : type === 'session.tool.success' ? 'PostToolUse' : 'PostToolUseFailure';
      const error = isOpencodeObject(data['error']) ? str(data['error'], 'message') : null;
      const mapped = one({
        hook_event_name: hook,
        tool_name: name,
        tool_use_id: callId,
        ...(input !== null ? { tool_input: input, detail: detailOf(name, input) } : {}),
        ...(hook === 'PostToolUseFailure' && error !== null ? { error } : {}),
      });
      if (hook === 'PreToolUse') return mapped;
      // The call is over: forget its name.
      const rest = { ...state.toolNames };
      delete rest[callId];
      return { ...mapped, state: { toolNames: rest } };
    }
    case 'permission.asked':
      return one({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: str(data, 'action') ?? 'permission',
        ...(str(data, 'action') !== null ? { tool_name: str(data, 'action') as string } : {}),
      });
    case 'session.execution.succeeded':
      return one({ hook_event_name: 'Stop' });
    case 'session.execution.interrupted':
      return one({ hook_event_name: 'Stop', interrupted: true, ...(str(data, 'reason') !== null ? { reason: str(data, 'reason') as string } : {}) });
    case 'session.execution.failed': {
      const error = isOpencodeObject(data['error']) ? data['error'] : {};
      return one({
        hook_event_name: 'StopFailure',
        error: str(error, 'type') ?? 'unknown',
        ...(str(error, 'message') !== null ? { error_details: str(error, 'message') as string } : {}),
      });
    }
    case 'session.usage.updated': {
      const tokens = isOpencodeObject(data['tokens']) ? data['tokens'] : {};
      const cache = isOpencodeObject(tokens['cache']) ? tokens['cache'] : {};
      return {
        state,
        records: [],
        usage: {
          sessionId,
          at: timestamp,
          inputTokens: count(tokens, 'input'),
          outputTokens: count(tokens, 'output'),
          reasoningTokens: count(tokens, 'reasoning'),
          cacheReadTokens: count(cache, 'read'),
          cacheWriteTokens: count(cache, 'write'),
          cost: count(data, 'cost'),
        },
      };
    }
    default:
      return none;
  }
}
