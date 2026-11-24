import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyScreen, selectedOption } from './parley-token-benchmark-drive.js';
import {
  answerCards,
  baseToolName,
  cleanScreen,
  describeNoPty,
  isHooksReview,
  buildScenario,
  judgeAnswers,
  median,
  mergeRows,
  nextAction,
  parseClaudeTranscript,
  parseCodexRollout,
  readRows,
  recordRows,
  reparseRow,
  renderMarkdown,
  stopReason,
  trustKey,
  weightedCost,
  type RunRow,
  type TimelineState,
} from './mail-turns-bench.js';

const lines = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n');

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output,
});

describe('parseClaudeTranscript', () => {
  const transcript = lines(
    { type: 'user', message: { role: 'user', content: 'prompt' } },
    // one message logged once per content block: the same id and usage count once
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet', usage: usage(3, 1000, 200, 5), content: [{ type: 'text', text: 'ok' }] } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet', usage: usage(3, 1000, 200, 40), content: [{ type: 'tool_use', id: 't1', name: 'mcp__parley__send_message', input: { to: 'human', text: 'ready' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-sonnet', usage: usage(1, 1300, 0, 12), content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley__wait_for', input: { target: 'inbox', timeoutSec: 1500 } }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'MCP tool "parley/wait_for" is still running after 120s. It was moved to the background…' }] }] },
    },
    { type: 'assistant', message: { id: 'm3', model: 'claude-sonnet', usage: usage(1, 1400, 0, 8), content: [{ type: 'tool_use', id: 't3', name: 'mcp__parley__check_inbox', input: {} }] } },
    { type: 'assistant', message: { id: 'm4', model: '<synthetic>', usage: usage(0, 0, 0, 0), content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'assistant', message: { id: 'm5', model: 'claude-sonnet', usage: usage(1, 1500, 0, 6), content: [{ type: 'tool_use', id: 't4', name: 'mcp__parley__send_message', input: { to: 'human', text: '42' } }, { type: 'tool_use', id: 't5', name: 'mcp__parley__report', input: { status: 'done', summary: 's' } }] } },
  );

  it('counts distinct assistant message ids, not content blocks or synthetic messages', () => {
    expect(parseClaudeTranscript(transcript).responses).toBe(4);
  });

  it('takes the largest usage per message and sums the responses', () => {
    expect(parseClaudeTranscript(transcript).tokens).toEqual({ input: 6, cacheRead: 5200, cacheWrite: 200, output: 66 });
  });

  it('counts tool calls by name, check_inbox, background results, sent texts and report', () => {
    const metrics = parseClaudeTranscript(transcript);
    expect(metrics.toolCalls).toEqual({
      mcp__parley__send_message: 2, mcp__parley__wait_for: 1, mcp__parley__check_inbox: 1, mcp__parley__report: 1,
    });
    expect(metrics.checkInboxCalls).toBe(1);
    expect(metrics.backgroundedResults).toBe(1);
    expect(metrics.sentTexts).toEqual(['ready', '42']);
    expect(metrics.reported).toBe(true);
  });

  it('skips broken and half-written lines', () => {
    expect(parseClaudeTranscript(`${transcript}\n{"type":"assis`).responses).toBe(4);
  });

  it('does not count a repeated tool result twice', () => {
    const background = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'moved to the background' }] } };
    expect(parseClaudeTranscript(`${transcript}\n${JSON.stringify(background)}`).backgroundedResults).toBe(1);
  });
});

