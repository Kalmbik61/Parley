import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FeedItem, FeedTool } from '../types.js';
import { applyQwenRecords, emptyQwenCursor, feedFromQwenTranscript } from './apply-qwen.js';
import { parseQwenLine, qwenRecordOf, splitQwenChunk, type QwenRecord } from './transcript-record.js';
import { emptyFeedState } from '../reduce.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
const recordsOf = (name: string): QwenRecord[] =>
  read(name).split('\n').map(parseQwenLine).filter((r): r is QwenRecord => r !== null);
const tools = (items: readonly FeedItem[]): FeedTool[] => items.filter((i): i is FeedTool => i.kind === 'tool');

describe('qwen transcript: session-main', () => {
  const { state, cursor } = feedFromQwenTranscript(recordsOf('session-main.jsonl'));

  it('shows real user prompts', () => {
    const prompts = state.items.filter((i) => i.kind === 'prompt');
    expect(prompts.map((p) => (p.kind === 'prompt' ? p.text : ''))).toEqual(['mcpflow', 'shellflow']);
  });

  it('shows assistant text and hides thinking', () => {
    const texts = state.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    expect(texts).toContain('Hello from mock');
    expect(texts).not.toContain('thinking about it');
  });

  it('shows the inner MCP name and arguments of the tool_call wrapper', () => {
    const echo = tools(state.items).find((t) => t.toolUseId === 'call_1');
    expect(echo).toMatchObject({ name: 'mcp__parley__echo', input: { text: 'hi' }, status: 'done' });
    expect(echo?.response?.text).toBe('echoed:hi');
  });

  it('keeps a plain tool under its own name', () => {
    expect(tools(state.items).find((t) => t.toolUseId === 'call_0')).toMatchObject({ name: 'tool_search', status: 'done' });
    const shell = tools(state.items).find((t) => t.toolUseId === 'call_s1');
    expect(shell).toMatchObject({ name: 'run_shell_command', input: { command: 'echo hi' }, status: 'done' });
    expect(shell?.response?.text).toContain('Output: hi');
  });

  it('marks a failed tool call with its error text', () => {
    const failed = tools(state.items).find((t) => t.toolUseId === 'call_e1');
    expect(failed).toMatchObject({ name: 'mcp__parley__echo', status: 'failed' });
    expect(failed?.response?.text).toBe('echo failed');
  });

  it('skips system records without counting them as unknown', () => {
    expect(cursor.skipped).toBe(0);
    expect(state.items.every((i) => ['prompt', 'text', 'tool', 'turn'].includes(i.kind))).toBe(true);
  });

  it('closes the first turn when the second prompt arrives', () => {
    expect(state.items.filter((i) => i.kind === 'turn')).toHaveLength(1);
    expect(state.turnStartedAt).not.toBeNull();
  });

  it('keeps the latest usage', () => {
    expect(cursor.usage).toEqual({ inputTokens: 20, outputTokens: 3, thoughtsTokens: 0, totalTokens: 23, cachedTokens: 0 });
  });

  it('applying the same records twice gives the same items', () => {
    const records = recordsOf('session-main.jsonl');
    const first = applyQwenRecords(emptyFeedState(), records, emptyQwenCursor());
    const second = applyQwenRecords(first.update.state, records, first.cursor);
    expect(second.update.state.items).toEqual(first.update.state.items);
  });
});

describe('qwen transcript: session-resume', () => {
  const { state } = feedFromQwenTranscript(recordsOf('session-resume.jsonl'));

  it('has both runs: two prompts, the shell call done, and a turn between them', () => {
    expect(state.items.filter((i) => i.kind === 'prompt')).toHaveLength(2);
    expect(tools(state.items)).toHaveLength(1);
    expect(tools(state.items)[0]).toMatchObject({ name: 'run_shell_command', status: 'done' });
    expect(state.items.filter((i) => i.kind === 'turn')).toHaveLength(1);
  });
});

describe('qwen transcript: robustness', () => {
  const rec = (type: string, extra: Record<string, unknown> = {}): QwenRecord =>
    qwenRecordOf({ uuid: `u-${type}`, timestamp: '2026-11-11T13:00:00.000Z', type, ...extra }) as QwenRecord;

  it('counts unknown types and does not throw', () => {
    const { cursor, state } = feedFromQwenTranscript([rec('future_kind'), rec('future_kind'), rec('other')]);
    expect(cursor.skipped).toBe(3);
    expect(cursor.unknownTypes).toEqual({ future_kind: 2, other: 1 });
    expect(state.items).toEqual([]);
  });

  it('ignores a user record that is not real_user', () => {
    const user = rec('user', { provenance: 'system', message: { parts: [{ text: 'injected' }] } });
    expect(feedFromQwenTranscript([user]).state.items).toEqual([]);
  });

  it('ignores a tool result without its call', () => {
    const result = rec('tool_result', { message: { parts: [{ functionResponse: { id: 'x', response: { output: 'o' } } }] }, toolCallResult: { callId: 'x', status: 'success' } });
    expect(feedFromQwenTranscript([result]).state.items).toEqual([]);
  });

  it('rejects broken lines', () => {
    expect(parseQwenLine('{oops')).toBeNull();
    expect(parseQwenLine('[]')).toBeNull();
    expect(parseQwenLine('{"type":"user"}')).toBeNull();
  });
});

describe('splitQwenChunk', () => {
  const lines = read('session-main.jsonl').split('\n').filter(Boolean);

  it('keeps a partial last line for the next read', () => {
    const whole = lines.slice(0, 3).join('\n') + '\n';
    const half = lines[3]!.slice(0, 40);
    const first = splitQwenChunk('', whole + half);
    expect(first.records).toHaveLength(3);
    expect(first.rest).toBe(half);
    const second = splitQwenChunk(first.rest, lines[3]!.slice(40) + '\n');
    expect(second.records).toHaveLength(1);
    expect(second.rest).toBe('');
    expect(second.records[0]?.uuid).toBe(JSON.parse(lines[3]!).uuid);
  });

  it('consumes nothing when no newline has arrived', () => {
    expect(splitQwenChunk('', lines[0]!)).toEqual({ records: [], rest: lines[0], malformed: 0 });
  });

  it('counts a broken complete line and goes on', () => {
    const out = splitQwenChunk('', `{bad\n${lines[0]}\n`);
    expect(out.malformed).toBe(1);
    expect(out.records).toHaveLength(1);
  });
});
