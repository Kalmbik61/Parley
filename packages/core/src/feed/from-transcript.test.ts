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
import { feedFromTranscript, interruptedAt, retryFromTranscript } from './from-transcript.js';
import { stashFeedImages } from './images.js';
import { applyHookEvent } from './reduce.js';
import type { FeedAgent, FeedImageRef, FeedItem, FeedPrompt, FeedTool, FeedTurn } from './types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const records = (name: string): RawRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawRecord);

const kinds = (items: readonly FeedItem[]): string[] =>
  items.map((item) => (item.kind === 'tool' ? `tool:${item.status}` : item.kind));

describe('API retry records', () => {
  const networkRetry = {
    type: 'system', subtype: 'api_error', uuid: 'network-1',
    timestamp: '2026-10-05T10:00:00.000Z',
    error: { message: 'Connection error.', formatted: 'Connection dropped (ECONNRESET)' },
    retryInMs: 614, retryAttempt: 1, maxRetries: 10,
  };

  it('uses the formatted network error from the actual CLI retry format', () => {
    expect(retryFromTranscript(networkRetry)).toMatchObject({
      error: 'api_error', message: 'Connection dropped (ECONNRESET)',
      retry: { delayMs: 614, attempt: 1, maxAttempts: 10 },
    });
  });

  it('ignores malformed retry records instead of producing a broken countdown', () => {
    for (const invalid of [
      { retryInMs: -1 }, { retryInMs: Infinity }, { retryAttempt: 0 },
      { retryAttempt: 11 }, { retryAttempt: 1.5 }, { timestamp: 'invalid' },
      { subtype: 'other' },
    ]) expect(retryFromTranscript({ ...networkRetry, ...invalid })).toBeNull();
  });

  it('keeps 429 retry details in history without turning them into assistant text', () => {
    const { items } = feedFromTranscript([{
      type: 'system', subtype: 'api_error', uuid: 'retry-6',
      timestamp: '2026-10-05T10:00:00.000Z',
      error: { status: 429, message: 'Usage limit reached for 5 hour.' },
      retryInMs: 8000, retryAttempt: 6, maxRetries: 10,
    }]);
    expect(items).toEqual([{
      id: 'retry:retry-6', at: '2026-10-05T10:00:00.000Z', kind: 'error',
      error: '429', message: 'Usage limit reached for 5 hour.',
      retry: { delayMs: 8000, attempt: 6, maxAttempts: 10 },
    }]);
  });
});

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