describe('parseCodexRollout', () => {
  const token = (total: number, last: { input: number; cached: number; output: number }) => ({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output, total_tokens: last.input + last.output } } },
  });
  const rollout = lines(
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    { type: 'response_item', payload: { type: 'function_call', name: 'mcp__parley__send_message', call_id: 'c1', arguments: JSON.stringify({ to: 'human', text: 'ready' }) } },
    token(1100, { input: 1000, cached: 0, output: 100 }),
    // Codex repeats a record with the same totals: one response
    token(1100, { input: 1000, cached: 0, output: 100 }),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'sent' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'parley.wait_for', call_id: 'c2', arguments: '{"target":"inbox"}' } },
    token(2300, { input: 1100, cached: 900, output: 100 }),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: { content: [{ type: 'text', text: 'call was moved to the background' }] } } },
    { type: 'response_item', payload: { type: 'function_call', name: 'check_inbox', call_id: 'c3', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'report', call_id: 'c4', arguments: '{"status":"done"}' } },
    token(3500, { input: 1200, cached: 1000, output: 0 }),
  );

  it('counts one response per moved cumulative total and splits cached input', () => {
    const metrics = parseCodexRollout(rollout);
    expect(metrics.responses).toBe(3);
    expect(metrics.tokens).toEqual({ input: 1000 + 200 + 200, cacheRead: 1900, cacheWrite: 0, output: 200 });
  });

  it('counts calls by name with provider spellings, background results, check_inbox, sent texts and report', () => {
    const metrics = parseCodexRollout(rollout);
    expect(metrics.toolCalls).toEqual({ mcp__parley__send_message: 1, 'parley.wait_for': 1, check_inbox: 1, report: 1 });
    expect(metrics.checkInboxCalls).toBe(1);
    expect(metrics.backgroundedResults).toBe(1);
    expect(metrics.sentTexts).toEqual(['ready']);
    expect(metrics.reported).toBe(true);
  });
});

describe('baseToolName', () => {
  it('cuts server prefixes', () => {
    expect(['mcp__parley__wait_for', 'parley.wait_for', 'parley:wait_for', 'parley/wait_for', 'wait_for'].map(baseToolName)).toEqual(Array(5).fill('wait_for'));
  });
});

describe('scenario timeline', () => {
  const state = (over: Partial<TimelineState> = {}): TimelineState => ({ promptAt: 1000, sentAt: [], stopTimes: [], ...over });

  it('W: letters after 20 s, 150 s, 150 s, then STOP after 20 s, each from the previous one', () => {
    const w = buildScenario('W');
    expect(w.steps.map((s) => [s.anchor, s.delayMs / 1000, s.text])).toEqual([
      ['previous', 20, 'Number: 41'], ['previous', 150, 'Number: 57'], ['previous', 150, 'Number: 73'], ['previous', 20, 'STOP'],
    ]);
    expect(w.expectedAnswers).toEqual(['42', '58', '74']);
    expect(nextAction(w, state(), 20_999)).toEqual({ kind: 'wait' });
    expect(nextAction(w, state(), 21_000)).toEqual({ kind: 'send', index: 0 });
    // the clock of the next letter starts at the previous letter, not at the answer
    expect(nextAction(w, state({ sentAt: [21_500] }), 171_499)).toEqual({ kind: 'wait' });
    expect(nextAction(w, state({ sentAt: [21_500] }), 171_500)).toEqual({ kind: 'send', index: 1 });
    expect(nextAction(w, state({ sentAt: [21_500, 171_500, 321_500] }), 341_500)).toEqual({ kind: 'send', index: 3 });
  });

  it('W: done only at a turn end after the STOP letter', () => {
    const w = buildScenario('W');
    const sent = [21_000, 171_000, 321_000, 341_000];
    expect(nextAction(w, state({ sentAt: sent, stopTimes: [100_000] }), 400_000)).toEqual({ kind: 'wait' });
    expect(nextAction(w, state({ sentAt: sent, stopTimes: [100_000, 350_000] }), 400_000)).toEqual({ kind: 'done' });
  });

  it('P: each letter 30 s after a turn end, not before the session has ended its turn', () => {
    const p = buildScenario('P');
    expect(p.expectedAnswers).toEqual(['119', '237']);
    expect(nextAction(p, state(), 999_999)).toEqual({ kind: 'wait' });
    expect(nextAction(p, state({ stopTimes: [10_000] }), 39_999)).toEqual({ kind: 'wait' });
    expect(nextAction(p, state({ stopTimes: [10_000] }), 40_000)).toEqual({ kind: 'send', index: 0 });
    // the second letter waits for the turn end that answers the first one
    expect(nextAction(p, state({ sentAt: [40_000], stopTimes: [10_000] }), 999_999)).toEqual({ kind: 'wait' });
    expect(nextAction(p, state({ sentAt: [40_000], stopTimes: [10_000, 45_000] }), 74_999)).toEqual({ kind: 'wait' });
    expect(nextAction(p, state({ sentAt: [40_000], stopTimes: [10_000, 45_000] }), 75_000)).toEqual({ kind: 'send', index: 1 });
    expect(nextAction(p, state({ sentAt: [40_000, 75_000], stopTimes: [10_000, 45_000, 80_000] }), 80_000)).toEqual({ kind: 'done' });
  });

  it('scales delays for dry runs', () => {
    expect(buildScenario('P', 0.1).steps[0]?.delayMs).toBe(3000);
  });
});

