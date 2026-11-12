/**
 * Chat feed from OpenCode 2.x API messages (spec 2026-11-12 §4.11). The message list owns the prompt, text, tool and
 * turn items; SSE events own only state. Building blocks are those of the other feeds (`reduce.ts`).
 *
 * - `user` → prompt (id from the message id);
 * - `assistant` `text` parts → text items; `reasoning` parts are not shown (as for the other families);
 * - `assistant` `tool` parts → tool items by the part id, closed when the part reaches `completed` or `error`;
 * - an `execute` tool whose code calls `tools.parley.check_inbox` or `tools.parley.wait_for({target:"inbox"})` and
 *   whose output is an inbox page also gives a `mail` item (`mailFromExecute`);
 * - `idle` closes the turn (`outcome: interrupted` marks it interrupted);
 * - `finish`/`tokens` of the latest assistant message go to `cursor.usage` (the feed has no usage item);
 * - other known types are ignored; unknown types are counted in `cursor`, never thrown on.
 *
 * Applying a message list twice changes nothing: item ids come from message and part ids, and a closed `idle` is
 * remembered in `cursor.closed`.
 */

import { mailFromTool } from '../mail.js';
import { closeTurn, emptyFeedState, FeedDraft, finishTool, limitText, newText, newTool } from '../reduce.js';
import { FEED_TEXT_LIMIT } from '../types.js';
import type { FeedItem, FeedMail, FeedPrompt, FeedState, FeedTool, FeedUpdate } from '../types.js';
import { isOpencodeObject, opencodeContentText, opencodeIso, opencodeMessageOf, type OpencodeMessage } from './message-record.js';

export interface OpencodeUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface OpencodeCursor {
  /** Messages of unknown types skipped (each counted once). */
  skipped: number;
  unknownTypes: Record<string, number>;
  /** Ids of `idle` messages already applied: a turn is closed once. */
  closed: string[];
  /** Ids of unknown-type messages already counted, so a repeat does not count them again. */
  unknownIds: string[];
  usage: OpencodeUsage | null;
}

export const emptyOpencodeCursor = (): OpencodeCursor => ({ skipped: 0, unknownTypes: {}, closed: [], unknownIds: [], usage: null });

const KNOWN = new Set(['user', 'assistant', 'idle']);
/** Types of the schema that carry no feed item. */
const IGNORED = new Set(['system', 'synthetic', 'skill', 'shell', 'agent-switched', 'model-switched', 'location-switched']);

const num = (source: Record<string, unknown>, key: string): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

function usageOf(message: Record<string, unknown>): OpencodeUsage | null {
  const tokens = isOpencodeObject(message['tokens']) ? message['tokens'] : null;
  if (tokens === null) return null;
  const cache = isOpencodeObject(tokens['cache']) ? tokens['cache'] : {};
  return {
    inputTokens: num(tokens, 'input'),
    outputTokens: num(tokens, 'output'),
    reasoningTokens: num(tokens, 'reasoning'),
    cacheReadTokens: num(cache, 'read'),
    cacheWriteTokens: num(cache, 'write'),
    cost: num(message, 'cost'),
  };
}

/** Puts the item unless an equal one is already there, so a repeat changes nothing, not even `changes`. */
function putIfChanged(draft: FeedDraft, item: FeedItem): void {
  const old = draft.get(item.id);
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(item)) return;
  draft.put(item);
}

