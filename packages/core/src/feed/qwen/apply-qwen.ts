/**
 * Chat feed from a Qwen Code transcript (spec §3.5). The transcript owns the prompt, text, tool and turn items;
 * hooks own only state. Building blocks are those of the Claude and Codex feeds (`reduce.ts`).
 *
 * - `user` records count only with `provenance: real_user`;
 * - assistant `text` parts become a text item; `thought: true` parts are not shown (as Claude and Codex reasoning);
 * - `functionCall` parts become tool items. The `tool_call` wrapper shows its inner `args.name` and `args.arguments`;
 * - `tool_result` closes its call by id: `toolCallResult.status === 'success'` is done, anything else failed;
 * - `usageMetadata` goes to `cursor.usage` (the feed has no usage item);
 * - `system` is skipped; unknown types are counted in `cursor.skipped` and `cursor.unknownTypes`, never thrown on.
 *
 * Applying a record twice changes nothing: every item id comes from the record uuid or the call id.
 */

import { closeTurn, emptyFeedState, FeedDraft, finishTool, newText, newTool, limitText, putMail } from '../reduce.js';
import { FEED_TEXT_LIMIT, type FeedPrompt, type FeedState, type FeedUpdate } from '../types.js';
import { isQwenObject, type QwenRecord } from './transcript-record.js';

export interface QwenUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface QwenCursor {
  /** Records of unknown types skipped. */
  skipped: number;
  unknownTypes: Record<string, number>;
  /** `usageMetadata` of the latest assistant record that had one. */
  usage: QwenUsage | null;
}

export const emptyQwenCursor = (): QwenCursor => ({ skipped: 0, unknownTypes: {}, usage: null });

const KNOWN = new Set(['user', 'assistant', 'tool_result', 'system']);
const WRAPPER = 'tool_call';

const str = (source: Record<string, unknown> | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const count = (source: Record<string, unknown>, key: string): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

function usageOf(meta: Record<string, unknown>): QwenUsage {
  return {
    inputTokens: count(meta, 'promptTokenCount'),
    outputTokens: count(meta, 'candidatesTokenCount'),
    thoughtsTokens: count(meta, 'thoughtsTokenCount'),
    totalTokens: count(meta, 'totalTokenCount'),
    cachedTokens: count(meta, 'cachedContentTokenCount'),
  };
}

function onUser(draft: FeedDraft, record: QwenRecord): void {
  if (record.provenance !== 'real_user' || record.uuid === null) return;
  const id = `prompt:${record.uuid}`;
  if (draft.has(id)) return;
  const joined = record.parts.map((part) => str(part, 'text') ?? '').filter((part) => part !== '').join('\n');
  // A new prompt ends the previous turn: the transcript has no turn-end record.
  if (draft.turnStartedAt !== null) closeTurn(draft, record.at);
  const prompt: FeedPrompt = { id, at: record.at, kind: 'prompt', text: limitText(joined, FEED_TEXT_LIMIT).text, images: 0 };
  draft.put(prompt);
  draft.turnStartedAt = record.at;
}

function onAssistant(draft: FeedDraft, record: QwenRecord, cursor: QwenCursor): void {
  if (record.usageMetadata !== null) cursor.usage = usageOf(record.usageMetadata);
  let textAt = 0;
  for (const part of record.parts) {
    const call = isQwenObject(part['functionCall']) ? part['functionCall'] : null;
    if (call !== null) {
      const id = str(call, 'id');
      if (id === null || draft.has(`tool:${id}`)) continue;
      const args = isQwenObject(call['args']) ? call['args'] : {};
      const outer = str(call, 'name') ?? 'tool';
      const inner = outer === WRAPPER ? str(args, 'name') : null;
      const input = inner !== null ? (isQwenObject(args['arguments']) ? args['arguments'] : {}) : args;
      draft.put(newTool(id, inner ?? outer, input, record.at, null));
      continue;
    }
    const value = str(part, 'text');
    if (value === null || part['thought'] === true || record.uuid === null) continue;
    textAt += 1;
    const id = `text:${record.uuid}:${textAt}`;
    if (!draft.has(id)) draft.put(newText(id, record.at, record.uuid, value, false));
  }
}

function responseOf(response: unknown): unknown {
  if (!isQwenObject(response)) return response;
  return str(response, 'output') ?? str(response, 'error') ?? JSON.stringify(response);
}

function onToolResult(draft: FeedDraft, record: QwenRecord): void {
  for (const part of record.parts) {
    const reply = isQwenObject(part['functionResponse']) ? part['functionResponse'] : null;
    if (reply === null) continue;
    const id = str(record.toolCallResult, 'callId') ?? str(reply, 'id');
    if (id === null) continue;
    const item = draft.get(`tool:${id}`);
    if (item === undefined || item.kind !== 'tool') continue;
    const status = str(record.toolCallResult, 'status') === 'success' ? 'done' : 'failed';
    const finished = finishTool(item, status, responseOf(reply['response']), record.at);
    draft.put(finished);
    putMail(draft, finished);
  }
}

export function applyQwenRecords(
  state: FeedState,
  records: readonly QwenRecord[],
  cursor: QwenCursor,
): { update: FeedUpdate; cursor: QwenCursor } {
  const draft = new FeedDraft(state);
  const next: QwenCursor = { ...cursor, unknownTypes: { ...cursor.unknownTypes } };
  for (const record of records) {
    if (!KNOWN.has(record.type)) {
      next.skipped += 1;
      next.unknownTypes[record.type] = (next.unknownTypes[record.type] ?? 0) + 1;
      continue;
    }
    if (record.type === 'user') onUser(draft, record);
    else if (record.type === 'assistant') onAssistant(draft, record, next);
    else if (record.type === 'tool_result') onToolResult(draft, record);
  }
  return { update: draft.done(), cursor: next };
}

export function feedFromQwenTranscript(
  records: readonly QwenRecord[],
  options: { limit?: number } = {},
): { state: FeedState; cursor: QwenCursor } {
  const { update, cursor } = applyQwenRecords(emptyFeedState(), records, emptyQwenCursor());
  let { state } = update;
  if (options.limit !== undefined && state.items.length > options.limit) state = { ...state, items: state.items.slice(-options.limit) };
  return { state, cursor };
}
