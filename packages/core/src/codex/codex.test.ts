import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexSessions } from './discover.js';
import { buildCodexIndex, extendCodexSessionIndex, indexCodexSession } from './index-session.js';

let root: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

/** Кладёт rollout-лог в <root>/<Y>/<M>/<D>/, как это делает Codex. */
async function writeRollout(day: string, id: string, lines: string): Promise<string> {
  const dir = path.join(root, ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${day}T10-00-00-${id}.jsonl`);
  await writeFile(file, lines);
  return file;
}

const meta = (at = '2026-03-12T10:00:00.000Z', over: Record<string, unknown> = {}) =>
  line({
    timestamp: at,
    type: 'session_meta',
    payload: {
      id: '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      timestamp: at,
      cwd: '/Users/dev/проект',
      originator: 'codex_cli_rs',
      cli_version: '0.77.0',
      source: 'cli',
      model_provider: 'openai',
      git: { branch: 'main', commit_hash: 'abc123', repository_url: 'https://example.test/r.git' },
      ...over,
    },
  });

const turn = (model: string, at = '2026-03-12T10:00:05.000Z') =>
  line({
    timestamp: at,
    type: 'turn_context',
    payload: { type: 'turn_context', cwd: '/Users/dev/проект', model, effort: 'xhigh' },
  });

const userMessage = (message: string, at = '2026-03-12T10:00:10.000Z') =>
  line({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message } });

const functionCall = (name: string) =>
  line({
    timestamp: '2026-03-12T10:00:20.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name, call_id: 'call_1', arguments: '{}' },
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverCodexSessions', () => {
  it('находит rollout-логи в раскладке год/месяц/день', async () => {
    await writeRollout('2026-03-12', '019ce3d5-584a-7be2-922e-b8185a8d7c19', meta());
    await writeRollout('2026-01-04', '019b8975-986e-7902-bf35-fb3f538faf74', meta());

    const found = await discoverCodexSessions(root);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.id).sort()).toEqual([
      '019b8975-986e-7902-bf35-fb3f538faf74',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
    ]);
  });

  it('несуществующий корень — пустой список, не ошибка', async () => {
    expect(await discoverCodexSessions(path.join(root, 'нет-такого'))).toEqual([]);
  });

  it('посторонние файлы игнорируются', async () => {
    const dir = path.join(root, '2026', '03', '12');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'заметка.txt'), 'не сессия');

    expect(await discoverCodexSessions(root)).toEqual([]);
  });
});

describe('indexCodexSession', () => {
  it.each(['task_started', 'task_complete', 'turn_aborted'])(
    'индексирует явное состояние хода %s без служебного хвоста',
    async (type) => {
      const at = '2026-03-12T10:00:30.000Z';
      const file = await writeRollout(
        '2026-03-12',
        'turn-state',
        meta() +
          line({ timestamp: at, type: 'event_msg', payload: { type } }) +
          line({
            timestamp: '2026-03-12T10:00:31.000Z',
            type: 'event_msg',
            payload: { type: 'token_count' },
          }),
      );
      expect(await indexCodexSession(file)).toMatchObject({ lastTurnEvent: { type, at } });
    },
  );

  describe('ошибка, которой кончился ход (task_complete.error)', () => {
    const AT = '2026-03-12T10:00:30.000Z';
    const LATER = '2026-03-12T10:01:00.000Z';
    // Настоящая запись: `error` лежит в самом `task_complete` рядом с `last_agent_message`.
    const LIMIT = {
      message:
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 7:27 PM.",
      codex_error_info: 'usage_limit_exceeded',
    };
    const turnEvent = (type: string, at: string, extra: Record<string, unknown> = {}): string =>
      line({ timestamp: at, type: 'event_msg', payload: { type, turn_id: 'turn-1', ...extra } });

    it('task_complete с error: lastTurnEvent несёт info (codex_error_info) и message', async () => {
      const file = await writeRollout(
        '2026-03-12',
        'turn-error',
        meta() +
          turnEvent('task_started', '2026-03-12T10:00:10.000Z') +
          turnEvent('task_complete', AT, { last_agent_message: null, error: LIMIT }) +
          // Служебный хвост после ответа событие хода не меняет.
          line({ timestamp: LATER, type: 'event_msg', payload: { type: 'token_count' } }),
      );

      expect((await indexCodexSession(file)).lastTurnEvent).toEqual({
        type: 'task_complete',
        at: AT,
        error: { info: 'usage_limit_exceeded', message: LIMIT.message },
      });
    });

    it.each([
      ['task_started', {}],
      ['turn_aborted', { reason: 'interrupted' }],
      ['task_complete', { last_agent_message: 'готово' }],
    ])(
      'следующий %s заменяет событие, и ошибка старого не переходит к новому',
      async (type, extra) => {
        const file = await writeRollout(
          '2026-03-12',
          `turn-after-${type}`,
          meta() + turnEvent('task_complete', AT, { error: LIMIT }) + turnEvent(type, LATER, extra),
        );

        const index = await indexCodexSession(file);

        expect(index.lastTurnEvent).toEqual({ type, at: LATER });
        expect(index.lastTurnEvent).not.toHaveProperty('error');
      },
    );

    it('codex_error_info вариантом с полями приходит как есть', async () => {
      const info = { http_connection_failed: { http_status_code: 502 } };
      const file = await writeRollout(
        '2026-03-12',
        'turn-error-object',
        meta() +
          turnEvent('task_complete', AT, {
            error: { message: 'Connection failed', codex_error_info: info },
          }),
      );

      expect((await indexCodexSession(file)).lastTurnEvent?.error).toEqual({
        info,
        message: 'Connection failed',
      });
    });

    it('error без message остаётся ошибкой с пустым текстом: вид (info) не теряется', async () => {
      const file = await writeRollout(
        '2026-03-12',
        'turn-error-no-text',
        meta() + turnEvent('task_complete', AT, { error: { codex_error_info: 'unauthorized' } }),
      );

      expect((await indexCodexSession(file)).lastTurnEvent?.error).toEqual({
        info: 'unauthorized',
        message: '',
      });
    });

    it.each([
      ['нет error', 'no-error-a', {}],
      ['error: null', 'no-error-b', { error: null }],
      ['error строкой', 'no-error-c', { error: 'boom' }],
      ['error списком', 'no-error-d', { error: [LIMIT] }],
    ])('task_complete, %s — ошибки в lastTurnEvent нет', async (_name, id, extra) => {
      const file = await writeRollout(
        '2026-03-12',
        id,
        meta() + turnEvent('task_complete', AT, extra),
      );

      const index = await indexCodexSession(file);

      expect(index.lastTurnEvent).toEqual({ type: 'task_complete', at: AT });
      expect(index.lastTurnEvent).not.toHaveProperty('error');
    });

    it('error у task_started и turn_aborted не читается: ошибкой кончается только task_complete', async () => {
      const file = await writeRollout(
        '2026-03-12',
        'turn-error-wrong-event',
        meta() +
          turnEvent('task_started', AT, { error: LIMIT }) +
          turnEvent('turn_aborted', LATER, { error: LIMIT }),
      );

      expect((await indexCodexSession(file)).lastTurnEvent).toEqual({
        type: 'turn_aborted',
        at: LATER,
      });
    });
  });

  it('раскладывает мету, модель, инструменты и заголовок', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() +
        turn('gpt-5.2-codex') +
        userMessage('почини сборку') +
        functionCall('shell_command') +
        functionCall('shell_command') +
        functionCall('update_plan') +
        line({
          timestamp: '2026-03-12T10:05:00.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [] },
        }),
    );

    const index = await indexCodexSession(file);

    expect(index.provider).toBe('codex');
    expect(index.id).toBe('019ce3d5-584a-7be2-922e-b8185a8d7c19');
    expect(index.cwd).toBe('/Users/dev/проект');
    expect(index.project).toBe('проект');
    expect(index.gitBranch).toBe('main');
    expect(index.version).toBe('0.77.0');
    expect(index.title).toBe('почини сборку');
    expect(index.titleSource).toBe('first-text');
    expect(index.primaryModel).toBe('gpt-5.2-codex');
    expect(index.tools).toEqual({ shell_command: 2, update_plan: 1 });
    expect(index.roles).toEqual({ assistant: 1 });
    expect(index.durationMs).toBe(300_000);
    // Реплика человека, а не последняя запись лога (та в 10:05:00).
    expect(index.lastUserRecordAt).toBe('2026-03-12T10:00:10.000Z');
    expect(index.subsessionCount).toBe(0);
  });

  it('первая реплика — указатель Parley на письма: firstPromptPointer; указатель позже — нет', async () => {
    const pointer = 'New messages (1) in r-01 "Second". Call check_inbox.';
    const woken = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c20',
      meta() + userMessage(pointer) + userMessage('почини сборку', '2026-03-12T10:01:00.000Z'),
    );
    expect((await indexCodexSession(woken)).firstPromptPointer).toBe(true);

    const usual = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c21',
      meta() + userMessage('почини сборку') + userMessage(pointer, '2026-03-12T10:01:00.000Z'),
    );
    expect(await indexCodexSession(usual)).not.toHaveProperty('firstPromptPointer');
  });

  it('заголовок берётся из реплики человека, а не из системных сообщений', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() +
        // Такие сообщения едут модели первыми и содержат AGENTS.md и окружение.
        line({
          timestamp: '2026-03-12T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context> служебное' }],
          },
        }) +
        userMessage('настоящая реплика'),
    );

    const index = await indexCodexSession(file);
    expect(index.title).toBe('настоящая реплика');
  });

  it('несколько моделей за сессию — primaryModel самая частая', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() +
        turn('gpt-5.2') +
        turn('gpt-5.2-codex') +
        turn('gpt-5.2-codex') +
        userMessage('вопрос'),
    );

    const index = await indexCodexSession(file);
    expect(index.primaryModel).toBe('gpt-5.2-codex');
    expect(index.models).toEqual({ 'gpt-5.2-codex': 2, 'gpt-5.2': 1 });
  });

  it('кастомные инструменты считаются наравне с обычными', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() +
        functionCall('shell_command') +
        line({
          timestamp: '2026-03-12T10:00:21.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'apply_patch' },
        }),
    );

    const index = await indexCodexSession(file);
    expect(index.tools).toEqual({ shell_command: 1, apply_patch: 1 });
  });

  it('токены берутся из последней записи token_count', async () => {
    const tokenCount = (input: number, cached: number, output: number, at: string) =>
      line({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: input + output,
            },
            model_context_window: 258_400,
          },
        },
      });

    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() +
        tokenCount(1_000, 800, 50, '2026-03-12T10:01:00.000Z') +
        // Счётчик накопительный — побеждает последняя запись, а не сумма.
        tokenCount(5_000, 4_400, 130, '2026-03-12T10:02:00.000Z'),
    );

    const index = await indexCodexSession(file);
    expect(index.tokens).toEqual({ input: 600, output: 130, cacheRead: 4_400, cacheWrite: 0 });
  });

  it('без token_count токенов нет', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() + userMessage('вопрос'),
    );
    expect((await indexCodexSession(file)).tokens).toBeNull();
  });

  it('пустая сессия без реплик остаётся без заголовка, но не ломается', async () => {
    const file = await writeRollout('2026-03-12', '019ce3d5-584a-7be2-922e-b8185a8d7c19', meta());

    const index = await indexCodexSession(file);
    expect(index.title).toBeNull();
    expect(index.titleSource).toBeNull();
    expect(index.primaryModel).toBeNull();
    expect(index.records).toBe(1);
  });

  it('сессия без git отдаёт null, а не падает', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      line({
        timestamp: '2026-03-12T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'x', cwd: '/tmp/проект', cli_version: '0.77.0' },
      }),
    );

    const index = await indexCodexSession(file);
    expect(index.gitBranch).toBeNull();
    expect(index.id).toBe('x');
  });

  it('оборванная последняя строка учитывается, но не мешает', async () => {
    const file = await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta() + userMessage('вопрос') + '{"timestamp":"2026-03',
    );

    const index = await indexCodexSession(file);
    expect(index.title).toBe('вопрос');
    expect(index.malformedLines).toBe(1);
  });
});

describe('buildCodexIndex', () => {
  it('сортирует по свежести', async () => {
    await writeRollout(
      '2026-01-04',
      '019b8975-986e-7902-bf35-fb3f538faf74',
      meta('2026-01-04T10:00:00.000Z') + userMessage('старая', '2026-01-04T10:00:00.000Z'),
    );
    await writeRollout(
      '2026-03-12',
      '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      meta('2026-03-12T10:00:00.000Z') + userMessage('свежая', '2026-03-12T10:00:00.000Z'),
    );

    const index = await buildCodexIndex(root);
    expect(index.map((s) => s.title)).toEqual(['свежая', 'старая']);
    expect(index.every((s) => s.provider === 'codex')).toBe(true);
  });
});

describe('indexCodexSession: вызов code mode без ответа (сторож, разбор 2026-10-16)', () => {
  const item = (at: string, payload: Record<string, unknown>) => line({ timestamp: at, type: 'response_item', payload });
  const exec = (at: string, input: string, callId = 'call_exec') =>
    item(at, { type: 'custom_tool_call', name: 'exec', call_id: callId, input });
  const execOutput = (at: string, callId = 'call_exec') =>
    item(at, { type: 'custom_tool_call_output', call_id: callId, output: 'Script completed' });
  const wait = (at: string, args: string, callId = 'call_wait') =>
    item(at, { type: 'function_call', name: 'wait', call_id: callId, arguments: args });
  const event = (at: string, type: string) => line({ timestamp: at, type: 'event_msg', payload: { type } });
  const CHECK_INBOX = 'text(await tools.mcp__parley__check_inbox({}));';

  const AT = '2026-10-18T09:52:11.151Z';
  const yielded = (id = '58', callId = 'call_exec', output: unknown = `Script running with cell ID ${id}\nWall time 31 seconds\nOutput:\n`) =>
    item(AT, { type: 'custom_tool_call_output', call_id: callId, output });

  it('s21: yielded exec survives repeated waits and a completed turn', async () => {
    const file = await writeRollout('2026-10-18', 's21', meta() + event(AT, 'task_started') +
      exec(AT, 'text(await tools.exec_command({cmd:"git fetch"}));') + yielded() +
      wait(AT, '{"cell_id":"58","yield_time_ms":1000}') +
      item(AT, { type: 'function_call_output', call_id: 'call_wait', output: [{ type: 'input_text', text: 'Script running with cell ID 58\nOutput:\n' }] }) +
      event(AT, 'task_complete'));
    const indexed = await indexCodexSession(file);
    expect(indexed.openCodeCall).toBeUndefined();
    expect(indexed.pendingCodeCell).toEqual({ id: '58', at: AT });
  });

  it('incremental reads retain pending cells and late results without changing previous snapshots', async () => {
    const file = await writeRollout('2026-10-18', 'incremental-cell', meta() +
      exec(AT, CHECK_INBOX) + yielded() + wait(AT, '{"cell_id":"58"}'));
    const before = await extendCodexSessionIndex(null, file);
    expect(before.index.openCodeCall?.name).toBe('wait');
    await appendFile(file, event(AT, 'task_complete'));
    const ended = await extendCodexSessionIndex(before.state, file);
    expect(ended.index).toEqual(await indexCodexSession(file));
    expect(ended.index.pendingCodeCell).toEqual({ id: '58', at: AT });
    expect(ended.index.openCodeCall).toBeUndefined();
    expect(before.state.acc.build(file)).toEqual(before.index);
    await appendFile(file, item(AT, { type: 'function_call_output', call_id: 'call_wait', output: 'Script completed\nOutput:\n' }));
    const completed = await extendCodexSessionIndex(ended.state, file);
    expect(completed.index).toEqual(await indexCodexSession(file));
    expect(completed.index.pendingCodeCell).toBeUndefined();
    expect(ended.state.acc.build(file)).toEqual(ended.index);
  });

  it.each(['Script completed\nOutput:\n', 'Script terminated'])('wait result %s clears only its own cell', async (output) => {
    const file = await writeRollout('2026-10-18', 'cell-finished', meta() +
      exec(AT, CHECK_INBOX) + yielded() + exec(AT, CHECK_INBOX, 'second') + yielded('59', 'second') +
      wait(AT, '{"cell_id":"58"}') +
      item(AT, { type: 'function_call_output', call_id: 'call_wait', output: [{ type: 'input_text', text: output }] }));
    expect((await indexCodexSession(file)).pendingCodeCell).toEqual({ id: '59', at: AT });
  });

  it('does not mistake nested command output or unrelated tools for a yielded cell', async () => {
    const file = await writeRollout('2026-10-18', 'fake-cell', meta() + exec(AT, CHECK_INBOX) +
      yielded('58', 'call_exec', 'Script completed\nOutput:\nScript running with cell ID 58') +
      item(AT, { type: 'function_call', name: 'shell_command', call_id: 'shell', arguments: '{}' }) +
      yielded('59', 'shell'));
    expect((await indexCodexSession(file)).pendingCodeCell).toBeUndefined();
  });

  it('a wait result delivered after the turn ends still clears its cell', async () => {
    const file = await writeRollout('2026-10-18', 'late-cell-result', meta() +
      exec(AT, CHECK_INBOX) + yielded() + wait(AT, '{"cell_id":"58"}') + event(AT, 'task_complete') +
      item(AT, { type: 'function_call_output', call_id: 'call_wait', output: 'Script completed\nOutput:\n' }));
    const indexed = await indexCodexSession(file);
    expect(indexed.openCodeCall).toBeUndefined();
    expect(indexed.pendingCodeCell).toBeUndefined();
  });

  it('an explicit interruption dismisses the unfinished-cell alert', async () => {
    const file = await writeRollout('2026-10-18', 'cell-interrupted', meta() + exec(AT, CHECK_INBOX) + yielded() +
      event(AT, 'turn_aborted') + event(AT, 'task_started') + event(AT, 'task_complete'));
    expect((await indexCodexSession(file)).pendingCodeCell).toBeUndefined();
  });

  it('exec без вывода — openCodeCall с временем вызова и ожиданием из прагмы // @exec', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'open-exec',
      meta() +
        event('2026-10-15T22:06:34.521Z', 'task_started') +
        exec('2026-10-15T22:06:37.780Z', `// @exec: {"yield_time_ms": 1000, "max_output_tokens": 6000}\n${CHECK_INBOX}`),
    );
    expect((await indexCodexSession(file)).openCodeCall).toEqual({
      name: 'exec',
      at: '2026-10-15T22:06:37.780Z',
      yieldMs: 1000,
    });
  });

  it('exec без прагмы — ожидание неизвестно (yieldMs null)', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'open-exec-default',
      meta() + event('2026-10-15T22:06:34.521Z', 'task_started') + exec('2026-10-15T22:06:37.780Z', CHECK_INBOX),
    );
    expect((await indexCodexSession(file)).openCodeCall).toEqual({
      name: 'exec',
      at: '2026-10-15T22:06:37.780Z',
      yieldMs: null,
    });
  });

  it('вывод с тем же call_id закрывает вызов', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'closed-exec',
      meta() +
        event('2026-10-15T22:05:05.529Z', 'task_started') +
        exec('2026-10-15T22:05:09.440Z', CHECK_INBOX) +
        execOutput('2026-10-15T22:05:10.362Z'),
    );
    expect((await indexCodexSession(file)).openCodeCall).toBeUndefined();
  });

  it('вывод чужого вызова не закрывает открытый', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'other-output',
      meta() +
        event('2026-10-15T22:05:05.529Z', 'task_started') +
        exec('2026-10-15T22:05:09.440Z', CHECK_INBOX, 'call_a') +
        execOutput('2026-10-15T22:05:10.362Z', 'call_b'),
    );
    expect((await indexCodexSession(file)).openCodeCall).toMatchObject({ name: 'exec', at: '2026-10-15T22:05:09.440Z' });
  });

  it('wait (function_call) без вывода — openCodeCall с yield_time_ms из arguments', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'open-wait',
      meta() +
        event('2026-10-15T21:54:43.908Z', 'task_started') +
        wait('2026-10-15T21:55:33.985Z', '{"cell_id":"38","yield_time_ms":20000,"max_tokens":3500}'),
    );
    expect((await indexCodexSession(file)).openCodeCall).toEqual({
      name: 'wait',
      at: '2026-10-15T21:55:33.985Z',
      yieldMs: 20000,
    });
  });

  it('из нескольких открытых — самый ранний', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'two-open',
      meta() +
        event('2026-10-15T22:06:34.521Z', 'task_started') +
        exec('2026-10-15T22:06:37.780Z', CHECK_INBOX, 'call_first') +
        exec('2026-10-15T22:06:38.000Z', CHECK_INBOX, 'call_second'),
    );
    expect((await indexCodexSession(file)).openCodeCall).toMatchObject({ at: '2026-10-15T22:06:37.780Z' });
  });

  it.each(['task_complete', 'turn_aborted'])('%s снимает вызовы, оставшиеся открытыми в прошлом ходе', async (type) => {
    const file = await writeRollout(
      '2026-10-15',
      `turn-end-${type}`,
      meta() +
        event('2026-10-15T22:06:34.521Z', 'task_started') +
        exec('2026-10-15T22:06:37.780Z', CHECK_INBOX) +
        event('2026-10-16T06:35:17.818Z', type),
    );
    expect((await indexCodexSession(file)).openCodeCall).toBeUndefined();
  });

  it('прочие вызовы не сторожатся: shell, MCP напрямую, apply_patch', async () => {
    const file = await writeRollout(
      '2026-10-15',
      'not-code-mode',
      meta() +
        event('2026-10-15T22:06:34.521Z', 'task_started') +
        item('2026-10-15T22:06:35.000Z', { type: 'function_call', name: 'shell_command', call_id: 'c1', arguments: '{}' }) +
        item('2026-10-15T22:06:36.000Z', { type: 'function_call', name: 'mcp__parley__wait_for', call_id: 'c2', arguments: '{}' }) +
        item('2026-10-15T22:06:37.000Z', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: '*** Begin Patch' }),
    );
    expect((await indexCodexSession(file)).openCodeCall).toBeUndefined();
  });
});