describe('interruptedAt', () => {
  it('время записи прерывания — строкой и блоками; прочие записи — null', () => {
    const at = '2026-10-02T10:00:00.000Z';
    const user = (content: unknown, extra: Record<string, unknown> = {}): RawRecord => ({
      type: 'user',
      timestamp: at,
      message: { role: 'user', content },
      ...extra,
    });
    expect(interruptedAt(user('[Request interrupted by user]'))).toBe(at);
    expect(interruptedAt(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(at);
    expect(interruptedAt(user('hello'))).toBeNull();
    expect(interruptedAt(user([{ type: 'tool_result', content: 'x' }]))).toBeNull();
    expect(interruptedAt({ type: 'assistant', timestamp: at, message: { content: '[Request interrupted by user]' } })).toBeNull();
    expect(interruptedAt({ type: 'user', message: { content: '[Request interrupted by user]' } })).toBeNull();
  });
});

describe('feedFromTranscript: картинки результата инструмента (план 2026-10-09, Task 1)', () => {
  const T = '2026-10-09T10:00:00.000Z';
  const KB = 1024;
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const ref = (n: number): FeedImageRef => ({
    path: `/home/.parley/feed-images/img${n}.png`,
    mime: 'image/png',
    bytes: 123 * KB,
  });
  /** Блок на месте картинки, как его оставляет хост (`stashFeedImages`). */
  const shot = (n: number) => ({ type: 'image', parleyImage: ref(n) });
  const text = (value: string) => ({ type: 'text', text: value });
  const toolUse = (id: string, name: string): RawRecord => ({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: T,
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  });
  const result = (id: string, content: unknown, toolUseResult?: unknown): RawRecord => ({
    type: 'user',
    uuid: `u-${id}`,
    timestamp: T,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  });
  const toolOf = (records: RawRecord[]): FeedTool =>
    feedFromTranscript(records).items.find((item): item is FeedTool => item.kind === 'tool') as FeedTool;

  it('MCP-скриншот: массив блоков в toolUseResult — текст с пометкой и ссылка в images', () => {
    const blocks = [text('Took a screenshot'), shot(1)];
    const tool = toolOf([
      toolUse('t1', 'mcp__browser__screenshot'),
      result('t1', blocks, blocks),
    ]);

    expect(tool.status).toBe('done');
    expect(tool.response?.text).toBe('Took a screenshot\n[image png, 123 KB]');
    expect(tool.response?.images).toEqual([ref(1)]);
  });

  it('toolUseResult не картинка (строка или нет вовсе), а картинка в content — берётся content', () => {
    const blocks = [text('Took a screenshot'), shot(1)];

    for (const toolUseResult of ['Took a screenshot', undefined, 'Error: nope']) {
      const tool = toolOf([toolUse('t1', 'mcp__browser__screenshot'), result('t1', blocks, toolUseResult)]);
      expect(tool.response?.text).toBe('Took a screenshot\n[image png, 123 KB]');
      expect(tool.response?.images).toEqual([ref(1)]);
    }
  });

  it('Read картинки: toolUseResult — объект-картинка, ссылка в images', () => {
    const tool = toolOf([
      toolUse('t1', 'Read'),
      result('t1', [shot(1)], shot(1)),
    ]);

    expect(tool.response?.text).toBe('[image png, 123 KB]');
    expect(tool.response?.images).toEqual([ref(1)]);
  });

  it('картинка, которую хост выбросил (parleyImageOmitted): пометка «[image omitted]», images нет', () => {
    const blocks = [text('Took a screenshot'), { type: 'image', parleyImageOmitted: true }];
    const tool = toolOf([toolUse('t1', 'mcp__browser__screenshot'), result('t1', blocks, blocks)]);

    expect(tool.response?.text).toBe('Took a screenshot\n[image omitted]');
    expect('images' in (tool.response ?? {})).toBe(false);
  });

  it('без картинок прежний разбор: текст блоков content, если toolUseResult не объект', () => {
    const tool = toolOf([
      toolUse('t1', 'mcp__x__y'),
      result('t1', [text('line one'), text('line two')], 'ignored string'),
    ]);

    expect(tool.response?.text).toBe('line one\nline two');
    expect('images' in (tool.response ?? {})).toBe(false);
  });

  it('объект toolUseResult без картинки по-прежнему идёт в сводку как есть', () => {
    const tool = toolOf([
      toolUse('t1', 'Bash'),
      result('t1', 'out', { stdout: 'out', stderr: '' }),
    ]);

    expect(tool.response?.text).toBe('out');
  });

  it('картинка промпта после хоста (type сохранён) считается так же: images: 1', () => {
    const { items } = feedFromTranscript([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: T,
        message: { role: 'user', content: [text('What is on this screenshot?'), shot(1)] },
      },
    ]);

    expect(items).toEqual([
      { id: 'prompt:#1', at: T, kind: 'prompt', text: 'What is on this screenshot?', images: 1 },
    ]);
  });

  it('запись журнала с base64 после stashFeedImages: ссылка в ленте, байтов в ней нет, картинка промпта считается', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    const raw: RawRecord[] = [
      toolUse('t1', 'mcp__browser__screenshot'),
      result('t1', [text('Took a screenshot'), image], [text('Took a screenshot'), image]),
      {
        type: 'user',
        uuid: 'u2',
        timestamp: T,
        message: { role: 'user', content: [text('and this one?'), image] },
      },
    ];
    let saved = 0;
    const stashed = raw.map(
      (record) =>
        stashFeedImages(record, () => {
          saved += 1;
          return ref(1);
        }) as RawRecord,
    );
    const { items } = feedFromTranscript(stashed);

    // Картинка стоит в записи вызова дважды (toolUseResult и content) и в промпте — три места.
    expect(saved).toBe(3);
    const tool = items.find((item): item is FeedTool => item.kind === 'tool');
    expect(tool?.response?.images).toEqual([ref(1)]);
    expect(items.find((item): item is FeedPrompt => item.kind === 'prompt')?.images).toBe(1);
    expect(JSON.stringify(items)).not.toContain('iVBOR');
  });
});