const CHECK_INBOX = /\btools\.parley\.check_inbox\s*\(/;
const WAIT_INBOX = /\btools\.parley\.wait_for\s*\(\s*\{[^}]*\btarget\s*:\s*["']inbox["']/;

/**
 * The `mail` item of a finished `execute` call whose code reads the inbox. The call is shown to `mailFromTool`
 * as the MCP tool it makes, so letters, limits and the cut mark come from the one parser of the other families.
 */
export function mailFromExecute(tool: FeedTool, code: string): FeedMail | null {
  if (tool.name !== 'execute') return null;
  const via = CHECK_INBOX.test(code) ? 'check_inbox' : WAIT_INBOX.test(code) ? 'wait_for' : null;
  if (via === null) return null;
  const alias: FeedTool =
    via === 'check_inbox'
      ? { ...tool, name: 'mcp__parley__check_inbox', input: {} }
      : { ...tool, name: 'mcp__parley__wait_for', input: { target: 'inbox' } };
  return mailFromTool(alias);
}

function onUser(draft: FeedDraft, message: OpencodeMessage): void {
  const id = `prompt:${message.id}`;
  if (draft.has(id)) return;
  const value = typeof message.raw['text'] === 'string' ? message.raw['text'] : '';
  if (value === '') return;
  // A new prompt ends the previous turn if no `idle` did.
  if (draft.turnStartedAt !== null) closeTurn(draft, message.at);
  const prompt: FeedPrompt = { id, at: message.at, kind: 'prompt', text: limitText(value, FEED_TEXT_LIMIT).text, images: 0 };
  draft.put(prompt);
  draft.turnStartedAt = message.at;
}

function onToolPart(draft: FeedDraft, message: OpencodeMessage, part: Record<string, unknown>): void {
  const callId = typeof part['id'] === 'string' && part['id'] !== '' ? part['id'] : null;
  const state = isOpencodeObject(part['state']) ? part['state'] : null;
  if (callId === null || state === null) return;
  const time = isOpencodeObject(part['time']) ? part['time'] : {};
  const at = opencodeIso(time['created']) ?? message.at;
  const status = state['status'];
  const input = isOpencodeObject(state['input']) ? state['input'] : {};
  const name = typeof part['name'] === 'string' && part['name'] !== '' ? part['name'] : 'tool';
  const existing = draft.get(`tool:${callId}`);
  if (existing !== undefined && (existing.kind !== 'tool' || existing.status !== 'running')) return;
  const running = existing ?? newTool(callId, name, input, at, null);
  if (existing === undefined) draft.put(running);
  if (status !== 'completed' && status !== 'error') return;
  const error = isOpencodeObject(state['error']) && typeof state['error']['message'] === 'string' ? state['error']['message'] : null;
  const output = opencodeContentText(state['content']) ?? error ?? '';
  const endedAt = opencodeIso(time['completed']) ?? message.completedAt ?? at;
  const finished = finishTool(running as FeedTool, status === 'completed' ? 'done' : 'failed', output, endedAt);
  draft.put(finished);
  const code = typeof input['code'] === 'string' ? input['code'] : null;
  if (code === null) return;
  const mail = mailFromExecute(finished, code);
  if (mail !== null) draft.put(mail);
}

function onAssistant(draft: FeedDraft, message: OpencodeMessage, cursor: OpencodeCursor): void {
  const usage = usageOf(message.raw);
  if (usage !== null && message.raw['finish'] !== undefined) cursor.usage = usage;
  const content = Array.isArray(message.raw['content']) ? message.raw['content'] : [];
  let textAt = 0;
  for (const part of content) {
    if (!isOpencodeObject(part)) continue;
    if (part['type'] === 'tool') onToolPart(draft, message, part);
    else if (part['type'] === 'text' && typeof part['text'] === 'string' && part['text'] !== '') {
      textAt += 1;
      putIfChanged(draft, newText(`text:${message.id}:${textAt}`, message.at, message.id, part['text'], message.completedAt === null));
    }
  }
}

function onIdle(draft: FeedDraft, message: OpencodeMessage, cursor: OpencodeCursor): void {
  if (cursor.closed.includes(message.id)) return;
  cursor.closed.push(message.id);
  closeTurn(draft, message.at, message.raw['outcome'] === 'interrupted');
}

export function applyOpencodeMessages(
  state: FeedState,
  messages: readonly unknown[],
  cursor: OpencodeCursor,
): { update: FeedUpdate; cursor: OpencodeCursor } {
  const draft = new FeedDraft(state);
  const next: OpencodeCursor = { ...cursor, closed: cursor.closed.slice(), unknownIds: cursor.unknownIds.slice(), unknownTypes: { ...cursor.unknownTypes } };
  for (const raw of messages) {
    const message = opencodeMessageOf(raw);
    if (message === null) continue;
    if (IGNORED.has(message.type)) continue;
    if (!KNOWN.has(message.type)) {
      if (next.unknownIds.includes(message.id)) continue;
      next.unknownIds.push(message.id);
      next.skipped += 1;
      next.unknownTypes[message.type] = (next.unknownTypes[message.type] ?? 0) + 1;
      continue;
    }
    if (message.type === 'user') onUser(draft, message);
    else if (message.type === 'assistant') onAssistant(draft, message, next);
    else onIdle(draft, message, next);
  }
  return { update: draft.done(), cursor: next };
}

export function feedFromOpencodeMessages(
  messages: readonly unknown[],
  options: { limit?: number } = {},
): { state: FeedState; cursor: OpencodeCursor } {
  const { update, cursor } = applyOpencodeMessages(emptyFeedState(), messages, emptyOpencodeCursor());
  let { state } = update;
  if (options.limit !== undefined && state.items.length > options.limit) state = { ...state, items: state.items.slice(-options.limit) };
  return { state, cursor };
}
