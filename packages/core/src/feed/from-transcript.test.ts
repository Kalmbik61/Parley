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
import type { FeedAgent, FeedItem, FeedPrompt, FeedTool, FeedTurn } from './types.js';

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
    // Прерванный ход: черта одна, с признаком и длительностью из записи `turn_duration`.
    expect(items[6]).toMatchObject({ kind: 'turn', interrupted: true });
    expect((items[6] as FeedTurn).durationMs).not.toBeNull();
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

describe('feedFromTranscript: ветки и пределы', () => {
  const T = '2026-10-01T10:00:00.000Z';
  const user = (
    uuid: string,
    content: unknown,
    extra: Record<string, unknown> = {},
  ): RawRecord => ({
    type: 'user',
    uuid,
    timestamp: T,
    message: { role: 'user', content },
    ...extra,
  });
  const toolUse = (uuid: string, id: string, name: string, input: unknown): RawRecord => ({
    type: 'assistant',
    uuid,
    timestamp: T,
    message: {
      id: `msg_${uuid}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
  const result = (uuid: string, id: string, extra: Record<string, unknown> = {}): RawRecord =>
    user(uuid, [{ type: 'tool_result', tool_use_id: id, content: 'out', ...extra }]);

  it('isMeta с обычным текстом промптом не становится', () => {
    const { items } = feedFromTranscript([user('u1', 'plain text', { isMeta: true })]);

    expect(items).toEqual([]);
  });

  it('tool_result с is_error — вызов failed', () => {
    const { items } = feedFromTranscript([
      toolUse('a1', 't1', 'Bash', { command: 'false' }),
      result('u1', 't1', { is_error: true }),
    ]);

    expect(kinds(items)).toEqual(['tool:failed']);
  });

  it('прерывание без отказа в диалоге отклоняет идущие вызовы и ставит черту interrupted', () => {
    const { items } = feedFromTranscript([
      toolUse('a1', 't1', 'Bash', { command: 'sleep 9' }),
      user('u1', [{ type: 'text', text: '[Request interrupted by user]' }]),
    ]);

    expect(kinds(items)).toEqual(['tool:rejected', 'turn']);
    expect(items.at(-1)).toMatchObject({ kind: 'turn', durationMs: null, interrupted: true });
  });

  it('is_error у вызова Agent — карточка агента failed', () => {
    const { items } = feedFromTranscript([
      toolUse('a1', 't1', 'Agent', { subagent_type: 'Explore', prompt: 'p' }),
      result('u1', 't1', { is_error: true }),
    ]);

    expect(items).toMatchObject([{ kind: 'agent', status: 'failed' }]);
  });

  it('повтор записей журнала (тот же uuid) не дублирует элементы', () => {
    const records: RawRecord[] = [
      toolUse('a1', 't1', 'Bash', { command: 'ls' }),
      result('u1', 't1'),
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: T,
        message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ];
    const once = feedFromTranscript(records);
    const twice = feedFromTranscript([...records, ...records]);

    expect(twice.items).toEqual(once.items);
  });

  it('запись без времени получает время предыдущей, а первая — начало эпохи', () => {
    const { items } = feedFromTranscript([
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'first' } },
      user('u1', 'second'),
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'third' } },
    ]);

    expect(items.map((item) => item.at)).toEqual([new Date(0).toISOString(), T, T]);
  });

  it('limit: 20 000 записей быстрее 3 с, в ответе не больше limit элементов', () => {
    const records: RawRecord[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      records.push(toolUse(`a${i}`, `t${i}`, 'Bash', { command: `echo ${i}` }));
      records.push(result(`u${i}`, `t${i}`));
    }
    const started = performance.now();
    const { items } = feedFromTranscript(records, { limit: 2_000 });

    expect(performance.now() - started).toBeLessThan(3000);
    expect(items.length).toBeLessThanOrEqual(2_000);
    expect(items.at(-1)).toMatchObject({ kind: 'tool', toolUseId: 't9999', status: 'done' });
    expect(feedFromTranscript(records.slice(0, 20)).items).toHaveLength(10);
  });
});

describe('feedFromTranscript: режим разрешений', () => {
  it('p5b: последняя запись permission-mode — default', () => {
    expect(feedFromTranscript(records('transcript-p5b-write')).permissionMode).toBe('default');
  });

  it('последняя запись побеждает; без записей — null', () => {
    const mode = (permissionMode: string): RawRecord => ({ type: 'permission-mode', permissionMode });
    expect(feedFromTranscript([mode('default'), mode('plan')]).permissionMode).toBe('plan');
    expect(feedFromTranscript([]).permissionMode).toBeNull();
  });
});
