import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawRecord } from '../jsonl.js';
import { INLINE_MAIL_LINE } from '../mcp/tools.js';
import { feedFromCodexRollout } from './codex/apply-codex.js';
import { parseRolloutLine, type RolloutRecord } from './codex/rollout-record.js';
import { feedFromTranscript } from './from-transcript.js';
import { mailFromInline, mailFromTool } from './mail.js';
import { feedFromQwenTranscript } from './qwen/apply-qwen.js';
import { parseQwenLine, type QwenRecord } from './qwen/transcript-record.js';
import { applyHookEvent, emptyFeedState } from './reduce.js';
import { FEED_MAIL_TEXT_LIMIT } from './types.js';
import type { FeedItem, FeedMail, FeedMailLetter, FeedTool } from './types.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mail');
const lines = (name: string): string[] => readFileSync(path.join(DIR, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
const json = (name: string): RawRecord[] => lines(name).map((l) => JSON.parse(l) as RawRecord);
const toolsOf = (items: readonly FeedItem[]): FeedTool[] => items.filter((i): i is FeedTool => i.kind === 'tool');
const byId = (tools: FeedTool[], id: string): FeedTool => {
  const tool = tools.find((t) => t.toolUseId === id);
  if (tool === undefined) throw new Error(`no tool ${id}`);
  return tool;
};

const L1: FeedMailLetter = { id: 'm-9001', from: 's-901', fromLabel: 'Reviewer', kind: 'question', room: { id: 'r-90', title: 'Demo room' }, at: '2030-01-05T09:59:00.000Z', text: 'Please look at the draft plan.' };
const L2: FeedMailLetter = { id: 'm-9002', from: 'human', fromLabel: null, kind: 'note', room: null, at: '2030-01-05T09:59:30.000Z', text: 'Line one\nLine two' };
const L3: FeedMailLetter = { id: 'm-9003', from: 'system', fromLabel: 'system', kind: 'decision', room: { id: 'r-90', title: 'Demo room' }, at: '2030-01-05T09:59:40.000Z', text: 'Room r-90 was updated.' };

const PAGE_A = (at: string, toolUseId: string): FeedMail => ({ id: 'mail:m-9001', at, kind: 'mail', via: 'check_inbox', toolUseId, letters: [L1, L2], remaining: 3 });
const PAGE_B = (at: string, toolUseId: string): FeedMail => ({ id: 'mail:m-9003', at, kind: 'mail', via: 'wait_for', toolUseId, letters: [L3] });

const tool = (over: Partial<FeedTool> & { text?: string; truncated?: boolean }): FeedTool => ({
  id: 'tool:t1', at: '2030-01-05T10:00:00.000Z', kind: 'tool', toolUseId: 't1', name: 'mcp__parley__check_inbox', input: {}, status: 'done',
  endedAt: '2030-01-05T10:00:01.000Z',
  response: { text: over.text ?? '{"messages":[]}', size: 1, truncated: over.truncated ?? false },
  ...over,
});
const page = (messages: unknown[], extra: object = {}): string => JSON.stringify({ messages, ...extra });
const rawLetter = (id: string, over: object = {}): object => ({ id, from: 's-1', fromLabel: null, at: '2030-01-05T10:00:00.000Z', text: 'x', kind: 'note', room: null, ...over });

describe('mail: the inline line', () => {
  it('matches the delivery line of the MCP tools', () => {
    const text = `${INLINE_MAIL_LINE}\n{"messages":[${JSON.stringify(rawLetter('m-1'))}]}`;
    expect(mailFromInline(text, '2030-01-05T10:00:00.050Z')?.id).toBe('mail:m-1');
  });
});

describe('mailFromInline', () => {
  const records = json('claude-inline.transcript.jsonl');
  const contentOf = (hookEvent: string): string => {
    const found = records.find((r) => (r['attachment'] as { hookEvent?: string } | undefined)?.hookEvent === hookEvent);
    return ((found?.['attachment'] as { content: string[] }).content)[0]!;
  };

  it('reads the UserPromptSubmit attachment of a transcript fixture', () => {
    expect(mailFromInline(contentOf('UserPromptSubmit'), '2030-01-05T10:00:00.050Z')).toEqual({
      id: 'mail:m-9001', at: '2030-01-05T10:00:00.050Z', kind: 'mail', via: 'pointer', toolUseId: null, letters: [L1, L2], remaining: 3,
    });
  });

  it.each([
    ['SessionStart context', () => contentOf('SessionStart')],
    ['text without the line', () => '{"messages":[]}'],
    ['malformed JSON', () => `${INLINE_MAIL_LINE}\n{"messages":[`],
    ['empty messages', () => `${INLINE_MAIL_LINE}\n{"messages":[]}`],
    ['line without a newline', () => `${INLINE_MAIL_LINE} {"messages":[]}`],
  ])('gives null for %s', (_title, text) => {
    expect(mailFromInline(text(), 'x')).toBeNull();
  });

  it('is not fooled by the SessionStart attachment staying in the transcript feed', () => {
    const state = feedFromTranscript(records);
    expect(state.items.some((i) => i.kind === 'mail')).toBe(false);
  });
});

describe('mailFromTool: positive fixtures', () => {
  it('claude transcript: check_inbox and wait_for("inbox")', () => {
    const tools = toolsOf(feedFromTranscript(json('claude-tools.transcript.jsonl')).items);
    const check = byId(tools, 'toolu_mail_check');
    const wait = byId(tools, 'toolu_mail_wait');
    expect(mailFromTool(check)).toEqual(PAGE_A(check.endedAt!, 'toolu_mail_check'));
    expect(mailFromTool(wait)).toEqual(PAGE_B(wait.endedAt!, 'toolu_mail_wait'));
    expect(check.endedAt).toBe('2030-01-05T10:01:00.200Z');
  });

  it('claude PostToolUse hook bodies', () => {
    let state = emptyFeedState();
    for (const line of json('claude-hooks.events.jsonl')) {
      state = applyHookEvent(state, line['ev'], new Date(line['t'] as number).toISOString()).state;
    }
    const tools = toolsOf(state.items);
    const check = byId(tools, 'toolu_mail_check');
    const wait = byId(tools, 'toolu_mail_wait');
    expect(mailFromTool(check)).toEqual(PAGE_A(check.endedAt!, 'toolu_mail_check'));
    expect(mailFromTool(wait)).toEqual(PAGE_B(wait.endedAt!, 'toolu_mail_wait'));
  });

  it('codex McpToolCall, including the wait_for {state:"message"} form', () => {
    const records = lines('codex-mail.rollout.jsonl').map(parseRolloutLine).filter((r): r is RolloutRecord => r !== null);
    const tools = toolsOf(feedFromCodexRollout(records).state.items);
    const check = byId(tools, 'exec-mail-check');
    const wait = byId(tools, 'exec-mail-wait');
    expect(mailFromTool(check)).toEqual(PAGE_A(check.endedAt!, 'exec-mail-check'));
    expect(mailFromTool(wait)).toEqual(PAGE_B(wait.endedAt!, 'exec-mail-wait'));
  });

  it('qwen functionCall + tool_result', () => {
    const records = lines('qwen-mail.transcript.jsonl').map(parseQwenLine).filter((r): r is QwenRecord => r !== null);
    const tools = toolsOf(feedFromQwenTranscript(records).state.items);
    const check = byId(tools, 'call_chk');
    const wait = byId(tools, 'call_wait');
    expect(mailFromTool(check)).toEqual(PAGE_A(check.endedAt!, 'call_chk'));
    expect(mailFromTool(wait)).toEqual(PAGE_B(wait.endedAt!, 'call_wait'));
  });

  it('overlapping tools: the transcript finishes A after B starts, so mail-A is placed last', () => {
    const tools = toolsOf(feedFromTranscript(json('claude-overlap.transcript.jsonl')).items);
    const a = byId(tools, 'toolu_A');
    const b = byId(tools, 'toolu_B');
    expect(a.at < b.at).toBe(true);
    expect(a.endedAt! > b.endedAt!).toBe(true);
    expect(mailFromTool(a)).toMatchObject({ id: 'mail:m-9003', at: a.endedAt, via: 'wait_for', toolUseId: 'toolu_A' });
    expect(mailFromTool(b)).toBeNull();
  });
});

describe('mailFromTool: nothing to show', () => {
  const tools = toolsOf(feedFromTranscript(json('claude-tools.transcript.jsonl')).items);

  it.each([
    ['wait_for on a session id', 'toolu_wait_session'],
    ['read_room', 'toolu_read_room'],
    ['a failed tool', 'toolu_check_fail'],
    ['empty messages', 'toolu_check_empty'],
    ['malformed JSON', 'toolu_check_bad'],
  ])('%s gives null', (_title, id) => {
    expect(mailFromTool(byId(tools, id))).toBeNull();
  });

  it('gives null for get_map and any other tool, even with letters in the text', () => {
    const text = page([rawLetter('m-1')]);
    expect(mailFromTool(tool({ name: 'mcp__parley__get_map', text }))).toBeNull();
    expect(mailFromTool(tool({ name: 'Bash', text }))).toBeNull();
  });

  it('gives null for a truncated response, a running tool and a nested tool', () => {
    const text = page([rawLetter('m-1')]);
    expect(mailFromTool(tool({ text, truncated: true }))).toBeNull();
    expect(mailFromTool(tool({ text, status: 'running' }))).toBeNull();
    expect(mailFromTool(tool({ text, agentId: 'ag-1' }))).toBeNull();
    expect(mailFromTool(tool({ text }))).not.toBeNull();
  });

  it('gives null without a response', () => {
    const bare: FeedTool = { ...tool({}) };
    delete bare.response;
    expect(mailFromTool(bare)).toBeNull();
  });
});

describe('mailFromTool: shapes and limits', () => {
  const messages = [rawLetter('m-1')];

  it.each([
    ['raw JSON', page(messages)],
    ['an MCP content object', JSON.stringify({ content: [{ type: 'text', text: page(messages) }] })],
    ['an array of text parts', JSON.stringify([{ type: 'image' }, { type: 'text', text: page(messages) }])],
  ])('unwraps %s', (_title, text) => {
    expect(mailFromTool(tool({ text }))?.letters.map((l) => l.id)).toEqual(['m-1']);
  });

  it('cuts text over the limit and marks the letter', () => {
    const long = 'x'.repeat(FEED_MAIL_TEXT_LIMIT + 5);
    const mail = mailFromTool(tool({ text: page([rawLetter('m-1', { text: long })]) }));
    expect(mail?.letters[0]?.text).toHaveLength(FEED_MAIL_TEXT_LIMIT);
    expect(mail?.letters[0]?.cut).toBe(true);
  });

  it('marks the letter named by the "is cut" hint, and only it', () => {
    const tools = toolsOf(feedFromTranscript(json('claude-tools.transcript.jsonl')).items);
    const mail = mailFromTool(byId(tools, 'toolu_check_cut'));
    expect(mail?.letters.map((l) => [l.id, l.cut])).toEqual([['m-9010', true], ['m-9011', undefined]]);
    expect(mail?.remaining).toBeUndefined();
  });

  it('skips invalid letters and returns null when none is valid', () => {
    const bad = [{ id: 'm-x' }, rawLetter('m-2', { kind: 'shout' }), rawLetter('m-3', { text: 5 }), rawLetter('m-4', { room: { id: 1 } }), 'text', null];
    expect(mailFromTool(tool({ text: page(bad) }))).toBeNull();
    const mixed = mailFromTool(tool({ text: page([...bad, rawLetter('m-5')]) }));
    expect(mixed?.letters.map((l) => l.id)).toEqual(['m-5']);
    expect(mixed?.id).toBe('mail:m-5');
  });

  it('copies remaining and ignores a bad one', () => {
    expect(mailFromTool(tool({ text: page(messages, { remaining: 7 }) }))?.remaining).toBe(7);
    expect(mailFromTool(tool({ text: page(messages, { remaining: 'many' }) }))?.remaining).toBeUndefined();
  });

  it('takes at 50 letters', () => {
    const many = Array.from({ length: 60 }, (_v, i) => rawLetter(`m-${i}`));
    expect(mailFromTool(tool({ text: page(many) }))?.letters).toHaveLength(50);
  });
});
