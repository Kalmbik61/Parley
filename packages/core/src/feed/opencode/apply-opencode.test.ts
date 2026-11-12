import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mailFromTool } from '../mail.js';
import { emptyFeedState } from '../reduce.js';
import type { FeedMail, FeedTool } from '../types.js';
import { applyOpencodeMessages, emptyOpencodeCursor, feedFromOpencodeMessages, mailFromExecute } from './apply-opencode.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const messages = (name: string): unknown[] => (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { data: unknown[] }).data;
const main = messages('messages-main.json');
const mail = messages('messages-mail.json');
// Recordings of the mock lab (tools/opencode-mock-lab/recorded): newest first, as the API lists them.
const labTurn = messages('lab-turn.json');
const labExecuteError = messages('lab-execute-error.json');
const labModelError = messages('lab-model-error.json');

describe('opencode messages: main fixture', () => {
  const { state, cursor } = feedFromOpencodeMessages(main);
  const kinds = state.items.map((i) => i.kind);

  it('gives prompt, text, tool and turn items in order; reasoning and system stay hidden', () => {
    expect(kinds).toEqual(['prompt', 'text', 'tool', 'tool', 'text', 'turn', 'prompt', 'text', 'tool']);
    expect(JSON.stringify(state.items)).not.toContain('secret thoughts');
    expect(JSON.stringify(state.items)).not.toContain('ignored');
  });

  it('shows prompts and texts by message id', () => {
    expect(state.items.filter((i) => i.kind === 'prompt').map((i) => i.id)).toEqual(['prompt:msg_u1', 'prompt:msg_u2']);
    expect(state.items.filter((i) => i.kind === 'text').map((i) => [i.id, (i as { streaming: boolean }).streaming])).toEqual([
      ['text:msg_a1:1', false],
      ['text:msg_a1:2', false],
      ['text:msg_a2:1', true],
    ]);
  });

  it('closes tools: completed is done, error is failed with its message, running stays running', () => {
    const tools = state.items.filter((i): i is FeedTool => i.kind === 'tool');
    expect(tools.map((t) => [t.toolUseId, t.name, t.status])).toEqual([
      ['call_1', 'execute', 'done'],
      ['call_3', 'write', 'failed'],
      ['call_4', 'shell', 'running'],
    ]);
    expect(tools[0]?.response?.text).toBe('pong:{"msg":"hi"}');
    expect(tools[1]?.response?.text).toContain('Invalid arguments');
  });

  it('idle closes the first turn only; the second turn stays open', () => {
    expect(state.items.filter((i) => i.kind === 'turn')).toHaveLength(1);
    expect(state.turnStartedAt).not.toBeNull();
  });

  it('counts the unknown type and keeps the usage of the finished assistant message', () => {
    expect(cursor.unknownTypes).toEqual({ 'future-thing': 1 });
    expect(cursor.usage).toEqual({ inputTokens: 11, outputTokens: 7, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 });
  });
});

