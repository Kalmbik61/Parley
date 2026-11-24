#!/usr/bin/env -S pnpm exec tsx
/**
 * Measurement harness "Fewer mail turns" (plan docs/plans/2026-11-11-fewer-mail-turns-plan.md, T3).
 *
 * One real session per run (Claude or Codex) in an isolated PARLEY_HOME and a throwaway git project; its counterpart is
 * the harness itself: it sends direct letters from the human through the host's own `rooms.send` on a fixed timeline
 * (no second model). Scenario W: the session waits for mail and answers numbers with number + 1. Scenario P: the session
 * ends its turn, and a letter with a number arrives later, twice. From the provider's own log (Claude transcript JSONL,
 * Codex rollout) the harness counts model responses, tool calls by name, results "moved to the background", check_inbox
 * calls and tokens, and judges whether the final answers are right. A run is stopped at 40 responses or 15 minutes.
 *
 * Run: `pnpm exec tsx tools/mail-turns-bench.ts --repo <checkout> --arm baseline --provider claude --model sonnet
 * --effort medium --scenario both --runs 3 --trust-copies`, help — `--help`. The session costs real model calls:
 * launch it only when the human has allowed the paid runs.
 *
 * Pure parts (timeline, stop limits, log parsing, judging, tables) are exported and covered by
 * `mail-turns-bench.test.ts` without live processes. The live part reuses `parley-token-benchmark-drive.ts`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildHostEnv,
  classifyScreen,
  findCodexRollout,
  findTranscript,
  HostClient,
  hostAlive,
  parseJournal,
  providerProblem,
  sessionModel,
  stopCount,
  type HookRow,
} from './parley-token-benchmark-drive.js';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(toolsDir, '..');
const DEFAULT_OUT = path.join(benchRoot, 'docs/research/2026-11-11-mail-turns');

// ---------- Scenarios ----------

export type ScenarioId = 'W' | 'P';

/**
 * One letter of the counterpart. `previous`: `delayMs` after the previous letter (the prompt for the first one).
 * `turn-end`: `delayMs` after the first turn end that follows the previous letter (the prompt for the first one).
 */
export interface Step {
  anchor: 'previous' | 'turn-end';
  delayMs: number;
  text: string;
}

export interface Scenario {
  id: ScenarioId;
  prompt: string;
  steps: Step[];
  /** Numbers the session must answer with, in order (the letter number plus one). */
  expectedAnswers: string[];
}

const SEC = 1000;

const W_PROMPT =
  'This is a scripted measurement. Your counterpart is the human. First send the human one message with the text "ready" ' +
  '(send_message). Then wait for mail. For every message with a number N, send the human a message whose text is N+1 as ' +
  'digits only, then wait for mail again. When a message says STOP, call report with status done and end your turn. ' +
  'Do nothing else: no files, no commands.';
const P_PROMPT =
  'This is a scripted measurement. Call report with status done and a one-line summary, then end your turn. ' +
  'If a message with a number N arrives later, send the human a message whose text is N+1 as digits only, then end your turn. ' +
  'Do nothing else: no files, no commands.';

/** Scenario timelines exactly as in the plan (section 4, T3), delays multiplied by `timeScale` (1 for paid runs). */
export function buildScenario(id: ScenarioId, timeScale = 1): Scenario {
  const ms = (seconds: number): number => Math.round(seconds * SEC * timeScale);
  if (id === 'W') {
    return {
      id,
      prompt: W_PROMPT,
      steps: [
        { anchor: 'previous', delayMs: ms(20), text: 'Number: 41' },
        { anchor: 'previous', delayMs: ms(150), text: 'Number: 57' },
        { anchor: 'previous', delayMs: ms(150), text: 'Number: 73' },
        { anchor: 'previous', delayMs: ms(20), text: 'STOP' },
      ],
      expectedAnswers: ['42', '58', '74'],
    };
  }
  return {
    id,
    prompt: P_PROMPT,
    steps: [
      { anchor: 'turn-end', delayMs: ms(30), text: 'Number: 118' },
      { anchor: 'turn-end', delayMs: ms(30), text: 'Number: 236' },
    ],
    expectedAnswers: ['119', '237'],
  };
}

/** What the harness observed so far; all times are harness clock milliseconds. */
export interface TimelineState {
  promptAt: number;
  sentAt: number[];
  /** Moments at which a new turn end was seen after the prompt, in order. */
  stopTimes: number[];
}

export type TimelineAction = { kind: 'send'; index: number } | { kind: 'wait' } | { kind: 'done' };

/**
 * The next thing the harness does. After the last letter the scenario is done at the first turn end that follows it:
 * the session has answered and stopped.
 */
export function nextAction(scenario: Scenario, state: TimelineState, now: number): TimelineAction {
  const index = state.sentAt.length;
  if (index >= scenario.steps.length) {
    const last = state.sentAt[index - 1] as number;
    return state.stopTimes.some((time) => time >= last) ? { kind: 'done' } : { kind: 'wait' };
  }
  const step = scenario.steps[index] as Step;
  const previous = index === 0 ? state.promptAt : (state.sentAt[index - 1] as number);
  let base = previous;
  if (step.anchor === 'turn-end') {
    const stop = state.stopTimes.find((time) => time >= previous);
    if (stop === undefined) return { kind: 'wait' };
    base = stop;
  }
  return now >= base + step.delayMs ? { kind: 'send', index } : { kind: 'wait' };
}

// ---------- Stop limits ----------

export const MAX_RESPONSES = 40;
export const MAX_RUN_MS = 15 * 60 * SEC;

export type StopReason = 'response-limit' | 'time-limit';

/** A run is stopped at 40 responses or 15 minutes, whichever comes first. */
export function stopReason(
  progress: { responses: number; elapsedMs: number },
  limits: { maxResponses: number; maxMs: number } = { maxResponses: MAX_RESPONSES, maxMs: MAX_RUN_MS },
): StopReason | null {
  if (progress.responses >= limits.maxResponses) return 'response-limit';
  if (progress.elapsedMs >= limits.maxMs) return 'time-limit';
  return null;
}

// ---------- Provider logs ----------