describe('stopReason', () => {
  it('stops at 40 responses or 15 minutes', () => {
    expect(stopReason({ responses: 39, elapsedMs: 899_999 })).toBeNull();
    expect(stopReason({ responses: 40, elapsedMs: 1 })).toBe('response-limit');
    expect(stopReason({ responses: 3, elapsedMs: 900_000 })).toBe('time-limit');
  });
});

describe('judgeAnswers', () => {
  const w = buildScenario('W');
  it('accepts ready, then the numbers in order, then report', () => {
    expect(judgeAnswers(w, { sentTexts: ['ready', '42', '58', '74'], reported: true })).toEqual({ correct: true, problems: [] });
  });
  it('rejects a missing or wrong answer, a wrong order, a part of a number and a missing report', () => {
    expect(judgeAnswers(w, { sentTexts: ['ready', '42', '59', '74'], reported: true }).problems).toEqual(['no message with 58 (in order)']);
    expect(judgeAnswers(w, { sentTexts: ['ready', '58', '42', '74'], reported: true }).correct).toBe(false);
    expect(judgeAnswers(w, { sentTexts: ['ready', '42', '158', '74'], reported: true }).correct).toBe(false);
    expect(judgeAnswers(w, { sentTexts: ['42', '58', '74'], reported: true }).problems[0]).toContain('ready');
    expect(judgeAnswers(w, { sentTexts: ['ready', '42', '58', '74'], reported: false }).problems).toEqual(['report was not called']);
  });
  it('P needs both answers but not ready', () => {
    expect(judgeAnswers(buildScenario('P'), { sentTexts: ['Answer: 119', '237'], reported: true }).correct).toBe(true);
    expect(judgeAnswers(buildScenario('P'), { sentTexts: ['119'], reported: true }).correct).toBe(false);
  });
});

