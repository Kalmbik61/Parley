/**
 * Лента из журнала сессии (план 2026-10-01, Task 1, пункт 3) на настоящих журналах проб разведки:
 * `transcript-*.jsonl` — журналы сессий p2, p5b и p6b (и журнал субагента p6b) без служебных
 * вложений, с обезличенными путями (`<proj>`, `user`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawRecord } from '../jsonl.js';
import { feedFromTranscript } from './from-transcript.js';
import { applyHookEvent } from './reduce.js';
import type { FeedAgent, FeedItem, FeedPrompt, FeedTool } from './types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const records = (name: string): RawRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawRecord);

const kinds = (items: readonly FeedItem[]): string[] =>
  items.map((item) => (item.kind === 'tool' ? `tool:${item.status}` : item.kind));

describe('feedFromTranscript на настоящих журналах', () => {
  it('p2: порядок хода, отказ в диалоге и прерывание', () => {
    const { items } = feedFromTranscript(records('transcript-p2-permissions'));

    expect(kinds(items)).toEqual([
      'prompt',
      'tool:done',
      'text',
      'turn',
      'prompt',
      'tool:rejected',
      'turn',
      'prompt',
      'tool:done',
      'text',
      'turn',
      'prompt',
      'tool:done',
      'text',
      'turn',
    ]);
    const rejected = items[5] as FeedTool;
    expect(rejected.input['command']).toBe('touch probe-b.txt');
    expect(rejected.response?.text).toMatch(/^The user doesn't want to proceed/);
    // Прерывание «[Request interrupted by user for tool use]» промптом не становится.
    expect(
      items.filter((item) => item.kind === 'prompt').map((item) => (item as FeedPrompt).text),
    ).not.toContainEqual(expect.stringContaining('[Request interrupted'));
    expect(items[3]).toMatchObject({ kind: 'turn', durationMs: 4648 });
  });

  it('p5b: дифф правки из structuredPatch, слеш-команда — промпт без разметки', () => {
    const { items } = feedFromTranscript(records('transcript-p5b-write'));
    const tools = items.filter((item): item is FeedTool => item.kind === 'tool');

    expect(tools.map((tool) => tool.name)).toEqual(['Write', 'Edit']);
    expect(tools[0]?.patch).toBeUndefined();
    expect(tools[1]?.patch).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '+gamma'] },
    ]);
    // Сводка правки — без исходного файла: он в диффе.
    expect(tools[1]?.response?.text).not.toContain('originalFile');
    expect(items.at(-1)).toMatchObject({ kind: 'prompt', text: '/exit' });
  });

  it('p6b: вызов Agent — карточка агента, пробуждение — notice, размышления пропущены', () => {
    const { items } = feedFromTranscript(records('transcript-p6b-subagents'));
    const agents = items.filter((item): item is FeedAgent => item.kind === 'agent');

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: 'ad2fe21e96ffde3ba',
      agentType: 'Explore',
      description: 'List project files',
      model: 'claude-haiku-4-5-20251001',
      background: true,
      status: 'done',
      children: [],
    });
    expect(agents[0]?.result).toMatch(/^Here's the complete listing/);
    expect(items.filter((item) => item.kind === 'prompt')).toHaveLength(2);
    expect(items.find((item) => item.kind === 'notice')).toMatchObject({
      notice: { type: 'agent-reported', agentItemId: agents[0]?.id, status: 'completed' },
    });
    expect(kinds(items)).toEqual([
      'prompt',
      'agent',
      'text',
      'turn',
      'notice',
      'text',
      'turn',
      'prompt',
    ]);
  });

  it('журнал субагента: задание — промпт, вложенный вызов — в общем потоке его ленты', () => {
    const { items } = feedFromTranscript(records('transcript-p6b-agent-ad2fe21e96ffde3ba'));

    expect(kinds(items)).toEqual(['prompt', 'tool:done', 'text']);
    expect((items[1] as FeedTool).response?.text).toMatch(/^total 24/);
  });

  it('картинка в промпте считается, служебные вставки пропущены', () => {
    const { items } = feedFromTranscript([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is on this screenshot?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' },
      },
      {
        type: 'user',
        uuid: 'u3',
        message: { role: 'user', content: '<local-command-stdout>bye</local-command-stdout>' },
      },
      { type: 'queue-operation', operation: 'enqueue', content: 'later' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: '…' }] },
      },
    ]);

    expect(items).toEqual([
      {
        id: 'prompt:#1',
        at: '2026-10-01T10:00:00.000Z',
        kind: 'prompt',
        text: 'What is on this screenshot?',
        images: 1,
      },
    ]);
  });

  it('ошибка API — карточка ошибки', () => {
    const { items } = feedFromTranscript([
      {
        type: 'assistant',
        uuid: 'a1',
        isApiErrorMessage: true,
        error: 'account_on_hold',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Your account is on hold' }],
        },
      },
    ]);

    expect(items).toMatchObject([
      { kind: 'error', error: 'account_on_hold', message: 'Your account is on hold' },
    ]);
  });

  it('живые события продолжают ленту, посеянную из журнала', () => {
    const seeded = feedFromTranscript(records('transcript-p5b-write'));
    const { state } = applyHookEvent(
      seeded,
      { hook_event_name: 'UserPromptSubmit', prompt: 'next' },
      '2026-10-01T13:00:00.000Z',
    );

    expect(state.items).toHaveLength(seeded.items.length + 1);
    expect(new Set(state.items.map((item) => item.id)).size).toBe(state.items.length);
  });
});