export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface LogMetrics {
  responses: number;
  /** Tool calls by the name the provider logged. */
  toolCalls: Record<string, number>;
  checkInboxCalls: number;
  /** Tool results that say the call was moved to the background. */
  backgroundedResults: number;
  tokens: Tokens;
  /** Texts of the session's send_message calls, in order. */
  sentTexts: string[];
  /** The session called report. */
  reported: boolean;
  /** Codex: `wait` polls whose result says the cell is still running; each poll is a model response. */
  waitPolls: number;
  /** Codex: scripts (`exec`) that yielded a running cell instead of finishing. */
  yieldedCells: number;
  /** Codex: `task_complete` records, one per finished turn. */
  turnsCompleted: number;
  /** Codex: milliseconds of the first `task_started` and the last `task_complete`; null without them. */
  firstStartMs: number | null;
  lastCompleteMs: number | null;
}

const emptyTokens = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

const BACKGROUNDED = /moved to the background/i;

type Rec = Record<string, unknown>;
const asRec = (value: unknown): Rec | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null);
const asNum = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function jsonLines(text: string): Rec[] {
  const rows: Rec[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = asRec(JSON.parse(line));
      if (row !== null) rows.push(row);
    } catch {
      // a half-written last line: read it at the next poll
    }
  }
  return rows;
}

/** `mcp__parley__wait_for` → `wait_for`; Codex spellings with `.`, `:` or `/` too. */
export function baseToolName(name: string): string {
  return name.split(/__|[.:/]/).pop() ?? name;
}

/** Text of a tool result: a string, or a list of `{ text }` parts, or `{ content }`. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(resultText).join('\n');
  const rec = asRec(value);
  if (rec === null) return '';
  if (typeof rec['text'] === 'string') return rec['text'];
  if ('content' in rec) return resultText(rec['content']);
  if ('output' in rec) return resultText(rec['output']);
  return '';
}

function callText(input: unknown): string | null {
  let rec = asRec(input);
  if (typeof input === 'string') {
    try {
      rec = asRec(JSON.parse(input));
    } catch {
      return null;
    }
  }
  return typeof rec?.['text'] === 'string' ? rec['text'] : null;
}

class Tally {
  readonly toolCalls: Record<string, number> = {};
  readonly sentTexts: string[] = [];
  checkInboxCalls = 0;
  backgroundedResults = 0;
  reported = false;
  private readonly seenCalls = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly backgrounded = new Set<string>();

  call(id: string, name: string, input: unknown): void {
    if (this.seenCalls.has(id)) return;
    this.seenCalls.add(id);
    this.names.set(id, name);
    this.toolCalls[name] = (this.toolCalls[name] ?? 0) + 1;
    const base = baseToolName(name);
    if (base === 'check_inbox') this.checkInboxCalls += 1;
    if (base === 'report') this.reported = true;
    if (base === 'send_message') {
      const text = callText(input);
      if (text !== null) this.sentTexts.push(text);
    }
  }

  /**
   * Codex 0.166 calls every Parley tool inside its `exec` tool: the call item is `exec` and the script holds the calls
   * (`await tools.mcp__parley__wait_for({...})`, possibly several). Each one is counted under its own name; `exec` and
   * `wait` stay counters of their own.
   */
  script(id: string, script: string): void {
    let n = 0;
    for (const match of script.matchAll(/tools\.(mcp__parley__\w+)\s*\(/g)) {
      const after = script.slice((match.index ?? 0) + match[0].length);
      const literal = /^\s*\{[^}]*?\btext\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/.exec(after)?.[1];
      let text: string | undefined;
      if (literal !== undefined) {
        try {
          text = literal.startsWith('"') ? (JSON.parse(literal) as string) : literal.slice(1, -1);
        } catch {
          text = literal.slice(1, -1);
        }
      }
      this.call(`${id}#${n++}`, match[1] as string, text === undefined ? {} : { text });
    }
  }

  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }

  result(id: string, text: string): void {
    if (!BACKGROUNDED.test(text) || this.backgrounded.has(id)) return;
    this.backgrounded.add(id);
    this.backgroundedResults += 1;
  }
}

/**
 * Claude Code transcript: a response is one distinct assistant message id (a message is logged once per content block,
 * with the same usage, so the largest value per id counts); `<synthetic>` messages are not model responses.
 */
export function parseClaudeTranscript(text: string): LogMetrics {
  const tally = new Tally();
  const usage = new Map<string, Tokens>();
  for (const row of jsonLines(text)) {
    const message = asRec(row['message']);
    if (message === null) continue;
    if (row['type'] === 'assistant') {
      const id = message['id'];
      if (typeof id !== 'string' || message['model'] === '<synthetic>') continue;
      const u = asRec(message['usage']);
      const now = usage.get(id) ?? emptyTokens();
      if (u !== null) {
        now.input = Math.max(now.input, asNum(u['input_tokens']));
        now.cacheRead = Math.max(now.cacheRead, asNum(u['cache_read_input_tokens']));
        now.cacheWrite = Math.max(now.cacheWrite, asNum(u['cache_creation_input_tokens']));
        now.output = Math.max(now.output, asNum(u['output_tokens']));
      }
      usage.set(id, now);
      for (const block of Array.isArray(message['content']) ? message['content'] : []) {
        const item = asRec(block);
        if (item?.['type'] === 'tool_use' && typeof item['id'] === 'string' && typeof item['name'] === 'string') {
          tally.call(item['id'], item['name'], item['input']);
        }
      }
    } else if (row['type'] === 'user' && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        const item = asRec(block);
        if (item?.['type'] === 'tool_result' && typeof item['tool_use_id'] === 'string') tally.result(item['tool_use_id'], resultText(item['content']));
      }
    }
  }
  const tokens = emptyTokens();
  for (const one of usage.values()) {
    tokens.input += one.input;
    tokens.cacheRead += one.cacheRead;
    tokens.cacheWrite += one.cacheWrite;
    tokens.output += one.output;
  }
  return { responses: usage.size, ...tallyFields(tally), tokens, waitPolls: 0, yieldedCells: 0, turnsCompleted: 0, firstStartMs: null, lastCompleteMs: null };
}