describe('rows and tables', () => {
  const row = (run: number, over: Partial<RunRow> = {}): RunRow => ({
    id: `r${run}`, arm: 'baseline', provider: 'claude', model: 'sonnet', effort: 'medium', scenario: 'W', run, outcome: 'completed',
    correct: true, problems: [], responses: 10 * run, toolCalls: { mcp__parley__wait_for: run }, checkInboxCalls: run, backgroundedResults: 0,
    tokens: { input: 1, cacheRead: 10, cacheWrite: 2, output: 3 }, weightedCost: 1 + 1 + 2.5 + 15, wallSeconds: 100 * run,
    lettersSentAtSeconds: [], providerSessionId: null, log: null, mcpServersListed: [], screen: null, consentAnswers: [], repo: '/r', startedAt: '2026-11-11T00:00:00Z', ...over,
  });

  it('weights tokens by the plan', () => {
    expect(weightedCost({ input: 1, cacheRead: 10, cacheWrite: 2, output: 3 })).toBe(19.5);
  });

  it('median of odd and even lists', () => {
    expect([median([3, 1, 2]), median([4, 1, 3, 2]), median([])]).toEqual([2, 2.5, null]);
  });

  it('lists a failed run and leaves it out of the median', () => {
    const md = renderMarkdown([row(1), row(2), row(3, { outcome: 'time-limit', correct: false, responses: null, tokens: null, weightedCost: null, wallSeconds: null, problems: ['no provider log found'] })]);
    expect(md).toContain('## Scenario W, arm baseline (claude sonnet medium)');
    expect(md).toContain('| responses | 15 | 10, 20 |');
    expect(md).toContain('| wait_for | 1.5 | 1, 2 |');
    expect(md).toContain('| 3 | time-limit | false | n/a | n/a | no provider log found |');
    expect(md).not.toContain('Fewer than 3 runs');
    expect(renderMarkdown([row(1), row(2)])).toContain('Fewer than 3 runs: no comparison');
  });

  it('makes one table per scenario and arm', () => {
    const md = renderMarkdown([row(1), row(1, { arm: 'treatment' }), row(1, { scenario: 'P' })]);
    expect(md.match(/^## /gm)).toHaveLength(3);
  });

  it('a later row with the same id replaces the earlier one', () => {
    expect(mergeRows([row(1), row(2)], [row(2, { outcome: 'x' })]).map((r) => r.outcome)).toEqual(['completed', 'x']);
  });
});

describe('describeNoPty', () => {
  it('names the session state, the machine queue and the host notices', () => {
    const text = describeNoPty({
      session: { lifecycle: 'idle', provider: 'claude', queued: { reason: 'machine-limit' } },
      capacity: { machine: { live: 3, limit: 3 }, queue: [{}] },
      notices: ['launch-failed: no budget'],
      waitedMs: 90_000,
    });
    expect(text).toContain('no live PTY after 90 s');
    expect(text).toContain('lifecycle=idle');
    expect(text).toContain('"reason":"machine-limit"');
    expect(text).toContain('queue=1');
    expect(text).toContain('host notices: launch-failed: no budget');
  });
  it('says so when the session or the notices are missing', () => {
    expect(describeNoPty({ session: null, capacity: null, notices: [], waitedMs: 1000 })).toBe('no live PTY after 1 s; session is not in the map; no host notices');
  });
});

describe('answerCards', () => {
  const ctx = { workRoot: '/tmp/mtb-work-x', trustCopies: true };
  it('denies a project MCP card (all servers disabled) and lists its servers with the revision', () => {
    const [answer] = answerCards([{ id: 'c-1', kind: 'project-mcp', state: 'pending', revision: 2, servers: [{ name: 'a', command: 'npx a' }, { name: 'b' }] }], ctx);
    expect(answer?.decide).toEqual({ id: 'c-1', decision: 'deny', revision: 2 });
    expect(answer?.servers).toEqual(['a (npx a)', 'b']);
  });
  it('allows folder trust only for the throwaway copy and only with trustCopies', () => {
    const card = { id: 'c-2', kind: 'folder-trust', state: 'pending', folder: '/tmp/mtb-work-x/project' };
    expect(answerCards([card], ctx)[0]?.decide).toEqual({ id: 'c-2', decision: 'allow' });
    expect(answerCards([card], { ...ctx, trustCopies: false })).toEqual([]);
    expect(answerCards([{ ...card, folder: '/Users/someone/project' }], ctx)).toEqual([]);
  });
  it('leaves decided cards and other kinds alone', () => {
    expect(answerCards([{ id: 'c-3', kind: 'project-mcp', state: 'denied' }, { id: 'c-4', kind: 'agent-switch', state: 'pending' }], ctx)).toEqual([]);
  });
});

describe('trust screen and the real path', () => {
  const screen = (dir: string): string => `Is this a project you created or one you trust?\n${dir}/project\n❯ 1. Yes, I trust this folder\n  2. No, exit`;
  it('is ours with real paths; a /tmp copy is still found inside the /private/tmp screen text, so the path is not the cause by itself', () => {
    const shown = screen('/private/tmp/mtb-work-x');
    expect(classifyScreen(shown, '/private/tmp/mtb-work-x/project', '/private/tmp/mtb-work-x', 'claude')).toMatchObject({ kind: 'trust', ours: true, selected: 'yes' });
    expect(classifyScreen(shown, '/tmp/mtb-work-x/project', '/tmp/mtb-work-x', 'claude')).toMatchObject({ kind: 'trust', ours: true });
  });
  it('is not ours for a folder outside the work root, and has no selection without the marker line', () => {
    expect(classifyScreen(screen('/private/tmp/other'), '/private/tmp/other/project', '/private/tmp/mtb-work-x', 'claude')).toMatchObject({ ours: false });
    expect(classifyScreen('Is this a project you created or one you trust?\n/private/tmp/mtb-work-x/project', '/private/tmp/mtb-work-x/project', '/private/tmp/mtb-work-x', 'claude')).toMatchObject({ selected: null });
  });
});

describe('trust screen of Claude Code 2.1.322', () => {
  // the screen text arrives with spaces stripped; the cursor starts on "No, exit"
  const shown = (first: string, second: string): string => `Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\n/private/tmp/mtb-work-x/project\n${first}\n${second}\nEntertoconfirm·Esctocancel`;
  const onNo = shown('❯No,exit', 'Yes,Itrustthisfolder');
  const onYes = shown('No,exit', '❯Yes,Itrustthisfolder');
  const classify = (text: string) => classifyScreen(text, '/private/tmp/mtb-work-x/project', '/private/tmp/mtb-work-x', 'claude');

  it('reads the cursor on No, then on Yes', () => {
    expect(selectedOption(onNo)).toBe('no');
    expect(selectedOption(onYes)).toBe('yes');
  });
  it('presses Down on No and Enter only on Yes', () => {
    expect(trustKey(classify(onNo) as { ours: boolean; selected: 'no' }, 0)).toBe('down');
    expect(trustKey(classify(onYes) as { ours: boolean; selected: 'yes' }, 1)).toBe('enter');
  });
  it('never presses Enter on No; stops when Down did not help, on a foreign folder or an unknown option', () => {
    expect(trustKey({ ours: true, selected: 'no' }, 2)).toBe('stop');
    expect(trustKey({ ours: false, selected: 'yes' }, 0)).toBe('stop');
    expect(trustKey({ ours: true, selected: 'other' }, 0)).toBe('stop');
    expect(trustKey({ ours: true, selected: null }, 0)).toBe('stop');
  });
});

describe('Codex 0.166 rollout of the pilot (trimmed real log, scenario W)', () => {
  const rollout = readFileSync(new URL('./fixtures/codex-rollout-w-pilot.jsonl', import.meta.url), 'utf8');
  const metrics = parseCodexRollout(rollout);

  it('counts Parley calls from the exec scripts and keeps exec and wait as their own counters', () => {
    expect(metrics.toolCalls).toEqual({
      exec: 10, wait: 11, mcp__parley__get_map: 1, mcp__parley__send_message: 4, mcp__parley__wait_for: 4, mcp__parley__report: 1,
    });
    expect(metrics.sentTexts).toEqual(['ready', '42', '58', '74']);
    expect(metrics.reported).toBe(true);
    expect(metrics.checkInboxCalls).toBe(0);
  });
  it('counts wait polls of a running cell and scripts that yielded one', () => {
    expect(metrics.waitPolls).toBe(9);
    expect(metrics.yieldedCells).toBe(2);
  });
  it('counts one response per token_count and takes the turn end from task_complete', () => {
    expect(metrics.responses).toBe(22);
    expect(metrics.turnsCompleted).toBe(1);
    expect(metrics.lastCompleteMs).toBeGreaterThan(metrics.firstStartMs as number);
    expect(metrics.tokens.cacheWrite).toBe(0);
    expect(metrics.tokens.input + metrics.tokens.cacheRead).toBe(456029 - metrics.tokens.output);
  });
  it('judges the pilot answers correct', () => {
    expect(judgeAnswers(buildScenario('W'), metrics).correct).toBe(true);
  });
  it('reads several Parley calls in one script, single quotes, and an unquoted text as no text', () => {
    const script = "const a = await tools.mcp__parley__send_message({to:'human', text:'7'}); text(await tools.mcp__parley__check_inbox({}));";
    const one = parseCodexRollout(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: script } }));
    expect(one.toolCalls).toEqual({ exec: 1, mcp__parley__send_message: 1, mcp__parley__check_inbox: 1 });
    expect(one.sentTexts).toEqual(['7']);
    expect(one.checkInboxCalls).toBe(1);
  });
  it('re-parses a row the harness stopped at the time limit: completed, wall time from the rollout, original outcome kept', () => {
    const row = {
      id: 'x', arm: 'baseline', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', scenario: 'W', run: 1, outcome: 'time-limit', correct: false,
      problems: ['no message with 42 (in order)'], responses: 22, toolCalls: { exec: 10 }, checkInboxCalls: 0, backgroundedResults: 0, tokens: null,
      weightedCost: null, wallSeconds: 900, lettersSentAtSeconds: [], providerSessionId: null, log: null, mcpServersListed: [], screen: null, consentAnswers: [], repo: '/r', startedAt: 'now',
    } as RunRow;
    const next = reparseRow(row, rollout);
    expect(next.outcome).toBe('completed');
    expect(next.correct).toBe(true);
    expect(next.wallSeconds).toBe(345);
    expect(next.problems[0]).toContain('recorded time-limit after 900 s');
    expect(next.waitPolls).toBe(9);
  });
});

