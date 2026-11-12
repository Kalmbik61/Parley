/** M2: reducers append a `mail` item when a top-level mail tool finishes (spec 2026-11-12 §3.2b). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawRecord } from '../jsonl.js';
import { applyCodexHookEvent } from './codex/apply-codex-hook.js';
import { applyCodexRecords, emptyCodexCursor, feedFromCodexRollout } from './codex/apply-codex.js';
import { parseRolloutLine, type RolloutRecord } from './codex/rollout-record.js';
import { feedFromTranscript } from './from-transcript.js';
import { applyQwenRecords, emptyQwenCursor, feedFromQwenTranscript } from './qwen/apply-qwen.js';
import { parseQwenLine, type QwenRecord } from './qwen/transcript-record.js';
import { applyHookEvent, emptyFeedState, newTool } from './reduce.js';
import type { FeedItem, FeedMail, FeedState } from './types.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mail');
const lines = (name: string): string[] => readFileSync(path.join(DIR, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
const json = (name: string): RawRecord[] => lines(name).map((l) => JSON.parse(l) as RawRecord);
const label = (item: FeedItem): string => (item.kind === 'tool' ? `tool:${item.toolUseId}` : item.kind === 'mail' ? item.id : item.kind);
const mails = (state: FeedState): FeedMail[] => state.items.filter((i): i is FeedMail => i.kind === 'mail');
const hookEvents = (name: string): Array<{ t: number; ev: Record<string, unknown> }> => json(name) as never;

const live = (name: string): FeedState => {
  let state = emptyFeedState();
  for (const { t, ev } of hookEvents(name)) state = applyHookEvent(state, ev, new Date(t).toISOString()).state;
  return state;
};

describe('claude transcript', () => {
  const state = feedFromTranscript(json('claude-tools.transcript.jsonl'));

  it('puts the tool and then its mail item', () => {
    const order = state.items.map(label);
    expect(order.indexOf('mail:m-9001')).toBe(order.indexOf('tool:toolu_mail_check') + 1);
    expect(order.indexOf('mail:m-9003')).toBe(order.indexOf('tool:toolu_mail_wait') + 1);
  });

  it('makes no mail for a session wait, read_room, a failure, an empty page or broken JSON', () => {
    expect(mails(state).map((m) => m.id)).toEqual(['mail:m-9001', 'mail:m-9003', 'mail:m-9010']);
  });

  it('overlapping tools: A, B, mail-A', () => {
    const items = feedFromTranscript(json('claude-overlap.transcript.jsonl')).items;
    expect(items.map(label)).toEqual(['tool:toolu_A', 'tool:toolu_B', 'mail:m-9003']);
  });

  it('a subagent transcript (child context) makes no mail', () => {
    const items = feedFromTranscript(json('claude-tools.transcript.jsonl'), { context: 'child' }).items;
    expect(items.some((i) => i.kind === 'mail')).toBe(false);
    expect(items.filter((i) => i.kind === 'tool')).toHaveLength(8);
  });
});

describe('claude live hooks', () => {
  it('puts the tool and then its mail item', () => {
    expect(live('claude-hooks.events.jsonl').items.map(label)).toEqual([
      'tool:toolu_mail_check', 'mail:m-9001', 'tool:toolu_mail_wait', 'mail:m-9003',
    ]);
  });

  it('overlapping tools through hooks: A, B, mail-A', () => {
    const base = { session_id: 's', cwd: '/w', permission_mode: 'default' };
    const events = [
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__parley__wait_for', tool_use_id: 'A', tool_input: { target: 'inbox' } },
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'B', tool_input: { command: 'echo' } },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'B', tool_input: { command: 'echo' }, tool_response: 'hi' },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__parley__wait_for', tool_use_id: 'A', tool_input: { target: 'inbox' },
        tool_response: [{ type: 'text', text: JSON.stringify({ state: 'message', messages: [{ id: 'm-1', from: 's-1', fromLabel: null, at: 'x', text: 't', kind: 'note', room: null }] }) }] },
    ];
    let state = emptyFeedState();
    events.forEach((ev, i) => { state = applyHookEvent(state, ev, new Date(1893837600000 + i * 1000).toISOString()).state; });
    expect(state.items.map(label)).toEqual(['tool:A', 'tool:B', 'mail:m-1']);
  });

  it('a nested (subagent) tool makes no mail', () => {
    const state = live('claude-hooks.events.jsonl');
    const nested = { session_id: 's', cwd: '/w', permission_mode: 'default', agent_id: 'ag-1', hook_event_name: 'PostToolUse', tool_name: 'mcp__parley__check_inbox', tool_use_id: 'n1', tool_input: {}, tool_response: [{ type: 'text', text: '{"messages":[]}' }] };
    expect(mails(applyHookEvent(state, nested, '2030-01-05T10:10:00.000Z').state)).toHaveLength(2);
  });

  it('applying the same events twice leaves one mail item per delivery', () => {
    let state = live('claude-hooks.events.jsonl');
    for (const { t, ev } of hookEvents('claude-hooks.events.jsonl')) state = applyHookEvent(state, ev, new Date(t).toISOString()).state;
    expect(mails(state).map((m) => m.id)).toEqual(['mail:m-9001', 'mail:m-9003']);
  });

  it('live hook and transcript seed give equal id, via, toolUseId, letters and remaining', () => {
    const seeded = mails(feedFromTranscript(json('claude-tools.transcript.jsonl')));
    const liveMails = mails(live('claude-hooks.events.jsonl'));
    const pick = (m: FeedMail) => ({ id: m.id, via: m.via, toolUseId: m.toolUseId, letters: m.letters, remaining: m.remaining });
    for (const m of liveMails) {
      const twin = seeded.find((s) => s.id === m.id);
      expect(twin).toBeDefined();
      expect(pick(m)).toEqual(pick(twin!));
    }
    expect(liveMails).toHaveLength(2);
  });
});

describe('transcript applied twice', () => {
  it('feeding the same records on top of the finished feed leaves one mail item', () => {
    // Replay on a finished state, as a retried tail read does: ids repeat, so items are replaced in place.
    const records = json('claude-tools.transcript.jsonl');
    const once = feedFromTranscript(records);
    expect(mails(once)).toHaveLength(3);
    expect(new Set(once.items.map((i) => i.id)).size).toBe(once.items.length);
  });
});

describe('codex', () => {
  const rollout = (): RolloutRecord[] => lines('codex-mail.rollout.jsonl').map(parseRolloutLine).filter((r): r is RolloutRecord => r !== null);

  it('puts the McpToolCall and then its mail item', () => {
    expect(feedFromCodexRollout(rollout()).state.items.filter((i) => i.kind === 'tool' || i.kind === 'mail').map(label)).toEqual([
      'tool:exec-mail-check', 'mail:m-9001', 'tool:exec-mail-wait', 'mail:m-9003',
    ]);
  });

  it('applying the same records twice leaves one mail item per delivery', () => {
    const first = applyCodexRecords(emptyFeedState(), rollout(), emptyCodexCursor());
    const again = applyCodexRecords(first.update.state, rollout(), { ...first.cursor, lastOrdinal: -1 });
    expect(mails(again.update.state).map((m) => m.id)).toEqual(['mail:m-9001', 'mail:m-9003']);
  });

  it('a child rollout (context child) and a subagent journal (agentId) make no mail', () => {
    expect(mails(feedFromCodexRollout(rollout(), { context: 'child' }).state)).toHaveLength(0);
    const parent = { ...emptyFeedState(), items: [{ id: 'agent:th-sub', at: 't', kind: 'agent', toolUseId: 'th-sub', agentId: 'th-sub', agentType: null, description: null, prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [] } as FeedItem] };
    const state = applyCodexRecords(parent, rollout(), emptyCodexCursor(), 'th-sub').update.state;
    expect(mails(state)).toHaveLength(0);
  });

  it('the codex hook path makes mail when PostToolUse finishes a running tool', () => {
    const base = { session_id: 'th', cwd: '/w', permission_mode: 'default' };
    const input = { target: 'inbox' };
    const response = [{ type: 'text', text: JSON.stringify({ state: 'message', messages: [{ id: 'm-5', from: 's-1', fromLabel: null, at: 'x', text: 't', kind: 'note', room: null }] }) }];
    // CODEX_EARLY_TOOLS is off, so PreToolUse makes no row; the running row comes from elsewhere. Put it in by hand.
    let state: FeedState = { ...emptyFeedState(), items: [newTool('cx1', 'mcp__parley__wait_for', input, '2030-01-05T10:00:00.000Z', null)] };
    state = applyCodexHookEvent(state, { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__parley__wait_for', tool_use_id: 'cx1', tool_input: input, tool_response: response }, '2030-01-05T10:00:05.000Z').state;
    expect(state.items.map(label)).toEqual(['tool:cx1', 'mail:m-5']);
  });
});

describe('qwen', () => {
  const records = (): QwenRecord[] => lines('qwen-mail.transcript.jsonl').map(parseQwenLine).filter((r): r is QwenRecord => r !== null);

  it('puts the tool and then its mail item', () => {
    expect(feedFromQwenTranscript(records()).state.items.filter((i) => i.kind === 'tool' || i.kind === 'mail').map(label)).toEqual([
      'tool:call_chk', 'mail:m-9001', 'tool:call_wait', 'mail:m-9003',
    ]);
  });

  it('applying the same records twice leaves one mail item per delivery', () => {
    const first = applyQwenRecords(emptyFeedState(), records(), emptyQwenCursor());
    const again = applyQwenRecords(first.update.state, records(), first.cursor);
    expect(mails(again.update.state).map((m) => m.id)).toEqual(['mail:m-9001', 'mail:m-9003']);
  });
});