function tallyFields(tally: Tally): Pick<LogMetrics, 'toolCalls' | 'checkInboxCalls' | 'backgroundedResults' | 'sentTexts' | 'reported'> {
  return {
    toolCalls: tally.toolCalls,
    checkInboxCalls: tally.checkInboxCalls,
    backgroundedResults: tally.backgroundedResults,
    sentTexts: tally.sentTexts,
    reported: tally.reported,
  };
}

/**
 * Codex rollout: a response is one `token_count` record whose cumulative `total_token_usage` moved (Codex repeats a
 * record with the same totals). `last_token_usage` is that one request; `input_tokens` already contains the cached
 * part, so the fresh input is the difference. Codex logs no cache writes: they stay 0.
 */
export function parseCodexRollout(text: string): LogMetrics {
  const tally = new Tally();
  const tokens = emptyTokens();
  let responses = 0;
  let lastTotal: number | null = null;
  let [waitPolls, yieldedCells, turnsCompleted] = [0, 0, 0];
  let firstStartMs: number | null = null;
  let lastCompleteMs: number | null = null;
  for (const row of jsonLines(text)) {
    const payload = asRec(row['payload']);
    if (payload === null) continue;
    const kind = payload['type'];
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : Number.NaN;
    if (row['type'] === 'event_msg' && kind === 'token_count') {
      const info = asRec(payload['info']);
      const total = asNum(asRec(info?.['total_token_usage'])?.['total_tokens']);
      const last = asRec(info?.['last_token_usage']);
      if (last === null || total === lastTotal) continue;
      lastTotal = total;
      responses += 1;
      const cached = asNum(last['cached_input_tokens']);
      const written = asNum(last['cache_write_input_tokens']);
      // `input_tokens` contains the cached part; the cache write is assumed to be inside it too (it was 0 in every pilot record).
      tokens.input += Math.max(asNum(last['input_tokens']) - cached - written, 0);
      tokens.cacheRead += cached;
      tokens.cacheWrite += written;
      tokens.output += asNum(last['output_tokens']);
    } else if (row['type'] === 'event_msg' && kind === 'task_started') {
      if (firstStartMs === null && !Number.isNaN(at)) firstStartMs = at;
    } else if (row['type'] === 'event_msg' && kind === 'task_complete') {
      turnsCompleted += 1;
      if (!Number.isNaN(at)) lastCompleteMs = at;
    } else if (row['type'] === 'response_item') {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : null;
      if ((kind === 'function_call' || kind === 'custom_tool_call') && callId !== null && typeof payload['name'] === 'string') {
        const input = kind === 'function_call' ? payload['arguments'] : payload['input'];
        tally.call(callId, payload['name'], input);
        if (payload['name'] === 'exec' && typeof input === 'string') tally.script(callId, input);
      } else if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && callId !== null) {
        const output = resultText(payload['output']);
        tally.result(callId, output);
        if (output.startsWith('Script running with cell ID')) {
          if (tally.nameOf(callId) === 'wait') waitPolls += 1;
          else yieldedCells += 1;
        }
      }
    }
  }
  return { responses, ...tallyFields(tally), tokens, waitPolls, yieldedCells, turnsCompleted, firstStartMs, lastCompleteMs };
}

/** Which of the two parsers fits the provider. */
export const parseLog = (provider: string, text: string): LogMetrics => (provider === 'codex' ? parseCodexRollout(text) : parseClaudeTranscript(text));

// ---------- Judging ----------

/**
 * Are the scenario's final answers right: the expected numbers appear, in order, as the texts of send_message calls
 * (a number counts as a whole token, so "58" is not found in "158"); W also needs `ready` first; the session called report.
 */
export function judgeAnswers(scenario: Scenario, metrics: Pick<LogMetrics, 'sentTexts' | 'reported'>): { correct: boolean; problems: string[] } {
  const problems: string[] = [];
  const wanted = scenario.id === 'W' ? ['ready', ...scenario.expectedAnswers] : scenario.expectedAnswers;
  let at = 0;
  for (const want of wanted) {
    const pattern = want === 'ready' ? /ready/i : new RegExp(`(?<!\\d)${want}(?!\\d)`);
    const found = metrics.sentTexts.findIndex((text, i) => i >= at && pattern.test(text));
    if (found === -1) problems.push(`no message with ${want === 'ready' ? '"ready"' : want} (in order)`);
    else at = found + 1;
  }
  if (!metrics.reported) problems.push('report was not called');
  return { correct: problems.length === 0, problems };
}

// ---------- Rows and tables ----------

/** Plan weights of the evidence section: input 1, cache read 0.1, cache write 1.25, output 5. Not provider billing. */
export const weightedCost = (t: Tokens): number => t.input + 0.1 * t.cacheRead + 1.25 * t.cacheWrite + 5 * t.output;