describe('Codex hooks review screen', () => {
  const screen = readFileSync(new URL('./fixtures/codex-hooks-review-screen.txt', import.meta.url), 'utf8');
  it('is recognised from the real screen text', () => {
    expect(isHooksReview(screen)).toBe(true);
    expect(isHooksReview('Trust this folder?\n1. Trust and continue\nesc quit')).toBe(false);
    expect(isHooksReview(cleanScreen(screen))).toBe(true);
  });
  it('cleanScreen drops carriage returns, trailing blanks and trailing empty lines', () => {
    const clean = cleanScreen(screen);
    expect(clean).not.toContain('\r');
    expect(clean.split('\n').every((line) => line === line.trimEnd())).toBe(true);
    expect(clean.endsWith('esc skip\n')).toBe(true);
    expect(clean.replace(/\s+/g, '')).toContain('3.Continuewithouttrusting(hookswon\'trun)');
  });
});

describe('recordRows', () => {
  const base = (id: string, over: Partial<RunRow> = {}): RunRow => ({
    id, arm: 'baseline', provider: 'claude', model: 'sonnet', effort: 'medium', scenario: 'W', run: 1, outcome: 'completed', correct: true, problems: [],
    responses: 5, toolCalls: {}, checkInboxCalls: 0, backgroundedResults: 0, tokens: null, weightedCost: null, wallSeconds: 1, lettersSentAtSeconds: [],
    providerSessionId: null, log: null, mcpServersListed: [], screen: null, consentAnswers: [], repo: '/r', startedAt: 'now', ...over,
  });
  it('keeps a row another process changed while this one was running: only its own row is replaced or appended', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mtb-rows-'));
    try {
      recordRows(dir, [base('a', { outcome: 'time-limit', correct: false }), base('b')]);
      // another process re-parses row a while a run is in flight; the run then records its own row
      recordRows(dir, [base('a', { outcome: 'completed', correct: true })]);
      const rows = recordRows(dir, [base('c')]);
      expect(rows.map((r) => [r.id, r.outcome, r.correct])).toEqual([['b', 'completed', true], ['a', 'completed', true], ['c', 'completed', true]]);
      expect(readRows(dir)).toEqual(rows);
      expect(readFileSync(path.join(dir, 'results.md'), 'utf8')).toContain('## Scenario W');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