describe('opencode messages: idempotence', () => {
  it.each([['main', main], ['mail', mail], ['lab turn', labTurn], ['lab execute error', labExecuteError], ['lab model error', labModelError]])('applying the %s list twice changes nothing', (_n, list) => {
    const first = applyOpencodeMessages(emptyFeedState(), list, emptyOpencodeCursor());
    const second = applyOpencodeMessages(first.update.state, list, first.cursor);
    expect(second.update.state).toEqual(first.update.state);
    expect(second.update.changes).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it('applies a growing list in pieces to the same state as in one go', () => {
    const whole = feedFromOpencodeMessages(main).state;
    let state = emptyFeedState();
    let cursor = emptyOpencodeCursor();
    for (const end of [2, 4, main.length]) {
      ({ update: { state }, cursor } = applyOpencodeMessages(state, main.slice(0, end), cursor));
    }
    expect(state).toEqual(whole);
  });

  it('finishes a running tool when a later poll shows it completed', () => {
    const running = main.slice(-3);
    const done = JSON.parse(JSON.stringify(running)) as Array<Record<string, unknown>>;
    const part = (done[1]?.['content'] as Array<Record<string, unknown>>)[1]!;
    part['state'] = { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.txt' }] };
    part['time'] = { created: 1794478200200, completed: 1794478201000 };
    const a = applyOpencodeMessages(emptyFeedState(), running, emptyOpencodeCursor());
    const b = applyOpencodeMessages(a.update.state, done, a.cursor);
    const tool = b.update.state.items.find((i): i is FeedTool => i.kind === 'tool');
    expect(tool?.status).toBe('done');
    expect(tool?.response?.text).toBe('a.txt');
  });
});

describe('opencode messages: mail from Code Mode', () => {
  const { state } = feedFromOpencodeMessages(mail);
  const mails = state.items.filter((i): i is FeedMail => i.kind === 'mail');
  const tools = state.items.filter((i): i is FeedTool => i.kind === 'tool');

  it('gives mail for check_inbox and wait_for({target:"inbox"}) (also in the MCP wrapper), not for read_room', () => {
    expect(mails.map((m) => [m.id, m.via, m.toolUseId])).toEqual([
      ['mail:m-9001', 'check_inbox', 'call_chk'],
      ['mail:m-9003', 'wait_for', 'call_wait'],
    ]);
    expect(tools.map((t) => t.toolUseId)).toEqual(['call_chk', 'call_wait', 'call_ping']);
  });

  it('equals what mailFromTool gives for the same inbox page', () => {
    const check = tools.find((t) => t.toolUseId === 'call_chk')!;
    const direct = mailFromTool({ ...check, name: 'mcp__parley__check_inbox', input: {} });
    expect(mails[0]).toEqual(direct);
    expect(mails[0]).toMatchObject({ remaining: 3, letters: [{ id: 'm-9001', kind: 'question' }, { id: 'm-9002', kind: 'note' }] });
    const wait = tools.find((t) => t.toolUseId === 'call_wait')!;
    expect(mails[1]).toEqual(mailFromTool({ ...wait, name: 'mcp__parley__wait_for', input: { target: 'inbox' } }));
  });

  it('gives no mail for a failed or foreign execute call', () => {
    const check = tools.find((t) => t.toolUseId === 'call_chk')!;
    expect(mailFromExecute({ ...check, status: 'failed' }, 'return await tools.parley.check_inbox({})')).toBeNull();
    expect(mailFromExecute(check, 'return await tools.parley.get_map({})')).toBeNull();
    expect(mailFromExecute({ ...check, name: 'shell' }, 'tools.parley.check_inbox()')).toBeNull();
  });
});

describe('opencode messages: recordings of the mock lab', () => {
  it('builds the turn oldest first from a newest-first list: prompt, shell, execute with mail, text, turn', () => {
    const { state } = feedFromOpencodeMessages(labTurn);
    expect(state.items.map((i) => i.kind)).toEqual(['prompt', 'tool', 'tool', 'mail', 'text', 'turn']);
    const tools = state.items.filter((i): i is FeedTool => i.kind === 'tool');
    expect(tools.map((t) => [t.name, t.status])).toEqual([['shell', 'done'], ['execute', 'done']]);
    const mailItem = state.items.find((i): i is FeedMail => i.kind === 'mail')!;
    expect(mailItem).toMatchObject({ id: 'mail:m-1', via: 'check_inbox', letters: [{ id: 'm-1', from: 's-1', kind: 'note' }] });
    expect(mailItem).toEqual(mailFromTool({ ...tools[1]!, name: 'mcp__parley__check_inbox', input: {} }));
    expect(state.turnStartedAt).toBeNull();
  });

  it('a throwing execute (completed with metadata.error) is a failed tool and gives no mail', () => {
    const { state } = feedFromOpencodeMessages(labExecuteError);
    const tool = state.items.find((i): i is FeedTool => i.kind === 'tool')!;
    expect(tool).toMatchObject({ status: 'failed' });
    expect(tool.response?.text).toBe('Error: boom from execute');
    expect(state.items.some((i) => i.kind === 'mail')).toBe(false);
  });

  it('a failed model turn closes with the prompt and no assistant text', () => {
    const { state } = feedFromOpencodeMessages(labModelError);
    expect(state.items.map((i) => i.kind)).toEqual(['prompt', 'turn']);
  });
});
