import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activityOf } from './activity.js';
import { eventRecordOf, openEvents } from './events.js';

const FIXTURE = path.resolve(import.meta.dirname, '../feed/qwen/__fixtures__/hook-payloads.jsonl');
const AT = '2026-11-11T13:20:00.000Z';
const NOW = Date.parse('2026-11-11T13:20:10.000Z');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-events-qwen-'));
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ups = (prompt: string): Record<string, unknown> => ({
  hook_event_name: 'UserPromptSubmit',
  prompt,
  submitted_prompt: prompt,
});

describe('eventRecordOf: qwen hook facts', () => {
  it('keeps promptEmpty, notificationType, contextUsage and contextLimit', () => {
    expect(eventRecordOf(ups(''), AT, 'qwen')?.promptEmpty).toBe(true);
    expect(eventRecordOf(ups('hello'), AT, 'qwen')?.promptEmpty).toBe(false);
    const note = eventRecordOf({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, AT, 'qwen');
    expect(note?.notificationType).toBe('idle_prompt');
    const stop = eventRecordOf(
      { hook_event_name: 'Stop', context_usage: 0.25, context_limit: 200000, last_assistant_message: 'SECRET-REPLY' },
      AT,
      'qwen',
    );
    expect(stop?.contextUsage).toBe(0.25);
    expect(stop?.contextLimit).toBe(200000);
  });

  it('stores no prompt text, reply or tool input', () => {
    const records = [
      eventRecordOf({ ...ups('SECRET-PROMPT') }, AT, 'qwen'),
      eventRecordOf({ hook_event_name: 'Stop', last_assistant_message: 'SECRET-REPLY', context_usage: 1 }, AT, 'qwen'),
      eventRecordOf({ hook_event_name: 'PreToolUse', tool_name: 'x', tool_input: { secret: 'SECRET-INPUT' } }, AT, 'qwen'),
    ];
    const out = JSON.stringify(records);
    for (const s of ['SECRET-PROMPT', 'SECRET-REPLY', 'SECRET-INPUT']) expect(out).not.toContain(s);
  });

  it('leaves Claude and Codex records without the new fields', () => {
    for (const family of [undefined, null, 'claude', 'codex'] as const) {
      const rec = eventRecordOf({ ...ups(''), context_usage: 1, context_limit: 2 }, AT, family);
      expect(rec).not.toBeNull();
      expect('promptEmpty' in (rec ?? {})).toBe(false);
      const stop = eventRecordOf({ hook_event_name: 'Stop', context_usage: 1, context_limit: 2 }, AT, family);
      expect('contextUsage' in (stop ?? {})).toBe(false);
      expect('contextLimit' in (stop ?? {})).toBe(false);
    }
  });
});

describe('replay of a qwen journal', () => {
  it('the empty follow-up gives one turn and keeps the wait', async () => {
    const lines = [
      { hook_event_name: 'SessionStart', source: 'startup' },
      ups('first prompt'),
      { hook_event_name: 'ParleyWaitStart', parley_wait_target: 's-03', parley_wait_id: 'w1' },
      ups(''),
    ];
    await writeFile(path.join(dir, 'q.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const events = (await openEvents(dir, 'qwen').read('q')) ?? [];
    expect(events.filter((e) => e.name === 'UserPromptSubmit' && e.promptEmpty !== true)).toHaveLength(1);
    const result = activityOf({ events, now: NOW });
    expect(result.activity).toBe('working');
    expect(result.waitingFor).toBe('s-03');
  });

  it('the recorded fixture: the empty prompt ends neither the turn nor the idle after Stop', async () => {
    const raw = (await readFile(FIXTURE, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    const upIdx = raw.findIndex((l) => l.includes('"UserPromptSubmit"') && l.includes('"prompt":""'));
    expect(upIdx).toBeGreaterThan(0);
    await writeFile(path.join(dir, 'f.jsonl'), raw.slice(0, upIdx + 1).join('\n') + '\n');
    const events = (await openEvents(dir, 'qwen').read('f')) ?? [];
    expect(events.filter((e) => e.name === 'UserPromptSubmit' && e.promptEmpty === false)).toHaveLength(1);
    expect(activityOf({ events, now: NOW }).activity).toBe('working');
  });

  it('without the family the same journal behaves as before (the empty prompt starts a turn)', async () => {
    const lines = [ups('a'), { hook_event_name: 'Stop' }, ups('')];
    await writeFile(path.join(dir, 'c.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const events = (await openEvents(dir).read('c')) ?? [];
    expect(activityOf({ events, now: NOW }).activity).toBe('working');
  });

  it('a qwen empty prompt after Stop does not restart the turn', async () => {
    const lines = [ups('a'), { hook_event_name: 'Stop' }, ups('')];
    await writeFile(path.join(dir, 'd.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const events = (await openEvents(dir, 'qwen').read('d')) ?? [];
    expect(activityOf({ events, now: NOW }).activity).not.toBe('working');
  });
});
