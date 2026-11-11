import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qwenContextFill } from '../context-fill.js';
import { activityOf } from './activity.js';
import { eventRecordOf, openEvents, type EventRecord } from './events.js';

/** Hook mapping of spec 2026-11-11, 3.4, row by row, on Qwen journal records. */
const t = (second: number): string => `2026-11-11T13:20:${String(second).padStart(2, '0')}.000Z`;
const NOW = Date.parse(t(30));
const record = (second: number, body: Record<string, unknown>): EventRecord => eventRecordOf(body, t(second), 'qwen')!;
const ups = (second: number, prompt: string) => record(second, { hook_event_name: 'UserPromptSubmit', prompt });
const fold = (events: EventRecord[]) => activityOf({ events, now: NOW });

describe('qwen hook mapping (activityOf)', () => {
  it('UserPromptSubmit with a real prompt starts a turn; the empty follow-up is ignored', () => {
    expect(fold([ups(1, 'hello')]).activity).toBe('working');
    const ended = [ups(1, 'hello'), record(2, { hook_event_name: 'Stop' })];
    expect(fold(ended).activity).toBe('unseen');
    expect(fold([...ended, ups(3, '')]).activity).toBe('unseen');
  });

  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('%s is tool activity: working', (name) => {
    const events = [ups(1, 'go'), record(2, { hook_event_name: 'Stop' }), record(3, { hook_event_name: name, tool_name: 'run_shell_command' })];
    expect(fold(events).activity).toBe('working');
  });

  it('Stop finishes the turn (idle once seen)', () => {
    const events = [ups(1, 'go'), record(2, { hook_event_name: 'Stop' })];
    expect(fold(events)).toMatchObject({ activity: 'unseen', turnEndedAt: t(2) });
    expect(activityOf({ events, now: NOW, seen: true }).activity).toBe('idle');
  });

  it('Notification permission_prompt and PermissionRequest wait for the human; the tool running after it clears the wait', () => {
    const prompt = [ups(1, 'go'), record(2, { hook_event_name: 'PreToolUse', tool_name: 'mcp__parley__get_map' }),
      record(3, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow get_map?' })];
    expect(fold(prompt)).toMatchObject({ activity: 'blocked', need: { kind: 'approval' } });
    const request = [ups(1, 'go'), record(2, { hook_event_name: 'PermissionRequest', tool_name: 'run_shell_command' })];
    expect(fold(request)).toMatchObject({ activity: 'blocked', need: { kind: 'approval' } });
    expect(fold([...prompt, record(4, { hook_event_name: 'PostToolUse', tool_name: 'mcp__parley__get_map' })]))
      .toMatchObject({ activity: 'working', need: null });
  });

  it('Notification idle_prompt is idle', () => {
    const events = [ups(1, 'go'), record(2, { hook_event_name: 'Notification', notification_type: 'idle_prompt' })];
    expect(fold(events)).toMatchObject({ activity: 'unseen', turnEndedAt: t(2) });
  });

  it('StopFailure fails the turn and shows it as stuck with the message', () => {
    const events = [ups(1, 'go'), record(2, {
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_details: 'Rate limit exceeded. Try again later.',
      last_assistant_message: '[API Error: 429 Rate limit exceeded]',
    })];
    expect(fold(events)).toMatchObject({
      activity: 'unseen',
      need: { kind: 'limit', detail: '[API Error: 429 Rate limit exceeded]' },
    });
    const auth = [ups(1, 'go'), record(2, { hook_event_name: 'StopFailure', error: 'authentication_failed', error_details: '401' })];
    expect(fold(auth).need).toMatchObject({ kind: 'sign-in', account: 'auth' });
  });

  it('SessionEnd is passive: the turn state stays as the process left it', () => {
    const events = [ups(1, 'go'), record(2, { hook_event_name: 'Stop' }), record(3, { hook_event_name: 'SessionEnd' })];
    expect(fold(events).activity).toBe('unseen');
  });
});

describe('qwenContextFill', () => {
  it('turns the Stop fraction and window into a fill', () => {
    expect(qwenContextFill(0.25, 200000, t(1))).toEqual({ usedPercent: 25, windowTokens: 200000, usedTokens: 50000, at: t(1) });
    expect(qwenContextFill(0.0001, undefined, t(1))).toEqual({ usedPercent: 0, windowTokens: null, usedTokens: null, at: t(1) });
    expect(qwenContextFill(1.4, 1000, t(1))).toMatchObject({ usedPercent: 100, usedTokens: 1000 });
    expect(qwenContextFill(undefined, 1000, t(1))).toBeNull();
    expect(qwenContextFill(-1, 1000, t(1))).toBeNull();
  });
});

describe('openEvents: per-session family', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'parley-events-family-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses Qwen facts only for the sessions the resolver names as qwen', async () => {
    const line = `${JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '' })}\n`;
    await writeFile(path.join(dir, 's-1.jsonl'), line);
    await writeFile(path.join(dir, 's-2.jsonl'), line);
    const journal = openEvents(dir, (sessionId) => (sessionId === 's-1' ? 'qwen' : 'claude'));
    expect((await journal.read('s-1'))?.[0]?.promptEmpty).toBe(true);
    expect((await journal.read('s-2'))?.[0]).not.toHaveProperty('promptEmpty');
  });
});
