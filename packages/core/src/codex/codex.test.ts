import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexSessions } from './discover.js';
import { buildCodexIndex, indexCodexSession } from './index-session.js';

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
  root = await mkdtemp(path.join(tmpdir(), 'harnas-codex-'));
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