export interface RunRow {
  id: string;
  arm: string;
  provider: string;
  model: string;
  effort: string;
  scenario: ScenarioId;
  run: number;
  /** `completed`, a stop reason, or why the run did not start or got stuck; a non-completed run is still a row. */
  outcome: string;
  correct: boolean | null;
  problems: string[];
  responses: number | null;
  toolCalls: Record<string, number>;
  checkInboxCalls: number | null;
  backgroundedResults: number | null;
  /** Codex only: `wait` polls of a running cell, and scripts that yielded a running cell. */
  waitPolls?: number | null;
  yieldedCells?: number | null;
  tokens: Tokens | null;
  weightedCost: number | null;
  wallSeconds: number | null;
  lettersSentAtSeconds: number[];
  providerSessionId: string | null;
  log: string | null;
  /** Project MCP servers the host listed in its question; all were disabled for the run. */
  mcpServersListed: string[];
  /** Last screen text of a start that failed (`screen.txt` in the run directory); null otherwise. */
  screen: string | null;
  /** Codex "Hooks need review" screen: `skipped` when the harness pressed Esc on it. */
  hooksReview?: 'skipped' | null;
  /** What the harness answered to the host's consent cards. */
  consentAnswers: string[];
  repo: string;
  startedAt: string;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const fmt = (value: number | null): string => (value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(1));

const COLUMNS: { title: string; value: (row: RunRow) => number | null }[] = [
  { title: 'responses', value: (r) => r.responses },
  { title: 'wait_for', value: (r) => (r.responses === null ? null : countBase(r, 'wait_for')) },
  { title: 'check_inbox', value: (r) => r.checkInboxCalls },
  { title: 'backgrounded', value: (r) => r.backgroundedResults },
  { title: 'wait polls (Codex)', value: (r) => r.waitPolls ?? null },
  { title: 'yielded cells (Codex)', value: (r) => r.yieldedCells ?? null },
  { title: 'input', value: (r) => r.tokens?.input ?? null },
  { title: 'cache read', value: (r) => r.tokens?.cacheRead ?? null },
  { title: 'cache write', value: (r) => r.tokens?.cacheWrite ?? null },
  { title: 'output', value: (r) => r.tokens?.output ?? null },
  { title: 'weighted', value: (r) => (r.weightedCost === null ? null : Math.round(r.weightedCost)) },
  { title: 'wall s', value: (r) => r.wallSeconds },
];

function countBase(row: RunRow, base: string): number {
  return Object.entries(row.toolCalls).reduce((sum, [name, n]) => sum + (baseToolName(name) === base ? n : 0), 0);
}

/**
 * One table per scenario and arm: a median and every value per column, then each run (a failed or stopped run is
 * listed, not dropped; the median is over runs that produced a log). No saving is derived from fewer than 3 runs.
 */
export function renderMarkdown(rows: readonly RunRow[]): string {
  const out: string[] = ['# Fewer mail turns: measurement results', '', 'Weighted = input + 0.1 cache read + 1.25 cache write + 5 output (plan weights, not provider billing).', ''];
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = `${row.scenario}\u0000${row.arm}\u0000${row.provider} ${row.model} ${row.effort}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const key of [...groups.keys()].sort()) {
    const group = (groups.get(key) as RunRow[]).sort((a, b) => a.run - b.run);
    const [scenario, arm, conditions] = key.split('\u0000') as [string, string, string];
    const measured = group.filter((row) => row.responses !== null);
    out.push(`## Scenario ${scenario}, arm ${arm} (${conditions})`, '');
    out.push(`Runs: ${group.length}, with a log: ${measured.length}, correct: ${group.filter((r) => r.correct === true).length}.${group.length < 3 ? ' Fewer than 3 runs: no comparison between arms is derived.' : ''}`, '');
    out.push('| metric | median | values |', '|---|---:|---|');
    for (const column of COLUMNS) {
      const values = measured.map(column.value).filter((v): v is number => v !== null);
      out.push(`| ${column.title} | ${fmt(median(values))} | ${values.map((v) => fmt(v)).join(', ') || 'n/a'} |`);
    }
    out.push('', '| run | outcome | correct | responses | wall s | problems |', '|---:|---|---|---:|---:|---|');
    for (const row of group) {
      out.push(`| ${row.run} | ${row.outcome} | ${row.correct === null ? 'n/a' : String(row.correct)} | ${fmt(row.responses)} | ${fmt(row.wallSeconds)} | ${row.problems.join('; ') || '-'} |`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

/** Rows already in the results file stay; a row with the same id is replaced by the new one. */
export function mergeRows(old: readonly RunRow[], added: readonly RunRow[]): RunRow[] {
  const ids = new Set(added.map((row) => row.id));
  return [...old.filter((row) => !ids.has(row.id)), ...added];
}

// ---------- Why there is no PTY ----------

/** What the harness knows when a created session has no live PTY: the map record, the machine queue and the host's notices. */
export interface NoPtyEvidence {
  session: { lifecycle?: string; queued?: unknown; provider?: string } | null;
  capacity: { machine?: unknown; queue?: unknown[] } | null;
  notices: string[];
  waitedMs: number;
}

/** One line for the row: the session's state and the host's reasons, as the host reported them. */
export function describeNoPty(evidence: NoPtyEvidence): string {
  const { session, capacity, notices } = evidence;
  const parts = [`no live PTY after ${Math.round(evidence.waitedMs / SEC)} s`];
  parts.push(session === null ? 'session is not in the map' : `session lifecycle=${session.lifecycle ?? 'n/a'} provider=${session.provider ?? 'n/a'} queued=${JSON.stringify(session.queued ?? null)}`);
  if (capacity !== null) parts.push(`machine=${JSON.stringify(capacity.machine ?? null)} queue=${capacity.queue?.length ?? 0}`);
  parts.push(notices.length === 0 ? 'no host notices' : `host notices: ${notices.join(' | ')}`);
  return parts.join('; ');
}

// ---------- Claude trust screen ----------

/**
 * What to press on the trust screen of the throwaway copy. Enter only with the cursor on "Yes, I trust this folder";
 * with the cursor on "No, exit" (Claude Code 2.1.322 starts there) one Down arrow, at most twice; anything else stops.
 */
export function trustKey(screen: { ours: boolean; selected: 'yes' | 'no' | 'other' | null }, downs: number): 'enter' | 'down' | 'stop' {
  if (!screen.ours) return 'stop';
  if (screen.selected === 'yes') return 'enter';
  if (screen.selected === 'no' && downs < 2) return 'down';
  return 'stop';
}

// ---------- Screens ----------

const squashed = (text: string): string => text.replace(/\s+/g, '');

/** Codex "Hooks need review" screen: Esc skips it (grants no trust to any hook); Enter would pick "Review hooks". */
export const isHooksReview = (text: string): boolean => /Hooksneedreview/i.test(squashed(text)) && /escskip/i.test(squashed(text));

/** Screen text for `screen.txt`: no carriage returns, no trailing blanks, no trailing empty lines. */
export const cleanScreen = (text: string): string => `${text.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;

// ---------- Consent cards ----------

/** The part of a consent card the harness reads (`consents.list`). */
export interface CardInfo {
  id: string;
  kind: string;
  state: string;
  revision?: number;
  folder?: string;
  servers?: { name: string; command?: string }[];
}

export interface CardAnswer {
  decide: { id: string; decision: 'allow' | 'deny'; revision?: number };
  /** One line for the row. */
  note: string;
  /** Project MCP servers the card listed. */
  servers: string[];
}

/**
 * Answers for pending cards that hold the launch of the session under test. Project MCP: `deny`, which disables every
 * listed server (the measurement needs only Parley's own server). Folder trust (Codex): `allow` only for a folder under
 * `workRoot` and only with `trustCopies`, the same permission as the trust prompt of the throwaway copy. Any other card
 * is left alone.
 */
export function answerCards(cards: readonly CardInfo[], ctx: { workRoot: string; trustCopies: boolean }): CardAnswer[] {
  const answers: CardAnswer[] = [];
  for (const card of cards) {
    if (card.state !== 'pending') continue;
    if (card.kind === 'project-mcp') {
      const servers = (card.servers ?? []).map((server) => (server.command === undefined ? server.name : `${server.name} (${server.command})`));
      answers.push({
        decide: { id: card.id, decision: 'deny', ...(card.revision === undefined ? {} : { revision: card.revision }) },
        note: `project MCP card ${card.id}: all disabled (${servers.length} listed)`,
        servers,
      });
    } else if (card.kind === 'folder-trust' && ctx.trustCopies && card.folder !== undefined && card.folder.startsWith(`${ctx.workRoot}${path.sep}`)) {
      answers.push({ decide: { id: card.id, decision: 'allow' }, note: `folder trust card ${card.id}: allowed for the throwaway copy`, servers: [] });
    }
  }
  return answers;
}

// ---------- Results file ----------

/** All rows of `<dir>/results.json`; none when the file does not exist yet. */
export function readRows(dir: string): RunRow[] {
  const file = path.join(dir, 'results.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { rows: RunRow[] }).rows : [];
}

/**
 * Put rows into `<dir>/results.json` and regenerate `results.md`. The file is read again at every write and only the
 * rows with the given ids are replaced or appended: a run that was in flight while another process re-parsed or added a
 * row cannot write an older in-memory copy over it. Returns the rows now on disk.
 */
export function recordRows(dir: string, added: readonly RunRow[]): RunRow[] {
  mkdirSync(dir, { recursive: true });
  const rows = mergeRows(readRows(dir), added);
  writeFileSync(path.join(dir, 'results.json'), `${JSON.stringify({ rows }, null, 2)}\n`);
  writeFileSync(path.join(dir, 'results.md'), renderMarkdown(rows));
  return rows;
}

// ---------- Live run ----------

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

export interface BenchOptions {
  repo: string;
  arm: string;
  provider: 'claude' | 'codex';
  model: string;
  effort: 'low' | 'medium' | 'high';
  scenarios: ScenarioId[];
  runs: number;
  out: string;
  trustCopies: boolean;
  claudeBin: string | null;
  hostEnv: string[];
  claudeProjects: string;
  codexSessions: string;
  timeScale: number;
  limits: { maxResponses: number; maxMs: number };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 1000;
const LOG_POLL_MS = 5000;
/** `sessions.create` may return before the process is up (a queued or held launch, provider checks): wait, bounded. */
const PTY_WAIT_MS = 90_000;

/** A tiny git project in `dir`: the session never has to touch it, but Parley wants a git working copy. */
function makeProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# Throwaway project\n\nUsed only to measure mail turns.\n');
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-q', '-m', 'init');
}

/** The socket limit is checked against the host's own path layout (`MAX_SOCKET_PATH_BYTES`). */
async function hostLayout(home: string): Promise<{ socket: string; token: string; log: string }> {
  const { hostPaths, MAX_SOCKET_PATH_BYTES } = await import('../packages/host/src/paths.js');
  const paths = hostPaths(home);
  const bytes = Buffer.byteLength(paths.socket, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) throw new Error(`${paths.socket}: socket path is ${bytes} bytes, the limit is ${MAX_SOCKET_PATH_BYTES}`);
  return { socket: paths.socket, token: paths.token, log: paths.log };
}

/** True once the session has a live PTY (`pty.attach` answers); false after `timeoutMs` of `not_found` or once its process has exited. */
async function waitForPty(client: HostClient, ref: Ref, timeoutMs: number, exited: () => boolean, tick: () => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.screen(ref);
      return true;
    } catch (error) {
      if (!String(error).includes('not_found')) throw error;
    }
    // The process started and ended already (a `pty.exit` event): waiting longer changes nothing.
    if (exited() || Date.now() > deadline) return false;
    await tick();
    await sleep(500);
  }
}

/**
 * Start dialogs (trust, project MCP, Codex update) answered as in the token benchmark driver, then the prompt is typed
 * in. Returns the moment of sending, or the outcome that stopped the start.
 */
async function startAndSend(
  client: HostClient,
  ref: Ref,
  ctx: { copy: string; workRoot: string; prompt: string; trustCopies: boolean; provider: 'claude' | 'codex' },
): Promise<{ sentAt: number; hooksReview: 'skipped' | null } | { outcome: string; screen: string }> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let trusted = false;
  let rejects = 0;
  let skips = 0;
  let afterTrust = 0;
  let downs = 0;
  let hooksSkips = 0;
  let last = '';
  const stop = (outcome: string): { outcome: string; screen: string } => ({ outcome, screen: last });
  for (;;) {
    if (Date.now() > deadline) return stop('start-timeout');
    await sleep(2000);
    const text = await client.screen(ref);
    last = text;
    if (ctx.provider === 'codex' && isHooksReview(text)) {
      // Esc once: it skips the review and trusts no hook. The same screen after two more polls: stop, the screen is saved.
      if (hooksSkips === 0) client.notify('pty.input', { ref, data: '\x1b' });
      if (++hooksSkips > 3) return stop('hooks-review-stuck');
      continue;
    }
    const screen = classifyScreen(text, ctx.copy, ctx.workRoot, ctx.provider);
    if (screen.kind === 'trust') {
      if (trusted) {
        if (++afterTrust <= 5) continue;
        return stop('trust-unexpected');
      }
      if (!ctx.trustCopies) return stop('trust-not-allowed');
      const key = trustKey(screen, downs);
      if (key === 'enter') {
        client.notify('pty.input', { ref, data: '\r' });
        trusted = true;
        continue;
      }
      if (key === 'down') {
        client.notify('pty.input', { ref, data: '\x1b[B' });
        downs += 1;
        continue;
      }
      return stop('trust-unexpected');
    }
    if (screen.kind === 'mcp') {
      if (rejects++ >= 2) return stop('mcp-prompt-stuck');
      client.notify('pty.input', { ref, data: '\x1b' });
      continue;
    }
    if (screen.kind === 'update') {
      if (skips++ >= 2) return stop('update-prompt-stuck');
      client.notify('pty.input', { ref, data: '\x1b' });
      continue;
    }
    if (screen.kind === 'channel') return stop('channel-dialog');
    const sent = await client.call<{ inserted: boolean; submitted: boolean; reason: string | null }>('pty.send', { ref, text: ctx.prompt, submit: true });
    if (sent.submitted) return { sentAt: Date.now(), hooksReview: hooksSkips > 0 ? 'skipped' : null };
    if (sent.inserted) return stop(`send-${sent.reason ?? 'unknown'}`);
  }
}

async function stopHost(client: HostClient, child: ChildProcess, exited: Promise<void>): Promise<void> {
  await client.call('host.shutdown', {}).catch(() => undefined);
  client.close();
  const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!gone) {
    child.kill('SIGTERM');
    await exited;
  }
}

/** Numbers and verdict of a row from the parsed provider log. */
export function applyMetrics(row: RunRow, scenario: Scenario, metrics: LogMetrics): void {
  const judged = judgeAnswers(scenario, metrics);
  Object.assign(row, {
    responses: metrics.responses, toolCalls: metrics.toolCalls, checkInboxCalls: metrics.checkInboxCalls,
    backgroundedResults: metrics.backgroundedResults, waitPolls: metrics.waitPolls, yieldedCells: metrics.yieldedCells,
    tokens: metrics.tokens, weightedCost: weightedCost(metrics.tokens), correct: judged.correct, problems: judged.problems,
  });
}

/**
 * Recompute a row from its saved provider log (after a parser fix, no new run). A Codex row stopped only because the
 * harness missed the turn end (the rollout has `task_complete` after the last answer) becomes `completed`, with the
 * wall time from the rollout; the original outcome is kept in `problems`.
 */
export function reparseRow(row: RunRow, logText: string): RunRow {
  const scenario = buildScenario(row.scenario);
  const metrics = parseLog(row.provider, logText);
  const next: RunRow = { ...row, problems: [], toolCalls: {} };
  applyMetrics(next, scenario, metrics);
  if (row.provider === 'codex' && metrics.turnsCompleted > 0 && metrics.firstStartMs !== null && metrics.lastCompleteMs !== null && (row.outcome === 'time-limit' || row.outcome === 'response-limit')) {
    next.outcome = 'completed';
    next.wallSeconds = Math.round((metrics.lastCompleteMs - metrics.firstStartMs) / SEC);
    next.problems = [`re-parsed from the saved rollout: the harness missed the turn end and recorded ${row.outcome} after ${row.wallSeconds} s; wall time is first task_started to last task_complete`, ...next.problems];
  } else {
    next.problems = [`re-parsed from the saved log`, ...next.problems];
  }
  return next;
}

const rowOf = (options: BenchOptions, scenario: ScenarioId, run: number, startedAt: Date): RunRow => ({
  id: `${options.arm}-${options.provider}-${scenario}-${run}-${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`,
  arm: options.arm,
  provider: options.provider,
  model: options.model,
  effort: options.effort,
  scenario,
  run,
  outcome: 'not-started',
  correct: null,
  problems: [],
  responses: null,
  toolCalls: {},
  checkInboxCalls: null,
  backgroundedResults: null,
  tokens: null,
  weightedCost: null,
  wallSeconds: null,
  lettersSentAtSeconds: [],
  providerSessionId: null,
  log: null,
  mcpServersListed: [],
  screen: null,
  consentAnswers: [],
  repo: options.repo,
  startedAt: startedAt.toISOString(),
});

/** One run: a fresh isolated host and home, one session, the scenario timeline, the log read at the end. */
export async function runOne(options: BenchOptions, scenarioId: ScenarioId, run: number): Promise<RunRow> {
  const startedAt = new Date();
  const row = rowOf(options, scenarioId, run, startedAt);
  const scenario = buildScenario(scenarioId, options.timeScale);
  const hostMain = path.join(options.repo, 'packages/host/dist/main.js');
  if (!existsSync(hostMain)) throw new Error(`${hostMain}: host is not built (pnpm --filter @parley/host build in that checkout)`);

  const runDir = path.join(options.out, 'runs', row.id);
  // The copy lives outside this repository and outside the user's home: no CLAUDE.md or AGENTS.md of a checkout and no
  // `.mcp.json` of a parent folder is picked up from above it, and both arms see the same folder.
  // Real path: on macOS /tmp is a link to /private/tmp, and the trust screen of Claude shows the real one.
  const workRoot = realpathSync(mkdtempSync('/tmp/mtb-work-'));
  const copy = path.join(workRoot, 'project');
  const home = mkdtempSync('/tmp/mtb-');
  makeProject(copy);
  mkdirSync(runDir, { recursive: true });
  const layout = await hostLayout(home);
  if (await hostAlive(layout.socket)) throw new Error(`${layout.socket}: a live host is already on this socket`);

  let binDir: string | null = null;
  if (options.claudeBin !== null) {
    binDir = mkdtempSync(path.join(tmpdir(), 'mail-turns-bin-'));
    symlinkSync(path.resolve(options.claudeBin), path.join(binDir, 'claude'));
  }
  const env = buildHostEnv({ base: process.env, home, runEnv: options.hostEnv, tmpDir: tmpdir(), claudeBinDir: binDir });
  const fd = openSync(path.join(runDir, 'host.log'), 'w');
  const child = spawn(process.execPath, [hostMain], { cwd: options.repo, env, stdio: ['ignore', fd, fd], detached: true });
  child.unref();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const t0 = Date.now();
  const notices: string[] = [];
  const log = (...parts: unknown[]): void => {
    const line = parts.map(String).join(' ');
    if (line.startsWith('NOTICE ')) notices.push(line.slice('NOTICE '.length));
    if (line.startsWith('pty.exit ')) notices.push(line);
    console.log(`[${row.id} ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts);
  };

  let client: HostClient | null = null;
  try {
    client = await HostClient.connect(layout.socket, log);
    await client.call('hello', { token: readFileSync(layout.token, 'utf8').trim(), protocol: 1, client: 'mail-turns-bench' });
    if (options.provider !== 'claude') {
      const listed = await client.call<{ providers: { id: string; available?: boolean; needs?: 'cli' | 'key' | null }[] }>('providers.list', {});
      const problem = providerProblem(listed.providers, options.provider);
      if (problem !== null) throw new Error(problem);
    }
    const created = await client.call<{ ref: Ref }>('sessions.create', {
      projectPath: copy, workId: null, provider: options.provider, label: 'mail-turns', task: '', parent: null,
      model: sessionModel(options.provider, options.model), effort: options.effort,
    });
    const ref = created.ref;
    log(`created ${JSON.stringify(ref)}`);

    const journal = path.join(copy, '.parley', 'works', ref.workId, 'events', `${ref.sessionId}.jsonl`);
    const rows = (): HookRow[] => (existsSync(journal) ? parseJournal(readFileSync(journal, 'utf8')) : []);
    const waitStart = Date.now();
    // A launch held by a consent card has no PTY until the card is answered (project MCP servers, Codex folder trust).
    const answerHeld = async (): Promise<void> => {
      const listed = await client!.call<{ items: CardInfo[] }>('consents.list', {}).catch(() => null);
      for (const answer of answerCards(listed?.items ?? [], { workRoot, trustCopies: options.trustCopies })) {
        await client!.call('consents.decide', answer.decide);
        row.consentAnswers.push(answer.note);
        row.mcpServersListed.push(...answer.servers);
        log(answer.note);
      }
    };
    if (!(await waitForPty(client, ref, PTY_WAIT_MS, () => notices.some((n) => n.startsWith('pty.exit ')), answerHeld))) {
      const works = await client.call<{ entries: { projectPath: string; map: { work: { id: string }; sessions: { id: string }[] } }[] }>('works.list', {}).catch(() => null);
      const entry = works?.entries.find((e) => e.projectPath === ref.projectPath && e.map.work.id === ref.workId);
      const session = (entry?.map.sessions.find((x) => x.id === ref.sessionId) ?? null) as NoPtyEvidence['session'];
      const capacity = await client.call<NoPtyEvidence['capacity']>('capacity.get', {}).catch(() => null);
      row.outcome = 'no-pty';
      row.problems.push(describeNoPty({ session, capacity, notices, waitedMs: Date.now() - waitStart }));
      return row;
    }
    const started = await startAndSend(client, ref, { copy, workRoot, prompt: scenario.prompt, trustCopies: options.trustCopies, provider: options.provider });
    if (!('sentAt' in started)) {
      row.outcome = started.outcome;
      // The last screen of a start that did not end in a sent prompt, so nobody has to relay what the terminal showed.
      const screenFile = path.join(runDir, 'screen.txt');
      writeFileSync(screenFile, cleanScreen(started.screen));
      row.screen = screenFile;
      return row;
    }
    const promptAt = started.sentAt;
    row.hooksReview = started.hooksReview;
    log('prompt sent');
    // Claude: `Stop` rows of the hook journal. Codex: its hook journal did not show the turn end in the pilot, so the turn
    // ends are the `task_complete` records of the rollout (read every poll once the file is found).
    const codex = options.provider === 'codex';
    const baseStops = codex ? 0 : stopCount(rows());
    const state: TimelineState = { promptAt, sentAt: [], stopTimes: [] };
    let seenStops = baseStops;
    let providerSessionId: string | null = null;
    let logFile: string | null = null;
    let metrics: LogMetrics | null = null;
    let nextLogPoll = 0;
    let outcome = 'completed';

    for (;;) {
      await sleep(POLL_MS);
      const now = Date.now();
      const stops = codex ? (metrics?.turnsCompleted ?? 0) : stopCount(rows());
      if (stops > seenStops) {
        for (let i = seenStops; i < stops; i += 1) state.stopTimes.push(now);
        seenStops = stops;
      }
      const action = nextAction(scenario, state, now);
      if (action.kind === 'done') break;
      if (action.kind === 'send') {
        const step = scenario.steps[action.index] as Step;
        await client.call('rooms.send', { projectPath: copy, workId: ref.workId, roomId: null, to: [ref.sessionId], text: step.text, kind: 'note' });
        state.sentAt.push(now);
        row.lettersSentAtSeconds.push(Math.round((now - promptAt) / SEC));
        log(`letter ${action.index + 1}/${scenario.steps.length} sent: ${step.text}`);
        continue;
      }
      if (client.lastActivity === 'blocked') {
        outcome = 'blocked';
        break;
      }
      const locate = now >= nextLogPoll;
      if (locate) {
        nextLogPoll = now + LOG_POLL_MS;
        if (providerSessionId === null) providerSessionId = await sessionIdOf(client, ref);
        if (providerSessionId !== null && logFile === null) logFile = locateLog(options, providerSessionId);
      }
      // Codex turn ends come from the rollout, so it is read every poll; Claude's log only every few seconds.
      if (logFile !== null && (codex || locate)) metrics = parseLog(options.provider, readFileSync(logFile, 'utf8'));
      const reason = stopReason({ responses: metrics?.responses ?? 0, elapsedMs: now - promptAt }, options.limits);
      if (reason !== null) {
        outcome = reason;
        break;
      }
    }
    const endedAt = Date.now();
    log(`end: ${outcome}`);
    await sleep(3000);
    providerSessionId ??= await sessionIdOf(client, ref);
    if (providerSessionId !== null) logFile ??= locateLog(options, providerSessionId);
    row.outcome = outcome;
    row.providerSessionId = providerSessionId;
    row.wallSeconds = Math.round((endedAt - promptAt) / SEC);
    // The raw provider log stays next to the row, so the numbers can be recomputed.
    if (logFile !== null) {
      row.log = path.join(runDir, path.basename(logFile));
      copyFileSync(logFile, row.log);
    }
    if (logFile === null) {
      row.problems.push('no provider log found');
    } else {
      applyMetrics(row, scenario, parseLog(options.provider, readFileSync(logFile, 'utf8')));
    }
    await client.call('sessions.stop', { ref }).catch(() => undefined);
    return row;
  } catch (error) {
    row.outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
    return row;
  } finally {
    if (client !== null) await stopHost(client, child, exited).catch(() => undefined);
    else child.kill('SIGTERM');
    if (binDir !== null) rmSync(binDir, { recursive: true, force: true });
    // The host's own log (its reasons for queueing, holding or refusing a launch) lives in the home that is removed below.
    if (existsSync(layout.log)) copyFileSync(layout.log, path.join(runDir, 'host-own.log'));
    rmSync(home, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  }
}

async function sessionIdOf(client: HostClient, ref: Ref): Promise<string | null> {
  const works = await client.call<{ entries: { projectPath: string; map: { work: { id: string }; sessions: { id: string; providerSessionId?: string | null }[] } }[] }>('works.list', {});
  for (const entry of works.entries) {
    if (entry.projectPath !== ref.projectPath || entry.map.work.id !== ref.workId) continue;
    return entry.map.sessions.find((s) => s.id === ref.sessionId)?.providerSessionId ?? null;
  }
  return null;
}

function locateLog(options: BenchOptions, providerSessionId: string): string | null {
  return options.provider === 'codex' ? findCodexRollout(options.codexSessions, providerSessionId) : findTranscript(options.claudeProjects, providerSessionId);
}

// ---------- CLI ----------

const HELP = `mail-turns-bench — measurement harness "Fewer mail turns" (T3)

  pnpm exec tsx tools/mail-turns-bench.ts --repo CHECKOUT --arm NAME [--provider claude|codex] [--model M]
      [--effort low|medium|high] [--scenario W|P|both] [--runs N] [--out DIR] [--trust-copies]
      [--claude-bin PATH] [--host-env KEY=VALUE]... [--claude-projects DIR] [--codex-sessions DIR]
      [--time-scale K] [--max-responses N] [--max-minutes N]

  --repo CHECKOUT      checkout whose packages/host/dist/main.js runs (the bench worktree = baseline arm)
  --arm NAME           arm label in the results (baseline, treatment)
  --provider, --model, --effort   as sessions.create (claude: sonnet; codex: gpt-6.1-sol, medium)
  --scenario           W (waiting), P (pointer) or both (default)
  --runs N             runs per scenario (default 1)
  --out DIR            results.json and results.md go here, per-run files under runs/
                       (default docs/research/2026-11-11-mail-turns)
  --trust-copies       answer the folder trust prompt of the throwaway copy (only with the human's permission)
  --claude-bin PATH    put this binary first in the host's PATH as "claude" (a stub for a dry run)
  --host-env K=V       extra host environment entry (repeatable)
  --claude-projects, --codex-sessions   where the provider logs are looked up (default ~/.claude/projects, ~/.codex/sessions)
  --time-scale K       multiply the scenario delays (dry runs only; paid runs keep 1)
  --max-responses, --max-minutes   stop limits (default 40 and 15)
  --reparse ID         (repeatable) recompute that row of results.json from its saved provider log; no run

Every run starts a real model session unless --claude-bin points at a stub. Last stdout line: RESULTS <path>.
`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' }, arm: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
      scenario: { type: 'string' }, runs: { type: 'string' }, out: { type: 'string' }, 'trust-copies': { type: 'boolean' },
      'claude-bin': { type: 'string' }, 'host-env': { type: 'string', multiple: true }, 'claude-projects': { type: 'string' },
      'codex-sessions': { type: 'string' }, 'time-scale': { type: 'string' }, 'max-responses': { type: 'string' },
      'max-minutes': { type: 'string' }, reparse: { type: 'string', multiple: true }, help: { type: 'boolean' },
    },
  });
  if (values.reparse !== undefined) {
    const out = path.resolve(values.out ?? DEFAULT_OUT);
    for (const id of values.reparse) {
      const row = readRows(out).find((candidate) => candidate.id === id);
      if (row === undefined || row.log === null || !existsSync(row.log)) throw new Error(`${id}: no such row or no saved log`);
      recordRows(out, [reparseRow(row, readFileSync(row.log, 'utf8'))]);
    }
    return 0;
  }
  if (values.help === true || values.repo === undefined || values.arm === undefined) {
    console.log(HELP);
    return values.help === true ? 0 : 1;
  }
  const provider = values.provider ?? 'claude';
  if (provider !== 'claude' && provider !== 'codex') throw new Error('--provider: claude or codex');
  const effort = values.effort ?? 'medium';
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error('--effort: low, medium or high');
  const scenario = values.scenario ?? 'both';
  if (scenario !== 'W' && scenario !== 'P' && scenario !== 'both') throw new Error('--scenario: W, P or both');
  const number = (value: string | undefined, fallback: number, name: string): number => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!(parsed > 0)) throw new Error(`${name}: a positive number is expected`);
    return parsed;
  };
  const options: BenchOptions = {
    repo: path.resolve(values.repo),
    arm: values.arm,
    provider,
    model: values.model ?? (provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol'),
    effort,
    scenarios: scenario === 'both' ? ['W', 'P'] : [scenario],
    runs: number(values.runs, 1, '--runs'),
    out: path.resolve(values.out ?? DEFAULT_OUT),
    trustCopies: values['trust-copies'] === true,
    claudeBin: values['claude-bin'] ?? null,
    hostEnv: values['host-env'] ?? [],
    claudeProjects: path.resolve(values['claude-projects'] ?? path.join(homedir(), '.claude/projects')),
    codexSessions: path.resolve(values['codex-sessions'] ?? path.join(homedir(), '.codex/sessions')),
    timeScale: number(values['time-scale'], 1, '--time-scale'),
    limits: { maxResponses: number(values['max-responses'], MAX_RESPONSES, '--max-responses'), maxMs: number(values['max-minutes'], MAX_RUN_MS / 60_000, '--max-minutes') * 60_000 },
  };
  mkdirSync(options.out, { recursive: true });
  const resultsFile = path.join(options.out, 'results.json');
  let all: RunRow[] = readRows(options.out);
  for (const id of options.scenarios) {
    for (let run = 1; run <= options.runs; run += 1) {
      const row = await runOne(options, id, run);
      console.log(`RUN ${JSON.stringify({ id: row.id, outcome: row.outcome, correct: row.correct, responses: row.responses })}`);
      all = recordRows(options.out, [row]);
    }
  }
  console.log(`RESULTS ${resultsFile}`);
  return all.some((row) => row.outcome !== 'completed') ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
